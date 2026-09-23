/**
 * EmptyState.tsx —— 欢迎空态（品牌 logo + 还没有消息，在下方输入开始对话）
 * 哑组件，纯展示，文案可由 props 覆盖（i18n 由上层注入）。
 */

import { memo } from 'react';
import './empty.css';

export interface EmptyStateProps {
  /** 品牌 logo 地址（默认同 vanilla /brand-logo.png）。 */
  logoSrc?: string;
  /** 可选主标题（不传则只显示提示语，对齐 vanilla 欢迎页）。 */
  title?: string;
  /** 副标题/提示语。 */
  subtitle?: string;
}

export const EmptyState = memo(function EmptyState({
  logoSrc = '/brand-logo.png',
  title,
  subtitle = '还没有消息 — 在下方输入开始对话',
}: EmptyStateProps) {
  return (
    <div className="chat-empty">
      <img className="chat-empty-logo" src={logoSrc} alt="MiniMax Code" />
      {title !== undefined && title !== '' ? <div className="chat-empty-title">{title}</div> : null}
      <div className="chat-empty-subtitle">{subtitle}</div>
    </div>
  );
});
