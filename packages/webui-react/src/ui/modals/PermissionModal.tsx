/**
 * ui/modals/PermissionModal.tsx —— 权限弹窗（哑组件，受控 open）
 * ============================================================================
 * 视觉职责：标题「Permission」+ 当前模式徽标（Current · ASK）+ 说明文案 +
 * ASK / AUTO / FULL 三个选项（各带一行说明，带 1/2/3 序号圆标）+
 * 底部快捷键提示（1-3 选择 / Enter 确认 / Esc 取消）。
 *
 * 行为（对齐 vanilla #perm-modal）：1/2/3 或点按立即选择并回调；
 * Enter 确认当前高亮项；Esc / X / 遮罩 = onClose。
 * ============================================================================
 */
import './perm.css';

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * 权限模式。与 composer/Composer.tsx 的同名联合保持一致
 * （contracts 暂不含此类型；结构化类型系统下两个定义可互换）。
 */
export type PermissionMode = 'ask' | 'auto' | 'full';

const MODE_ORDER: readonly PermissionMode[] = ['ask', 'auto', 'full'];

const MODE_DEFS: readonly { key: PermissionMode; num: number; label: string; desc: string }[] = [
  { key: 'ask', num: 1, label: 'ASK', desc: 'Confirm sensitive actions' },
  { key: 'auto', num: 2, label: 'AUTO', desc: 'Ask only when risk is high' },
  { key: 'full', num: 3, label: 'FULL', desc: 'Run without confirmation' },
];

export interface PermissionModalProps {
  open: boolean;
  /** 当前模式（显示在标题右侧徽标）；null 不显示徽标。 */
  current: PermissionMode | null;
  /** 选择新模式。 */
  onSelect: (mode: PermissionMode) => void;
  /** Esc / X / 遮罩取消。 */
  onClose: () => void;
  title?: string;
}

export function PermissionModal(props: PermissionModalProps) {
  const { open, current, onSelect, onClose, title = 'Permission' } = props;
  const [active, setActive] = useState<PermissionMode>('ask');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setActive(current ?? 'ask');
    rootRef.current?.focus();
  }, [open, current]);

  if (!open) return null;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === '1') {
      e.preventDefault();
      setActive('ask');
      onSelect('ask');
    } else if (e.key === '2') {
      e.preventDefault();
      setActive('auto');
      onSelect('auto');
    } else if (e.key === '3') {
      e.preventDefault();
      setActive('full');
      onSelect('full');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSelect(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const i = MODE_ORDER.indexOf(active);
      setActive(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const i = MODE_ORDER.indexOf(active);
      setActive(MODE_ORDER[(i - 1 + MODE_ORDER.length) % MODE_ORDER.length]);
    }
  };

  const renderOption = (def: (typeof MODE_DEFS)[number]): ReactElement => (
    <button
      key={def.key}
      type="button"
      className={active === def.key ? 'perm-option active' : 'perm-option'}
      onClick={() => {
        setActive(def.key);
        onSelect(def.key);
      }}
    >
      <span className="perm-option-num">{def.num}</span>
      <span className="perm-option-text">
        <span className="perm-option-label">{def.label}</span>
        <span className="perm-option-desc">{def.desc}</span>
      </span>
    </button>
  );

  return (
    <div className="perm-modal">
      <div className="perm-modal-backdrop" onClick={onClose} />
      <div
        ref={rootRef}
        className="perm-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-modal-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="perm-modal-header">
          <span className="perm-modal-title" id="perm-modal-title">{title}</span>
          {current ? <span className="perm-current">Current · {current.toUpperCase()}</span> : null}
          <button type="button" className="perm-modal-close" title="Esc 取消" aria-label="关闭" onClick={onClose}>
            <svg className="icon" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="perm-modal-body">
          <p className="perm-desc">Choose how MCode handles tool access.</p>
          <div className="perm-options">{MODE_DEFS.map(renderOption)}</div>
        </div>

        <div className="perm-modal-footer">
          <span><kbd>1-3</kbd> 选择</span>
          <span><kbd>Enter</kbd> 确认</span>
          <span><kbd>Esc</kbd> 取消</span>
        </div>
      </div>
    </div>
  );
}
