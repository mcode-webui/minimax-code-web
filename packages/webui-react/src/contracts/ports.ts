/**
 * contracts/ports.ts —— 端口契约（port contract）＝ 咬合面的齿轮接口
 * ============================================================================
 * 【这是"咬合面"的第三半】模块之间**只**通过这里的 Port 接口互相依赖。
 *
 * 高内聚低耦合：
 *   - 每个 Port 只描述**一个职责**（一问一答/一条流/一份状态），接口窄而稳。
 *   - 调用方依赖接口，不依赖实现；实现方不 import 调用方。依赖方向单向指向本文件。
 *
 * 热插拔易迭代：
 *   - 所有实现经 core/registry 的 `createRegistry({ ...overrides })` 注入。
 *   - 换供应商 / 换传输 / 换状态库 / 换 UI 提示层，只需提供另一个实现并在组装根替换。
 *   - 单测里注入 fake 实现即可完全离线跑 core 与 features。
 * ============================================================================
 */

import type {
  AlertItem,
  Attachment,
  ContextUsage,
  Cid,
  ModelOption,
  ModelSelection,
  PendingAuth,
  ProviderOption,
  SessionId,
  SessionSummary,
  SessionSlice,
  ThinkingEffort,
  UsageInfo,
  WorkspaceEntry,
  WorkspaceInfo,
  ChatMessage,
} from './domain';
import type { ClientFrame, WireClientState, WireSettings } from './protocol';

// ════════════════════════════════════════════════════════════════════════════
// 1. 基础设施端口（Infra ports）
// ════════════════════════════════════════════════════════════════════════════

/** 时钟 —— 让倒计时/超时可测。 */
export interface ClockPort {
  now(): number;
}

/**
 * 带状态码的 HTTP 错误。HttpPort 的实现在非 2xx / ok:false 时抛出它，
 * 调用方可按 status 分支（例如授权决定的 404 = 已在别处决定）。
 * 实现方也可以抛普通 Error；调用方应做鸭子类型兜底。
 */
export interface HttpError extends Error {
  status?: number;
  code?: string;
}

/** HTTP 传输。只负责"发请求拿 JSON"，不含任何端点语义。 */
export interface HttpPort {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  upload<T = unknown>(path: string, file: Blob, name: string): Promise<T>;
}

/** WebSocket 事件流传输。断线重连 + resume 由实现负责。 */
export interface StreamPort {
  /** 建立连接（幂等：重复调用不会产生第二条连接）。 */
  connect(): void;
  /** 主动断开并停止重连。 */
  close(): void;
  send(frame: ClientFrame): void;
  /** 订阅底层帧；返回退订函数。 */
  onFrame(listener: (raw: unknown) => void): () => void;
  /** 连接状态，用于顶栏指示灯。 */
  status(): StreamStatus;
}

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** 本地持久化（localStorage 可替换为 IndexedDB / 服务端同步）。 */
export interface KeyValueStorePort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** 用户提示（antd message / modal 由 ui 层实现，core 不感知 antd）。 */
export interface NotifierPort {
  toast(message: string, kind?: 'info' | 'success' | 'warn' | 'error'): void;
  /** 返回 Promise<boolean>，true=用户确认。 */
  confirm(title: string, body: string): Promise<boolean>;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. 领域服务端口（Domain service ports）—— 按职责内聚
// ════════════════════════════════════════════════════════════════════════════

/** 会话生命周期 + 会话隔离切片的读写。 */
export interface SessionServicePort {
  list(): Promise<SessionSummary[]>;
  create(workspace?: string | null): Promise<SessionId>;
  switchTo(id: SessionId): Promise<void>;
  rename(id: SessionId, title: string): Promise<void>;
  remove(id: SessionId): Promise<void>;
  /** 取（必要时创建）某个会话的隔离切片。 */
  slice(id: SessionId): SessionSlice;
  subscribe(id: SessionId, listener: () => void): () => void;
}

/** 对话：发送 / 停止 / 斜杠命令。 */
export interface ChatServicePort {
  send(sessionId: SessionId, content: string, attachments?: string[]): Promise<void>;
  stop(sessionId: SessionId): Promise<void>;
  command(sessionId: SessionId, cmd: string): Promise<void>;
}

/** 模型能力：供应商 / 模型 / 思考强度 三段式切换（本次新增能力）。 */
export interface ModelServicePort {
  /** 供应商列表（从模型目录派生 + 自定义）。 */
  providers(): Promise<ProviderOption[]>;
  /** 某供应商下的模型列表。 */
  models(provider?: string): Promise<ModelOption[]>;
  /** 当前生效选择。 */
  current(sessionId: SessionId): ModelSelection;
  /** 切换供应商（模型回落到该供应商第一个）。 */
  setProvider(sessionId: SessionId, provider: string): Promise<ModelSelection>;
  /** 切换模型。 */
  setModel(sessionId: SessionId, modelId: string): Promise<ModelSelection>;
  /** 切换思考强度。 */
  setThinking(sessionId: SessionId, effort: ThinkingEffort): Promise<ModelSelection>;
}

/** 工作区。 */
export interface WorkspaceServicePort {
  current(): WorkspaceInfo | null;
  use(dir: string, syncTui?: boolean): Promise<WorkspaceInfo>;
  reset(): Promise<WorkspaceInfo>;
  browse(path?: string): Promise<WorkspaceEntry[]>;
  recents(): WorkspaceEntry[];
  addRecent(path: string): void;
}

/** 服务端设置（LAN / 只读 / token 等）。 */
export interface SettingsServicePort {
  get(): Promise<WireSettings>;
  update(patch: Partial<WireSettings>): Promise<WireSettings>;
  resetToken(): Promise<{ token: string }>;
  acknowledgeToken(): Promise<void>;
}

/** 套餐用量 + 上下文消耗。 */
export interface UsageServicePort {
  quota(): Promise<UsageInfo>;
  refresh(): Promise<void>;
  /**
   * 会话的上下文消耗。注意：服务端 /api/usage-real 当前按 cid（浏览器 tab）
   * 统计而非按 sessionId，参数保留会话语义以便将来按会话切分。
   */
  context(sessionId: SessionId): Promise<ContextUsage | null>;
}

/** 异常通道（bell）。 */
export interface AlertsServicePort {
  snapshot(): Promise<AlertItem[]>;
  list(): AlertItem[];
  unread(): number;
  markRead(): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

/** 每请求授权（authorize 门）。 */
export interface AuthServicePort {
  pending(): PendingAuth[];
  decide(requestId: string, approve: boolean): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** 附件上传。 */
export interface UploadServicePort {
  upload(file: File | Blob, name: string): Promise<Attachment>;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. 组装根（composition root）—— 热插拔的替换点
// ════════════════════════════════════════════════════════════════════════════

/**
 * 全部端口的集合。**任何模块都不许自己 new 实现**，一律从这里取。
 * 热插拔 = 用 `createRegistry({ http: myHttp })` 覆盖任意一项。
 */
export interface Registry {
  // infra
  clock: ClockPort;
  http: HttpPort;
  stream: StreamPort;
  kv: KeyValueStorePort;
  notifier: NotifierPort;
  // domain services
  sessions: SessionServicePort;
  chat: ChatServicePort;
  models: ModelServicePort;
  workspace: WorkspaceServicePort;
  settings: SettingsServicePort;
  usage: UsageServicePort;
  alerts: AlertsServicePort;
  auth: AuthServicePort;
  upload: UploadServicePort;
}

/** 部分覆盖：未提供的端口由 core 的默认实现补齐。 */
export type RegistryOverrides = Partial<Registry>;

/** 进程/浏览器身份（cid、token）—— 由 core 注入，UI 只读。 */
export interface ClientIdentity {
  cid: Cid;
  /** 是否远程客户端（影响本机/远程的展示差异）。 */
  remote: boolean;
}

export type { WireClientState, ChatMessage, SessionSlice };
