/**
 * SessionList.tsx —— 左栏会话列表（哑组件）
 * ============================================================================
 * 吃 SessionGroup[]（上层用 domain.ts 的 groupSessionsByWorkspace 生成），
 * 按组渲染可折叠分组；每组标题 = 工作区路径 + 会话数 + 折叠箭头。
 * 折叠态经 collapsedKeys/onToggle 由上层持有；当前会话经 activeSessionId 高亮。
 * 会话隔离：每条会话只渲染自己的 summary，动作回调带 id 出参，组件不存任何会话态。
 * ============================================================================
 */

import { memo } from 'react';
import type { SessionGroup, SessionId } from '../../contracts/domain';
import { SessionGroupView } from './SessionGroupView';
import './list.css';

export interface SessionListProps {
  groups: SessionGroup[];
  /** 当前活跃会话 id（高亮）。 */
  activeSessionId: SessionId | null;
  /** 已折叠分组 key（由上层持有，组件不持久化）。 */
  collapsedKeys: readonly string[];
  onToggleGroup: (key: string) => void;
  onSelect: (id: SessionId) => void;
  onRename: (id: SessionId, title: string) => void;
  onDelete: (id: SessionId) => void;
  /** 空列表文案（默认"暂无会话记录"，对齐 vanilla data-i18n="no_sessions"）。 */
  emptyText?: string;
}

export const SessionList = memo(function SessionList({
  groups,
  activeSessionId,
  collapsedKeys,
  onToggleGroup,
  onSelect,
  onRename,
  onDelete,
  emptyText = '暂无会话记录',
}: SessionListProps) {
  if (groups.length === 0) {
    return <div className="sessions-empty">{emptyText}</div>;
  }
  return (
    <div className="sessions-list">
      {groups.map((group) => (
        <SessionGroupView
          key={group.key}
          group={group}
          collapsedKeys={collapsedKeys}
          onToggle={onToggleGroup}
          activeSessionId={activeSessionId}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
});
