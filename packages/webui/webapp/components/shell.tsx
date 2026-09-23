"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import * as api from "@/lib/api";
import { useSessionContext } from "@/lib/store";
import type { MessageKey } from "@/lib/i18n";
import { Icon } from "./icons";
import { InboxFlyout } from "./inbox";
import { SessionTree } from "./session-tree";
import { runAction } from "@/lib/action-errors";
import type { PanelKind } from "./panels";

/**
 * Application shell.
 *
 * The markup, class strings and measurements are copied from the upstream
 * renderer's own DOM (captured from the running desktop client), so the frame
 * matches it rather than approximating it:
 *
 *   <app>     flex h-screen overflow-hidden bg-bg_grouped_secondary
 *   <aside>   bg-bg_default_scrim, fixed-width, drag-resizable
 *   <nav>     h-8 rows, rounded-lg, pl-2 pr-2.5, kbd badges in grouped-primary
 *   <main>    centred column, max-w-[743px]
 *
 * Where upstream's rows are Electron-specific (the `-webkit-app-region` titlebar
 * drag strip) the strip is kept as a spacer without the drag region, so vertical
 * rhythm is unchanged in a browser.
 */

// Desktop parity : 240px default, drag-clamped to
// 240–400, and a 52px icon rail when collapsed — the sidebar never becomes a
// zero-width column.
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;
const SIDEBAR_RAIL = 52;
/** Below this width the sidebar collapses itself, as the desktop client does. */
const SIDEBAR_AUTO_COLLAPSE_PX = 980;

interface ShellProps {
  t: (key: MessageKey) => string;
  children: React.ReactNode;
  /** Conversation toolbar, rendered above the content. */
  toolbar?: React.ReactNode;
  /** Right-hand drawer (see components/panels.tsx). */
  panel?: React.ReactNode;
  /** Open a drawer panel by kind (wired to the sidebar's nav rows). */
  onOpenPanel?: (kind: PanelKind) => void;
  /**
   * Open the settings dialog. Separate from `onOpenPanel` because settings is a
   * dismissible modal, not a drawer panel (see components/panels.tsx).
   */
  onOpenSettings?: () => void;
  /** Unread alert count, shown on the account menu's Alerts row. */
  alertCount?: number;
}

export function AppShell({ t, children, toolbar, panel, onOpenPanel, onOpenSettings, alertCount = 0 }: ShellProps) {
  // The sidebar is collapsible from the button in its own top strip. The state
  // lives here rather than in `Sidebar` because the expand affordance has to be
  // rendered by the content column once the sidebar is clipped away.
  const [collapsed, setCollapsed] = useState(false);
  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);

  // Narrow viewports collapse on their own (desktop: `innerWidth < 980`). It never
  // auto-expands — that is the user's call once they have widened the window.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < SIDEBAR_AUTO_COLLAPSE_PX) setCollapsed(true);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 站内信 is a flyout anchored beside the sidebar, not a drawer panel.
  const [inboxOpen, setInboxOpen] = useState(false);
  const toggleInbox = useCallback(() => setInboxOpen((value) => !value), []);
  const closeInbox = useCallback(() => setInboxOpen(false), []);

  return (
    <div className="relative flex h-screen overflow-hidden bg-bg_grouped_secondary text-text_default_primary">
      <Sidebar
        t={t}
        onOpenPanel={onOpenPanel}
        onOpenSettings={onOpenSettings}
        alertCount={alertCount}
        onOpenAlerts={toggleInbox}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />
      <InboxFlyout open={inboxOpen} onClose={closeInbox} t={t} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative flex h-full min-w-0 flex-1 flex-col">
          {toolbar}
          {/* Collapsed: the sidebar's own toggle is clipped, so the expand
              affordance floats over the content at the same top offset. */}

          <div className="flex min-h-0 flex-1">
            {/* The AI-content disclaimer lives in the conversation column, not
                beside the drawer: as a sibling of this row it spanned the full
                width, so `text-center` centred it across the drawer as well and
                it read as sitting under the drawer. It stays outside the
                transcript's scroll container so it does not scroll away with
                the messages, and it is rendered on the home screen too. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {children}
              <p
                data-testid="app-disclaimer"
                className="flex-none px-4 pt-1 pb-2 text-center text-caption-small-strong text-text_default_secondary"
              >
                {t("home.disclaimer")}
              </p>
            </div>
            {panel}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Sidebar nav rows.
 *
 * Only the entries this server actually backs are listed: 新建任务 / Ctrl+N
 * and 插件. Upstream also shows 定时 / 网站 / 远程, but nothing behind them is
 * implemented here yet, so they were removed rather than left as dead controls.
 * Re-add a row together with the contract it opens.
 *
 * `Ctrl+N` is rendered as the same `kbd` pill the upstream places beside the
 * first row. Labels are sourced from the i18n dictionary via the `key` field, so
 * the English locale shows the matching translation.
 */
const NAV_ROWS: { key: MessageKey; shortcut?: string }[] = [
  { key: "topbar.newSession", shortcut: "Ctrl+N" },
  { key: "sidebar.plugins" },
];

function Sidebar({
  t,
  onOpenPanel,
  onOpenSettings,
  onOpenAlerts,
  alertCount = 0,
  collapsed,
  onToggleCollapsed,
}: {
  t: (key: MessageKey) => string;
  onOpenPanel?: (kind: PanelKind) => void;
  onOpenSettings?: () => void;
  /** Toggle the 站内信 flyout anchored beside this sidebar. */
  onOpenAlerts: () => void;
  alertCount?: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { state } = useSessionContext();
  const [width, setWidth] = useState(SIDEBAR_DEFAULT);
  const dragging = useRef(false);

  const onBell = useCallback(() => {
    onOpenAlerts();
  }, [onOpenAlerts]);

  // Drag-resize, matching upstream's separator semantics: a 3px pill that only
  // shows while the pointer is over the handle.
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    setWidth((current) => {
      const next = current + event.movementX;
      return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next));
    });
  }, []);
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const onNav = useCallback(
    (entry: (typeof NAV_ROWS)[number]) => {
      if (entry.key === "topbar.newSession") {
        void runAction(t("topbar.newSession"), api.newSession());
      } else if (entry.key === "sidebar.search") {
        onOpenPanel?.("search");
      } else if (entry.key === "sidebar.plugins") {
        // Open the right-side Plugins panel (see panels.tsx PluginsPanel —
        // currently a "正在做" stub; the real marketplace comes when the
        // engine exposes its plugin install contract). Desktop's sibling-row
        // nav puts plugins at top-level sidebar alongside tasks / scheduled /
        // websites / remote, not as a settings tab.
        onOpenPanel?.("plugins");
      }
    },
    [onOpenPanel, onOpenSettings],
  );

  return (
    <>
      {/* Collapsing animates the outer width to the 52px rail rather than to zero,
          and the transcript keeps its state: the session tree stays mounted (just
          hidden) so its loaded rows and scroll position survive a collapse cycle. */}
      <div
        className="relative h-full min-h-0 flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
        style={{ width: collapsed ? SIDEBAR_RAIL : width }}
      >
        {/* Upstream's sidebar card. Class order and the inline geometry come from
            its live DOM (`data-testid="sidebar-base-card"`): the card itself owns
            the `border-right: 0.6px` hairline and a width/transform/opacity
            transition, which is why the border is inline here rather than a
            utility. */}
        <div
          data-testid="sidebar-base-card"
          data-rail-mode={collapsed ? "true" : "false"}
          className="relative z-50 flex flex-col overflow-hidden bg-bg_default_scrim select-none"
          style={{
            // The card itself narrows to the rail; only animating the outer
            // wrapper would leave a 240px card clipped to a 52px slice.
            width: collapsed ? SIDEBAR_RAIL : width,
            height: "100%",
            margin: 0,
            borderRight: "0.6px solid var(--border_light)",
          }}
        >
          {/* Upstream's window-drag strip. `[-webkit-app-region:drag]` is inert in
              a browser, so it is omitted; the strip now carries the sidebar
              collapse toggle in place of upstream's traffic-light gap. The
              `pl-2` matches the nav-row padding below (also `px-2`), so the
              toggle's left edge sits at the same x as the new-session button
              beneath it. The SVG is forced to `block` (see IconButton's
              `[&>svg]:block`) so it no longer drifts against the inline
              baseline — without it the icon sat visibly off-centre inside the
              28x28 button. */}
          <div className="flex w-full flex-shrink-0 flex-col">
            <div className="relative flex h-[38px] w-full items-center pl-2">
              <IconButton label={t("sidebar.collapse")} onClick={onToggleCollapsed}>
                <Icon name="sidebar" />
              </IconButton>
            </div>
          </div>

          {/* Nav rows. Upstream's section is `px-2 pt-2 pb-5 space-y-px`. */}
          <nav
            className={
              collapsed
                ? "flex w-[52px] flex-shrink-0 flex-col items-start gap-px px-2 pt-2"
                : "flex-shrink-0 space-y-px px-2 pt-2 pb-5"
            }
          >
            {NAV_ROWS.map((entry) =>
              collapsed ? (
                <button
                  key={entry.key}
                  type="button"
                  aria-label={t(entry.key)}
                  title={t(entry.key)}
                  onClick={() => onNav(entry)}
                  className="mavis-sidebar-icon-item flex size-[34px] flex-shrink-0 items-center justify-center rounded-[8px] text-icon_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
                >
                  <Icon name={iconForNav(entry.key)} />
                </button>
              ) : (
                <NavRow
                  key={entry.key}
                  label={t(entry.key)}
                  shortcut={entry.shortcut}
                  onClick={() => onNav(entry)}
                >
                  <Icon name={iconForNav(entry.key)} />
                </NavRow>
              ),
            )}
          </nav>

          {/* Stays mounted while the rail is showing so its rows and scroll
              position survive the collapse. */}
          <div className={collapsed ? "hidden" : "relative min-h-0 flex-1"}>
            <SessionTree t={t} />
          </div>

          {/* Rail mode needs a spacer of its own. The tree above is what normally
              pushes the footer to the bottom, and `hidden` removes it from the flex
              layout entirely — without this the footer sits directly under the nav and
              its menu, which opens upward, is laid out above the viewport and cannot be
              clicked. */}
          {collapsed ? <div className="min-h-0 flex-1" aria-hidden /> : null}

          <SidebarFooter
            t={t}
            plan={state?.usage?.plan ?? ""}
            workspaceName={workspaceLeaf(state?.workspace?.dir)}
            onOpenAlerts={onBell}
            onOpenSettings={onOpenSettings}
            alertCount={alertCount}
            rail={collapsed}
          />
        </div>
      </div>

      {collapsed ? null : (
        <div
          role="separator"
          aria-label={t("sidebar.resize")}
          className="group absolute top-0 bottom-0 z-[60] cursor-col-resize"
          style={{ left: width - 4, width: 8 }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="absolute top-1/2 left-1/2 h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-text_default_tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
        </div>
      )}
    </>
  );
}

function iconForNav(key: MessageKey): Parameters<typeof Icon>[0]["name"] {
  switch (key) {
    case "topbar.newSession":
      return "plusCircle";
    case "sidebar.search":
      return "search";
    case "sidebar.plugins":
      return "plugins";
    case "sidebar.scheduled":
      return "scheduled";
    case "sidebar.websites":
      return "website";
    case "sidebar.mobile":
      return "mobile";
    case "sidebar.remote":
      return "remote";
    case "sidebar.settings":
      return "settings";
    default:
      return "plusSmall";
  }
}

/**
 * A nav row: upstream's `button.group/nav` with its kbd badge.
 *
 * The kbd is upstream's, class for class: a rounded-full pill in
 * `bg-bg_grouped_primary` that is **invisible until the row is hovered or
 * focused** (`opacity-0 group-hover/nav:opacity-100 group-focus-within/nav:opacity-100`).
 * That is the behaviour to preserve — the shortcut stays out of the way until you
 * are looking at the row, and it is why the badge is a real `<kbd>` rather than
 * always-on text. Upstream also marks the current surface by swapping the hover
 * colour for a permanent `bg-bg_interaction_tertiary_hover`, which is what `active`
 * does here.
 */
function NavRow({
  label,
  shortcut,
  active,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={[
        "group/nav flex h-8 w-full items-center gap-2 rounded-lg pl-2 pr-2.5 text-sm transition-colors",
        active
          ? "bg-bg_interaction_tertiary_hover text-text_default_primary"
          : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover",
      ].join(" ")}
    >
      <span className="flex size-4 flex-shrink-0 items-center justify-center">{children}</span>
      <span className="min-w-0 flex-1 truncate text-left whitespace-nowrap">{label}</span>
      {shortcut ? (
        <kbd
          className="inline-flex shrink-0 items-center justify-center rounded-full bg-bg_grouped_primary px-1.5 py-0.5 font-sans text-caption-small-strong slashed-zero text-text_default_secondary opacity-0 transition-opacity pointer-events-none group-hover/nav:opacity-100 group-focus-within/nav:opacity-100"
        >
          {shortcut}
        </kbd>
      ) : null}
    </button>
  );
}

/**
 * SidebarFooter is the avatar / name / plan row at the bottom of the sidebar.
 * Clicking the avatar (or, when the rail is collapsed, the avatar button) opens
 * the account menu.
 *
 * The account menu is **1:1 with the upstream `user_menu`** (function `e7`
 * in `page-b7c7b58f4fd0d4c1.js`, offset 627389). It has:
 *
 * Upstream also puts a profileCard at the top — realUserID + copy, workspace
 * name + plan tier, and an Upgrade / Manage button. The webui does not render
 * it: the id has no source, the workspace name and the plan tier are two
 * different things that read as one identity when stacked, the account name and
 * plan already show on the footer row, and a permanently disabled Manage button
 * is not a feature. Its rows are absent rather than faked.
 *   - Settings — the `R.ewm` settings glyph.
 *   - Daily check-in — `R.OgN`; shown only when signed in. The webui engine
 *     contract for the check-in is not implemented yet, so the row opens a
 *     placeholder Tooltip saying so rather than a panel.
 *   - Usage — `R.Mcw`; opens a hover Tooltip popover (function `Q`, offset
 *     599872) with the live quota snapshot from `api.getQuota()`. NOT a
 *     panel — upstream is hover Tooltip only.
 *   - Contact us — `R.AkR`; submenu with Discord / Feishu / Twitter /
 *     Email / Security entries (some are conditional on platform features;
 *     webui only renders the entries it can actually back).
 *   - Learn more — `R.Mxk`; submenu with Tools / About / Terms / Privacy /
 *     Open-source.
 *   - Sign out — `R.R0g`; webui has no logout endpoint yet, so the row is
 *     disabled with a tooltip.
 *
 * Rows upstream does not have are not rendered — keeping a webui-invented row
 * next to a real upstream row was what the user flagged as 歪的.
 */
/** Last path segment of a workspace directory, for display. */
function workspaceLeaf(dir: string | undefined): string {
  if (!dir) return "";
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

function SidebarFooter({
  t,
  plan,
  workspaceName,
  onOpenAlerts,
  onOpenSettings,
  alertCount = 0,
  rail = false,
}: {
  t: (key: MessageKey) => string;
  /** Active plan tier as reported by the engine's quota API; empty when unknown. */
  plan: string;
  /** Name of the workspace this session runs in. */
  workspaceName: string;
  onOpenAlerts: () => void;
  /** Rail mode: only the avatar fits, and the menu opens from it. */
  rail?: boolean;
  onOpenSettings?: () => void;
  alertCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<"contact" | "learn" | null>(null);
  const [usageHover, setUsageHover] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Same dismissal contract as the composer's dropdown: outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The submenu panel is portalled to document.body, so it lives outside
      // `rootRef` — also check it so a click inside the submenu doesn't
      // close the parent menu before the click lands.
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      if (document.querySelector("[data-testid='sidebar-user-submenu']")?.contains(target)) return;
      setOpen(false);
      setSubmenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setSubmenu(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The account card reads the engine through /api/account rather than the state
  // snapshot: the snapshot is broadcast to every SSE subscriber, so account data
  // does not belong in it. Re-fetched when the menu opens, so a login or a plan
  // change shows up without a reload. The props remain the fallback for the
  // moment before the first response — they are real snapshot values, not
  // stand-ins.
  const [account, setAccount] = useState<api.AccountPayload | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .getAccount()
      .then((payload) => {
        if (live) setAccount(payload);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open]);
  const name = account?.identity?.name || workspaceName;
  const planTier = account?.tokenPlan?.tier || plan;

  /** Run a menu action and close the menu in one step. */
  const pick = (action: () => void) => () => {
    setOpen(false);
    setSubmenu(null);
    action();
  };

  /**
   * The account menu. Shared by both footer shapes: the full row (expanded) and
   * the rail avatar (collapsed) — the desktop's rail puts the same dropdown on a
   * single avatar button.
   */
  const menu = open ? (
    <div
      ref={menuRef}
      role="menu"
      data-testid="sidebar-user-menu"
      className="absolute right-1 bottom-[calc(100%+4px)] left-1 z-[100] rounded-[12px] border border-border_default bg-bg_grouped_secondary_elevated p-3 shadow-shadow_default"
    >
      <div className="my-2 h-px bg-border_default" role="separator" />
      <MenuRow
        icon="settings"
        label={t("sidebar.settings")}
        onClick={pick(() => onOpenSettings?.())}
      />
      <MenuRow
        icon="gift"
        label={t("userMenu.checkin")}
        chevron
        disabled
        title={t("common.unsupported")}
      />
      <UsageMenuRow
        t={t}
        onHoverChange={setUsageHover}
        isOpen={usageHover}
      />
      <div className="my-2 h-px bg-border_default" role="separator" />
      {/* A panel is an absolutely-positioned sibling of its trigger here, so
          putting the hover handlers on the trigger alone closed the submenu in
          the same tick the pointer crossed toward the panel. One hover
          container owns the row and its panel; because the panel is a DOM
          descendant of that container, React keeps the hover alive while the
          pointer travels, and the panel has to overlap the row by a few pixels
          so the path between them never leaves the container. */}
      <div
        className="relative"
        onMouseEnter={() => setSubmenu("contact")}
        onMouseLeave={() => setSubmenu((current) => (current === "contact" ? null : current))}
      >
        <SubmenuTrigger
          icon="contact"
          label={t("userMenu.contactUs")}
          isOpen={submenu === "contact"}
          onActivate={pick(() => setSubmenu(null))}
        />
        {submenu === "contact" ? <ContactSubmenu t={t} /> : null}
      </div>
      <div
        className="relative"
        onMouseEnter={() => setSubmenu("learn")}
        onMouseLeave={() => setSubmenu((current) => (current === "learn" ? null : current))}
      >
        <SubmenuTrigger
          icon="learnMore"
          label={t("userMenu.learnMore")}
          isOpen={submenu === "learn"}
          onActivate={pick(() => setSubmenu(null))}
        />
        {submenu === "learn" ? <LearnMoreSubmenu t={t} /> : null}
      </div>
      <MenuRow
        icon="logout"
        label={t("userMenu.signOut")}
        disabled
        title={t("common.unsupported")}
      />
    </div>
  ) : null;

  if (rail) {
    return (
      <div ref={rootRef} className="relative flex-shrink-0 border-t-[0.5px] border-border_default">
        {menu}
        <button
          type="button"
          data-testid="sidebar-user-menu-trigger-rail"
          aria-label={t("sidebar.menu")}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="group/avatar flex size-[52px] cursor-pointer items-center justify-center"
        >
          <span className="flex size-6 items-center justify-center overflow-hidden rounded-full transition-[filter] group-hover/avatar:brightness-110">
            <span className="flex size-6 items-center justify-center rounded-full bg-bg_grouped_tertiary text-xs text-text_default_primary">
              {name.slice(0, 1).toUpperCase()}
            </span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative flex-shrink-0 border-t-[0.5px] border-border_default">
      {menu}

      <div
        data-testid="sidebar-user-menu-trigger"
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("sidebar.menu")}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
        className="m-1 flex h-12 w-[calc(100%-8px)] flex-1 items-center overflow-hidden rounded-[10px] px-2 hover:bg-bg_interaction_tertiary_hover"
      >
        <div className="flex size-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-border_light">
          <span className="flex size-7 items-center justify-center rounded-full bg-bg_grouped_tertiary text-sm font-medium text-text_default_primary">
            {name.slice(0, 1).toUpperCase()}
          </span>
        </div>
        <div className="ml-2 flex min-w-0 max-w-[135px] flex-1 flex-col gap-[2px]">
          <span className="max-w-[135px] truncate text-[14px] font-[400] leading-[20px] text-text_default_primary">
            {name}
          </span>
          <span className="max-w-[135px] truncate text-[12px] font-[400] leading-[16px] text-text_default_tertiary">
            {planTier}
          </span>
        </div>

        {/* 站内信 (inbox). Upstream keeps this entry at the end of the user row
            (`ml-auto`) with its own tooltip and unread dot; the click must not
            bubble into the row's menu toggle. */}
        <button
          type="button"
          aria-label={alertCount > 0 ? t("inbox.entryUnread") : t("inbox.entryNoUnread")}
          title={t("inbox.title")}
          data-testid="inbox-entry"
          onClick={(event) => {
            event.stopPropagation();
            onOpenAlerts();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          className="relative ml-auto flex size-8 flex-shrink-0 items-center justify-center rounded-[8px] border-0 bg-transparent p-0 text-icon_default_primary transition-colors duration-150 hover:bg-bg_interaction_tertiary_hover"
        >
          <Icon name="bell" size={20} />
          {alertCount > 0 ? (
            <span
              data-testid="inbox-unread-dot"
              aria-hidden="true"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-bg_interaction_danger_primary_default"
            />
          ) : null}
        </button>
      </div>
    </div>
  );
}

/**
 * One row of the account menu: leading glyph, label, optional trailing value or
 * chevron. `disabled` rows are the reference menu's entries this server cannot
 * back yet — they stay visible and say why on hover.
 */
function MenuRow({
  icon,
  label,
  value,
  chevron,
  disabled,
  title,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  value?: string;
  chevron?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={[
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
        disabled
          ? "cursor-not-allowed text-text_default_tertiary opacity-50"
          : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover",
      ].join(" ")}
    >
      <span
        className={[
          "flex size-4 flex-shrink-0 items-center justify-center",
          disabled ? "text-icon_default_tertiary" : "text-icon_default_secondary",
        ].join(" ")}
      >
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value ? (
        <span className="flex-shrink-0 text-caption-small-strong text-text_default_tertiary">
          {value}
        </span>
      ) : null}
      {chevron ? (
        <span className="flex flex-shrink-0 items-center justify-center text-icon_default_tertiary">
          <Icon name="chevronRight" size={14} />
        </span>
      ) : null}
    </button>
  );
}

/**
 * Usage row + hover Tooltip popover. Upstream uses `Tooltip trigger="hover"
 * placement="rightTop"` wrapping a chevron row, with `Q` (offset 599872) as
 * the popover content. webui has no `processedQuotas[]` yet (only a single
 * `QuotaSnapshot` with `remaining` / `resetAt` / `weeklyResetAt`), so the
 * popover renders one labelled *Quota* row today and grows more rows as the
 * engine adds the per-window breakdown.
 */
function UsageMenuRow({
  t,
  onHoverChange,
  isOpen,
}: {
  t: (key: MessageKey) => string;
  onHoverChange: (open: boolean) => void;
  isOpen: boolean;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  // Track a wrapped hover state so the popover stays open while the cursor
  // moves between the row and the popover itself. Without this, the row's
  // `mouseleave` fires before the popover's `mouseenter` and the popover
  // disappears in the same tick the user tries to read it.
  const hoverAreaRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Anchor the popover to the right of the row, vertically centered on the
    // row. Use `left` (not `right`) so the popover naturally extends right
    // from the row's right edge — `right: window.innerWidth - rect.left + 6`
    // (the earlier formula) places the popover to the LEFT of the row, which
    // is off-screen for a sidebar-on-the-left layout.
    const popoverWidth = 260;
    const left = Math.min(
      rect.right + 6,
      window.innerWidth - popoverWidth - 8,
    );
    setPosition({
      top: rect.top + rect.height / 2,
      left,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [isOpen, place]);

  // The hover area wraps row + popover so a single mouseEnter/Leave pair
  // governs the open state and the row ↔ popover gap doesn't cause flicker.
  return (
    <div
      ref={hoverAreaRef}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        data-testid="sidebar-user-usage-row"
        onFocus={() => onHoverChange(true)}
        onBlur={() => onHoverChange(false)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
      >
        <span className="flex size-4 flex-shrink-0 items-center justify-center text-icon_default_secondary">
          <Icon name="gauge" size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate">{t("toolbar.usage")}</span>
        <span className="flex flex-shrink-0 items-center justify-center text-icon_default_tertiary">
          <Icon name="chevronRight" size={14} />
        </span>
      </button>
      {isOpen && position && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              data-testid="sidebar-user-usage-popover"
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                transform: "translateY(-50%)",
                zIndex: 110,
              }}
              className="w-[260px] rounded-[12px] border border-border_default bg-bg_grouped_secondary_elevated p-3 shadow-shadow_default"
            >
              <UsagePopover t={t} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function UsagePopover({ t }: { t: (key: MessageKey) => string }) {
  const [quota, setQuota] = useState<api.QuotaSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      if (refresh) await api.refreshUsage();
      const next = await api.getQuota();
      setQuota(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const used = typeof quota?.remaining === "number" ? Math.max(0, Math.min(100, 100 - quota.remaining)) : null;
  const reset = quota?.resetAt
    ? new Date(quota.resetAt > 1e12 ? quota.resetAt : quota.resetAt * 1000).toLocaleString()
    : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-caption-small-strong text-text_default_primary">{t("usagePopover.title")}</span>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={busy}
          className="flex size-5 items-center justify-center rounded text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
          title={t("usagePopover.refresh")}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {error ? (
        <div className="flex flex-col gap-1">
          <span className="text-caption-small-strong text-text_default_primary">{t("usagePopover.errorTitle")}</span>
          <span className="text-caption-small text-text_default_tertiary">{t("usagePopover.errorBody")}</span>
        </div>
      ) : quota?.ok && used !== null ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-caption-small text-text_default_tertiary">{t("usagePopover.quota")}</span>
            <span className="text-caption-small-strong text-text_default_primary">{used}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-bg_grouped_primary">
            <div
              className="h-full rounded-full bg-bg_interaction_primary_default"
              style={{ width: `${used}%` }}
            />
          </div>
          {reset ? (
            <span className="text-caption-small text-text_default_tertiary">
              {t("usage.reset")}: {reset}
            </span>
          ) : null}
        </div>
      ) : (
        <span className="text-caption-small text-text_default_tertiary">{t("usagePopover.unavailable")}</span>
      )}
    </div>
  );
}

/**
 * A row whose hover opens a submenu rendered to the right of the trigger.
 * Upstream renders Contact us / Learn more as direct menu rows with a
 * trailing chevron — the submenu panel is a separate antd dropdown anchored
 * to the row. webui reproduces that with mouse-enter / mouse-leave on the
 * row plus a position-tracked popover in document.body.
 */
function SubmenuTrigger({
  icon,
  label,
  isOpen,
  onActivate,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  isOpen: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={isOpen}
      data-testid="sidebar-user-submenu-trigger"
      onClick={onActivate}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
    >
      <span className="flex size-4 flex-shrink-0 items-center justify-center text-icon_default_secondary">
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex flex-shrink-0 items-center justify-center text-icon_default_tertiary">
        <Icon name="chevronRight" size={14} />
      </span>
    </button>
  );
}

function ContactSubmenu({ t }: { t: (key: MessageKey) => string }) {
  return (
    <SubmenuPanel>
      <MenuRow icon="contact" label={t("userMenu.feishu")} disabled title={t("common.unsupported")} />
      <MenuRow icon="contact" label={t("userMenu.email")} disabled title={t("common.unsupported")} />
    </SubmenuPanel>
  );
}

function LearnMoreSubmenu({ t }: { t: (key: MessageKey) => string }) {
  return (
    <SubmenuPanel>
      <MenuRow icon="learnMore" label={t("userMenu.tools")} disabled title={t("common.unsupported")} />
      <MenuRow icon="learnMore" label={t("userMenu.about")} disabled title={t("common.unsupported")} />
      <MenuRow icon="learnMore" label={t("userMenu.terms")} disabled title={t("common.unsupported")} />
      <MenuRow icon="learnMore" label={t("userMenu.privacy")} disabled title={t("common.unsupported")} />
      <MenuRow icon="learnMore" label={t("userMenu.opencodeSource")} disabled title={t("common.unsupported")} />
    </SubmenuPanel>
  );
}

/**
 * The flyout every submenu shares.
 *
 * `left-[calc(100%-8px)]` puts it just past the trigger's right edge while
 * overlapping the trigger by 8px, so the pointer never crosses a region that
 * belongs to neither the row nor the panel — see the hover container in
 * AccountMenu. `right-[calc(100%-8px)]`, which this used before, resolves to
 * a position 8px from the *left* edge of the trigger and so laid the panel
 * out past the left edge of the window, where it could not be seen or
 * clicked.
 *
 * Every entry inside is disabled: the reference client's rows point at
 * product pages and a support mailbox, and this distribution has neither —
 * the targets that used to be here were example.com URLs and a
 * support@example.com address, i.e. links that look live and go nowhere. The
 * rows stay listed and report `common.unsupported` until there is a real
 * target to open.
 */
function SubmenuPanel({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="menu"
      data-testid="sidebar-user-submenu"
      className="absolute top-2 left-[calc(100%-8px)] z-[105] min-w-[180px] rounded-[12px] border border-border_default bg-bg_grouped_secondary_elevated p-2 shadow-shadow_default"
    >
      {children}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary [&>svg]:block"
    >
      {children}
    </button>
  );
}

