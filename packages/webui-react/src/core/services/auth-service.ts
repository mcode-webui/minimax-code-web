/**
 * core/services/auth-service.ts —— AuthServicePort 实现（每请求授权队列）
 * 【职责】订阅 stream 的 needs_authorization / authorization_decided 控制帧维护
 *   待确认队列（按 requestId 去重）；decide() 发 POST /api/auth/decision
 *   （requestId + approve 严格布尔）；返回 404 视为已在别处决定，本地移除。
 *   提供 pending / decide / subscribe。
 * 【接缝】实现 contracts/ports.ts 的 AuthServicePort；wire 数据经 contracts/
 *   protocol.ts 的 WireAuthRequest / WireAuthDecided 形状收窄后进 PendingAuth。
 */
import type { AuthServicePort, HttpPort, StreamPort } from '../../contracts/ports';
import type { PendingAuth } from '../../contracts/domain';
import { HttpError } from '../transport/http-port';

/** auth-service 用到的端口窄视图（持有器视图）。 */
export interface AuthPorts {
  http: HttpPort;
  stream: StreamPort;
}

export interface AuthServiceDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: AuthPorts;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function readControl(raw: unknown): { name: string; data: string } | null {
  const f = asRecord(raw);
  if (!f || f['type'] !== 'control') return null;
  const p = asRecord(f['payload']);
  if (!p) return null;
  const name = p['name'];
  const data = p['data'];
  if (typeof name !== 'string' || typeof data !== 'string') return null;
  return { name, data };
}

/**
 * 404 = 该请求已在别处被决定（或已过期被服务端丢弃）。
 * 鸭子类型兜底：HttpPort 实现也可以抛普通 Error —— 只要带 status=404（数字或
 * 字符串）、code 写明 404 / not_found，或消息里写明 404 / not found，都识别为已决定。
 */
function isNotFound(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 404;
  const o = asRecord(e);
  if (o) {
    if (o['status'] === 404 || o['status'] === '404') return true;
    const code = o['code'];
    if (typeof code === 'string' && /\b404\b|not[_ -]?found/i.test(code)) return true;
  }
  return e instanceof Error && /\b404\b|not found/i.test(e.message);
}

export function createAuthService(deps: AuthServiceDeps): AuthServicePort {
  const ports = deps.ports;
  /** 按 requestId 去重的待确认队列（到达序）。 */
  const queue = new Map<string, PendingAuth>();
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // 监听方异常不打断分发
      }
    }
  }

  function enqueue(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const o = asRecord(parsed);
    if (!o) return;
    const requestId = o['requestId'];
    if (typeof requestId !== 'string' || !requestId) return;
    if (queue.has(requestId)) return; // 去重：重放不重复弹窗
    const ctxRaw = asRecord(o['ctx']);
    const ctx: Record<string, unknown> = ctxRaw ? { ...ctxRaw } : {};
    queue.set(requestId, {
      requestId,
      action: typeof o['action'] === 'string' ? o['action'] : '',
      ctx,
      expiresAt: Number(o['expiresAt']) || 0,
      receivedAt: Date.now(),
    });
    emit();
  }

  function dequeue(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const o = asRecord(parsed);
    const requestId = o ? o['requestId'] : undefined;
    if (typeof requestId === 'string' && queue.delete(requestId)) emit();
  }

  ports.stream.onFrame((raw) => {
    const ctrl = readControl(raw);
    if (!ctrl) return;
    if (ctrl.name === 'needs_authorization') enqueue(ctrl.data);
    else if (ctrl.name === 'authorization_decided') dequeue(ctrl.data);
  });

  return {
    pending(): PendingAuth[] {
      return [...queue.values()];
    },

    async decide(requestId: string, approve: boolean): Promise<void> {
      try {
        await ports.http.post('/api/auth/decision', { requestId, approve: approve === true });
      } catch (e) {
        if (!isNotFound(e)) throw e; // 其它失败保留队列项，便于重试
      }
      if (queue.delete(requestId)) emit();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
