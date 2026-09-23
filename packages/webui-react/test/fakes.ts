/**
 * test/fakes.ts —— feature 容器 / controller 测试共用的 fake Registry 与夹具。
 * ============================================================================
 * 只依赖 contracts/ 的端口与领域类型 + features/app-controller（组装出 AppController）。
 * 不 import 任何 core 实现 —— 全部端口用 vi.fn() 假实现，离线可重复。
 *
 * 设计要点：
 *   - makeHarness() 造一套 Registry + 由它组装的 AppController，二者共用同一 reg，
 *     因此 <RegistryProvider value={h.reg}> 与 controller 看到的是同一份端口（可断言）。
 *   - 会话切片 slice(id) 可直接改（messages / running / attachments…），供容器读取。
 *   - 会话列表、授权队列可控；notifier.confirm / chat.send / chat.command /
 *     upload.upload / auth.decide / sessions.remove 全是 vi.fn() 便于断言调用路径。
 * ============================================================================
 */
import { vi } from 'vitest';

import type {
  AuthServicePort,
  ChatServicePort,
  HttpPort,
  ModelServicePort,
  NotifierPort,
  Registry,
  SessionServicePort,
  UploadServicePort,
} from '../src/contracts/ports';
import type {
  PendingAuth,
  SessionId,
  SessionSlice,
  SessionSummary,
} from '../src/contracts/domain';
import { createAppController } from '../src/features/app-controller';

const NOOP = (): void => { /* noop */ };

/** 一条会话摘要夹具（Partial 覆盖）。 */
export function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    title: '会话一',
    workspace: '/w1',
    mcodeSessionId: null,
    titleCustom: false,
    updatedAt: 1,
    ...over,
  };
}

/** 一条待授权请求夹具（expiresAt 默认 60s 后 → 倒计时 01:00）。 */
export function pendingAuth(over: Partial<PendingAuth> = {}): PendingAuth {
  return {
    requestId: 'r1',
    action: 'bash',
    ctx: {},
    expiresAt: Date.now() + 60_000,
    receivedAt: Date.now(),
    ...over,
  };
}

function emptySlice(id: SessionId): SessionSlice {
  return {
    id,
    summary: null,
    messages: [],
    inflightId: null,
    running: false,
    selection: { provider: 'minimax_api', model: 'minimax_api/MiniMax-M3', thinking: 'medium' },
    context: null,
    workspace: null,
    todos: [],
    goal: null,
    attachments: [],
  };
}

export interface HarnessOptions {
  sessions?: SessionSummary[];
  authQueue?: PendingAuth[];
  /** 预置某个会话切片的字段（messages / running / attachments…）。 */
  slices?: Record<SessionId, Partial<SessionSlice>>;
}

/** 造一套 fake Registry + 由它组装的 AppController（二者共用同一 reg）。 */
export function makeHarness(opts: HarnessOptions = {}) {
  const sessionList: SessionSummary[] = [...(opts.sessions ?? [])];
  const slices = new Map<SessionId, SessionSlice>();
  const subs = new Map<SessionId, Set<() => void>>();
  let authQueue: PendingAuth[] = [...(opts.authQueue ?? [])];

  const slice = (id: SessionId): SessionSlice => {
    let s = slices.get(id);
    if (!s) {
      s = emptySlice(id);
      slices.set(id, s);
    }
    return s;
  };
  for (const [id, patch] of Object.entries(opts.slices ?? {})) {
    Object.assign(slice(id), patch);
  }

  const confirm = vi.fn(async (_title: string, _body: string): Promise<boolean> => true);
  const toast = vi.fn(NOOP);
  const chatSend = vi.fn(async (_id: SessionId, _content: string, _refs?: string[]): Promise<void> => { /* noop */ });
  const chatCommand = vi.fn(async (_id: SessionId, _cmd: string): Promise<void> => { /* noop */ });
  const chatStop = vi.fn(async (_id: SessionId): Promise<void> => { /* noop */ });
  const upload = vi.fn(async (file: Blob, name: string) => ({
    id: 'att-1',
    name,
    path: '/uploads/' + name,
    size: file.size,
    status: 'done' as const,
  }));
  const authDecide = vi.fn(async (_requestId: string, _approve: boolean): Promise<void> => { /* noop */ });
  const sessionRemove = vi.fn(async (_id: SessionId): Promise<void> => { /* noop */ });

  const notifier: NotifierPort = { toast, confirm };
  const chat: ChatServicePort = { send: chatSend, stop: chatStop, command: chatCommand };
  const auth: AuthServicePort = {
    pending: () => [...authQueue],
    decide: authDecide,
    subscribe: () => NOOP,
  };
  const uploadService: UploadServicePort = { upload };
  const sessions: SessionServicePort = {
    list: async () => [...sessionList],
    create: async () => {
      const id = 's' + (sessionList.length + 1);
      sessionList.push(session({ id, title: 'T' + id }));
      return id;
    },
    switchTo: async () => { /* noop */ },
    rename: async () => { /* noop */ },
    remove: sessionRemove,
    slice,
    subscribe: (id, listener) => {
      let set = subs.get(id);
      if (!set) {
        set = new Set();
        subs.set(id, set);
      }
      set.add(listener);
      return () => { set.delete(listener); };
    },
  };
  const models: ModelServicePort = {
    providers: async () => [{ id: 'minimax_api', label: 'MiniMax' }],
    models: async () => [{ id: 'minimax_api/MiniMax-M3', label: 'MiniMax-M3', provider: 'minimax_api' }],
    current: (id) => slice(id).selection,
    setProvider: async (id, p) => { slice(id).selection = { ...slice(id).selection, provider: p }; return slice(id).selection; },
    setModel: async (id, m) => { slice(id).selection = { ...slice(id).selection, model: m }; return slice(id).selection; },
    setThinking: async (id, e) => { slice(id).selection = { ...slice(id).selection, thinking: e }; return slice(id).selection; },
  };

  const reg: Registry = {
    clock: { now: () => Date.now() },
    http: {
      get: async () => ({}),
      post: async () => ({}),
      del: async () => ({}),
      upload: async () => ({}),
    } as unknown as HttpPort,
    stream: { connect: NOOP, close: NOOP, send: NOOP, onFrame: () => NOOP, status: () => 'open' as const },
    kv: { get: () => null, set: NOOP, remove: NOOP },
    notifier,
    sessions,
    chat,
    models,
    workspace: {
      current: () => null,
      use: async () => ({ dir: '/w' }),
      reset: async () => ({ dir: null }),
      browse: async () => [],
      recents: () => [],
      addRecent: NOOP,
    },
    settings: {
      get: async () => ({}),
      update: async () => ({}),
      resetToken: async () => ({ token: 't' }),
      acknowledgeToken: async () => { /* noop */ },
    },
    usage: {
      quota: async () => ({ fiveHourPercent: 50, weeklyPercent: 50, fetchedAt: 1 }),
      refresh: async () => { /* noop */ },
      context: async () => null,
    },
    alerts: {
      snapshot: async () => [],
      list: () => [],
      unread: () => 0,
      markRead: NOOP,
      clear: NOOP,
      subscribe: () => NOOP,
    },
    auth,
    upload: uploadService,
  };

  const controller = createAppController(reg);

  return {
    reg,
    controller,
    // 端口侧 spy（断言调用路径）
    confirm,
    toast,
    chatSend,
    chatCommand,
    chatStop,
    upload,
    authDecide,
    sessionRemove,
    // 控制面
    slice,
    setAuthQueue(next: PendingAuth[]): void {
      authQueue = [...next];
    },
  };
}

export type Harness = ReturnType<typeof makeHarness>;
