// webui/test/lib-ws-server.test.js
// GET /api/stream WebSocket 事件流端点：握手 / 事件推送 / 恢复重放 / 快照回退 /
// 心跳 / 入站配额 / 二进制拒绝 / 开关拒绝。真实回环 TCP + 自研帧解析。
// 每用例独立 server + 套接字（withStream），杜绝共享状态；connect 超时也
// 落定（把挂死变成可断言的诊断现场）。

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

let handleStreamUpgrade, emitEvent, resetEventBusForTests, encodeFrame;

const CLIENT_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const CLIENT_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

before(async () => {
  ({ handleStreamUpgrade } = await import("../server/lib/ws-server.js"));
  ({ emitEvent, resetEventBusForTests } = await import("../server/lib/event-bus.js"));
  ({ encodeFrame } = await import("../server/lib/ws-frame.js"));
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitUntil(pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(10);
  }
  assert.fail("等待条件超时");
}

function parseServerFrames(st) {
  while (st.buf.length >= 2) {
    const opcode = st.buf[0] & 0x0f;
    let len = st.buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (st.buf.length < 4) return;
      len = st.buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (st.buf.length < 10) return;
      len = Number(st.buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (st.buf.length < offset + len) return;
    st.frames.push({ opcode, payload: Buffer.from(st.buf.subarray(offset, offset + len)) });
    st.buf = st.buf.subarray(offset + len);
  }
}

function connect(port, path) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const st = { buf: Buffer.alloc(0), frames: [], header: "", handshook: false, socket, timedOut: false };
    // 超时也落定：挂死转为可断言的诊断现场
    const guard = setTimeout(() => { st.timedOut = true; resolve(st); }, 2500);
    socket.on("data", (chunk) => {
      if (!st.handshook) {
        st.header += chunk.toString("latin1");
        const idx = st.header.indexOf("\r\n\r\n");
        if (idx === -1) return;
        st.rawBody = st.header.slice(idx + 4);
        st.buf = Buffer.from(st.rawBody, "latin1");
        st.header = st.header.slice(0, idx);
        st.handshook = true;
        parseServerFrames(st);
        clearTimeout(guard);
        resolve(st);
        return;
      }
      st.buf = Buffer.concat([st.buf, chunk]);
      parseServerFrames(st);
    });
    socket.on("connect", () => {
      socket.write(
        "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " +
          CLIENT_KEY + "\r\nSec-WebSocket-Version: 13\r\nx-cid: " + path.split("cid=")[1] + "\r\n\r\n",
      );
    });
    socket.on("error", () => { clearTimeout(guard); resolve(st); });
  });
}

// RFC 6455 §5.3：客户端帧必须掩码（解码器对未掩码帧以 1002 拒绝，服务端行为正确）
function encodeClientFrame(opcode, payload) {
  const body = Buffer.from(payload || "", "utf8");
  const key = Buffer.from([1, 2, 3, 4]);
  const head = Buffer.alloc(2 + 4);
  head[0] = 0x80 | opcode;
  head[1] = 0x80 | body.length;
  key.copy(head, 2);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4];
  return Buffer.concat([head, masked]);
}

function jsonFrames(st) {
  const out = [];
  for (const f of st.frames) {
    if (f.opcode !== 0x1) continue;
    try { out.push(JSON.parse(f.payload.toString("utf8"))); } catch {}
  }
  return out;
}
function closeCode(st) {
  const f = st.frames.find((f) => f.opcode === 0x8);
  return f && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : f ? 0 : null;
}

let seq = 0;
const freshCid = () => "ws-t" + (++seq);

async function withStream(opts, fn) {
  resetEventBusForTests();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => handleStreamUpgrade(req, socket, head, opts));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const st = await connect(server.address().port, opts.path || ("api/stream?cid=".replace("api", "/api") + (opts.cid || freshCid())));
  try {
    await fn(st);
  } finally {
    // 清理限时（500ms 竞速）：升级套接字脱离 http 连接跟踪后 close 回调
    // 在个别路径不落定——测试基建采用尽力而为语义，杜绝清理挂死。
    st.socket.destroy();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await Promise.race([new Promise((r) => server.close(r)), sleep(500)]);
  }
}

describe("GET /api/stream WebSocket 事件流", { concurrency: 1 }, () => {
  it("握手返回 101 + 正确 Accept，随后收到 hello 帧", async () => {
    await withStream({ enabled: true, heartbeatMs: 60000 }, async (st) => {
      assert.equal(st.timedOut, false, "连接超时: header=" + st.header);
      assert.ok(st.header.startsWith("HTTP/1.1 101"), "header=" + st.header);
      assert.ok(st.header.includes("Sec-WebSocket-Accept: " + CLIENT_ACCEPT));
      await waitUntil(() => jsonFrames(st).length >= 1);
      const hello = jsonFrames(st)[0];
      assert.equal(hello.type, "hello");
      assert.equal(hello.payload.resumeSupported, true);
    });
  });

  it("事件推送 seq 连续；resume 按序重放未收到的部分", async () => {
    await withStream({ enabled: true, heartbeatMs: 60000 }, async (st) => {
      await waitUntil(() => jsonFrames(st).some((f) => f.type === "hello"), 3000);
      const feedCid = jsonFrames(st).find((f) => f.type === "hello").payload.cid;
      emitEvent(feedCid, { type: "control", name: "a" });
      emitEvent(feedCid, { type: "control", name: "b" });
      emitEvent(feedCid, { type: "control", name: "c" });
      await waitUntil(() => jsonFrames(st).filter((f) => f.seq).length === 3, 3000);
      assert.deepEqual(jsonFrames(st).filter((f) => f.seq).map((f) => f.seq), [1, 2, 3]);
      st.frames.length = 0;
      st.socket.write(encodeClientFrame(0x1, JSON.stringify({ v: 1, type: "resume", payload: { lastSeq: 1 } })));
      await waitUntil(() => jsonFrames(st).filter((f) => f.seq).length === 2, 3000);
      const replay = jsonFrames(st).filter((f) => f.seq).map((f) => ({ seq: f.seq, name: f.payload.name }));
      assert.deepEqual(replay, [{ seq: 2, name: "b" }, { seq: 3, name: "c" }]);
    });
  });

  it("环形缓冲欠载 → 以最近快照为基线回退", async () => {
    await withStream({ enabled: true, heartbeatMs: 60000, ringCapacity: 2 }, async (st) => {
      await waitUntil(() => jsonFrames(st).some((f) => f.type === "hello"), 3000);
      const feedCid = jsonFrames(st).find((f) => f.type === "hello").payload.cid;
      emitEvent(feedCid, { type: "state.snapshot", snapshot: { a: 1 } });
      for (let i = 0; i < 4; i++) emitEvent(feedCid, { type: "control", name: "n" + i });
      await waitUntil(() => jsonFrames(st).filter((f) => f.seq).length === 5, 3000);
      st.frames.length = 0;
      st.socket.write(encodeClientFrame(0x1, JSON.stringify({ v: 1, type: "resume", payload: { lastSeq: 0 } })));
      await waitUntil(() => jsonFrames(st).some((f) => f.type === "state.snapshot"), 3000);
      const snap = jsonFrames(st).find((f) => f.type === "state.snapshot");
      assert.equal(snap.payload.a, 1);
    });
  });

  it("心跳发送 WS ping 控制帧", async () => {
    await withStream({ enabled: true, heartbeatMs: 30 }, async (st) => {
      await waitUntil(() => st.frames.some((f) => f.opcode === 0x9), 1500);
    });
  });

  it("入站配额超限 → error 帧 + 1013 关闭", async () => {
    await withStream({ enabled: true, heartbeatMs: 60000, inboundBurst: 3, inboundPerSec: 1 }, async (st) => {
      await waitUntil(() => jsonFrames(st).some((f) => f.type === "hello"), 3000);
      for (let i = 0; i < 6; i++) {
        st.socket.write(encodeClientFrame(0x1, JSON.stringify({ v: 1, type: "ping" })));
      }
      await waitUntil(() => closeCode(st) !== null, 3000);
      assert.ok(jsonFrames(st).some((f) => f.type === "error" && f.payload.code === "quota"), "frames=" + JSON.stringify(jsonFrames(st)));
      assert.equal(closeCode(st), 1013);
    });
  });

  it("二进制帧 → 1002 关闭", async () => {
    await withStream({ enabled: true, heartbeatMs: 60000 }, async (st) => {
      st.socket.write(encodeClientFrame(0x2, "\u0001\u0002\u0003"));
      await waitUntil(() => closeCode(st) !== null, 3000);
      assert.equal(closeCode(st), 1002);
    });
  });

  it("开关关闭（默认 sse）→ 拒绝升级 404", async () => {
    await withStream({ enabled: false }, async (st) => {
      assert.ok(st.header.includes("404"), "header=" + st.header);
      assert.ok((st.rawBody || "").includes("websocket stream disabled") || st.buf.toString("latin1").includes("websocket stream disabled"));
    });
  });
});