/**
 * contracts/domain.ts —— 领域契约（domain contract）
 * ============================================================================
 * 【这是"咬合面"的第二半】定义 UI 与 core 之间共用的**领域对象**。
 *
 * 规则（高内聚低耦合）：
 *   1. ui/ 只 import 本文件（+ ports.ts），**禁止** import protocol.ts / core 实现。
 *   2. core/ 把 protocol.ts 的不可信 wire 数据翻译成本文件的对象后再上抛。
 *   3. 一切按 sessionId 切片存放 —— 这是"会话隔离显示"的结构性保证：
 *      不同会话的消息、流式缓冲、上下文、模型/思考强度互不串扰。
 *   4. 本文件只放类型 + 纯函数（归一化/派生），不放 IO、不放 React。
 * ============================================================================
 */

// ── 标识 ───────────────────────────────────────────────────────────────────
export type SessionId = string;
export type Cid = string;

// ── 供应商 / 模型 / 思考强度（新增能力：可换供应商、模型、思考强度）──────────
/** 供应商 id，例如 'minimax_api' | 'openai' | 'anthropic' | … */
export type ProviderId = string;

export interface ProviderOption {
  id: ProviderId;
  label: string;
  /** 该供应商下模型为空时给用户的提示（例如指向 mcode TUI 配置）。 */
  hint?: string;
}

export interface ModelOption {
  /** 全限定 id：<provider>/<model>，例如 'minimax_api/MiniMax-M3'。 */
  id: string;
  label: string;
  provider: ProviderId;
  /** 上下文窗口（token）；0 表示未知。 */
  contextLimit?: number;
}

/** 模型目录的供应商分组（/api/models groups —— 目录按供应商分组返回）。 */
export interface ModelGroup {
  id: ProviderId;
  label: string;
  models: ModelOption[];
}

/** 思考强度 —— 映射到各家 reasoning effort。 */
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['off', 'low', 'medium', 'high', 'max'];

export interface ModelSelection {
  provider: ProviderId;
  /** 全限定 id。 */
  model: string;
  thinking: ThinkingEffort;
}

// ── 工作区 ─────────────────────────────────────────────────────────────────
export interface WorkspaceInfo {
  dir: string | null;
  branch?: string | null;
  tree?: string | null;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** 最近/已有工作区条目（在 WorkspaceEntry 上附加会话数角标与服务端聚合时间）。 */
export interface WorkspaceRecentEntry extends WorkspaceEntry {
  sessionCount?: number;
  lastActiveAt?: number;
}

/** 服务端目录浏览结果：当前目录 + 上级目录（供「上一级」导航）+ 子目录列表。 */
export interface WorkspaceBrowseResult {
  dir: string | null;
  parent: string | null;
  entries: WorkspaceEntry[];
}

// ── 文件系统（右栏文件树 / 文档预览）────────────────────────────────────────

/** /api/fs/read 条目（文件树懒加载节点）。 */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** 字节大小（文件）。 */
  size?: number;
  /** 修改时间（毫秒）。 */
  mtime?: number;
  /** 权限字符串（如 rwxr-xr-x）。 */
  mode?: string;
}

/** /api/fs/read 结果。 */
export interface FsListResult {
  ok: boolean;
  dir: string | null;
  parent: string | null;
  entries: FsEntry[];
  /** 服务端主目录（readDirectory 回传）—— 面包屑/顶层判定用。 */
  home?: string | null;
  error?: string;
}

/** /api/fs/file 结果（文本文件内容；≤512KB，二进制拒读）。 */
export interface FsFileResult {
  ok: boolean;
  path: string | null;
  content: string | null;
  size?: number;
  error?: string;
}

// ── git（右栏 Git 面板：变更 / 分支 / diff）─────────────────────────────────

/** 单个变更文件（porcelain v1 的 XY + 路径）。 */
export interface GitFileChange {
  /** 暂存区状态（M/A/D/R/…；' ' = 无）。 */
  x: string;
  /** 工作区状态。 */
  y: string;
  path: string;
  /** 重命名前的原路径。 */
  origPath?: string | null;
  /** 是否已暂存。 */
  staged: boolean;
}

/** /api/git/status 结果；isRepo=false 表示目录不是 git 仓库。 */
export interface GitStatus {
  ok: boolean;
  isRepo: boolean;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  files: GitFileChange[];
  error?: string;
}

/** 本地分支。 */
export interface GitBranch {
  name: string;
  current: boolean;
}

/** /api/git/branches 结果。 */
export interface GitBranches {
  ok: boolean;
  branches: GitBranch[];
  error?: string;
}

// ── 会话 ───────────────────────────────────────────────────────────────────
export interface SessionSummary {
  id: SessionId;
  title: string;
  workspace: string | null;
  mcodeSessionId: string | null;
  titleCustom: boolean;
  updatedAt: number;
}

/** 按工作区分组（左侧栏的折叠分组）。 */
export interface SessionGroup {
  /** 分组键：工作区路径，空串表示"无工作区"。 */
  key: string;
  label: string;
  sessions: SessionSummary[];
}

// ── 消息与结构化块 ─────────────────────────────────────────────────────────
export type Role = 'user' | 'assistant' | 'system';

export type BlockKind =
  | 'text'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'plan'
  | 'ask-user'
  | 'error';

export interface MessageBlockBase {
  id: string;
  kind: BlockKind;
}

export interface TextBlock extends MessageBlockBase { kind: 'text'; text: string; markdown?: boolean }
export interface ThinkingBlock extends MessageBlockBase { kind: 'thinking'; text: string; done?: boolean }
export interface ToolCallBlock extends MessageBlockBase {
  kind: 'tool-call';
  toolName: string;
  args?: unknown;
  status: 'running' | 'done' | 'error';
  summary?: string;
}
export interface ToolResultBlock extends MessageBlockBase { kind: 'tool-result'; ok: boolean; text: string }
export interface PlanBlock extends MessageBlockBase {
  kind: 'plan';
  title: string;
  steps: string[];
  status: 'pending' | 'agreed' | 'skipped';
}
export interface AskUserBlock extends MessageBlockBase {
  kind: 'ask-user';
  question: string;
  options: AskUserOption[];
  multiSelect: boolean;
  answered?: boolean;
}
export interface ErrorBlock extends MessageBlockBase { kind: 'error'; text: string }

export type MessageBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | PlanBlock
  | AskUserBlock
  | ErrorBlock;

export interface ChatMessage {
  id: string;
  role: Role;
  blocks: MessageBlock[];
  ts: number;
  /** 是否仍在流式生成中。 */
  streaming?: boolean;
}

export interface AskUserOption {
  id: string;
  label: string;
  desc?: string;
}

// ── 右栏状态 ───────────────────────────────────────────────────────────────
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoItem { id: string; content: string; status: TodoStatus }

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';
export interface GoalState {
  objective: string;
  phase: GoalPhase;
  rounds: number;
  startedAt?: number;
}

// ── 模式互动（wire state.plan / state.enterPlanMode 直读）──────────────────
/** plan_update 推送的方案选项条目（wire state.plan.options）。 */
export interface PlanOption {
  label: string;
  desc: string;
}

/**
 * 服务端 plan 状态（plan_update / plan_removed 维护）。
 * 应答（POST /api/answer type=plan）后服务端清空 → null，弹窗随之关闭。
 */
export interface PlanState {
  active: boolean;
  planId: string | null;
  title: string;
  summary: string;
  options: PlanOption[];
}

/** mcode 请求进入 plan 模式（mode_update → state.enterPlanMode）。 */
export interface EnterPlanModeState {
  active: boolean;
  prompt: string | null;
}

export interface ContextUsage {
  used: number;
  limit: number;
  percent: number;
  tps: number;
  cacheRead?: number;
  model?: string;
  source?: string;
}

// ── 会话隔离切片：每个 sessionId 一份，互不串扰 ─────────────────────────────
export interface SessionSlice {
  id: SessionId;
  summary: SessionSummary | null;
  messages: ChatMessage[];
  /**
   * 正在流式接收的 **assistant 占位消息** 的 id。
   *
   * 语义约束（务必遵守）：
   *   - 只能指向 assistant 侧的未定稿消息；**绝不**指向用户消息 ——
   *     用户消息一发出去即已定稿。
   *   - 由流式翻译层在创建 assistant 占位块时置入，在定稿/停止时清空。
   *   - null 表示该会话无未定稿输出。
   *   - 仅描述本会话，绝不跨会话共享。
   *
   * 判断「会话是否在跑」请用 {@link SessionSlice.running}，不要用 inflightId。
   */
  inflightId: string | null;
  running: boolean;
  /** 每会话独立的模型/供应商/思考强度选择。 */
  selection: ModelSelection;
  context: ContextUsage | null;
  workspace: WorkspaceInfo | null;
  todos: TodoItem[];
  goal: GoalState | null;
  /** wire state.plan 直读（plan_update 事件维护）；应答后服务端清空 → null。 */
  plan: PlanState | null;
  attachments: Attachment[];
}

export interface Attachment {
  id: string;
  name: string;
  /** 服务端返回的绝对路径（已 @ 引用）。 */
  path: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

// ── 套餐用量 ───────────────────────────────────────────────────────────────
export interface UsageInfo {
  fiveHourPercent: number | null;
  weeklyPercent: number | null;
  fetchedAt: number | null;
  source?: string;
  hidden?: boolean;
}

// ── 授权弹窗队列项 ─────────────────────────────────────────────────────────
export interface PendingAuth {
  requestId: string;
  action: string;
  ctx: Record<string, unknown>;
  expiresAt: number;
  receivedAt: number;
}

// ── 异常通道 ───────────────────────────────────────────────────────────────
export interface AlertItem {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
  src: string;
  sessionId: string | null;
  count: number;
}

// ── 纯派生函数（无 IO）─────────────────────────────────────────────────────
/** 按工作区把会话列表分组并按更新时间倒序 —— 左栏渲染的唯一排序来源。 */
export function groupSessionsByWorkspace(sessions: SessionSummary[]): SessionGroup[] {
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = s.workspace ?? '';
    const arr = map.get(key);
    if (arr) arr.push(s);
    else map.set(key, [s]);
  }
  const groups: SessionGroup[] = [];
  for (const [key, list] of map) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    groups.push({ key, label: key || '（无工作区）', sessions: list });
  }
  groups.sort((a, b) => (a.sessions[0]?.updatedAt ?? 0) - (b.sessions[0]?.updatedAt ?? 0));
  groups.reverse();
  return groups;
}

/** 从全限定模型 id 拆出供应商；无 '/' 时回落到 fallback。 */
export function splitModelId(id: string, fallback: ProviderId = 'minimax_api'): ModelSelection['provider'] {
  return id.includes('/') ? id.split('/')[0] : fallback;
}

/** 构造一个空的会话隔离切片。 */
export function emptySessionSlice(id: SessionId, selection: ModelSelection): SessionSlice {
  return {
    id,
    summary: null,
    messages: [],
    inflightId: null,
    running: false,
    // 关键：必须复制一份 —— 若按引用存入，两个会话切片会共享同一个模型选择
    // 对象，改 A 会话的供应商/模型/思考强度会串到 B 会话（会话隔离被破坏）。
    selection: { ...selection },
    context: null,
    workspace: null,
    todos: [],
    goal: null,
    plan: null,
    attachments: [],
  };
}
