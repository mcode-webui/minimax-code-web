import type { ReactNode } from 'react';
import { MenuRow } from '../primitives/MenuRow';
import { PopoverCard } from '../primitives/PopoverCard';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import './left.css';

export interface UsagePopoverContent {
  /** 用量行 / 说明等自定义内容。 */
  body?: ReactNode;
  /** 加载中 / 错误文案（二选一由上层决定）。 */
  status?: ReactNode;
}

export interface LanTokenState {
  /** Token 鉴权开关是否可用（false = 显示"已关闭"占位）。 */
  enabled: boolean;
  /** 当前 token；空串表示无 token（显示"已保存"占位）。 */
  token: string;
  /** 是否明文显示。 */
  visible: boolean;
  /** 是否显示"新的 token"警告 + "我已保存"按钮。 */
  showWarning: boolean;
}

export interface LeftPanelProps {
  /** 移动端抽屉是否展开。 */
  open?: boolean;

  /** 新建会话按钮点击。 */
  onNewSession?: () => void;
  /** 搜索框文案覆盖。 */
  newChatText?: string;
  /** 搜索框 placeholder。 */
  searchPlaceholder?: string;
  /** 搜索关键字（受控）。 */
  searchValue?: string;
  /** 搜索输入变化。 */
  onSearchChange?: (value: string) => void;

  /** 会话区标题，默认"会话列表"。 */
  sessionsTitle?: string;
  /** 刷新会话列表。 */
  onRefreshSessions?: () => void;
  /** 刷新按钮文案。 */
  refreshText?: string;
  /** 刷新按钮是否 loading。 */
  refreshing?: boolean;
  /** 空列表文案，默认"暂无会话记录"。 */
  emptyText?: string;
  /** 会话列表内容（children 或 renderList 二选一）。 */
  children?: ReactNode;
  /** 会话列表渲染函数（当需要延迟求值时用）。 */
  renderList?: () => ReactNode;

  /** 套餐用量按钮值，例如 "12%"。 */
  usageValue?: ReactNode;
  /** 套餐用量按钮是否隐藏（关闭用量功能时整块消失）。 */
  usageHidden?: boolean;
  /** 套餐用量按钮点击（展开弹层）。 */
  onToggleUsage?: () => void;
  /** 套餐用量弹层展开态。 */
  usageOpen?: boolean;
  /** 套餐用量弹层内容。 */
  usage?: UsagePopoverContent;
  /** 套餐用量弹层刷新。 */
  onRefreshUsage?: () => void;
  /** 套餐用量标题 / 弹层标题。 */
  usageText?: string;

  /** 外观按钮值，例如"明亮"/"深色"。 */
  appearanceValue?: ReactNode;
  /** 外观按钮点击。 */
  onToggleAppearance?: () => void;
  /** 外观卡片展开态。 */
  appearanceOpen?: boolean;
  /** 主题是否为深色。 */
  dark?: boolean;
  /** 主题切换。 */
  onToggleTheme?: (dark: boolean) => void;
  /** 用量显示开关（关掉后套餐用量按钮消失）。 */
  showUsage?: boolean;
  /** 用量显示开关切换。 */
  onToggleShowUsage?: (show: boolean) => void;

  /** 语言按钮值，例如"简体中文"。 */
  languageValue?: ReactNode;
  /** 语言按钮点击。 */
  onToggleLanguage?: () => void;

  /** 局域网访问按钮值，例如"开"/"关"。 */
  lanValue?: ReactNode;
  /** 局域网访问按钮点击（展开安全卡片）。 */
  onToggleLan?: () => void;
  /** 局域网安全卡片展开态。 */
  lanOpen?: boolean;
  /** 局域网广播开关。 */
  lanBroadcast?: boolean;
  onToggleLanBroadcast?: (on: boolean) => void;
  /** 只读模式开关。 */
  readOnly?: boolean;
  onToggleReadOnly?: (on: boolean) => void;
  /** Token 鉴权开关。 */
  tokenAuth?: boolean;
  onToggleTokenAuth?: (on: boolean) => void;
  /** Token 区状态。 */
  token?: LanTokenState;
  /** 显示 / 隐藏 token。 */
  onToggleTokenVisible?: () => void;
  /** 复制 token。 */
  onCopyToken?: () => void;
  /** 重置 token。 */
  onResetToken?: () => void;
  /** "我已保存"。 */
  onAcknowledgeToken?: () => void;

  /** GitHub 链接地址。 */
  githubHref?: string;

  /** 各类文案覆盖（i18n 接缝）。 */
  labels?: Partial<LeftPanelLabels>;
}

export interface LeftPanelLabels {
  usage: string;
  appearance: string;
  language: string;
  lanAccess: string;
  lanOn: string;
  lanOff: string;
  appearanceTitle: string;
  themeLabel: string;
  themeHelp: string;
  showUsageLabel: string;
  showUsageHelp: string;
  lanCardTitle: string;
  lanBroadcastLabel: string;
  readOnlyLabel: string;
  readOnlyHelp: string;
  tokenAuthLabel: string;
  tokenAuthHelp: string;
  tokenValueLabel: string;
  tokenShow: string;
  tokenHide: string;
  tokenCopy: string;
  tokenReset: string;
  tokenAck: string;
  tokenAckHelp: string;
  tokenNewWarning: string;
  tokenSavedPlaceholder: string;
  tokenDisabledPlaceholder: string;
  usageRefresh: string;
  usageLoading: string;
}

const DEFAULT_LABELS: LeftPanelLabels = {
  usage: '\u5957\u9910\u7528\u91cf',
  appearance: '\u5916\u89c2',
  language: '\u8bed\u8a00',
  lanAccess: '\u5c40\u57df\u7f51\u8bbf\u95ee',
  lanOn: '\u5f00',
  lanOff: '\u5173',
  appearanceTitle: '\u5916\u89c2',
  themeLabel: '\u4e3b\u9898',
  themeHelp: '\u5207\u6362\u4eae\u8272/\u6df1\u8272\u4e3b\u9898',
  showUsageLabel: '\u542f\u7528',
  showUsageHelp: '\u5173\u6389\u540e\uff0c\u5957\u9910\u7528\u91cf\u6309\u94ae\u5728\u4e3b\u754c\u9762\u6d88\u5931',
  lanCardTitle: '\u5c40\u57df\u7f51\u5b89\u5168\u8bbe\u7f6e',
  lanBroadcastLabel: '\u5c40\u57df\u7f51\u8bbf\u95ee',
  readOnlyLabel: '\u53ea\u8bfb\u6a21\u5f0f',
  readOnlyHelp: '\u8fdc\u7a0b\u5ba2\u6237\u7aef\u53ea\u80fd\u8bfb\u53d6\uff0c\u4e0d\u80fd\u53d1\u9001\u6d88\u606f/\u5220\u9664\u4f1a\u8bdd',
  tokenAuthLabel: 'Token \u9274\u6743',
  tokenAuthHelp: '\u9700\u8981 ?token= \u6216 Authorization header\uff1b\u672c\u673a\u4e0d\u53d7\u9650',
  tokenValueLabel: '\u5f53\u524d token',
  tokenShow: '\u663e\u793a',
  tokenHide: '\u9690\u85cf',
  tokenCopy: '\u590d\u5236',
  tokenReset: '\u91cd\u7f6e token',
  tokenAck: '\u6211\u5df2\u4fdd\u5b58',
  tokenAckHelp: '\u4fdd\u5b58\u540e token \u4e0d\u4f1a\u518d\u6b21\u663e\u793a\uff1b\u4e0b\u6b21\u9700\u8981\u67e5\u770b\u53ef\u70b9"\u91cd\u7f6e"',
  tokenNewWarning: '\u65b0\u7684 token \u2014 \u8bf7\u5728\u53e6\u4e00\u53f0\u8bbe\u5907\u7528\u4e0a\u9762\u7684 URL \u6253\u5f00',
  tokenSavedPlaceholder: '\u2713 \u5df2\u4fdd\u5b58 \u2014 \u67e5\u770b\u8bf7\u70b9"\u91cd\u7f6e"',
  tokenDisabledPlaceholder: '\u2014 Token \u9274\u6743\u5df2\u5173\u95ed',
  usageRefresh: '\u5237\u65b0',
  usageLoading: '\u52a0\u8f7d\u4e2d...',
};

/**
 * LeftPanel —— 左栏：新建会话 + 搜索 + 会话滚动区 + 底部功能区。
 * 哑组件：会话列表内容由 children / renderList 注入，所有交互经回调上抛。
 */
export function LeftPanel(props: LeftPanelProps) {
  const {
    open,
    onNewSession,
    newChatText = '\u65b0\u5efa\u4f1a\u8bdd',
    searchPlaceholder = '\u641c\u7d22\u4f1a\u8bdd...',
    searchValue,
    onSearchChange,
    sessionsTitle = '\u4f1a\u8bdd\u5217\u8868',
    onRefreshSessions,
    refreshText = '\u5237\u65b0',
    refreshing = false,
    emptyText = '\u6682\u65e0\u4f1a\u8bdd\u8bb0\u5f55',
    children,
    renderList,
    usageValue,
    usageHidden = false,
    onToggleUsage,
    usageOpen = false,
    usage,
    onRefreshUsage,
    usageText,
    appearanceValue,
    onToggleAppearance,
    appearanceOpen = false,
    dark = false,
    onToggleTheme,
    showUsage = true,
    onToggleShowUsage,
    languageValue,
    onToggleLanguage,
    lanValue,
    onToggleLan,
    lanOpen = false,
    lanBroadcast = false,
    onToggleLanBroadcast,
    readOnly = false,
    onToggleReadOnly,
    tokenAuth = false,
    onToggleTokenAuth,
    token,
    onToggleTokenVisible,
    onCopyToken,
    onResetToken,
    onAcknowledgeToken,
    githubHref = 'https://github.com/Wzdhehe/mcode-webui',
    labels,
  } = props;

  const l: LeftPanelLabels = { ...DEFAULT_LABELS, ...labels };
  const list = renderList ? renderList() : children;

  return (
    <aside className={open ? 'left-panel left-panel--open' : 'left-panel'}>
      <div className="left-section">
        <button type="button" className="btn-new" onClick={onNewSession}>
          <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>{newChatText}</span>
        </button>
        <div className="search-box">
          <svg className="icon search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="search-input"
            type="text"
            maxLength={500}
            placeholder={searchPlaceholder}
            value={searchValue ?? ''}
            onChange={(e) => onSearchChange?.(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="sessions-scroll">
        <div className="sessions-header">
          <span className="sessions-header-title">{sessionsTitle}</span>
          <button type="button" className="btn-refresh-sessions" onClick={onRefreshSessions} disabled={refreshing} title={refreshText}>
            <svg className={refreshing ? 'icon icon--spin' : 'icon'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span>{refreshText}</span>
          </button>
        </div>
        <div className="sessions-list">
          {list == null || (Array.isArray(list) && list.length === 0) ? (
            <div className="session-title-empty">{emptyText}</div>
          ) : (
            list
          )}
        </div>
      </div>

      <div className="left-bottom">
        {!usageHidden && (
          <PopoverCard
            open={usageOpen}
            onOpenChange={(o) => {
              if (!o) onToggleUsage?.();
            }}
            placement="right"
            anchor={
              <MenuRow
                icon={<ChartIcon />}
                text={usageText ?? l.usage}
                value={usageValue ?? '\u2014'}
                onClick={onToggleUsage}
                expanded={usageOpen}
              />
            }
          >
            <div className="usage-popover-header">
              <span className="usage-popover-title">{usageText ?? l.usage}</span>
              <button type="button" className="usage-popover-refresh" onClick={onRefreshUsage} title={l.usageRefresh}>
                <span>{l.usageRefresh}</span>
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            </div>
            <div className="usage-popover-body">
              {usage?.status ?? usage?.body ?? <div className="usage-loading">{l.usageLoading}</div>}
            </div>
          </PopoverCard>
        )}

        <PopoverCard
          open={appearanceOpen}
          onOpenChange={(o) => {
            if (!o) onToggleAppearance?.();
          }}
          placement="right"
          anchor={
            <MenuRow
              icon={<SunIcon />}
              text={l.appearance}
              value={appearanceValue ?? '\u2014'}
              onClick={onToggleAppearance}
              expanded={appearanceOpen}
            />
          }
        >
          <div className="lan-card">
            <div className="lan-card-title">{l.appearanceTitle}</div>
            <div className="lan-card-row">
              <div className="lan-card-row-label">
                <span>{l.themeLabel}</span>
                <span className="lan-card-row-help">{l.themeHelp}</span>
              </div>
              <ToggleSwitch checked={dark} onChange={(v) => onToggleTheme?.(v)} label={l.themeLabel} />
            </div>
            <div className="lan-card-row">
              <div className="lan-card-row-label">
                <span>{l.showUsageLabel}</span>
                <span className="lan-card-row-help">{l.showUsageHelp}</span>
              </div>
              <ToggleSwitch checked={showUsage} onChange={(v) => onToggleShowUsage?.(v)} label={l.showUsageLabel} />
            </div>
          </div>
        </PopoverCard>

        <MenuRow icon={<GlobeIcon />} text={l.language} value={languageValue ?? '\u2014'} onClick={onToggleLanguage} />

        <PopoverCard
          open={lanOpen}
          onOpenChange={(o) => {
            if (!o) onToggleLan?.();
          }}
          placement="right"
          anchor={
            <MenuRow
              icon={<WifiIcon />}
              text={l.lanAccess}
              value={lanValue ?? (lanBroadcast ? l.lanOn : l.lanOff)}
              valueTone={lanBroadcast ? 'on' : 'neutral'}
              onClick={onToggleLan}
              expanded={lanOpen}
              ariaLabel={l.lanAccess}
            />
          }
        >
          <div className="lan-card">
            <div className="lan-card-title">{l.lanCardTitle}</div>

            <div className="lan-card-row">
              <div className="lan-card-row-label">
                <span>{l.lanBroadcastLabel}</span>
              </div>
              <ToggleSwitch checked={lanBroadcast} onChange={(v) => onToggleLanBroadcast?.(v)} label={l.lanBroadcastLabel} />
            </div>

            <div className="lan-card-row">
              <div className="lan-card-row-label">
                <span>{l.readOnlyLabel}</span>
                <span className="lan-card-row-help">{l.readOnlyHelp}</span>
              </div>
              <ToggleSwitch checked={readOnly} onChange={(v) => onToggleReadOnly?.(v)} label={l.readOnlyLabel} />
            </div>

            <div className="lan-card-row">
              <div className="lan-card-row-label">
                <span>{l.tokenAuthLabel}</span>
                <span className="lan-card-row-help">{l.tokenAuthHelp}</span>
              </div>
              <ToggleSwitch checked={tokenAuth} onChange={(v) => onToggleTokenAuth?.(v)} label={l.tokenAuthLabel} />
            </div>

            <div className="lan-card-section">
              <div className="lan-card-section-label">{l.tokenValueLabel}</div>
              {!token || !token.enabled ? (
                <div className="lan-card-token-row">
                  <span className="lan-card-token-placeholder">{l.tokenDisabledPlaceholder}</span>
                </div>
              ) : !token.token ? (
                <div className="lan-card-token-row">
                  <span className="lan-card-token-placeholder">{l.tokenSavedPlaceholder}</span>
                </div>
              ) : (
                <div className="lan-card-token-row">
                  {token.visible ? (
                    <span className="lan-card-token-value">{token.token}</span>
                  ) : (
                    <span className="lan-card-token-mask">••••••••••••••••••••••••••••••••</span>
                  )}
                  <button type="button" className="lan-card-btn" onClick={onToggleTokenVisible}>
                    {token.visible ? l.tokenHide : l.tokenShow}
                  </button>
                  <button type="button" className="lan-card-btn" onClick={onCopyToken}>
                    {l.tokenCopy}
                  </button>
                </div>
              )}

              {token?.showWarning && (
                <div className="lan-card-warning">
                  <span>{l.tokenNewWarning}</span>
                </div>
              )}

              <div className="lan-card-actions">
                <button type="button" className="lan-card-btn lan-card-btn-danger" onClick={onResetToken}>
                  {l.tokenReset}
                </button>
                {token?.showWarning && (
                  <button type="button" className="lan-card-btn lan-card-btn-primary" onClick={onAcknowledgeToken}>
                    {l.tokenAck}
                  </button>
                )}
              </div>
              <div className="lan-card-help">{l.tokenAckHelp}</div>
            </div>
          </div>
        </PopoverCard>

        <a className="user-footer github-link" href={githubHref} target="_blank" rel="noopener noreferrer" title="mcode-webui on GitHub">
          <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.58.23 2.75.11 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
          </svg>
          <span>GitHub</span>
        </a>
      </div>
    </aside>
  );
}

function ChartIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="3" y1="20" x2="21" y2="20" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}
