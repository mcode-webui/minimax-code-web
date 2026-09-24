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
  ContextUsage,
  EnterPlanModeState,
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
import type { PermissionModeCatalog, Registry } from '../contracts/ports';
import type { SessionService } from '../core/services/session-service';
import type { SlashEntry } from '../ui/composer/SlashOverlay';

export type ThemeMode = 'light' | 'dark';
export type Lang = 'zh' | 'en';

export interface AppSnapshot {
  ready: boolean;
  activeSessionId: SessionId | null;
  sessions: SessionSummary[];
  groups: SessionGroup[];
  /** 按 searchQuery 过滤后的分组（列表渲染用这个，不要用 groups）。 */
  filteredGroups: SessionGroup[];
  /** 当前会话的输入草稿 —— 按 SessionId 隔离，切会话各自保留。 */
  draft: string;
  /** 当前会话的 ask-user 勾选态（blockId -> 选中的 optionId 列表），按会话隔离。 */
  askSelections: Record<string, string[]>;
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
  /** 服务端可用斜杠命令目录（state.availableCommands 派生）；空则容器用内置兜底表。 */
  slashEntries: SlashEntry[];
  /** mcode 请求进入 plan 模式（state.enterPlanMode 直读）；应答后服务端清空。 */
  enterPlanMode: EnterPlanModeState | null;
  /** 当前权限模式标签（state.permissions，如 "Full access"）。 */
  permissionLabel: string;
}

export interface AppActions {
  // 会话
  newChat(workspace?: string | null): Promise<void>;
  selectSession(id: SessionId): Promise<void>;
  renameSession(id: SessionId, title: string): Promise<void>;
  deleteSession(id: SessionId): Promise<void>;
  refreshSessions(): Promise<void>;
  // 对话
  /** 发送文本；无参则发当前会话草稿。以 '/' 开头会自动路由到 sendCommand。 */
  send(content?: string): Promise<void>;
  stop(): Promise<void>;
  sendCommand(cmd: string): Promise<void>;
  /** 写当前会话草稿（按 SessionId 隔离，互不覆盖）。 */
  setDraft(text: string): void;
  // ask-user 块的受控交互
  sendAskOptionToggle(blockId: string, optionId: string): void;
  sendAskConfirm(blockId: string, optionIds: string[]): void;
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
  // 模式互动：plan / planmode 应答 + 权限模式（新增接缝）
  /** 应答方案弹窗；agree/add 的后续话术由 UI 层经 send 下发（本地化不属于控制器）。 */
  answerPlan(option: 'agree' | 'skip' | 'add', context?: string): Promise<void>;
  /** 应答「进入 plan 模式？」；服务端置 planMode 并清 enterPlanMode。 */
  answerPlanMode(choice: 'continue' | 'deny'): Promise<void>;
  /** 权限模式目录（下拉选项）。 */
  permissionModes(): Promise<PermissionModeCatalog>;
  /** 切换权限模式（服务端同步 UI 标签）。 */
  setPermissionMode(mode: string): Promise<void>;
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

/** GET /api/settings 与 state 快照里扁平摆放的设置字段（同名对齐 WireSettings）。 */
const SETTINGS_WIRE_KEYS = [
  'lanBroadcast', 'lanBind', 'readOnly', 'tokenEnabled', 'currentToken',
  'tokenAcknowledged', 'tokenRotatedAt', 'lanIp', 'lanUrl', 'lanUrlWithToken',
  'localUrl', 'lanExposed', 'bindRestartPending', 'lanExposureNotice',
  'trustedOrigins', 'defaultModel', 'defaultWorkspace', 'mcodeCmd', 'mcodeVersion',
  'port', 'host', 'bindHost', 'quotaEnabled', 'hasTokenPlanKey',
  'tokenPlanApiKeyMasked', 'tokenPlanApiKeySource', 'tokenPlanApiKeyFilePath',
] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** weekly 可能是 91 / "91%" / "unlimited" —— 一律收窄为百分比或 null。 */
function weeklyPercentOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim().replace(/%$/, '');
    if (t === '' || t.toLowerCase() === 'unlimited') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function createAppController(reg: Registry): AppController {
  const listeners = new Set<() => void>();
  // 快照记忆化 —— 这是 useSyncExternalStore 的硬性要求：状态未变时必须返回
  // **同一个引用**。若每次 snapshot() 都新建对象，React 会认为状态一直在变，
  // 触发「Maximum update depth exceeded」无限重渲染（React #185）。
  let cachedSnapshot: AppSnapshot | null = null;
  const notify = () => {
    cachedSnapshot = null; // 先作废缓存，再通知订阅者重取
    for (const l of listeners) l();
  };

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
  let slashEntries: SlashEntry[] = [];
  // 模式互动（per-cid，不按会话隔离）：mcode 请求进入 plan 模式 + 权限标签。
  let enterPlanMode: EnterPlanModeState | null = null;
  let permissionLabel = '';
  // 会话隔离的输入草稿：切会话各自保留，绝不共享同一份缓冲。
  const drafts = new Map<SessionId, string>();
  // ask-user 选项的勾选态，同样按会话隔离。
  const askSelections = new Map<SessionId, Record<string, string[]>>();

  const activeSlice = (): SessionSlice | null =>
    activeSessionId ? reg.sessions.slice(activeSessionId) : null;

  /** 按搜索词过滤：命中标题或工作区路径即保留；空词不过滤。纯派生，无 IO。 */
  function filtered(list: SessionSummary[], query: string): SessionSummary[] {
    const q = query.trim().toLowerCase();
    if (q === '') return list;
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.workspace ?? '').toLowerCase().includes(q),
    );
  }

  function snapshot(): AppSnapshot {
    if (cachedSnapshot) return cachedSnapshot;
    const slice = activeSlice();
    const groups = groupSessionsByWorkspace(sessions);
    const built: AppSnapshot = {
      ready,
      activeSessionId,
      sessions,
      groups,
      filteredGroups: groupSessionsByWorkspace(filtered(sessions, searchQuery)),
      draft: activeSessionId ? (drafts.get(activeSessionId) ?? '') : '',
      askSelections: activeSessionId ? (askSelections.get(activeSessionId) ?? {}) : {},
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
      enterPlanMode,
      permissionLabel,
      slashEntries,
    };
    cachedSnapshot = built;
    return built;
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

    setDraft(text) {
      if (!activeSessionId) return;
      // 每个会话一份草稿 —— 切走再切回，输入内容原样还在。
      drafts.set(activeSessionId, text);
      notify();
    },

    sendAskOptionToggle(blockId, optionId) {
      const id = activeSessionId;
      if (!id) return;
      const perBlock = askSelections.get(id) ?? {};
      const cur = perBlock[blockId] ?? [];
      perBlock[blockId] = cur.includes(optionId)
        ? cur.filter((x) => x !== optionId)
        : [...cur, optionId];
      askSelections.set(id, perBlock);
      notify();
    },

    sendAskConfirm(blockId, optionIds) {
      const id = activeSessionId;
      if (!id) return;
      const perBlock = askSelections.get(id) ?? {};
      perBlock[blockId] = optionIds;
      askSelections.set(id, perBlock);
      notify();
    },

    async send(content) {
      const id = activeSessionId;
      if (!id) return;
      // 斜杠命令与普通消息分流：'/' 开头走 /api/cmd，否则走 /api/send。
      const text = (content ?? drafts.get(id) ?? '').trim();
      if (text === '') return;
      drafts.delete(id);
      if (text.startsWith('/')) {
        await reg.chat.command(id, text);
        notify();
        return;
      }
      const slice = reg.sessions.slice(id);
      const refs = slice.attachments.filter((a) => a.status === 'done').map((a) => '@' + a.path);
      // 用户消息的回显统一归 chat-service（它会 append 一条并置 inflightId）。
      // 控制器这里再 push 一条会导致用户消息渲染两遍。
      slice.attachments = [];
      notify();
      await reg.chat.send(id, text, refs);
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

    async answerPlan(option, context) {
      await reg.interact.answerPlan(option, context);
      // 应答已生效（服务端清 plan 并广播 state）——本地无需再改切片。
    },
    async answerPlanMode(choice) {
      await reg.interact.answerPlanMode(choice);
    },
    permissionModes() {
      return reg.interact.permissionModes();
    },
    async setPermissionMode(mode) {
      await reg.interact.setPermissionMode(mode);
      // 标签经下一次 state 推送回流（POST /api/permissions 会 pushStateFor）。
    },

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

  // ── 服务端状态同步（消息展示 / 切会话内容）──────────────────────────────
  /**
   * GET /api/state 基线与 state.snapshot 帧同构。chat 只属于 state.sessionId
   * 那个会话 —— 切片写入由 SessionService.hydrateFromWireState 按 state.sessionId
   * 落位（绝不串会话），这里只补控制器级的会话列表 / 用量 / 上下文变量。
   */
  function applyWireState(raw: unknown): void {
    const s = asRecord(raw);
    if (!s) return;
    let changed = false;

    const rows = Array.isArray(s['sessions']) ? s['sessions'] : null;
    if (rows) {
      const list: SessionSummary[] = [];
      for (const r of rows) {
        const o = asRecord(r);
        if (!o || typeof o['id'] !== 'string' || o['id'] === '') continue;
        list.push({
          id: o['id'],
          title: typeof o['title'] === 'string' ? o['title'] : '',
          workspace: typeof o['workspace'] === 'string' ? o['workspace'] : null,
          mcodeSessionId: typeof o['mcodeSessionId'] === 'string' ? o['mcodeSessionId'] : null,
          titleCustom: o['titleCustom'] === true,
          updatedAt: Number(o['updatedAt']) || Number(o['createdAt']) || 0,
        });
      }
      sessions = list;
      changed = true;
    }

    const impl = reg.sessions as Partial<SessionService>;
    const sid = typeof s['sessionId'] === 'string' && s['sessionId'] !== '' ? s['sessionId'] : null;
    if (sid && typeof impl.hydrateFromWireState === 'function') {
      impl.hydrateFromWireState(raw);
      // 初始采纳服务端当前会话；之后本地点选优先（selectSession 自己走 switch）。
      if (activeSessionId === null) {
        activeSessionId = sid;
        resubscribeSession();
      }
      const slice = reg.sessions.slice(sid);
      if (sid === activeSessionId) context = slice.context;
      if (slice.workspace) workspace = slice.workspace;
      changed = true;
    }

    const usageO = asRecord(s['usage']);
    if (usageO) {
      usage = {
        fiveHourPercent: numOrNull(usageO['fiveHourPercent'] ?? usageO['remaining']),
        weeklyPercent: weeklyPercentOf(usageO['weeklyPercent'] ?? usageO['weekly']),
        fetchedAt: numOrNull(usageO['fetchedAt']),
      };
      changed = true;
    }

    // 斜杠命令目录：服务端 availableCommands（local / mcode 两组）→ 面板条目。
    const cmdsO = asRecord(s['availableCommands']);
    if (cmdsO) {
      const entries: SlashEntry[] = [];
      const add = (list: unknown): void => {
        if (!Array.isArray(list)) return;
        for (const c of list) {
          const o = asRecord(c);
          if (!o || typeof o['name'] !== 'string' || o['name'] === '') continue;
          const name = o['name'].startsWith('/') ? o['name'] : '/' + o['name'];
          entries.push({
            id: 'cmd:' + name,
            cmd: name,
            desc: typeof o['description'] === 'string' ? o['description'] : '',
            kind: 'cmd',
          });
        }
      };
      add(cmdsO['local']);
      add(cmdsO['mcode']);
      if (entries.length > 0) {
        slashEntries = entries;
        changed = true;
      }
    }

    // 模式互动（per-cid）：enterPlanMode 直读（应答后服务端清空 → null，
    // PlanModeModal 随之关闭）；permissions 是标签字符串（如 "Full access"）。
    const epmO = asRecord(s['enterPlanMode']);
    if (epmO) {
      enterPlanMode = {
        active: epmO['active'] === true,
        prompt: typeof epmO['prompt'] === 'string' ? epmO['prompt'] : null,
      };
      changed = true;
    }
    if (typeof s['permissions'] === 'string') {
      permissionLabel = s['permissions'];
      changed = true;
    }

    // 设置字段在 state 里扁平摆放（与 /api/settings 同名）——合入 settings。
    // POST /api/settings 会广播 state，多标签页 / 外部改动借此同步到界面。
    const flat: Record<string, unknown> = {};
    let hasFlat = false;
    for (const key of SETTINGS_WIRE_KEYS) {
      if (key in s) {
        flat[key] = s[key];
        hasFlat = true;
      }
    }
    if (hasFlat) {
      settings = { ...(settings ?? {}), ...flat };
      changed = true;
    }

    if (changed) notify();
  }

  // 基线 GET /api/state + 增量 state.snapshot 帧。这里也是 /api/stream 的唯一连接点：
  // 授权弹窗（needs_authorization —— 删除会话 / token 重置走 authorize 门）、告警、
  // 状态推送全依赖这条流；不连接则删除等操作会一直挂到超时被拒。
  subDeps.push(
    reg.stream.onFrame((raw) => {
      const f = asRecord(raw);
      if (f && f['type'] === 'state.snapshot') applyWireState(f['payload']);
    }),
  );
  reg.stream.connect();
  void reg.http
    .get('/api/state')
    .then((state) => applyWireState(state))
    .catch(() => { /* 基线拉取失败不阻塞 —— 流帧会补齐 */ });

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
