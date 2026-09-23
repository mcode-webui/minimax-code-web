// webui/test/fixtures/engine-host.stub.worker.js
// engine-host.worker.js 的协议桩：不加载引擎，完整实现 MessagePort RPC v:1
// （boot / prompt / steer / cancel / shutdown → booted / boot-failed / event /
// reply / fatal）。事件序列 / boot-failed / fatal 均可经 workerData.script 脚本化。
//
// script = {
//   boot: 'ok' | 'fail',              // 缺省 'ok'
//   engineVersion: string,            // boot:'ok'   → {type:'booted', payload:{engineVersion}}
//   bootError: string,                // boot:'fail' → {type:'boot-failed', payload:{error}}
//   prompts: [{                       // 按 prompt 到达顺序消费；最后一项复用于后续 prompt
//     events: [ NormalizedEvent | {delay: ms} | {fatal: {error}} ],
//     reply:  {ok: true, payload: {...}} | {ok: false, error: '...'},
//   }],
//   steer:  {ok: true, payload: {...}} | {ok: false, error: '...'},
//   cancel: {ok: true, payload: {...}} | {ok: false, error: '...'},
// }
// events 里的 NormalizedEvent 原样作为 {type:'event', payload} 上行（逐字透传，
// 与生产 Worker 同语义）；{delay} 是脚本排程用的停顿；{fatal} 发 'fatal' 帧后
// 退出线程且不回 reply。

import { parentPort, workerData } from "node:worker_threads";

const script = (workerData && workerData.script) || {};
let promptCount = 0;

/** 向主线程发一帧（端口已关闭时静默 —— shutdown 后脚本可能仍有余波）。 */
function post(msg) {
  try {
    parentPort.postMessage(msg);
  } catch {
    /* 端口关闭中 */
  }
}

/** 回 RPC 应答（协议：{id, type:'reply', ok, payload | error}）。 */
function reply(id, ok, payload, error) {
  if (ok) post({ id, type: "reply", ok: true, payload: payload ?? {} });
  else post({ id, type: "reply", ok: false, error: String(error || "stub error") });
}

/** 发 fatal 帧后退出线程（协议：未捕获异常不跨线程传播）。 */
function postThenExit(msg, code) {
  post(msg);
  setImmediate(() => process.exit(code));
}

// 桩也完整实现 fatal 语义：真正的未捕获异常同样发 'fatal' 后退出。
process.on("uncaughtException", (e) =>
  postThenExit({ type: "fatal", payload: { error: String((e && e.message) || e) } }, 1),
);
process.on("unhandledRejection", (e) =>
  postThenExit({ type: "fatal", payload: { error: String((e && e.message) || e) } }, 1),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 消费一段 prompt 脚本：事件逐帧上行后回 reply（fatal 指令除外）。 */
async function runPromptScript(msg) {
  const list =
    Array.isArray(script.prompts) && script.prompts.length
      ? script.prompts
      : [{}];
  const s = list[Math.min(promptCount++, list.length - 1)];
  for (const item of Array.isArray(s.events) ? s.events : []) {
    if (item && typeof item.delay === "number") {
      await sleep(item.delay);
      continue;
    }
    if (item && item.fatal) {
      postThenExit(
        { type: "fatal", payload: { error: String(item.fatal.error || "scripted fatal") } },
        1,
      );
      return; // fatal 后不回 reply
    }
    post({ type: "event", payload: item });
  }
  const r = s.reply || { ok: true, payload: {} };
  if (r.ok === false) reply(msg.id, false, null, r.error || "scripted failure");
  else reply(msg.id, true, r.payload || {});
}

/** steer / cancel 的脚本化应答。 */
function runSimpleScript(msg, key, fallback) {
  const s = script[key] || fallback;
  if (s.ok === false) reply(msg.id, false, null, s.error || "scripted failure");
  else reply(msg.id, true, s.payload || {});
}

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
      if (script.boot === "fail") {
        post({
          type: "boot-failed",
          payload: { error: String(script.bootError || "stub boot-failed") },
        });
      } else {
        post({
          type: "booted",
          payload: { engineVersion: String(script.engineVersion || "stub-0.0.0") },
        });
      }
      return;
    }
    case "prompt":
      void runPromptScript(msg);
      return;
    case "steer":
      runSimpleScript(msg, "steer", { ok: true, payload: { steered: true } });
      return;
    case "cancel":
      runSimpleScript(msg, "cancel", { ok: true, payload: { canceled: true } });
      return;
    case "shutdown": {
      reply(msg.id, true, { shutdown: true });
      // 关闭端口后线程自然退出 —— 「shutdown 无悬挂句柄」的被测语义
      parentPort.close();
      return;
    }
    default:
      if (msg.id != null) {
        reply(msg.id, false, null, `unknown request type ${msg.type}`);
      }
  }
});
