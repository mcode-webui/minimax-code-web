/**
 * LeftPanel.tsx —— 左栏（参考布局版）
 * ============================================================================
 * 结构（自上而下）：
 *   1. 新建任务（主按钮，右侧云图标）
 *   2. 环境切换（本地 / 云端 —— webui 仅本地，云端为禁用占位）
 *   3. 功能导航（插件 / 定时 / 网站 / 远程 —— webui 暂无对应后端，禁用占位）
 *   4. 项目（工作区分组会话树：children / renderList 注入 + 搜索 + 刷新）
 *   5. 底部：用量 / 外观 / 语言 / 局域网 弹层 + 重载页面 + GitHub + 用户卡（铃铛）
 * 哑组件：会话列表内容由 children / renderList 注入，所有交互经回调上抛。
 * ============================================================================
 */

import type { CSSProperties, ReactNode } from 'react';
import { MenuRow } from '../primitives/MenuRow';
import { PopoverCard } from '../primitives/PopoverCard';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { Icon } from '../primitives/Icon';
import { ResizeHandle } from '../primitives/ResizeHandle';
import { AlertsBell, type AlertsBellProps } from './AlertsBell';
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
  /** 新建按钮文案，默认"新建任务"。 */
  newChatText?: string;
  /** 搜索框 placeholder。 */
  searchPlaceholder?: string;
  /** 搜索关键字（受控）。 */
  searchValue?: string;
  /** 搜索输入变化。 */
  onSearchChange?: (value: string) => void;

  /** 会话区标题，默认"项目"。 */
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

  /** 重载页面（原顶栏"强制刷新"迁移至此）。 */
  onReload?: () => void;
  /** 重载文案，默认"重载页面"。 */
  reloadText?: string;

  /** 面板宽度（可拖拽调整，受控）。 */
  width?: number;
  onResizeWidth?: (delta: number) => void;
  onResetWidth?: () => void;

  /** GitHub 链接地址。 */
  githubHref?: string;

  /** 用户卡：品牌标题（默认 Mcode Web UI）。 */
  brandTitle?: string;
  /** 用户卡：副标题（默认 v1.0 · BETA）。 */
  brandSub?: string;
  /** 用户卡头像图片地址。 */
  logoSrc?: string;
  /** 通知铃铛（弹层数据与开合由上层持有）。 */
  alerts?: AlertsBellProps;

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
  /** 参考布局新增：功能导航（占位）与环境切换。 */
  navPlugins: string;
  navTimer: string;
  navSites: string;
  navRemote: string;
  navSoon: string;
  envLocal: string;
  envCloud: string;
  envCloudTitle: string;
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
  navPlugins: '\u63d2\u4ef6',
  navTimer: '\u5b9a\u65f6',
  navSites: '\u7f51\u7ad9',
  navRemote: '\u8fdc\u7a0b',
  navSoon: '\u5373\u5c06\u4e0a\u7ebf',
  envLocal: '\u672c\u5730',
  envCloud: '\u4e91\u7aef',
  envCloudTitle: 'webui \u4ec5\u652f\u6301\u672c\u5730\u8fd0\u884c',
};

/**
 * LeftPanel —— 左栏：新建任务 + 导航 + 项目会话树 + 底部功能区。
 * 哑组件：会话列表内容由 children / renderList 注入，所有交互经回调上抛。
 */
export function LeftPanel(props: LeftPanelProps) {
  const {
    open,
    onNewSession,
    newChatText = '\u65b0\u5efa\u4efb\u52a1',
    searchPlaceholder = '\u641c\u7d22\u9879\u76ee / \u4f1a\u8bdd...',
    searchValue,
    onSearchChange,
    sessionsTitle = '\u9879\u76ee',
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
    onReload,
    reloadText = '\u91cd\u8f7d\u9875\u9762',
    width,
    onResizeWidth,
    onResetWidth,
    githubHref = 'https://github.com/Wzdhehe/mcode-webui',
    brandTitle = 'Mcode Web UI',
    brandSub = 'v1.0 \u00b7 BETA',
    logoSrc = '/brand-logo.png',
    alerts,
    labels,
  } = props;

  const l: LeftPanelLabels = { ...DEFAULT_LABELS, ...labels };
  const list = renderList ? renderList() : children;

  return (
    <aside
      className={open ? 'left-panel left-panel--open' : 'left-panel left-panel--closed'}
      style={width !== undefined ? ({ '--panel-w': width + 'px' } as CSSProperties) : undefined}
    >
      {/* ── 顶部：新建任务 + 环境切换 + 功能导航 ── */}
      <div className="left-top">
        <button type="button" className="btn-new" onClick={onNewSession}>
          <Icon name="plus" size={14} strokeWidth={2.2} className="btn-new-plus" />
          <span className="btn-new-text">{newChatText}</span>
          <Icon name="cloud" size={15} className="btn-new-cloud" />
        </button>

        <div className="env-switch" role="group" aria-label={l.envLocal + ' / ' + l.envCloud}>
          <button type="button" className="env-opt env-opt--on">
            <Icon name="monitor" size={13} strokeWidth={2} />
            <span>{l.envLocal}</span>
          </button>
          <button type="button" className="env-opt" disabled title={l.envCloudTitle}>
            <Icon name="cloud" size={13} strokeWidth={2} />
            <span>{l.envCloud}</span>
          </button>
        </div>

        <nav className="left-nav" aria-label={l.navSoon}>
          <MenuRow icon={<Icon name="puzzle" size={16} />} text={l.navPlugins} value={l.navSoon} disabled title={l.navSoon} />
          <MenuRow icon={<Icon name="clock" size={16} />} text={l.navTimer} value={l.navSoon} disabled title={l.navSoon} />
          <MenuRow icon={<Icon name="globe" size={16} />} text={l.navSites} value={l.navSoon} disabled title={l.navSoon} />
          <MenuRow icon={<Icon name="monitor" size={16} />} text={l.navRemote} value={l.navSoon} disabled title={l.navSoon} />
        </nav>
      </div>

      {/* ── 中部：项目（工作区分组会话树）── */}
      <div className="sessions-scroll">
        <div className="sessions-header">
          <span className="sessions-header-title">{sessionsTitle}</span>
          <button type="button" className="btn-refresh-sessions" onClick={onRefreshSessions} disabled={refreshing} title={refreshText}>
            <Icon name="refresh" size={12} className={refreshing ? 'icon--spin' : undefined} />
            <span>{refreshText}</span>
          </button>
        </div>
        <div className="search-box">
          <Icon name="search" size={14} className="search-icon" />
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
        <div className="sessions-list">
          {list == null || (Array.isArray(list) && list.length === 0) ? (
            <div className="session-title-empty">{emptyText}</div>
          ) : (
            list
          )}
        </div>
      </div>

      {/* ── 底部：设置弹层 + 用户卡 ── */}
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
                icon={<Icon name="chart" size={16} />}
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
                <Icon name="refresh" size={13} />
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
              icon={<Icon name="sun" size={16} />}
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

        <MenuRow icon={<Icon name="globe" size={16} />} text={l.language} value={languageValue ?? '\u2014'} onClick={onToggleLanguage} />

        <PopoverCard
          open={lanOpen}
          onOpenChange={(o) => {
            if (!o) onToggleLan?.();
          }}
          placement="right"
          anchor={
            <MenuRow
              icon={<Icon name="wifi" size={16} />}
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
                    <span className="lan-card-token-mask">{'\u2022'.repeat(28)}</span>
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

        {onReload && <MenuRow icon={<Icon name="refresh" size={16} />} text={reloadText} onClick={onReload} />}

        {/* 用户卡：头像 + 品牌 + GitHub + 通知铃铛（参考布局底部） */}
        <div className="user-card">
          <img className="user-card-avatar" src={logoSrc} alt={brandTitle} />
          <div className="user-card-main">
            <div className="user-card-name">{brandTitle}</div>
            <div className="user-card-sub">{brandSub}</div>
          </div>
          <a className="user-card-github" href={githubHref} target="_blank" rel="noopener noreferrer" title="mcode-webui on GitHub" aria-label="GitHub">
            <Icon name="github" size={17} />
          </a>
          <AlertsBell {...alerts} />
        </div>
      </div>
      {onResizeWidth ? (
        <ResizeHandle
          width={width ?? 240}
          onWidthChange={(w) => onResizeWidth(w - (width ?? 240))}
          onReset={onResetWidth}
        />
      ) : null}
    </aside>
  );
}
