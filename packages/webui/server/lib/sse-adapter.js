// webui/server/lib/sse-adapter.js
// SSE 线上机制（字节级写入、节流合并、字节 diff 门、命名控制帧格式）。
//
// 职责：state-bus.js 原样迁出的传输层细节。state-bus 负责状态构造与
// 事件发布；本模块只负责「以什么字节落线」。行为逐字节兼容旧实现
// （含 STATE_PUSH_THROTTLE_MS 默认值、背压守卫、fresh-res 检测）。

/** SSE 响应头（逐字段与旧实现一致）。 */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

// 节流窗口（导入期快照，供内省）：0 = 禁用。
// 行为判定以调用期读 env 为准（currentThrottleMs）——保持既有测试契约：
// 「重导入状态模块即可读到新 env」（cache-bust 契约，见 checks/lib-state-bus.check.mjs）。
export const STATE_PUSH_THROTTLE_MS = Math.max(
    0,
    Number(process.env.STATE_PUSH_THROTTLE_MS) || 0,
);

function currentThrottleMs() {
    const v = Number(process.env.STATE_PUSH_THROTTLE_MS);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

// cid -> { payloadStr, res, timer? } 待写快照（窗口内 last-call-wins）
const _pendingByCid = new Map();
// cid -> setTimeout 句柄
const _flushTimers = new Map();
// cid -> 最后一次成功写出的时间戳
const _lastWriteTsByCid = new Map();
// cid -> 最后一次成功写出的 payload（字节 diff 门）
const _lastPushedByCid = new Map();
// cid -> 最后一次成功写出的 res（fresh-res 检测）
const _lastPushedResByCid = new Map();

function _writeNow(cid, payloadStr, res) {
    // 背压/死套接字守卫：被丢弃的一帧会被下一帧取代，积压时丢弃是安全的；
    // 跳过时不写 diff 缓存，套接字排空后重推仍会真正落线。
    if (!res || res.writableEnded || res.destroyed) return;
    if (res.writableNeedDrain) return;
    _lastWriteTsByCid.set(cid, Date.now());
    _lastPushedByCid.set(cid, payloadStr);
    _lastPushedResByCid.set(cid, res);
    try {
        res.write(`data: ${payloadStr}\n\n`);
    } catch {}
}

/**
 * 快照推送调度：fresh-res 无条件直写 → 字节 diff 门 → 节流合并
 * （窗口外直写，窗口内 last-call-wins 定时冲刷）。
 */
export function scheduleStatePush(cid, payloadStr, res) {
    if (!res) return;
    // fresh-res 检测：res 换代（重连/测试重置）时旧 diff 缓存与定时器全部失效
    const cachedRes = _lastPushedResByCid.get(cid);
    if (cachedRes !== res) {
        clearCidCoalesce(cid);
        _writeNow(cid, payloadStr, res);
        return;
    }
    if (_lastPushedByCid.get(cid) === payloadStr) return;
    const throttleMs = currentThrottleMs();
    if (throttleMs <= 0) {
        _writeNow(cid, payloadStr, res);
        return;
    }
    const now = Date.now();
    const lastTs = _lastWriteTsByCid.get(cid) || 0;
    const elapsed = now - lastTs;
    if (elapsed >= throttleMs) {
        _writeNow(cid, payloadStr, res);
        return;
    }
    _pendingByCid.set(cid, { payloadStr, res });
    if (!_flushTimers.has(cid)) {
        const delay = throttleMs - elapsed;
        const timer = setTimeout(() => _flushPending(cid), delay);
        if (typeof timer.unref === "function") timer.unref();
        _flushTimers.set(cid, timer);
    }
}

function _flushPending(cid) {
    _flushTimers.delete(cid);
    const pending = _pendingByCid.get(cid);
    if (!pending) return;
    _pendingByCid.delete(cid);
    if (_lastPushedByCid.get(cid) === pending.payloadStr) return;
    if (_lastPushedResByCid.get(cid) !== pending.res) return;
    _writeNow(cid, pending.payloadStr, pending.res);
}

/**
 * 清理单个 cid 的合并状态（定时器/待写/时间戳/diff 缓存）。
 *
 * @param {string} cid
 * @param {{ dropResRef?: boolean }} [opts] dropResRef=true 时连 res 引用一并释放
 */
export function clearCidCoalesce(cid, { dropResRef = false } = {}) {
    const timer = _flushTimers.get(cid);
    if (timer) {
        try { clearTimeout(timer); } catch {}
        _flushTimers.delete(cid);
    }
    _pendingByCid.delete(cid);
    _lastWriteTsByCid.delete(cid);
    _lastPushedByCid.delete(cid);
    if (dropResRef) _lastPushedResByCid.delete(cid);
}

/**
 * 构造命名控制事件帧（旧帧格式逐字节一致：event 行 + data 行 + 空行）。
 * data 编码由调用方决定（token 轮转为原文，其余为 JSON 字符串）。
 */
export function formatControlFrame(name, data) {
    return `event: ${name}\ndata: ${data}\n\n`;
}

/** 写出一帧（吞写异常，与旧实现一致）。 */
export function writeControlFrame(res, frame) {
    try {
        res.write(frame);
    } catch {}
}

// ---------------- 测试钩子（形状与旧实现一致） ----------------
export function resetCoalesceState() {
    for (const [, timer] of _flushTimers) {
        try { clearTimeout(timer); } catch {}
    }
    _flushTimers.clear();
    _pendingByCid.clear();
    _lastWriteTsByCid.clear();
    _lastPushedByCid.clear();
    _lastPushedResByCid.clear();
}

export function flushPendingPushes() {
    const cids = Array.from(_pendingByCid.keys());
    for (const cid of cids) _flushPending(cid);
    return cids.length;
}

export function peekLastPushed(cid) {
    return _lastPushedByCid.get(cid);
}

export function peekLastWriteTs(cid) {
    return _lastWriteTsByCid.get(cid);
}

export function peekLastPushedRes(cid) {
    return _lastPushedResByCid.get(cid);
}