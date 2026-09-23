import type { ContextUsage } from '../../contracts/domain';
import { KeyValueRow } from '../primitives/KeyValueRow';
import './ContextPanel.css';

// ── 小工具（纯函数，无 IO）─────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + 'M';
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + 'k';
  }
  return String(Math.round(n));
}

/** 数据源 → 徽标修饰类 + 文案（1:1 对齐 main.css 的 .kv-usage-source.estimate/.real/.mcode）。 */
function sourceBadge(source: string | undefined): { cls: string; text: string } {
  if (source === 'mavis-db') return { cls: 'real', text: 'mavis db' };
  if (source === 'estimate') return { cls: 'estimate', text: '\u4f30\u7b97' };
  return { cls: 'mcode', text: 'mcode' };
}

// ── ContextBar：上下文占用进度条 ───────────────────────────────────────────
export interface ContextBarProps {
  /** 占用百分比 0-100。 */
  percent: number;
  /** 是否为估算值（加虚化纹理提示）。 */
  estimated?: boolean;
}

export function ContextBar({ percent, estimated }: ContextBarProps) {
  const hasData = Number.isFinite(percent) && percent > 0;
  const clamped = hasData ? Math.min(100, Math.max(0, percent)) : 0;
  const level = clamped > 80 ? 'danger' : clamped > 50 ? 'high' : 'normal';
  const cls =
    'context-bar-fill context-bar-fill--' + level + (estimated ? ' context-bar-fill--estimated' : '');
  return (
    <div className="context-bar" role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cls} style={{ width: clamped + '%' }} />
    </div>
  );
}

// ── TpsDisplay：速度 tok/s ────────────────────────────────────────────────
export interface TpsDisplayProps {
  /** 每秒 token 数；无数据显示占位符。 */
  tps: number | string | null;
  /** 左侧标签文案。 */
  label?: string;
  /** 右侧单位文案。 */
  unit?: string;
}

export function TpsDisplay({ tps, label = '\u901f\u5ea6', unit = 'tok/s' }: TpsDisplayProps) {
  const value = tps === null || tps === undefined || tps === '' ? '\u2014' : String(tps);
  return (
    <div className="tps-display">
      <svg className="tps-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
      <span>{label}</span>
      <b className="tps-value">{value}</b>
      <span className="tps-unit">{unit}</span>
    </div>
  );
}

// ── ContextSourceBadge：CONTEXT 标题行右侧的数据源徽标 ─────────────────────
export interface ContextSourceBadgeProps {
  /** 上下文用量；无数据时不渲染。 */
  usage: ContextUsage | null;
}

export function ContextSourceBadge({ usage }: ContextSourceBadgeProps) {
  const hasData = !!usage && usage.used > 0;
  if (!hasData || !usage) return null;
  const badge = sourceBadge(usage.source);
  return (
    <span className={'kv-usage-source kv-usage-source--' + badge.cls} title={usage.source}>
      {badge.text}
    </span>
  );
}

// ── ContextPanel：CONTEXT 段内容 ──────────────────────────────────────────
export interface ContextPanelLabels {
  used: string;
  percent: string;
  cache: string;
}

export interface ContextPanelProps {
  /** 上下文用量（领域对象）。 */
  usage: ContextUsage | null;
  /** 标签文案覆盖（i18n 接缝）。 */
  labels?: Partial<ContextPanelLabels>;
}

const DEFAULT_LABELS: ContextPanelLabels = {
  used: '\u5df2\u7528',
  percent: '\u5360\u6bd4',
  cache: '\u7f13\u5b58',
};

/**
 * ContextPanel —— 右栏 CONTEXT 段内容：
 *   已用量（+ mavis 模型徽标 + 缓存读徽标）/ 进度条 / 占比 / 速度 tok/s。
 * 哑组件：只渲染，不做任何 IO。
 */
export function ContextPanel({ usage, labels }: ContextPanelProps) {
  const l: ContextPanelLabels = { ...DEFAULT_LABELS, ...labels };
  const hasData = !!usage && usage.used > 0;
  const used = usage?.used ?? 0;
  const limit = usage?.limit ?? 0;
  const percent = usage?.percent ?? 0;
  const estimated = usage?.source === 'estimate';

  const usedText = hasData
    ? (estimated ? '\u2248' : '') + formatTokens(used) + (limit > 0 ? '/' + formatTokens(limit) : '')
    : '\u2014';
  const percentText = hasData && limit > 0 ? percent.toFixed(1) + '%' : '\u2014';

  const modelExtra =
    hasData && usage?.model ? (
      <span className="kv-mavis-model" title={usage.model}>
        {usage.model}
      </span>
    ) : null;
  const cacheExtra =
    hasData && typeof usage?.cacheRead === 'number' && usage.cacheRead > 0 ? (
      <span className="kv-cache-read" title={String(usage.cacheRead)}>
        {l.cache} ↓{formatTokens(usage.cacheRead)}
      </span>
    ) : null;

  return (
    <div className="context-panel">
      <KeyValueRow label={l.used} value={usedText} extra={<>{modelExtra}{cacheExtra}</>} />
      <ContextBar percent={hasData ? percent : 0} estimated={estimated} />
      <KeyValueRow label={l.percent} value={percentText} muted />
      <TpsDisplay tps={hasData ? (usage?.tps ?? null) : null} />
    </div>
  );
}
