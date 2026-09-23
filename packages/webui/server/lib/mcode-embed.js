// webui/server/lib/mcode-embed.js
// 传输抽象层第三实现 —— 引擎宿主 Worker（arch_net_draft_0922.md §6 方案 C：
// worker_threads + MessagePort 结构化克隆）。与 mcode-acp.js（ACP 子进程）、
// mcode-exec.js（headless 子进程）同属「runMcode → NormalizedEvent」传输契约，
// 三条泳道的角色分配见草案 §6.3（主 agent / side-chat / 子 agent）。
//
// 本模块是纯新增内部模块：不接线 chat.js、不改前端，默认旧行为完全不变；
// 是否启用本传输的回退决策在调用方（阶段 1 的 MCODE_ENGINE=acp 逃生门）。
//
// ── 导出面与传输契约对齐 mcode-acp.js / mcode-exec.js ─────────────────────
//   runMcodeEmbed(content, opts) → AsyncGenerator<NormalizedEvent>
//     - 事件与 mcode-acp.js 流回调消费的对象逐字段一致（见下方 NormalizedEvent），
//       逐字透传、不改写；
//     - 生成器返回值 = streamAcpPrompt 的收尾结果 r（字段与 runMcodeAcp 返回值
//       一致：answer / thinking / status / error / usage / sessionId /
//       durationMs / stopReason / tps），finalize 语义逐点对齐：恰好一次、
//       durationMs 兜底、空闲看门狗停止、状态词汇 'succeeded' | 'failed' |
//       'timeout' | 'stopped'（'stopped' 对应 mcode-exec.js 的 r._stopped 词汇）。
//   stopEmbed() / isEmbedRunning()
//     - 对齐 ARCHITECTURE.md §3 传输契约的 stopExec() / isRunning() 配对语义。
//   steerEmbed(sessionId, text) / cancelEmbed(sessionId)
//     - 协议 v:1 的 steer / cancel RPC 发送方（草案 §7.7 的 runtime.steer 与
//       语义 cancel 通道）；供后续接线使用，本切片以桩测试锁往返语义。
//
// ── NormalizedEvent（tagged union：{kind, …}）────────────────────────────
// 与 acp.mjs prompt() 的 onChunk 载荷、即 mcode-acp.js streamAcpPrompt 流回调
// `c` 的字段逐项一致（specs: "NormalizedEvent 逐字段对齐 mcode-acp.js"）：
//   {kind:'thought',    text}     思考增量（agent_thought_chunk → r.thinking 累加）
//   {kind:'message',    text}     正文增量（agent_message_chunk → r.answer 累加）
//   {kind:'tool_call',  update}   工具调用开始（tool_call，update 原样透传）
//   {kind:'tool_update', update}  工具完成（tool_call_update，update 原样透传）
//   {kind:'usage',      update}   上下文用量（usage_update，字段为累计值）
//   {kind:'plan_update' | 'plan_removed' | 'mode_update' | 'goal_update'
//        | 'config_option_update' | 'session_info_update' | 'other', update}
//   {kind:'done',       stopReason, usage}  prompt 结束（acp.mjs 的 done 载荷）
//   {kind:'error',      text}     失败事件（mcode-acp.js 的 c.kind === 'error' 分支；
//                                 r.error = {message: c.text || c.error}）
// 任何失败路径（未 boot / RPC 失败 / fatal / 宿主退出 / 空闲超时）都先产出一个
// {kind:'error'} 事件再优雅结束 —— 回退决策在调用方，本模块不抛异常。
//
// ── MessagePort RPC v:1（主线程 ↔ engine-host.worker.js）──────────────────
//   主→Worker: {v:1, id, type:'boot',    payload:{workspace}}
//              {id, type:'prompt',  payload:{sessionId?, content, model, permission}}
//              {id, type:'steer',   payload:{sessionId, text}}
//              {id, type:'cancel',  payload:{sessionId}}
//              {id, type:'shutdown'}
//   Worker→主: {type:'booted',      payload:{engineVersion}}
//              {type:'boot-failed', payload:{error}}
//              {type:'event',       payload: NormalizedEvent}
//              {id, type:'reply', ok, payload | error}
//              {type:'fatal',       payload:{error}}
// 注意：event / booted / boot-failed / fatal 帧不带 id（协议规定），因此同一宿主
// 内只允许一个在途 prompt（单主会话语义，见草案 §6.3 可重入性边界）；并发调用
// 以失败事件快速返回，不排队。

import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  DEFAULT_MODEL,
  DEFAULT_WORKSPACE,
  PROMPT_IDLE_TIMEOUT_MS,
} from "./config.js";
import { createIdleWatchdog } from "./idle-watchdog.js";

// 默认 Worker 入口（与本模块同目录）。测试经 workerPath 注入桩 Worker。
const DEFAULT_WORKER_URL = new URL("./engine-host.worker.js", import.meta.url);

// ── 模块状态（宿主单例 + 单在途 prompt）────────────────────────────────────
let host = null; // { worker, bootState, engineVersion, bootWaiter, exitWaiters }
let activeRun = null; // { id, queue, stopping } —— 在途 prompt
let requestSeq = 0; // RPC 请求 id（自增，协议要求关联 reply）
const pendingReplies = new Map(); // id → resolve({ok, payload, error})

/**
 * 极简异步队列：把 Worker 消息帧转换成生成器可 await 的拉取序列。
 * 无界缓冲（事件量 = 单回合流式增量，内存可控），终态帧保证拉取方必然退出。
 */
function createFrameQueue() {
  const frames = [];
  let waiter = null;
  return {
    push(frame) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(frame);
      } else {
        frames.push(frame);
      }
    },
    next() {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
  };
}

/** workerPath 归一化为 URL 对象（file: 串包成 URL；路径经 pathToFileURL，Windows 盘符安全）。 */
function toWorkerUrl(workerPath) {
  if (!workerPath) return DEFAULT_WORKER_URL;
  const s = String(workerPath);
  // new Worker() 只接受 URL 实例或路径，不接受 file: URL 字符串
  return s.startsWith("file:") ? new URL(s) : pathToFileURL(resolve(s));
}

/** 向 Worker 发一帧（宿主已退出时静默丢弃，调用方经 reply/exit 帧感知失败）。 */
function post(msg) {
  if (!host) return;
  try {
    host.worker.postMessage(msg);
  } catch {
    /* 宿主正在拆除 —— 由 exit 帧统一收尾 */
  }
}

/** 发送带 reply 的 RPC（steer / cancel / shutdown）并等待应答。 */
function sendRpc(type, payload) {
  return new Promise((resolve) => {
    if (!host) {
      resolve({ ok: false, error: "mcode embed engine host is not running" });
      return;
    }
    const id = ++requestSeq;
    pendingReplies.set(id, resolve);
    post({ id, type, payload });
  });
}

/** 宿主拆除统一收尾：清空状态、唤醒所有在途等待者。 */
function settleHostDown(reason) {
  if (!host) return;
  const h = host;
  host = null;
  const msg = reason || "mcode embed engine host exited";
  for (const resolve of pendingReplies.values()) {
    resolve({ ok: false, error: msg });
  }
  pendingReplies.clear();
  if (activeRun) {
    activeRun.queue.push({ type: "down", reason: msg, stopped: !!activeRun.stopping });
  }
  for (const resolve of h.exitWaiters) resolve();
  if (h.bootWaiter) {
    h.bootWaiter({ ok: false, reason: msg });
    h.bootWaiter = null;
  }
}

/** 挂接宿主 Worker 的消息/生命周期路由（每次 boot 一个）。 */
function attachRouter(worker) {
  worker.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "booted": {
        const h = host;
        if (!h) return;
        h.bootState = "booted";
        h.engineVersion =
          msg.payload && typeof msg.payload.engineVersion === "string"
            ? msg.payload.engineVersion
            : null;
        if (h.bootWaiter) {
          h.bootWaiter({ ok: true, engineVersion: h.engineVersion });
          h.bootWaiter = null;
        }
        return;
      }
      case "boot-failed": {
        const h = host;
        if (!h) return;
        h.bootState = "failed";
        const reason =
          (msg.payload && msg.payload.error) || "engine boot-failed (no reason)";
        if (h.bootWaiter) {
          const waiter = h.bootWaiter;
          h.bootWaiter = null;
          // 失败即拆除宿主（主线程据此回退到 ACP 等既有传输）后才落定结果。
          stopEmbed().then(() => waiter({ ok: false, reason }));
        }
        return;
      }
      case "event": {
        // NormalizedEvent 逐字转发给在途 prompt 的事件队列
        if (activeRun) activeRun.queue.push({ type: "event", payload: msg.payload });
        return;
      }
      case "reply": {
        const id = msg.id;
        const resolver = pendingReplies.get(id);
        if (resolver) {
          pendingReplies.delete(id);
          // 干净的二选一形状：{ok:true, payload} | {ok:false, error}
          resolver(
            msg.ok === true
              ? { ok: true, payload: msg.payload }
              : { ok: false, error: msg.error },
          );
        } else if (activeRun && activeRun.id === id) {
          activeRun.queue.push({
            type: "reply",
            ok: msg.ok === true,
            payload: msg.payload,
            error: msg.error,
          });
        }
        return;
      }
      case "fatal": {
        // 未捕获异常：失败事件 + 优雅结束（worker 随后自行退出）
        if (activeRun) {
          activeRun.queue.push({
            type: "fatal",
            error: (msg.payload && msg.payload.error) || "engine host fatal",
          });
        }
        return;
      }
      default:
        return;
    }
  });
  worker.on("error", (e) => settleHostDown(`mcode embed engine host error: ${e.message}`));
  worker.on("exit", () => settleHostDown("mcode embed engine host exited"));
}

/**
 * 启动引擎宿主 Worker（boot RPC）。失败不抛 —— 一律以结果对象返回，回退决策
 * 在调用方。boot-failed 会顺带拆除宿主，isEmbedRunning() 随后为 false。
 *
 * @param {object} [opts]
 * @param {string} [opts.workerPath]  Worker 入口（缺省 server/lib/engine-host.worker.js；
 *                                    测试注入 test/fixtures/engine-host.stub.worker.js）
 * @param {string} [opts.workspace]   boot 载荷的 workspace（缺省 config.DEFAULT_WORKSPACE，
 *                                    与 mcode-acp.js 的 workspace 取值规则一致）
 * @param {object} [opts.workerData]  透传给 new Worker 的 workerData（桩脚本测试缝）
 * @returns {Promise<{ok:true, engineVersion:string|null} | {ok:false, reason:string}>}
 */
export function bootEngineHost({ workerPath, workspace, workerData } = {}) {
  return new Promise((resolve) => {
    if (host) {
      resolve({ ok: false, reason: "mcode embed engine host already running" });
      return;
    }
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let worker;
    try {
      worker = new Worker(toWorkerUrl(workerPath), {
        workerData: workerData === undefined ? null : workerData,
      });
    } catch (e) {
      settle({ ok: false, reason: `spawn engine host worker failed: ${e.message}` });
      return;
    }
    host = {
      worker,
      bootState: "booting",
      engineVersion: null,
      bootWaiter: settle,
      exitWaiters: [],
    };
    attachRouter(worker);
    post({ v: 1, id: ++requestSeq, type: "boot", payload: { workspace: workspace || DEFAULT_WORKSPACE } });
  });
}

/**
 * 查询引擎宿主是否可用（boot 成功且存活）—— 对齐传输契约的 isRunning()。
 * @returns {boolean}
 */
export function isEmbedRunning() {
  return !!host && host.bootState === "booted";
}

/**
 * 停止引擎宿主（shutdown RPC → 等 Worker 自然退出；超时兜底 terminate）。
 * 对齐传输契约的 stopExec()；额外返回 Promise 以便确定性验证「无悬挂句柄」。
 * @returns {Promise<void>} 宿主 Worker 退出后落定
 */
export function stopEmbed() {
  const h = host;
  if (!h) return Promise.resolve();
  if (activeRun) activeRun.stopping = true; // 在途 prompt 将以 'stopped' 收尾
  const exited = new Promise((resolve) => h.exitWaiters.push(resolve));
  sendRpc("shutdown").catch(() => {});
  // 兜底：Worker 2s 内未自然退出则强制终止（草案 §7.7：worker.terminate() 是
  // 干净的强取消边界）。
  const fallback = setTimeout(() => {
    try {
      h.worker.terminate();
    } catch {}
  }, 2000);
  return exited.then(() => clearTimeout(fallback));
}

/**
 * 中途转向（草案 §7.7 的 runtime.steer 通道）。
 * @param {string} sessionId 引擎会话 id
 * @param {string} text      转向文本
 * @returns {Promise<{ok:true, payload:object} | {ok:false, error:string}>}
 */
export function steerEmbed(sessionId, text) {
  return sendRpc("steer", { sessionId, text });
}

/**
 * 语义取消在途回合（优先于 worker.terminate() 的温和取消）。
 * @param {string} sessionId 引擎会话 id
 * @returns {Promise<{ok:true, payload:object} | {ok:false, error:string}>}
 */
export function cancelEmbed(sessionId) {
  return sendRpc("cancel", { sessionId });
}

/**
 * 构造 prompt RPC 载荷（协议 v:1：{sessionId?, content, model, permission}）。
 * 字段取值与 mcode-acp.js / mcode-exec.js 对齐：
 *   model      = opts.model || opts.cs.model.name || DEFAULT_MODEL
 *   permission = mcode-exec.js 的 webui→mcode 映射（'Ask'→'ask' / 'Auto'→'auto' /
 *                'Read'→'read' / 其余→'full'），输入取 opts.permission || opts.cs.permissions
 * @param {string} content
 * @param {object} opts 见 runMcodeEmbed
 * @returns {{sessionId?:string, content:string, model:string, permission:string}}
 */
function buildPromptPayload(content, opts) {
  const model = opts.model || (opts.cs && opts.cs.model && opts.cs.model.name) || DEFAULT_MODEL;
  const webuiMode =
    opts.permission || (opts.cs && opts.cs.permissions) || "Full access";
  const permission =
    webuiMode === "Ask"
      ? "ask"
      : webuiMode === "Auto"
        ? "auto"
        : webuiMode === "Read"
          ? "read"
          : "full";
  const payload = { content: String(content ?? ""), model, permission };
  if (opts.sessionId) payload.sessionId = opts.sessionId;
  return payload;
}

/**
 * 发起一轮 prompt，以 AsyncGenerator 产出 NormalizedEvent 流。
 *
 * 生命周期与 streamAcpPrompt（mcode-acp.js）逐点对齐：
 *   - 逐事件累积 r.thinking / r.answer（thought / message 增量）；
 *   - reply 应答按 `result.answer || r.answer` 语义收尾（`.then` 分支）；
 *   - finalize 恰好一次：durationMs 兜底、空闲看门狗停止、状态词汇一致；
 *   - 生成器提前退出（消费方 break）时以语义 cancel 收束在途回合（对齐
 *     runMcodeAcp 的 finally 清理）。
 *
 * @param {string} content 用户输入正文
 * @param {object} [opts]
 * @param {string} [opts.sessionId]    续接已有引擎会话
 * @param {string} [opts.model]        模型（缺省 opts.cs.model.name || DEFAULT_MODEL）
 * @param {string} [opts.permission]   webui 权限标签（'Ask'|'Auto'|'Read'|'Full access'，
 *                                     或 opts.cs.permissions）→ mcode-exec.js 同款映射
 * @param {object} [opts.cs]           per-cid 状态（只读 model.name / permissions，不改写）
 * @param {number} [opts.idleTimeoutMs] 空闲看门狗窗口（缺省 PROMPT_IDLE_TIMEOUT_MS；
 *                                     事件续命语义与 mcode-acp.js 相同）
 * @returns {AsyncGenerator<NormalizedEvent, object>} 事件流；生成器返回值 = 收尾结果 r
 */
export async function* runMcodeEmbed(content, opts = {}) {
  const t0 = Date.now();
  const r = {
    answer: null,
    thinking: null,
    status: "unknown",
    error: null,
    usage: null,
    sessionId: opts.sessionId || null,
    durationMs: null,
    stopReason: null,
    tps: null,
  };
  // finalize —— 与 streamAcpPrompt 的 finalize() 相同语义：恰好一次。
  let finalized = false;
  let watchdog = null;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (watchdog) watchdog.stop();
    r.durationMs = r.durationMs || Date.now() - t0;
  };

  // ── 失败快路径：产出失败事件后优雅结束（回退决策在调用方）──────────────
  const failFast = (message) => {
    r.status = "failed";
    r.error = { message };
    finalize();
    return r;
  };
  const h = host;
  if (!h || h.bootState !== "booted") {
    const message =
      "mcode embed engine host is not booted (call bootEngineHost first; fallback is the caller's decision)";
    yield { kind: "error", text: message };
    return failFast(message);
  }
  if (activeRun) {
    // event 帧不带 id（协议 v:1），单宿主只允许一个在途 prompt（见文件头注释）。
    const message = "another mcode embed prompt is already active";
    yield { kind: "error", text: message };
    return failFast(message);
  }

  const id = ++requestSeq;
  const queue = createFrameQueue();
  const run = (activeRun = { id, queue, stopping: false });

  // 空闲看门狗 —— 事件续命，只掐「流静默」的回合（与 mcode-acp.js 的
  // createIdleWatchdog 用法一致）。
  let lastEventAt = t0;
  const idleMs =
    Number(opts.idleTimeoutMs) > 0 ? Number(opts.idleTimeoutMs) : PROMPT_IDLE_TIMEOUT_MS;
  watchdog = createIdleWatchdog({
    idleMs,
    activityAt: () => lastEventAt,
    onTimeout: () => queue.push({ type: "timeout" }),
  });

  post({ id, type: "prompt", payload: buildPromptPayload(content, opts) });

  let settled = false;
  try {
    for (;;) {
      const frame = await queue.next();
      if (frame.type === "event") {
        lastEventAt = Date.now();
        const ev = frame.payload;
        // 累积规则与 streamAcpPrompt 的流回调逐行一致
        if (ev && ev.kind === "thought" && typeof ev.text === "string") {
          r.thinking = (r.thinking || "") + ev.text;
        } else if (ev && ev.kind === "message" && typeof ev.text === "string") {
          r.answer = (r.answer || "") + ev.text;
        } else if (ev && ev.kind === "done") {
          if (ev.stopReason) r.stopReason = r.stopReason || ev.stopReason;
          if (ev.usage) r.usage = r.usage || ev.usage;
        } else if (ev && (ev.kind === "error" || ev.error)) {
          r.error = { message: ev.text || ev.error || JSON.stringify(ev) };
          r.status = "failed";
        }
        yield ev; // NormalizedEvent 逐字透传（与 mcode-acp.js 逐字段一致）
        if (r.status === "failed") {
          // mcode-acp.js 收到 error 事件即 finalize —— 此处同语义落定
          settled = true;
          break;
        }
        continue;
      }
      if (frame.type === "reply") {
        if (frame.ok) {
          // streamAcpPrompt 的 .then 分支：result.answer || r.answer 语义
          const p = frame.payload || {};
          r.answer = p.answer || r.answer;
          r.thinking = p.thinking || r.thinking;
          r.stopReason = p.stopReason || r.stopReason || "end_turn";
          if (p.usage) r.usage = p.usage;
          if (p.sessionId) r.sessionId = p.sessionId;
          r.status = "succeeded";
        } else {
          const message = frame.error || "mcode embed prompt failed";
          r.error = { message };
          r.status = "failed";
          yield { kind: "error", text: message };
        }
        settled = true;
        break;
      }
      if (frame.type === "fatal") {
        // 未捕获异常：失败事件 + 优雅结束（不在本模块抛出）
        const message = frame.error || "engine host fatal";
        r.error = { message };
        r.status = "failed";
        yield { kind: "error", text: message };
        settled = true;
        break;
      }
      if (frame.type === "timeout") {
        const seconds = Math.round(idleMs / 1000);
        const message = `mcode embed prompt inactive for ${seconds}s (no stream events)`;
        r.error = { message };
        r.status = "timeout";
        yield { kind: "error", text: message };
        // 语义 cancel 收束引擎侧回合（草案 §7.7：优先于 worker.terminate()）
        cancelEmbed(r.sessionId).catch(() => {});
        settled = true;
        break;
      }
      if (frame.type === "down") {
        const message = frame.stopped
          ? "mcode embed engine host stopped"
          : `mcode embed engine host exited: ${frame.reason}`;
        r.error = { message };
        r.status = frame.stopped ? "stopped" : "failed";
        yield { kind: "error", text: message };
        settled = true;
        break;
      }
    }
  } finally {
    finalize();
    if (activeRun === run) activeRun = null;
    if (!settled) {
      // 消费方提前 break（gen.return()）：以语义 cancel 收束在途回合，
      // 对齐 runMcodeAcp 的 finally 清理。
      cancelEmbed(r.sessionId).catch(() => {});
    }
  }
  return r;
}
