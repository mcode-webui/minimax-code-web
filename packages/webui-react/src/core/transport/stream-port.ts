/**
 * core/transport/stream-port.ts —— StreamPort 的 WebSocket 实现（/api/stream 事件流）
 * 【职责】按 location 协议连 ws(s)://host/api/stream（带 token & cid 查询串）；
 *   只收文本 JSON 帧并把原始对象**原样**经 onFrame 上抛（不做业务解析）；
 *   断线 3 秒重连；维护 seq 车票供 resume。
 * 【接缝】实现 contracts/ports.ts 的 StreamPort，帧格式见 contracts/protocol.ts。
 *   resume 策略：本页连接史里有 lastSeq 才在 hello 后发 {type:'resume'}，否则
 *   什么都不发（基线由调用方拉 REST）；error 帧 code=resume-underrun 时把
 *   lastSeq 回退为 hello 的 latestSeq。lastSeq 只活在本实例（跨 reload 会重新
 *   拉 REST 基线，重放旧事件反而会回滚 UI）。二进制帧 / 非法 JSON / 未知帧类型
 *   一律静默忽略（向前兼容）。
 */
import type { KeyValueStorePort, StreamPort, StreamStatus } from '../../contracts/ports';
import type { ClientFrame, ServerFrame } from '../../contracts/protocol';
import { PROTOCOL_VERSION, isServerFrame } from '../../contracts/protocol';
import type { AuthedHttpPort } from './http-port';
import { WEBUI_CID_KEY, WEBUI_TOKEN_KEY } from './http-port';

/** stream 用到的端口窄视图（持有器视图）。 */
export interface StreamPorts {
  /** 取实时 token / cid（token 可能被 auth.token_rotated 轮换过，必须现读）。 */
  http: AuthedHttpPort;
  /** 兜底身份源（http 未注入身份时从 kv 读）。 */
  kv: KeyValueStorePort;
}

export interface StreamPortDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: StreamPorts;
}

const RECONNECT_MS = 3000;
const KNOWN_FRAME_TYPES: ReadonlySet<string> = new Set(['hello', 'state.snapshot', 'control', 'error', 'pong']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

export function createStreamPort(deps: StreamPortDeps): StreamPort {
  const listeners = new Set<(raw: unknown) => void>();
  let ws: WebSocket | null = null;
  let status: StreamStatus = 'idle';
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 单调 seq 车票：断线重连时用于 resume。null = 没有可续的历史。 */
  let lastSeq: number | null = null;
  /** 最近一次 hello 的 latestSeq：resume-underrun 时回退到这里。 */
  let helloLatestSeq: number | null = null;

  function buildUrl(): string {
    const loc = typeof location !== 'undefined' ? location : null;
    const scheme = loc && loc.protocol === 'https:' ? 'wss' : 'ws';
    const host = loc ? loc.host : '127.0.0.1:18090';
    const token = deps.ports.http.getToken() || deps.ports.kv.get(WEBUI_TOKEN_KEY) || '';
    const cid = deps.ports.http.cid() || deps.ports.kv.get(WEBUI_CID_KEY) || '';
    const parts: string[] = [];
    if (token) parts.push('token=' + encodeURIComponent(token));
    if (cid) parts.push('cid=' + encodeURIComponent(cid));
    const query = parts.length ? '?' + parts.join('&') : '';
    return scheme + '://' + host + '/api/stream' + query;
  }

  function emit(raw: unknown): void {
    for (const l of listeners) {
      try {
        l(raw);
      } catch {
        // 监听方异常不许打断帧分发
      }
    }
  }

  function sendFrame(frame: ClientFrame): void {
    if (!ws || status !== 'open') return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // 发不进去就丢：下一次重连会用 resume 补
    }
  }

  function handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // 非 JSON 文本帧：静默忽略
    }
    if (!isServerFrame(parsed)) return;
    const frame: ServerFrame = parsed;
    if (!KNOWN_FRAME_TYPES.has(frame.type)) return; // 未知帧类型：静默忽略

    const seq: unknown = frame.seq;
    if (typeof seq === 'number' && Number.isFinite(seq) && (lastSeq === null || seq > lastSeq)) {
      lastSeq = seq;
    }

    if (frame.type === 'hello') {
      const p = asRecord(frame.payload);
      const latest: unknown = p ? p['latestSeq'] : null;
      helloLatestSeq = typeof latest === 'number' && Number.isFinite(latest) ? latest : null;
      // 本地有 lastSeq 才续传；否则什么都不做，基线由调用方拉 REST
      if (lastSeq !== null) {
        sendFrame({ v: PROTOCOL_VERSION, type: 'resume', payload: { lastSeq } });
      }
    } else if (frame.type === 'error') {
      const p = asRecord(frame.payload);
      if (p && p['code'] === 'resume-underrun') {
        // 环形缓冲已覆盖不到 lastSeq —— 服务端补发了最新快照，车票回退到 hello 的水位
        lastSeq = helloLatestSeq;
      }
    }

    emit(frame); // 原样上抛，业务解析归 features / services
  }

  function scheduleReconnect(): void {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      openSocket();
    }, RECONNECT_MS);
  }

  function openSocket(): void {
    if (stopped || ws) return;
    if (typeof WebSocket === 'undefined') return; // 非浏览器环境（单测）：保持 idle
    status = 'connecting';
    let socket: WebSocket;
    try {
      socket = new WebSocket(buildUrl());
    } catch {
      status = 'reconnecting';
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.onopen = (): void => {
      if (ws === socket) status = 'open';
    };
    socket.onmessage = (ev: MessageEvent): void => {
      if (ws !== socket) return;
      const data: unknown = ev.data;
      if (typeof data !== 'string') return; // 二进制帧：静默忽略
      handleMessage(data);
    };
    socket.onclose = (): void => {
      if (ws !== socket) return;
      ws = null;
      if (stopped) {
        status = 'closed';
        return;
      }
      status = 'reconnecting';
      scheduleReconnect();
    };
    socket.onerror = (): void => {
      // 交给 onclose 收尾（close 紧随 error），这里不重复调度重连
    };
  }

  return {
    connect(): void {
      stopped = false;
      if (!ws && timer === null) openSocket(); // 幂等：已有连接或待重连时不再开新连接
    },
    close(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const socket = ws;
      ws = null;
      status = 'closed';
      if (socket) {
        try {
          socket.close();
        } catch {
          // 忽略
        }
      }
    },
    send: sendFrame,
    onFrame(listener: (raw: unknown) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    status: (): StreamStatus => status,
  };
}
