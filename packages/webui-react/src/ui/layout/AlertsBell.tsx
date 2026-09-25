/**
 * AlertsBell.tsx —— 通知铃铛 + 弹层（自 TopBar 抽出的可复用组件）
 * ============================================================================
 * 参考布局里铃铛挂在左栏底部用户卡旁。哑组件：数据（未读数/列表）与开合态
 * 全部由 props 进，交互经回调上抛；弹层定位相对本组件。
 * ============================================================================
 */

import { memo } from 'react';
import type { AlertItem } from '../../contracts/domain';
import { Icon } from '../primitives/Icon';
import './alertsbell.css';

function defaultFormatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + '\u2026' : id;
}

export interface AlertsBellProps {
  /** 未读数（0 不显示徽标）。 */
  unreadCount?: number;
  /** 弹层展开态（受控）。 */
  open?: boolean;
  onToggle?: () => void;
  alerts?: readonly AlertItem[];
  onClear?: () => void;
  /** 文案覆盖（i18n 接缝）。 */
  title?: string;
  emptyText?: string;
  clearText?: string;
  sessionPrefix?: string;
  /** 时间格式化（缺省 HH:MM:SS）。 */
  formatTime?: (ts: number) => string;
}

export const AlertsBell = memo(function AlertsBell({
  unreadCount = 0,
  open = false,
  onToggle,
  alerts = [],
  onClear,
  title = '\u7cfb\u7edf\u901a\u77e5',
  emptyText = '\u6682\u65e0\u901a\u77e5',
  clearText = '\u6e05\u7a7a',
  sessionPrefix = '\u4f1a\u8bdd',
  formatTime = defaultFormatTime,
}: AlertsBellProps) {
  return (
    <div className="alerts-bell">
      <button
        type="button"
        className="alerts-bell-btn"
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="bell" size={17} strokeWidth={1.9} />
        {unreadCount > 0 && (
          <span className="alerts-bell-badge">{unreadCount > 99 ? '99+' : String(unreadCount)}</span>
        )}
      </button>
      {open && (
        <div className="alerts-popover" role="dialog" aria-label={title}>
          <div className="alerts-popover-header">
            <span className="alerts-popover-title">{title}</span>
          </div>
          <div className="alerts-popover-body">
            {alerts.length === 0 ? (
              <div className="alerts-empty">{emptyText}</div>
            ) : (
              alerts.map((a) => (
                <div key={a.id} className={'alerts-item alerts-item--' + a.level}>
                  <span className="alerts-item-level" aria-hidden="true">
                    {a.level === 'error' ? '\u2715' : a.level === 'warn' ? '!' : 'i'}
                  </span>
                  <div className="alerts-item-main">
                    <div className="alerts-item-msg">{a.msg}</div>
                    <div className="alerts-item-meta">
                      {[a.src || 'system', a.sessionId ? sessionPrefix + ' ' + shortId(a.sessionId) : '', a.count > 1 ? '\u00d7' + a.count : '', formatTime(a.ts)]
                        .filter(Boolean)
                        .join(' \u00b7 ')}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="alerts-popover-footer">
            <button type="button" className="alerts-popover-clear" onClick={onClear}>
              {clearText}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
