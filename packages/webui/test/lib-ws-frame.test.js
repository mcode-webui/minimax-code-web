// webui/test/lib-ws-frame.test.js
// RFC 6455 WebSocket 帧库一致性单元测试。
// 覆盖规格：§1.3 握手标例、编解码往返、125/126/127 长度边界、4 字节键循环
// 异或掩码解码、未掩码 / 超长控制帧 / RSV / 分片结构类违规、TEXT+CONT 重组、
// 分片间控制帧穿插、close 解析、UTF-8 跨分片校验、超限 1009、终态语义。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;
const {
  WS_GUID,
  OPCODE,
  CLOSE_CODE,
  computeAcceptKey,
  encodeFrame,
  createFrameDecoder,
} = await import(absPath("lib/ws-frame.js"));

// -----------------------------------------------------------------------
// 测试辅助：构造客户端 → 服务端帧（掩码）。
// 服务端解码器只接受掩码帧，违规用例需要手工拼头字节。
// -----------------------------------------------------------------------

// RFC 6455 §5.7 标例用的掩码键
const KEY = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

function maskPayload(payload, key) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3];
  return out;
}

/**
 * 构造一个客户端帧。
 *
 * @param {object} opts
 * @param {number} opts.opcode 操作码
 * @param {string | Buffer} [opts.payload] 负载
 * @param {boolean} [opts.fin] FIN 位，默认 true
 * @param {number} [opts.rsv] RSV 位（0x10/0x20/0x40），默认 0
 * @param {boolean} [opts.masked] 是否掩码，默认 true
 * @param {Buffer} [opts.key] 4 字节掩码键
 * @param {number | null} [opts.len7Override] 强制第二个头字节的低 7 位（构造非最小编码）
 * @param {Buffer} [opts.extLenBytes] 强制扩展长度字段的原始字节
 */
function clientFrame({
  opcode,
  payload = Buffer.alloc(0),
  fin = true,
  rsv = 0,
  masked = true,
  key = KEY,
  len7Override = null,
  extLenBytes = null,
} = {}) {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = body.length;
  const b0 = (fin ? 0x80 : 0) | (rsv & 0x70) | (opcode & 0x0f);

  let len7;
  let ext = Buffer.alloc(0);
  if (len7Override !== null) {
    len7 = len7Override;
    if (len7 === 126) {
      ext = extLenBytes ?? (() => { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(len); return b; })();
    } else if (len7 === 127) {
      ext = extLenBytes ?? (() => { const b = Buffer.allocUnsafe(8); b.writeBigUInt64BE(BigInt(len)); return b; })();
    }
  } else if (len < 126) {
    len7 = len;
  } else if (len <= 0xffff) {
    len7 = 126;
    ext = Buffer.allocUnsafe(2);
    ext.writeUInt16BE(len);
  } else {
    len7 = 127;
    ext = Buffer.allocUnsafe(8);
    ext.writeBigUInt64BE(BigInt(len));
  }

  const b1 = (masked ? 0x80 : 0) | len7;
  const parts = [Buffer.from([b0, b1]), ext];
  if (masked) {
    parts.push(key, maskPayload(body, key));
  } else {
    parts.push(body);
  }
  return Buffer.concat(parts);
}

/**
 * 把服务端帧（不掩码）转换成客户端帧（掩码），
 * 以便对 encodeFrame → createFrameDecoder 做编解码往返。
 */
function maskServerFrame(frame, key = KEY) {
  const len7 = frame[1] & 0x7f;
  let ext = 0;
  let len = 0;
  if (len7 < 126) {
    len = len7;
  } else if (len7 === 126) {
    ext = 2;
    len = frame.readUInt16BE(2);
  } else {
    ext = 8;
    len = Number(frame.readBigUInt64BE(2));
  }
  const headerLen = 2 + ext;
  const body = frame.subarray(headerLen);
  const out = Buffer.alloc(headerLen + 4 + len);
  frame.copy(out, 0, 0, headerLen);
  out[1] = 0x80 | len7;
  key.copy(out, headerLen);
  for (let i = 0; i < len; i++) out[headerLen + 4 + i] = body[i] ^ key[i & 3];
  return out;
}

/** 构造 close 帧负载：2 字节大端 code + UTF-8 reason。 */
function closeBody(code, reason = "") {
  const head = Buffer.allocUnsafe(2);
  head.writeUInt16BE(code);
  return Buffer.concat([head, Buffer.from(reason, "utf8")]);
}

// -----------------------------------------------------------------------

describe("ws-frame / computeAcceptKey", () => {
  test("RFC 6455 §1.3 握手标例", () => {
    // 规范原文：client key 'dGhlIHNhbXBsZSBub25jZQ==' 必须得到
    // 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
    assert.equal(
      computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  test("WS_GUID 为规范定值", () => {
    assert.equal(WS_GUID, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  });

  test("非字符串入参抛 TypeError", () => {
    assert.throws(() => computeAcceptKey(123), TypeError);
    assert.throws(() => computeAcceptKey(undefined), TypeError);
  });
});

describe("ws-frame / encodeFrame", () => {
  test("服务端帧恒为 FIN=1、不掩码（RFC §5.7 单帧标例）", () => {
    const frame = encodeFrame({ opcode: OPCODE.TEXT, payload: "Hello" });
    assert.deepEqual([...frame], [0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  test("编解码往返：encodeFrame → 转客户端帧 → 解码还原", () => {
    const decoder = createFrameDecoder();
    const text = "你好, WebSocket ✓";
    const events = decoder.push(
      maskServerFrame(encodeFrame({ opcode: OPCODE.TEXT, payload: text })),
    );
    assert.deepEqual(events, [{ kind: "text", text }]);

    const bin = Buffer.from([0, 1, 2, 250, 255]);
    const events2 = decoder.push(
      maskServerFrame(encodeFrame({ opcode: OPCODE.BINARY, payload: bin })),
    );
    assert.equal(events2.length, 1);
    assert.equal(events2[0].kind, "binary");
    assert.deepEqual(events2[0].data, bin);
  });

  test("长度边界 125 / 126：7 bit 与 126+2B 的切换点", () => {
    const f125 = encodeFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(125) });
    assert.equal(f125[1], 125);
    assert.equal(f125.length, 2 + 125);

    const f126 = encodeFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(126) });
    assert.equal(f126[1], 126);
    assert.equal(f126.readUInt16BE(2), 126);
    assert.equal(f126.length, 4 + 126);
  });

  test("长度边界 65535 / 65536：126+2B 与 127+8B 的切换点", () => {
    const f65535 = encodeFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(65535) });
    assert.equal(f65535[1], 126);
    assert.equal(f65535.readUInt16BE(2), 65535);
    assert.equal(f65535.length, 4 + 65535);

    const f65536 = encodeFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(65536) });
    assert.equal(f65536[1], 127);
    assert.equal(f65536.readBigUInt64BE(2), 65536n);
    // 8 字节大端最高位必须为 0（§5.2）
    assert.equal(f65536[2] & 0x80, 0);
    assert.equal(f65536.length, 10 + 65536);

    // 三档边界帧都能被解码器还原
    const decoder = createFrameDecoder({ maxFrameBytes: 70000 });
    for (const n of [125, 126, 65535, 65536]) {
      const events = decoder.push(
        maskServerFrame(encodeFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(n, 7) })),
      );
      assert.equal(events[0].kind, "binary");
      assert.equal(events[0].data.length, n);
    }
  });

  test("非法 opcode 或负载类型抛 TypeError", () => {
    assert.throws(() => encodeFrame({ opcode: 0x3, payload: "" }), TypeError);
    assert.throws(() => encodeFrame({ opcode: OPCODE.TEXT, payload: 42 }), TypeError);
    assert.throws(() => encodeFrame({}), TypeError);
  });
});

describe("ws-frame / createFrameDecoder 解码", () => {
  test("掩码解码：RFC §5.7 掩码单帧标例（4 字节键循环异或）", () => {
    // 81 85 37 fa 21 3d 7f 9f 4d 51 58 = 掩码后的 TEXT \"Hello\"（键 37 fa 21 3d）
    const frame = Buffer.from([
      0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58,
    ]);
    const decoder = createFrameDecoder();
    assert.deepEqual(decoder.push(frame), [{ kind: "text", text: "Hello" }]);
  });

  test("掩码解码：负载超过 4 字节时掩码键按 i&3 循环", () => {
    // 自校验：把已知明文按 4 字节键循环异或打码后喂给解码器
    const plain = Buffer.from("0123456789abcdef", "utf8");
    const decoder = createFrameDecoder();
    const events = decoder.push(
      clientFrame({ opcode: OPCODE.BINARY, payload: plain, key: Buffer.from([1, 2, 3, 4]) }),
    );
    assert.deepEqual(events[0].data, plain);
  });

  test("未掩码帧 → protocol-error 1002", () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(
      clientFrame({ opcode: OPCODE.TEXT, payload: "hi", masked: false }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "protocol-error");
    assert.equal(events[0].code, CLOSE_CODE.PROTOCOL_ERROR);
    assert.equal(decoder.errored, true);
  });

  test("RSV 非 0 → protocol-error 1002（未协商扩展）", () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(clientFrame({ opcode: OPCODE.TEXT, payload: "x", rsv: 0x10 }));
    assert.equal(events[0].kind, "protocol-error");
    assert.equal(events[0].code, CLOSE_CODE.PROTOCOL_ERROR);
  });

  test("FIN=0 控制帧 → protocol-error 1002", () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(
      clientFrame({ opcode: OPCODE.PING, payload: "x", fin: false }),
    );
    assert.equal(events[0].kind, "protocol-error");
    assert.equal(events[0].code, CLOSE_CODE.PROTOCOL_ERROR);
  });

  test("控制帧 >125 字节 → protocol-error 1002", () => {
    // 声明 126 字节负载的 PING：扩展长度即超长
    const decoder = createFrameDecoder();
    const events = decoder.push(
      clientFrame({ opcode: OPCODE.PING, payload: Buffer.alloc(126, 9) }),
    );
    assert.equal(events[0].kind, "protocol-error");
    assert.equal(events[0].code, CLOSE_CODE.PROTOCOL_ERROR);
  });

  test("TEXT + CONT 重组为单条消息", () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(
      Buffer.concat([
        clientFrame({ opcode: OPCODE.TEXT, payload: "Hel", fin: false }),
        clientFrame({ opcode: OPCODE.CONT, payload: "lo ", fin: false }),
        clientFrame({ opcode: OPCODE.CONT, payload: "world" }),
      ]),
    );
    assert.deepEqual(events, [{ kind: "text", text: "Hello world" }]);
  });

  test("分片间穿插 PING：控制帧即时产出，消息在其后封口", () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(
      Buffer.concat([
        clientFrame({ opcode: OPCODE.TEXT, payload: "Hel", fin: false }),
        clientFrame({ opcode: OPCODE.PING, payload: "beat" }),
        clientFrame({ opcode: OPCODE.CONT, payload: "lo" }),
      ]),
    );
    assert.equal(events.length, 2);
    // 顺序：PING 先（解析到即产出），TEXT 在最后一个分片到达时封口
    assert.equal(events[0].kind, "ping");
    assert.deepEqual(events[0].payload, Buffer.from("beat", "utf8"));
    assert.deepEqual(events[1], { kind: "text", text: "Hello" });
  });

  test("非法分片结构：CONT 起手 / 分片中插入新数据帧 → 1002", () => {
    const d1 = createFrameDecoder();
    const e1 = d1.push(clientFrame({ opcode: OPCODE.CONT, payload: "x" }));
    assert.equal(e1[0].kind, "protocol-error");
    assert.equal(e1[0].code, CLOSE_CODE.PROTOCOL_ERROR);

    const d2 = createFrameDecoder();
    const e2 = d2.push(
      Buffer.concat([
        clientFrame({ opcode: OPCODE.TEXT, payload: "a", fin: false }),
        clientFrame({ opcode: OPCODE.TEXT, payload: "b" }),
      ]),
    );
    assert.equal(e2[e2.length - 1].kind, "protocol-error");
    assert.equal(e2[e2.length - 1].code, CLOSE_CODE.PROTOCOL_ERROR);
  });

  test("close 解析：空负载 → 1005", () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(clientFrame({ opcode: OPCODE.CLOSE }));
    assert.deepEqual(events, [
      { kind: "close", code: CLOSE_CODE.NO_STATUS, reason: "" },
    ]);
  });

  test("close 解析：大端 code + UTF-8 reason", () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(
      clientFrame({ opcode: OPCODE.CLOSE, payload: closeBody(1000, "bye") }),
    );
    assert.deepEqual(events, [{ kind: "close", code: 1000, reason: "bye" }]);
  });

  test("close 解析：1 字节负载 / 非法 code → 1002", () => {
    const d1 = createFrameDecoder();
    const e1 = d1.push(clientFrame({ opcode: OPCODE.CLOSE, payload: Buffer.from([0x03]) }));
    assert.equal(e1[0].kind, "protocol-error");
    assert.equal(e1[0].code, CLOSE_CODE.PROTOCOL_ERROR);

    // 1005/1006 只作内部语义，出现在线上即违规
    const d2 = createFrameDecoder();
    const e2 = d2.push(
      clientFrame({ opcode: OPCODE.CLOSE, payload: closeBody(1005) }),
    );
    assert.equal(e2[0].kind, "protocol-error");
    assert.equal(e2[0].code, CLOSE_CODE.PROTOCOL_ERROR);

    const d3 = createFrameDecoder();
    const e3 = d3.push(clientFrame({ opcode: OPCODE.CLOSE, payload: closeBody(999) }));
    assert.equal(e3[0].kind, "protocol-error");
  });

  test("close 解析：reason 非法 UTF-8 → 1007", () => {
    const decoder = createFrameDecoder();
    const body = Buffer.concat([closeBody(1000), Buffer.from([0xff, 0xfe])]);
    const events = decoder.push(clientFrame({ opcode: OPCODE.CLOSE, payload: body }));
    assert.equal(events[0].kind, "protocol-error");
    assert.equal(events[0].code, CLOSE_CODE.INVALID_UTF8);
  });

  test("UTF-8 跨分片：多字节字符被拆进两个 CONT 分片仍正确重组", () => {
    const decoder = createFrameDecoder();
    const mid = Buffer.from("中", "utf8"); // E4 B8 AD
    assert.equal(mid.length, 3);
    const events = decoder.push(
      Buffer.concat([
        clientFrame({ opcode: OPCODE.TEXT, payload: mid.subarray(0, 2), fin: false }),
        clientFrame({ opcode: OPCODE.CONT, payload: Buffer.concat([mid.subarray(2), Buffer.from("文", "utf8")]) }),
      ]),
    );
    assert.deepEqual(events, [{ kind: "text", text: "中文" }]);
  });

  test("UTF-8 跨 push 边界：同一帧的字节被任意切块仍正确解码", () => {
    const decoder = createFrameDecoder();
    const frame = clientFrame({ opcode: OPCODE.TEXT, payload: "中文abc😀" });
    const events = [];
    for (let i = 0; i < frame.length; i += 3) {
      events.push(...decoder.push(frame.subarray(i, i + 3)));
    }
    assert.deepEqual(events, [{ kind: "text", text: "中文abc😀" }]);
  });

  test("UTF-8 截断 / 非法序列 → protocol-error 1007", () => {
    const mid = Buffer.from("中", "utf8");
    const d1 = createFrameDecoder();
    // 消息在多字节序列中间结束
    const e1 = d1.push(clientFrame({ opcode: OPCODE.TEXT, payload: mid.subarray(0, 2) }));
    assert.equal(e1[0].kind, "protocol-error");
    assert.equal(e1[0].code, CLOSE_CODE.INVALID_UTF8);

    const d2 = createFrameDecoder();
    const e2 = d2.push(clientFrame({ opcode: OPCODE.TEXT, payload: Buffer.from([0xff]) }));
    assert.equal(e2[0].kind, "protocol-error");
    assert.equal(e2[0].code, CLOSE_CODE.INVALID_UTF8);
  });

  test("超限 → protocol-error 1009（单帧）", () => {
    const decoder = createFrameDecoder({ maxFrameBytes: 16 });
    const events = decoder.push(
      clientFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(17, 1) }),
    );
    assert.equal(events[0].kind, "protocol-error");
    assert.equal(events[0].code, CLOSE_CODE.TOO_LARGE);
    assert.equal(decoder.errored, true);
  });

  test("超限 → protocol-error 1009（分片累计超出上限）", () => {
    const decoder = createFrameDecoder({ maxFrameBytes: 16 });
    decoder.push(clientFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(10), fin: false }));
    const events = decoder.push(clientFrame({ opcode: OPCODE.CONT, payload: Buffer.alloc(10) }));
    assert.equal(events[0].kind, "protocol-error");
    assert.equal(events[0].code, CLOSE_CODE.TOO_LARGE);
  });

  test("默认上限 1 MiB：恰在上限内放行，超一字节即 1009", () => {
    const ok = createFrameDecoder();
    const events = ok.push(
      clientFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(1024 * 1024) }),
    );
    assert.equal(events[0].kind, "binary");
    assert.equal(events[0].data.length, 1024 * 1024);

    const tooBig = createFrameDecoder();
    const events2 = tooBig.push(
      clientFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(1024 * 1024 + 1) }),
    );
    assert.equal(events2[0].kind, "protocol-error");
    assert.equal(events2[0].code, CLOSE_CODE.TOO_LARGE);
  });

  test("一次 push 多帧按序产出，控制帧穿插在消息之间", () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(
      Buffer.concat([
        clientFrame({ opcode: OPCODE.TEXT, payload: "one" }),
        clientFrame({ opcode: OPCODE.PING }),
        clientFrame({ opcode: OPCODE.BINARY, payload: Buffer.from([1, 2]) }),
        clientFrame({ opcode: OPCODE.PONG, payload: "p" }),
      ]),
    );
    assert.deepEqual(
      events.map((e) => e.kind),
      ["text", "ping", "binary", "pong"],
    );
  });

  test("非最小编码的长度字段 → protocol-error 1002", () => {
    // 5 字节负载却用 126+2B 编码长度：违反 §5.2 最小编码要求
    const decoder = createFrameDecoder();
    const events = decoder.push(
      clientFrame({
        opcode: OPCODE.BINARY,
        payload: Buffer.alloc(5),
        len7Override: 126,
        extLenBytes: Buffer.from([0x00, 0x05]),
      }),
    );
    assert.equal(events[0].kind, "protocol-error");
    assert.equal(events[0].code, CLOSE_CODE.PROTOCOL_ERROR);
  });

  test("protocol-error 是终态：后续 push 返回空数组", () => {
    const decoder = createFrameDecoder();
    decoder.push(clientFrame({ opcode: OPCODE.TEXT, payload: "x", masked: false }));
    assert.equal(decoder.errored, true);
    const events = decoder.push(clientFrame({ opcode: OPCODE.TEXT, payload: "ok" }));
    assert.deepEqual(events, []);
    assert.equal(decoder.errored, true);
  });

  test("构造参数非法抛 RangeError", () => {
    assert.throws(() => createFrameDecoder({ maxFrameBytes: 0 }), RangeError);
    assert.throws(() => createFrameDecoder({ maxFrameBytes: -1 }), RangeError);
    assert.throws(() => createFrameDecoder({ maxFrameBytes: 1.5 }), RangeError);
  });
});
