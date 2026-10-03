"use client";

/**
 * Settings-modal port (webui-parity 58, line A).
 *
 * 结构/行为/形态照搬参照包 other-minimax-code 的
 * `packages/webui/src/client/components/SettingsModal.tsx`（10 Tab 四分组
 * 弹窗外壳 + 搜索过滤 + 通用页全区块）与
 * `settings/UsageModelSettings.tsx`（用量与模型的三来源切换头），
 * CSS 类体系（webui-settings-* / webui-generic-* / webui-mode-* …）
 * 随 `styles/settings-modal.css` 整块搬运，见该文件头注释。
 *
 * 与参照的适配点（只动适配层，不动形态）：
 *
 *  - Tab 内容的落点接本仓现有能力：desktop → 参照 GenericPage（文件区
 *    两开关、会话管理、偏好设置沿用 `lib/settings-local.ts` 的同一批
 *    localStorage key）；usage → 三来源切换头，token-plan 落点复用 53 号
 *    的 `UsageModelsSection`（headless，只出四张卡）、custom 落点复用 54
 *    号 `ProviderManagementPanel`；connection → 本仓既有连接面板。
 *  - minimax-api 来源：SB-1 起接真后端（`GET/PUT /api/model-source`、
 *    `PUT /api/model-source/api-key`、`POST /api/model-source/test`，
 *    服务端 `server/engine/model-source.js` 消费引擎的
 *    `getMiniMaxModelSource` / `setMiniMaxModelSource` /
 *    `upsertMiniMaxApiKey` / `testUserModel`）。三来源切换是真动作，
 *    「使用中」徽标渲染引擎回读的真值；检测读的是已保存的密钥，引擎
 *    的 `testUserModel` 不接受临时 key，输入未保存时按钮禁用。
 *  - voice/shortcuts/custom-instructions/coding/worktree 五个 Tab 照抄
 *    参照的空面板形态；其真实内容由 deploy-55 分支的 55a 四子页提供，
 *    合并后在对应分支接线。
 *  - 图标：参照 `SettingsModal.tsx` 的内联 svg path 表整体搬入
 *    （SETTINGS_ICON_PATHS），不经由本仓 icons.tsx。
 *  - 文案：全部用户可见文案走 `t()`（工单 59 D3-4 把参照遗留的硬编码
 *    中文收进 i18n 字典，en 侧为地道英文；语言自称「中文/English」除外）。
 *  - 外观三选：参照用 /assets/img/*.svg 预览图，本仓无该资产，预览槽
 *    以纯 CSS 色块呈现（light 白 / dark 黑 / system 对半分），按钮语义
 *    与选中态样式不变，主题写入走 `lib/theme.ts#applyAppearance`。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import * as api from "@/lib/api";
import {
  commitContextWindowUsage,
  commitFileLineWrap,
  commitFileOpenInNewTab,
  commitFollowUpBehavior,
  readContextWindowUsage,
  readFileLineWrap,
  readFileOpenInNewTab,
  readFollowUpBehavior,
} from "@/lib/settings-local";
import { applyAppearance, currentAppearance } from "@/lib/theme";
import type { Locale, MessageKey } from "@/lib/i18n";
import { ProviderManagementPanel } from "./provider-management";
import { SettingsPanel, UsageModelsSection } from "./panels";
// 55a 四子页（工单 58 线 D 接线）：与移植壳同目录的纯前端组件，无
// store/api 依赖；面板自带 localStorage 持久化（lib/settings-local.ts）。
import {
  CodeReviewSection,
  PersonalizationSection,
  ShortcutsSection,
  VoiceSection,
} from "./settings-extra-pages";

// --- tab registry（照抄参照 DESKTOP_SETTINGS_TABS / SETTINGS_GROUPS）------

export type SettingsTabKey =
  | "desktop"
  | "shortcuts"
  | "voice"
  | "custom-instructions"
  | "usage"
  | "connection"
  | "account"
  | "coding"
  | "worktree"
  | "archived";

export interface SettingsTabDefinition {
  readonly key: SettingsTabKey;
  readonly group: "preferences" | "management" | "coding" | "archived";
  /** i18n label：本仓沿用既有 MessageKey（en/zh 双语已有）。 */
  readonly labelKey: MessageKey;
  /** 参照 ICONS 表的图标名（内联 svg path，见 SETTINGS_ICON_PATHS）。 */
  readonly icon: string;
}

export const DESKTOP_SETTINGS_TABS: readonly SettingsTabDefinition[] = [
  { key: "desktop", group: "preferences", labelKey: "settings.tab.general", icon: "desktop" },
  { key: "voice", group: "preferences", labelKey: "settings.tab.voice", icon: "voice" },
  { key: "shortcuts", group: "preferences", labelKey: "settings.tab.shortcuts", icon: "shortcuts" },
  { key: "custom-instructions", group: "preferences", labelKey: "settings.tab.personalization", icon: "custom-instructions" },
  { key: "usage", group: "management", labelKey: "settings.tab.usageModels", icon: "chart" },
  { key: "connection", group: "management", labelKey: "settings.tab.connection", icon: "link" },
  { key: "account", group: "management", labelKey: "settings.tab.account", icon: "user" },
  { key: "coding", group: "coding", labelKey: "settings.tab.codeReview", icon: "coding" },
  { key: "worktree", group: "coding", labelKey: "settings.tab.worktree", icon: "worktree" },
  { key: "archived", group: "archived", labelKey: "settings.tab.archived", icon: "archived" },
];

const SETTINGS_GROUP_LABELS: Record<SettingsTabDefinition["group"], MessageKey> = {
  preferences: "settings.group.preferences",
  management: "settings.group.management",
  coding: "settings.group.coding",
  archived: "settings.group.archived",
};
const SETTINGS_GROUP_ORDER: readonly SettingsTabDefinition["group"][] = [
  "preferences",
  "management",
  "coding",
  "archived",
];

/** 参照 `filterSettingsTabs`：`${label} ${key}` 小写包含匹配。label 走
 * `t()`（本仓 i18n），key 为参照内部键（如 `custom-instructions`）。 */
export function filterSettingsTabs(query: string, t: (key: MessageKey) => string): readonly SettingsTabDefinition[] {
  const needle = query.trim().toLowerCase();
  return DESKTOP_SETTINGS_TABS.filter((tab) => !needle || `${t(tab.labelKey)} ${tab.key}`.toLowerCase().includes(needle));
}

// --- icons（参照 SettingsModal.tsx 的内联 path 表整体搬运）-----------------

const ICONS: Record<string, string> = {
  desktop:
    "M14.9996 3.56689H4.99963C3.747 3.56689 2.73303 4.581 2.73303 5.8335V12.938L1.7301 15.189C1.61993 15.408 1.66322 16.3808 2.31799 17.0884H16.983C18.3361 16.3808 18.3787 15.4072 18.2682 15.188L17.2662 12.938V5.8335C17.2662 4.581 16.2522 3.56689 14.9996 3.56689Z",
  voice:
    "M11.25 4.25C11.25 3.00736 10.2426 2 9 2C7.75736 2 6.75 3.00736 6.75 4.25V9.5C6.75 10.7426 7.75736 11.75 9 11.75C10.2426 11.75 11.25 10.7426 11.25 9.5V4.25ZM14.25 7.5V9C14.25 11.8995 11.8995 14.25 9 14.25C6.10051 14.25 3.75 11.8995 3.75 9V7.5M9 14.25V16.5M6.75 16.5H11.25",
  shortcuts:
    "M13.8768 13.1403H6.10529M2 5.59998C2 4.49541 2.89543 3.59998 4 3.59998H16C17.1046 3.59998 18 15.5045 18 14.4V5.59998C18 4.49541 17.1046 3.59998 16 3.59998H4C2.89543 3.59998 2 4.49541 2 5.59998V14.4C2 15.5045 2.89543 16.4 4 16.4H16C17.1046 16.4 18 15.5045 18 14.4V5.59998Z",
  "custom-instructions":
    "M5.24316 2.84784C5.24316 1.57385 6.64787 .800013 7.72461 1.48065L9.60449 3.33514L10.5469 4.78241L11.4404 4.40253C12.9336 3.47824 14.6993 3.09444 16.4414 3.31561V14.6672C14.7097 14.609 13.1971 14.3609 11.873 15.1232L10.2988 16.0295L9.25098 15.7307C7.60003 14.6279 5.89805 14.1654 4.07324 14.3644V4.47479Z",
  chart:
    "M2.86194 2.26236V15.5514C2.86194 16.0953 3.30396 16.5368 3.84788 16.5368H17.1373M6.82776 9.53873V13.9655M10.7926 4.44888V13.9655M14.7584 7.62076V13.9655",
  link: "M10.0002 1.97192A8.0283 8.0283 0 1 0 10.0002 18.0286A8.0283 8.0283 0 0 0 10.0002 1.97192ZM3.19849 10.5999H16.801",
  user: "M6.25 16.4965V15.25C6.25 14.8522 6.40804 14.4706 7.75 13.75H12.25C13.75 14.8522 13.592 14.4706 13.75 15.25V16.4965M17.5 10A7.5 7.5 0 1 1 2.5 10A7.5 7.5 0 0 1 17.5 10Z",
  coding:
    "M11.7852 3.57383L8.34082 16.4264M5.14453 5.74961L1.42969 9.46347L5.99219 14.027M14.0078 5.74961L18.5703 9.46347L14.0078 14.027",
  worktree:
    "M11.1538 1.82715V5.42676H10.7524V9.33691H13.9868C15.4225 9.33726 16.5864 10.5008 16.5864 11.9365V12.9736",
  work: "M7.33333 2.66667H12.6667C15.9804 2.66667 18.6667 5.35296 18.6667 8.66667C18.6667 11.9804 15.9804 14.6667 12.6667 14.6667H8.66667L4 18V14.1141C2.77778 13.1453 2 11.6 2 10C2 5.58172 5.35296 2.66667 7.33333 2.66667Z",
  archived: "M3.33333 4.66667H16.6667C17.0349 4.66667 17.3333 4.96514 17.3333 5.33333V8C17.3333 8.36819 17.0349 8.66667 16.6667 8.66667H3.33333C2.96514 8.66667 2.66667 8.36819 2.66667 8V5.33333C2.66667 4.96514 2.96514 4.66667 3.33333 4.66667ZM4.66667 8.66667V15.3333C4.66667 15.7015 4.96514 16 5.33333 16H14.6667C15.0349 16 15.3333 15.7015 15.3333 15.3333V8.66667M8 11.3333H12",
  back: "M12.6667 15.1667L7.5 10L12.6667 4.83333",
  search: "M14.5 14.5L17.5 17.5M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z",
  close:
    "M11.2636 4.02491C11.4587 3.82986 11.7754 3.83007 11.9706 4.02491C12.1658 4.22015 12.1658 4.5367 11.9706 4.73194L8.7099 7.99268L11.9706 11.2534C12.1657 11.4487 12.1659 11.7652 11.9706 11.9605C11.7754 12.1556 11.4589 12.1555 11.2636 11.9605L8.00287 8.69971L4.74213 11.9605C4.54688 12.1556 4.23033 12.1556 4.0351 11.9605C3.84027 11.7652 3.84008 11.4486 4.0351 11.2534L7.29584 7.99268L4.0351 4.73194C3.84024 4.53666 3.84 4.22004 4.0351 4.02491C4.23022 3.82978 4.54683 3.83005 4.74213 4.02491L8.00287 7.28565L11.2636 4.02491Z",
};
export const SETTINGS_ICON_PATHS = ICONS;

/** 参照 `Icon`：link/worktree 为多形状 svg，其余走 path 表。 */
function SettingsIcon({ name, size = 18 }: { readonly name: string; readonly size?: number }): ReactElement {
  const voice = name === "voice";
  let shape: ReactNode;
  if (name === "link") {
    shape = (
      <>
        <circle cx="10" cy="10" r="8" />
        <path d="M2 10h16M10 2c-2 2.2-3 4.8-3 8s1 5.8 3 8m0-16c2 2.2 3 4.8 3 8s-1 5.8-3 8" />
      </>
    );
  } else if (name === "worktree") {
    shape = (
      <>
        <circle cx="10" cy="4" r="1.75" />
        <circle cx="4" cy="15" r="1.75" />
        <circle cx="10" cy="15" r="1.75" />
        <circle cx="16" cy="15" r="1.75" />
        <path d="M10 5.75V9M4 9h12M4 9v4.25M10 9v4.25M16 9v4.25" />
      </>
    );
  } else {
    shape = <path d={ICONS[name] ?? ICONS.desktop} fill="none" />;
  }
  return (
    <svg
      aria-hidden="true"
      data-testid={voice ? "asr-mic-icon" : undefined}
      className="webui-settings-icon"
      width={size}
      height={size}
      viewBox={voice ? "0 0 18 18" : "0 0 20 20"}
      fill="none"
      stroke="currentColor"
      strokeWidth={voice ? "1.08" : "1.2"}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shape}
    </svg>
  );
}

// --- 参照的通用 UI 原语（ToggleSwitch / Select / Button / SettingRow …）----

/** 参照 `ToggleSwitch.tsx` 整体搬运：webui-toggle-switch 类自带全部形态。 */
export function ToggleSwitch({
  checked,
  label,
  onChange,
  testId,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange?: (checked: boolean) => void;
  readonly testId?: string;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className={`webui-toggle-switch${checked ? " is-checked" : ""}`}
      onClick={() => onChange?.(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

/** 参照 `Select`：原生 select 包一层 webui-ant-select 外观。 */
function SettingsSelect({
  value,
  onChange,
  options,
  disabled = false,
  wide = false,
  testId,
  ariaLabel,
}: {
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly options: readonly string[];
  readonly disabled?: boolean;
  readonly wide?: boolean;
  readonly testId?: string;
  readonly ariaLabel?: string;
}): ReactElement {
  return (
    <label className={`webui-ant-select${wide ? " is-wide" : ""}`} data-testid={testId}>
      <select
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M12 6L8 10L4 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  );
}

function SettingsButton({
  children,
  variant = "gray",
  disabled = false,
  onClick,
  title,
}: {
  readonly children: ReactNode;
  readonly variant?: "gray" | "black";
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly title?: string;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`webui-mavis-button webui-mavis-button-${variant}`}
    >
      {children}
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
  testId,
  disabled = false,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly testId?: string;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <div data-testid={testId} className={`webui-generic-row${disabled ? " is-disabled" : ""}`} aria-disabled={disabled || undefined}>
      <div className="webui-generic-row-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      <div className="webui-generic-row-control">{children}</div>
    </div>
  );
}

function RowDivider(): ReactElement {
  return <div className="webui-generic-divider"><span /></div>;
}

function GenericSection({
  title,
  testId,
  children,
  preference = false,
}: {
  readonly title: string;
  readonly testId?: string;
  readonly children: ReactNode;
  readonly preference?: boolean;
}): ReactElement {
  return (
    <section data-testid={testId} className={`webui-generic-section${preference ? " is-preference" : ""}`}>
      <h3>{title}</h3>
      <div className="webui-generic-card">{children}</div>
    </section>
  );
}

/** 参照 `SettingPanel`：管理组页面的带边框卡片面板。 */
function SettingPanel({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
  return (
    <section className="webui-settings-panel">
      <h3>{title}</h3>
      <div>{children}</div>
    </section>
  );
}

// --- modal 本体 -------------------------------------------------------------

export interface SettingsModalPortProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly t: (key: MessageKey) => string;
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  /** 已映射为参照 Tab 键：desktop / usage / connection。 */
  readonly initialTab?: SettingsTabKey;
  /** 转发给 custom 来源的 ProviderManagementPanel（添加模型 deep-link）。 */
  readonly autoAddProvider?: boolean;
  readonly onAutoAddConsumed?: () => void;
}

export function SettingsModalPort({
  open,
  onClose,
  t,
  locale,
  setLocale,
  initialTab,
  autoAddProvider,
  onAutoAddConsumed,
}: SettingsModalPortProps): ReactElement | null {
  const [active, setActive] = useState<SettingsTabKey>(initialTab ?? "desktop");
  const [query, setQuery] = useState("");
  const wasOpen = useRef(false);

  // 开启转移时应用 deep-link 种子（沿用本仓 SettingsModal 原语义：open
  // 沿为 dep，模态内自行导航不被覆盖）。
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    if (initialTab) setActive(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const visibleTabs = useMemo(() => filterSettingsTabs(query, t), [query, t]);
  if (!open) return null;

  const groups = SETTINGS_GROUP_ORDER.map((group) => ({
    key: group,
    label: t(SETTINGS_GROUP_LABELS[group]),
    tabs: visibleTabs.filter((tab) => tab.group === group),
  })).filter((group) => group.tabs.length > 0);
  const current = DESKTOP_SETTINGS_TABS.find((tab) => tab.key === active);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("panel.settings")}
      className="webui-settings-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="webui-settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <aside className="webui-settings-sidebar">
          <button type="button" aria-label={t("settings.back")} className="webui-settings-back" onClick={onClose}>
            <SettingsIcon name="back" />
            <span>{t("settings.back")}</span>
          </button>
          <div className="webui-settings-search">
            <SettingsIcon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("settings.searchPlaceholder")}
              aria-label={t("settings.searchPlaceholder")}
              data-testid="settings-search-input"
            />
            {query ? (
              <button type="button" aria-label={t("settings.clearSearch")} onClick={() => setQuery("")}>
                <SettingsIcon name="close" />
              </button>
            ) : null}
          </div>
          <nav aria-label={t("settings.nav.aria")} className="webui-settings-nav">
            {groups.length ? (
              groups.map((group) => (
                <div key={group.key} className="webui-settings-group">
                  <h3>{group.label}</h3>
                  {group.tabs.map((tab) => (
                    <button
                      type="button"
                      key={tab.key}
                      data-menu-key={tab.key}
                      data-testid={`settings-tab-${tab.key}`}
                      className={`webui-settings-nav-item${active === tab.key ? " is-active" : ""}`}
                      aria-current={active === tab.key ? "page" : undefined}
                      onClick={() => setActive(tab.key)}
                    >
                      <span className="menu-icon">
                        <SettingsIcon name={tab.icon} />
                      </span>
                      <span className="menu-label">{t(tab.labelKey)}</span>
                    </button>
                  ))}
                </div>
              ))
            ) : (
              <p className="webui-settings-no-results">{t("settings.searchNoResults")}</p>
            )}
          </nav>
        </aside>
        <main className="webui-settings-content" key={active}>
          <header className="webui-settings-content-header">
            <h2>{current ? t(current.labelKey) : ""}</h2>
          </header>
          {active === "desktop" ? (
            <GenericPage t={t} locale={locale} setLocale={setLocale} />
          ) : null}
          {active === "usage" ? (
            <UsageModelSettingsPort
              t={t}
              autoAddProvider={autoAddProvider}
              onAutoAddConsumed={onAutoAddConsumed}
            />
          ) : null}
          {active === "connection" ? (
            <div className="webui-settings-panels">
              <SettingsPanel t={t} locale={locale} setLocale={setLocale} section="connection" />
            </div>
          ) : null}
          {active === "account" ? (
            <div className="webui-settings-panels">
              <SettingPanel title={t("settings.tab.account")}>
                {/* 本地版无账户会话：按参照形态渲染账户信息行（空值）与
                 * 退出登录（无 capability，禁用）。 */}
                <div className="webui-settings-row">
                  <div>
                    <strong>{t("settings.account.info")}</strong>
                    <span>{t("settings.account.localLoggedOut")}</span>
                  </div>
                </div>
                <SettingsButton disabled title={t("settings.account.signOutUnavailable")}>
                  {t("settings.account.signOut")}
                </SettingsButton>
              </SettingPanel>
            </div>
          ) : null}
          {active === "archived" ? (
            <div className="webui-settings-panels">
              <SettingPanel title={t("settings.tab.archived")}>
                <p className="webui-settings-empty-panel">{t("settings.archived.empty")}</p>
              </SettingPanel>
            </div>
          ) : null}
          {/* 55a 四子页内容接进移植壳（工单 58 线 D）：语音/快捷键/个性化/代码审查
           * 渲染各自组件，记忆摘要弹窗由 PersonalizationSection 内部管理（「管理」
           * 按钮打开）；工作树与已归档任务保持参照的占位/空态（55a 未实现）。 */}
          {active === "voice" ? <VoiceSection t={t} /> : null}
          {active === "shortcuts" ? <ShortcutsSection t={t} /> : null}
          {active === "custom-instructions" ? <PersonalizationSection t={t} /> : null}
          {active === "coding" ? <CodeReviewSection t={t} /> : null}
          {active === "worktree" ? (
            <div className="webui-settings-panels">
              <SettingPanel title={t("settings.tab.worktree")}>
                <p className="webui-settings-empty-panel">{t("settings.worktree.empty")}</p>
              </SettingPanel>
            </div>
          ) : null}
        </main>
      </section>
    </div>
  );
}

// --- 通用页（参照 GenericPage 全区块）--------------------------------------

function GenericPage({
  t,
  locale,
  setLocale,
}: {
  readonly t: (key: MessageKey) => string;
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
}): ReactElement {
  const [appearance, setAppearance] = useState(() => currentAppearance() ?? "system");
  const [newTab, setNewTab] = useState(() => readFileOpenInNewTab());
  const [wrap, setWrap] = useState(() => readFileLineWrap());
  const [contextWindow, setContextWindow] = useState(() => readContextWindowUsage());
  const [followUp, setFollowUp] = useState(() => readFollowUpBehavior());
  const [engine, setEngine] = useState<api.SettingsSnapshot | null>(null);

  useEffect(() => {
    void api
      .getSettings()
      .then((snapshot) => setEngine(snapshot))
      .catch(() => undefined);
  }, []);

  // 参照 `off()`：桌面端专属开关按参照形态渲染为禁用行。
  const off = (title: string, description: ReactNode, testId?: string) => (
    <SettingRow title={title} description={description} testId={testId} disabled>
      <ToggleSwitch checked={false} label={title} disabled />
    </SettingRow>
  );

  return (
    <div data-testid="content-body" className="webui-generic-page">
      <GenericSection title={t("settings.mode.section")} testId="app-mode-section">
        <div data-testid="app-mode-options" className="webui-mode-options">
          <ModeCard
            testId="app-mode-option-coding"
            title={t("settings.mode.coding")}
            description={t("settings.mode.codingHint")}
            icon="coding"
            selected
          />
          <ModeCard
            testId="app-mode-option-work"
            title={t("settings.mode.work")}
            description={t("settings.mode.workHint")}
            icon="work"
          />
        </div>
      </GenericSection>

      <GenericSection title={t("settings.section.application")} testId="application-section">
        <Appearance t={t} value={appearance} onChange={setAppearance} />
        <RowDivider />
        {off(t("settings.app.menuBar"), t("settings.app.menuBarHint"))}
        <RowDivider />
        {off(t("settings.app.autoStart"), t("settings.app.autoStartHint"))}
        <RowDivider />
        {off(t("settings.app.notifications"), t("settings.app.notificationsHint"))}
        <RowDivider />
        {off(t("settings.app.earlyAccess"), t("settings.app.earlyAccessHint"), "early-access-update-switch")}
        <RowDivider />
        {off(t("settings.app.indexing"), t("settings.app.indexingHint"), "workspace-indexing-switch")}
        <RowDivider />
        <SettingRow title={t("settings.language")} description={t("settings.languageHint")}>
          <SettingsSelect
            value={locale === "zh" ? "中文" : "English"}
            options={["中文", "English"]}
            ariaLabel={t("settings.language")}
            onChange={(value) => setLocale(value === "中文" ? "zh" : "en")}
          />
        </SettingRow>
      </GenericSection>

      <GenericSection title={t("settings.links.section")} testId="link-open-destination-section">
        <SettingRow
          title={t("settings.links.web")}
          description={t("settings.links.webHint")}
          testId="web-link-open-destination-row"
        >
          <SettingsSelect value={t("settings.links.builtinBrowser")} options={[t("settings.links.builtinBrowser")]} wide disabled testId="web-link-open-destination-row-select" />
        </SettingRow>
        <RowDivider />
        <SettingRow
          title={t("settings.links.local")}
          description={t("settings.links.localHint")}
          testId="local-link-open-destination-row"
        >
          <SettingsSelect value={t("settings.links.builtinBrowser")} options={[t("settings.links.builtinBrowser")]} wide disabled testId="local-link-open-destination-row-select" />
        </SettingRow>
      </GenericSection>

      <GenericSection title={t("settings.section.file")} testId="file-section">
        <SettingRow
          title={t("settings.file.openInNewTab")}
          description={t("settings.file.openInNewTabHint")}
          testId="file-open-in-new-tab-switch"
        >
          <ToggleSwitch
            checked={newTab}
            label={t("settings.file.openInNewTab")}
            testId="file-open-in-new-tab-toggle"
            onChange={(value) => commitFileOpenInNewTab(setNewTab, value)}
          />
        </SettingRow>
        <RowDivider />
        <SettingRow
          title={t("settings.file.lineWrap")}
          description={t("settings.file.lineWrapHint")}
          testId="file-line-wrap-switch"
        >
          <ToggleSwitch
            checked={wrap}
            label={t("settings.file.lineWrap")}
            testId="file-line-wrap-toggle"
            onChange={(value) => commitFileLineWrap(setWrap, value)}
          />
        </SettingRow>
      </GenericSection>

      <GenericSection title={t("settings.section.sessionManagement")} testId="session-management-section">
        <SettingRow
          title={t("settings.session.contextWindowUsage")}
          testId="context-window-usage-switch"
        >
          <ToggleSwitch
            checked={contextWindow}
            label={t("settings.session.contextWindowUsage")}
            testId="context-window-usage-toggle"
            onChange={(value) => commitContextWindowUsage(setContextWindow, value)}
          />
        </SettingRow>
      </GenericSection>

      <GenericSection title={t("settings.agentControl.section")} testId="agent-control-permission-section">
        <SettingRow
          title={t("settings.agentControl.browserPanel")}
          description={t("settings.agentControl.browserPanelHint")}
          testId="browser-use-auto-open-row"
        >
          <ToggleSwitch checked={false} label={t("settings.agentControl.browserPanel")} disabled testId="browser-use-auto-open-switch" />
        </SettingRow>
      </GenericSection>

      <GenericSection title={t("settings.section.preference")} testId="preference-settings" preference>
        <SettingRow title={t("settings.followUp.title")} description={t("settings.followUp.hint")}>
          <div className="webui-segmented" role="radiogroup">
            {([["queue", t("settings.followUp.queue")], ["steer", t("settings.followUp.steer")]] as const).map(
              ([value, text]) => (
                <button
                  type="button"
                  key={value}
                  role="radio"
                  aria-checked={followUp === value}
                  className={followUp === value ? "is-selected" : ""}
                  onClick={() => commitFollowUpBehavior(setFollowUp, value === "steer" ? "steer" : "queue")}
                >
                  {text}
                </button>
              ),
            )}
          </div>
        </SettingRow>
        <RowDivider />
        {off(
          t("settings.preference.watermark"),
          t("settings.preference.watermarkHint"),
        )}
        <RowDivider />
        {off(t("settings.preference.dataOptIn"), t("settings.preference.dataOptInHint"))}
      </GenericSection>

      <GenericSection title={t("settings.about.section")} testId="about-section">
        <SettingRow title={t("settings.about.uploadLogs")} description={t("settings.about.uploadLogsHint")}>
          <SettingsButton disabled title={t("settings.about.uploadUnavailable")}>
            {t("settings.about.uploadAction")}
          </SettingsButton>
        </SettingRow>
        <RowDivider />
        <SettingRow title={t("settings.about.version")} description={engine?.mcodeVersion ?? "—"}>
          <SettingsButton variant="black" disabled title={t("settings.about.updateUnavailable")}>
            {t("settings.about.checkUpdate")}
          </SettingsButton>
        </SettingRow>
        <RowDivider />
        {/* engine facts（本地/局域网服务地址）自旧通用页并入关于区：
         * 参照关于区无此二行，保留是为不丢失既有可见信息。 */}
        <SettingRow title={t("settings.about.localUrl")} description={engine?.localUrl ?? "—"} />
        <RowDivider />
        <SettingRow title={t("settings.about.lanUrl")} description={engine?.lanUrl ?? "—"} />
      </GenericSection>
    </div>
  );
}

/** 外观三选：参照 `Appearance`。预览槽无 svg 资产，用 CSS 色块（见文件头
 * 适配点）；选择走 `applyAppearance`，与 AppearanceSync 同一通道。 */
function Appearance({
  t,
  value,
  onChange,
}: {
  readonly t: (key: MessageKey) => string;
  readonly value: "light" | "dark" | "system";
  readonly onChange: (value: "light" | "dark" | "system") => void;
}): ReactElement {
  const options = [
    { key: "light", label: t("appearance.choice.light"), swatch: "webui-theme-swatch-light" },
    { key: "dark", label: t("appearance.choice.dark"), swatch: "webui-theme-swatch-dark" },
    { key: "system", label: t("appearance.choice.system"), swatch: "webui-theme-swatch-system" },
  ] as const;
  return (
    <SettingRow title={t("settings.appearance")} description={t("settings.appearanceHint")} testId="mavis-settings-appearance-row">
      <div className="mavis-settings-theme-selector">
        {options.map((option) => (
          <button
            type="button"
            key={option.key}
            aria-pressed={value === option.key}
            className="mavis-settings-theme-option"
            onClick={() => {
              onChange(option.key);
              applyAppearance(option.key);
            }}
          >
            <span className={`mavis-settings-theme-preview${value === option.key ? " is-selected" : ""}`}>
              <span className={option.swatch} aria-hidden="true" />
            </span>
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </SettingRow>
  );
}

/** 参照 `ModeCard`：双模式卡，禁用态、编程卡选中。 */
function ModeCard({
  testId,
  title,
  description,
  icon,
  selected = false,
}: {
  readonly testId: string;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly selected?: boolean;
}): ReactElement {
  return (
    <button type="button" data-testid={testId} data-selected={selected} aria-pressed={selected} disabled className="webui-mode-card">
      <span className="webui-mode-inner">
        <span className="webui-mode-icon">
          <SettingsIcon name={icon} size={24} />
        </span>
        <span className="webui-mode-copy">
          <strong data-testid={`${testId}-title`}>{title}</strong>
          <span data-testid={`${testId}-description`}>{description}</span>
        </span>
        <span data-testid={`${testId}-radio`} className={`webui-mode-radio${selected ? " is-selected" : ""}`}>
          <svg aria-hidden="true" width={selected ? 20 : 16} height={selected ? 20 : 16} viewBox="0 0 20 20" fill="none">
            {selected ? (
              <>
                <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.25" />
                <circle cx="10" cy="10" r="4.5" fill="currentColor" />
              </>
            ) : (
              <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.25" />
            )}
          </svg>
        </span>
      </span>
    </button>
  );
}

// --- 用量与模型（参照 UsageModelSettings 的三来源切换头）-------------------

/**
 * The view tab — which panel the user is LOOKING at. Distinct from
 * `activeSource`, which is what the ENGINE is using. The reference draws
 * the same two things: the pill is the view, the 「使用中」 badge is the
 * truth. Collapsing them is what let the old build pick a source in the
 * dropdown and show it as selected while the engine kept using the other
 * one.
 */
type UsageSourceTab = "token-plan" | "minimax-api" | "custom";

/** The switcher tab ↔ the engine source it selects. */
const TAB_TO_ENGINE_SOURCE = {
  "token-plan": "token_plan",
  "minimax-api": "minimax_api_key",
} as const;

function UsageModelSettingsPort({
  t,
  autoAddProvider,
  onAutoAddConsumed,
}: {
  readonly t: (key: MessageKey) => string;
  readonly autoAddProvider?: boolean;
  readonly onAutoAddConsumed?: () => void;
}): ReactElement {
  const [sourceTab, setSourceTab] = useState<UsageSourceTab>(autoAddProvider ? "custom" : "token-plan");
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");

  // SB-1: the engine's truth for this tab. `null` while the read is in
  // flight and after a failed one — the badge renders nothing in both
  // cases rather than guessing, because a badge that claims 「使用中」 for
  // a source the engine never accepted is the fake-success shape this
  // repository keeps refusing.
  const [activeSource, setActiveSource] = useState<api.ModelSource | null>(null);
  const [keyStatus, setKeyStatus] = useState<api.ModelSourceApiKeyStatus | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<"source" | "key" | "test" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // Read the engine's source when the tab mounts. This is deliberately
  // NOT a page-level fetch: the server boots the engine runtime to
  // answer it, and a boot belongs to a user action (opening the tab) —
  // see `server/engine/model-source.js` KNOWN DEBT 2.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await api.getModelSource();
        if (cancelled) return;
        setActiveSource(snapshot.source);
        setKeyStatus(snapshot.apiKey);
        setLoadState("ready");
      } catch {
        if (cancelled) return;
        setActiveSource(null);
        setKeyStatus(null);
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceLabel = sourceTab === "token-plan" ? "Token Plan" : "MiniMax API";
  const keyAvailable = keyStatus !== null && keyStatus.available;
  const hasStoredKey = keyStatus?.hasKey === true;
  const hasUnsavedKey = apiKey.trim().length > 0;

  /**
   * Select a source: move the view AND switch the engine in one action.
   *
   * The order matters. The view moves first (it is instant and reversible
   * by clicking again), then the engine call; a refusal leaves the
   * VIEW where the user put it — so a failed switch to MiniMax API shows
   * the key field the user has to fill, rather than snapping back to a
   * panel that does not explain the failure — while the badge keeps
   * showing the source that is actually in use.
   */
  const chooseSource = useCallback(
    async (tab: Exclude<UsageSourceTab, "custom">) => {
      setSourceMenuOpen(false);
      setSourceTab(tab);
      const wanted = TAB_TO_ENGINE_SOURCE[tab];
      if (wanted === activeSource) return;
      setBusy("source");
      setNotice(null);
      try {
        const written = await api.setModelSource(wanted);
        // The response carries what the engine PERSISTED, not what was
        // requested, so a re-read of the badge can never disagree with
        // the config.
        setActiveSource(written.source);
      } catch (cause) {
        setNotice({
          tone: "error",
          text:
            cause instanceof api.ApiHttpError && api.hasApiErrorCode(cause, "NO_API_KEY")
              ? t("usageModels.minimax.keyRequired")
              : t("usageModels.source.switchFailed"),
        });
      } finally {
        setBusy(null);
      }
    },
    [activeSource, t],
  );

  const saveKeyAndUse = useCallback(async () => {
    const raw = apiKey.trim();
    if (!raw) {
      setNotice({ tone: "error", text: t("usageModels.minimax.keyRequired") });
      return;
    }
    setBusy("key");
    setNotice(null);
    try {
      // `saveAndUse` writes the key and switches the source in ONE
      // engine transaction, so the tab never shows a saved key beside a
      // source that was not switched.
      const result = await api.putModelSourceApiKey({ apiKey: raw, saveAndUse: true });
      setKeyStatus(result.apiKey);
      setActiveSource(result.source);
      setApiKey("");
      setSourceTab("minimax-api");
      setNotice({ tone: "ok", text: t("usageModels.minimax.saved") });
    } catch (cause) {
      setNotice({
        tone: "error",
        text: cause instanceof Error ? cause.message : t("usageModels.minimax.keyRequired"),
      });
    } finally {
      setBusy(null);
    }
  }, [apiKey, t]);

  const testKey = useCallback(async () => {
    setBusy("test");
    setNotice(null);
    try {
      const result = await api.testModelSourceModel();
      setKeyStatus((previous) =>
        previous === null
          ? previous
          : { ...previous, testState: result.status.state ?? previous.testState },
      );
      setNotice({
        tone: result.success ? "ok" : "error",
        text: result.success
          ? t("usageModels.minimax.testOk")
          : result.status.lastErrorMessage || t("usageModels.minimax.testFailed"),
      });
    } catch (cause) {
      setNotice({
        tone: "error",
        text: cause instanceof Error ? cause.message : t("usageModels.minimax.testFailed"),
      });
    } finally {
      setBusy(null);
    }
  }, [t]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[704px] flex-1 flex-col gap-4" data-testid="settings-usage-model">
      {/* 参照的三来源切换头：来源 pill（下拉切 Token Plan / MiniMax API）
       * + 细分隔线 + 自定义模型按钮。SB-1 起切换是真动作：下拉点选同时
       * 改视图并写引擎（PUT /api/model-source），「使用中」徽标渲染的是
       * 引擎回读的真值而非本地 state。 */}
      <div className="flex h-8 items-center gap-3">
        <div className="relative">
          <div
            className={`flex h-8 items-center overflow-hidden rounded-[8px] text-[14px] font-medium leading-5 transition-colors ${
              sourceTab !== "custom"
                ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
                : "text-text_default_secondary hover:bg-bg_interaction_tertiary_hover"
            }`}
          >
            <button
              type="button"
              data-testid="settings-usage-source-tab"
              className="flex h-full items-center pl-3 pr-1"
              onClick={() => setSourceMenuOpen((open) => !open)}
            >
              {sourceLabel}
            </button>
            <button
              type="button"
              aria-label={t("usageModels.source.aria")}
              className="flex h-full w-7 items-center justify-center hover:bg-bg_interaction_tertiary_hover"
              onClick={() => setSourceMenuOpen((open) => !open)}
            >
              <ChevronDownIcon />
            </button>
          </div>
          {sourceMenuOpen ? (
            <div className="absolute left-0 top-full z-10 mt-1 flex min-w-[180px] flex-col rounded-[12px] bg-bg_default_primary p-1.5 shadow-lg">
              <button
                type="button"
                data-testid="settings-usage-source-option-token-plan"
                className="flex h-[30px] items-center justify-between rounded-[8px] px-3 text-left text-sm hover:bg-bg_interaction_tertiary_hover"
                onClick={() => void chooseSource("token-plan")}
              >
                Token Plan
                {activeSource === "token_plan" ? (
                  <span className="text-text_default_tertiary">{t("usageModels.source.inUse")}</span>
                ) : null}
              </button>
              <button
                type="button"
                data-testid="settings-usage-source-option-minimax-api"
                className="flex h-[30px] items-center justify-between rounded-[8px] px-3 text-left text-sm hover:bg-bg_interaction_tertiary_hover"
                onClick={() => void chooseSource("minimax-api")}
              >
                MiniMax API
                {activeSource === "minimax_api_key" ? (
                  <span className="text-text_default_tertiary">{t("usageModels.source.inUse")}</span>
                ) : null}
              </button>
            </div>
          ) : null}
        </div>
        {/* 徽标只在读到了真值、且当前视图就是那一来源时出现：视图是
         * token-plan 时一个「MiniMax API 使用中」的徽标会挂在错的行上。 */}
        {activeSource !== null &&
        TAB_TO_ENGINE_SOURCE[sourceTab as "token-plan" | "minimax-api"] === activeSource ? (
          <span
            data-testid="settings-usage-source-in-use"
            className="rounded-[6px] bg-bg_interaction_tertiary_selected px-1.5 py-0.5 text-[12px] leading-4 text-text_default_secondary"
          >
            {t("usageModels.source.inUse")}
          </span>
        ) : null}
        <div className="h-3 w-[0.5px] bg-border_default" />
        <button
          type="button"
          className={`h-8 rounded-[8px] px-3 text-[14px] font-medium leading-5 transition-colors ${
            sourceTab === "custom"
              ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
              : "text-text_default_secondary hover:bg-bg_interaction_tertiary_hover"
          }`}
          onClick={() => setSourceTab("custom")}
        >
          {t("usage.tab.customModels")}
        </button>
      </div>

      {notice ? (
        <p
          data-testid="settings-usage-notice"
          className={`text-[12px] leading-4 ${
            notice.tone === "ok" ? "text-text_default_secondary" : "text-text_default_primary"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {sourceTab === "token-plan" ? (
        <section className="flex w-full flex-col gap-4" data-testid="settings-usage-token-plan">
          {/* 53 号四张卡（headless：内部切换头由本组件的三来源头取代）。 */}
          <UsageModelsSection t={t} headless />
        </section>
      ) : null}

      {sourceTab === "minimax-api" ? (
        <section className="flex w-full flex-col gap-2 pt-1" data-testid="settings-minimax-api-panel">
          <div className="flex items-center gap-2">
            <label className="text-[14px] font-medium leading-5 text-text_default_primary">API Key</label>
            {/* 徽标读的是引擎回传的掩码投影：available=false（服务读不到
             * 密钥半边）与 hasKey=false（确实没存）是两件事，分开渲染。 */}
            <span
              data-testid="settings-minimax-key-status"
              className="rounded-[6px] bg-bg_interaction_tertiary_selected px-1 py-0.5 text-[12px] leading-4 text-text_default_secondary"
            >
              {loadState === "loading"
                ? t("usageModels.minimax.loading")
                : !keyAvailable
                  ? t("usageModels.minimax.unavailable")
                  : hasStoredKey
                    ? t("usageModels.minimax.configured")
                    : t("usageModels.minimax.notEnabled")}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <input
              aria-label="API Key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                hasStoredKey
                  ? t("usageModels.minimax.storedPlaceholder")
                  : t("usageModels.minimax.apiKeyPlaceholder")
              }
              className="min-w-0 flex-[1_0_0] rounded-[8px] border border-border_default bg-bg_default_primary px-3 py-2 text-[14px]"
            />
            {/* 检测读的是「已保存的密钥」——引擎的 testUserModel 不接受
             * 临时 key（v2 无 override 通道），所以输入框里有未保存的值时
             * 按钮禁用并说明原因，而不是去检测一个它测不到的东西。 */}
            <button
              type="button"
              aria-label={t("usageModels.minimax.testAria")}
              data-testid="settings-minimax-test"
              disabled={!hasStoredKey || hasUnsavedKey || busy !== null}
              title={
                !hasStoredKey
                  ? t("usageModels.minimax.noKeyToTest")
                  : hasUnsavedKey
                    ? t("usageModels.minimax.saveFirst")
                    : ""
              }
              onClick={() => void testKey()}
              className="flex size-7 items-center justify-center text-icon_default_tertiary disabled:cursor-default disabled:opacity-60"
            >
              <RefreshIcon />
            </button>
          </div>
          <button
            type="button"
            data-testid="settings-minimax-save"
            disabled={!hasUnsavedKey || busy !== null}
            onClick={() => void saveKeyAndUse()}
            className="mt-1 h-9 w-[116px] rounded-[8px] bg-bg_interaction_tertiary_hover px-3 text-[14px] disabled:opacity-60"
          >
            {busy === "key"
              ? t("usageModels.minimax.saving")
              : busy === "test"
                ? t("usageModels.minimax.testing")
                : busy === "source"
                  ? t("usageModels.minimax.switching")
                  : t("usageModels.minimax.saveAndUse")}
          </button>
        </section>
      ) : null}

      {sourceTab === "custom" ? (
        <section className="flex min-h-0 flex-1 flex-col gap-3" data-testid="settings-custom-models-panel">
          {/* 54 号添加模型/供应商管理面板（含连通检测）整体作为 custom 落点。 */}
          <ProviderManagementPanel
            t={t}
            autoAddProvider={autoAddProvider}
            onAutoAddConsumed={onAutoAddConsumed}
          />
        </section>
      ) : null}
    </div>
  );
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M12 6L8 10L4 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// --- 兼容壳：维持 panels.tsx 旧 SettingsModal 的对外 props ------------------

/** 旧 `initialSection` 语义（general/connection/providers）到参照 Tab 键
 * 的映射：general→desktop（参照的“通用”）、providers→usage（参照的“用量
 * 与模型”，自定义模型在其 custom 来源下）、connection→connection。 */
const INITIAL_SECTION_TO_TAB: Record<"general" | "connection" | "providers", SettingsTabKey> = {
  general: "desktop",
  connection: "connection",
  providers: "usage",
};

/**
 * Drop-in replacement for the pre-port `panels.tsx#SettingsModal`: same
 * props, same call sites (`page.tsx` imports this name), the reference
 * modal inside. Kept as a named shim so the port stays the single owner
 * of the settings surface while the page keeps its wiring unchanged.
 */
export function SettingsModal({
  open,
  onClose,
  t,
  locale,
  setLocale,
  initialSection,
  autoAddProvider,
  onAutoAddConsumed,
}: {
  open: boolean;
  onClose: () => void;
  t: (key: MessageKey) => string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  initialSection?: "general" | "connection" | "providers";
  autoAddProvider?: boolean;
  onAutoAddConsumed?: () => void;
}): ReactElement | null {
  return (
    <SettingsModalPort
      open={open}
      onClose={onClose}
      t={t}
      locale={locale}
      setLocale={setLocale}
      initialTab={initialSection ? INITIAL_SECTION_TO_TAB[initialSection] : undefined}
      autoAddProvider={autoAddProvider}
      onAutoAddConsumed={onAutoAddConsumed}
    />
  );
}

function RefreshIcon(): ReactElement {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none">
      <path
        d="M17.1134 2.28793C17.4446 2.28807 17.714 2.55625 17.714 2.88754V6.83871C17.7139 6.90647 17.6986 6.97031 17.6778 7.0311C17.6737 7.04327 17.672 7.05627 17.6671 7.06821C17.6211 7.17887 17.543 7.2721 17.4444 7.33774C17.4279 7.34876 17.41 7.35685 17.3927 7.36606C17.3761 7.37488 17.3603 7.38516 17.3429 7.39243C17.3232 7.40058 17.3025 7.405 17.2823 7.41098C17.2645 7.41626 17.2471 7.42299 17.2286 7.42661C17.1905 7.43409 17.152 7.43925 17.1134 7.4393H13.1622C12.8309 7.4393 12.5627 7.17002 12.5626 6.83871C12.5627 6.50747 12.8309 6.23911 13.1622 6.23911H15.6641C14.5184 4.93002 12.8972 4.1739 11.1944 4.16324C9.4917 4.15261 7.86158 4.83252 6.70045 6.02269C5.53935 7.21287 4.96147 8.83112 5.11359 10.4603C5.26574 12.0895 6.1332 13.5751 7.48574 14.5467C8.83829 15.5184 10.5439 15.8799 12.1752 15.5384C13.8066 15.1969 15.2103 14.1854 16.0356 12.7646C16.2012 12.4797 16.5659 12.3831 16.8498 12.5489C17.1336 12.7146 17.2296 13.0795 17.0639 13.3644C16.0304 15.1433 14.2732 16.4092 12.2332 16.8365C10.1931 17.2638 8.06114 16.8124 6.36983 15.5969C4.67855 14.3814 3.59217 12.5187 3.37726 10.4694C3.16238 8.42009 3.83912 6.37705 5.23624 4.84562C6.63333 3.31419 8.61575 2.44499 10.6875 2.45864C12.3367 2.46939 13.9317 3.02489 15.2267 4.03166V2.88754C15.2267 2.55626 15.495 2.28808 15.8262 2.28793H17.1134Z"
        fill="currentColor"
      />
    </svg>
  );
}
