// webui/server/lib/mcode-acp.js
// mcode acp protocol streaming — streamAcpPrompt + runMcodeAcp.

import { McodeAcpClient } from "../../acp.mjs";
import { DEFAULT_WORKSPACE, DEFAULT_MODEL, PROMPT_IDLE_TIMEOUT_MS } from "./config.js";
import { createIdleWatchdog } from "./idle-watchdog.js";
import { streamUpdateLine } from "./chat-line.js";
import { bindDraftToMcodeSid, computeContextPercent } from "./sessions.js";
import {
  setActiveChild,
  clearActiveChild,
  pushStateFor,
  pushAlert,
  getCidsByMcodeSession,
} from "./state-bus.js";
import { applyMavisUsageToCs } from "./mavis-usage.js";
import { mcodePermissionToWebui } from "./mcode-rpc.js";
import {
  getMcodeSessionTitle,
  invalidateMcodeSessionsCache,
  getMcodeSessionsForWorkspace,
} from "./acp-client.js";
import { getMcodeModelLimit } from "./models.js";
import { loadSessions, saveSessions } from "./sessions.js";

// runMcodeAcp / streamAcpPrompt — mcode acp protocol streaming.
//
// If cs.permissions is set to anything other than "Full access", the
// acp protocol layer does not expose permission push — fall back to
// mcode-exec (which honours --permission ask/full/auto/off).
export async function runMcodeAcp(content, opts = {}) {
  const label = opts.label || "prompt";
  const existingSid = opts.sessionId || null;
  const cs = opts.cs;
  const cid = opts.cid;
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
    // qa (两条记录): 草稿→引擎身份的绑定在 session 创建时立即执行，不再
    //   等到 finalize。之前长任务全程草稿是 uuid 孤儿 —— sidebar 同时显示
    //   uuid 草稿和 mvs_ 引擎条目两条；此时点 mvs_ 条目会走 new_from_mcode
    //   建壳，把同一对话永久分裂成两条记录（审计日志实锤）。幂等。
    if (sid) {
      try {
        bindDraftToMcodeSid(cs, sid);
      } catch (e) {
        console.warn(`[webui] bindDraftToMcodeSid: ${e.message}`);
      }
    }
    return await streamAcpPrompt(client, sid, content, label, cs, cid);
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
// `mcodePermissionToWebui`, and propagates `model.currentValue` into
// `cs.model.name`. The model field is read with the same
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

  let insertAfter = r.toolIndexById.get(u.toolCallId);
  if (insertAfter == null) {
    const name = u.title || u.name || u.toolName || "tool";
    cs.chat = [...cs.chat, `→ ${name}`];
    insertAfter = cs.chat.length - 1;
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

  cs.chat = [
    ...cs.chat.slice(0, insertAfter + 1),
    ...newLines,
    ...cs.chat.slice(insertAfter + 1),
  ];
  if (r.toolIndexById) {
    for (const [k, v] of r.toolIndexById) {
      if (v > insertAfter) r.toolIndexById.set(k, v + newLines.length);
    }
  }
}

// streamAcpPrompt — like collectExecResult, but the event source is
// the acp client's prompt callback rather than a child-process stdout
// stream.
function streamAcpPrompt(client, sid, content, label, cs, cid) {
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
        r.durationMs > 0 &&
        Array.isArray(cs.chat)
      ) {
        cs.chat = [
          ...cs.chat,
          `§§ processed_duration=${Math.round(r.durationMs)}ms`,
        ];
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
      if (Array.isArray(cs.chat)) {
        cs.chat = cs.chat.map((line) =>
          typeof line === "string" && line.endsWith(" ▍")
            ? line.slice(0, -2)
            : line,
        );
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
      if (r.sessionId) cs.mcodeSessionId = r.sessionId;
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
        getMcodeSessionTitle(finalSid)
          .then((title) => {
            // qa (两条记录): mcodeSessionId 绑定与 title 查询解耦 —— 之前
            //   `if (!title) return` 提前退出会连绑定一起跳过，titleCustom
            //   守卫也曾把绑定一并挡住（该守卫只应保护标题本身）。绑定
            //   无条件写入。
            if (cs.sessionId) {
              try {
                const all = loadSessions();
                const item = all.find((s) => s.id === cs.sessionId);
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
              // 同步到 webui session db（写 title，让 sidebar 能 1:1 找回来）
              if (cs.sessionId) {
                try {
                  const all = loadSessions();
                  const item = all.find((s) => s.id === cs.sessionId);
                  // qa (session-workspace-crud): titleCustom 是用户显式改名
                  //   (POST /api/sessions/rename) 的留痕 — 自动标题永不覆盖
                  //   用户标题。isDefault 的 cs 侧判定之外再守一道 item 侧，
                  //   封住"改名发生在 title RPC 在途时"的竞态窗口。
                  if (item && !item.titleCustom) {
                    item.title = title;
                    item.updatedAt = Date.now();
                    saveSessions(all);
                  }
                } catch (e) {
                  console.warn(`[bx] save title failed: ${e.message}`);
                }
              }
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
      .prompt(sid, content, (c) => {
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
          r.thinking = (r.thinking || "") + c.text;
          const oneLine = r.thinking.replace(/\n+/g, " ").trim();
          streamUpdateLine(cs.chat, "▲", oneLine);
        } else if (c.kind === "message" && typeof c.text === "string") {
          r.answer = (r.answer || "") + c.text;
          const oneLine = r.answer.replace(/\n+/g, " ").trim();
          streamUpdateLine(cs.chat, "●", oneLine);
        } else if (c.kind === "tool_call" && c.update) {
          // v0.5.bs: 工具调用开始 — 写 `→ toolName` 行到 chat
          const u = c.update;
          const name = u.title || u.name || u.toolName || "tool";
          const input = u.rawInput ? JSON.stringify(u.rawInput) : "";
          const line = input ? `→ ${name}  ${input}` : `→ ${name}`;
          cs.chat = [...cs.chat, line];
          // 记下这行在 chat 里的位置（之后 tool_update 用来在它后面插输出）
          if (!r.toolIndexById) r.toolIndexById = new Map();
          r.toolIndexById.set(u.toolCallId, cs.chat.length - 1);
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
        r.answer = result.answer || r.answer;
        r.thinking = result.thinking || r.thinking;
        r.stopReason = result.stopReason;
        // v0.5.bx: 捕获 mcode 返的 usage（totalTokens/inputTokens/outputTokens/thoughtTokens）
        if (result.usage) r.usage = result.usage;
        r.status = "succeeded";
        // v2.3: 思考链超长回合（思维耗尽输出预算）以无正文结束 — 界面上
        //   表现为"思考戛然而止"。落一条 system 提示行说明结局与续法。
        const note = buildEmptyTurnNote(r.stopReason, r.answer);
        if (note) cs.chat = [...(cs.chat || []), note];
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
