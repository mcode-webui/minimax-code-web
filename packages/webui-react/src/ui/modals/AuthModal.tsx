/**
 * ui/modals/AuthModal.tsx —— 每请求授权确认弹窗（哑组件，受控 open）
 * ============================================================================
 * 视觉职责：🔐 图标 + 标题「需要授权确认」+ 队列位置 + 操作名 + 上下文列表 +
 * 倒计时 mm:ss + 错误行 + 底部「拒绝 / 允许」。
 *
 * 【与原 UI 一致的刻意设计】没有关闭按钮、没有 Esc、没有背景点击关闭 ——
 * 请求必须被显式决策（或等服务端超时 fail-closed 拒绝），Deny 就是那个
 * 显式的“不”。倒计时由容器按 props 传入的 msLeft 驱动（哑组件不跑定时器）。
 * ============================================================================
 */
import './auth.css';

export interface AuthModalRequest {
  requestId: string;
  action: string;
  /** 请求附带的结构化上下文（不可信 wire 数据 —— 一律以文本渲染）。 */
  ctx: Record<string, unknown>;
}

export interface AuthModalProps {
  open: boolean;
  /** 队首请求。 */
  request: AuthModalRequest | null;
  /** 队列位置（1 起）；total ≤ 1 时不显示。 */
  position: number;
  total: number;
  /** 剩余毫秒 —— 组件折算为 mm:ss 展示。 */
  msLeft: number;
  /** 决策提交中（双按钮禁用，一次请求只允许一次决策）。 */
  deciding?: boolean;
  /** 错误行（上次决策失败等）。 */
  error?: string | null;
  /** 操作名展示文案（缺省回退到 request.action）。 */
  actionLabel?: string;
  /** ctx 字段 → 友好名（缺省用原始 key；'cid' 自动跳过）。 */
  ctxLabels?: Record<string, string>;
  onApprove: () => void;
  onDeny: () => void;
}

/** 毫秒 → mm:ss，钳在 00:00（纯函数）。 */
export function formatAuthCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil((Number(msLeft) || 0) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 不可信 ctx 值 → 安全展示文本（对象/数组 JSON 化，异常回退 String()）。 */
function ctxValueText(value: unknown): string {
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function AuthModal(props: AuthModalProps) {
  const {
    open,
    request,
    position,
    total,
    msLeft,
    deciding = false,
    error = null,
    actionLabel,
    ctxLabels,
    onApprove,
    onDeny,
  } = props;

  if (!open || !request) return null;

  const ctxRows = Object.keys(request.ctx)
    .filter((key) => key !== 'cid')
    .filter((key) => request.ctx[key] !== null && request.ctx[key] !== undefined)
    .map((key) => ({ key, value: ctxValueText(request.ctx[key]) }));

  return (
    <div className="auth-modal">
      {/* 刻意不做背景点击关闭：遮罩只负责压暗。 */}
      <div className="auth-modal-backdrop" />
      <div
        className="auth-modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        <div className="auth-modal-header">
          <div className="auth-modal-icon" aria-hidden="true">🔐</div>
          <div className="auth-modal-title" id="auth-modal-title">需要授权确认</div>
          {total > 1 ? (
            <div className="auth-modal-position">第 {position} / {total} 个</div>
          ) : null}
        </div>

        <div className="auth-modal-body">
          <div className="auth-modal-action">{actionLabel ?? request.action}</div>

          {ctxRows.length > 0 ? (
            <div className="auth-modal-ctx">
              {ctxRows.map((row) => (
                <div className="auth-modal-ctx-row" key={row.key}>
                  <span className="auth-modal-ctx-key">{ctxLabels?.[row.key] ?? row.key}</span>
                  <span className="auth-modal-ctx-value">{row.value}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="auth-modal-countdown">
            <span>确认时限</span>
            <span className="auth-modal-countdown-value">{formatAuthCountdown(msLeft)}</span>
          </div>

          {error ? <div className="auth-modal-error">{error}</div> : null}
        </div>

        <div className="auth-modal-footer">
          <button
            type="button"
            className="auth-modal-btn-secondary"
            disabled={deciding}
            onClick={onDeny}
          >
            拒绝
          </button>
          <button
            type="button"
            className="auth-modal-btn-primary"
            disabled={deciding}
            onClick={onApprove}
          >
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
