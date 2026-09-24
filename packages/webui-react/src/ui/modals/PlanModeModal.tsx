/**
 * ui/modals/PlanModeModal.tsx —— “Use Plan mode?” 弹窗（哑组件，受控 open）
 * ============================================================================
 * 视觉职责：标题「Use Plan mode?」+ 说明文案 + 两个选项
 * （1 Continue with plan / 2 Deny，带 1/2 序号圆标）+ 底部快捷键提示
 * （1-2 选择 / Enter 确认 / Esc 拒绝）。
 *
 * 行为（对齐 vanilla #planmode-modal）：按 1 或 Enter = Continue with plan，
 * 按 2 = Deny；X / Esc / 遮罩 = onClose（原 UI 即“拒绝”，容器可把 onClose
 * 映射为 Deny 应答）。
 * ============================================================================
 */
import './planmode.css';

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef } from 'react';

export type PlanModeChoice = 'continue' | 'deny';

export interface PlanModeModalProps {
  open: boolean;
  /** 选择 Continue with plan / Deny。 */
  onChoose: (choice: PlanModeChoice) => void;
  /** X / Esc / 遮罩 —— 原 UI 语义即“拒绝”，容器可按 Deny 处理。 */
  onClose: () => void;
  title?: string;
}

interface ChoiceDef {
  key: PlanModeChoice;
  num: number;
  label: string;
  desc: string;
}

const CHOICES: readonly ChoiceDef[] = [
  { key: 'continue', num: 1, label: 'Continue with plan', desc: '进 Plan 模式，先出方案' },
  { key: 'deny', num: 2, label: 'Deny', desc: '不进 Plan 模式' },
];

function optionNode(def: ChoiceDef, onChoose: (c: PlanModeChoice) => void): ReactElement {
  return (
    <button
      key={def.key}
      type="button"
      className="planmode-option"
      onClick={() => onChoose(def.key)}
    >
      <span className="planmode-option-num">{def.num}</span>
      <span className="planmode-option-text">
        <span className="planmode-option-label">{def.label}</span>
        <span className="planmode-option-desc">{def.desc}</span>
      </span>
    </button>
  );
}

export function PlanModeModal(props: PlanModeModalProps) {
  const { open, onChoose, onClose, title = 'Use Plan mode?' } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) rootRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === '1' || e.key === 'Enter') {
      e.preventDefault();
      onChoose('continue');
    } else if (e.key === '2' || e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="planmode-modal">
      <div className="planmode-modal-backdrop" onClick={onClose} />
      <div
        ref={rootRef}
        className="planmode-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="planmode-modal-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="planmode-modal-header">
          <span className="planmode-modal-title" id="planmode-modal-title">{title}</span>
          <button type="button" className="planmode-modal-close" title="Esc 拒绝" aria-label="关闭" onClick={onClose}>
            <svg className="icon" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="planmode-modal-body">
          <p className="planmode-desc">Plan mode structures complex tasks before execution.</p>
          <div className="planmode-options">
            {CHOICES.map((def) => optionNode(def, onChoose))}
          </div>
        </div>

        <div className="planmode-modal-footer">
          <span><kbd>1-2</kbd> 选择</span>
          <span><kbd>Enter</kbd> 确认</span>
          <span><kbd>Esc</kbd> 拒绝</span>
        </div>
      </div>
    </div>
  );
}
