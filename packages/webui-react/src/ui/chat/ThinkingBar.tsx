/**
 * ThinkingBar.tsx —— "思考中"指示（三个跳动圆点 + 思考中）
 * 哑组件，纯展示；已被 ChatArea / MessageList 使用，仅导出即可。
 */

import { memo } from 'react';
import './thinkingbar.css';

export interface ThinkingBarProps {
  /** 文案（默认"思考中"，对齐 vanilla data-i18n="status_thinking"）。 */
  label?: string;
  /** 品牌 logo 地址。 */
  logoSrc?: string;
}

export const ThinkingBar = memo(function ThinkingBar({
  label = '思考中',
  logoSrc = '/brand-logo.png',
}: ThinkingBarProps) {
  return (
    <div className="thinking-bar" role="status" aria-live="polite">
      <img className="thinking-bar-avatar" src={logoSrc} alt="MiniMax Code" />
      <span className="thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="thinking-bar-text">{label}</span>
    </div>
  );
});
