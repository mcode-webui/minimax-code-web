"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import { useSessionContext } from "@/lib/store";
import type { MessageKey } from "@/lib/i18n";
import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import { Icon } from "./icons";
import { InboxFlyout } from "./inbox";
import { SessionTree } from "./session-tree";
import { runAction } from "@/lib/action-errors";
import { isSidebarNavActive, type SidebarNavSurface } from "@/lib/sidebar-nav";
import {
  readShellCollapsedFromPersistedState,
  writePersistedShellCollapsed,
} from "@/lib/persist";
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
// 240–400, and a 64px icon rail when collapsed — the sidebar never becomes a
// zero-width column. webui-parity 47 (C1) raised the rail from 52px to the
// reference's 64px so the collapsed icon column breathes the same way.
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;
const SIDEBAR_RAIL = 64;
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
   * Slice 17 — open a tree-column surface by SurfaceTabKind.
   * The legacy `onOpenPanel("search")` route no longer exists
   * (slice 17 removed "search" from the PanelKind union); the
   * sidebar's 搜索 entry dispatches through here so the page can
   * route to the new tree-column surface.
   */
  onOpenSurfaceTab?: (kind: "search") => void;
  /**
   * Open the settings dialog. Separate from `onOpenPanel` because settings is a
   * dismissible modal, not a drawer panel (see components/panels.tsx).
   */
  onOpenSettings?: () => void;
  /**
   * Open the settings dialog on the 用量与模型 section. The user menu's usage
   * row dispatches through here (user decision 2026-09-28: the entry jumps to
   * the settings section rather than hosting its own flyout).
   */
  onOpenUsage?: () => void;
  /** Unread alert count, shown on the account menu's Alerts row. */
  alertCount?: number;
  /**
   * Slice 15 — when the conversation column lives inside the new
   * workspace-columns shell (the `panel` slot), the children
   * column is empty and the disclaimer should not render there.
   * When false (home screen), the children column is the
   * conversation column and the disclaimer appears below it.
   */
  hasConversation?: boolean;
  /**
   * webui-parity 47 (N2) — which tree-column surface the sidebar should mark
   * as active. The tab strip lives in the page (page.tsx owns `tabState`),
   * so the page computes "the tree column's active tab is search/plugins"
   * and hands it down; the nav row cannot read it anywhere else. Null when
   * no sidebar-owned surface is the active one.
   */
  activeNavSurface?: "search" | "plugins" | null;
}

export function AppShell({ t, children, toolbar, panel, onOpenPanel, onOpenSurfaceTab, onOpenSettings, onOpenUsage, alertCount = 0, hasConversation = false, activeNavSurface = null }: ShellProps) {
  // The sidebar is collapsible from the button in its own top strip. The state
  // lives here rather than in `Sidebar` because the expand affordance has to be
  // rendered by the content column once the sidebar is clipped away.
  //
  // Webui-parity 07 — additive: seed `collapsed` from the persisted UI state
  // (see webapp/lib/persist.ts: same keyspace and version guard as
  // slice 01's files-tree slice). The existing onResize handler still
  // wins on narrow viewports, so a mobile user opening the page narrow
  // sees the auto-collapsed rail rather than their saved desktop
  // preference — that is the same upstream trade-off. The save effect
  // below writes the user's toggles back into the same payload.
  const [collapsed, setCollapsed] = useState<boolean>(() => readShellCollapsedFromPersistedState());
  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);

  // Mirror the toggle back into the persisted UI-state payload. Best-
  // effort, debounced inside `writePersistedShellCollapsed`.
  useEffect(() => {
    writePersistedShellCollapsed(collapsed);
  }, [collapsed]);

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
        onOpenSurfaceTab={onOpenSurfaceTab}
        onOpenSettings={onOpenSettings}
        onOpenUsage={onOpenUsage}
        alertCount={alertCount}
        onOpenAlerts={toggleInbox}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        activeNavSurface={activeNavSurface}
      />
      <InboxFlyout open={inboxOpen} onClose={closeInbox} t={t} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative flex h-full min-w-0 flex-1 flex-col">
          {/* webui-parity 47 (C6): while the rail is collapsed the toolbar's
              title row would otherwise jump ~180px left, because the flex row
              reclaims the sidebar's width. The reference compensates with
              `pl-[142px]` on its session title row (64px rail + 142px ≈ the
              expanded title position), so the same constant is applied here
              rather than inventing one. The padding wraps the toolbar slot,
              not the content, matching what the reference compensates. */}
          <div className={collapsed ? "pl-[142px]" : undefined}>{toolbar}</div>

          <div className="flex min-h-0 flex-1">
            {/* The AI-content disclaimer lives in the conversation column, not
                beside the drawer: as a sibling of this row it spanned the full
                width, so `text-center` centred it across the drawer as well and
                it read as sitting under the drawer. It stays outside the
                transcript's scroll container so it does not scroll away with
                the messages, and it is rendered on the home screen too.
                Slice 15 hides it on the conversation screen because
                the conversation column now lives INSIDE the new
                workspace-columns shell (the `panel` slot), which
                renders its own disclaimer copy at the bottom of the
                chat column. On the home screen the conversation
                column is the children area, so the disclaimer still
                appears here. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {children}
              {!hasConversation ? (
                <p
                  data-testid="app-disclaimer"
                  className="flex-none px-4 pt-1 pb-2 text-center text-caption-small-strong text-text_default_secondary"
                >
                  {t("home.disclaimer")}
                </p>
              ) : null}
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
// Slice 17 — re-added the 搜索 nav entry. Slice 15 dropped
// "定时 / 网站 / 远程" because nothing behind them was
// implemented. Slice 17 has both 搜索 and 插件 as tree-column
// surfaces (column 4), so they both belong in the sidebar nav.
// 搜索 dispatches through `onOpenSurfaceTab` (a new prop added
// in slice 17); 插件 dispatches through `onOpenPanel` (a
// legacy PanelKind that survived the slice-17 trim).
const NAV_ROWS: { key: MessageKey; shortcut?: string }[] = [
  { key: "topbar.newSession", shortcut: "Ctrl+N" },
  { key: "sidebar.search" },
  { key: "sidebar.plugins" },
];

function Sidebar({
  t,
  onOpenPanel,
  onOpenSurfaceTab,
  onOpenSettings,
  onOpenUsage,
  onOpenAlerts,
  alertCount = 0,
  collapsed,
  onToggleCollapsed,
  activeNavSurface,
}: {
  t: (key: MessageKey) => string;
  onOpenPanel?: (kind: PanelKind) => void;
  onOpenSurfaceTab?: (kind: "search") => void;
  onOpenSettings?: () => void;
  onOpenUsage?: () => void;
  /** Toggle the 站内信 flyout anchored beside this sidebar. */
  onOpenAlerts: () => void;
  alertCount?: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** See the `activeNavSurface` prop on `AppShell` (webui-parity 47 N2). */
  activeNavSurface?: "search" | "plugins" | null;
}) {
  const { state } = useSessionContext();
  const sessionId = state?.mcodeSessionId ?? null;
  const [width, setWidth] = useState(SIDEBAR_DEFAULT);
  const dragging = useRef(false);

  // webui-parity 47 (N2) — the nav rows' active wiring. The reference marks
  // each rail row with `data-webui-nav-active` from a real `active` prop; the
  // same signal here drives both the full row and the collapsed icon rail.
  // The rule itself lives in `lib/sidebar-nav.ts` (pure, unit-driven); the
  // inputs are the engine's active session id and the page-owned surface
  // signal handed down through `activeNavSurface`.
  const isNavActive = useCallback(
    (key: MessageKey): boolean => isSidebarNavActive(key, sessionId, activeNavSurface ?? null),
    [activeNavSurface, sessionId],
  );

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
        // Search is a tree-column surface (column 4) in slice 17.
        // `onOpenPanel` no longer accepts the legacy "search"
        // PanelKind (slice 17 removed it from the union); we route
        // through a dedicated `onOpenSurfaceTab` so the page can
        // dispatch to the new SurfaceTabKind vocabulary.
        onOpenSurfaceTab?.("search");
      } else if (entry.key === "sidebar.plugins") {
        // Open the Plugins surface (column 4) — currently a
        // placeholder pending the engine's plugin-install
        // contract. Desktop's sibling-row nav puts plugins at
        // top-level sidebar alongside tasks / scheduled /
        // websites / remote, not as a settings tab.
        onOpenPanel?.("plugins");
      }
    },
    [onOpenPanel],
  );

  return (
    <>
      {/* Collapsing animates the outer width to the 64px rail rather than to
          zero, and the transcript keeps its state: the session tree stays
          mounted (just hidden) so its loaded rows and scroll position survive
          a collapse cycle. webui-parity 47 (C1): 180ms on the reference's own
          cubic-bezier(.2,.7,.2,1), replacing the previous 200ms ease-out. */}
      <div
        className="relative h-full min-h-0 flex-shrink-0 overflow-hidden transition-[width] duration-[180ms] ease-[cubic-bezier(0.2,0.7,0.2,1)]"
        style={{ width: collapsed ? SIDEBAR_RAIL : width }}
      >
        {/* Upstream's sidebar card. Class order and the inline geometry come from
            its live DOM (`data-testid="sidebar-base-card"`): the card itself owns
            the `border-right: 0.6px` hairline and a width/transform/opacity
            transition, which is why the border is inline here rather than a
            utility. webui-parity 47 (C5): the card goes transparent while
            collapsed — the rail is a chromeless strip, and the reference's
            own `webui-rail` swaps `bg-bg_default_scrim` for `bg-transparent`
            on the same branch. */}
        <div
          data-testid="sidebar-base-card"
          data-rail-mode={collapsed ? "true" : "false"}
          className={`relative z-50 flex flex-col overflow-hidden select-none ${collapsed ? "bg-transparent" : "bg-bg_default_scrim"}`}
          style={{
            // The card itself narrows to the rail; only animating the outer
            // wrapper would leave a 240px card clipped to a 52px slice.
            width: collapsed ? SIDEBAR_RAIL : width,
            height: "100%",
            margin: 0,
            borderRight: "0.6px solid var(--border_light)",
          }}
        >
          {/* Upstream's window-drag strip, kept as a spacer. webui-parity 47
              (C2) moved the collapse toggle OUT of the sidebar onto a
              floating overlay (rendered after the separator below), so the
              strip no longer carries a control — it only holds the nav rows'
              vertical offset, which stays 38px so the rows do not shift. */}
          <div className="flex w-full flex-shrink-0 flex-col">
            <div className="relative h-[38px] w-full" aria-hidden />
          </div>

          {/* Nav rows. Upstream's section is `px-2 pt-2 pb-5 space-y-px`. */}
          <nav
            className={
              collapsed
                ? "flex w-[64px] flex-shrink-0 flex-col items-start gap-px px-2 pt-2"
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
                  aria-current={isNavActive(entry.key) ? "true" : undefined}
                  onClick={() => onNav(entry)}
                  className={[
                    "mavis-sidebar-icon-item flex size-[34px] flex-shrink-0 items-center justify-center rounded-[8px] transition-colors",
                    isNavActive(entry.key)
                      ? "bg-bg_interaction_tertiary_hover text-icon_default_primary"
                      : "text-icon_default_primary hover:bg-bg_interaction_tertiary_hover",
                  ].join(" ")}
                >
                  <Icon name={iconForNav(entry.key)} />
                </button>
              ) : (
                <NavRow
                  key={entry.key}
                  label={t(entry.key)}
                  shortcut={entry.shortcut}
                  active={isNavActive(entry.key)}
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
            onOpenUsage={onOpenUsage}
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

      {/* webui-parity 47 (C2/C3) — the collapse toggle lives OUTSIDE the
          sidebar, on a pointer-events-none overlay above the shell, which is
          how the reference places it (`data-webui-sidebar-toggle` in a
          `left-[126px] top-0 z-[60]` strip). Outside the clipping sidebar it
          stays reachable in both states; expanded it sits at the strip's own
          left edge (left-2, where the in-sidebar toggle used to be),
          collapsed it floats just right of the 64px rail. The label flips
          with state (展开导航栏 / 收起导航栏) and `aria-expanded` is the
          machine-readable half of the same signal. */}
      <div
        className="pointer-events-none absolute top-0 z-[60] flex h-[38px] items-center"
        style={{ left: collapsed ? SIDEBAR_RAIL + 8 : 8 }}
      >
        <button
          type="button"
          data-testid="sidebar-collapse-toggle"
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
          className="pointer-events-auto flex size-8 items-center justify-center rounded-[8px] text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary [&>svg]:block"
        >
          <Icon name="sidebar" />
        </button>
      </div>
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
 * in `page-b7c7b58f4fd0d4c1.js`, offset 627389), full row set per ticket 55c
 * (ref-01):
 *
 *   - Settings — the `R.ewm` settings glyph, with the desktop's `Ctrl+,`
 *     kbd badge. The badge is honest: page.tsx binds Ctrl+, to open settings.
 *   - Upgrade — `sparkles` glyph. Cloud-account billing; disabled with the
 *     本地版不适用 tooltip (decision A1).
 *   - Daily check-in — `R.OgN`; no engine contract, disabled placeholder.
 *   - Usage — `R.Mcw`; jumps to the settings page's 用量与模型 section
 *     (user decision 2026-09-28).
 *   - Feedback & help — `headset` glyph. Points at product support surfaces
 *     this distribution does not have; disabled placeholder (A1).
 *   - Sign out — `R.R0g`; no logout endpoint, disabled placeholder.
 *   - A trailing user card — avatar, display name, plan badge, bell.
 *
 * Ticket 55c reversed two earlier trims: the 2026-09-23/24 removals of the
 * Upgrade / Feedback rows (and their glyphs) held that a disabled row next to
 * a real one was the "invented row" shape the user had rejected. The user's
 * 2026-09-29 instruction ("照抄全部截图") re-adds the desktop's full row set
 * with the A1 honesty marker — every cloud-only row renders disabled with the
 * 本地版不适用 tooltip rather than being hidden, so the menu's shape matches
 * the desktop and its limits are stated, not implied.
 *
 * The user card shows the engine-reported identity when there is one
 * (`/api/account`), the 本地用户 placeholder when there is not, the plan tier
 * as a badge when the engine reports one, and a bell that opens the same
 * 站内信 flyout the footer row's bell does (unread dot included). The
 * desktop's UID line at the top of the menu is NOT rendered: a local edition
 * has no account id to print, and an empty or faked id would violate the
 * honesty rule the rest of the menu follows.
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
  onOpenUsage,
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
  /** Opens settings on the 用量与模型 section (the usage row's target). */
  onOpenUsage?: () => void;
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
  // The menu's user card shows the ACCOUNT identity (ref-01), not the
  // workspace: when the engine reports no signed-in identity it carries the
  // 本地用户 placeholder instead of the footer row's workspace-leaf fallback
  // — the card answers "who am I", the footer row answers "where am I".
  const userCardName = account?.identity?.name || t("userMenu.localUser");

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
      label: <MenuRow icon="settings" label={t("sidebar.settings")} kbd="Ctrl+," />,
      onClick: () => pick(() => onOpenSettings?.())(),
    },
    // Ticket 55c (ref-01): the desktop's Upgrade row. Cloud-account billing
    // has no local path, so the row renders disabled with the A1 marker
    // rather than hidden — the menu keeps the desktop's shape.
    {
      key: "upgrade",
      disabled: true,
      label: (
        <MenuRow
          icon="sparkles"
          label={t("userMenu.upgrade")}
          disabled
          title={t("common.notLocal")}
        />
      ),
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
    // The usage row used to host a hover flyout with the quota figures;
    // the figures now live in the settings page's 用量与模型 section and
    // this row jumps there (user decision 2026-09-28). Same shape as the
    // settings row above it.
    {
      key: "usage",
      onClick: () => pick(() => onOpenUsage?.())(),
      label: <MenuRow icon="gauge" label={t("toolbar.usage")} />,
    },
    // Ticket 55c (ref-01): the desktop's 反馈与帮助 row — a support
    // submenu this distribution has no target for. Disabled placeholder.
    {
      key: "feedback",
      disabled: true,
      label: (
        <MenuRow
          icon="headset"
          label={t("userMenu.feedback")}
          chevron
          disabled
          title={t("common.notLocal")}
        />
      ),
    },
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
    // The trailing user card (ref-01 bottom): avatar / name / plan badge /
    // bell. The item itself is inert (no onClick) — only the bell inside
    // acts, opening the same 站内信 flyout the footer row's bell does.
    { key: "divider2", disabled: true, label: <MenuDivider /> },
    {
      key: "userCard",
      label: (
        <UserMenuCard
          name={userCardName}
          planTier={planTier}
          alertCount={alertCount}
          onOpenAlerts={() => pick(() => onOpenAlerts())()}
          t={t}
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
            className="group/avatar flex size-[64px] cursor-pointer items-center justify-center"
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
 * One row of the account menu: an 18px leading glyph, the label, an optional
 * trailing kbd badge (the desktop's Settings row carries `Ctrl+,`) and an
 * optional trailing chevron.
 *
 * Exported because the sidebar's project context menu (session-tree.tsx,
 * ticket 55c) uses the same row construction — same `matrix-menu-item` skin,
 * same padding — so the two menus stay visually one component family.
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
 *
 * `danger` re-colours the row for destructive entries (the project menu's
 * 移除). The desktop paints its danger rows red in both states; here the tint
 * rides the same `text-text_status_error` token the transcript's error marks
 * use.
 */
export function MenuRow({
  icon,
  label,
  chevron,
  disabled,
  danger,
  kbd,
  title,
  testid,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: React.ReactNode;
  chevron?: boolean;
  disabled?: boolean;
  danger?: boolean;
  kbd?: string;
  title?: string;
  testid?: string;
}) {
  return (
    <div
      title={title}
      data-testid={testid}
      className={`matrix-menu-item flex w-full min-w-0 items-center overflow-hidden p-1.5 text-[14px] ${
        danger ? "text-text_status_error" : "text-text_default_primary"
      } ${disabled ? "cursor-not-allowed opacity-20" : "cursor-pointer"}`}
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
            {kbd ? (
              <kbd className="inline-flex shrink-0 items-center justify-center rounded-[4px] bg-bg_grouped_tertiary px-1 py-px font-sans text-[11px] leading-[14px] text-text_default_tertiary">
                {kbd}
              </kbd>
            ) : null}
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
export function MenuDivider() {
  return (
    <div className="mavis-user-menu-divider pointer-events-none flex h-[4px] items-center">
      <div className="h-[1px] w-full bg-border_default" />
    </div>
  );
}

/**
 * The user card at the bottom of the account menu (ref-01): avatar / display
 * name / plan badge / bell.
 *
 * The name is the engine identity when one exists and the 本地用户 placeholder
 * otherwise; the plan badge only renders when the engine reports a tier (no
 * faked "Ultra"); the bell is the same 站内信 entry the footer row carries,
 * unread dot included, and must stop the click before antd's item handler can
 * close the menu on it.
 */
function UserMenuCard({
  name,
  planTier,
  alertCount,
  onOpenAlerts,
  t,
}: {
  name: string;
  planTier: string;
  alertCount: number;
  onOpenAlerts: () => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <div
      data-testid="user-menu-card"
      className="flex w-full min-w-0 items-center gap-2 p-1.5"
    >
      <span className="flex size-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-border_light bg-bg_grouped_tertiary text-sm font-medium text-text_default_primary">
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span
          data-testid="user-menu-card-name"
          className="truncate text-[14px] font-[400] leading-5 text-text_default_primary"
        >
          {name}
        </span>
        {planTier ? (
          <span
            data-testid="user-menu-card-plan"
            className="mt-px w-fit truncate rounded-[4px] bg-bg_grouped_tertiary px-1 py-px text-[11px] leading-[14px] text-text_default_secondary"
          >
            {planTier}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        aria-label={alertCount > 0 ? t("inbox.entryUnread") : t("inbox.entryNoUnread")}
        title={t("inbox.title")}
        data-testid="user-menu-card-bell"
        onClick={(event) => {
          event.stopPropagation();
          onOpenAlerts();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        className="relative flex size-8 flex-shrink-0 items-center justify-center rounded-[8px] border-0 bg-transparent p-0 text-icon_default_primary transition-colors duration-150 hover:bg-bg_interaction_tertiary_hover"
      >
        <Icon name="bell" size={18} />
        {alertCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 size-1.5 rounded-full bg-bg_interaction_danger_primary_default"
          />
        ) : null}
      </button>
    </div>
  );
}

