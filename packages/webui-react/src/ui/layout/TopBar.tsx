import type { MouseEventHandler, ReactNode } from 'react';
import type { AlertItem } from '../../contracts/domain';
import { Chip } from '../primitives/Chip';
import './topbar.css';

export interface TopBarProps {
  /** 移动端左抽屉按钮点击。 */
  onToggleLeft?: () => void;
  /** 移动端右抽屉按钮点击。 */
  onToggleRight?: () => void;
  /** 品牌 logo 图片地址，默认 /brand-logo.png。 */
  logoSrc?: string;
  /** logo 双击（原 UI：重置 ask_user 弹窗）。 */
  onLogoDoubleClick?: MouseEventHandler<HTMLImageElement>;
  /** 标题文案，默认 "Mcode Web UI"。 */
  title?: ReactNode;
  /** 版本号文案，默认 "v1.0"。 */
  version?: string;
  /** BETA 徽标是否显示，默认 true。 */
  beta?: boolean;
  /** BETA 徽标 title。 */
  betaTitle?: string;

  /** 强制刷新 chip 点击。 */
  onForceReload?: () => void;
  /** 强制刷新中文文案。 */
  forceReloadLabel?: string;

  /** 在线台数（tab 数）。 */
  onlineCount?: number;
  /** 在线 chip title。 */
  onlineTitle?: string;

  /** 只读模式（中英双语 chip）。 */
  readOnly?: boolean;
  readOnlyTitle?: string;

  /** 局域网链接 URL；为空则隐藏 chip。 */
  lanUrl?: string | null;
  /** 局域网链接显示文字。 */
  lanText?: string;
  /** 局域网 chip 点击复制。 */
  onCopyLanUrl?: (url: string) => void;

  /** 通知铃铛未读数。 */
  unreadCount?: number;
  /** 通知弹层是否展开。 */
  alertsOpen?: boolean;
  /** 通知铃铛点击（切换弹层）。 */
  onToggleAlerts?: () => void;
  /** 通知列表。 */
  alerts?: readonly AlertItem[];
  /** 清空通知。 */
  onClearAlerts?: () => void;
  /** 通知会话提示前缀，例如 "会话"。 */
  alertSessionPrefix?: string;
  /** 空通知文案。 */
  alertEmptyText?: string;
  /** 通知标题。 */
  alertsTitle?: string;
  /** 清空按钮文案。 */
  alertsClearText?: string;
  /** 自定义时间格式化（缺省用本地 HH:MM:SS）。 */
  formatTime?: (ts: number) => string;

  /** 附加到状态区右侧的自定义节点。 */
  extra?: ReactNode;
}

function defaultFormatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + '\u2026' : id;
}

/**
 * TopBar —— 顶栏：品牌区 + 状态区（强制刷新 / 在线台数 / 只读 / 局域网链接 / 通知铃铛）。
 * 哑组件：数据由 props 进，交互由 props 的回调出；不 fetch、不读 localStorage。
 */
export function TopBar(props: TopBarProps) {
  const {
    onToggleLeft,
    onToggleRight,
    logoSrc = '/brand-logo.png',
    onLogoDoubleClick,
    title = 'Mcode Web UI',
    version = 'v1.0',
    beta = true,
    betaTitle = 'Beta \u6d4b\u8bd5\u7248',
    onForceReload,
    forceReloadLabel = '\u5f3a\u5236\u5237\u65b0',
    onlineCount,
    onlineTitle = '\u5f53\u524d\u8fde\u5230 webui server \u7684 tab \u6570',
    readOnly,
    readOnlyTitle = 'webui \u5f53\u524d\u5904\u4e8e\u53ea\u8bfb\u6a21\u5f0f / webui is in read-only mode',
    lanUrl,
    lanText,
    onCopyLanUrl,
    unreadCount = 0,
    alertsOpen = false,
    onToggleAlerts,
    alerts = [],
    onClearAlerts,
    alertSessionPrefix = '\u4f1a\u8bdd',
    alertEmptyText = '\u6682\u65e0\u901a\u77e5',
    alertsTitle = '\u7cfb\u7edf\u901a\u77e5',
    alertsClearText = '\u6e05\u7a7a',
    formatTime = defaultFormatTime,
    extra,
  } = props;

  return (
    <header className="topbar">
      <button type="button" className="btn-mobile-toggle" title="菜单" onClick={onToggleLeft} aria-label="菜单">
        <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      <div className="topbar-brand">
        <img
          className="topbar-logo"
          src={logoSrc}
          alt="mcode"
          title="双击重置 ask_user 弹窗"
          onDoubleClick={onLogoDoubleClick}
        />
        <span className="topbar-title">{title}</span>
        <span className="topbar-version">{version}</span>
        {beta && (
          <span className="topbar-beta" title={betaTitle}>
            BETA
          </span>
        )}
      </div>

      <div className="topbar-status">
        {onForceReload && (
          <Chip tone="neutral" onClick={onForceReload} title="强制刷新 (绕过浏览器缓存)" label={forceReloadLabel} icon={<ReloadIcon />} />
        )}

        {onlineCount !== undefined && (
          <Chip tone="neutral" title={onlineTitle} icon={<span>🟢</span>} value={onlineCount + ' \u53f0'} />
        )}

        {readOnly && (
          <Chip
            tone="danger"
            title={readOnlyTitle}
            label={
              <>
                只读
                <span className="chip-readonly-sep">/</span>
                READ ONLY
              </>
            }
          />
        )}

        {lanUrl && (
          <Chip
            tone="neutral"
            title="点击复制局域网访问 URL"
            icon={<PhoneIcon />}
            label={lanText ?? lanUrl}
            onClick={() => onCopyLanUrl?.(lanUrl)}
          />
        )}

        <div className="topbar-alerts">
          <Chip
            tone="neutral"
            title={alertsTitle}
            onClick={onToggleAlerts}
            icon={<BellIcon />}
            value={
              unreadCount > 0 ? (
                <span className="alerts-badge">{unreadCount > 99 ? '99+' : String(unreadCount)}</span>
              ) : undefined
            }
          />
          {alertsOpen && (
            <div className="alerts-popover" role="dialog" aria-label={alertsTitle}>
              <div className="alerts-popover-header">
                <span className="alerts-popover-title">{alertsTitle}</span>
              </div>
              <div className="alerts-popover-body">
                {alerts.length === 0 ? (
                  <div className="alerts-empty">{alertEmptyText}</div>
                ) : (
                  alerts.map((a) => (
                    <div key={a.id} className={'alerts-item alerts-item--' + a.level}>
                      <span className="alerts-item-level" aria-hidden="true">
                        {a.level === 'error' ? '\u2715' : a.level === 'warn' ? '!' : 'i'}
                      </span>
                      <div className="alerts-item-main">
                        <div className="alerts-item-msg">{a.msg}</div>
                        <div className="alerts-item-meta">
                          {[a.src || 'system', a.sessionId ? alertSessionPrefix + ' ' + shortId(a.sessionId) : '', a.count > 1 ? '\u00d7' + a.count : '', formatTime(a.ts)]
                            .filter(Boolean)
                            .join(' \u00b7 ')}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="alerts-popover-footer">
                <button type="button" className="alerts-popover-clear" onClick={onClearAlerts}>
                  {alertsClearText}
                </button>
              </div>
            </div>
          )}
        </div>

        {extra}
      </div>

      <button type="button" className="btn-mobile-toggle btn-mobile-toggle--right" title="详情" onClick={onToggleRight} aria-label="详情">
        <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24" />
        </svg>
      </button>
    </header>
  );
}

function ReloadIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <line x1="12" y1="18" x2="12" y2="18" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
