/**
 * features/app-controller.ts —— 咬合枢纽（the mesh hub）
 * ============================================================================
 * 【这是整套设计里最关键的一个文件】ui/ 与 core/ 在这里唯一地咬合。
 *
 *   ui/   ──(只收 props)──┐
 *                          ├──> 本文件：把端口翻译成快照 + 动作
 *   core/ ──(只走 Port)────┘
 *
 * 【高内聚】本文件只做编排：不渲染、不发 HTTP、不碰 WebSocket 细节 —— 那些
 *   全在 core 的端口实现里。它把 N 个窄端口聚合成 1 个面向视图的宽接口，
 *   因此 ui 层的每个组件都只需要自己那一小撮 props（低耦合）。
 * 【会话隔离】所有会话相关的读写都经 activeSession() 取到对应切片，绝不共享
 *   跨会话的可变状态 —— 这是本次修复的核心诉求。
 * 【热插拔】只依赖 contracts/ports.ts 的接口。换供应商/换传输 = 换 Registry
 *   里的一个实现，本文件零改动。
 * ============================================================================
 */

import type {
  AlertItem,
  Attachment,
  ChatMessage,
  ContextUsage,
  ModelSelection,
  PendingAuth,
  ProviderOption,
  ModelOption,
  SessionGroup,
  SessionId,
  SessionSlice,
  SessionSummary,
  ThinkingEffort,
  UsageInfo,
  WorkspaceEntry,
  WorkspaceInfo,
} from '../contracts/domain';
import { groupSessionsByWorkspace } from '../contracts/domain';
import type { WireSettings } from '../contracts/protocol';
import type { Registry } from '../contracts/ports';

export type ThemeMode = 'light' | 'dark';
export type Lang = 'zh' | 'en';

export interface AppSnapshot {
  ready: boolean;
  activeSessionId: SessionId | null;
  sessions: SessionSummary[];
  groups: SessionGroup[];
  /** 当前会话的隔离切片；无会话时为 null。 */
  slice: SessionSlice | null;
  providers: ProviderOption[];
  models: ModelOption[];
  selection: ModelSelection | null;
  settings: WireSettings | null;
  usage: UsageInfo | null;
  context: ContextUsage | null;
  alerts: AlertItem[];
  alertsUnread: number;
  authQueue: PendingAuth[];
  workspace: WorkspaceInfo | null;
  recents: WorkspaceEntry[];
  theme: ThemeMode;
  lang: Lang;
  leftOpen: boolean;
  rightOpen: boolean;
  searchQuery: string;
  collapsedGroups: string[];
}

export interface AppActions {
  // 会话
  newChat(workspace?: string | null): Promise<void>;
  selectSession(id: SessionId): Promise<void>;
  renameSession(id: SessionId, title: string): Promise<void>;
  deleteSession(id: SessionId): Promise<void>;
  refreshSessions(): Promise<void>;
  // 对话
  send(content: string): Promise<void>;
  stop(): Promise<void>;
  sendCommand(cmd: string): Promise<void>;
  // 模型三段式（本次新增能力）
  setProvider(provider: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setThinking(effort: ThinkingEffort): Promise<void>;
  submitCustomModel(expr: string): Promise<void>;
  // 工作区
  useWorkspace(dir: string): Promise<void>;
  resetWorkspace(): Promise<void>;
  browseWorkspace(path?: string): Promise<WorkspaceEntry[]>;
  // 附件
  uploadFiles(files: File[]): Promise<void>;
  removeAttachment(id: string): void;
  // 设置与用量
  updateSettings(patch: Partial<WireSettings>): Promise<void>;
  resetToken(): Promise<void>;
  acknowledgeToken(): Promise<void>;
  refreshUsage(): Promise<void>;
  // 异常与授权
  markAlertsRead(): void;
  clearAlerts(): void;
  decideAuth(requestId: string, approve: boolean): Promise<void>;
  // 纯 UI 状态
  setTheme(theme: ThemeMode): void;
  setLang(lang: Lang): void;
  setLeftOpen(v: boolean): void;
  setRightOpen(v: boolean): void;
  setSearchQuery(q: string): void;
  toggleGroup(key: string): void;
}

export interface AppController {
  snapshot(): AppSnapshot;
  subscribe(listener: () => void): () => void;
  actions: AppActions;
}

export function createAppController(reg: Registry): AppController {
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) l(); };

  // ── 纯 UI 状态（不进服务端） ────────────────────────────────────────────
  let ready = false;
  let activeSessionId: SessionId | null = null;
  let sessions: SessionSummary[] = [];
  let providers: ProviderOption[] = [];
  let models: ModelOption[] = [];
  let settings: WireSettings | null = null;
  let usage: UsageInfo | null = null;
  let context: ContextUsage | null = null;
  let workspace: WorkspaceInfo | null = null;
  let recents: WorkspaceEntry[] = [];
  let theme: ThemeMode = 'light';
  let lang: Lang = 'zh';
  let leftOpen = false;
  let rightOpen = false;
  let searchQuery = '';
  let collapsedGroups: string[] = [];

  const activeSlice = (): SessionSlice | null =>
    activeSessionId ? reg.sessions.slice(activeSessionId) : null;

  function snapshot(): AppSnapshot {
    const slice = activeSlice();
    return {
      ready,
      activeSessionId,
      sessions,
      groups: groupSessionsByWorkspace(sessions),
      slice,
      providers,
      models,
      selection: slice ? slice.selection : null,
      settings,
      usage,
      context,
      alerts: reg.alerts.list(),
      alertsUnread: reg.alerts.unread(),
      authQueue: reg.auth.pending(),
      workspace,
      recents,
      theme,
      lang,
      leftOpen,
      rightOpen,
      searchQuery,
      collapsedGroups,
    };
  }

  // ── 订阅所有会话切片 + 各服务，统一通知 ────────────────────────────────
  const subDeps: Array<() => void> = [];
  subDeps.push(reg.alerts.subscribe(notify));
  subDeps.push(reg.auth.subscribe(notify));
  let sessionSub: (() => void) | null = null;
  function resubscribeSession() {
    if (sessionSub) { sessionSub(); sessionSub = null; }
    if (activeSessionId) sessionSub = reg.sessions.subscribe(activeSessionId, notify);
  }

  async function loadCatalog() {
    try {
      providers = await reg.models.providers();
      models = await reg.models.models();
    } catch {
      providers = [];
      models = [];
    }
  }

  async function bootstrap() {
    try { sessions = await reg.sessions.list(); } catch { sessions = []; }
    await loadCatalog();
    try { settings = await reg.settings.get(); } catch { settings = null; }
    try { usage = await reg.usage.quota(); } catch { usage = null; }
    try { workspace = reg.workspace.current(); recents = reg.workspace.recents(); } catch { /* noop */ }
    ready = true;
    notify();
  }

  const actions: AppActions = {
    async newChat(ws) {
      const id = await reg.sessions.create(ws ?? null);
      activeSessionId = id;
      resubscribeSession();
      await actions.refreshSessions();
    },
    async selectSession(id) {
      if (activeSessionId === id) return;
      activeSessionId = id; // 旧切片原样保留 —— 会话隔离
      resubscribeSession();
      context = null;
      try { await reg.sessions.switchTo(id); } catch { /* 服务端切换失败不阻塞本地隔离 */ }
      try { context = await reg.usage.context(id); } catch { context = null; }
      notify();
    },
    async renameSession(id, title) {
      await reg.sessions.rename(id, title);
      await actions.refreshSessions();
    },
    async deleteSession(id) {
      await reg.sessions.remove(id);
      if (activeSessionId === id) activeSessionId = null;
      resubscribeSession();
      await actions.refreshSessions();
    },
    async refreshSessions() {
      try { sessions = await reg.sessions.list(); } catch { /* 保留旧列表 */ }
      notify();
    },

    async send(content) {
      const id = activeSessionId;
      if (!id) return;
      const slice = reg.sessions.slice(id);
      const refs = slice.attachments.filter((a) => a.status === 'done').map((a) => '@' + a.path);
      const msg: ChatMessage = {
        id: 'u-' + reg.clock.now(),
        role: 'user',
        ts: reg.clock.now(),
        blocks: [{ id: 'b-' + reg.clock.now(), kind: 'text', text: content, markdown: false }],
      };
      reg.sessions.slice(id).messages.push(msg);
      reg.sessions.slice(id).attachments = [];
      notify();
      await reg.chat.send(id, content, refs);
    },
    async stop() {
      if (activeSessionId) await reg.chat.stop(activeSessionId);
    },
    async sendCommand(cmd) {
      if (activeSessionId) await reg.chat.command(activeSessionId, cmd);
    },

    async setProvider(provider) {
      const id = activeSessionId;
      if (!id) return;
      const sel = await reg.models.setProvider(id, provider);
      try { models = await reg.models.models(sel.provider); } catch { models = []; }
      notify();
    },
    async setModel(modelId) {
      const id = activeSessionId;
      if (!id) return;
      await reg.models.setModel(id, modelId);
      notify();
    },
    async setThinking(effort) {
      const id = activeSessionId;
      if (!id) return;
      await reg.models.setThinking(id, effort);
      notify();
    },
    async submitCustomModel(expr) {
      const trimmed = expr.trim();
      if (!trimmed) return;
      const id = activeSessionId;
      if (!id) return;
      await reg.models.setModel(id, trimmed);
      await loadCatalog();
      notify();
    },

    async useWorkspace(dir) {
      workspace = await reg.workspace.use(dir, true);
      reg.workspace.addRecent(dir);
      recents = reg.workspace.recents();
      notify();
    },
    async resetWorkspace() {
      workspace = await reg.workspace.reset();
      notify();
    },
    browseWorkspace(path) {
      return reg.workspace.browse(path);
    },

    async uploadFiles(files) {
      const id = activeSessionId;
      if (!id) return;
      for (const f of files) {
        const localId = 'att-' + reg.clock.now() + '-' + Math.random().toString(36).slice(2, 8);
        const pending: Attachment = { id: localId, name: f.name, path: '', size: f.size, status: 'uploading' };
        reg.sessions.slice(id).attachments.push(pending);
        notify();
        try {
          const done = await reg.upload.upload(f, f.name);
          const arr = reg.sessions.slice(id).attachments;
          const i = arr.findIndex((a) => a.id === localId);
          if (i >= 0) arr[i] = { ...done, id: localId };
        } catch (e) {
          const arr = reg.sessions.slice(id).attachments;
          const i = arr.findIndex((a) => a.id === localId);
          if (i >= 0) arr[i] = { ...pending, status: 'error', error: e instanceof Error ? e.message : String(e) };
        }
        notify();
      }
    },
    removeAttachment(atId) {
      const slice = activeSlice();
      if (!slice) return;
      slice.attachments = slice.attachments.filter((a) => a.id !== atId);
      notify();
    },

    async updateSettings(patch) {
      settings = await reg.settings.update(patch);
      notify();
    },
    async resetToken() {
      await reg.settings.resetToken();
      settings = await reg.settings.get();
      notify();
    },
    async acknowledgeToken() {
      await reg.settings.acknowledgeToken();
      settings = await reg.settings.get();
      notify();
    },
    async refreshUsage() {
      try { await reg.usage.refresh(); } catch { /* noop */ }
      try { usage = await reg.usage.quota(); } catch { /* keep old */ }
      if (activeSessionId) {
        try { context = await reg.usage.context(activeSessionId); } catch { context = null; }
      }
      notify();
    },

    markAlertsRead() { reg.alerts.markRead(); notify(); },
    clearAlerts() { reg.alerts.clear(); notify(); },
    async decideAuth(requestId, approve) { await reg.auth.decide(requestId, approve); notify(); },

    setTheme(t) { theme = t; notify(); },
    setLang(l) { lang = l; notify(); },
    setLeftOpen(v) { leftOpen = v; notify(); },
    setRightOpen(v) { rightOpen = v; notify(); },
    setSearchQuery(q) { searchQuery = q; notify(); },
    toggleGroup(key) {
      collapsedGroups = collapsedGroups.includes(key)
        ? collapsedGroups.filter((k) => k !== key)
        : [...collapsedGroups, key];
      notify();
    },
  };

  void bootstrap();

  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); for (const s of subDeps) s(); };
    },
    actions,
  };
}
