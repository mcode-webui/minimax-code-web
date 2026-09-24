/**
 * ui/composer/WorkspacePicker.tsx —— 切换工作区弹层（哑组件）
 * ============================================================================
 * 视觉职责：锚定弹层 —— 标题「切换工作区」、搜索框、最近工作区列表（当前项
 * 打勾）、底部分隔线 + 「选择目录」「无需工作空间」两按钮。
 * 对齐 vanilla .workspace-picker / .ws-picker-* 样式。
 * ============================================================================
 */
import './wspicker.css';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useMemo, useState } from 'react';

import type { WorkspaceEntry } from '../../contracts/domain';

/** 最近工作区条目（在 domain 的 WorkspaceEntry 上附加可选会话数角标）。 */
export interface WorkspaceRecent extends WorkspaceEntry {
  sessionCount?: number;
}

export interface WorkspacePickerProps {
  open: boolean;
  /** 最近工作区列表（搜索词在组件内过滤 name/path）。 */
  recents: WorkspaceRecent[];
  /** 当前工作区路径；null / '' 表示无工作区。 */
  currentPath: string | null;
  /** 选中某个最近工作区。 */
  onSelect: (path: string) => void;
  /** 「选择目录」。 */
  onPickDirectory: () => void;
  /** 「无需工作空间」。 */
  onNoWorkspace: () => void;
  /** Esc 关闭。 */
  onClose: () => void;
  title?: string;
  loading?: boolean;
}

/** 纯过滤函数：按 name / path 匹配搜索词。 */
export function filterRecents(recents: WorkspaceRecent[], query: string): WorkspaceRecent[] {
  const q = query.trim().toLowerCase();
  if (!q) return recents;
  return recents.filter(
    (r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
  );
}

export function WorkspacePicker(props: WorkspacePickerProps) {
  const {
    open,
    recents,
    currentPath,
    onSelect,
    onPickDirectory,
    onNoWorkspace,
    onClose,
    title = '切换工作区',
    loading = false,
  } = props;

  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterRecents(recents, query), [recents, query]);

  if (!open) return null;

  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = filtered[0];
      if (first) onSelect(first.path);
    }
  };

  return (
    <div className="wspicker" role="dialog" aria-label={title}>
      <div className="wspicker-title">{title}</div>

      <div className="wspicker-search-wrap">
        <svg
          className="wspicker-search-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="wspicker-search"
          value={query}
          placeholder="搜索工作区…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
      </div>

      <div className="wspicker-recent-list">
        {loading ? <div className="wspicker-recent-loading">加载中...</div> : null}
        {!loading && filtered.length === 0 ? (
          <div className="wspicker-recent-empty">暂无工作区</div>
        ) : null}
        {filtered.map((r) => {
          const active = !!currentPath && r.path === currentPath;
          return (
            <button
              key={r.path}
              type="button"
              className={active ? 'wspicker-recent-item active' : 'wspicker-recent-item'}
              onClick={() => onSelect(r.path)}
            >
              <svg
                className="wspicker-recent-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="wspicker-recent-info">
                <span className="wspicker-recent-name">{r.name}</span>
                <span className="wspicker-recent-path">{r.path}</span>
              </span>
              {typeof r.sessionCount === 'number' ? (
                <span className="wspicker-recent-count">{r.sessionCount}</span>
              ) : null}
              {active ? <span className="wspicker-check" aria-hidden="true">✓</span> : null}
            </button>
          );
        })}
      </div>

      <div className="wspicker-divider" />

      <div className="wspicker-actions-row">
        <button type="button" className="wspicker-action primary" onClick={onPickDirectory}>
          <svg
            className="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>选择目录</span>
        </button>
        <button type="button" className="wspicker-action" onClick={onNoWorkspace}>
          无需工作空间
        </button>
      </div>
    </div>
  );
}
