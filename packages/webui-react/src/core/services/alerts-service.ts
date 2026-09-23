/**
 * core/services/alerts-service.ts —— AlertsServicePort 实现（异常通道 / 铃铛）
 * 【职责】GET /api/alerts 取快照；订阅 stream 的 alerts.append / alerts.update 控制帧
 *   做增量合并；按 alert.id 去重 —— 断线重放的快照/事件不得重复计入未读。
 *   提供 list / unread / markRead / clear / subscribe。
 * 【接缝】实现 contracts/ports.ts 的 AlertsServicePort；wire alert 经
 *   contracts/protocol.ts 的 normalizeWireAlert 归一后才进 AlertItem。
 */
import type { AlertsServicePort, HttpPort, StreamPort } from '../../contracts/ports';
import type { AlertItem } from '../../contracts/domain';
import type { WireAlert } from '../../contracts/protocol';
import { normalizeWireAlert } from '../../contracts/protocol';

/** alerts-service 用到的端口窄视图（持有器视图）。 */
export interface AlertsPorts {
  http: HttpPort;
  stream: StreamPort;
}

export interface AlertsServiceDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: AlertsPorts;
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

function toItem(wire: WireAlert): AlertItem | null {
  if (!wire.id) return null; // id 为空串 = 不可用，跳过
  return {
    id: wire.id,
    ts: wire.ts,
    level: wire.level,
    msg: wire.msg,
    src: wire.src,
    sessionId: wire.sessionId ?? null,
    count: wire.count ?? 1,
  };
}

export function createAlertsService(deps: AlertsServiceDeps): AlertsServicePort {
  const ports = deps.ports;
  /** 到达顺序即环形缓冲顺序（最旧在前）；Map.set 已存在 id 时保持原位置。 */
  const byId = new Map<string, AlertItem>();
  const readIds = new Set<string>();
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

  function merge(item: AlertItem | null): void {
    if (!item) return;
    byId.set(item.id, item); // 按 id 去重：重放不会新增条目
  }

  function handleDelta(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const o = asRecord(parsed);
    if (!o) return;
    const kind = o['kind'];
    if (kind !== 'append' && kind !== 'update') return;
    merge(toItem(normalizeWireAlert(o['alert'])));
    emit();
  }

  ports.stream.onFrame((raw) => {
    const ctrl = readControl(raw);
    if (!ctrl) return;
    if (ctrl.name === 'alerts.append' || ctrl.name === 'alerts.update') {
      handleDelta(ctrl.data);
    }
  });

  return {
    async snapshot(): Promise<AlertItem[]> {
      const res = await ports.http.get<{ alerts?: unknown }>('/api/alerts');
      const rows = Array.isArray(res.alerts) ? res.alerts : [];
      for (const row of rows) {
        merge(toItem(normalizeWireAlert(row)));
      }
      emit();
      return this.list();
    },

    list(): AlertItem[] {
      return [...byId.values()];
    },

    unread(): number {
      let n = 0;
      for (const id of byId.keys()) if (!readIds.has(id)) n += 1;
      return n;
    },

    markRead(): void {
      for (const id of byId.keys()) readIds.add(id);
      emit();
    },

    clear(): void {
      byId.clear();
      readIds.clear();
      emit();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
