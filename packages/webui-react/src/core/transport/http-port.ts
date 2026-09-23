/**
 * core/transport/http-port.ts —— HttpPort 的 fetch 实现（REST 传输的唯一出口）
 * 【职责】拼 /api 前缀与 ?token=&cid= 查询串、注入 Authorization: Bearer 头，
 *   把「非 2xx」与「响应体 ok:false」统一归一为抛 Error(响应的 error 字段)。
 * 【接缝】实现 contracts/ports.ts 的 HttpPort，另暴露 setToken/getToken/cid 三个
 *   身份方法（token 轮换与 WS 地址需要）；token/cid 经 KeyValueStorePort 持久化
 *   （webui_token / webui_cid），token 优先读 URL ?token=，读到后立即
 *   history.replaceState 从地址栏抹掉（语义对齐 public/app/state.js 开头注释）。
 */
import type { HttpPort, KeyValueStorePort } from '../../contracts/ports';

export const WEBUI_TOKEN_KEY = 'webui_token';
export const WEBUI_CID_KEY = 'webui_cid';

/** 身份操作：stream-port 拼 WS 地址、settings-service 落 token 轮换时使用。 */
export interface HttpIdentity {
  setToken(token: string): void;
  getToken(): string;
  cid(): string;
}

/** 带身份操作的 HttpPort。 */
export type AuthedHttpPort = HttpPort & HttpIdentity;

/** http 用到的端口窄视图（持有器视图）。 */
export interface HttpPorts {
  kv: KeyValueStorePort;
}

export interface HttpPortDeps {
  /** 端口持有器：kv 每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: HttpPorts;
}

/** 携带 HTTP 状态码的失败，调用方可按 status 精确分支（例如 404 = 已在别处决定）。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** 网络层错误（fetch 抛出）也归一为 HttpError，status 记 0。 */
export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function readErrorField(data: unknown, fallback: string): string {
  const o = asRecord(data);
  if (o && typeof o['error'] === 'string' && o['error']) return o['error'];
  return fallback;
}

function readCode(data: unknown): string | undefined {
  const o = asRecord(data);
  const code = o ? o['code'] : undefined;
  return typeof code === 'string' && code ? code : undefined;
}

function isErrBody(data: unknown): boolean {
  const o = asRecord(data);
  return o !== null && o['ok'] === false;
}

/** 读 URL ?token=（用户从带 token 的链接进来）。 */
function readUrlToken(): string {
  try {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('token') ?? '';
  } catch {
    return '';
  }
}

/** 立刻把 ?token= 从地址栏抹掉，避免进 history / Referer（必须在任何请求之前跑）。 */
function stripTokenFromUrl(): void {
  try {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('token')) return;
    const clean = window.location.pathname + (window.location.hash || '');
    window.history.replaceState(null, '', clean);
  } catch {
    // 隐私模式等 —— token 仍在 kv，reload 依旧可用
  }
}

function createCid(): string {
  const c: unknown = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: unknown }).crypto : undefined;
  if (typeof c === 'object' && c !== null) {
    const gen = (c as { randomUUID?: unknown }).randomUUID;
    if (typeof gen === 'function') return String(gen.call(c));
  }
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function createHttpPort(deps: HttpPortDeps): AuthedHttpPort {
  const ports = deps.ports;

  // ── token 引导：URL ?token= 优先 → kv 兜底；随即抹掉地址栏 ────────────────
  let token = '';
  const urlToken = readUrlToken();
  if (urlToken) {
    token = urlToken;
    ports.kv.set(WEBUI_TOKEN_KEY, urlToken);
  } else {
    token = ports.kv.get(WEBUI_TOKEN_KEY) ?? '';
  }
  stripTokenFromUrl();

  // ── cid 引导：每浏览器一个稳定 client id，随所有请求上行 ───────────────────
  let cid = ports.kv.get(WEBUI_CID_KEY) ?? '';
  if (!cid) {
    cid = createCid();
    ports.kv.set(WEBUI_CID_KEY, cid);
  }

  function toUrl(path: string): string {
    let p = path.trim();
    if (!/^https?:\/\//i.test(p)) {
      if (p.startsWith('/api/') || p === '/api') {
        // 调用方已带前缀 —— 原样
      } else if (p.startsWith('/')) {
        p = '/api' + p;
      } else {
        p = '/api/' + p;
      }
    }
    const parts: string[] = [];
    if (token) parts.push('token=' + encodeURIComponent(token));
    parts.push('cid=' + encodeURIComponent(cid));
    const joiner = p.includes('?') ? (p.endsWith('?') || p.endsWith('&') ? '' : '&') : '?';
    return p + joiner + parts.join('&');
  }

  async function request<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    let payload: BodyInit | undefined;
    if (form) {
      payload = form; // multipart：Content-Type 由浏览器带 boundary 生成
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(toUrl(path), { method, headers, body: payload });
    } catch (e) {
      throw new HttpError(e instanceof Error ? e.message : String(e), 0);
    }

    let data: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null; // 非 JSON 响应体：只看状态码
      }
    }

    if (!res.ok) throw new HttpError(readErrorField(data, 'HTTP ' + res.status), res.status, readCode(data));
    if (isErrBody(data)) throw new HttpError(readErrorField(data, 'request failed'), res.status, readCode(data));
    const out: unknown = data ?? {};
    return out as T;
  }

  return {
    get: <T>(path: string): Promise<T> => request<T>('GET', path),
    post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
    del: <T>(path: string): Promise<T> => request<T>('DELETE', path),
    upload: <T>(path: string, file: Blob, name: string): Promise<T> => {
      const form = new FormData();
      form.append('file', file, name); // 服务端读 file 字段
      return request<T>('POST', path, undefined, form);
    },
    setToken(next: string): void {
      token = typeof next === 'string' ? next : '';
      if (token) ports.kv.set(WEBUI_TOKEN_KEY, token);
      else ports.kv.remove(WEBUI_TOKEN_KEY);
    },
    getToken: (): string => token,
    cid: (): string => cid,
  };
}
