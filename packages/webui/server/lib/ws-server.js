// webui/server/lib/ws-server.js
// GET /api/stream 的 WebSocket 事件流端点（技术方案 §7.2：事件流 + REST）。
//
// 职责：HTTP 升级握手 → 事件总线订阅 → 帧序列推送（seq 连续）+ 断线恢复
// （环形缓冲重放 / 快照基线回退）+ 心跳 + 入站配额。帧编解码复用 ws-frame.js
// （RFC 6455 服务端子集），事件源复用 event-bus.js，与 SSE 适配器（sse-adapter.js）
// 平行消费同一总线 —— 线上行为（REST 形状 / SSE 帧字节）不受影响。
//
// 协议帧（服务端 → 客户端，WS text，JSON）：
//   {v:1, type:"hello",   payload:{resumeSupported, latestSeq, heartbeatMs, ringCapacity}}
//   {v:1, seq, ts, type:"state.snapshot", payload:<快照>}        // 状态快照
//   {v:1, seq, ts, type:"control", payload:{name, data}}          // 命名控制事件
//   {v:1, type:"error",   payload:{code, message}}
// 客户端 → 服务端（WS text，JSON；二进制帧一律 1002 拒绝）：
//   {v:1, type:"resume", payload:{lastSeq}}   // 断线恢复：重放 seq > lastSeq
//   {v:1, type:"ping"} / {v:1, type:"pong"} / {v:1, type:"close"}
//
// 兼容性（决策记录 17）：升级门链与 /api/events 同款（origin / LAN / token）；
// 默认 MCODE_WEBUI_TRANSPORT=sse 时本端点拒绝升级（旧行为不变的最强形式）；
// 发行版 SPA 不使用本端点。

import {
  computeAcceptKey,
  encodeFrame,
  createFrameDecoder,
  OPCODE,
  CLOSE_CODE,
} from "./ws-frame.js";
import { createRingBuffer } from "./ring-buffer.js";
import { subscribeEvents, getLatestSeq } from "./event-bus.js";
import { getCidFromReq } from "./state-bus.js";
import {
  isLocalRequest,
  buildTrustedOrigins,
  normalizeOriginHeader,
} from "./lan.js";
import { getServingPort, MCODE_WEBUI_TRANSPORT } from "./config.js";
import { getLanBroadcast, getTrustedOrigins } from "./settings.js";
import { isRequestAuthorized } from "./auth.js";

const DEFAULT_HEARTBEAT_MS = 30_000;
const MAX_MISSED_PONGS = 2;
const INBOUND_RATE_PER_SEC = 20;
const INBOUND_BURST = 40;
const RING_CAPACITY = 4096;

// cid → 馈送（重放缓冲 + 最近快照 + 连接集合 + 订阅句柄）。
// 生命周期按连接引用计数：最后一个连接断开即退订并丢弃，避免僵尸订阅。
const feeds = new Map();

/** 关闭帧体：2 字节大端 code + UTF-8 reason（RFC 6455 §5.5）。 */
function closeBody(code, reason) {
  const reasonBuf = Buffer.from(String(reason || ""), "utf8");
  const body = Buffer.alloc(2 + reasonBuf.length);
  body.writeUInt16BE(code, 0);
  reasonBuf.copy(body, 2);
  return body;
}

/** 总线条目 → 线上帧对象（兼容环形缓冲 replay 的 {seq, item} 包装形状）。 */
function frameForItem(raw) {
  const item = raw && raw.item ? raw.item : raw;
  const ev = item.event || {};
  const payload =
    ev.type === "control"
      ? { name: ev.name, data: ev.data }
      : ev.snapshot;
  return { v: 1, seq: item.seq, ts: item.ts, type: ev.type, payload };
}

function acquireFeed(cid, ringCapacity) {
  let feed = feeds.get(cid);
  if (feed) return feed;
  feed = {
    ring: createRingBuffer(ringCapacity || RING_CAPACITY),
    lastSnapshot: null,
    conns: new Set(),
    unsubscribe: null,
  };
  feed.unsubscribe = subscribeEvents(cid, (item) => {
    feed.ring.push(item.seq, item);
    if (item.event && item.event.type === "state.snapshot") {
      feed.lastSnapshot = item;
    }
    const frame = frameForItem(item);
    for (const conn of feed.conns) conn.send(frame);
  });
  feeds.set(cid, feed);
  return feed;
}

function releaseFeed(cid, feed) {
  if (feed.conns.size > 0) return;
  if (typeof feed.unsubscribe === "function") feed.unsubscribe();
  feeds.delete(cid);
}

/**
 * 处理 GET /api/stream 的 WebSocket 升级。
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:net").Socket} socket
 * @param {Buffer} head
 * @param {object} [opts] 测试缝：enabled / heartbeatMs / ringCapacity /
 *   inboundPerSec / inboundBurst / maxFrameBytes
 */
export function handleStreamUpgrade(req, socket, head, opts = {}) {
  const enabled =
    opts.enabled !== undefined ? !!opts.enabled : MCODE_WEBUI_TRANSPORT === "ws";
  const pathname = (req.url || "/").split("?")[0];
  const reject = (status, message) => {
    try {
      socket.write(
        "HTTP/1.1 " + status + " X\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n" +
          JSON.stringify({ ok: false, error: message }),
      );
    } catch {}
    try { socket.destroy(); } catch {}
  };

  if (pathname !== "/api/stream") return reject(404, "not found");
  if (!enabled) {
    return reject(404, "websocket stream disabled (set MCODE_WEBUI_TRANSPORT=ws)");
  }

  // 门链（与 /api/events 同款）：origin / LAN / token。
  //   升级等同于带副作用的请求：有 Origin 必须在信任集内（CSRF 边界）。
  const originHeader = normalizeOriginHeader(req.headers.origin);
  const trustedOrigins = buildTrustedOrigins({
    port: getServingPort(),
    lanBroadcast: getLanBroadcast(),
    extra: getTrustedOrigins(),
  });
  if (originHeader !== "" && !trustedOrigins.has(originHeader)) {
    return reject(403, "cross-origin request rejected");
  }
  const local = isLocalRequest(req);
  if (!local && !getLanBroadcast()) return reject(403, "LAN access disabled");
  if (!local && !isRequestAuthorized(req)) return reject(401, "token required");

  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.length === 0) {
    return reject(400, "missing Sec-WebSocket-Key");
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      computeAcceptKey(key) + "\r\n\r\n",
  );
  socket.setNoDelay(true);

  const cid = getCidFromReq(req);
  const heartbeatMs =
    Number(opts.heartbeatMs) > 0 ? Number(opts.heartbeatMs) : DEFAULT_HEARTBEAT_MS;
  const maxFrameBytes =
    Number(opts.maxFrameBytes) > 0 ? Number(opts.maxFrameBytes) : 1024 * 1024;
  const burst = Number(opts.inboundBurst) > 0 ? Number(opts.inboundBurst) : INBOUND_BURST;
  const refillPerMs =
    (Number(opts.inboundPerSec) > 0 ? Number(opts.inboundPerSec) : INBOUND_RATE_PER_SEC) / 1000;

  const writeFrame = (opcode, payload) => {
    try { socket.write(encodeFrame({ opcode, payload })); } catch {}
  };
  const writeJson = (obj) => writeFrame(OPCODE.TEXT, JSON.stringify(obj));
  let closed = false;
  const closeWith = (code, reason) => {
    if (closed) return;
    closed = true;
    writeFrame(OPCODE.CLOSE, closeBody(code, reason));
    try { socket.end(); } catch {}
  };

  const decoder = createFrameDecoder({ maxFrameBytes });
  let missedPongs = 0;
  // 入站配额：令牌桶（突发 burst，稳态 inboundPerSec 帧/秒，决策记录 17）
  let tokens = burst;
  let lastRefill = Date.now();

  const feed = acquireFeed(cid, opts.ringCapacity);
  const conn = { send: (frame) => writeJson(frame) };
  feed.conns.add(conn);
  // 清理只解订阅，不主动 destroy —— destroy 会冲掉未刷写的收尾帧
  // （error / close），让 socket.end() 自然收尾、close 事件触发清理。
  const release = () => {
    if (feed.conns.delete(conn)) releaseFeed(cid, feed);
    clearInterval(heartbeat);
  };
  socket.on("close", release);
  socket.on("error", release);

  writeJson({
    v: 1,
    type: "hello",
    payload: {
      resumeSupported: true,
      latestSeq: getLatestSeq(cid),
      heartbeatMs,
      ringCapacity: feed.ring.capacity,
      cid,
    },
  });

  const heartbeat = setInterval(() => {
    if (missedPongs >= MAX_MISSED_PONGS) {
      closeWith(CLOSE_CODE.GOING_AWAY, "heartbeat timeout");
      return;
    }
    missedPongs += 1;
    writeFrame(OPCODE.PING);
  }, heartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  socket.on("close", () => clearInterval(heartbeat));

  function handleClientJson(text) {
    let msg;
    try { msg = JSON.parse(text); } catch {
      writeJson({ v: 1, type: "error", payload: { code: "bad-frame", message: "client text frames must be JSON" } });
      return;
    }
    const t = msg && msg.type;
    if (t === "resume") {
      const lastSeq = Number(msg.payload && msg.payload.lastSeq) || 0;
      const replay = feed.ring.replay(lastSeq + 1);
      if (replay.complete) {
        for (const it of replay.items) writeJson(frameForItem(it));
      } else if (feed.lastSnapshot) {
        // 欠载（环形缓冲已覆盖不到）：以最近快照为基线（决策记录 17 近似语义）
        writeJson(frameForItem(feed.lastSnapshot));
      } else {
        writeJson({ v: 1, type: "error", payload: { code: "resume-underrun", message: "no buffered events and no snapshot baseline yet" } });
      }
      return;
    }
    if (t === "ping") { writeJson({ v: 1, type: "pong" }); return; }
    if (t === "pong") { missedPongs = 0; return; }
    if (t === "close") { closeWith(CLOSE_CODE.NORMAL); release(); return; }
    writeJson({ v: 1, type: "error", payload: { code: "unknown-type", message: "unsupported client frame type: " + String(t) } });
  }

  socket.on("data", (chunk) => {
    if (closed) return;
    const events = decoder.push(chunk) || [];
    for (const ev of events) {
      // 入站配额按帧计数（TCP 粘包下块计数无意义），令牌桶：突发 burst、稳态 refillPerMs
      const now = Date.now();
      tokens = Math.min(burst, tokens + (now - lastRefill) * refillPerMs);
      lastRefill = now;
      tokens -= 1;
      if (tokens < 0) {
        writeJson({ v: 1, type: "error", payload: { code: "quota", message: "inbound frame quota exceeded" } });
        closeWith(CLOSE_CODE.TRY_AGAIN_LATER, "inbound frame quota exceeded");
        return;
      }
      if (ev.kind === "protocol-error") {
        closeWith(ev.code || CLOSE_CODE.PROTOCOL_ERROR, ev.message || "protocol error");
        return;
      }
      if (ev.kind === "binary") {
        closeWith(CLOSE_CODE.PROTOCOL_ERROR, "binary frames not accepted");
        return;
      }
      if (ev.kind === "ping") { missedPongs = 0; writeFrame(OPCODE.PONG, ev.payload); continue; }
      if (ev.kind === "pong") { missedPongs = 0; continue; }
      if (ev.kind === "close") { closeWith(CLOSE_CODE.NORMAL); return; }
      if (ev.kind === "text") handleClientJson(ev.text);
    }
  });
}
