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

async function callRpc(method, params) {
  const client = await getMcodeAcpClient();
  if (!client)
    return fail(new Error("mcode acp client unavailable"), "no_client");
  try {
    const r = await client.request(method, params);
    return ok(r);
  } catch (e) {
    if (e && e.data && typeof e.data.code === "string")
      return fail(e, e.data.code);
    return fail(e);
  }
}

async function notifyRpc(method, params) {
  const client = await getMcodeAcpClient();
  if (!client)
    return fail(new Error("mcode acp client unavailable"), "no_client");
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
export async function setMode(sessionId, modeId) {
  return callRpc("session/set_mode", { sessionId, modeId });
}

// ============================================================
// session/set_config_option — forwarded to the engine
//   The wire field is `configId`, and `value` must be a string. For permission
//   modes configId is 'permissionMode' (ACP_CONFIG_PERMISSION_MODE in
//   packages/tui/src/acp/control-state.ts) and value is one of PERMISSION_MODES.
// ============================================================
export async function setConfigOption(sessionId, configId, value) {
  return callRpc("session/set_config_option", {
    sessionId,
    configId,
    value,
  });
}

// ============================================================
// session/cancel — a NOTIFICATION, not a request
//   The engine registers it with app.onNotification (packages/tui/src/acp/
//   agent.ts), which aborts the active prompt's AbortController; a request
//   would come back "Method not found". It carries no reply, so a success here
//   means "sent", not "the prompt stopped".
// ============================================================
export async function cancelSession(sessionId) {
  return notifyRpc("session/cancel", { sessionId });
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
