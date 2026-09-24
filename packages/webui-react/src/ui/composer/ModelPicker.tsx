/**
 * ui/composer/ModelPicker.tsx —— 三段式模型切换浮层（哑组件，核心新能力）
 * ============================================================================
 * 视觉职责：锚定在输入框上方的切换面板，三段式布局：
 *   ① 供应商列表（ProviderOption[]，当前项打勾）
 *   ② 该供应商下的模型列表（ModelOption[]，label + contextLimit 折算的上下文
 *      大小，当前项打勾）
 *   ③ 思考强度五档（off/low/medium/high/max → 关/低/中/高/极高，当前档高亮）
 * 底部：自定义 provider/model 输入框 + 取消按钮。
 *
 * 全部受控：providers / models / selection 由 props 进，切换与提交由
 * onSelectProvider / onSelectModel / onSelectThinking / onSubmitCustom /
 * onClose 回调出。类型全部来自 contracts/domain.ts。
 * ============================================================================
 */
import './modelpicker.css';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type {
  ModelGroup,
  ModelSelection,
  ThinkingEffort,
} from '../../contracts/domain';
import { THINKING_EFFORTS } from '../../contracts/domain';

/** 思考强度五档中文标签（关/低/中/高/极高）。 */
const THINKING_LABELS: Record<ThinkingEffort, string> = {
  off: '关',
  low: '低',
  medium: '中',
  high: '高',
  max: '极高',
};

/** contextLimit（token）→ 人类可读上下文大小；未知显示 '—'。 */
export function formatContextLimit(limit: number | undefined): string {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return '—';
  if (limit >= 1_000_000) return `${(limit / 1_000_000).toFixed(1)}M`;
  if (limit >= 1_000) return `${Math.round(limit / 1_000)}K`;
  return String(limit);
}

export interface ModelPickerProps {
  /** 是否显示（受控）。 */
  open: boolean;
  /** 按供应商分组的模型目录（第一段：先选模型）。 */
  groups: ModelGroup[];
  /** 当前选择。 */
  selection: ModelSelection;
  onSelectModel: (modelId: string) => void;
  onSelectThinking: (effort: ThinkingEffort) => void;
  /** 自定义 provider/model 输入框回车提交（原始文本）。 */
  onSubmitCustom: (value: string) => void;
  onClose: () => void;
  title?: string;
  /** 目录加载中。 */
  loading?: boolean;
  /** 目录为空时的提示（如指向配置文件 / mcode TUI）。 */
  emptyHint?: string;
}

export function ModelPicker(props: ModelPickerProps) {
  const {
    open,
    groups,
    selection,
    onSelectModel,
    onSelectThinking,
    onSubmitCustom,
    onClose,
    title = '切换模型',
    loading = false,
    emptyHint = '暂无模型 — 可在 models.json 配置，或在下方自定义输入',
  } = props;

  const [custom, setCustom] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) setCustom('');
  }, [open]);

  if (!open) return null;

  const handleCustomKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = custom.trim();
      if (v) onSubmitCustom(v);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const check = <span className="modelpicker-check" aria-hidden="true">✓</span>;

  return (
    <div className="modelpicker" role="dialog" aria-label={title}>
      <div className="modelpicker-title">{title}</div>

      {/* ① 模型（按供应商分组 —— 先选模型） */}
      <div className="modelpicker-section">
        <div className="modelpicker-section-label">模型 · 按供应商</div>
        <div className="modelpicker-list">
          {loading ? <div className="modelpicker-loading">加载中...</div> : null}
          {!loading && groups.length === 0 ? (
            <div className="modelpicker-empty">{emptyHint}</div>
          ) : null}
          {groups.map((g) => (
            <div key={g.id} className="modelpicker-group">
              <div className="modelpicker-group-label">{g.label}</div>
              {g.models.map((m) => {
                // 目录 id 是全限定（provider/model）；selection.model 可能是裸名 —— 两者都算当前。
                const current = m.id === selection.model || m.label === selection.model;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={current ? 'modelpicker-item-btn current' : 'modelpicker-item-btn'}
                    title={m.id}
                    onClick={() => onSelectModel(m.id)}
                  >
                    <span className="modelpicker-item-label">{m.label}</span>
                    <span className="modelpicker-item-meta">
                      {formatContextLimit(m.contextLimit)}
                    </span>
                    {current ? check : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* ② 思考强度（后选思考强度） */}
      <div className="modelpicker-section">
        <div className="modelpicker-section-label">思考强度</div>
        <div className="modelpicker-thinking" role="radiogroup" aria-label="思考强度">
          {THINKING_EFFORTS.map((effort) => {
            const current = effort === selection.thinking;
            return (
              <button
                key={effort}
                type="button"
                role="radio"
                aria-checked={current}
                className={current ? 'modelpicker-thinking-btn current' : 'modelpicker-thinking-btn'}
                onClick={() => onSelectThinking(effort)}
              >
                {THINKING_LABELS[effort]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="modelpicker-divider" />

      <input
        ref={inputRef}
        className="modelpicker-input"
        value={custom}
        placeholder="provider/model[#variant]"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={handleCustomKeyDown}
      />
      <div className="modelpicker-hint">回车发送 /model 命令给 mcode</div>

      <div className="modelpicker-actions">
        <button type="button" className="modelpicker-cancel" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}
