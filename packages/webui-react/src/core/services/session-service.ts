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
import type {
  ChatMessage,
  ContextUsage,
  GoalPhase,
  GoalState,
  MessageBlock,
  ModelSelection,
  PlanState,
  Role,
  SessionId,
  SessionSlice,
  SessionSummary,
  ThinkingEffort,
  TodoItem,
  WorkspaceInfo,
} from '../../contracts/domain';
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
  /**
   * GET /api/state / state.snapshot 帧 → 切片水合。chat 只属于 state.sessionId
   * 那个会话：写入按 state.sessionId 落位，其它会话切片一概不动（会话隔离）。
   * 返回 state.sessionId（无则 null）。
   */
  hydrateFromWireState(raw: unknown): SessionId | null;
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
    // state.sessions 影子行只有 createdAt —— 回落它，避免相对时间显示 "—"。
    updatedAt: Number(o['updatedAt']) || Number(o['createdAt']) || 0,
  };
}

function isEffort(v: unknown): v is ThinkingEffort {
  return typeof v === 'string' && (THINKING_EFFORTS as readonly string[]).includes(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface ChatLinesResult {
  messages: ChatMessage[];
  todos: TodoItem[];
}

/**
 * 服务端 chat 行语法 → 消息 / 待办（对齐 vanilla public/app/render.js#parseChatLines）：
 *   › 或 > = 用户；● / • = 助手；▲ = 思考（连续行聚合成一块）；! / ○ / [xxx] = 系统；
 *   ✓✔○◌◯✗✘× 前缀 = 待办行（像 [error]/Questionnaire 的除外）；Plan: / Ask: / ◎ / →
 *   成块文本平铺为助手文本 —— 历史水合只做展示，绝不触发 plan/ask 弹窗副作用。
 *   续行并入当前块；每个 › / ● 行是独立一条消息（与 vanilla 一致）。
 */
export function chatLinesToMessages(raw: unknown[]): ChatLinesResult {
  const messages: ChatMessage[] = [];
  const todos: TodoItem[] = [];
  let seq = 0;
  let cur: { role: Role; kind: 'text' | 'thinking'; text: string } | null = null;

  // 工具块（→ 前缀 + 缩进续行，服务端 mcode-acp 写入的文法）：
  //   → toolName  {input}   ← 块头
  //     [completed]         ← 状态行（completed/failed/in_progress）—— 必须吃进块里，
  //     output             ← 否则原样漏出就是用户报告的「大量 [completed] 回显」
  //     @ /path            ← 涉及的本地文件
  //     ! error            ← 错误
  let tool: { name: string; status: 'running' | 'done' | 'error'; out: string[]; locs: number; err: string | null } | null = null;
  const flushTool = (): void => {
    if (!tool) return;
    const out = tool.out.slice(0, 8);
    if (tool.out.length > 8) out.push('…');
    const parts: string[] = [];
    if (out.length > 0) parts.push(out.join('\n'));
    if (tool.err) parts.push('! ' + tool.err);
    if (tool.locs > 0) parts.push(`@ ${tool.locs} 个本地文件`);
    const block: MessageBlock = {
      id: 'wb-' + seq,
      kind: 'tool-call',
      toolName: tool.name,
      status: tool.status,
      summary: parts.length > 0 ? parts.join('\n') : undefined,
    };
    messages.push({ id: 'wm-' + seq, role: 'system', blocks: [block], ts: seq, streaming: false });
    seq += 1;
    tool = null;
  };

  const flush = (): void => {
    flushTool();
    if (!cur) return;
    const block: MessageBlock =
      cur.kind === 'thinking'
        ? { id: 'wb-' + seq, kind: 'thinking', text: cur.text, done: true }
        : { id: 'wb-' + seq, kind: 'text', text: cur.text, markdown: cur.role !== 'user' };
    messages.push({ id: 'wm-' + seq, role: cur.role, blocks: [block], ts: seq, streaming: false });
    seq += 1;
    cur = null;
  };
  const feed = (role: Role, kind: 'text' | 'thinking', text: string): void => {
    // 只有连续 ▲ 思考行聚合成一块；其余前缀行各自成条（vanilla 语义）。
    if (kind === 'thinking' && cur && cur.kind === 'thinking') {
      cur.text += '\n' + text;
      return;
    }
    flush();
    cur = { role, kind, text };
  };
  // 续行并入当前块；无当前块时视为助手续写。（放在闭包里读 cur —— 外层循环直接
  // 读会被 TS 的闭包捕获收窄判成 never。）
  const appendContinuation = (text: string): void => {
    if (cur) cur.text += '\n' + text;
    else feed('assistant', 'text', text);
  };

  for (const rawLine of raw) {
    const line = typeof rawLine === 'string' ? rawLine : rawLine == null ? '' : String(rawLine);
    if (line.trim() === '') continue;
    const systemish =
      /^\[(error|warning|info|system)\]/i.test(line) ||
      /Questionnaire|requires.*user input|requires.*interactive/i.test(line);
    const todo = line.match(/^([✓✔○◌◯✗✘×])\s+(.+)$/);
    if (todo && !systemish) {
      const mark = todo[1];
      todos.push({
        id: 'wt-' + todos.length,
        content: todo[2],
        status: mark === '✓' || mark === '✔' ? 'completed' : 'pending',
      });
      feed('system', 'text', line);
      continue;
    }
    if (/^[›>]\s+/.test(line)) {
      feed('user', 'text', line.replace(/^[›>]\s+/, ''));
      continue;
    }
    if (/^[●•]\s+/.test(line)) {
      feed('assistant', 'text', line.replace(/^[●•]\s+/, ''));
      continue;
    }
    if (/^▲\s+/.test(line)) {
      feed('assistant', 'thinking', line.replace(/^▲\s+/, ''));
      continue;
    }
    if (systemish || /^[○◯!]\s+/.test(line)) {
      feed('system', 'text', line.replace(/^[○◯!]\s+/, ''));
      continue;
    }
    if (/^→\s+/.test(line)) {
      flush();
      const tm = line.match(/^→\s+(\S+?)(?:\s{2,}(.+))?$/);
      tool = { name: tm ? tm[1] : 'tool', status: 'running', out: [], locs: 0, err: null };
      continue;
    }
    // 工具块的缩进续行（必须先于其它分类 —— vanilla 同款文法）。
    if (tool && /^\s{2,}\S/.test(line)) {
      const stripped = line.replace(/^\s{2,}/, '');
      const st = stripped.match(/^\[([^\]]+)\]$/);
      if (st) {
        const s = st[1];
        tool.status = s === 'completed' ? 'done' : s === 'failed' ? 'error' : 'running';
      } else if (/^!\s+/.test(stripped)) {
        tool.err = stripped.replace(/^!\s+/, '');
        tool.status = 'error';
      } else if (/^@\s+/.test(stripped)) {
        tool.locs += 1;
      } else if (tool.out.length < 12) {
        tool.out.push(stripped);
      }
      continue;
    }
    if (/^(Plan\s*[:：]|Ask\b|[◎])/i.test(line.trim())) {
      feed('assistant', 'text', line);
      continue;
    }
    if (tool) flushTool();
    appendContinuation(line);
  }
  flush();
  return { messages, todos };
}

function mapContextUsage(o: Record<string, unknown>): ContextUsage {
  const used = num(o['used']) ?? num(o['tokens']) ?? 0;
  const limit = num(o['limit']) ?? 0;
  return {
    used,
    limit,
    percent: num(o['percent']) ?? (limit > 0 ? Math.round((used * 100) / limit) : 0),
    tps: num(o['tps']) ?? 0,
    source: 'api-state',
  };
}

/** wire state.plan → PlanState；inactive / 非对象 → null（应答后服务端已清空）。 */
function mapPlanState(o: Record<string, unknown>): PlanState | null {
  if (o['active'] !== true) return null;
  const rawOptions = Array.isArray(o['options']) ? o['options'] : [];
  const options = rawOptions.flatMap((raw) => {
    const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    if (!p) return [];
    return [{
      label: typeof p['label'] === 'string' ? p['label'] : '',
      desc: typeof p['desc'] === 'string' ? p['desc']
        : typeof p['description'] === 'string' ? p['description'] : '',
    }];
  });
  return {
    active: true,
    planId: typeof o['planId'] === 'string' ? o['planId'] : null,
    title: typeof o['title'] === 'string' ? o['title'] : '',
    summary: typeof o['summary'] === 'string' ? o['summary'] : '',
    options,
  };
}

const GOAL_PHASES: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete'];

/** wire state.goal → GoalState；inactive → null。status 未知值保守落 'active'。 */
function mapGoalState(o: Record<string, unknown>): GoalState | null {
  if (o['active'] !== true) return null;
  const text = typeof o['text'] === 'string' ? o['text']
    : typeof o['description'] === 'string' ? o['description'] : '';
  if (text === '') return null;
  const rawStatus = typeof o['status'] === 'string' ? o['status'] : 'active';
  const phase = (GOAL_PHASES as readonly string[]).includes(rawStatus) ? (rawStatus as GoalPhase) : 'active';
  const duration = typeof o['duration'] === 'number' && Number.isFinite(o['duration']) ? o['duration'] : 0;
  return { objective: text, phase, rounds: duration, startedAt: undefined };
}

function mapWorkspaceInfo(o: Record<string, unknown>): WorkspaceInfo {
  return {
    dir: typeof o['dir'] === 'string' ? o['dir'] : null,
    branch: typeof o['branch'] === 'string' ? o['branch'] : null,
    tree: typeof o['tree'] === 'string' ? o['tree'] : null,
  };
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
      const res = await ports.http.post<{ id?: unknown; session?: { id?: unknown } }>('/api/sessions', body);
      // 服务端实际回 { ok, session: { id, ... } }；兼容旧的 { id } 直出形状。
      const nested = res.session && typeof res.session === 'object' ? res.session.id : undefined;
      const id = typeof nested === 'string' ? nested : typeof res.id === 'string' ? res.id : '';
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
      const res = await ports.http.post<{ session?: unknown }>('/api/sessions/switch', { id });
      // 会话隔离：切换只通知服务端，本地任何切片都不清空、不重建。
      // 响应回带该会话的 chat —— 立即水合它**自己的**切片（按 res.session.id 落位），
      // 切换会话马上能看到对话内容，且绝不写到别的会话上。
      const s = asRecord(res.session);
      const sid = s && typeof s['id'] === 'string' && s['id'] !== '' ? s['id'] : id;
      const chat = s && Array.isArray(s['chat']) ? s['chat'] : null;
      if (chat) {
        const parsed = chatLinesToMessages(chat);
        update(sid, (prev) => ({
          ...prev,
          messages: parsed.messages,
          todos: parsed.todos.length > 0 ? parsed.todos : prev.todos,
          summary:
            s && typeof s['title'] === 'string'
              ? prev.summary
                ? { ...prev.summary, title: s['title'] }
                : {
                    id: sid,
                    title: s['title'],
                    workspace: null,
                    mcodeSessionId: typeof s['mcodeSessionId'] === 'string' ? s['mcodeSessionId'] : null,
                    titleCustom: false,
                    updatedAt: Date.now(),
                  }
              : prev.summary,
        }));
      }
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

    hydrateFromWireState(raw: unknown): SessionId | null {
      const s = asRecord(raw);
      if (!s) return null;
      const sid = typeof s['sessionId'] === 'string' && s['sessionId'] !== '' ? s['sessionId'] : null;
      if (!sid) return null;
      const chat = Array.isArray(s['chat']) ? s['chat'] : null;
      const runningO = asRecord(s['running']);
      const runningNow = runningO ? runningO['active'] === true : false;
      const ctxO = asRecord(s['context']);
      const wsO = asRecord(s['workspace']);
      const modelO = asRecord(s['model']);
      const planO = asRecord(s['plan']);
      const goalO = asRecord(s['goal']);
      const title = typeof s['sessionTitle'] === 'string' ? s['sessionTitle'] : null;
      const mcodeSid = typeof s['mcodeSessionId'] === 'string' ? s['mcodeSessionId'] : null;
      update(sid, (prev) => {
        const parsed = chat ? chatLinesToMessages(chat) : null;
        const messages = parsed ? parsed.messages : prev.messages;
        if (runningNow && messages.length > 0) {
          const last = messages[messages.length - 1];
          messages[messages.length - 1] = { ...last, streaming: true };
        }
        return {
          ...prev,
          summary:
            title != null || mcodeSid != null
              ? {
                  id: sid,
                  title: title ?? prev.summary?.title ?? '',
                  workspace: prev.summary?.workspace ?? null,
                  mcodeSessionId: mcodeSid ?? prev.summary?.mcodeSessionId ?? null,
                  titleCustom: prev.summary?.titleCustom ?? false,
                  updatedAt: prev.summary?.updatedAt ?? Date.now(),
                }
              : prev.summary,
          messages,
          todos: parsed && parsed.todos.length > 0 ? parsed.todos : prev.todos,
          running: runningNow,
          plan: planO ? mapPlanState(planO) : prev.plan,
          goal: goalO ? mapGoalState(goalO) : prev.goal,
          context: ctxO ? mapContextUsage(ctxO) : prev.context,
          workspace: wsO ? mapWorkspaceInfo(wsO) : prev.workspace,
          selection:
            modelO && typeof modelO['name'] === 'string' && modelO['name'] !== ''
              ? { ...prev.selection, model: modelO['name'] }
              : prev.selection,
        };
      });
      return sid;
    },

    store: storeFor,
    update,
    ids(): SessionId[] {
      return [...slices.keys()];
    },
  };
}
