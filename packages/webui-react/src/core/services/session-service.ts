/**
 * core/services/session-service.ts —— SessionServicePort 实现（会话生命周期 + 会话隔离切片）
 * 【职责】REST 会话 CRUD（/api/sessions*）＋ 维护 Map<SessionId, Store<SessionSlice>>：
 *   每个会话一份独立 store（core/store/create-store.ts），消息 / 流式缓冲 / 上下文 /
 *   模型三段选择互不串扰；切换会话绝不清空或污染其它会话的切片。
 * 【接缝】实现 contracts/ports.ts 的 SessionServicePort，并额外暴露 store/update/ids
 *   供 features 的流式翻译层写切片（stream -> domain 的接缝）；每会话 selection
 *   经 KeyValueStorePort 持久化（webui_sel:<id>），reload 后仍是每会话独立保存。
 */
import { createStore } from '../store/create-store';
import type { Store, Updater } from '../store/create-store';
import type {
  HttpPort,
  KeyValueStorePort,
  SessionServicePort,
  StreamPort,
} from '../../contracts/ports';
import type { ModelSelection, SessionId, SessionSlice, SessionSummary, ThinkingEffort } from '../../contracts/domain';
import { THINKING_EFFORTS, emptySessionSlice } from '../../contracts/domain';

/** session-service 用到的端口窄视图（持有器视图）。 */
export interface SessionPorts {
  http: HttpPort;
  /** 预留接缝：流式帧 -> 切片的翻译层将来挂在 features，这里不解析帧。 */
  stream: StreamPort;
  kv: KeyValueStorePort;
}

export interface SessionServiceDeps {
  /** 端口持有器：字段每次用时现读 —— 热替换后立即生效，不在构造期捕获实例。 */
  ports: SessionPorts;
  /** 每会话切片的默认模型选择（默认 minimax_api / medium）。 */
  defaultSelection?: ModelSelection;
}

/** 比端口更宽的实现类型：store/update/ids 是流式翻译层的写入口。 */
export interface SessionService extends SessionServicePort {
  store(id: SessionId): Store<SessionSlice>;
  update(id: SessionId, updater: Updater<SessionSlice>): void;
  ids(): SessionId[];
}

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  provider: 'minimax_api',
  model: '',
  thinking: 'medium',
};

function selKey(id: SessionId): string {
  return 'webui_sel:' + id;
}

function toSummary(raw: unknown): SessionSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : '';
  if (!id) return null;
  return {
    id,
    title: typeof o['title'] === 'string' ? o['title'] : '',
    workspace: typeof o['workspace'] === 'string' ? o['workspace'] : null,
    mcodeSessionId: typeof o['mcodeSessionId'] === 'string' ? o['mcodeSessionId'] : null,
    titleCustom: o['titleCustom'] === true,
    updatedAt: Number(o['updatedAt']) || 0,
  };
}

function isEffort(v: unknown): v is ThinkingEffort {
  return typeof v === 'string' && (THINKING_EFFORTS as readonly string[]).includes(v);
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const ports = deps.ports;
  const fallback: ModelSelection = deps.defaultSelection ?? DEFAULT_MODEL_SELECTION;
  /** 会话隔离的核心结构：每个 sessionId 一份独立 store，互不共享。 */
  const slices = new Map<SessionId, Store<SessionSlice>>();

  function loadSelection(id: SessionId): ModelSelection {
    try {
      const raw = ports.kv.get(selKey(id));
      if (!raw) return { ...fallback };
      const o = JSON.parse(raw) as unknown;
      if (typeof o === 'object' && o !== null) {
        const r = o as Record<string, unknown>;
        if (typeof r['provider'] === 'string' && typeof r['model'] === 'string' && isEffort(r['thinking'])) {
          return { provider: r['provider'], model: r['model'], thinking: r['thinking'] };
        }
      }
    } catch {
      // 坏数据当没有
    }
    return { ...fallback };
  }

  function persistSelection(id: SessionId, sel: ModelSelection): void {
    try {
      ports.kv.set(selKey(id), JSON.stringify(sel));
    } catch {
      // 持久化失败不影响内存态
    }
  }

  /**
   * 新建会话切片 —— 逐字段新建，任何字段都不与别的切片（或模块常量）共享引用。
   * 即便 emptySessionSlice 的默认值将来改成常量复用，这里也逐个复制：
   * messages / todos / attachments 数组与 selection / context / goal 对象
   * 都不得跨会话共享（#2 会话隔离的结构保证）。
   */
  function freshSlice(id: SessionId): SessionSlice {
    const base = emptySessionSlice(id, loadSelection(id));
    return {
      ...base,
      selection: { ...base.selection },
      messages: [...base.messages],
      todos: [...base.todos],
      attachments: [...base.attachments],
      context: base.context ? { ...base.context } : null,
      goal: base.goal ? { ...base.goal } : null,
      inflightId: null,
    };
  }

  function storeFor(id: SessionId): Store<SessionSlice> {
    let s = slices.get(id);
    if (!s) {
      s = createStore<SessionSlice>(freshSlice(id));
      slices.set(id, s);
    }
    return s;
  }

  function update(id: SessionId, updater: Updater<SessionSlice>): void {
    const s = storeFor(id);
    const prev = s.get();
    const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
    if (next.selection !== prev.selection) persistSelection(id, next.selection);
    s.set(next);
  }

  return {
    async list(): Promise<SessionSummary[]> {
      const res = await ports.http.get<{ sessions?: unknown[] }>('/api/sessions');
      const rows = Array.isArray(res.sessions) ? res.sessions : [];
      const out: SessionSummary[] = [];
      for (const row of rows) {
        const s = toSummary(row);
        if (!s) continue;
        out.push(s);
        // 只刷新 summary 字段，绝不触碰该会话（或任何其它会话）的消息
        if (slices.has(s.id)) update(s.id, { summary: s });
      }
      return out;
    },

    async create(workspace?: string | null): Promise<SessionId> {
      const body = workspace != null ? { workspace } : {};
      const res = await ports.http.post<{ id?: unknown }>('/api/sessions', body);
      const id = typeof res.id === 'string' ? res.id : '';
      if (!id) throw new Error('session create: missing id in response');
      update(id, {
        summary: {
          id,
          title: '',
          workspace: workspace ?? null,
          mcodeSessionId: null,
          titleCustom: false,
          updatedAt: Date.now(),
        },
      });
      return id;
    },

    async switchTo(id: SessionId): Promise<void> {
      await ports.http.post('/api/sessions/switch', { id });
      // 会话隔离：切换只通知服务端，本地任何切片都不清空、不重建。
    },

    async rename(id: SessionId, title: string): Promise<void> {
      await ports.http.post('/api/sessions/rename', { id, title });
      const s = slices.get(id);
      if (s) {
        const prev = s.get();
        update(id, {
          summary: prev.summary
            ? { ...prev.summary, title, titleCustom: true }
            : { id, title, workspace: null, mcodeSessionId: null, titleCustom: true, updatedAt: Date.now() },
        });
      }
    },

    async remove(id: SessionId): Promise<void> {
      await ports.http.del('/api/sessions/' + encodeURIComponent(id));
      slices.delete(id); // 只丢这一份切片，其它会话原样保留
      try {
        ports.kv.remove(selKey(id));
      } catch {
        // 忽略
      }
    },

    slice(id: SessionId): SessionSlice {
      return storeFor(id).get();
    },

    subscribe(id: SessionId, listener: () => void): () => void {
      return storeFor(id).subscribe(listener);
    },

    store: storeFor,
    update,
    ids(): SessionId[] {
      return [...slices.keys()];
    },
  };
}
