import type { ModelSelection } from '../../contracts/domain';
import { KeyValueRow } from '../primitives/KeyValueRow';
import './ModelPanel.css';

export interface ModelPanelLabels {
  model: string;
  thinking: string;
  context: string;
}

export interface ModelPanelProps {
  /** 当前会话的模型 / 供应商 / 思考强度选择。 */
  selection: ModelSelection;
  /** 上下文窗口（token）；0 / null / undefined 表示未知。 */
  contextLimit?: number | null;
  /** 标签文案覆盖（i18n 接缝）。 */
  labels?: Partial<ModelPanelLabels>;
}

const DEFAULT_LABELS: ModelPanelLabels = {
  model: 'Model',
  thinking: 'Thinking',
  context: 'Context',
};

/** token 数 → "200k" / "1.2M" 紧凑格式。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '\u2014';
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + 'M';
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + 'k';
  }
  return String(n);
}

/**
 * ModelPanel —— 右栏 MODEL 段内容：Model / Thinking / Context 三行。
 * 哑组件：只渲染 KeyValueRow。
 */
export function ModelPanel({ selection, contextLimit, labels }: ModelPanelProps) {
  const l: ModelPanelLabels = { ...DEFAULT_LABELS, ...labels };
  const limit = typeof contextLimit === 'number' ? contextLimit : 0;
  return (
    <div className="model-panel">
      <KeyValueRow label={l.model} value={selection.model || '\u2014'} muted />
      <KeyValueRow label={l.thinking} value={selection.thinking || '\u2014'} muted />
      <KeyValueRow label={l.context} value={formatTokens(limit)} muted />
    </div>
  );
}
