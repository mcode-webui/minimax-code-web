// webui/server/lib/engine-host.worker.js
// 引擎宿主 Worker 入口 —— MessagePort RPC v:1（主线程侧见 mcode-embed.js）。
//
// 职责单一（一文件一职责）：
//   1. RPC v:1 协议编解码（boot / prompt / steer / cancel / shutdown →
//      booted / boot-failed / event / reply / fatal）；
//   2. boot 时动态 import 引擎应用服务（解析策略见 loadEngineAppService），
//      失败发 'boot-failed' —— 主线程据此回退到既有传输（ACP / exec）；
//   3. 未捕获异常 → 发 'fatal' 后退出，绝不让异常跨线程传播。
//
// 引擎会话编排（组合 RuntimeApplications / CliService 的完整启动面）超出本
// 「传输骨架」切片：prompt / steer / cancel 经「引擎适配器缝」调用 —— 引擎模块
// 导出 createEngineAdapter() 时生效，否则 reply {ok:false, error:'engine-adapter-missing'}
// （明确错误，由调用方决定是否回退）。适配器契约：
//   createEngineAdapter({ workspace }) → {
//     prompt(payload, emit) → Promise<{sessionId?, answer?, thinking?, stopReason?, usage?}>
//     steer(payload)        → Promise<object>
//     cancel(payload)       → Promise<object>
//   }
//   emit(NormalizedEvent) 逐字上行（→ {type:'event', payload}）；prompt 返回值
//   形状对齐 acp.mjs prompt() 的 result（thinking / answer / stopReason / usage）。

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";

// ── 引擎应用服务解析策略（按序尝试，各步均置于 try/catch）──────────────────
//   1. 仓库内相对路径 ../../../local-runtime-v2/dist/local/index.js
//      （= packages/local-runtime-v2/dist/local/index.js，构建产物入口）
//   2. 包导出 '@mavis/local-runtime-v2/cli-service'（安装布局）
// 当前仓库未构建 dist 属预期 —— 两种解析都会失败，走 'boot-failed' 路径。
const RELATIVE_ENTRY = new URL(
  "../../../local-runtime-v2/dist/local/index.js",
  import.meta.url,
);
const RELATIVE_PACKAGE_JSON = new URL(
  "../../../local-runtime-v2/package.json",
  import.meta.url,
);
const PACKAGE_SPEC = "@mavis/local-runtime-v2/cli-service";

// ── 模块状态 ────────────────────────────────────────────────────────────────
let engineModule = null; // boot 成功后的引擎应用服务模块
let adapter = null; // createEngineAdapter() 的产物（可缺省）
let workspace = ""; // boot 载荷里的工作区

/**
 * 消毒错误文本（复用 mcode-rpc.js 的 sanitizeError 规则：换行/控制字符去除、
 * 截断 200 字符），供 'boot-failed' / 'fatal' / reply error 载荷使用。
 * @param {unknown} e
 * @returns {string}
 */
function sanitizeError(e) {
  let msg;
  if (e && typeof e.message === "string") msg = e.message;
  else if (typeof e === "string") msg = e;
  else msg = String((e && e.message) || e);
  msg = msg
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (msg.length > 200) msg = msg.slice(0, 200) + "…";
  return msg;
}

/** 向主线程发一帧（端口已关闭时静默）。 */
function post(msg) {
  try {
    parentPort.postMessage(msg);
  } catch {
    /* 端口关闭中 —— 无需上行 */
  }
}

/** 回 RPC 应答（协议：{id, type:'reply', ok, payload | error}）。 */
function reply(id, ok, payload, error) {
  if (ok) post({ id, type: "reply", ok: true, payload: payload ?? {} });
  else post({ id, type: "reply", ok: false, error: sanitizeError(error) });
}

/** 发一帧后退出线程（fatal 用；下一跳让端口把帧冲出去）。 */
function postThenExit(msg, code) {
  post(msg);
  setImmediate(() => process.exit(code));
}

// 未捕获异常 → 'fatal' 后退出（协议规定：异常绝不跨线程传播）
process.on("uncaughtException", (e) =>
  postThenExit({ type: "fatal", payload: { error: sanitizeError(e) } }, 1),
);
process.on("unhandledRejection", (e) =>
  postThenExit({ type: "fatal", payload: { error: sanitizeError(e) } }, 1),
);

/**
 * 读取引擎版本：模块导出（engineVersion / version）优先，否则取相对布局下
 * local-runtime-v2/package.json 的 version，读不到返回 null。
 * @param {object} mod 引擎应用服务模块
 * @returns {string|null}
 */
function readEngineVersion(mod) {
  if (mod && typeof mod.engineVersion === "string") return mod.engineVersion;
  if (mod && typeof mod.version === "string") return mod.version;
  try {
    const pkg = JSON.parse(readFileSync(RELATIVE_PACKAGE_JSON, "utf8"));
    if (pkg && typeof pkg.version === "string") return pkg.version;
  } catch {
    /* 非仓库布局 —— 无版本可报 */
  }
  return null;
}

/**
 * 动态 import 引擎应用服务。两种解析策略依次尝试（均 try/catch），全部失败
 * 返回 {error} —— 调用方发 'boot-failed'，绝不抛出。
 * @returns {Promise<{module:object, engineVersion:string|null}|{error:string}>}
 */
async function loadEngineAppService() {
  const failures = [];
  try {
    const mod = await import(RELATIVE_ENTRY.href);
    return { module: mod, engineVersion: readEngineVersion(mod) };
  } catch (e) {
    failures.push(`relative(${RELATIVE_ENTRY.pathname}): ${sanitizeError(e)}`);
  }
  try {
    const mod = await import(PACKAGE_SPEC);
    return { module: mod, engineVersion: readEngineVersion(mod) };
  } catch (e) {
    failures.push(`package(${PACKAGE_SPEC}): ${sanitizeError(e)}`);
  }
  return { error: failures.join(" | ") };
}

/** 取引擎适配器（引擎模块导出 createEngineAdapter 时建立，未接线返回 null）。 */
function getAdapter() {
  if (adapter) return adapter;
  if (engineModule && typeof engineModule.createEngineAdapter === "function") {
    adapter = engineModule.createEngineAdapter({ workspace });
  }
  return adapter;
}

/** prompt RPC：经适配器跑一轮，事件逐字上行，结果回 reply。 */
async function handlePrompt(msg) {
  const a = getAdapter();
  if (!a || typeof a.prompt !== "function") {
    reply(
      msg.id,
      false,
      null,
      "engine-adapter-missing: engine module does not export createEngineAdapter() (engine wiring is a later slice)",
    );
    return;
  }
  try {
    const result = await a.prompt(msg.payload, (event) =>
      post({ type: "event", payload: event }),
    );
    const r = result || {};
    reply(msg.id, true, {
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.answer ? { answer: r.answer } : {}),
      ...(r.thinking ? { thinking: r.thinking } : {}),
      // stopReason 缺省 'end_turn' —— 对齐 acp.mjs prompt() 的 result 归一化
      stopReason: r.stopReason || "end_turn",
      ...(r.usage ? { usage: r.usage } : {}),
    });
  } catch (e) {
    reply(msg.id, false, null, e);
  }
}

/** steer / cancel RPC：经适配器转发，结果回 reply。 */
async function handleAdapterCall(msg, method) {
  const a = getAdapter();
  if (!a || typeof a[method] !== "function") {
    reply(
      msg.id,
      false,
      null,
      `engine-adapter-missing: no ${method}() on engine adapter`,
    );
    return;
  }
  try {
    reply(msg.id, true, (await a[method](msg.payload)) || {});
  } catch (e) {
    reply(msg.id, false, null, e);
  }
}

// ── RPC v:1 分发 ────────────────────────────────────────────────────────────
parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.v != null && msg.v !== 1) {
    if (msg.id != null) {
      reply(msg.id, false, null, `unsupported protocol version ${msg.v}`);
    }
    return;
  }
  switch (msg.type) {
    case "boot": {
      workspace = (msg.payload && msg.payload.workspace) || "";
      loadEngineAppService().then((r) => {
        if (r.error) {
          post({ type: "boot-failed", payload: { error: sanitizeError(r.error) } });
          return;
        }
        engineModule = r.module;
        post({
          type: "booted",
          payload: { engineVersion: r.engineVersion },
        });
      });
      return;
    }
    case "prompt":
      void handlePrompt(msg);
      return;
    case "steer":
      void handleAdapterCall(msg, "steer");
      return;
    case "cancel":
      void handleAdapterCall(msg, "cancel");
      return;
    case "shutdown": {
      reply(msg.id, true, { shutdown: true });
      // 关闭端口后线程自然退出 —— 无悬挂句柄；若引擎残留句柄，
      // 主线程 stopEmbed() 的 terminate 兜底会强制收束。
      parentPort.close();
      return;
    }
    default:
      if (msg.id != null) {
        reply(msg.id, false, null, `unknown request type ${msg.type}`);
      }
  }
});
