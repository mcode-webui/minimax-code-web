/**
 * SessionTitleBar.tsx —— 会话标题栏（中栏顶部）
 * ============================================================================
 * 参考布局：顶部居中的会话标题 + ∨（点开下拉快速切换会话），
 * 右侧放面板开关等工具按钮。哑组件：下拉的开合与列表渲染由容器负责，
 * 本组件只管「标题按钮 + 左右插槽」的结构与居中排版。
 * ============================================================================
 */

import { memo } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../primitives/Icon';
import './titlebar.css';

export interface SessionTitleBarProps {
  /** 会话标题（空 → 显示占位）。 */
  title: string;
  /** 占位文案（无标题/无会话时）。 */
  placeholder?: string;
  /** 标题按钮点击（容器用来开合会话切换下拉）。 */
  onTitleClick?: () => void;
  /** 下拉展开态（控制 chevron 旋转与 aria）。 */
  expanded?: boolean;
  /** 是否只读模式（显示徽标）。 */
  readOnly?: boolean;
  readOnlyLabel?: string;
  /** 运行中状态点。 */
  running?: boolean;
  /** 左侧插槽（如侧栏折叠钮）。 */
  left?: ReactNode;
  /** 右侧插槽（面板开关等）。 */
  right?: ReactNode;
  /** 标题正下方的下拉内容（容器渲染，开合由容器控制）。 */
  dropdown?: ReactNode;
}

export const SessionTitleBar = memo(function SessionTitleBar({
  title,
  placeholder = '新会话',
  onTitleClick,
  expanded = false,
  readOnly = false,
  readOnlyLabel = '只读',
  running = false,
  left,
  right,
  dropdown,
}: SessionTitleBarProps) {
  return (
    <div className="stitle">
      <div className="stitle-side stitle-side--left">{left}</div>
      <div className="stitle-center">
        <button
          type="button"
          className={expanded ? 'stitle-btn stitle-btn--open' : 'stitle-btn'}
          onClick={onTitleClick}
          aria-expanded={expanded}
          title={title || placeholder}
        >
          {running ? <span className="stitle-run" aria-hidden="true" /> : null}
          <span className="stitle-text">{title || placeholder}</span>
          <Icon name="chevron-down" size={14} strokeWidth={2} className="stitle-chevron" />
        </button>
        {readOnly ? <span className="stitle-ro">{readOnlyLabel}</span> : null}
        {dropdown}
      </div>
      <div className="stitle-side stitle-side--right">{right}</div>
    </div>
  );
});
