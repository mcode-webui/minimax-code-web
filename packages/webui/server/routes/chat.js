// webui/server/routes/chat.js
// POST /api/send — main chat entry
// POST /api/stop — kill running child for cid
// POST /api/cmd — webui button-driven commands

import { randomUUID } from "node:crypto";
import {
  loadSessions,
  saveSessions,
  persistCurrentChat,
  promoteDraftToMcodeSid,
  appendChatToSession,
} from "../lib/sessions.js";
import {
  pushStateFor,
  pushAlert,
  getActiveChild,
  beginRun,
  endRun,
  createRunChat,
  drainRunChat,
} from "../lib/state-bus.js";
// 2026-09-20 rigor fix (G1 bypass finding): import the lib/slash.js shell,
//   NOT interaction/commands.js directly. The shell carries the B03
//   authorize("slash.clear") gate + write-ahead audit (slash.clear.intent /
//   chat.clear) for the destructive /clear and /new commands; importing the
//   raw dispatcher bypassed both in production.
import { handleLocalSlash, handleCmdCommand } from "../lib/slash.js";
import { runMcodeAcp } from "../lib/mcode-acp.js";
import { collectExecResult, runMcodeExec } from "../lib/mcode-exec.js";
import { cancelSession } from "../lib/mcode-rpc.js";
import { DEFAULT_MODEL } from "../lib/config.js";
import { resolveAttachments } from "../lib/attachments.js";
import { readJson } from "../lib/read-json.js";


// resetThinkingClaim — drop every field by which the pushed state
// can claim "a run is in progress". The streaming runners reset all
// of this in their finalize() (mcode-acp.js / mcode-exec.js), but a
// failure BEFORE the stream starts (acp client.start() ENOENT,
// session/load throw, exec resolveMcodeSpawn fail-closed) skips
// finalize entirely — so whatever claim cs carried into the turn
// survives every later pushStateFor and the panel shows 思考中
// forever. Idle shape is byte-mirrored from finalize() +
// makeClientState() so the reset path and the normal end-of-turn path
// stay symmetric.
//
// lastUsageAt is deliberately NOT cleared: it records "when usage
// was last observed", not an active-run claim — finalize() keeps it
// too, and zeroing it would erase the context panel's freshness
// datum for no gain.
function resetThinkingClaim(cs) {
  cs.running = {
    active: false,
    prompt: null,
    pid: null,
    startedAt: null,
    model: null,
    sessionId: null,
    lastDeltaAt: null,
    tps: 0,
  };
  cs.context.thinkingStatus = "Idle";
  cs.context.thinkingDuration = null;
  cs.context.tps = 0;
  // Strip the streaming cursor (▍) finalize() also strips — a line
  // left marked "streaming" after a terminal failure keeps the chat
  // block flickering as if the model were still writing.
  if (Array.isArray(cs.chat)) {
    cs.chat = cs.chat.map((line) =>
      typeof line === "string" && line.endsWith(" ▍")
        ? line.slice(0, -2)
        : line,
    );
  }
}

// POST /api/send — main chat entry, fire-and-forget (response = ack; output via /api/events SSE)
export async function handleSend(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  let content = (payload.content || "").trim();
  // Uploaded files. The composer enables Send for an attachment with no text,
  // so this list — not `content` — can be what makes a turn worth starting.
  // Paths arrive from the client and are untrusted: `resolveAttachments` keeps
  // only what is inside UPLOAD_DIR and exists, and reports the rest so the
  // rejection is visible instead of silent.
  const {
    attachments,
    rejected: rejectedAttachments,
    dropped: droppedAttachments,
  } = resolveAttachments(payload.attachments);
  if (!content && attachments.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "content required" }));
  }
  if (rejectedAttachments > 0 || droppedAttachments > 0) {
    // Silent truncation would be the same class of bug as the drop this
    // replaces: the user would believe every chip was delivered.
    pushAlert({
      level: "warn",
      msg:
        `${rejectedAttachments} attachment path(s) rejected (not an uploaded file)` +
        (droppedAttachments > 0 ? `, ${droppedAttachments} dropped (duplicate or over the per-turn limit)` : ""),
      src: "chat.send",
      cid,
      data: { rejected: rejectedAttachments, dropped: droppedAttachments },
    });
  }
  // ask_user modal answer — don't add to chat as a user message.
  const isAskAnswer = payload.isAskAnswer === true;

  // Claim the turn BEFORE acknowledging. Every prompt spawns its own engine
  // subprocess, so without this a double-send (retry, two tabs, a scripted
  // client) silently starts a second one: measured on a running server, ten
  // concurrent sends produced ten live engine processes. Three claims are
  // checked — this cid is idle, no other cid is running this engine session,
  // and the server is under MAX_CONCURRENT (which /api/health advertises as
  // `maxConcurrent` and which nothing used to read).
  //
  // Answering 409 rather than acking and failing later is deliberate: the ack
  // is fire-and-forget, so a rejection after it would be invisible to the
  // caller. api.sendMessage surfaces a non-2xx as an error, so the composer
  // shows it.
  const claim = beginRun(cid, cs && cs.mcodeSessionId);
  if (!claim.ok) {
    res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: false,
        error: claim.detail,
        reason: claim.reason,
        ...(claim.reason === "at-capacity"
          ? { running: claim.running, limit: claim.limit }
          : {}),
      }),
    );
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));

  try {
    if (!isAskAnswer) {
      // An attachment-only turn has no text to echo; the `›` line would be a
      // bare marker. The chips in the composer are the record of what was sent,
      // and the engine reports the references back.
      if (content) cs.chat = [...(cs.chat || []), `› ${content}`];
      // Sending a message bumps lastUsedWorkspace so the sidebar sorts
      // this workspace's group to the top. Switching session does NOT
      // (browsing ≠ sending); ask_user answer does NOT (modal ≠
      // message).
      cs.lastUsedWorkspace = (cs.workspace && cs.workspace.dir) || null;
      pushStateFor(cid);
      persistCurrentChat(cs);
    }

    // First-message bootstrap: if no webui session id exists yet, create
    // a fresh one with the current chat snapshot. The webui session id
    // is a randomUUID, distinct from the mcode session id allocated
    // inside the run.
    if (!cs.sessionId) {
      const all = loadSessions();
      const id = randomUUID();
      const item = {
        id,
        title: "New session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        chat: cs.chat || [],
        // Persist the workspace too — restoreLatestSession filters by
        // workspace, so a record without one can never be rehydrated
        // after a reload (the page would render as a fresh empty
        // session).
        workspace: (cs.workspace && cs.workspace.dir) || null,
      };
      all.unshift(item);
      saveSessions(all);
      cs.sessionId = id;
    }

    // session-isolation/02 (run-mirror): the webui record this turn
    // belongs to, captured before any await (draft creation above just
    // made sure it exists). Mid-run switches re-point cs (sessionId /
    // mcodeSessionId / chat) at another record — the finalize drain and
    // the engine-side bind/title writes must know where the turn CAME
    // FROM, not where the user is looking now.
    const owningWebuiSessionId = (cs && cs.sessionId) || null;

    // Detect slash commands that we can satisfy without spawning mcode
    const slashResult = await handleLocalSlash(content, cs, cid);
    if (slashResult.handled) {
      if (slashResult.continueMcode && slashResult.rewriteContent !== undefined) {
        content = slashResult.rewriteContent;
        // fall through to mcode call
      } else {
        return;
      }
    }

    // mcode acp is the default transport; MCODE_USE_ACP=0 falls back to
    // mcode exec (escape hatch if the acp protocol regresses).
    const modelToUse = (cs && cs.model && cs.model.name) || DEFAULT_MODEL;
    console.log(
      `[send] cid=${cid} content=${JSON.stringify(content.slice(0, 80))} model=${modelToUse} sessionId=${cs.mcodeSessionId} workspace=${(cs && cs.workspace && cs.workspace.dir) || "null"}`,
    );
    // session-isolation/02 (run-mirror): seed the per-(cid, owning
    // session) line buffer right before the engine runs (a no-op while
    // mcodeSessionId is still null — the buffer is keyed by the engine
    // sid, which `streamAcpPrompt` creates the moment it is known; a
    // locally-handled slash command above never leaves a stale buffer
    // behind). The engine's stream writes land in this buffer, never
    // directly in cs.chat; the finalize drain below flushes it.
    createRunChat(cid, cs && cs.mcodeSessionId, []);
    const t0 = Date.now();
    const r =
      process.env.MCODE_USE_ACP === "0"
        ? await collectExecResult(
            runMcodeExec(content, {
              label: "prompt",
              sessionId: cs.mcodeSessionId,
              model: modelToUse,
              cs,
              cid,
              attachments,
            }),
          )
        : await runMcodeAcp(content, {
            label: "prompt",
            sessionId: cs.mcodeSessionId,
            model: modelToUse,
            cs,
            cid,
            attachments,
            owningWebuiSessionId,
          });
    console.log(
      `[send] result ${Date.now() - t0}ms:`,
      JSON.stringify({
        status: r.status,
        error: r.error,
        answer: r.answer && r.answer.slice(0, 80),
        sessionId: r.sessionId,
      }).slice(0, 500),
    );
    // session-isolation/02 (run-mirror): finalize drain. The turn's
    // stream lines accumulated in the runChat buffer keyed by the
    // OWNING engine session; the user's `›` line was persisted up front.
    // Where the buffer flushes depends on where the user is looking:
    //   still viewing the owning session → append into cs.chat (the
    //     live view) — the success-branch ● rewrite below then lands on
    //     the drained line and persistCurrentChat persists the record;
    //   switched away mid-run → cs.chat belongs to ANOTHER session —
    //     never touched. The drained lines (with the final ● text
    //     patched in) go to the owning session's persisted record via
    //     appendChatToSession; the final persistCurrentChat(cs) below
    //     only re-writes the viewed session's own (unchanged) chat.
    // stillViewing keys on the engine sid the turn actually ran on
    // (r.sessionId — it can differ from the beginRun claim when a stale
    // session/load fell back to a fresh engine session), with the
    // owning webui record id as the fallback view test for a turn whose
    // draft never got bound.
    const owningSid = (r && r.sessionId) || cs.mcodeSessionId || null;
    const drainedLines = owningSid ? drainRunChat(cid, owningSid) : null;
    const stillViewing =
      !owningSid ||
      cs.mcodeSessionId === owningSid ||
      (owningWebuiSessionId != null && cs.sessionId === owningWebuiSessionId);
    // The flushed line list, normalized once: a successful turn's last
    // ● line is rewritten to the authoritative answer text — the same
    // normalization the still-viewing path has always applied to
    // cs.chat — no matter which destination the lines end up in.
    const flushDrainedLines = (oneLine) => {
      if (!drainedLines || drainedLines.length === 0) return null;
      const lines = drainedLines.slice();
      if (oneLine != null) {
        let patched = false;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (typeof lines[i] === "string" && lines[i].startsWith("● ")) {
            lines[i] = `● ${oneLine}`;
            patched = true;
            break;
          }
        }
        if (!patched) lines.push(`● ${oneLine}`);
      }
      if (stillViewing) {
        cs.chat = [...cs.chat, ...lines];
      } else {
        try {
          appendChatToSession(owningSid, lines);
        } catch (e) {
          console.warn(`[chat] appendChatToSession failed: ${e.message}`);
        }
      }
      return lines;
    };
    if (r.status === "succeeded" && r.answer) {
      // v0.5.bx-4: 流式输出已经在 streamAcpPrompt/streamUpdateLine 里把 ▲ 和 ● 行写进 chat 了
      const oneLine = r.answer.replace(/\n+/g, " ").trim();
      const flushed = flushDrainedLines(oneLine);
      if (stillViewing) {
        let lastAnsIdx = -1;
        for (let i = cs.chat.length - 1; i >= 0; i--) {
          if (typeof cs.chat[i] === "string" && cs.chat[i].startsWith("● ")) {
            lastAnsIdx = i;
            break;
          }
        }
        if (lastAnsIdx >= 0) {
          cs.chat[lastAnsIdx] = `● ${oneLine}`;
        } else {
          cs.chat = [...cs.chat, `● ${oneLine}`];
        }
      }
      cs.context.assistantLast = oneLine;
      cs.context.assistantAt = Date.now();
    } else {
      if (r.status === "failed" || r.error) {
      const rawMsg = (r.error?.message || r.status).replace(/\n+/g, " ");
      let oneLine = rawMsg;
      let hint = "";
      if (/Questionnaire|user input/i.test(rawMsg)) {
        hint = " (Ask 工具在 webui/exec 模式不可用，请直接用输入框发问)";
      } else if (/requires.*input|interactive/i.test(rawMsg)) {
        hint = " (此工具需要交互模式，webui 暂不支持)";
      }
      // v2.0 (lease B02): §AP3 — errors no longer pollute the chat
      // stream. Surface them via the independent anomaly channel;
      // cs.context.assistantLast keeps the error in the model context
      // (so a follow-up turn can reference it) but the user-facing
      // chat list stays clean. The bell icon (frontend, C batch) shows
      // the alert with the matching id.
      pushAlert({
        level: "error",
        msg: `[chat.send] ${oneLine}${hint}`,
        src: "chat.send",
        cid,
        sessionId: r.sessionId || null,
        data: { status: r.status, error: r.error || null },
      });
      cs.context.assistantLast = `[error] ${oneLine}`;
      cs.context.assistantAt = Date.now();
      // v2 (2026-09-20 webui-manual-audit): a failed send is a TERMINAL
      //   turn state — reset the thinking claim so the pushStateFor at
      //   the end of this handler lands an at-rest state instead of
      //   re-asserting whatever running/thinkingStatus cs carried in.
      //   Without this, the context panel's 思考中 indicator never
      //   clears (start-phase failures never reach the runners'
      //   finalize()). The success branch needs no equivalent: by the
      //   time r.status === "succeeded" is observed here, finalize()
      //   has already run inside runMcodeAcp/collectExecResult and put
      //   cs into exactly this idle shape.
      resetThinkingClaim(cs);
      }
      // Non-success turn (failed, timeout, or succeeded with no answer
      // text — e.g. the empty-turn note line): the buffered lines are
      // still the owning session's content — flush them exactly like
      // the success path, minus the ● normalization.
      flushDrainedLines(null);
    }
    // v2.4 单一基础会话：回合绑定了 mcode 会话（cs.mcodeSessionId 由 acp
    //   finalize 写入）后，把草稿记录晋升为引擎身份（id → mvs_…），或并入
    //   该 mcode 会话既有的叠加记录——保证一次对话在存储里只有一条记录。
    //   (session-isolation/02: when the user switched away mid-run, cs
    //   belongs to the OTHER session; this is a no-op for it — the
    //   owning record was already promoted at bind time via
    //   bindRecordToMcodeSid inside runMcodeAcp.)
    if (cs.mcodeSessionId) {
      try {
        promoteDraftToMcodeSid(cs);
      } catch (e) {
        console.warn(`[chat] promoteDraftToMcodeSid failed: ${e.message}`);
      }
    }
    persistCurrentChat(cs);
    pushStateFor(cid);
  } finally {
    // Releases the cid claim and, if this run owned it, the engine-session
    // claim. Covers every exit after the ack — including the early return for
    // a locally-handled slash command, which never spawns an engine.
    endRun(cid);
  }
}

// POST /api/stop — 中断正在跑的 prompt
// Sends the engine's `session/cancel` notification first, so the prompt is aborted
// and finalize runs. SIGKILL is the fallback for a child that cannot be told to
// stop at all — killing the process takes its background tasks down with it,
// which is why the graceful path is tried first.
export async function handleStop(_req, res, ctx) {
  const cid = ctx.cid;
  const cs = ctx.cs;
  const child = getActiveChild(cid);
  const wasRunning = !!child;
  let cancelled = false;
  let hardKilled = false;
  // 1. Gentle path: send the `session/cancel` notification. The engine aborts the
  //    active prompt's AbortController; there is no reply, so `ok` means "sent".
  if (cs && cs.mcodeSessionId) {
    try {
      const r = await cancelSession(cs.mcodeSessionId, ctx.cid);
      if (r.ok) cancelled = true;
      else {
        // No client to notify — worth a line in the log before the SIGKILL.
        console.warn(
          `[stop] session/cancel failed cid=${cid}: ${r.error} (code=${r.code})`,
        );
      }
    } catch (e) {
      console.warn(`[stop] session/cancel threw cid=${cid}: ${e.message}`);
    }
  }
  // 2. 兜底路径: hard kill child (RPC 不支持或失败)
  if (child && !cancelled) {
    try {
      child.kill();
    } catch {}
    hardKilled = true;
  }
  // 3. 兜底路径 2: 设个 2s timeout, 如果 mcode acp 没通过 cancel 退出, 也强 kill
  //    (避免 mcode 还在 prompt 不响应时 webui 显示 "已停止" 但实际还在跑)
  //    缓存 child.child 引用, 因为 2s 后 child.stop() 可能已经把它置 null
  if (child) {
    const rawChild = child.child; // 缓存 node child_process 实例
    setTimeout(() => {
      try {
        if (rawChild && !rawChild.killed && rawChild.exitCode === null) {
          console.log(
            `[stop] cid=${cid} child still alive 2s after stop, force-killing`,
          );
          child.kill();
        }
      } catch {}
    }, 2000).unref();
  }
  // v2 (2026-09-20 webui-manual-audit): zombie-run claim reset. If no
  //   active child backs this cid but cs still claims an active run
  //   (runner died before its finalize ran — e.g. the acp start-phase
  //   failure path above, or a mid-run crash that lost the child
  //   registration), nothing will ever push an at-rest state again:
  //   every pushStateFor re-asserts running.active=true and the panel
  //   shows 思考中 forever. /api/stop is the user's escape hatch for
  //   exactly this moment, so answering wasRunning:false without
  //   clearing the claim strands the UI. Reset + push here; when a
  //   child IS present (wasRunning=true) we deliberately do NOT touch
  //   cs — the kill cascade above rejects the in-flight prompt and
  //   the runner's own finalize() owns the terminal state (including
  //   its chat-cursor cleanup), so resetting early would only race it.
  if (!wasRunning && cs && cs.running && cs.running.active) {
    resetThinkingClaim(cs);
    pushStateFor(cid);
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      wasRunning,
      cancelled,
      hardKilled,
      note: cancelled
        ? "gentle cancel"
        : "hard kill (session/cancel could not be delivered)",
    }),
  );
}

// POST /api/cmd — webui button-driven commands
export async function handleCmd(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const cmd = (payload.cmd || "").trim();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
  await handleCmdCommand(cmd, cs, cid);
}
