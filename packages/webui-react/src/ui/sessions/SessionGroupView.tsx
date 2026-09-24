/**
 * SessionGroupView.tsx —— 单个会话分组（工作区分组，可折叠）
 * 折叠态不由组件自己持久化：collapsedKeys + onToggle 由上层持有
 * （上层可把它放进 store/kv 做持久化，组件保持哑）。
 */

import { memo } from 'react';
import type { SessionGroup, SessionId } from '../../contracts/domain';
import { SessionItem } from './SessionItem';
import './list.css';

export interface SessionGroupViewProps {
  group: SessionGroup;
  /** 已折叠分组的 key 集合（由上层持有）。 */
  collapsedKeys: readonly string[];
  /** 折叠/展开切换。 */
  onToggle: (key: string) => void;
  /** 当前活跃会话 id（高亮）。 */
  activeSessionId: SessionId | null;
  onSelect: (id: SessionId) => void;
  onRename: (id: SessionId, title: string) => void;
  onDelete: (id: SessionId) => void;
}

export const SessionGroupView = memo(function SessionGroupView({
  group,
  collapsedKeys,
  onToggle,
  activeSessionId,
  onSelect,
  onRename,
  onDelete,
}: SessionGroupViewProps) {
  const collapsed = collapsedKeys.includes(group.key);

  return (
    <section
      className={collapsed ? 'workspace-group workspace-group--collapsed' : 'workspace-group'}
    >
      <div
        className="workspace-group-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        title={group.label}
        onClick={() => onToggle(group.key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onToggle(group.key);
        }}
      >
        <span className="workspace-group-chevron" aria-hidden="true">
          ▶
        </span>
        <span className="workspace-group-name">{group.label}</span>
        <span className="workspace-group-count">{group.sessions.length}</span>
      </div>
      {collapsed ? null : (
        <div className="workspace-group-items">
          {group.sessions.length === 0 ? (
            <div className="workspace-group-empty">（空）</div>
          ) : (
            group.sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
});
