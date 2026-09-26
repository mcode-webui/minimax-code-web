// webui/server/lib/mcode-acp.js
// mcode acp protocol streaming — streamAcpPrompt + runMcodeAcp.

import { McodeAcpClient } from "../../acp.mjs";
import { DEFAULT_WORKSPACE, DEFAULT_MODEL, PROMPT_IDLE_TIMEOUT_MS } from "./config.js";
import { createIdleWatchdog } from "./idle-watchdog.js";
import { streamUpdateLine } from "./chat-line.js";
import {
  createRunChat,
  runChatLinesFor,
} from "./state-bus.js";
import {
  bindDraftToMcodeSid,
  bindRecordToMcodeSid,
  computeContextPercent,
} from "./sessions.js";
import {
  setActiveChild,
  clearActiveChild,
  pushStateFor,
  pushAlert,
  getCidsByMcodeSession,
  updateRunSid,
} from "./state-bus.js";
import { applyMavisUsageToCs } from "./mavis-usage.js";
import { mcodePermissionToWebui } from "./mcode-rpc.js";
import {
  getMcodeSessionTitle,
  invalidateMcodeSessionsCache,
  getMcodeSessionsForWorkspace,
} from "./acp-client.js";
import { getMcodeModelLimit } from "./models.js";
import { buildPromptBlocks, promptTextFor } from "./attachments.js";
import { loadSessions, saveSessions } from "./sessions.js";

// runMcodeAcp / streamAcpPrompt — mcode acp protocol streaming.
//
// If cs.permissions is set to anything other than "Full access", the
// acp protocol layer does not expose permission push — fall back to
// mcode-exec (which honours --permission ask/full/auto/off).

/**
 * Push the recorded pre-session model pick (and, if recorded, the
 * matching thinking-effort level) to a brand-new engine session.
 *
 * Called from `runMcodeAcp` immediately after `session/new` returns, while
 * the new `McodeAcpClient` is still in scope but not yet registered as the
 * cid's active child (so going through `setConfigOption` in
 * `server/lib/mcode-rpc.js` would miss the dispatch — `clientForCid`
 * would fall back to the singleton, which is a different acp subprocess).
 *
 * Resolution: `cs.model.name` carries the id the user picked, which can be
 *   - the engine's own option.value (`minimax_api:MiniMax-M3`,
 *     `:` separator) — direct match, no rewrite;
 *   - the builtin-catalogue form (`minimax_api/MiniMax-M3`,
 *     `/` separator) — matched against option.name, retargeted to
 *     option.value;
 *   - a stale engine-encoded form for an option no longer listed
 *     (`currentValue` already advanced) — no change, the engine's
 *     `currentValue` is what runs.
 *
 * A successful apply updates `cs.configOptions` with the new currentValue
 * so the next `/api/models` reads the same model the engine is running.
 *
 * Engine contract: the `thinkingEffort` config option is rejected when
 * no model is selected (`Select a Session model before changing
 * thinking effort.`, agent.ts#1003). We push the model first, then the
 * effort, in that order — and only when a level was recorded
 * (`cs.model.thinking` non-empty). The level is otherwise accepted
 * as-is: the engine validates it against the selected model's
 * effortOptions and answers invalidParams on a mismatch.
 *
 * Errors are swallowed: a fresh session with the engine's default is
 * better than a failed session start; the user can re-pick on the chip.
 */
async function applyRecordedModel(client, sid, cs, cid) {
  const recorded = cs && cs.model && typeof cs.model.name === "string"
    ? cs.model.name.trim()
    : "";
  const recordedThinking = cs && cs.model && typeof cs.model.thinking === "string"
    ? cs.model.thinking.trim()
    : "";

  let modelApplied = false;
  if (recorded) {
    const modelOption = findModelOption(cs);
    if (!modelOption) {
      // Engine hasn't reported its model option yet — neither apply
      // can fire (the engine rejects effort before a model is selected).
      // Bail; both will get re-attempted on the next session event that
      // carries a fresh configOptions list.
      return;
    }
    const engineCurrent = modelOption.currentValue;
    if (!matchesModelId(recorded, engineCurrent, modelOption)) {
      const resolved = resolveModelId(recorded, modelOption);
      if (!resolved) {
        console.warn(
          `[webui] applyRecordedModel: recorded id "${recorded}" does not match any engine option; skipping`,
        );
      } else {
        await client.request("session/set_config_option", {
          sessionId: sid,
          configId: "model",
          value: resolved,
        });
        // Reflect the apply on the local config-options snapshot so a
        // follow-up /api/models reads the engine's new currentValue
        // instead of the session-boot default. The engine pushes a
        // `config_option_update` notification when it processes the
        // apply; this local update is the synchronous mirror that keeps
        // the chip and the engine in lockstep before the next SSE flush
        // lands.
        const opts = Array.isArray(cs.configOptions) ? cs.configOptions : [];
        for (const o of opts) {
          if (o && o.id === "model" && typeof o === "object") {
            o.currentValue = resolved;
          }
        }
        modelApplied = true;
      }
    }
  }

  // Thinking-effort apply (ticket 04): only when a level was recorded
  // AND a model is selected (recorded or just applied). The engine
  // validates the level against the selected model's effortOptions; a
  // rejection is logged and otherwise ignored — the engine's default
  // stands, and the next /api/models reflects that.
  if (recordedThinking) {
    if (!recorded && !modelApplied) {
      // No recorded model and the engine's current model is unknown to
      // us; we have no anchor for the effort. Skip.
      return;
    }
    try {
      await client.request("session/set_config_option", {
        sessionId: sid,
        configId: "thinkingEffort",
        value: recordedThinking,
      });
      const opts = Array.isArray(cs.configOptions) ? cs.configOptions : [];
      for (const o of opts) {
        if (o && o.id === "thinkingEffort" && typeof o === "object") {
          o.currentValue = recordedThinking;
        }
      }
    } catch (e) {
      console.warn(
        `[webui] applyRecordedModel: thinking effort "${recordedThinking}" rejected: ${e.message}`,
      );
    }
  }

  if ((modelApplied || recordedThinking) && cid) pushStateFor(cid);
}

/** Locate the engine's `model` config option, or null if none was reported yet. */
function findModelOption(cs) {
  if (!cs || !Array.isArray(cs.configOptions)) return null;
  return cs.configOptions.find((o) => o && o.id === "model") || null;
}

/**
 * True when `recorded` already represents what the engine is running.
 *
 * Two ways to match: engine-encoded `option.value` (exact), or the bare
 * model name (`option.name`) regardless of provider prefix. The latter
 * covers the case where the chip recorded `minimax_api/MiniMax-M3`
 * (builtin-catalogue form) while the engine's `currentValue` is
 * `minimax_api:MiniMax-M3` (engine form).
 */
function matchesModelId(recorded, engineCurrent, modelOption) {
  if (typeof engineCurrent === "string" && engineCurrent === recorded) return true;
  if (!modelOption || !Array.isArray(modelOption.options)) return false;
  for (const opt of modelOption.options) {
    if (!opt || typeof opt !== "object") continue;
    if (typeof opt.value === "string" && opt.value === recorded) return true;
  }
  return false;
}

/**
 * Resolve the recorded id to one of the engine's option.values.
 *
 * - exact `option.value` match → return as-is;
 * - bare model name (`MiniMax-M3`, the `option.name` or the suffix
 *   after the last separator in the recorded id) matching exactly one
 *   option → return that option's `value`;
 * - multiple matches or none → null (caller skips).
 *
 * Ticket 05: the bare-name match is case-insensitive. The engine
 * populates `option.name` from the user-supplied model label (e.g.
 * `GLM-5.3` for a custom provider whose label happens to differ in
 * case from the model id), while the webui records the model id in
 * `cs.model.name` (e.g. `glm-5.3`). A strict comparison would skip
 * the apply and leave the engine on its default. The recorded id is
 * authoritative — when only one option matches case-insensitively,
 * that option is the right target. (Multiple case-insensitive
 * matches still returns null; ambiguity is ambiguity.)
 */
function resolveModelId(recorded, modelOption) {
  if (!modelOption || !Array.isArray(modelOption.options)) return null;
  const options = modelOption.options.filter(
    (o) => o && typeof o === "object" && typeof o.value === "string",
  );
  // Direct value match wins.
  for (const o of options) {
    if (o.value === recorded) return o.value;
  }
  const bareName = lastSegment(recorded);
  const matches = options.filter(
    (o) => typeof o.name === "string" && o.name.toLowerCase() === bareName.toLowerCase(),
  );
  if (matches.length === 1) return matches[0].value;
  return null;
}

/** Last segment after `/` or `:` — `minimax_api/MiniMax-M3` → `MiniMax-M3`. */
function lastSegment(id) {
  const i = Math.max(id.lastIndexOf("/"), id.lastIndexOf(":"));
  return i >= 0 ? id.slice(i + 1) : id;
}

// Exported for unit tests (test/lib/mcode-acp-note.test.js extends to
// cover applyRecordedModel's resolution logic). The pre-session model
// apply needs to handle three input forms without regressing, so the
// pure helpers are tested in isolation; the integration with the
// `McodeAcpClient` is exercised by `runMcodeAcp` itself.
export {
  applyRecordedModel,
  findModelOption,
  matchesModelId,
  resolveModelId,
  lastSegment,
};

export async function runMcodeAcp(content, opts = {}) {
  const label = opts.label || "prompt";
  const existingSid = opts.sessionId || null;
  const cs = opts.cs;
  const cid = opts.cid;
  // session-isolation/02 (run-mirror): the webui record this turn
  // belongs to, captured BEFORE any await. Mid-run the user can switch
  // sessions, which re-points the live `cs` (sessionId / mcodeSessionId
  // / chat) at ANOTHER record — every cs-mutation downstream (draft
  // promotion, finalize's sid binding and title write-back) must be
  // gated on "the user is still looking at the session that ran", and
  // the owning record is addressed by this id instead when they did
  // not. `handleSend` passes the id it captured right after creating
  // the turn's draft record; the cs fallback covers direct callers.
  const owningWebuiSessionId =
    (typeof opts.owningWebuiSessionId === "string" &&
      opts.owningWebuiSessionId) ||
    (cs && cs.sessionId) ||
    null;
  // Uploaded files, already validated to be inside UPLOAD_DIR by the route.
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
  const workspace =
    (cs && cs.workspace && cs.workspace.dir) || DEFAULT_WORKSPACE;
  if (cs && cs.permissions && cs.permissions !== "Full access") {
    const modelToUse = (cs.model && cs.model.name) || DEFAULT_MODEL;
    // Note: collectExecResult is imported lazily to avoid circular import
    const { collectExecResult } = await import("./mcode-exec.js");
    const { runMcodeExec } = await import("./mcode-exec.js");
    return await collectExecResult(
      runMcodeExec(content, {
        label: "prompt",
        sessionId: existingSid,
        model: modelToUse,
        cs,
        cid,
        // exec has no block channel — it writes plain text to stdin, so the
        // resource links are rendered with the same wording the engine's own
        // `promptToText` uses for them.
        content: promptTextFor(content, attachments),
      }),
    );
  }
  const client = new McodeAcpClient({ debug: false });
  let sid = existingSid;
  try {
    await client.start();
    let control = null;
    if (sid) {
      try {
        control = await client.loadSession(sid, workspace);
      } catch (e) {
        console.warn(
          `[webui] acp session/load ${sid} failed: ${e.message}; creating new`,
        );
        sid = null;
      }
    }
    if (!sid) {
      const r = await client.newSession(workspace);
      sid = r.sessionId;
      control = r;
    }
    // The session's config options are the engine's answer to "which models and
    // permission modes may this session use, and which are active". Routes read
    // them instead of guessing from mcode's build output.
    if (control && Array.isArray(control.configOptions)) {
      cs.configOptions = control.configOptions;
    }
    // Pre-session model pick — the chip shows whatever the user picked
    // (`cs.model.name`), but a brand-new engine session boots its own
    // default. Without this apply step the engine would run on its default
    // while the chip claimed something else, surfacing as "engine ran
    // glm-5.3 while the chip showed M2.5". We resolve the recorded id
    // against the engine's model option (same `value`/`name` matching the
    // `/api/set-model` route uses) and push it through
    // `session/set_config_option` directly on the in-scope client — the
    // active-child registry is not yet wired here, so going through
    // `setConfigOption` from `mcode-rpc.js` would always miss.
    if (sid && !existingSid) {
      try {
        await applyRecordedModel(client, sid, cs, cid);
      } catch (e) {
        console.warn(`[webui] applyRecordedModel: ${e.message}`);
      }
    }
    // qa (两条记录): 草稿→引擎身份的绑定在 session 创建时立即执行，不再
    //   等到 finalize。之前长任务全程草稿是 uuid 孤儿 —— sidebar 同时显示
    //   uuid 草稿和 mvs_ 引擎条目两条；此时点 mvs_ 条目会走 new_from_mcode
    //   建壳，把同一对话永久分裂成两条记录（审计日志实锤）。幂等。
    //
    // session-isolation/02 (run-mirror): bindDraftToMcodeSid mutates `cs`
    //   AND renames/merges records through cs.sessionId — both are only
    //   correct while the user is still viewing the session that ran. A
    //   mid-run switch re-points cs at the OTHER session; promoting
    //   through it would rename that session's record or merge its chat.
    //   Still viewing → cs path as before; switched away → the same
    //   promotion targeted at the OWNING record by id (cs untouched).
    const stillViewingAtBind =
      !owningWebuiSessionId || cs.sessionId === owningWebuiSessionId;
    if (sid) {
      try {
        if (stillViewingAtBind) {
          bindDraftToMcodeSid(cs, sid);
        } else {
          bindRecordToMcodeSid(owningWebuiSessionId, sid);
        }
      } catch (e) {
        console.warn(`[webui] bindDraftToMcodeSid: ${e.message}`);
      }
      // First-turn session-busy guard: `handleSend` claimed the run with
      // `beginRun(cid, cs.mcodeSessionId)` BEFORE this turn existed, so on
      // a session's first turn the claim was registered with `sid: null`
      // and `runsBySid` never guarded the engine session — a second window
      // could send to the same brand-new session and get a 200, then lose
      // its prompt to the engine's "Session already has an active Turn".
      // The turn's sid is now known: backfill the claim mid-turn (idempotent
      // when beginRun already carried a real sid; re-points the claim when a
      // failed session/load fell back to a fresh engine session above).
      updateRunSid(cid, sid);
    }
    return await streamAcpPrompt(
      client,
      sid,
      content,
      label,
      cs,
      cid,
      attachments,
      owningWebuiSessionId,
    );
  } catch (e) {
    // v2.0 (lease B02): §AP5 — surface subprocess start / session
    // failures on the anomaly channel instead of swallowing them
    // into a chat `! [error]` line.
    pushAlert({
      level: "error",
      msg: `[mcode-acp.start] ${e.message}`,
      src: "mcode-acp",
      cid: cid || null,
      sessionId: sid || null,
      data: { phase: "start-or-load" },
    });
    return {
      status: "failed",
      error: { message: e.message },
      sessionId: sid,
      answer: null,
      thinking: null,
    };
  } finally {
    clearActiveChild(cid);
    client.stop();
  }
}

// buildEmptyTurnNote — explanatory line for turns that ended without
// producing answer text. Returns null for normal turns; returns a
// "! …" prefixed system-note string for max_tokens/length (thinking
// exhausted the output budget) or other stopReason values (model did
// not produce output). The "!" prefix is rendered as a system note
// block by parseChatLines.
export function buildEmptyTurnNote(stopReason, answer) {
  if (typeof answer === "string" && answer.trim()) return null;
  const reason = stopReason || "end_turn";
  const why =
    reason === "max_tokens" || reason === "length"
      ? "思考占满了输出预算"
      : "模型未产出正文";
  return (
    `! 回合结束但未生成回复（stopReason=${reason}：${why}）。` +
    `发送「继续」即可让它产出结果。/ Turn ended with no reply — send “继续” to continue.`
  );
}

// applyConfigOptionUpdate — handle the engine's `config_option_update`
// session event. Replaces `cs.configOptions` wholesale (the engine sends
// the whole list), propagates `permissionMode.currentValue` through
// `mcodePermissionToWebui`, propagates `model.currentValue` into
// `cs.model.name`, and propagates `thinkingEffort.currentValue` into
// `cs.model.thinking`. The model field is read with the same
// `option.currentValue` contract that `routes/model.js#handleGetModels`
// uses, so the two cannot disagree about which holds the encoded id.
// When the model option is absent or its currentValue is empty,
// `cs.model` is left untouched — this branch is only a reflection of the
// engine's authoritative state.
export function applyConfigOptionUpdate(cs, update) {
  const opts =
    update && Array.isArray(update.configOptions) ? update.configOptions : null;
  if (!opts) return;
  cs.configOptions = opts;
  const mode = opts.find((o) => o && o.id === "permissionMode");
  if (mode && mode.currentValue) {
    cs.permissions = mcodePermissionToWebui(mode.currentValue);
  }
  const model = opts.find((o) => o && o.id === "model");
  if (model && model.currentValue) {
    cs.model = { ...(cs.model || {}), name: model.currentValue };
  }
  const thinking = opts.find((o) => o && o.id === "thinkingEffort");
  if (thinking) {
    // currentValue can legitimately be empty (engine's default or no
    // override); reflect that exactly so the picker shows "off" rather
    // than a stale level. The field is dropped when the option is
    // missing altogether (model without an effort dimension).
    if (typeof thinking.currentValue === "string" && thinking.currentValue) {
      cs.model = { ...(cs.model || {}), thinking: thinking.currentValue };
    } else if (cs.model && "thinking" in cs.model) {
      const { thinking: _drop, ...rest } = cs.model;
      void _drop;
      cs.model = rest;
    }
  }
}

// applyToolUpdate — handle a `tool_update` (a.k.a. `tool_call_update`)
// session event. Writes the indented body (status, output, `@ path`,
// `! error`) after the matching `→ name` header line so the decoder
// can attribute every body line back to a tool block. When the prior
// `tool_call` never arrived — webui attached mid-stream, or this is the
// first frame seen for the tool — there is no header to insert after;
// synthesize one so the body has an owner. Without an owner,
// `decodeTranscript` would otherwise route the body lines into a stray
// `system` block (the transcript row the user reported as labelled
// `系统`). The synthesized header is registered in `r.toolIndexById`
// so subsequent updates for the same `toolCallId` insert after it.
export function applyToolUpdate(r, cs, update) {
  const u = update || {};
  if (!r.toolIndexById) r.toolIndexById = new Map();
  // session-isolation/02: route tool-update writes into the runChat
  // buffer (not cs.chat), so the viewing-session sees no cross-
  // contamination when the user switches mid-run.
  const chat = r && typeof r.chatArray === "function" ? r.chatArray() : cs.chat;

  let insertAfter = r.toolIndexById.get(u.toolCallId);
  if (insertAfter == null) {
    const name = u.title || u.name || u.toolName || "tool";
    chat.push(`→ ${name}`);
    insertAfter = chat.length - 1;
    r.toolIndexById.set(u.toolCallId, insertAfter);
  }

  const status = u.status || "completed";
  const rawOutput = u.rawOutput;
  const outText =
    rawOutput && Array.isArray(rawOutput.content)
      ? rawOutput.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";

  const newLines = [];
  newLines.push(`  [${status}]`);
  if (outText) {
    for (const ln of outText.split("\n")) newLines.push("  " + ln);
  }
  if (Array.isArray(u.locations) && u.locations.length > 0) {
    const seen = new Set();
    for (const loc of u.locations) {
      const p = loc && loc.path;
      if (typeof p === "string" && p && !seen.has(p)) {
        seen.add(p);
        newLines.push(`  @ ${p}`);
      }
    }
  }
  if (u.error)
    newLines.push(
      `  ! ${typeof u.error === "string" ? u.error : u.error.message || JSON.stringify(u.error)}`,
    );

  // Insert newLines into the chat array (runChat buffer when in a
  // turn, cs.chat otherwise). Match the splice-with-index-shift that
  // would happen on a regular array mutation.
  const before = chat.slice(0, insertAfter + 1);
  const after = chat.slice(insertAfter + 1);
  for (let i = 0; i < before.length; i += 1) chat[i] = before[i];
  for (let j = 0; j < newLines.length; j += 1) {
    chat[before.length + j] = newLines[j];
  }
  for (let k = 0; k < after.length; k += 1) {
    chat[before.length + newLines.length + k] = after[k];
  }
  chat.length = before.length + newLines.length + after.length;
  if (r.toolIndexById) {
    for (const [k, v] of r.toolIndexById) {
      if (v > insertAfter) r.toolIndexById.set(k, v + newLines.length);
    }
  }
}

// streamAcpPrompt — like collectExecResult, but the event source is
// the acp client's prompt callback rather than a child-process stdout
// stream.
function streamAcpPrompt(
  client,
  sid,
  content,
  label,
  cs,
  cid,
  attachments = [],
  owningWebuiSessionId = null,
) {
  return new Promise((resolve) => {
    const r = {
      answer: null,
      thinking: null,
      status: "unknown",
      error: null,
      usage: null,
      sessionId: sid,
      durationMs: null,
      stopReason: null,
      tps: null,
      // session-isolation/06: per-segment accumulator reset.
      // `lastChunkKind` is the kind of the chunk that last wrote a
      // `▲` or `●` line; when the new chunk is the same kind we
      // append to the existing buffer (normal streaming growth), when
      // it is different we reset so the new line contains only the
      // new segment. Reset on every turn (streamAcpPrompt is called
      // once per prompt), so a new message after stop/save/resume
      // starts with lastChunkKind === null and the first chunk of
      // any kind triggers a clean accumulator.
      lastChunkKind: null,
      // session-isolation/02 (run-mirror): the owning session id for
      // this turn, captured at entry — the ENGINE sid the turn runs on
      // (identical to `cs.mcodeSessionId` once the draft is bound).
      // Every stream write (▲ / ● / tool_call / tool_update / plan /
      // empty-turn note) lands in the runChat buffer keyed by this id,
      // NEVER directly in cs.chat: mid-run the user can switch sessions
      // and cs.chat then belongs to whichever session they opened. The
      // wire snapshots re-attach the buffer for the owning view
      // (state-bus.snapshotViewFields) and the route's finalize drain
      // flushes the buffer to the owning session's view-or-record.
      owningSessionId: sid,
      // session-isolation/02 (run-mirror): the webui record id this
      // turn belongs to, captured by runMcodeAcp before its first
      // await. Finalize consults this to detect "the user switched
      // away mid-run" before any cs mutation.
      owningWebuiSessionId,
      // `chatArray()` — the write target for every stream line. ALWAYS
      // the runChat buffer while the turn's buffer exists (created just
      // below, before the first engine event can arrive); cs.chat is
      // only a fallback for calls outside a buffered turn (unit tests,
      // non-turn helpers). View delivery is the snapshot's job, not the
      // write target's.
      chatArray() {
        const m = runChatLinesFor(cid, sid);
        return m !== null ? m : cs.chat;
      },
    };
    const t0 = Date.now();
    cs.running = {
      active: true,
      prompt: label,
      pid: null,
      startedAt: t0,
      model: cs.model.name,
      sessionId: sid,
      lastDeltaAt: t0,
      tps: 0,
    };
    cs.context.thinkingStatus = "Running";
    setActiveChild(cid, client);
    pushStateFor(cid);
    // session-isolation/02 (run-mirror): create the per-(cid,
    // owning-session) buffer that captures every stream write
    // during this turn. Lines DO NOT go to cs.chat directly — the
    // viewing session might be a different one (the user may have
    // switched mid-run). The buffer is drained at finalize back
    // into either cs.chat (same session still viewing) or the
    // owning session's persisted record (user switched away).
    createRunChat(cid, sid, []);
    // Idle watchdog — every stream event (thought / message / tool_call /
    // tool_update / usage / other) refreshes cs.running.lastDeltaAt,
    // so a long but healthy turn never trips this; only a silent
    // stream does.
    const idleSeconds = Math.round(PROMPT_IDLE_TIMEOUT_MS / 1000);
    const safetyTimeout = createIdleWatchdog({
      idleMs: PROMPT_IDLE_TIMEOUT_MS,
      activityAt: () => cs.running.lastDeltaAt || t0,
      onTimeout: () => {
        if (r.status === "unknown") {
          r.status = "timeout";
          r.error = {
            message: `mcode acp prompt inactive for ${idleSeconds}s (no stream events)`,
          };
          // Surface silent hangs on the anomaly channel as a `warn`
          // (less severe than a crash but still actionable).
          pushAlert({
            level: "warn",
            msg: `[mcode-acp.timeout] prompt inactive for ${idleSeconds}s`,
            src: "mcode-acp",
            cid: cid || null,
            sessionId: sid || null,
            data: { phase: "stream" },
          });
          try {
            client.stop();
          } catch {}
          finalize();
        }
      },
    });
    function finalize() {
      if (r._finalized) return;
      r._finalized = true;
      safetyTimeout.stop();
      r.durationMs = r.durationMs || Date.now() - t0;
      // v2.4 (SPEC §B 尾项 — turn_process.processed_duration):
      //   append a `§§ processed_duration=Nms` marker to the transcript so the
      //   webui renderer can attach it to the matching assistant turn and show
      //   the upstream `turn_process_disclosure` collapse bar. The marker is
      //   stripped by `decodeTranscript` before markdown rendering, so it stays
      //   invisible in the chat body. Only the latest turn carries this field
      //   upstream (no per-turn history replay), and we mirror that scope here.
      if (
        typeof r.durationMs === "number" &&
        r.durationMs > 0
      ) {
        const chatTarget = r && typeof r.chatArray === "function" ? r.chatArray() : cs.chat;
        if (Array.isArray(chatTarget)) {
          chatTarget.push(`§§ processed_duration=${Math.round(r.durationMs)}ms`);
        }
      }
      clearActiveChild(cid);
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
      cs.context.tps = 0;
      // Strip the streaming cursor ▍ from every line — streamUpdateLine
      // adds it on every push, finalize must clear it or the thinking
      // / answer lines stay marked as streaming forever.
      const cursorTarget = r && typeof r.chatArray === "function" ? r.chatArray() : cs.chat;
      if (Array.isArray(cursorTarget)) {
        for (let i = 0; i < cursorTarget.length; i += 1) {
          const line = cursorTarget[i];
          if (typeof line === "string" && line.endsWith(" ▍")) {
            cursorTarget[i] = line.slice(0, -2);
          }
        }
      }
      if (r.usage) {
        cs.context.tokens =
          (cs.context.tokens || 0) + (r.usage.totalTokens || 0);
        cs.context.used = cs.context.tokens;
        cs.context.percent = computeContextPercent(
          cs.context.tokens,
          cs.context.limit,
        );
        cs.context.lastUsageAt = Date.now();
        cs.usage.sessionInput =
          (cs.usage.sessionInput || 0) + (r.usage.inputTokens || 0);
        cs.usage.sessionOutput =
          (cs.usage.sessionOutput || 0) + (r.usage.outputTokens || 0);
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
        cs.context.estimated = false;
      } else if (r.answer || r.thinking) {
        // Fallback when the engine returns no usage and fires no
        // usage_update: estimate from thinking + answer length (~3 chars
        // per token) plus the last user-message length.
        const outText = (r.thinking || "") + (r.answer || "");
        const estOutTokens = Math.ceil(outText.length / 3);
        const lastUserLine = [...(cs.chat || [])]
          .reverse()
          .find((l) => typeof l === "string" && l.startsWith("› "));
        const userLen = lastUserLine ? lastUserLine.length : 0;
        const estInTokens = Math.ceil(userLen / 3);
        const estTotal = estOutTokens + estInTokens;
        cs.context.tokens = (cs.context.tokens || 0) + estTotal;
        cs.context.used = cs.context.tokens;
        cs.context.estimated = true;
        cs.context.percent = computeContextPercent(
          cs.context.tokens,
          cs.context.limit,
        );
        cs.context.lastUsageAt = Date.now();
        cs.usage.sessionInput = (cs.usage.sessionInput || 0) + estInTokens;
        cs.usage.sessionOutput = (cs.usage.sessionOutput || 0) + estOutTokens;
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
        if (process.env.MCODE_USAGE_DEBUG) {
          console.log(
            `[usage.estimate.acp] cid=${cid} outLen=${outText.length} estOut=${estOutTokens} userLen=${userLen} estIn=${estInTokens} total=${estTotal} (no usage reported; estimated)`,
          );
        }
      }
      // Debug — see the actual usage payload mcode returned.
      if (process.env.MCODE_USAGE_DEBUG) {
        console.log(
          `[finalize.usage] cid=${cid} r.usage=${JSON.stringify(r.usage)} r.answerLen=${(r.answer || "").length} r.thinkingLen=${(r.thinking || "").length}`,
        );
      }
      // session-isolation/02 (run-mirror): only re-point the VIEWED
      // session's engine binding when the user is still looking at the
      // session that ran. A mid-run switch left cs bound to the OTHER
      // session — writing r.sessionId over it would redirect that
      // session's next turn onto this turn's engine conversation.
      // The still-viewing test covers both id forms: the pre-promotion
      // draft id (owningWebuiSessionId) and the post-promotion engine
      // id the record was renamed to at bind time.
      const stillViewingAtFinalize =
        !owningWebuiSessionId ||
        cs.sessionId === owningWebuiSessionId ||
        (r.sessionId != null && cs.sessionId === r.sessionId);
      if (r.sessionId && stillViewingAtFinalize) {
        cs.mcodeSessionId = r.sessionId;
      }
      // Fire-and-forget — the mavis hook writes a
      // local_runtime_token_usage row after acp completes. Wait ~400ms
      // for it to land, then query the db for the real numbers.
      // No rows → keep the estimate (estimated=true). Has rows →
      // overwrite (estimated=false).
      if (r.sessionId) {
        const mavisSid = r.sessionId;
        setTimeout(() => {
          applyMavisUsageToCs(cs, mavisSid, { getMcodeModelLimit })
            .then((applied) => {
              if (!applied && process.env.MCODE_USAGE_DEBUG)
                console.log(
                  `[usage.mavis] cid=${cid} sid=${mavisSid} no data in db, keep estimate`,
                );
              if (process.env.MCODE_USAGE_DEBUG && applied) {
                console.log(
                  `[usage.mavis] cid=${cid} sid=${mavisSid} (覆盖估算)`,
                );
              }
              pushStateFor(cid);
              // v0.5.bx-29: 同一 mcodeSessionId 的其它 cid (手机 + 电脑开同一 session) 也要更新
              //   修: 之前只有发起 prompt 的 cid 更新 context, 其它 CID 一直看估算
              const others = getCidsByMcodeSession(mavisSid).filter(
                (o) => o.cid !== cid,
              );
              if (process.env.MCODE_USAGE_DEBUG && others.length > 0) {
                console.log(
                  `[usage.mavis.broadcast] sid=${mavisSid} → ${others.length} other cid(s): ${others.map((o) => o.cid).join(",")}`,
                );
              }
              for (const { cid: otherCid, cs: otherCs } of others) {
                applyMavisUsageToCs(otherCs, mavisSid, { getMcodeModelLimit })
                  .then(() => pushStateFor(otherCid))
                  .catch(() => {});
              }
            })
            .catch((e) => {
              if (process.env.MCODE_USAGE_DEBUG)
                console.warn(`[usage.mavis] cid=${cid} error: ${e.message}`);
              pushStateFor(cid);
            });
        }, 400);
      }
      // v0.5.bx: prompt 完成后用 mcodeSessionId 反查 mcode 真实 title
      if (r.sessionId) {
        const finalSid = r.sessionId;
        // session-isolation/02 (run-mirror): binding and title belong to
        // the record that RAN, addressed by id — cs.sessionId is only
        // the right target while the user still views the owning
        // session (both id forms count; see stillViewingAtFinalize).
        // After a mid-run switch, writing through cs would stamp this
        // turn's engine sid (and title) onto the session the user
        // switched TO.
        const bindTargetId = stillViewingAtFinalize
          ? cs.sessionId
          : owningWebuiSessionId;
        getMcodeSessionTitle(finalSid)
          .then((title) => {
            // qa (两条记录): mcodeSessionId 绑定与 title 查询解耦 —— 之前
            //   `if (!title) return` 提前退出会连绑定一起跳过，titleCustom
            //   守卫也曾把绑定一并挡住（该守卫只应保护标题本身）。绑定
            //   无条件写入。
            if (bindTargetId) {
              try {
                const all = loadSessions();
                // The owning record may have been promoted mid-run — its
                // id is then the engine sid, not the captured webui id.
                const item =
                  all.find((s) => s && s.id === bindTargetId) ||
                  all.find((s) => s && s.mcodeSessionId === finalSid);
                if (item && item.mcodeSessionId !== finalSid) {
                  item.mcodeSessionId = finalSid;
                  item.updatedAt = Date.now();
                  saveSessions(all);
                }
              } catch (e) {
                console.warn(`[bx] save mcodeSid failed: ${e.message}`);
              }
            }
            if (!title) return;
            // 只在用户没改过（仍是默认标题）时更新
            const isDefault =
              !cs.sessionTitle ||
              cs.sessionTitle === "New session" ||
              cs.sessionTitle === "Untitled";
            if (isDefault && cs.mcodeSessionId === finalSid) {
              cs.sessionTitle = title;
            }
            // The record's title follows the conversation (the session
            // that ran), regardless of which session is on screen; the
            // cs-side mirror above only applies while still viewing.
            // qa (session-workspace-crud): titleCustom 是用户显式改名
            //   (POST /api/sessions/rename) 的留痕 — 自动标题永不覆盖
            //   用户标题。isDefault 的 cs 侧判定之外再守一道 item 侧，
            //   封住"改名发生在 title RPC 在途时"的竞态窗口。
            try {
              const all = loadSessions();
              const item =
                all.find((s) => s && s.id === bindTargetId) ||
                all.find((s) => s && s.mcodeSessionId === finalSid);
              if (item && !item.titleCustom && item.title !== title) {
                const recordIsDefault =
                  !item.title ||
                  item.title === "New session" ||
                  item.title === "Untitled" ||
                  item.title === "Mcode session";
                if (recordIsDefault) {
                  item.title = title;
                  item.updatedAt = Date.now();
                  saveSessions(all);
                }
              }
            } catch (e) {
              console.warn(`[bx] save title failed: ${e.message}`);
            }
            if (stillViewingAtFinalize) {
              pushStateFor(cid);
            }
          })
          .catch((e) =>
            console.warn(`[bx] getMcodeSessionTitle: ${e.message}`),
          );
        // v0.5.bv: 失效 mcode sessions cache + 异步拉新 list 推给 client
        invalidateMcodeSessionsCache();
        getMcodeSessionsForWorkspace(cs.workspace && cs.workspace.dir)
          .then(() => {
            pushStateFor(cid);
          })
          .catch(() => {});
      }
      pushStateFor(cid);
      resolve(r);
    }
    client
      .prompt(sid, buildPromptBlocks(content, attachments), (c) => {
        // v0.5.bm: 详细日志 — 看到 mcode acp 返回了什么
        console.log(
          `[acp.cb] kind=${c.kind} text=${JSON.stringify((c.text || "").slice(0, 200))} data=${JSON.stringify(c.data || "").slice(0, 200)}`,
        );
        // v0.5.bm: 处理 error 事件
        if (c.kind === "error" || c.error) {
          r.error = { message: c.text || c.error || JSON.stringify(c) };
          r.status = "failed";
          // v2.0 (lease B02): §AP5 — push the protocol-level error to
          // the anomaly channel. The chat.js handler will also
          // surface it (since r.status === "failed"), but firing
          // here gives operators an immediate, low-latency signal
          // even before the response object resolves.
          pushAlert({
            level: "error",
            msg: `[mcode-acp.protocol] ${r.error.message}`,
            src: "mcode-acp",
            cid: cid || null,
            sessionId: sid || null,
            data: { kind: c.kind, raw: c.data || null },
          });
          finalize();
          return;
        }
        if (c.kind === "usage" && c.update) {
          // v0.5.bx: mcode acp usage_update 事件（{used, size, cost} — 当前 session 已用 vs 上限）
          // 字段是累计值，直接覆盖 cs.context
          const u = c.update;
          if (process.env.MCODE_USAGE_DEBUG)
            console.log(`[usage.chunk] cid=${cid} update=${JSON.stringify(u)}`);
          if (typeof u.used === "number") {
            cs.context.used = u.used;
            cs.context.tokens = u.used;
          }
          if (typeof u.size === "number" && u.size > 0) {
            cs.context.limit = u.size;
          }
          if (cs.context.limit) {
            cs.context.percent = computeContextPercent(
              cs.context.used,
              cs.context.limit,
            );
          }
        } else if (c.kind === "thought" && typeof c.text === "string") {
          // session-isolation/06 (stream cumulative-render): each
          // agent_message segment starts fresh — the bug was that
          // r.thinking was turn-long, so after a tool_call line broke
          // streamUpdateLine's same-prefix chain, the next message
          // chunk appended a NEW `▲` line containing every prior
          // segment. Reset the buffer when the previous chunk kind
          // was something other than a thought.
          if (r.lastChunkKind !== "thought") r.thinking = "";
          r.thinking += c.text;
          r.lastChunkKind = "thought";
          const oneLine = r.thinking.replace(/\n+/g, " ").trim();
          streamUpdateLine(r.chatArray(), "▲", oneLine);
        } else if (c.kind === "message" && typeof c.text === "string") {
          if (r.lastChunkKind !== "message") r.answer = "";
          r.answer += c.text;
          r.lastChunkKind = "message";
          const oneLine = r.answer.replace(/\n+/g, " ").trim();
          streamUpdateLine(r.chatArray(), "●", oneLine);
        } else if (c.kind === "tool_call" && c.update) {
          // v0.5.bs: 工具调用开始 — 写 `→ toolName` 行到 chat
          const u = c.update;
          const name = u.title || u.name || u.toolName || "tool";
          const input = u.rawInput ? JSON.stringify(u.rawInput) : "";
          const line = input ? `→ ${name}  ${input}` : `→ ${name}`;
          // session-isolation/02: route into the runChat buffer (not
          // cs.chat) when in a turn. The viewing-session sees no
          // cross-contamination when the user switches mid-run.
          const tcChat = r && typeof r.chatArray === "function" ? r.chatArray() : cs.chat;
          tcChat.push(line);
          // 记下这行在 chat 里的位置（之后 tool_update 用来在它后面插输出）
          if (!r.toolIndexById) r.toolIndexById = new Map();
          r.toolIndexById.set(u.toolCallId, tcChat.length - 1);
          // session-isolation/06: tool_call (and tool_update,
          // plan_update, error, anything else) breaks the same-prefix
          // chain. Without this update, the next message chunk would
          // see lastChunkKind === "message" and skip the reset.
          // session-isolation/07: this reset set is the canonical one —
          // keep acp.mjs#prompt's result.lastChunkKind in sync (only
          // chat-line-breaking tool events reset there; usage / plan /
          // session_info events must NOT, they can interleave
          // MID-segment and an early reset would truncate
          // result.answer).
          r.lastChunkKind = "tool_call";
        } else if (c.kind === "tool_update" && c.update) {
          applyToolUpdate(r, cs, c.update);
        } else if (c.kind === "plan_update" && c.update) {
          // plan_update event
          const u = c.update;
          cs.plan = {
            active: true,
            planId: u.planId || null,
            title: u.title || "",
            summary: u.summary || "",
            options: Array.isArray(u.options)
              ? u.options.map((o) => ({
                  label: o.label || "",
                  desc: o.description || o.desc || "",
                }))
              : [],
          };
          console.log(
            `[plan.update] cid=${cid} planId=${cs.plan.planId} title="${(u.title || "").slice(0, 50)}" options=${cs.plan.options.length}`,
          );
        } else if (c.kind === "plan_removed" && c.update) {
          cs.plan = {
            active: false,
            planId: null,
            title: null,
            summary: "",
            options: [],
          };
          console.log(`[plan.removed] cid=${cid}`);
        } else if (c.kind === "mode_update" && c.update) {
          // v0.5.bx-9: mcode 切模式 (plan/ask/normal)
          const u = c.update;
          const mode = u.mode || u.currentMode || null;
          if (mode === "plan") {
            cs.enterPlanMode = {
              active: true,
              prompt: u.prompt || u.message || null,
            };
          } else {
            cs.enterPlanMode = { active: false, prompt: null };
          }
          console.log(`[mode.update] cid=${cid} mode=${mode}`);
        } else if (c.kind === "goal_update" && c.update) {
          // The engine does not always emit goal_update; the handler stays for when it does.
          const u = c.update;
          cs.goal = {
            active: !!u.active,
            text: u.text || u.description || null,
            status: u.status || null,
            duration: u.duration || null,
          };
          console.log(
            `[goal.update] cid=${cid} active=${cs.goal.active} status=${cs.goal.status}`,
          );
        } else if (c.kind === "config_option_update" && c.update) {
          // Another client changing the model or the permission mode is how
          // we learn about it; the engine sends the WHOLE option list here.
          applyConfigOptionUpdate(cs, c.update);
        } else if (c.kind === "session_info_update" && c.update) {
          // Session info change. The shape is undocumented, so log it and leave cs alone.
          const u = c.update;
          console.log(
            `[session.info] cid=${cid} keys=${JSON.stringify(Object.keys(u || {})).slice(0, 200)}`,
          );
        } else if (c.kind === "other" && c.update) {
          const u = c.update;
          if (u && u.sessionUpdate) {
            console.log(
              `[acp.other.event] sessionUpdate=${u.sessionUpdate} keys=${JSON.stringify(Object.keys(u)).slice(0, 200)}`,
            );
          }
        }
        const now = Date.now();
        if (cs.running.lastDeltaAt) {
          const dt = (now - cs.running.lastDeltaAt) / 1000;
          if (dt > 0) cs.running.tps = Math.round(1 / dt);
        }
        cs.running.lastDeltaAt = now;
        cs.context.tps = cs.running.tps;
        pushStateFor(cid);
      })
      .then((result) => {
        // session-isolation/07: the transport's result.answer/thinking
        // carry the LAST segment (per-segment discriminator in acp.mjs,
        // mirroring this callback's lastChunkKind resets) — not a
        // turn-long concatenation. `|| r.answer` keeps the
        // callback-derived value when the transport saw no chunks of
        // that kind; both sides now agree on the same segment
        // semantics, so the empty-turn note, the no-usage token
        // estimate, the ● finalize rewrite and the [send] result log
        // all read the final segment.
        r.answer = result.answer || r.answer;
        r.thinking = result.thinking || r.thinking;
        r.stopReason = result.stopReason;
        // v0.5.bx: 捕获 mcode 返的 usage（totalTokens/inputTokens/outputTokens/thoughtTokens）
        if (result.usage) r.usage = result.usage;
        r.status = "succeeded";
        // v2.3: 思考链超长回合（思维耗尽输出预算）以无正文结束 — 界面上
        //   表现为"思考戛然而止"。落一条 system 提示行说明结局与续法。
        const note = buildEmptyTurnNote(r.stopReason, r.answer);
        if (note) {
          const noteChat = r && typeof r.chatArray === "function" ? r.chatArray() : cs.chat;
          noteChat.push(note);
        }
        finalize();
      })
      .catch((e) => {
        r.status = "failed";
        r.error = { message: e.message };
        // v2.0 (lease B02): §AP5 — final-catch failure (anything
        // not already caught by the inner error handler).
        pushAlert({
          level: "error",
          msg: `[mcode-acp.stream] ${e.message}`,
          src: "mcode-acp",
          cid: cid || null,
          sessionId: sid || null,
          data: { phase: "promise-catch" },
        });
        finalize();
      });
  });
}
