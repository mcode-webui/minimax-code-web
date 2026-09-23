// webui/server/lib/event-bus.js
// cid 分区的有序事件总线（下行汇聚点）。
//
// 职责：接收 state 快照与命名控制事件，按 cid 分配单调递增序列号后
// 同步扇出给订阅者（总线是唯一下行通道：WebSocket /api/stream 适配器
// 订阅本总线；SSE 已按决策 20 移除，见技术方案 §10 决策记录）。
//
// 设计约束：零 npm 依赖；同步分发（订阅者回调在 emit 调用栈内执行，
// 与旧直写路径的时序语义一致）；订阅者异常隔离（单个 sink 抛错不影响
// 其他订阅者与调用方）。

/** cid -> 订阅者集合 */
const _sinksByCid = new Map();
/** cid -> 最新序列号 */
const _seqByCid = new Map();

/**
 * 发布一个事件（按 cid 有序）。
 *
 * @param {string} cid 客户端标识
 * @param {{ type: "state.snapshot", snapshot: object } | { type: "control", name: string, data: string }} event
 */
export function emitEvent(cid, event) {
  const seq = (_seqByCid.get(cid) || 0) + 1;
  _seqByCid.set(cid, seq);
  const item = { seq, ts: Date.now(), event };
  const sinks = _sinksByCid.get(cid);
  if (!sinks || sinks.size === 0) return;
  for (const sink of [...sinks]) {
    try {
      sink(item);
    } catch (e) {
      console.warn(`[event-bus] sink error: ${e.message}`);
    }
  }
}

/**
 * 订阅某 cid 的事件流。
 *
 * @param {string} cid
 * @param {(item: { seq: number, ts: number, event: object }) => void} sink
 * @returns {() => void} 取消订阅（幂等）
 */
export function subscribeEvents(cid, sink) {
  let sinks = _sinksByCid.get(cid);
  if (!sinks) {
    sinks = new Set();
    _sinksByCid.set(cid, sinks);
  }
  sinks.add(sink);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = _sinksByCid.get(cid);
    if (!current) return;
    current.delete(sink);
    if (current.size === 0) _sinksByCid.delete(cid);
  };
}

/** 读取某 cid 的最新序列号（无事件时为 null）。 */
export function getLatestSeq(cid) {
  const seq = _seqByCid.get(cid);
  return seq === undefined ? null : seq;
}

/** 返回当前存在订阅者的 cid 列表（即在线事件流客户端集合）。 */
export function getSubscribedCids() {
  return [..._sinksByCid.keys()];
}

/** 测试钩子：清空全部订阅与序列号。 */
export function resetEventBusForTests() {
  _sinksByCid.clear();
  _seqByCid.clear();
}