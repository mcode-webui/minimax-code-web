"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import { refreshQuota, useSessionContext } from "@/lib/store";
import type { MessageKey } from "@/lib/i18n";
import { Dropdown, Popover } from "antd";
import type { MenuProps } from "antd";
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
 *   - Sign out — `R.R0g`; webui has no logout endpoint yet, so the row is
 *     disabled with a tooltip.
 *
 * Rows upstream does not have are not rendered — keeping a webui-invented row
 * next to a real upstream row was what the user flagged as 歪的.
 *
 * Upstream's Contact us (`R.AkR`) and Learn more (`R.Mxk`) submenus are not
 * rendered, and their extracted glyphs were deleted 2026-09-24. Their entries
 * point at product pages and a support mailbox that this distribution does not
 * have, so every row would have been a disabled placeholder — exactly the
 * "invented row next to a real one" shape the user rejected. There is nothing
 * to route to, so the menu does not carry them at all. If a real target ever
 * lands, the upstream module ids above are the source to re-extract from.
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
  const rootRef = useRef<HTMLDivElement>(null);

  // Outside-click and Escape dismissal are antd's now (the Dropdown owns them),
  // which is why the hand-rolled `mousedown` listener that used to live here is
  // gone: it had to know about every portalled flyout, and it got that wrong.
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
    action();
  };

  /**
   * The account menu: antd's `Dropdown` + `Menu`, because that is what the
   * desktop's menu is (`DESIGN.md` maps its `mavis-dropdown` onto antd
   * `Dropdown`). The hand-rolled version re-implemented what the library owns —
   * outside-click and Escape dismissal, portal placement, hover-to-open — and each
   * of those was a defect in this file at some point.
   *
   * Shared by both footer shapes: the full row (expanded) and the rail avatar
   * (collapsed) — the desktop's rail puts the same dropdown on a single avatar
   * button.
   *
   * The panel's *appearance* is the desktop's too: `overlayClassName` carries its
   * `mavis-dropdown mavis-user-dropdown`, which the ported skin keys off. Without
   * it the menu would be antd's default — content-sized, 8px radius, no hairline,
   * a different shadow — and its items would keep antd's own padding.
   */
  const menuItems: MenuProps["items"] = [
    {
      key: "settings",
      label: <MenuRow icon="settings" label={t("sidebar.settings")} />,
      onClick: () => pick(() => onOpenSettings?.())(),
    },
    {
      key: "checkin",
      disabled: true,
      label: (
        <MenuRow
          icon="gift"
          label={t("userMenu.checkin")}
          chevron
          disabled
          title={t("common.unsupported")}
        />
      ),
    },
    { key: "usage", label: <MenuRow icon="gauge" label={<UsageLabel t={t} />} /> },
    { key: "divider", disabled: true, label: <MenuDivider /> },
    {
      key: "signOut",
      disabled: true,
      label: (
        <MenuRow
          icon="logout"
          label={t("userMenu.signOut")}
          disabled
          title={t("common.unsupported")}
        />
      ),
    },
  ];

  return (
    <div ref={rootRef} className="relative flex-shrink-0 border-t-[0.5px] border-border_default">
      <Dropdown
        open={open}
        onOpenChange={setOpen}
        trigger={["click"]}
        /* Upward from the footer, aligned with the row: the desktop's menu opens
           over the sidebar rather than beside it. */
        placement="topLeft"
        /* The desktop's own class names. The panel's width, radius, hairline,
           shadow and item padding are not theme tokens, so they live in the ported
           skin (`styles/mavis-dropdown.css`) keyed off exactly these two. */
        overlayClassName="mavis-dropdown mavis-user-dropdown"
        menu={{
          items: menuItems,
          rootClassName: "mavis-dropdown-root-sub-menu mavis-user-dropdown-submenu",
          style: { width: "100%" },
        }}
        /* `popupRender` wraps the menu itself, which is where the testid has to
           live: `MenuProps` does not accept arbitrary attributes. */
        popupRender={(menuNode) => <div data-testid="sidebar-user-menu">{menuNode}</div>}
      >
        {rail ? (
          <button
            type="button"
            data-testid="sidebar-user-menu-trigger-rail"
            aria-label={t("sidebar.menu")}
            className="group/avatar flex size-[52px] cursor-pointer items-center justify-center"
          >
            <span className="flex size-6 items-center justify-center overflow-hidden rounded-full transition-[filter] group-hover/avatar:brightness-110">
              <span className="flex size-6 items-center justify-center rounded-full bg-bg_grouped_tertiary text-xs text-text_default_primary">
                {name.slice(0, 1).toUpperCase()}
              </span>
            </span>
          </button>
        ) : (
          /* A `div` rather than a `button`: the row contains the inbox button, and
             a button inside a button is not valid. antd clones this child and
             attaches its own click handler plus `aria-expanded`, so the keyboard
             handling is the only part left to state here. */
          <div
            data-testid="sidebar-user-menu-trigger"
            role="button"
            tabIndex={0}
            aria-label={t("sidebar.menu")}
            /* antd clones this child and attaches its own click handler, but it
               does not set `aria-expanded` on a `div` child — the state is ours
               to publish. */
            aria-haspopup="menu"
            aria-expanded={open}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpen(true);
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
        )}
      </Dropdown>
    </div>
  );
}

/**
 * One row of the account menu: an 18px leading glyph, the label, and an optional
 * trailing chevron.
 *
 * This is the row's *content*; the item around it is antd's `li` — radius, hover,
 * focus and the disabled state are the library's. The desktop splits the two the
 * same way and its stylesheet keys off `.matrix-menu-item`, so the class is kept
 * verbatim along with the `p-1.5` that supplies the row's padding. The item's own
 * padding is reset to zero by the ported skin; without that reset antd's `5px
 * 12px` would add to this and the rows would sit 20px in from the panel edge
 * instead of 6px.
 *
 * `disabled` is a prop rather than something read off the item: the desktop dims
 * the row itself (`opacity-20`) rather than relying on antd's disabled text
 * colour, which the row's own colour class would override anyway.
 */
function MenuRow({
  icon,
  label,
  chevron,
  disabled,
  title,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: React.ReactNode;
  chevron?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      className={`matrix-menu-item flex w-full min-w-0 items-center overflow-hidden p-1.5 text-[14px] text-text_default_primary ${
        disabled ? "cursor-not-allowed opacity-20" : "cursor-pointer"
      }`}
    >
      <div className="relative flex w-full min-w-0 items-center gap-2 md:min-w-[108px]">
        <div
          className="mavis-user-menu-icon flex flex-shrink-0 items-center justify-center"
          style={{ width: 18, height: 18 }}
        >
          <Icon name={icon} size={18} />
        </div>
        <div className="flex min-w-0 flex-1 items-center font-[400] leading-5">
          <span className="flex w-full min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {chevron ? (
              <Icon
                name="chevronRight"
                size={16}
                className="shrink-0 text-icon_default_tertiary"
              />
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The menu's group separator.
 *
 * Not antd's `type: "divider"`, which draws its own line at its own inset: the
 * desktop renders a hairline in `--border_default` as a disabled item's label, so
 * it inherits the panel's 4px padding and the menu's item spacing. Same
 * construction here — including the `mavis-user-menu-divider` class, which is what
 * restores the opacity the disabled state would otherwise dim.
 */
function MenuDivider() {
  return (
    <div className="mavis-user-menu-divider pointer-events-none flex h-[4px] items-center">
      <div className="h-[1px] w-full bg-border_default" />
    </div>
  );
}

/**
 * The usage row's label: the text plus a chevron that opens the quota flyout on
 * hover.
 *
 * antd `Popover` rather than the hand-rolled flyout this replaces — the portal,
 * the placement and the gap between the row and the panel are the library's, and
 * each of those was a defect here at some point (the old formula resolved from the
 * wrong edge and opened off-screen; its `mouseleave` fired before the panel's
 * `mouseenter` and the panel vanished in the same tick). The delays and the offset
 * are the desktop's.
 *
 * The row is a menu item's click target, so the flyout stops the click: opening
 * the quota panel must not also close the menu behind it.
 */
function UsageLabel({ t }: { t: (key: MessageKey) => string }) {
  return (
    <Popover
      trigger="hover"
      placement="rightTop"
      align={{ offset: [4, -4] }}
      mouseEnterDelay={0.05}
      mouseLeaveDelay={0.15}
      arrow={false}
      overlayClassName="mavis-popover-overlay mavis-usage-popover-overlay"
      content={<UsagePopover t={t} />}
    >
      <span
        data-testid="sidebar-user-usage-row"
        onClick={(event) => event.stopPropagation()}
        className="inline-flex w-full cursor-default items-center justify-between gap-2"
      >
        <span>{t("toolbar.usage")}</span>
        <Icon name="chevronRight" size={16} className="shrink-0 text-icon_default_tertiary" />
      </span>
    </Popover>
  );
}

function UsagePopover({ t }: { t: (key: MessageKey) => string }) {
  // The figures live in the store, which polls them on its own timer, so opening
  // this popover shows the current number instead of starting from empty — and
  // the manual refresh is an extra read, not the only way to get one.
  const { quota, quotaBusy, quotaError } = useSessionContext();
  const error = quotaError;
  const busy = quotaBusy;

  useEffect(() => {
    void refreshQuota();
  }, []);

  // The engine reports two quota windows: one rolling over 5 hours and one
  // weekly. Both are rendered. A single row could only ever describe one of
  // them, which is how the weekly figure went missing while the API was already
  // returning it. A window with no figure is dropped rather than drawn as 0%.
  const windows = [
    {
      key: "fiveHour",
      label: t("usagePopover.fiveHour"),
      remaining: quota?.remaining,
      resetAt: quota?.resetAt,
    },
    {
      key: "weekly",
      label: t("usagePopover.weekly"),
      remaining: quota?.weeklyRemaining,
      resetAt: quota?.weeklyResetAt,
    },
  ].filter((w) => typeof w.remaining === "number");

  return (
    <div data-testid="sidebar-user-usage-popover" className="flex w-full flex-col gap-2">
      <div className="flex items-center justify-between px-2 pt-1">
        <span className="text-[14px] leading-5 text-text_default_primary">{t("usagePopover.title")}</span>
        <button
          type="button"
          // `record` — the user asked for fresh figures, so this reading is also
          // a forecast sample.
          onClick={() => void refreshQuota(true)}
          disabled={busy}
          className="flex size-5 items-center justify-center rounded text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
          title={t("usagePopover.refresh")}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {error ? (
        <div className="flex flex-col gap-1 px-2">
          <span className="text-[14px] leading-5 text-text_default_primary">{t("usagePopover.errorTitle")}</span>
          <span className="text-[12px] leading-4 text-text_default_secondary">{t("usagePopover.errorBody")}</span>
        </div>
      ) : quota?.ok && windows.length > 0 ? (
        windows.map((w) => {
          // `remaining` is what is left; the row reports what was used. The
          // desktop's row is text only — it draws no bar, so neither does this.
          const used = Math.max(0, Math.min(100, 100 - (w.remaining as number)));
          const reset = w.resetAt
            ? new Date(w.resetAt > 1e12 ? w.resetAt : w.resetAt * 1000).toLocaleString()
            : null;
          return (
            <div key={w.key} className="flex flex-col gap-1 overflow-hidden rounded-[8px] px-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-normal leading-5 text-text_default_primary">{w.label}</span>
                <span className="text-[14px] font-normal leading-5 text-text_default_primary">
                  {t("usage.used")} {used}%
                </span>
              </div>
              {reset ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] leading-4 text-text_default_secondary">{t("usage.reset")}</span>
                  <span className="text-[12px] leading-4 text-text_default_secondary">{reset}</span>
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <span className="px-2 text-[12px] leading-4 text-text_default_secondary">
          {t("usagePopover.unavailable")}
        </span>
      )}
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

