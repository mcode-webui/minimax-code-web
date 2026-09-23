/**
 * SessionSearch.tsx —— 会话搜索框（放大镜图标 + 输入）
 * 哑组件：完全受控，value/onChange 由上层持有（草稿状态不进组件、不落盘）。
 */

import { memo } from 'react';
import type { ChangeEvent } from 'react';
import './search.css';

export interface SessionSearchProps {
  /** 受控输入值。 */
  value: string;
  /** 输入变化回调（上层持有搜索词并做过滤）。 */
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
}

export const SessionSearch = memo(function SessionSearch({
  value,
  onChange,
  placeholder = '搜索会话...',
  maxLength = 500,
}: SessionSearchProps) {
  function handleChange(e: ChangeEvent<HTMLInputElement>): void {
    onChange(e.target.value);
  }

  return (
    <div className="search-box">
      <svg
        className="search-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        className="search-input"
        type="text"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={handleChange}
      />
    </div>
  );
});
