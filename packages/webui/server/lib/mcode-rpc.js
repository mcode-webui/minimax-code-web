// webui/server/lib/mcode-rpc.js
// ACP RPC wrapper.
//
// Every method here has an engine handler: packages/tui/src/acp/agent.ts
// registers session.new/list/load/resume/close/setMode/setConfigOption/prompt,
// and extensions.ts registers session/activate. `session/delete` is the sole
// exception — see MCODE_ACP_CAPABILITIES.
//
// A failure comes back as {ok:false, error, code} instead of throwing, so the
// route layer maps `code` onto a status rather than answering 500.

import { getMcodeAcpClient, listAllMcodeSessions } from "./acp-client.js";
import { getActiveChild } from "./state-bus.js";

function ok(data) {
  return { ok: true, data };
}
// Sanitize mcode 端返的错误 message:
//   - 截断 200 字符 (避免吐一坨 stack 给前端)
//   - 换行/CR 替换成空格 (jsonrpc error message 经常含换行, 会破坏响应 JSON)
//   - 去掉控制字符 (避免 log 注入)
function sanitizeError(e) {
  let msg;
  if (e && typeof e.message === "string") msg = e.message;
  else if (e && typeof e === "string") msg = e;
  else msg = String(e?.message || e);
  msg = msg
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (msg.length > 200) msg = msg.slice(0, 200) + "…";
  return msg;
}
function fail(error, code) {
  return { ok: false, error: sanitizeError(error), code: code || "rpc_error" };
}

/**
 * Pick the right acp client for a session-bound RPC.
 *
 * `runMcodeAcp` (server/lib/mcode-acp.js) creates a fresh `McodeAcpClient`
 * per prompt and registers it on the cid's "active child". The transport the
 * singleton (`getMcodeAcpClient()`) opens is a different process, so a
 * request/notification routed through the singleton lands on a subprocess
 * whose `sessions` map does not contain the one the caller is operating on;
 * `requireAttachedSession` on the engine side then refuses the call, and
 * the route silently returns "not synced" — the route layer's `mcodeSynced`
 * stays false and the user sees nothing change. See mcode-rpc.js history
 * for the matching entry point and tests/server/mcode-rpc.test.js for the
 * regression test that asserts this dispatch.
 *
 * Falls back to the singleton when there is no active child, because the
 * commands-probe and session/list paths still need it.
 */
async function clientForCid(cid, requireLive) {
  if (cid) {
    const child = getActiveChild(cid);
    // Require the RPC surface, not merely a liveness flag. `activeChildByCid`
    // holds two different kinds of object: an `McodeAcpClient` (ACP transport,
    // has `.request` / `.notify` / `.alive`) and a raw `ChildProcess` (exec
    // transport, has neither). Testing `.alive` alone happened to exclude the
    // exec child only because that class has no such property — which then made
    // every exec-mode `requireLive` lookup fail with a message implying the
    // engine was unavailable, when in fact exec has no engine session to talk
    // to at all. Keying on the capability makes it correct by contract.
    if (child && typeof child.request === "function" && child.alive) return child;
  }
  if (requireLive) return null;
  return await getMcodeAcpClient();
}

// Exported for tests that want to assert the dispatch without going through
// the full setupMocks wrapper. The route layer relies on this same function.
export { clientForCid };

/**
 * Why a `requireLive` lookup found nothing, in terms the caller can act on.
 *
 * There are two very different reasons, and collapsing them into one
 * "mcode acp client unavailable" string misreports a structural property as a
 * transient outage:
 *
 *  - An **exec** run registers a raw `ChildProcess` (`mcode-exec.js`), which has
 *    no RPC surface at all. `session/set_config_option` and `session/cancel`
 *    are not merely undeliverable to it — they are inapplicable, because the
 *    one-shot `mcode exec` CLI has no persistent engine session to configure.
 *    (The transport choice is `cs.permissions !== "Full access"`; see
 *    `runMcodeAcp`.) A permission or model change still takes effect, on the
 *    *next* turn, because `cs.permissions` is what selects the transport and
 *    supplies the mode for the next spawn.
 *  - Nothing is registered for this cid, meaning no turn is in flight — also
 *    normal, and also not an error the user should act on beyond retrying.
 *
 * Returning a distinct `code` lets the route word its warning accurately
 * instead of implying the engine refused a change it was never asked to make.
 */
function noLiveClientFailure(cid) {
  const child = cid ? getActiveChild(cid) : null;
  if (child && typeof child.request !== "function") {
    return fail(
      new Error(
        "this turn uses the exec transport, which has no live engine session to update — the change applies from the next turn",
      ),
      "no_acp_session",
    );
  }
  return fail(new Error("mcode acp client unavailable"), "no_client");
}

async function callRpc(method, params, opts = {}) {
  const client = await clientForCid(opts.cid, opts.requireLive);
  if (!client) {
    return opts.requireLive ? noLiveClientFailure(opts.cid) : fail(new Error("mcode acp client unavailable"), "no_client");
  }
  try {
    const r = await client.request(method, params ?? probeParamsFor(method));
    getActiveRegistry().markSupported(method);
    return ok(r);
  } catch (e) {
    // 惰性探测: 真实调用的错误即探测结果 — Method not found 判不支持并缓存
    getActiveRegistry().recordProbeResult(method, e);
    if (getActiveRegistry().classify(method) === "unsupported") {
      return fail(
        `mcode acp does not implement ${method} (mcode 0.1.5 server returns "Method not found")`,
        "unsupported",
      );
    }
    if (e && e.data && typeof e.data.code === "string")
      return fail(e, e.data.code);
    return fail(e);
  }
}

async function notifyRpc(method, params, opts = {}) {
  const client = await clientForCid(opts.cid, opts.requireLive);
  if (!client) {
    return opts.requireLive ? noLiveClientFailure(opts.cid) : fail(new Error("mcode acp client unavailable"), "no_client");
  }
  try {
    await client.notify(method, params);
    return ok({ notified: true });
  } catch (e) {
    if (e && e.data && typeof e.data.code === "string")
      return fail(e, e.data.code);
    return fail(e);
  }
}

// ============================================================
// session/set_mode — forwarded to the engine
//   The wire field is `modeId`, and it must be one of the session's
//   availableModes (packages/tui/src/acp/control-state.ts: 'default' / 'plan'),
//   or the engine answers invalidParams. This is not the permission mode —
//   that is a config option, below.
// ============================================================
export async function setMode(sessionId, modeId, cid) {
  return callRpc("session/set_mode", { sessionId, modeId }, { cid });
}

// ============================================================
// session/set_config_option — forwarded to the engine
//   The wire field is `configId`, and `value` must be a string. For permission
//   modes configId is 'permissionMode' (ACP_CONFIG_PERMISSION_MODE in
//   packages/tui/src/acp/control-state.ts) and value is one of PERMISSION_MODES.
// ============================================================
export async function setConfigOption(sessionId, configId, value, cid) {
  return callRpc(
    "session/set_config_option",
    { sessionId, configId, value },
    { cid, requireLive: true },
  );
}

// ============================================================
// session/cancel — a NOTIFICATION, not a request
//   The engine registers it with app.onNotification (packages/tui/src/acp/
//   agent.ts), which aborts the active prompt's AbortController; a request
//   would come back "Method not found". It carries no reply, so a success here
//   means "sent", not "the prompt stopped".
//
//   `cid` here matters: handleStop already holds the live child via
//   `getActiveChild(cid)`. Routing through the cid pins the notification on
//   the same subprocess that owns the in-flight prompt's AbortController.
//   Without it, the notification goes to the singleton's subprocess, which
//   does not have the prompt's session loaded — the engine answers "session
//   not found" via _rejectAllPending on the caller side and the cancel is a
//   no-op while the prompt keeps running.
// ============================================================
export async function cancelSession(sessionId, cid) {
  return notifyRpc("session/cancel", { sessionId }, { cid, requireLive: true });
}

// ============================================================
// session/load — forwarded to the engine
//   Loads any mcode session, including one the TUI started.
// ============================================================
export async function loadSession(sessionId, cwd) {
  if (!sessionId)
    return fail(new Error("sessionId required"), "missing_session");
  const client = await getMcodeAcpClient();
  if (!client)
    return fail(new Error("mcode acp client unavailable"), "no_client");
  try {
    const r = await client.request("session/load", {
      sessionId,
      cwd: cwd || "",
      mcpServers: [],
    });
    return ok(r);
  } catch (e) {
    if (e && e.data && typeof e.data.code === "string")
      return fail(e, e.data.code);
    return fail(e);
  }
}

// ============================================================
// session/activate — forwarded to the engine
//   Registered by extensions.ts. One acp client tracks a single active session,
//   so activating another is how the client is pointed at it.
// ============================================================
export async function activateSession(sessionId) {
  return callRpc("session/activate", { sessionId });
}

// ============================================================
// mcode/account/status — the account card's data, an ACP extension method.
//   The engine returns an allow-list projection (display name, plan tier, quota);
//   no credential is read on either side. The session id is optional, because the
//   card is visible before a session exists.
// ============================================================
export async function getAccountStatus(sessionId) {
  return callRpc("mcode/account/status", sessionId ? { sessionId } : {});
}

// ============================================================
// session/close — forwarded to the engine
// ============================================================
export async function closeSession(sessionId) {
  if (!sessionId)
    return fail(new Error("sessionId required"), "missing_session");
  const client = await getMcodeAcpClient();
  if (!client)
    return fail(new Error("mcode acp client unavailable"), "no_client");
  try {
    const r = await client.request("session/close", { sessionId });
    return ok(r);
  } catch (e) {
    if (e && e.data && typeof e.data.code === "string")
      return fail(e, e.data.code);
    return fail(e);
  }
}

// ============================================================
// session/list — forwarded to the engine
// ============================================================
export async function listSessions() {
  return listAllMcodeSessions();
}

// ============================================================
// What the frontend may call through this wrapper, for capability detection.
// ============================================================
export const MCODE_ACP_CAPABILITIES = {
  set_mode: true,
  set_config_option: true,
  cancel: true,
  activate: true,
  // The engine implements fork and resume but no webui route exposes them yet.
  fork: true,
  resume: true,
  // Not available at any layer: mcode's protocol registers `session/delete` but
  // implements no handler, which is why deletes go through SQL on the
  // local_runtime_* tables (see sqlite-resolver.js).
  delete: false,
  load: true,
  close: true,
  list: true,
  new: true,
  prompt: true,
};

// Valid permission modes from the CLI config schema. session/set_config_option is
// refused by this wrapper, so a mode can only be set through mcode's --permission
// startup flag, not mid-session.
export const PERMISSION_MODES = [
  "default",
  "bypassPermissions",
  "auto",
  "off",
  "read",
  "full",
];

// webui UI label → mcode 配置值 (仅供参考, mid-session 切换不可用)
const WEBUI_TO_MCODE_PERMISSION = {
  ask: "default",
  full: "bypassPermissions",
  auto: "auto",
  read: "read",
  default: "default",
  bypassPermissions: "bypassPermissions",
  off: "off",
};
export function webuiPermissionToMcode(webuiMode) {
  return WEBUI_TO_MCODE_PERMISSION[webuiMode] || null;
}

const MCODE_TO_WEBUI_PERMISSION = {
  default: "Ask",
  bypassPermissions: "Full access",
  auto: "Auto",
  off: "Off",
  read: "Read",
  full: "Full access",
};
export function mcodePermissionToWebui(mcodeMode) {
  return MCODE_TO_WEBUI_PERMISSION[mcodeMode] || mcodeMode || "Full access";
}
