// webui/server/lib/capability.js
// ACP 方法能力协商（三层策略，替代旧 mcode-rpc.js 的静态 UNSUPPORTED 黑名单）。
//
// 三层策略：
//   1. 声明清单 — initialize 响应的 agentCapabilities.sessionCapabilities
//      与 _meta["minimax-code/extensions"].methods 直接采信；
//   2. 惰性探测 — 未声明方法首次真实调用即探测：Method not found(-32601)
//      判为不支持并缓存；其余错误或成功判为支持；
//   3. 旧引擎回退 — initialize 无任何声明（declared=false）时沿用
//      LEGACY_UNSUPPORTED 静态表语义（0.1.5 实测行为）。
//
// 设计约束：本模块零依赖、不 import 任何本地模块（避免 acp-client ↔ mcode-rpc
// 循环依赖）。契约修正（决策记录 19）：session/cancel 不再恒视为支持——
//   未声明时短路为 unsupported 且不派生 client（守护 no mcode spawn），
//   声明后由 mcode-rpc 走 notification 语义。

/**
 * 旧引擎（无任何能力声明）不支持的方法集合（mcode 0.1.5 实测语义）。
 * 注意：session/cancel 不参与回退判定（notification 恒尝试，见 classifyMethod）。
 */
export const LEGACY_UNSUPPORTED = new Set([
  "session/set_mode",
  "session/set_config_option",
  "session/cancel",
  "session/activate",
  "session/fork",
  "session/resume",
  "session/delete",
]);

/** 核心方法：协议基础能力，任何引擎都视为支持。 */
const CORE_ALWAYS_SUPPORTED = new Set([
  "initialize",
  "session/new",
  "session/load",
  "session/prompt",
  "session/list",
  "session/close",
]);

/** sessionCapabilities 键 → ACP 方法名映射。 */
const SESSION_CAPABILITY_METHODS = {
  list: "session/list",
  fork: "session/fork",
  resume: "session/resume",
  close: "session/close",
};

/** UI 能力位键 → 方法名映射（GET /api/protocol/capabilities 响应形状，保持 12 键不变）。 */
export const UI_METHOD_KEYS = {
  set_mode: "session/set_mode",
  set_config_option: "session/set_config_option",
  cancel: "session/cancel",
  activate: "session/activate",
  fork: "session/fork",
  resume: "session/resume",
  delete: "session/delete",
  load: "session/load",
  close: "session/close",
  list: "session/list",
  new: "session/new",
  prompt: "session/prompt",
};

/**
 * 解析 initialize 响应的声明式能力。
 *
 * @param {object} initializeResult initialize 的 JSON-RPC result
 * @returns {{ declared: boolean, session: Record<string, boolean>, extensionMethods: string[] }}
 */
export function resolveDeclaredCapabilities(initializeResult) {
  const r = initializeResult && typeof initializeResult === "object"
    ? initializeResult
    : {};
  const sessionCaps =
    r.agentCapabilities && typeof r.agentCapabilities === "object"
      ? r.agentCapabilities.sessionCapabilities
      : undefined;
  const ext = r._meta && typeof r._meta === "object"
    ? r._meta["minimax-code/extensions"]
    : undefined;
  const extensionMethods = Array.isArray(ext && ext.methods)
    ? ext.methods.filter((m) => typeof m === "string")
    : [];
  const session = {};
  let anySessionDeclared = false;
  for (const [key, method] of Object.entries(SESSION_CAPABILITY_METHODS)) {
    const present = Boolean(
      sessionCaps && typeof sessionCaps === "object" && key in sessionCaps,
    );
    session[method] = present;
    if (present) anySessionDeclared = true;
  }
  return {
    declared: anySessionDeclared || extensionMethods.length > 0,
    session,
    extensionMethods,
  };
}

/**
 * 判定一个 JSON-RPC 错误是否为「方法不存在」（Method not found）。
 * 兼容数值码 -32601、字符串码与 message 文本匹配。
 *
 * @param {unknown} error 被拒的错误对象（acp.mjs 附带 data: jsonrpc error）
 */
function isMethodNotFound(error) {
  if (!error) return false;
  const code = error && error.data ? error.data.code : undefined;
  if (code === -32601 || code === "-32601") return true;
  const msg = String(
    (error && error.data && error.data.message) || (error && error.message) || "",
  );
  return /method not found/i.test(msg);
}

/**
 * 创建能力注册表。
 *
 * @param {object} [opts]
 * @param {object} [opts.initializeResult] initialize 结果；缺省按旧引擎回退
 */
export function createCapabilityRegistry({ initializeResult } = {}) {
  const declared = resolveDeclaredCapabilities(initializeResult);
  const supported = new Set();
  const unsupported = new Set();
  // 声明清单预置
  for (const [method, present] of Object.entries(declared.session)) {
    (present ? supported : unsupported).add(method);
  }
  for (const m of declared.extensionMethods) supported.add(m);
  for (const m of CORE_ALWAYS_SUPPORTED) supported.add(m);
  // 旧引擎回退：无声明 → 黑名单语义（含 session/cancel——契约修正 19：
  //   未声明时短路不得触碰 client；声明 extensionMethods 含之才视为支持）
  if (!declared.declared) {
    for (const m of LEGACY_UNSUPPORTED) unsupported.add(m);
  }

  return {
    /** @returns {"supported"|"unsupported"|"unknown"} */
    classify(method) {
      if (supported.has(method)) return "supported";
      if (unsupported.has(method)) return "unsupported";
      return "unknown";
    },
    /** 真实调用结果即探测结果：Method not found → 不支持并缓存，其余 → 支持。 */
    recordProbeResult(method, error) {
      unsupported.delete(method);
      supported.delete(method);
      (error && isMethodNotFound(error) ? unsupported : supported).add(method);
    },
    markSupported(method) {
      unsupported.delete(method);
      supported.add(method);
    },
    /** @returns {{ supported: string[], unsupported: string[], unknown: string[] }} */
    snapshot() {
      const known = new Set([
        ...Object.values(UI_METHOD_KEYS),
        ...declared.extensionMethods,
        ...CORE_ALWAYS_SUPPORTED,
      ]);
      const out = { supported: [], unsupported: [], unknown: [] };
      for (const m of [...known].sort()) {
        out[this.classify(m)].push(m);
      }
      return out;
    },
  };
}

/**
 * 显式惰性探测的无副作用参数（缺必填字段，服务端在副作用前即以
 * invalidParams / resourceNotFound 拒绝）。真实调用的错误同样可作探测
 * 结果（recordProbeResult），本函数供显式预探测路径使用。
 *
 * @param {string} method ACP 方法名
 */
export function probeParamsFor(method) {
  if (method === "session/set_mode") return { sessionId: "" };
  if (method === "session/set_config_option") return { sessionId: "" };
  return {};
}

// ------------------------------------------------------------------
// 进程级活动注册表（acp-client 播种 / mcode-rpc 消费，无循环依赖）
// ------------------------------------------------------------------
let activeRegistry = createCapabilityRegistry({});

/** @returns {ReturnType<typeof createCapabilityRegistry>} */
export function getActiveRegistry() {
  return activeRegistry;
}

/**
 * 用 initialize 结果播种活动注册表并刷新 UI 能力映射。
 * 由 acp-client 在 client 启动成功后调用。
 */
export function syncActiveCapabilities(initializeResult) {
  activeRegistry = createCapabilityRegistry({ initializeResult });
  refreshCapabilityUi();
}

/** UI 能力映射（可变对象，routes/protocol.js 每次请求读取最新值）。 */
export const CAPABILITY_UI = {};

function refreshCapabilityUi() {
  for (const [key, method] of Object.entries(UI_METHOD_KEYS)) {
    CAPABILITY_UI[key] = activeRegistry.classify(method) !== "unsupported";
  }
}
refreshCapabilityUi();