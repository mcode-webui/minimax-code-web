// webui/server/routes/protocol.js
// v0.5.by: mcode acp 协议 RPC 路由层
// 每个端点对应一个 mcode-rpc.js 函数,做参数校验 + 状态更新 + push state
//
// 端点清单:
//   POST /api/protocol/set-mode           — plan_mode / goal_mode / 默认
//   POST /api/protocol/set-config-option  — 通用 (permissionMode / model 等)
//   POST /api/protocol/cancel             — 取消正在跑的 prompt (温和版, 替 child.kill())
//   POST /api/protocol/load-session       — 加载任意 mcode session (含 TUI 跑的)
//   POST /api/protocol/activate-session   — 切到指定 session
//   GET  /api/protocol/list-sessions      — 拉 mcode session 列表 (TUI 远控入口)
//
// 设计原则: 永远不 throw, 永远返 {ok, data?, error?, code?}; 状态变化后 pushStateFor(cid).

import { mcodePermissionToWebui } from "../lib/mcode-rpc.js";
// M3-B1 (engine facade): #72 (`list-sessions`) reads through
// `engine/session-reads.js`. Every handler in this file is now behind
// the facade — B1 here, B7 for the interrupt/load pair below, B9 for
// the mode-write pair — so this module's own imports of the RPC wrapper
// are down to the one pure conversion the client-state sync needs.
import { readEngineSessionList } from "../engine/session-reads.js";
// M3-B7 (engine facade): #69 (`cancel`), #70 (`load-session`) and #71
// (`activate-session`) now ask the facade. Two modules, because the
// families' gate policies are opposite and one module would force one
// to inherit the other's — the same split B2 drew between the tree
// read and the export enrichment. `interrupt.js` holds the SOFT
// declaration for the cancel pair (a provider without an interrupt
// surface still gets a truthful "I could not deliver it" answer);
// `session-load.js` holds #70's HARD `sessionCrud` · `loadSession`
// gate — the only hard gate in B7, and the one that keeps a sidebar
// entry from being written for a session the engine never loaded —
// beside #71's SOFT one, which is soft precisely because hard-gating it
// would be deciding the semantic-collapse question KNOWN DEBT 1 in that
// module's header says is still open.
import { sendEngineSessionCancel } from "../engine/interrupt.js";
import { loadEngineSession, activateEngineSession } from "../engine/session-load.js";
// M3-B9 (engine facade): #67 (`set-mode`) and #68 (`set-config-option`)
// now ask `engine/mode-writes.js`, which holds both HARD gates, both
// status tables, both response bodies and the `model` /
// `permissionMode` bridge. This is the first batch where the gate
// changes what a client sees, and the two handlers below are where the
// boundary is kept: the engine-gate 501 is written by the router and
// must never be caught here, and every OTHER outcome — including the
// pre-existing `code === "unsupported"` 501 and the 502/500 asymmetry
// between the two endpoints' unmapped codes — is byte for byte what it
// was.
import { setEngineSessionMode, setEngineSessionConfigOption } from "../engine/mode-writes.js";
// M3-B4 (engine facade): #73 (`capabilities`) now reads the engine's
// declared capability surface through the facade instead of reaching
// into `lib/mcode-rpc.js` and `lib/acp-client.js` from inside the
// handler. See `engine/capability-reads.js` for why the response gains
// the `engine` view rather than replacing the ACP wire table, and why
// this endpoint declares no capability of its own.
import { readEngineCapabilityView } from "../engine/capability-reads.js";
import { pushStateFor } from "../lib/state-bus.js";
import { readJson } from "../lib/read-json.js";


function respond(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// ============================================================
// POST /api/protocol/set-mode  { sessionId, mode }
//
// M3-B9: the hard `toolSkillInvocation` · `setMode` gate, the engine
// write, the `code` → status table and the success body live in
// `engine/mode-writes.js#setEngineSessionMode`.
//
// The gate throws for a provider that declares the mode write absent,
// and the router's existing central mapping answers it 501 — this
// route does not catch it, and must not: that 501 is "the engine cannot
// do this" and folding it into a status table here would turn it into a
// 502. What this handler keeps is the route's: the two 400s, the
// `cs.planMode` sync and the state push.
//
// The response this route can still write on a failure is the
// PRE-EXISTING one, from `code === "unsupported"` — the engine
// accepting the call and refusing it. Its body keeps
// `fallback: "send_plan_as_prompt"`, because there the feature exists
// and only this call did not work; the gate's 501 carries no `fallback`
// at all, because there is no degraded action to fall back TO. The two
// must not be confused for each other — KNOWN DEBT 1 in the engine
// module.
// ============================================================
export async function handleSetMode(req, res, ctx) {
  const { sessionId, mode } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  if (!mode) return respond(res, 400, { ok: false, error: "mode required" });
  const r = await setEngineSessionMode({ sessionId, mode });
  if (r.statusHint !== 200) return respond(res, r.statusHint, r.payload);
  // 同步本地 state.planMode 标志 (前端某些 UI 还读这个)
  // set-mode 端点只接 plan_mode 类的 mode 名, 不接 permission 类的 'off'/'default'
  //   (off 是 permission mode, 不是 plan mode 退出值 — 误用会让 mcode 看着像"退出 plan"
  //    实际是给 permissionMode 赋值, 后续 set_config_option 一调会引发灵异 bug)
  if (ctx && ctx.cs) {
    if (mode === "plan_mode" || mode === "plan") ctx.cs.planMode = true;
    else if (mode === "default" || mode === "normal") ctx.cs.planMode = false;
    // 其他 mode (goal_mode / 自定义) 不动 planMode
  }
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, r.payload);
}

// ============================================================
// POST /api/protocol/set-config-option  { sessionId, key, value }
// 通用配置选项。permissionMode / model / 等都走这里
//
// M3-B9: the hard `authCredentials` gate, the engine write, the status
// table and the success body live in
// `engine/mode-writes.js#setEngineSessionConfigOption`. The gate's
// sub-item is the request's own `key`, because that is what the bridge
// turns on: `model` and `permissionMode` ask for their dedicated
// sub-items and pass a provider that denies the generic config-option
// write, and every other config id asks for `setConfigOption` and gets
// the gate's 501. This handler is not involved in that decision and
// must not grow its own copy of it.
//
// As with #67: the gate's 501 is the router's and is not caught here,
// and the pre-existing `code === "unsupported"` 501 is preserved byte
// for byte. The two endpoints' unmapped-code rows stay 502 and 500
// respectively — pre-existing, asymmetric, and pinned as values.
// ============================================================
export async function handleSetConfigOption(req, res, ctx) {
  const { sessionId, key, value } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  if (!key) return respond(res, 400, { ok: false, error: "key required" });
  const r = await setEngineSessionConfigOption({
    sessionId,
    key,
    value,
    cid: ctx && ctx.cid,
  });
  if (r.statusHint !== 200) return respond(res, r.statusHint, r.payload);
  // 权限 mode 同步到 webui cs.permissions (供前端 icon/label 显示)
  if (key === "permissionMode" && ctx && ctx.cs) {
    ctx.cs.permissions = mcodePermissionToWebui(value);
  }
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, r.payload);
}

// ============================================================
// POST /api/protocol/cancel  { sessionId }
// 取消正在跑的 prompt。比 child.kill() 温和: 让 mcode 走完 finalize,而不是直接 SIGKILL
//
// M3-B7 (engine facade): the notification and the two response shapes
// live in `engine/interrupt.js#sendEngineSessionCancel`. What stays
// here is the route's: the 400 for a missing sessionId, the state
// push, and the rule that the push fires ONLY when the notification
// was actually delivered — a push on a refusal would re-assert the
// very claim the caller just failed to clear, and that conditional is
// the part the engine layer has no business knowing about.
//
// The endpoint still does NOT escalate: `session/cancel` is a
// notification, so the route cannot say whether the prompt stopped. A
// refusal therefore answers 200 with `cancelled:false` and a pointer
// to `/api/stop`, which is where the gentle-then-SIGKILL cascade lives.
// Claiming a hard kill here would be claiming a kill this handler
// never performs.
// ============================================================
export async function handleCancel(req, res, ctx) {
  const { sessionId } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  const r = await sendEngineSessionCancel({ sessionId, cid: ctx && ctx.cid });
  if (r.delivered && ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, r.payload);
}

// ============================================================
// POST /api/protocol/load-session  { sessionId, cwd?, createWebuiEntry? }
// 加载任意 mcode session (含 TUI 跑的)。
//  - 默认: 仅在 mcode 端 load, 不动 webui session
//  - createWebuiEntry=true: 同时在 webui session db 创建 entry (用于 sidebar 显示)
//
// M3-B7 (engine facade): the hard `sessionCrud` · `loadSession` gate,
// the engine load, the `code` → status and → wire-code mappings, and
// the idempotent sidebar entry all live in
// `engine/session-load.js#loadEngineSession`. The gate throws for a
// provider that declares the capability absent, and the router's
// existing central mapping answers it 501 — this route does not catch
// it, and must not: that 501 is the "the engine cannot do this" answer
// and folding it into a status table here would turn it into a 500.
//
// What stays is the route's: the 400, the status write, and the state
// push (which is unconditional on success, as it always was).
// ============================================================
export async function handleLoadSession(req, res, ctx) {
  const { sessionId, cwd, createWebuiEntry } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  const r = await loadEngineSession({
    sessionId,
    cwd,
    createWebuiEntry,
    cs: ctx && ctx.cs,
  });
  if (r.statusHint !== 200) return respond(res, r.statusHint, r.payload);
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, r.payload);
}

// ============================================================
// POST /api/protocol/activate-session  { sessionId }
// 切到指定 mcode session
//
// M3-B7 (engine facade): the soft gate, the engine activate, the
// status mapping, the `mcodeSessionId` rebinding and the `resetContext`
// that follows it all live in
// `engine/session-load.js#activateEngineSession`.
//
// The gate is SOFT and the response shape is unchanged on purpose. The
// endpoint's fate is an open product question — the plan (§3a) gives it
// as "语义塌缩（cs 切换 + resume）, 或 501", and hard-gating it would
// be silently choosing the second. KNOWN DEBT 1 in that module's
// header costs both branches. The 501 this route can still answer is
// the PRE-EXISTING one, from `code === "unsupported"` — a different
// status with a different body, and the two must not be confused for
// each other.
//
// What stays is the route's: the 400, the status write, and the state
// push (success only, as always).
// ============================================================
export async function handleActivateSession(req, res, ctx) {
  const { sessionId } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  const r = await activateEngineSession({ sessionId, cs: ctx && ctx.cs });
  if (r.statusHint !== 200) return respond(res, r.statusHint, r.payload);
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, r.payload);
}

// ============================================================
// GET /api/protocol/list-sessions?cwd=...
// 列 mcode session, 供前端 "远控 TUI" UI 用
//
// M3-B1: the list now comes from the engine facade
// (`server/engine/session-reads.js`) instead of `mcode-rpc.js#listSessions`
// directly, so this endpoint is gated on the same declared
// `sessionCrud.listSessions` as the sidebar's #9 and #72 share. The
// facade forwards to the same `listAllMcodeSessions()` the rpc wrapper
// called, which means the runtime path already went through
// `lib/catalogue-sessions.js`; the cwd filter below and the response
// shape are untouched — `mcode-rpc.js#listSessions` is still exported
// for the write-family callers that arrive with later batches.
// ============================================================
export async function handleListSessions(req, res, ctx) {
  const url = new URL(req.url, "http://localhost");
  const cwd = url.searchParams.get("cwd") || ctx?.cs?.workspace?.dir || "";
  const { sessions: all } = await readEngineSessionList();
  if (!cwd) return respond(res, 200, { ok: true, sessions: all });
  // 按 cwd 过滤 (norm 路径对齐)
  const norm = (p) =>
    (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = norm(cwd);
  const filtered = target ? all.filter((s) => norm(s.cwd) === target) : all;
  return respond(res, 200, { ok: true, sessions: filtered, cwd });
}

// ============================================================
// GET /api/protocol/capabilities
// 列出 mcode acp 实际支持的能力 — 供前端 capability detection,
//   决定按钮是否 disable / 降级路径
// mcode version 动态从 acp client initialize 响应读 (不再 hardcode)
//
// M3-B4: the handler no longer names `lib/mcode-rpc.js` or
// `lib/acp-client.js` — both moved behind
// `engine/capability-reads.js#readEngineCapabilityView`, which also
// resolves the provider whose DECLARED surface this endpoint now serves.
//
// `capabilities` IS the 14-key engine-capabilities view: a replacement
// for the `MCODE_ACP_CAPABILITIES` ACP wire table this field used to
// carry, approved as an endpoint contract change. The four
// `capabilities*` keys form one group — the declaration, which provider
// answered, how it was chosen, and the derived degradation roll-up — and
// the declaration appears exactly once.
//
// `capabilitiesProviderFor` says whether the declaration came from the
// active transport's provider or from the default provider standing in
// for a transport no provider claims yet (M4), so a consumer never
// mistakes a standing-in declaration for the connected engine's.
//
// `notes` stays here: it is prose about webui's own routes, not an
// engine read, and the facade has no business restating it.
// ============================================================
export async function handleCapabilities(_req, res) {
  const {
    declaration,
    unavailable,
    provider,
    providerFor,
    agent,
  } = await readEngineCapabilityView();
  return respond(res, 200, {
    ok: true,
    mcodeVersion: agent.version,
    mcodeName: agent.name,
    mcodeTitle: agent.title,
    capabilities: declaration,
    capabilitiesProvider: provider,
    capabilitiesProviderFor: providerFor,
    capabilitiesUnavailable: unavailable,
    notes: {
      set_mode: "Takes a modeId from the session's availableModes.",
      set_config_option:
        "With configId 'permissionMode' this changes the mode mid-session.",
      cancel:
        "Sent as a notification; /api/stop falls back to SIGKILL only when the client cannot be reached.",
      activate: "One acp client tracks a single active session.",
      fork: "Implemented by the engine; no webui route exposes it yet.",
    },
  });
}
