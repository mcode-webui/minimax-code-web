/**
 * IconButton.tsx —— 图标按钮（消息操作行 / 面板头部工具条的通用原子）
 * ============================================================================
 * 哑组件：一个 <button> 包一个 <Icon>。提供三种视觉态：
 *   默认（幽灵，hover 出底）/ active（高亮底，如已点赞）/ danger（悬停转红）。
 * 统一了参考布局里大量出现的「小方图标按钮」形态（消息操作、面板头部、
 * 文件树工具条），避免各处手写 className。
 * ============================================================================
 */

import { memo } from 'react';
import type { MouseEventHandler } from 'react';
import { Icon, type IconName } from './Icon';
import './iconbutton.css';

export interface IconButtonProps {
  icon: IconName;
  /** 无障碍标签 + tooltip（必填，图标按钮没有可见文字）。 */
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** 高亮态（如「已点赞」「面板已展开」）。 */
  active?: boolean;
  /** 悬停转危险色（删除类动作）。 */
  danger?: boolean;
  disabled?: boolean;
  /** 图标尺寸 px，默认 15。 */
  size?: number;
  /** 按钮边尺寸：sm=24px / md=28px，默认 sm。 */
  box?: 'sm' | 'md';
}

export const IconButton = memo(function IconButton({
  icon,
  label,
  onClick,
  active = false,
  danger = false,
  disabled = false,
  size = 15,
  box = 'sm',
}: IconButtonProps) {
  let cls = 'iconbtn iconbtn--' + box;
  if (active) cls += ' iconbtn--active';
  if (danger) cls += ' iconbtn--danger';
  return (
    <button
      type="button"
      className={cls}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={size} strokeWidth={1.9} />
    </button>
  );
});
