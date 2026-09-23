// webui/server/lib/ws-frame.js
// RFC 6455 WebSocket 帧层（服务端子集）：握手密钥 + 帧编码 + 增量帧解码。
//
// 职责：为 WebSocket 数据面（/api/stream）提供帧级原语，不含握手 HTTP
// 处理、心跳调度与消息路由——那些属于上层连接管理。
//
// 范围（RFC 6455 服务端子集，按需最小实现）：
//   - computeAcceptKey：握手 Sec-WebSocket-Accept 计算（§1.3 标例）。
//   - encodeFrame：服务端 → 客户端帧编码，FIN=1、不掩码（§5.2）。
//   - createFrameDecoder：客户端 → 服务端帧流增量解码，要求掩码（§5.1），
//     支持分片重组、控制帧穿插、跨分片 UTF-8 校验、close 解析。
//   - 不实现压缩扩展：RSV 非 0 一律按协议错误（1002）拒绝。
//
// 设计约束：
//   - 零 npm 依赖（packages/webui 保持零依赖包）：仅 node:crypto 与全局 TextDecoder。
//   - 帧原语为纯函数、解码器为显式状态机，便于 RFC 6455 一致性单测逐条覆盖。

import { createHash } from "node:crypto";

/** RFC 6455 §1.3 握手 GUID，与客户端 Sec-WebSocket-Key 拼接后做 SHA-1。 */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** RFC 6455 §5.6 操作码。 */
export const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** RFC 6455 §7.4.1 关闭状态码（本项目用到的子集）。 */
export const CLOSE_CODE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  NO_STATUS: 1005,
  INVALID_UTF8: 1007,
  TOO_LARGE: 1009,
  POLICY_VIOLATION: 1008,
  TRY_AGAIN_LATER: 1013,
};

/** 默认单帧负载上限：1 MiB（与网络层草案 §7.2 帧约束一致）。 */
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

/**
 * 解码器产出的事件联合类型：
 *   {kind:'text', text}                     文本消息（分片已重组、UTF-8 已校验）
 *   {kind:'binary', data}                   二进制消息（分片已重组）
 *   {kind:'ping'|'pong', payload}           控制帧，穿插在分片间即时产出
 *   {kind:'close', code, reason}            关闭帧（空负载按 1005 上报）
 *   {kind:'protocol-error', code, reason}   协议违规，此后解码器进入终态
 *
 * @typedef {{kind: 'text', text: string}
 *   | {kind: 'binary', data: Buffer}
 *   | {kind: 'ping', payload: Buffer}
 *   | {kind: 'pong', payload: Buffer}
 *   | {kind: 'close', code: number, reason: string}
 *   | {kind: 'protocol-error', code: number, reason: string}} WsFrameEvent
 */

/** 协议违规：内部信号，携带应答给对端的关闭码，由 push() 转成 protocol-error 事件。 */
class ProtocolViolation extends Error {
  /**
   * @param {number} code 关闭码（1002/1007/1009）
   * @param {string} reason 人类可读原因（会出现在 protocol-error 事件里）
   */
  constructor(code, reason) {
    super(reason);
    this.name = "ProtocolViolation";
    this.code = code;
    this.reason = reason;
  }
}

/**
 * 计算握手应答 Sec-WebSocket-Accept（RFC 6455 §1.3）。
 * 公式：base64(sha1(clientKey + WS_GUID))。
 *
 * @param {string} clientKey 客户端 Sec-WebSocket-Key 头原值
 * @returns {string} Sec-WebSocket-Accept 值
 */
export function computeAcceptKey(clientKey) {
  if (typeof clientKey !== "string") {
    throw new TypeError("ws-frame: clientKey must be a string");
  }
  return createHash("sha1").update(clientKey + WS_GUID, "utf8").digest("base64");
}

/**
 * 编码一个服务端 → 客户端帧（RFC 6455 §5.2：FIN=1、RSV=0、不掩码）。
 *
 * 长度编码：≤125 走 7 bit；≤65535 走 126 + 2 字节大端；更大走 127 + 8 字节
 * 大端（最高位恒为 0）。本子集不支持分片发送，每条消息一个帧。
 *
 * @param {{opcode: number, payload?: string | Buffer | Uint8Array}} frame
 * @returns {Buffer} 完整帧字节
 */
export function encodeFrame({ opcode, payload } = {}) {
  if (!Object.values(OPCODE).includes(opcode)) {
    throw new TypeError(`ws-frame: unknown opcode 0x${Number(opcode).toString(16)}`);
  }
  let body;
  if (payload === undefined || payload === null) {
    body = Buffer.alloc(0);
  } else if (typeof payload === "string") {
    body = Buffer.from(payload, "utf8");
  } else if (payload instanceof Uint8Array) {
    body = Buffer.from(payload);
  } else {
    throw new TypeError("ws-frame: payload must be a string, Buffer or Uint8Array");
  }

  const len = body.length;
  let header;
  if (len < 126) {
    // 7 bit 长度直接落在第二个头字节
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    // 8 字节大端；Buffer 长度 < 2^31，最高位恒为 0（§5.2 要求）
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

/**
 * 创建客户端 → 服务端帧流的增量解码器。
 *
 * 用法：把 socket 收到的原始字节按序 push() 进来，每次拿回该批次产出的事件
 * 数组。字节可以任意切块（TCP 不保帧边界），解码器内部缓存半帧。
 *
 * 违规映射（事件 code 即应答给对端的关闭码）：
 *   RSV 非 0 / 未掩码 / FIN=0 控制帧 / 控制帧 >125B / 结构类违规 → 1002
 *   文本消息非法 UTF-8（含截断多字节序列）                    → 1007
 *   单帧或重组消息超过 maxFrameBytes                          → 1009
 * 违规后解码器进入终态：errored 置 true，后续 push() 只返回空数组。
 *
 * @param {{maxFrameBytes?: number}} [options]
 * @param {number} [options.maxFrameBytes] 单帧负载上限，默认 1 MiB；分片重组后
 *   的消息总量同样受此上限约束（防分片放大占内存）
 * @returns {{ push: (chunk: Buffer | Uint8Array | string) => WsFrameEvent[], errored: boolean }}
 */
export function createFrameDecoder({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new RangeError(
      `ws-frame: maxFrameBytes must be an integer >= 1, got ${maxFrameBytes}`,
    );
  }

  /** @type {Buffer} 已收到但尚未构成完整帧的字节 */
  let pending = Buffer.alloc(0);
  /** @type {null | {opcode: number, parts: Buffer[], bytes: number, textDecoder: TextDecoder | null}} 进行中的分片消息 */
  let fragmented = null;
  let erroredFlag = false;

  /** 抛出协议违规，统一在 push() 里转成 protocol-error 事件。 */
  function fail(code, reason) {
    throw new ProtocolViolation(code, reason);
  }

  /**
   * 把消息的最后一个分片组装成完整消息事件（UTF-8 在此冲刷校验）。
   * @param {WsFrameEvent[]} events
   */
  function emitMessage(events) {
    if (fragmented.opcode === OPCODE.TEXT) {
      let text = "";
      try {
        // stream:true 让多字节字符可以横跨分片；末尾 decode() 冲刷残留，
        // 截断的多字节序列会在这里以 fatal 模式抛出。
        for (const part of fragmented.parts) {
          text += fragmented.textDecoder.decode(part, { stream: true });
        }
        text += fragmented.textDecoder.decode();
      } catch {
        fragmented = null;
        fail(CLOSE_CODE.INVALID_UTF8, "text message is not valid UTF-8");
      }
      events.push({ kind: "text", text });
    } else {
      events.push({ kind: "binary", data: Buffer.concat(fragmented.parts) });
    }
    fragmented = null;
  }

  /**
   * 追加一个数据帧分片（单帧消息 = 只有一个分片且立即封口）。
   * @param {Buffer} payload
   * @param {boolean} fin
   * @param {WsFrameEvent[]} events
   */
  function appendFragment(payload, fin, events) {
    fragmented.parts.push(payload);
    fragmented.bytes += payload.length;
    if (fragmented.bytes > maxFrameBytes) {
      fragmented = null;
      fail(CLOSE_CODE.TOO_LARGE, "reassembled message exceeds maxFrameBytes");
    }
    if (fin) emitMessage(events);
  }

  /**
   * 解析 close 帧负载（§5.5）：空负载 → 1005；否则 2 字节大端 code + UTF-8 reason。
   * @param {Buffer} payload
   * @returns {WsFrameEvent}
   */
  function parseClose(payload) {
    if (payload.length === 1) {
      // 负载非空时前两字节必须构成 code，1 字节是结构违规
      fail(CLOSE_CODE.PROTOCOL_ERROR, "close frame body must be empty or at least 2 bytes");
    }
    if (payload.length === 0) {
      return { kind: "close", code: CLOSE_CODE.NO_STATUS, reason: "" };
    }
    const code = payload.readUInt16BE(0);
    if (!isValidCloseCode(code)) {
      fail(CLOSE_CODE.PROTOCOL_ERROR, `invalid close code ${code}`);
    }
    let reason;
    try {
      reason = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
    } catch {
      fail(CLOSE_CODE.INVALID_UTF8, "close reason is not valid UTF-8");
    }
    return { kind: "close", code, reason };
  }

  /** 按操作码分发一个已解掩码的完整帧。 */
  function dispatchFrame(opcode, fin, payload, events) {
    switch (opcode) {
      case OPCODE.PING:
        events.push({ kind: "ping", payload });
        return;
      case OPCODE.PONG:
        events.push({ kind: "pong", payload });
        return;
      case OPCODE.CLOSE:
        events.push(parseClose(payload));
        return;
      case OPCODE.CONT: {
        if (fragmented === null) {
          fail(CLOSE_CODE.PROTOCOL_ERROR, "continuation frame without an initial data frame");
        }
        appendFragment(payload, fin, events);
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY: {
        if (fragmented !== null) {
          fail(CLOSE_CODE.PROTOCOL_ERROR, "new data frame while a fragmented message is in progress");
        }
        fragmented = {
          opcode,
          parts: [],
          bytes: 0,
          textDecoder: opcode === OPCODE.TEXT ? new TextDecoder("utf-8", { fatal: true }) : null,
        };
        appendFragment(payload, fin, events);
        return;
      }
    }
  }

  /** 反复解析 pending 中的完整帧，直到字节不足。 */
  function parseAvailable(events) {
    for (;;) {
      if (pending.length < 2) return;
      const b0 = pending[0];
      const b1 = pending[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      const len7 = b1 & 0x7f;

      // —— 头部合法性：仅凭前两字节即可判定的违规立刻失败 ——
      if (rsv !== 0) {
        // 本子集不实现压缩等扩展，RSV 必须全 0（§5.2）
        fail(CLOSE_CODE.PROTOCOL_ERROR, "RSV bits must be 0 (no extensions negotiated)");
      }
      if (!Object.values(OPCODE).includes(opcode)) {
        fail(CLOSE_CODE.PROTOCOL_ERROR, `unknown opcode 0x${opcode.toString(16)}`);
      }
      const isControl = (opcode & 0x08) !== 0;
      if (isControl) {
        if (!fin) fail(CLOSE_CODE.PROTOCOL_ERROR, "control frames must not be fragmented");
        // len7 为 126/127 时声明长度必然 >125，同属超长控制帧
        if (len7 > 125) fail(CLOSE_CODE.PROTOCOL_ERROR, "control frame payload must be <= 125 bytes");
      }
      if (!masked) {
        // 客户端 → 服务端帧必须掩码（§5.1）
        fail(CLOSE_CODE.PROTOCOL_ERROR, "client frames must be masked");
      }

      // —— 扩展长度：必须用最小字节数编码（§5.2）——
      let headerLen = 2;
      let payloadLen = len7;
      if (len7 === 126) {
        if (pending.length < 4) return; // 等待更多字节
        payloadLen = pending.readUInt16BE(2);
        if (payloadLen < 126) {
          fail(CLOSE_CODE.PROTOCOL_ERROR, "payload length must use the minimal encoding");
        }
        headerLen = 4;
      } else if (len7 === 127) {
        if (pending.length < 10) return;
        const big = pending.readBigUInt64BE(2);
        if (big > 0x7fffffffffffffffn) {
          fail(CLOSE_CODE.PROTOCOL_ERROR, "payload length high bit must be 0");
        }
        if (big <= 0xffffn) {
          fail(CLOSE_CODE.PROTOCOL_ERROR, "payload length must use the minimal encoding");
        }
        payloadLen = Number(big);
        headerLen = 10;
      }

      if (payloadLen > maxFrameBytes) {
        fail(CLOSE_CODE.TOO_LARGE, "frame payload exceeds maxFrameBytes");
      }

      // —— 等待掩码键 + 负载到齐后解掩码分发 ——
      const frameLen = headerLen + 4 + payloadLen;
      if (pending.length < frameLen) return;
      const key = pending.subarray(headerLen, headerLen + 4);
      const maskedPayload = pending.subarray(headerLen + 4, frameLen);
      const payload = Buffer.allocUnsafe(payloadLen);
      // 掩码 = 4 字节键按位循环异或（§5.3）
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = maskedPayload[i] ^ key[i & 3];
      }
      pending = pending.subarray(frameLen);

      dispatchFrame(opcode, fin, payload, events);
    }
  }

  return {
    /**
     * 喂入一段原始字节，返回本批次产出的事件（可能为空，可能含多帧）。
     *
     * @param {Buffer | Uint8Array | string} chunk
     * @returns {WsFrameEvent[]}
     */
    push(chunk) {
      /** @type {WsFrameEvent[]} */
      const events = [];
      if (erroredFlag) return events; // 终态：不再解析
      if (!(chunk instanceof Uint8Array) && typeof chunk !== "string") {
        throw new TypeError("ws-frame: chunk must be a Buffer/Uint8Array or string");
      }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      pending = Buffer.concat([pending, bytes]);
      try {
        parseAvailable(events);
      } catch (err) {
        if (err instanceof ProtocolViolation) {
          erroredFlag = true;
          fragmented = null;
          events.push({ kind: "protocol-error", code: err.code, reason: err.reason });
        } else {
          throw err;
        }
      }
      return events;
    },

    /** 是否已进入终态（发生过协议违规）。终态不可恢复，需上层关闭连接。 */
    get errored() {
      return erroredFlag;
    },
  };
}

/**
 * 关闭码是否允许出现在线上 close 帧里（§7.4.1）：
 * 1000–1014（1004/1005/1006 除外）与 3000–4999 合法；1005/1006/1015 仅作
 * 内部语义不得上线，其余为保留段。
 *
 * @param {number} code
 * @returns {boolean}
 */
function isValidCloseCode(code) {
  return (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}
