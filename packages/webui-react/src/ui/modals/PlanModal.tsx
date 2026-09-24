/**
 * ui/modals/PlanModal.tsx —— Plan Review 弹窗（哑组件，受控 open）
 * ============================================================================
 * 视觉职责：标题「Plan Review」+ 冻结快照徽标 + 计划摘要 + 追加上下文
 * textarea（仅 add 模式显示）+ 三个选项按钮（agree/skip/add，带 1/2/3 序号
 * 圆标）+ 底部快捷键提示（↑↓ 移动 / 1-3 选择 / Enter 确认 / Esc 跳过）。
 *
 * 行为：agree/skip 点按或按 1/2 立即确认；add（点按或按 3）进入 add 模式
 * 展示 textarea，再按一次或 Enter 才携带上下文提交；X / Esc / 遮罩 = onClose
 * （容器可映射为跳过）。
 * ============================================================================
 */
import './plan.css';

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

export type PlanChoice = 'agree' | 'skip' | 'add';

const CHOICE_ORDER: readonly PlanChoice[] = ['agree', 'skip', 'add'];

const DEFAULT_LABELS: Record<PlanChoice, string> = {
  agree: 'Agree and start implementation',
  skip: 'Skip for now',
  add: 'Add context to revise',
};

export interface PlanModalProps {
  open: boolean;
  /** 计划标题。 */
  planTitle: string;
  /** 计划摘要（空 → 显示空态文案）。 */
  summary: string;
  /** 冻结徽标文案；缺省 'Frozen Runtime snapshot'。 */
  frozenLabel?: string;
  /** 三个选项的自定义文案。 */
  labels?: Partial<Record<PlanChoice, string>>;
  /** 追加上下文（受控，仅 add 模式显示输入框）。 */
  contextText: string;
  onContextChange: (text: string) => void;
  /** 确认选择（add 时携带上下文文本）。 */
  onSubmit: (choice: PlanChoice, contextText: string) => void;
  /** X / Esc / 遮罩 —— 页脚提示的“跳过”由此回调承载。 */
  onClose: () => void;
  summaryEmptyText?: string;
}

export function PlanModal(props: PlanModalProps) {
  const {
    open,
    planTitle,
    summary,
    frozenLabel = 'Frozen Runtime snapshot',
    labels,
    contextText,
    onContextChange,
    onSubmit,
    onClose,
    summaryEmptyText = '没有 Plan 内容',
  } = props;

  const [active, setActive] = useState<PlanChoice>('agree');
  const [addMode, setAddMode] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const addRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setActive('agree');
    setAddMode(false);
    rootRef.current?.focus();
  }, [open]);

  if (!open) return null;

  // 激活一个选项：agree/skip 立即提交；add 进入/确认 add 模式。
  const activate = (choice: PlanChoice) => {
    if (choice === 'add') {
      if (!addMode) {
        setAddMode(true);
        setActive('add');
        addRef.current?.focus();
        return;
      }
      onSubmit('add', contextText);
      return;
    }
    setActive(choice);
    onSubmit(choice, contextText);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // textarea 里正常输入；只放行 Escape。
    const typing = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT';
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (typing) {
      if (e.key === 'Enter' && !e.shiftKey && addMode) {
        e.preventDefault();
        onSubmit('add', contextText);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const i = CHOICE_ORDER.indexOf(active);
      setActive(CHOICE_ORDER[(i + 1) % CHOICE_ORDER.length]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const i = CHOICE_ORDER.indexOf(active);
      setActive(CHOICE_ORDER[(i - 1 + CHOICE_ORDER.length) % CHOICE_ORDER.length]);
    } else if (e.key === '1') {
      e.preventDefault();
      activate('agree');
    } else if (e.key === '2') {
      e.preventDefault();
      activate('skip');
    } else if (e.key === '3') {
      e.preventDefault();
      activate('add');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(active);
    }
  };

  const labelOf = (choice: PlanChoice) => labels?.[choice] ?? DEFAULT_LABELS[choice];

  const renderOption = (choice: PlanChoice, num: number, primary: boolean): ReactElement => (
    <button
      key={choice}
      type="button"
      className={
        primary
          ? 'plan-option primary'
          : active === choice
            ? 'plan-option active'
            : 'plan-option'
      }
      onClick={() => activate(choice)}
    >
      <span className="plan-option-num">{num}</span>
      <span className="plan-option-label">{labelOf(choice)}</span>
    </button>
  );

  return (
    <div className="plan-modal">
      <div className="plan-modal-backdrop" onClick={onClose} />
      <div
        ref={rootRef}
        className="plan-modal-card wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-modal-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="plan-modal-header">
          <span className="plan-modal-title" id="plan-modal-title">Plan Review</span>
          <span className="plan-frozen">{frozenLabel}</span>
          <button type="button" className="plan-modal-close" title="Esc 跳过" aria-label="关闭" onClick={onClose}>
            <svg className="icon" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="plan-modal-body">
          <div className="plan-title">{planTitle}</div>
          {summary ? (
            <div className="plan-summary">{summary}</div>
          ) : (
            <div className="plan-summary">
              <div className="plan-summary-empty">{summaryEmptyText}</div>
            </div>
          )}

          {addMode ? (
            <textarea
              ref={addRef}
              className="plan-add-context"
              placeholder="Add context to revise（仅 Add 模式生效）"
              value={contextText}
              onChange={(e) => onContextChange(e.target.value)}
            />
          ) : null}

          <div className="plan-options">
            {renderOption('agree', 1, true)}
            {renderOption('skip', 2, false)}
            {renderOption('add', 3, false)}
          </div>
        </div>

        <div className="plan-modal-footer">
          <span><kbd>↑↓</kbd> 移动</span>
          <span><kbd>1-3</kbd> 选择</span>
          <span><kbd>Enter</kbd> 确认</span>
          <span><kbd>Esc</kbd> 跳过</span>
        </div>
      </div>
    </div>
  );
}
