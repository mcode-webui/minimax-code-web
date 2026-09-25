import type { ReactNode } from 'react';
import type { ChipTone } from './Chip';
import './menu.css';

export interface MenuRowProps {
  /** 左侧图标。 */
  icon?: ReactNode;
  /** 主文字。 */
  text?: ReactNode;
  /** 右侧值（如 "开"/"明亮"/用量百分比）。 */
  value?: ReactNode;
  /** 右侧值的语义色。 */
  valueTone?: ChipTone;
  onClick?: () => void;
  ariaLabel?: string;
  /** 展开态（右箭头旋转 90°，原 UI 的 aria-expanded）。 */
  expanded?: boolean;
  /** 禁用态（占位导航项：可点击但不响应，视觉弱化）。 */
  disabled?: boolean;
  /** 禁用/提示文案（title）。 */
  title?: string;
}

/**
 * MenuRow —— 左下角那种 icon + 文字 + 右侧值 + 右箭头的整行按钮。
 * 哑组件：受控展示，交互经 onClick 上抛。
 */
export function MenuRow({ icon, text, value, valueTone = 'neutral', onClick, ariaLabel, expanded, disabled = false, title }: MenuRowProps) {
  const className = 'menu-row' + (expanded ? ' menu-row--expanded' : '') + (disabled ? ' menu-row--disabled' : '');
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      aria-expanded={expanded}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={disabled ? undefined : onClick}
    >
      <span className="menu-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="menu-row-text">{text}</span>
      <span className={'menu-row-value menu-row-value--' + valueTone}>{value}</span>
      <svg
        className="menu-row-chevron"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}
