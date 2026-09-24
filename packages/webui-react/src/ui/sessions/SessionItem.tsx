/**
 * SessionItem.tsx —— 单条会话（标题、工作区缩写、更新时间、hover 操作按钮、当前会话高亮）
 * ============================================================================
 * 哑组件：会话数据由 props 进，重命名/删除/选中全部经 props 回调出。
 * 组件只保留"重命名输入框/删除确认条"这类瞬时视图状态（不持久化、不跨会话）。
 * 当前活跃会话由 active 高亮（结构性的会话隔离显示）。
 * ============================================================================
 */

import { memo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { SessionId, SessionSummary } from '../../contracts/domain';
import './item.css';

export interface SessionItemProps {
  session: SessionSummary;
  /** 是否当前活跃会话（高亮）。 */
  active: boolean;
  onSelect: (id: SessionId) => void;
  onRename: (id: SessionId, title: string) => void;
  onDelete: (id: SessionId) => void;
}

/** 工作区缩写：路径末段的前两个字符大写；无工作区显示 —。纯派生，无 IO。 */
export function workspaceAbbrev(workspace: string | null): string {
  if (workspace === null || workspace === '') return '—';
  const trimmed = workspace.replace(/[\/]+$/, '');
  const seg = trimmed.split(/[\/]/).pop() ?? trimmed;
  const letters = seg.replace(/[^0-9a-zA-Z]/g, '');
  if (letters.length === 0) return seg.slice(0, 2).toUpperCase() || '—';
  return letters.slice(0, 2).toUpperCase();
}

/** 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期）。纯派生，无 IO。 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  if (ts <= 0) return '—';
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return String(Math.floor(diff / 60_000)) + ' 分钟前';
  if (diff < 86_400_000) return String(Math.floor(diff / 3_600_000)) + ' 小时前';
  if (diff < 7 * 86_400_000) return String(Math.floor(diff / 86_400_000)) + ' 天前';
  const d = new Date(ts);
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: SessionItemProps) {
  // 瞬时视图状态（不持久化、不跨会话复用）
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function handleClick(): void {
    if (renaming || confirming) return;
    onSelect(session.id);
  }

  function startRename(): void {
    setDraft(session.title);
    setRenaming(true);
    setConfirming(false);
  }

  // 去重守卫：Enter 提交会 setRenaming(false) 卸载 input，浏览器随后触发的 blur
  // 会再进一次 commitRename。记住上次已提交的标题，避免同一次重命名回调两次。
  const lastCommittedTitle = useRef<string | null>(null);

  function commitRename(): void {
    const title = draft.trim();
    setRenaming(false);
    if (title === '' || title === session.title) return;
    if (lastCommittedTitle.current === title) return;
    lastCommittedTitle.current = title;
    onRename(session.id, title);
  }

  function cancelRename(): void {
    setRenaming(false);
    setDraft(session.title);
  }

  function handleRenameKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  function handleDraftChange(e: ChangeEvent<HTMLInputElement>): void {
    setDraft(e.target.value);
  }

  function confirmDelete(): void {
    setConfirming(false);
    onDelete(session.id);
  }

  const cls = [
    'session-item',
    active ? 'session-item--active' : '',
    renaming ? 'session-item--renaming' : '',
    confirming ? 'session-item--confirming' : '',
  ]
    .filter((s) => s !== '')
    .join(' ');

  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleClick();
      }}
    >
      <span className="session-ws-badge" title={session.workspace ?? '（无工作区）'}>
        {workspaceAbbrev(session.workspace)}
      </span>
      {renaming ? (
        <input
          ref={inputRef}
          className="session-rename-input"
          value={draft}
          maxLength={200}
          autoFocus
          onChange={handleDraftChange}
          onBlur={commitRename}
          onKeyDown={handleRenameKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="session-info">
          <div className="session-name" title={session.title}>
            {session.title}
          </div>
        </div>
      )}
      <span className="session-time">{formatRelativeTime(session.updatedAt)}</span>
      <button
        type="button"
        className="session-action session-rename"
        title="重命名"
        aria-label="重命名会话"
        onClick={(e) => {
          e.stopPropagation();
          startRename();
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="session-action session-delete"
        title="删除"
        aria-label="删除会话"
        onClick={(e) => {
          e.stopPropagation();
          setConfirming(true);
        }}
      >
        ×
      </button>
      {confirming ? (
        <div className="session-confirm" onClick={(e) => e.stopPropagation()}>
          <span>删除？</span>
          <button type="button" className="session-confirm-yes" onClick={confirmDelete}>
            是
          </button>
          <button type="button" className="session-confirm-no" onClick={() => setConfirming(false)}>
            否
          </button>
        </div>
      ) : null}
    </div>
  );
});
