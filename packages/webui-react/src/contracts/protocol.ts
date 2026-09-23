/**
 * contracts/protocol.ts —— 传输层契约（wire contract）
 * ============================================================================
 * 【这是"咬合面"的第一半】定义浏览器 ↔ webui server 之间的真实线上格式，
 * 与 packages/webui/docs/API.md、server/lib/ws-server.js 严格一一对应。
 *
 * 规则（高内聚低耦合）：
 *   1. 本文件只放 **线上格式** 的类型与判别函数，不放任何业务逻辑、任何 import。
 *   2. core/ 的 transport 实现负责把它翻译成 domain.ts 的领域对象。
 *   3. ui/ **禁止** 直接 import 本文件（UI 只见 domain.ts）。
 *   4. 修改线上格式 = 修改契约，必须同步 API.md 与服务端测试。
 * ============================================================================
 */

// ── WebSocket 帧信封（server → client）─────────────────────────────────────
export const PROTOCOL_VERSION = 1 as const;

export type ServerFrameType =
  | 'hello'
  | 'state.snapshot'
  | 'control'
  | 'error'
  | 'pong';

export interface ServerFrame<P = unknown> {
  v: typeof PROTOCOL_VERSION;
  type: ServerFrameType;
  /** 单调递增，仅 state.snapshot / control 携带；用于断线 resume。 */
  seq?: number;
  ts?: number;
  payload: P;
}

export interface HelloPayload {
  cid: string;
  resumeSupported: boolean;
  latestSeq: number | null;
  heartbeatMs: number;
  ringCapacity: number;
}

export interface StreamErrorPayload {
  code: 'resume-underrun' | (string & {});
  message?: string;
}

/** 控制帧名字空间 —— 未知名字必须被静默忽略（向前兼容）。 */
export type ControlName =
  | 'auth.token_rotated'
  | 'needs_authorization'
  | 'authorization_decided'
  | 'alerts.append'
  | 'alerts.update'
  | 'token.first_run';

export interface ControlPayload {
  name: ControlName | (string & {});
  /** 恒为字符串；结构化数据以 JSON 文本承载。 */
  data: string;
}

// ── WebSocket 帧（client → server）─────────────────────────────────────────
export type ClientFrame =
  | { v: typeof PROTOCOL_VERSION; type: 'resume'; payload: { lastSeq: number } }
  | { v: typeof PROTOCOL_VERSION; type: 'ping' }
  | { v: typeof PROTOCOL_VERSION; type: 'pong' }
  | { v: typeof PROTOCOL_VERSION; type: 'close' };

// ── 异常通道（alerts）──────────────────────────────────────────────────────
export type AlertLevel = 'info' | 'warn' | 'error';

export interface WireAlert {
  id: string;
  ts: number;
  level: AlertLevel;
  msg: string;
  src: string;
  cid?: string | null;
  sessionId?: string | null;
  data?: unknown;
  count?: number;
}

export interface AlertsSnapshotFrame {
  kind: 'snapshot';
  alerts: WireAlert[];
}

export type AlertsDeltaFrame =
  | { kind: 'append'; alert: WireAlert }
  | { kind: 'update'; alert: WireAlert };

// ── 每请求授权（authorize 门）──────────────────────────────────────────────
export interface WireAuthRequest {
  requestId: string;
  action: string;
  ctx: Record<string, unknown>;
  expiresAt: number;
}

export interface WireAuthDecided {
  requestId: string;
  approved: boolean;
  decidedBy?: string;
}

// ── 全量状态快照（GET /api/state 与 state.snapshot 帧同构）─────────────────
export interface WireModel {
  name?: string;
  provider?: string;
}

export interface WireRunning {
  active: boolean;
  startedAt?: number;
}

export interface WireUsage {
  fiveHourPercent?: number;
  weekly?: string | number;
  resetAt?: number;
  weeklyResetAt?: number;
  fetchedAt?: number;
  source?: string;
  hidden?: boolean;
  raw?: unknown;
}

export interface WireWorkspace {
  dir?: string | null;
  branch?: string | null;
  tree?: string | null;
}

export interface WireMcodeSession {
  id: string;
  title?: string;
  workspace?: string;
  updatedAt?: number;
}

/** 每个浏览器 tab（cid）一份的服务端状态。 */
export interface WireClientState {
  version?: string;
  running?: WireRunning;
  model?: WireModel;
  permissions?: string;
  thinking?: string | null;
  workspace?: WireWorkspace;
  usage?: WireUsage;
  chat?: unknown[];
  sessions?: WireSessionRow[];
  mcodeSessions?: WireMcodeSession[];
  mcodeSessionsPending?: boolean;
  settings?: WireSettings;
  quotaEnabled?: boolean;
  hasTokenPlanKey?: boolean;
  tokenPlanApiKeyMasked?: string;
  tokenPlanApiKeySource?: 'env' | 'file' | 'settings' | '';
  tokenPlanApiKeyFilePath?: string;
  askUserAnswers?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface WireSessionRow {
  id: string;
  title?: string;
  workspace?: string;
  mcodeSessionId?: string;
  titleCustom?: boolean;
  updatedAt?: number;
}

export interface WireSettings {
  lanBroadcast?: boolean;
  lanBind?: boolean;
  readOnly?: boolean;
  tokenEnabled?: boolean;
  currentToken?: string;
  tokenAcknowledged?: boolean;
  tokenRotatedAt?: number;
  lanIp?: string | null;
  lanUrl?: string | null;
  lanUrlWithToken?: string | null;
  localUrl?: string;
  lanExposed?: boolean;
  bindRestartPending?: boolean;
  lanExposureNotice?: string;
  trustedOrigins?: string[];
  defaultModel?: string;
  defaultWorkspace?: string;
  mcodeCmd?: string;
  mcodeVersion?: string;
  port?: number;
  host?: string;
  bindHost?: string;
  [k: string]: unknown;
}

// ── REST 通用响应信封 ──────────────────────────────────────────────────────
export interface OkResponse {
  ok: true;
  [k: string]: unknown;
}

export interface ErrResponse {
  ok: false;
  error: string;
  code?: string;
}

export type ApiResponse<T extends object = object> = (OkResponse & T) | ErrResponse;

// ── 判别与归一化（容错：线上数据一律视为不可信）────────────────────────────
export function isServerFrame(v: unknown): v is ServerFrame {
  return (
    typeof v === 'object' && v !== null &&
    (v as ServerFrame).v === PROTOCOL_VERSION &&
    typeof (v as ServerFrame).type === 'string'
  );
}

export function isErrResponse(v: unknown): v is ErrResponse {
  return typeof v === 'object' && v !== null && (v as ErrResponse).ok === false;
}

export const ALERT_LEVELS: readonly AlertLevel[] = ['info', 'warn', 'error'];

/** 把不可信 wire alert 归一化；id 为空串表示"不可用"，调用方须跳过。 */
export function normalizeWireAlert(raw: unknown): WireAlert {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const level = ALERT_LEVELS.includes(o.level as AlertLevel) ? (o.level as AlertLevel) : 'info';
  return {
    id: typeof o.id === 'string' ? o.id : o.id != null ? String(o.id) : '',
    ts: Number(o.ts) || 0,
    level,
    msg: typeof o.msg === 'string' ? o.msg : String(o.msg ?? ''),
    src: typeof o.src === 'string' && o.src ? o.src : 'system',
    cid: o.cid != null ? String(o.cid) : null,
    sessionId: o.sessionId != null ? String(o.sessionId) : null,
    data: o.data,
    count: Number(o.count) || 1,
  };
}
