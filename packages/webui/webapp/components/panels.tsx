"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Input as AntInput,
  type InputRef,
  Modal as AntModal,
  Segmented as AntSegmented,
  Switch,
  Tabs as AntTabs,
} from "antd";

import * as api from "@/lib/api";
import { useAlerts } from "@/lib/alerts";
import {
  deserializeExpansion,
  fileTypeColor,
  filterAncestors,
  formatSize,
  relativeMtimeBucket,
  serializeExpansion,
  shouldShowDirLoadingSuffix,
  sortEntries,
} from "@/lib/files-tree";
import {
  ancestorChain,
  pathsToExpand,
  searchFootSegments,
} from "@/lib/fs-search";
import { InboxList } from "./inbox";
import { useSessionContext } from "@/lib/store";
import { applyTheme, currentTheme } from "@/lib/theme";
import { matchFilter } from "@/lib/workspace-filter";
import { splitFilesByBucket, formatStatusTags, previewDiff } from "@/lib/git-panel";
import { BrowserPanel } from "@/components/browser-panel";
import { isHtmlPath } from "@/lib/browser-nav";
import type { Locale, MessageKey } from "@/lib/i18n";
import type { ThemeName } from "@/lib/types";
import { Icon } from "./icons";
import { ProviderManagementPanel } from "./provider-management";
import { FilePreviewPane } from "./file-preview-pane";

/**
 * Right-hand drawer.
 *
 * The container is upstream's right panel, reproduced as-is: an `aside` with a
 * width transition and an inset shadow on its left edge
 * (`shadow-[inset_8px_0px_12px_-8px_var(--opacity_black_1_8)]`), so opening it
 * looks like upstream's panel opening. The width is **fixed** at 288px so every
 * panel — workspace / files / alerts / search / progress / plugins — is the
 * same size regardless of viewport or content.
 *
 * Upstream fills that panel with a file/diff preview. This frontend has no such
 * feature, so the shell carries the panels this server actually backs. Settings
 * is *not* here — it is a dismissible dialog (`SettingsModal` below), because it
 * is a destination the user opens and closes rather than a side-by-side
 * surface.
 */

export type PanelKind =
  | "workspace"
  | "files"
  | "git"
  | "plugins"
  | "browser";

export function RightPanel({
  kind,
  onClose,
  t,
  locale,
  workspaceDir,
  browserPath,
  onBrowserNavigate,
  onOpenInBrowser,
  onOpenFile,
}: {
  kind: PanelKind;
  /** Used by the search panel for its own Esc/blanket/close affordance. The
   *  container does not render its own close button (upstream's Drawer has
   *  no title row, see 反编译 eK in 36705 chunk). */
  onClose: () => void;
  t: (key: MessageKey) => string;
  locale: Locale;
  /** Active workspace dir (slice 04b wiring). Forwarded into
   *  `BrowserPanel` so workspace-relative entries resolve against it
   *  before reaching `/api/fs/raw`. Empty string means "no workspace
   *  yet" — the panel renders its empty state, no iframe. */
  workspaceDir: string;
  /** Currently-open browser-panel path (workspace-relative). Drives
   *  `BrowserPanel`'s controlled `currentPath`. Mirrors how the
   *  slice-12 file preview owns its open-file state. */
  browserPath: string | null;
  /** The browser panel's internal navigation handler — address-bar
   *  Go, back / forward, and any future in-app navigator. Sets the
   *  `browserPath` but does NOT open the panel (the panel already
   *  owns the path being navigated). The two callbacks intentionally
   *  diverge so the file-tree's "click an HTML row" case can use a
   *  single setter that does both, while the in-panel case stays
   *  one-way. */
  onBrowserNavigate: (path: string | null) => void;
  /** The file-tree "click an HTML row" handler — sets the path AND
   *  opens the browser panel so the user actually sees the preview
   *  they triggered. Only the file tree calls this; the panel
   *  itself never re-enters via this funnel. */
  onOpenInBrowser: (path: string) => void;
  /** The file-tree "click any other file" handler — slice 14 widens
   *  the click surface so every row (not just HTML) opens the right
   *  panel. Same plumbing as `onOpenInBrowser` minus the panel-
   *  specific destination: this one always opens the `files` panel
   *  so the preview pane (with its open-with / show-in buttons for
   *  unsupported types) actually appears. */
  onOpenFile: (path: string) => void;
}) {
  return (
    <aside
      className="h-full min-h-0 w-[288px] shrink-0 overflow-hidden"
      data-testid={`right-panel-${kind}`}
      // Same hairline as the sidebar's right edge (0.6px of --border_light), so the
      // drawer is separated from the transcript column exactly like upstream's
      // extension area is. The inset shadow below stays as the softer inner edge.
      // Width 288px matches upstream's `i.w4` Drawer `width:288` (see SPEC §H,
      // `workspace_panel.body`). Upstream's Drawer body is the panel content
      // with `pr-3`, no title row.
      style={{ borderLeft: "0.6px solid var(--border_light)" }}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden pr-4 shadow-[inset_8px_0px_12px_-8px_var(--opacity_black_1_8)]">
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {/*
            `alerts` and `progress` are rendered but no launcher can reach them:
            every `openPanel(...)` call in the app passes one of `workspace`,
            `files`, `search`, `plugins` or `browser`, and the bell opens the
            inbox flyout (components/inbox.tsx), not this panel. Neither kind
            has a counterpart in the desktop's right panel, whose tab
            registry is exactly `changes` / `terminal` / `browser` / `files`.
            See the ProgressPanel comment. Kept, not deleted, so a future
            launcher is a one-line change — but do not read them as ported
            surfaces.
          */}
          {kind === "workspace" ? <WorkspacePanel t={t} /> : null}
          {kind === "files" ? (
            <FilesPanel
              t={t}
              locale={locale}
              onOpenInBrowser={onOpenInBrowser}
              onOpenFile={onOpenFile}
            />
          ) : null}
          {kind === "git" ? <GitPanel t={t} /> : null}
          {kind === "browser" ? (
            <BrowserPanel
              t={t}
              locale={locale}
              workspaceDir={workspaceDir}
              currentPath={browserPath}
              onNavigate={onBrowserNavigate}
            />
          ) : null}
          {/* Slice 17 — `alerts` / `search` / `progress` were
              removed from the PanelKind union (no entry points
              in the four-column shell). The remaining kinds
              that have a legacy right-panel surface are wired
              here; the unused components (AlertsPanel /
              SearchPanel / ProgressPanel) are kept exported so
              a future slice can wire them to a transient
              surface without re-importing the module graph. */}
          {kind === "plugins" ? <PluginsPanel t={t} /> : null}
        </div>
      </div>
    </aside>
  );
}

/**
 * Settings.
 *
 * Upstream has no `/settings` route: settings is a two-column modal inside the main
 * surface. This reproduces the desktop (electron) variant — full viewport, a 260px
 * sidebar carrying a back affordance and a search box, and a content column capped at
 * 704px on the grouped-secondary background.
 *
 * The sidebar's category tree is upstream's, names included (`偏好/管理/编码/归档`
 * groups over `通用/外观/语音/快捷键/个性化/浏览器`, `用量与模型/连接/账户`,
 * `代码审查/工作树`, `已归档任务`). Only the categories this server can actually drive
 * are enabled; the rest are rendered disabled with the standing 暂不支持 marker rather
 * than hidden, so the surface still reads as the desktop's and nobody has to guess
 * whether a category is missing or unsupported.
 *
 * The body is the same `SettingsPanel` the drawer hosts, now told which section to
 * render — the settings contract itself did not move.
 */
type SettingsSection =
  | "general"
  | "appearance"
  | "connection"
  | "providers";

const SETTINGS_NAV: {
  group: MessageKey;
  items: { id: string; key: MessageKey; section?: SettingsSection }[];
}[] = [
  {
    group: "settings.group.preferences",
    items: [
      { id: "general", key: "settings.tab.general", section: "general" },
      { id: "appearance", key: "settings.appearance", section: "appearance" },
      { id: "voice", key: "settings.tab.voice" },
      { id: "shortcuts", key: "settings.tab.shortcuts" },
      { id: "personalization", key: "settings.tab.personalization" },
      { id: "browser", key: "settings.tab.browser" },
    ],
  },
  {
    group: "settings.group.management",
    items: [
      { id: "connection", key: "settings.tab.connection", section: "connection" },
      // Provider management (ticket 03) — model providers surface lives
      // in the management group, below connection, and is the only
      // server-driven section the desktop "用量与模型" group also covers.
      { id: "providers", key: "providers.title", section: "providers" },
      { id: "account", key: "settings.tab.account" },
    ],
  },
  {
    group: "settings.group.coding",
    items: [
      { id: "code-review", key: "settings.tab.codeReview" },
      { id: "worktree", key: "settings.tab.worktree" },
    ],
  },
  {
    group: "settings.group.archived",
    items: [{ id: "archived", key: "settings.tab.archived" }],
  },
];

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
  /** Section the modal should land on when it next opens. The page
   *  sets this when the model selector's "Add provider" row is
   *  clicked; the modal reads it as its initial state on each open
   *  transition (a normal settings open from the sidebar passes
   *  "general" and reuses the default). */
  initialSection?: "general" | "appearance" | "connection" | "providers";
  /** One-shot flag consumed by `ProviderManagementPanel`. When true,
   *  the panel fires its add-provider flow on mount and calls
   *  `onAutoAddConsumed`. The page sets this so a deep-link from the
   *  model selector can land the user mid-add. */
  autoAddProvider?: boolean;
  onAutoAddConsumed?: () => void;
}) {
  const [active, setActive] = useState<string>(initialSection ?? "general");
  const [query, setQuery] = useState("");

  // Re-seed `active` whenever the modal opens from a different
  // section. The seed is only applied on the open transition — using
  // `open` as the dep means the user's in-modal navigation (clicking
  // a sidebar tab) is preserved for the lifetime of the open modal,
  // while a deep-link from outside the modal still wins.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    if (initialSection) setActive(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const needle = query.trim().toLowerCase();
  const groups = SETTINGS_NAV.map((group) => ({
    ...group,
    items: needle
      ? group.items.filter((item) => t(item.key).toLowerCase().includes(needle))
      : group.items,
  })).filter((group) => group.items.length > 0);

  const current = SETTINGS_NAV.flatMap((group) => group.items).find((item) => item.id === active);
  const section = current?.section;

  return (
    <div className="fixed inset-0 z-[1000] flex">
      {/* Upstream dims with the blanket token rather than a hardcoded black. */}
      <div className="absolute inset-0 bg-utility_blanket" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("panel.settings")}
        data-testid="settings-modal"
        className="two-column-modal relative flex h-full w-full overflow-hidden bg-bg_grouped_secondary"
      >
        {/* Back affordance + search + the grouped category tree. */}
        <div className="flex w-[260px] flex-shrink-0 flex-col gap-2 overflow-y-auto bg-bg_default_scrim px-3 pt-3 pb-5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t("settings.back")}
              onClick={onClose}
              className="flex size-7 flex-none items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
            >
              <Icon name="reply" size={16} className="rotate-180" />
            </button>
            <AntInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("settings.searchPlaceholder")}
              aria-label={t("settings.searchPlaceholder")}
              data-testid="settings-search-input"
              // .mavis-input is the desktop skin (36px / 8px radius / token-based
              // bg/border). The previous hand-rolled <input> was 32px / 8px — the
              // extra 4px come from the official desktop class. Acceptable: this is
              // a settings-modal search field, not a 1:1 match to a desktop widget.
              className="mavis-input min-w-0 flex-1"
            />
          </div>

          {groups.length === 0 ? (
            <p className="px-3 py-2 text-sm text-text_default_tertiary">
              {t("settings.searchNoResults")}
            </p>
          ) : null}

          {groups.map((group) => (
            <div key={group.group} className="flex flex-col gap-0.5">
              <span className="desktop-text-ui-assist px-3 py-1 text-text_default_tertiary">
                {t(group.group)}
              </span>
              {group.items.map((item) => {
                const disabled = !item.section;
                const selected = item.id === active;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={disabled}
                    title={disabled ? t("common.unsupported") : undefined}
                    aria-current={selected ? "page" : undefined}
                    data-testid={`settings-tab-${item.id}`}
                    onClick={() => setActive(item.id)}
                    // Upstream's `.menu-item`: gap 12px, padding 8px 12px, radius 8px,
                    // hover/selected on the tertiary interaction tokens, and an
                    // inset focus ring on keyboard focus.
                    className={[
                      "flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-left text-sm transition-colors focus:outline-none",
                      disabled
                        ? "cursor-not-allowed text-text_default_tertiary opacity-50 focus-visible:shadow-[inset_0_0_0_1px_var(--border_accent)]"
                        : selected
                          ? "bg-bg_interaction_tertiary_selected text-text_default_primary focus-visible:shadow-[inset_0_0_0_1px_var(--border_accent)]"
                          : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover focus-visible:shadow-[inset_0_0_0_1px_var(--border_accent)]",
                    ].join(" ")}
                  >
                    <span className="min-w-0 flex-1 truncate">{t(item.key)}</span>
                    {disabled ? (
                      <span className="flex-none text-caption-small-strong text-text_default_tertiary">
                        {t("common.unsupported")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Content on the grouped-secondary background, capped at upstream's 704px. */}
        <div
          role="separator"
          aria-orientation="vertical"
          className="w-0 border-l-[0.5px] border-border_light"
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full min-w-[320px] max-w-[704px] px-6 py-6">
            <SettingsPanel
            t={t}
            locale={locale}
            setLocale={setLocale}
            section={section}
            autoAddProvider={autoAddProvider}
            onAutoAddConsumed={onAutoAddConsumed}
          />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Progress panel — **currently unreachable**.
 *
 * An earlier revision of this comment claimed upstream renders this as "the
 * `进度` tab on the right edge". It does not. The desktop's right panel is a
 * tabbed *file* panel and its tab registry is exactly four entries:
 * `changes`, `terminal`, `browser`, `files`, each gated on a capability
 * (extracted from the shipped bundle's `iJ` list). There is no progress tab
 * and no alerts tab there either.
 *
 * This view therefore has no counterpart to port, and nothing opens it: the
 * only panel kinds any launcher passes to `openPanel` are `search`,
 * `workspace`, `files` and `plugins`. The activity feed it approximates lives
 * on a different desktop surface (the turn inspector's `activity-group-*`
 * regions), which has no webui entry point.
 *
 * It is kept rather than deleted because the content is assembled from state
 * this app already has, so wiring a launcher is a small change — but it should
 * not be read as a ported surface. If it is ever reached, what it shows is
 * "recent alerts plus the active run", not an upstream progress timeline.
 */
function ProgressPanel({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  const [open, setOpen] = useState(true);
  // The alert ring buffer, newest first, from the shared alerts stream
  // (lib/alerts.ts).
  const { alerts } = useAlerts();

  const running = state?.running.active ?? false;
  const thinking = state?.context.thinkingStatus ?? "";

  return (
    <div className="flex flex-col gap-3">
      {/* Collapsible header. Upstream renders `进度 ⌄` plus the subtitle on
          the same line; clicking the header toggles whether the body shows. */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-2 py-1 text-left"
      >
        <span className="min-w-0 flex-1 text-sm font-medium text-text_default_primary">
          {t("panel.progress")}
        </span>
        <span
          className={[
            "flex size-4 items-center justify-center text-icon_default_secondary transition-transform duration-200",
            open ? "rotate-180" : "",
          ].join(" ")}
        >
          <Icon name="chevronDown" size={14} />
        </span>
      </button>
      <p className="-mt-2 px-2 text-caption-small-strong text-text_default_tertiary">
        {t("panel.progress.subtitle")}
      </p>

      {open ? (
        <div className="flex flex-col gap-3">
          <Field label={t("chat.thinking")}>
            <div className="flex items-center gap-2 text-text_default_primary">
              <span
                className={[
                  "size-2 rounded-full",
                  running ? "bg-bg_status_positive" : "bg-bg_status_neutral",
                ].join(" ")}
                aria-hidden
              />
              <span>{running ? thinking || t("chat.thinking") : "—"}</span>
            </div>
          </Field>

          <Field label={t("toolbar.alerts")}>
            {alerts.length === 0 ? (
              <span className="text-caption-small-strong text-text_default_tertiary">
                {t("panel.progress.empty")}
              </span>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {alerts.slice(0, 12).map((alert) => (
                  <li
                    key={alert.id}
                    className="flex items-start gap-2 rounded-lg bg-bg_grouped_tertiary px-2 py-1.5 text-caption-small-strong text-text_default_secondary"
                  >
                    <span
                      className={[
                        "mt-1 size-1.5 flex-shrink-0 rounded-full",
                        alert.level === "error"
                          ? "bg-bg_status_error"
                          : alert.level === "warn"
                            ? "bg-bg_status_warning"
                            : "bg-bg_status_positive",
                      ].join(" ")}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 break-words">{alert.msg}</span>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Plugin marketplace.
 *
 * Stub — the real implementation lives behind the engine's plugin install
 * contract, which this server does not expose yet. The desktop client renders
 * a category-tabs + grid-of-cards layout (市场 / 个人 tabs, 安装 buttons).
 * Until that contract lands, show the affordance plus a "正在做" notice so the
 * click target is real and the user knows we know it's missing. See shell.tsx
 * sidebar.nav for the desktop order.
 */
function PluginsPanel({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="desktop-text-dialog-medium text-base font-medium leading-6 text-text_default_primary">
        {t("panel.plugins.title")}
      </div>
      <div className="flex items-start gap-2 rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 py-3">
        <span className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-bg_interaction_tertiary_hover text-icon_default_secondary">
          <Icon name="plugins" size={14} />
        </span>
        <div className="desktop-text-ui-body min-w-0 flex-1 text-sm leading-5 text-text_default_secondary">
          {t("panel.plugins.placeholder")}
        </div>
      </div>
    </div>
  );
}

// --- workspace --------------------------------------------------------------

/**
 * Files panel — collapsible file tree (webui-parity 01).
 *
 * Upstream's `文件` tab in the right-hand extension area shows a single
 * folder at a time, with breadcrumb navigation. This panel keeps the
 * upstream's purpose (it is still a navigator, not a viewer — see
 * `api.ts#getFsDir`'s docs) but upgrades the surface to a lazy,
 * collapsible tree so a deep workspace can be eyeballed without
 * drilling.
 *
 * Contract:
 *
 *  * The tree is rooted at the current workspace directory. The
 *    workspace dir is owned by `state.workspace.dir`; when the user
 *    switches project, this panel re-roots to the new dir and the
 *    persisted expansion slice for the previous project is dropped
 *    (see sessionStorage keys below).
 *
 *  * Each directory's children are fetched lazily via
 *    `GET /api/fs/read?path=<node>` on first expand. No recursive
 *    prefetch — see ticket 01 ("不做递归预取"). When a node's
 *    response would have been cut by the per-node cap, the panel
 *    renders an explicit "还有 N 项未显示" footer.
 *
 *  * Per-node race safety: every node carries a generation counter
 *    in a ref; an older in-flight response for that exact node must
 *    not overwrite a newer one. The counter is per-node (not
 *    per-panel), so two concurrent expands of two different nodes
 *    don't fight.
 *
 *  * Filter (glob) + showHidden + the (per-workspace) `expanded`
 *    set are persisted in `sessionStorage` under
 *    `webui:files-tree:<workspaceDir>` so a page refresh restores
 *    them. Channel chosen per ticket 01: sessionStorage satisfies
 *    "across refresh" (the slice's own acceptance criterion);
 *    ticket 07 owns the cross-restart durability channel and will
 *    promote this slice's wire format when its policy lands.
 *
 *  * Out-of-bounds directories are gated server-side by
 *    `assertWorkspacePath`; the panel surfaces the failure as an
 *    inline hint on the affected row, not as a modal / toast.
 */
export function FilesPanel({
  t,
  locale,
  onOpenInBrowser,
  onOpenFile,
}: {
  t: (key: MessageKey) => string;
  locale: Locale;
  /** Called when the user clicks an `.html` / `.htm` row. Page.tsx
   *  uses this to route the same file into the browser panel AND
   *  open that panel (rather than into the text/image preview
   *  pane). Non-HTML rows call `onOpenFile` so the preview pane
   *  keeps its existing single-source contract AND the user actually
   *  sees the right-hand panel — slice 14 widens the click surface
   *  so every row opens the panel, not just the HTML ones. */
  onOpenInBrowser: (path: string) => void;
  /** Called when the user clicks any non-HTML row. Page.tsx wires
   *  this to `openFileInWeb(path)` plus a panel-open side effect so
   *  the click triggers the preview AND opens the right panel — the
   *  previous "click for a non-HTML row did nothing if the panel was
   *  closed" failure mode is exactly what slice 14 fixes. The
   *  side-effect call lives in page.tsx, not here — keeping the
   *  panels surface passive is the tripwire `open-file.test.ts`
   *  pins. */
  onOpenFile: (path: string) => void;
}) {
  const { state } = useSessionContext();
  const workspaceDir = state?.workspace.dir ?? "";

  // Hydrate persisted slice once per workspace change. We keep the
  // three slices (expanded set, filter string, hidden flag) in one
  // payload so the wire format is shared with ticket 07's future
  // cross-restart migration.
  const [hydratedWorkspace, setHydratedWorkspace] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    if (!workspaceDir) {
      setExpanded([]);
      setFilter("");
      setShowHidden(false);
      setHydratedWorkspace(null);
      return;
    }
    if (hydratedWorkspace === workspaceDir) return;
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem(persistKey(workspaceDir));
      const slice = deserializeExpansion(raw, workspaceDir);
      setExpanded(slice.expanded);
      setFilter(slice.filter);
      setShowHidden(slice.showHidden);
    } catch {
      // sessionStorage is best-effort — a quota / disabled-storage
      // environment must not break the panel. The default empty
      // slice is what we get on every load, and that is correct
      // behaviour for a user without persistence.
      setExpanded([]);
      setFilter("");
      setShowHidden(false);
    }
    setHydratedWorkspace(workspaceDir);
  }, [workspaceDir, hydratedWorkspace]);

  // Persist on every change. Debounced so a stream of keyboard edits
  // does not flood sessionStorage (one write per coalesced batch).
  useEffect(() => {
    if (hydratedWorkspace !== workspaceDir) return;
    if (typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      try {
        window.sessionStorage.setItem(
          persistKey(workspaceDir),
          serializeExpansion({ expanded, filter, showHidden }, workspaceDir),
        );
      } catch {
        // same best-effort contract as hydrate
      }
    }, 150);
    return () => window.clearTimeout(handle);
  }, [expanded, filter, showHidden, workspaceDir, hydratedWorkspace]);

  // Map from path → node state. Holds the cache so re-collapsing
  // and re-expanding the same node is instant and never re-fires
  // the request. Each value also carries `loading` and `gen` so a
  // user-driven refresh can race against a stale in-flight request.
  const [nodes, setNodes] = useState<Record<string, TreeNodeState>>({});
  const [rootError, setRootError] = useState<string | null>(null);

  // Slice 19b — bounded server search. Holds the most recent
  // server-side search result for the current workspace. The result
  //   - drives the "expand to the hit" effect (we union its ancestor
  //     paths into `expanded` so the match becomes visible),
  //   - is the source of the footer numbers (scanned / skipped /
  //     truncated / matches),
  //   - and is the source of the highlight set.
  //
  // The server search runs AFTER the in-tree filter reports zero
  // hits — a 200ms debounce keeps a fast typist from flooding the
  // network, and an AbortController drops a stale response if a
  // newer keystroke has already started a fresher one. The same
  // pattern is used by the SearchPanel (session search) and the
  // workspace picker recents tab — see how each use a generation
  // counter as a belt-and-braces guard on top of `AbortController`,
  // because a slow request can land AFTER its own abort and would
  // otherwise race past the cancellation.
  const [serverSearch, setServerSearch] = useState<{
    query: string;
    result: api.FsSearchResult | null;
    loading: boolean;
    error: string | null;
  }>({ query: "", result: null, loading: false, error: null });
  const serverSearchGen = useRef(0);
  const serverSearchAbort = useRef<AbortController | null>(null);

  // Paths the panel should highlight once the server result has
  // been "materialised" (i.e. the ancestors are loaded and the hit
  // is rendered). The set lives across re-renders and is cleared
  // by the auto-clear timer so a stale highlight does not stick
  // around when the user moves on.
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const highlightClearTimer = useRef<number | null>(null);

  // Filter auto-expansion: when the user types a filter, compute
  // the set of ancestors of every matching loaded entry and union
  // it with the user's explicit expansion set. Unloaded ancestors
  // are still added — they will lazy-fetch on next render. This is
  // NOT recursive prefetch: only the ancestor chains of MATCHES
  // that live in ALREADY-LOADED directories get fetched, never the
  // full subtree of every directory the user happens to see.
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const filterExpanded = useMemo(() => {
    if (!filter.trim()) return expandedSet;
    const loaded: Record<string, api.FsEntry[]> = {};
    for (const [path, node] of Object.entries(nodes)) {
      if (node.entries) loaded[path] = node.entries;
    }
    return filterAncestors(loaded, filter, workspaceDir, expandedSet);
  }, [filter, nodes, expandedSet, workspaceDir]);

  // Slice 19b — server-search trigger. Three things to keep straight
  // here:
  //
  //  1. **Loaded-first**: the in-tree filter already surfaces
  //     matches from `nodes` (via `filterAncestors`). The server
  //     request fires ONLY when the loaded set has zero hits — a
  //     typing user never pays the network round-trip for
  //     "package.json" if it's already expanded in the tree.
  //     Implemented as the `loadedHasMatch` memo above the effect.
  //
  //  2. **Debounce + cancel**: every keystroke bumps the generation
  //     counter, the cleanup function aborts the previous
  //     AbortController, and the response handler checks the
  //     captured generation so a stale response cannot overwrite
  //     the latest result. The debounce is 200ms — long enough to
  //     coalesce a fast typing burst, short enough that an idle
  //     user sees results in a single tick.
  //
  //  3. **Server result → expand-to-hit**: when a fresh result
  //     arrives, we union its ancestor paths into the `expanded`
  //     set and kick off `fetchNode` for each. The lazy tree then
  //     loads those nodes on the next render so the match becomes
  //     visible without the user clicking every parent. Matches
  //     not yet visible after the chain is loaded (rare — the
  //     match's parent is normally an ancestor) are appended to
  //     the visible rows via `serverMatchRows`.
  const loadedHasMatch = useMemo(() => {
    const trimmed = filter.trim();
    if (!trimmed) return true; // no filter → no "missing" to look for
    for (const [, node] of Object.entries(nodes)) {
      if (!node.entries) continue;
      for (const entry of node.entries) {
        if (entry.type === "dir") continue;
        if (matchFilter(entry.name, trimmed)) return true;
      }
    }
    return false;
  }, [filter, nodes]);

  useEffect(() => {
    const trimmed = filter.trim();
    // Empty filter → no server search, no stale result.
    if (!trimmed) {
      serverSearchAbort.current?.abort();
      serverSearchAbort.current = null;
      if (serverSearchGen.current !== -1) {
        serverSearchGen.current = -1;
        setServerSearch({ query: "", result: null, loading: false, error: null });
      }
      setHighlightedPaths(new Set());
      if (highlightClearTimer.current !== null) {
        window.clearTimeout(highlightClearTimer.current);
        highlightClearTimer.current = null;
      }
      return;
    }
    // Loaded-first: if the user already has hits in the expanded
    // tree AND we have NOT already returned a server result for
    // this query, skip the server. The "AND we have not already
    // returned" guard is what keeps the footer visible after
    // expand-to-hit: the auto-expanded dir's children get fetched
    // and the loaded set now contains matches, but the user still
    // needs to see the server footer's scanned / skipped numbers.
    // Cancels any in-flight request so a stale response cannot
    // overwrite later state.
    if (loadedHasMatch) {
      setServerSearch((current) =>
        current.result && current.query === trimmed
          ? current
          : { query: trimmed, result: null, loading: false, error: null },
      );
      serverSearchAbort.current?.abort();
      serverSearchAbort.current = null;
      serverSearchGen.current = -1;
      return;
    }
    if (!workspaceDir) return;

    // Debounce 200ms. The session-search panel uses 180ms; this is
    // slightly longer because each request is potentially more
    // expensive than a title substring match, and a fast typist
    // who pauses will fire one request, not seven.
    const handle = window.setTimeout(() => {
      const gen = ++serverSearchGen.current;
      const controller = new AbortController();
      serverSearchAbort.current?.abort();
      serverSearchAbort.current = controller;
      setServerSearch((prev) => ({ ...prev, query: trimmed, loading: true, error: null }));
      void api
        .searchFs(workspaceDir, trimmed, {
          signal: controller.signal,
          includeHidden: showHidden,
        })
        .then((result) => {
          // Generation guard — even with AbortController, a response
          // can land after the abort if the server already started
          // writing it. Drop the stale result.
          if (gen !== serverSearchGen.current) return;
          setServerSearch({
            query: trimmed,
            result,
            loading: false,
            error: null,
          });
          // Expand-to-hit: union every ancestor chain into the
          // expanded set, kick off lazy fetches for each path. The
          // tree walker will surface the match on the next render.
          const toExpand = pathsToExpand(result.matches, workspaceDir);
          if (toExpand.length > 0) {
            setExpanded((current) => Array.from(new Set([...current, ...toExpand])));
            for (const path of toExpand) {
              void fetchNode(path);
            }
          }
          // Highlight every match for a few seconds so the user's
          // eye lands on the right row(s). The auto-clear timer is
          // reset per result so the highlight does not vanish mid-
          // typing.
          if (result.matches.length > 0) {
            const next = new Set(result.matches.map((m) => m.path));
            setHighlightedPaths(next);
            if (highlightClearTimer.current !== null) {
              window.clearTimeout(highlightClearTimer.current);
            }
            highlightClearTimer.current = window.setTimeout(() => {
              setHighlightedPaths(new Set());
              highlightClearTimer.current = null;
            }, 4000);
          } else {
            setHighlightedPaths(new Set());
          }
        })
        .catch((cause) => {
          if (gen !== serverSearchGen.current) return;
          // An aborted request throws `AbortError` — silently
          // ignore it; a newer generation will produce the real
          // answer. Anything else is a real failure and gets
          // surfaced inline.
          const name = cause instanceof Error ? cause.name : "";
          if (name === "AbortError") return;
          setServerSearch({
            query: trimmed,
            result: null,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    }, 200);

    return () => {
      window.clearTimeout(handle);
    };
    // We deliberately exclude `fetchNode` from deps — it captures
    // `nodes` at hook definition time, and the expand-to-hit call
    // only matters on result arrival, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, loadedHasMatch, workspaceDir, showHidden]);

  // Workspace switch clears the search state — the previous
  // workspace's results are not meaningful on the new tree.
  useEffect(() => {
    serverSearchAbort.current?.abort();
    serverSearchAbort.current = null;
    serverSearchGen.current = -1;
    setServerSearch({ query: "", result: null, loading: false, error: null });
    setHighlightedPaths(new Set());
    if (highlightClearTimer.current !== null) {
      window.clearTimeout(highlightClearTimer.current);
      highlightClearTimer.current = null;
    }
  }, [workspaceDir]);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      serverSearchAbort.current?.abort();
      if (highlightClearTimer.current !== null) {
        window.clearTimeout(highlightClearTimer.current);
      }
    };
  }, []);

  // Per-node fetch with race-safety. `gen` is the local counter; the
  // result handler drops anything whose gen does not match the latest
  // value for that exact path.
  const fetchNode = useCallback(
    async (path: string, opts: { force?: boolean } = {}) => {
      // Optimistic state: mark loading, increment gen, capture local
      // gen so the result handler can verify it.
      let capturedGen = 0;
      setNodes((current) => {
        const previous = current[path];
        const next = previous ? { ...previous } : { entries: undefined, error: null, loading: true, gen: 0, total: 0, skipped: 0 };
        const incomingGen = (previous?.gen ?? 0) + 1;
        next.gen = incomingGen;
        next.loading = true;
        capturedGen = incomingGen;
        return { ...current, [path]: next };
      });
      // Skip the round-trip when we already have a fresh listing and
      // the caller is not forcing a refresh. The `force` path is the
      // hover-action refresh button — even an up-to-date cache must
      // be re-fetched because the user explicitly asked.
      const fresh = !opts.force && nodes[path]?.entries && !nodes[path]?.error;
      if (fresh && !opts.force) {
        setNodes((current) => {
          if (!current[path]) return current;
          if (current[path].gen !== capturedGen) return current;
          return { ...current, [path]: { ...current[path], loading: false } };
        });
        return;
      }
      try {
        const result = await api.getFsDir(path, showHidden);
        setNodes((current) => {
          if (!current[path]) return current;
          if (current[path].gen !== capturedGen) return current;
          if (result.ok && result.entries) {
            return {
              ...current,
              [path]: {
                entries: result.entries,
                error: null,
                loading: false,
                gen: capturedGen,
                total: result.entries.length,
                skipped: result.skipped ?? 0,
              },
            };
          }
          return {
            ...current,
            [path]: {
              entries: current[path].entries ?? [],
              error: result.error ?? t("files.tree.outOfBounds"),
              loading: false,
              gen: capturedGen,
              total: 0,
              skipped: 0,
            },
          };
        });
      } catch (cause) {
        setNodes((current) => {
          if (!current[path]) return current;
          if (current[path].gen !== capturedGen) return current;
          return {
            ...current,
            [path]: {
              entries: current[path].entries ?? [],
              error: cause instanceof Error ? cause.message : String(cause),
              loading: false,
              gen: capturedGen,
              total: 0,
              skipped: 0,
            },
          };
        });
      }
    },
    [nodes, showHidden, t],
  );

  // When the workspace dir changes (user switches project) drop every
  // cached node — the previous tree does not belong to the new
  // workspace. Without this, the persisted `expanded` slice is the
  // only thing that resets and the cache would carry stale paths.
  useEffect(() => {
    setNodes({});
    setRootError(null);
    if (workspaceDir) void fetchNode(workspaceDir, { force: true });
    // we deliberately exclude fetchNode from deps: it captures nodes at
    // mount time and a workspace change should not retroactively rerun
    // against the previous workspace's data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceDir]);

  // After the persisted `expanded` slice is hydrated for a workspace,
  // re-issue fetches for every path in the slice. Without this, a
  // page refresh would mark dirs as expanded but show no children
  // because no node has been loaded yet — the user would have to
  // click every parent to re-discover what was open. This is still
  // lazy in the ticket's sense: only the user-explicit chain is
  // fetched, never the full tree.
  const rehydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceDir) return;
    if (hydratedWorkspace !== workspaceDir) return;
    if (rehydratedRef.current === workspaceDir) return;
    rehydratedRef.current = workspaceDir;
    for (const path of expanded) {
      if (path === workspaceDir) continue;
      void fetchNode(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydratedWorkspace, workspaceDir, expanded]);

  // Always reflect showHidden in the root listing — every refetch uses
  // the latest value via the fetchNode closure dependency.
  useEffect(() => {
    if (!workspaceDir) return;
    void fetchNode(workspaceDir, { force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // Expand / collapse handlers. Both are no-ops if the path is
  // already in the requested state — a redundant setState would
  // still trigger a re-render, so we guard.
  const expandPath = useCallback((path: string) => {
    setExpanded((current) => (current.includes(path) ? current : [...current, path]));
    void fetchNode(path);
  }, [fetchNode]);

  const collapsePath = useCallback((path: string) => {
    setExpanded((current) => current.filter((p) => p !== path));
  }, []);

  const togglePath = useCallback((path: string) => {
    setExpanded((current) =>
      current.includes(path) ? current.filter((p) => p !== path) : [...current, path],
    );
    // Only kick a fetch on the expand branch; collapsing is local.
    if (!nodes[path]?.entries) {
      void fetchNode(path);
    }
  }, [fetchNode, nodes]);

  const refreshPath = useCallback((path: string) => {
    void fetchNode(path, { force: true });
  }, [fetchNode]);

  // New folder: prompt for name, mkdir, then refresh the parent.
  // Mirrors the legacy browse tab's mkdir pattern.
  const mkdirInPath = useCallback(
    async (parent: string) => {
      const name = window.prompt(t("files.tree.newFolderPrompt"), "");
      if (!name) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      const target = `${parent.replace(/\/+$/, "")}/${trimmed}`;
      try {
        const result = await api.mkdir(target);
        if (!result.ok) {
          setRootError(result.path ? "mkdir failed" : "mkdir failed");
          return;
        }
        await fetchNode(parent, { force: true });
      } catch (cause) {
        setRootError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [fetchNode, t],
  );

  // Copy absolute path of a file row to the clipboard. The ticket
  // pins "复制绝对路径" as the file-row hover affordance; preview is
  // ticket 02. Transient confirmation is row-scoped (a state key
  // per path) so two rows near each other can confirm independently.
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyPath = useCallback(
    async (path: string) => {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(path);
        } else {
          // Fallback for browsers / contexts without async clipboard
          // (the WebUI serves itself on a non-secure origin in dev).
          const textarea = document.createElement("textarea");
          textarea.value = path;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "absolute";
          textarea.style.left = "-9999px";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
        }
        setCopiedPath(path);
        window.setTimeout(() => {
          setCopiedPath((current) => (current === path ? null : current));
        }, 1500);
      } catch (cause) {
        setRootError(t("files.tree.copyFailed"));
      }
    },
    [t],
  );

  // The visible rows: walk the tree top-down from the workspace
  // root, only descending into expanded directories. Each emitted
  // row carries everything the renderer needs to draw + the depth
  // it lives at (used for the indentation chevron gutter).
  //
  // The workspace root is always expanded — there is no point in
  // rendering a tree whose top level is collapsed (the user came
  // here to see files). Non-root dirs honour the `expanded` set.
  //
  // A child directory whose listing has not been fetched yet still
  // gets a row — the chevron says "click to load" — but the row
  // is flagged `placeholder: true` so the renderer does NOT show a
  // "加载中…" suffix. The suffix is reserved for an in-flight
  // fetch on a node that already has cache state. Without the
  // distinction, a tree of 30 collapsed dirs would render 30
  // copies of "加载中…" that look like 30 active requests — the
  // exact failure mode the target desktop UI avoids.
  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    if (!workspaceDir) return out;
    const rootNode = nodes[workspaceDir];
    if (!rootNode) return out;
    const visit = (path: string, depth: number) => {
      const node = nodes[path];
      const isRoot = path === workspaceDir;
      const isExpanded = isRoot || filterExpanded.has(path);
      if (!node) {
        // Never-fetched dir: render a row so the user can see what
        // will expand when they click, but mark it `placeholder` so
        // the renderer suppresses the loading suffix.
        out.push({
          path,
          depth,
          kind: "dir",
          expanded: isExpanded,
          loading: false,
          placeholder: true,
          error: null,
          skipped: 0,
        });
        return;
      }
      out.push({
        path,
        depth,
        kind: "dir",
        expanded: isExpanded,
        loading: node.loading,
        placeholder: false,
        error: node.error,
        skipped: node.skipped,
      });
      if (!isExpanded) return;
      const entries = sortEntries(node.entries ?? []);
      for (const entry of entries) {
        if (entry.type === "dir") {
          visit(entry.path, depth + 1);
        } else {
          out.push({ path: entry.path, depth: depth + 1, kind: "file", entry });
        }
      }
    };
    visit(workspaceDir, 0);
    return out;
  }, [nodes, filterExpanded, workspaceDir]);

  // Apply the per-row filter so the panel hides non-matching files.
  // Directories are kept (otherwise a hit nested deeper is invisible
  // even after auto-expansion). The per-row filter applies to FILE
  // rows only — the ancestor-of-match logic already filters out
  // non-matching directories at the lookup level.
  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows;
    return rows.filter((row) => {
      if (row.kind === "dir") return true;
      return matchFilter(row.entry!.name, filter);
    });
  }, [rows, filter]);

  // Slice 19b — server matches that did not appear in `rows`
  // because their parent directories are not loaded yet (the
  // ancestors are still being lazy-fetched). The expand-to-hit
  // effect kicks off those fetches in parallel; while they are
  // in flight we still want the user to see the matches and
  // click them, so we render them as a "server match" row at
  // the bottom of the listing. Each row is built from a
  // synthesised `FsEntry` so the existing `FileRow` renderer
  // can render it without branching.
  const serverMatchRows = useMemo<TreeFileRow[]>(() => {
    if (!filter.trim()) return [];
    const trimmed = filter.trim();
    if (!serverSearch.result) return [];
    const result = serverSearch.result;
    if (result.q !== trimmed) return [];
    // Dedupe against rows already shown so a match that has been
    // resolved through the expand-to-hit path does not render
    // twice.
    const visiblePaths = new Set(rows.map((r) => r.path));
    const out: TreeFileRow[] = [];
    for (const match of result.matches) {
      if (match.type !== "file") continue;
      if (visiblePaths.has(match.path)) continue;
      // Synthesised entry — the server only returns path / name /
      // type / ancestors, so size / mtime / mode / icon are absent
      // from the wire. Render them as zeros; FileRow already
      // tolerates that (size 0 → blank label, mtime 0 → blank
      // label).
      const entry: api.FsEntry = {
        name: match.name,
        path: match.path,
        type: "file",
        size: 0,
        mtime: 0,
        mode: "",
        icon: "",
      };
      out.push({
        path: match.path,
        depth: (match.ancestors?.length ?? 0) + 1,
        kind: "file",
        entry,
      });
    }
    return out;
  }, [filter, serverSearch, rows]);

  // mtime is rendered as "just now / Nm / Nh / …" — recompute once
  // per render so a panel left open for hours does not show stale
  // relative times. Cheap; cheaper than the fetch itself.
  const now = Date.now();

  return (
    <div className="flex flex-col gap-2" data-testid="files-tree-root">
      {/* Toolbar: the workspace root path + filter + showHidden + refresh. */}
      <div className="flex items-center gap-1">
        <span
          data-testid="files-tree-workspace"
          title={workspaceDir}
          className="min-w-0 flex-1 truncate text-caption-small-strong text-text_default_tertiary"
        >
          {workspaceDir || t("workspace.picker.noWorkspace")}
        </span>
        <button
          type="button"
          onClick={() => workspaceDir && refreshPath(workspaceDir)}
          aria-label={t("files.tree.refreshAria")}
          title={t("files.tree.refresh")}
          data-testid="files-tree-refresh"
          className="flex size-7 flex-shrink-0 items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1">
        <AntInput
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("files.filterPlaceholder")}
          aria-label={t("files.filterPlaceholder")}
          data-testid="files-tree-filter"
          className="mavis-input min-w-0 flex-1"
        />
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter("")}
            aria-label={t("files.clearFilter")}
            title={t("files.clearFilter")}
            data-testid="files-tree-filter-clear"
            className="flex size-7 flex-shrink-0 items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
          >
            <Icon name="close" size={14} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          aria-label={showHidden ? t("files.tree.shown") : t("files.tree.hidden")}
          title={showHidden ? t("files.tree.shown") : t("files.tree.hidden")}
          aria-pressed={showHidden}
          data-testid="files-tree-hidden-toggle"
          data-checked={showHidden ? "true" : "false"}
          className={[
            "flex size-7 flex-shrink-0 items-center justify-center rounded-[8px] transition-colors",
            showHidden
              ? "bg-bg_interaction_tertiary_selected text-text_default_primary"
              : "text-icon_default_tertiary hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary",
          ].join(" ")}
        >
          {/* small inline glyph: an "eye" outline so the toggle is
              readable without adding a new icon registry entry */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="8" cy="8" r="1.6" fill="currentColor" />
          </svg>
        </button>
      </div>

      {rootError ? (
        <p className="text-caption-small-strong text-text_status_error">{rootError}</p>
      ) : null}

      <div className="flex flex-col">
        {filteredRows.map((row) => {
          if (row.kind === "dir") {
            const isRoot = row.path === workspaceDir;
            return (
              <DirRow
                key={`dir:${row.path}`}
                row={row}
                isRoot={isRoot}
                t={t}
                onToggle={() => togglePath(row.path)}
                onRefresh={() => refreshPath(row.path)}
                onMkdir={() => mkdirInPath(row.path)}
              />
            );
          }
          const isCopied = copiedPath === row.path;
          // Routing: HTML/HTM files go to the browser panel (via the
          // page-level callback so the panel auto-opens). Everything
          // else goes through the page-level `onOpenFile` callback,
          // which publishes the path AND opens the right panel —
          // slice 14 widens the click surface so every row opens the
          // panel, never "click and nothing happened" for an
          // unsupported type. `isHtmlPath` lives in
          // `lib/browser-nav.ts` to keep the extension allow-list in
          // one place (the iframe src type-check does the same).
          const isHtml = isHtmlPath(row.entry.name);
          const isHighlighted = highlightedPaths.has(row.path);
          return (
            <FileRow
              key={`file:${row.path}`}
              row={row}
              t={t}
              now={now}
              copied={isCopied}
              highlighted={isHighlighted}
              onOpen={() =>
                isHtml ? onOpenInBrowser(row.path) : onOpenFile(row.path)
              }
              onCopy={() => copyPath(row.path)}
            />
          );
        })}

        {/* Slice 19b — server-search matches that are not yet
            reachable through the lazy tree. Each row renders as a
            file row with a depth derived from the match's ancestor
            chain. `data-source="server"` distinguishes them from
            the loaded-tree rows in the test harness. */}
        {serverMatchRows.map((row) => {
          const isCopied = copiedPath === row.path;
          const isHtml = isHtmlPath(row.entry.name);
          const isHighlighted = highlightedPaths.has(row.path);
          const credential =
            serverSearch.result?.matches.find((m) => m.path === row.path)?.credential ?? false;
          return (
            <FileRow
              key={`server:${row.path}`}
              row={row}
              t={t}
              now={now}
              copied={isCopied}
              highlighted={isHighlighted}
              credential={credential}
              source="server"
              onOpen={() =>
                isHtml ? onOpenInBrowser(row.path) : onOpenFile(row.path)
              }
              onCopy={() => copyPath(row.path)}
            />
          );
        })}

        {/* Below-the-fold states. */}
        {rows.length === 0 && nodes[workspaceDir]?.loading ? (
          <p
            data-testid="files-tree-loading"
            className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
          >
            {t("files.tree.loading")}
          </p>
        ) : null}
        {rows.length === 0 && !nodes[workspaceDir]?.loading && !rootError ? (
          <p
            data-testid="files-tree-empty"
            className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
          >
            {t("files.tree.empty")}
          </p>
        ) : null}
        {/* Filter narrows everything out — every loaded row failed the
            glob. Show a dedicated hint so the user knows the tree
            itself is fine. */}
        {rows.length > 0 && filteredRows.length === 0 && serverMatchRows.length === 0 ? (
          <p
            data-testid="files-tree-no-match"
            className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
          >
            {t("files.noMatch")}
          </p>
        ) : null}
      </div>

      {/* Slice 19b — server-search status row. The footer only
          renders once a server request has actually fired (so the
          panel does not look different from the pre-19b version
          when the user has not typed anything that needed a
          server search). The `loading` row is the spinner; the
          `error` row surfaces the failure message; the
          `result` row carries the footer segments (scanned,
          skipped, truncated, …). */}
      {serverSearch.loading ? (
        <p
          data-testid="files-tree-server-searching"
          className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
        >
          {t("files.search.loading")}
        </p>
      ) : null}
      {serverSearch.error ? (
        <p
          data-testid="files-tree-server-error"
          className="px-1.5 py-1 text-caption-small-strong text-text_status_error"
        >
          {t("files.search.error").replace("{{error}}", serverSearch.error)}
        </p>
      ) : null}
      {serverSearch.result && !serverSearch.loading && !serverSearch.error ? (
        <SearchFooter
          result={serverSearch.result}
          t={t}
        />
      ) : null}

      {/* Preview pane — subscribes to `open.file.in.web` so the tree
          entry point (`FileRow` below) and the turn-summary entry
          point (`components/chat.tsx#ToolCard`) land on the same
          surface. Lives inside FilesPanel because the target desktop
          UI keeps the tree + preview in the same right column (see
          `refs/ui/02-workspace-shell.jpg`). */}
      <FilePreviewPane t={t} locale={locale} />
    </div>
  );
}

interface TreeNodeState {
  entries: api.FsEntry[] | undefined;
  error: string | null;
  loading: boolean;
  /** Per-node generation counter — race safety on a per-path basis. */
  gen: number;
  total: number;
  /** Number of entries the server cut due to FILES_VISIBLE_LIMIT. */
  skipped: number;
}

interface TreeRowBase {
  path: string;
  depth: number;
}

interface TreeDirRow extends TreeRowBase {
  kind: "dir";
  expanded: boolean;
  loading: boolean;
  /**
   * `true` when the row exists in the tree because its parent
   * listing told us there was a directory here, but we have NOT
   * fetched its contents yet. Placeholder rows render the chevron
   * and folder name but NO loading suffix — the suffix is reserved
   * for an actual in-flight request. See `shouldShowDirLoadingSuffix`
   * in `lib/files-tree.ts` for the predicate this drives.
   */
  placeholder: boolean;
  error: string | null;
  /** Pre-truncation count of entries the server cut off. */
  skipped: number;
}

interface TreeFileRow extends TreeRowBase {
  kind: "file";
  entry: api.FsEntry;
}

type TreeRow = TreeDirRow | TreeFileRow;

function persistKey(workspaceDir: string): string {
  return `webui:files-tree:${workspaceDir}`;
}

/**
 * Directory row — chevron + name + hover actions.
 *
 * Hovering reveals the per-directory actions (`新建子目录` / `刷新`).
 * Keyboard support: Enter / ArrowRight expand, ArrowLeft collapse.
 * These are the keyboard ops the ticket pins; full arrow navigation
 * across rows is out of scope for this slice.
 */
function DirRow({
  row,
  isRoot,
  t,
  onToggle,
  onRefresh,
  onMkdir,
}: {
  row: TreeDirRow;
  isRoot: boolean;
  t: (key: MessageKey) => string;
  onToggle: () => void;
  onRefresh: () => void;
  onMkdir: () => void;
}) {
  const indent = row.depth * 12;
  return (
    <div
      className="group/dir flex h-[26px] items-center gap-1 rounded-lg px-1 transition-colors hover:bg-bg_interaction_tertiary_hover"
      style={{ paddingLeft: 4 + indent }}
      data-testid="files-tree-dir-row"
      data-path={row.path}
      data-depth={row.depth}
      data-expanded={row.expanded ? "true" : "false"}
      data-error={row.error ? "true" : "false"}
    >
      <button
        type="button"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            if (!row.expanded) onToggle();
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (row.expanded) onToggle();
          }
        }}
        aria-label={row.expanded ? t("files.tree.collapse") : t("files.tree.expand")}
        aria-expanded={row.expanded}
        data-testid="files-tree-dir-toggle"
        className="flex size-4 flex-shrink-0 items-center justify-center rounded text-icon_default_tertiary transition-transform"
      >
        <Icon
          name="chevronRight"
          size={11}
          className={["transition-transform", row.expanded ? "rotate-90" : ""].join(" ")}
        />
      </button>
      <button
        type="button"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !row.expanded) {
            event.preventDefault();
            onToggle();
          } else if (event.key === "ArrowLeft" && row.expanded) {
            event.preventDefault();
            onToggle();
          }
        }}
        title={row.path}
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-sm text-text_default_primary"
      >
        <span className="flex size-4 flex-shrink-0 items-center justify-center text-icon_default_secondary">
          <Icon name={isRoot ? "folder" : "folderEmpty"} size={14} />
        </span>
        <span className="min-w-0 truncate">
          {isRoot ? baseName(row.path) || row.path : baseName(row.path)}
        </span>
        {shouldShowDirLoadingSuffix(row.loading, row.placeholder) ? (
          <span className="flex-shrink-0 text-caption-small-strong text-text_default_tertiary">
            {t("files.tree.loading")}
          </span>
        ) : null}
      </button>
      {/* Hover-only actions — the parent group/dir makes them
          visible on hover via Tailwind's `group-hover/dir`. Hidden
          by default so the row itself stays uncluttered. */}
      <div className="hidden flex-shrink-0 items-center gap-0.5 group-hover/dir:flex">
        {!isRoot && !row.error ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void onMkdir();
            }}
            aria-label={t("files.tree.newFolder")}
            title={t("files.tree.newFolder")}
            data-testid="files-tree-dir-mkdir"
            className="flex size-5 items-center justify-center rounded text-icon_default_tertiary hover:bg-bg_interaction_tertiary_selected hover:text-icon_default_primary"
          >
            <Icon name="plusSmall" size={12} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRefresh();
          }}
          aria-label={t("files.tree.refreshAria")}
          title={t("files.tree.refresh")}
          data-testid="files-tree-dir-refresh"
          className="flex size-5 items-center justify-center rounded text-icon_default_tertiary hover:bg-bg_interaction_tertiary_selected hover:text-icon_default_primary"
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {row.error ? (
        <span
          data-testid="files-tree-dir-error"
          className="ml-1 truncate text-caption-small-strong text-text_status_warning"
          title={row.error}
        >
          {t("files.tree.outOfBounds")}
        </span>
      ) : null}
      {row.skipped > 0 ? (
        <span
          data-testid="files-tree-dir-truncated"
          className="ml-1 flex-shrink-0 text-caption-small-strong text-text_default_tertiary"
          title={t("files.tree.truncated").replace("{n}", String(row.skipped))}
        >
          {t("files.tree.truncated").replace("{n}", String(row.skipped))}
        </span>
      ) : null}
    </div>
  );
}

/**
 * File row — coloured type chip + name + size / mtime + hover copy.
 *
 * The row is the entry point for the `open.file.in.web` action (slice
 * 12): clicking the icon + name area fires the single-source action in
 * `lib/open-file.ts`, which routes through the same `FilePreviewPane`
 * the turn summary uses. The hover-only "复制绝对路径" button stays as
 * its own target so a copy action never opens the preview by accident.
 */
function FileRow({
  row,
  t,
  now,
  copied,
  highlighted = false,
  credential = false,
  source = "loaded",
  onOpen,
  onCopy,
}: {
  row: TreeFileRow;
  t: (key: MessageKey) => string;
  now: number;
  copied: boolean;
  /** Server-search hit highlight — applied for a few seconds after
   *  a server result lands. Renders a left-edge accent so the
   *  user's eye lands on the row. */
  highlighted?: boolean;
  /** Slice 16 alignment — when the server marks this row as
   *  credential-shaped the panel renders an inline "已阻止预览"
   *  affordance next to the name. Clicking still routes through
   *  `onOpen`; the slice-16 read-file gate refuses by default and
   *  shows the second confirmation. */
  credential?: boolean;
  /** Origin of the row — `"loaded"` means the panel walked the
   *  tree normally, `"server"` means the row came from a server
   *  search and may live in an unloaded directory. Exposed via
   *  `data-source` so tests can pin the wiring without a DOM. */
  source?: "loaded" | "server";
  onOpen: () => void;
  onCopy: () => void;
}) {
  const indent = row.depth * 12;
  const entry = row.entry;
  const bucket = relativeMtimeBucket(now, entry.mtime);
  const mtimeLabel = bucket === "now"
    ? t("files.tree.mtime.now")
    : bucket === ""
      ? ""
      : (() => {
          const [kind, raw] = bucket.split(":");
          const n = Number(raw);
          const safe = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 0;
          return t(`files.tree.mtime.${kind}` as MessageKey).replace("{n}", String(safe));
        })();
  return (
    <div
      className={[
        "group/file flex h-[26px] items-center gap-1 rounded-lg px-1 transition-colors hover:bg-bg_interaction_tertiary_hover",
        highlighted ? "bg-bg_interaction_tertiary_selected" : "",
      ].join(" ")}
      style={{ paddingLeft: 4 + indent }}
      data-testid="files-tree-file-row"
      data-path={entry.path}
      data-depth={row.depth}
      data-highlighted={highlighted ? "true" : "false"}
      data-source={source}
      data-credential={credential ? "true" : "false"}
    >
      {/* Spacer to keep the file name aligned with the dir row's text
          position (the dir row uses a 16px chevron + 4px icon). The
          file row has no chevron, so we add 16px of leading space. */}
      <span className="w-4 flex-shrink-0" />
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("files.tree.fileAria").replace("{name}", entry.name)}
        title={entry.path}
        data-testid="files-tree-file-open"
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded text-left text-text_default_primary hover:text-text_default_primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border_accent"
      >
        <span
          className={[
            "flex size-4 flex-shrink-0 items-center justify-center",
            fileTypeColor(entry.name),
          ].join(" ")}
          aria-hidden
        >
          <Icon name="file" size={13} />
        </span>
        <span className="min-w-0 truncate text-sm">{entry.name}</span>
        {credential ? (
          <span
            data-testid="files-tree-file-credential"
            className="flex flex-shrink-0 items-center gap-1 rounded bg-bg_grouped_tertiary px-1 py-0.5 text-caption-small-strong text-text_status_warning"
          >
            <span>{t("files.search.credential")}</span>
          </span>
        ) : null}
      </button>
      <span className="flex-shrink-0 text-caption-small-strong text-text_default_tertiary">
        {entry.size > 0 ? formatSize(entry.size) : ""}
      </span>
      {mtimeLabel ? (
        <span className="flex-shrink-0 text-caption-small-strong text-text_default_tertiary">
          {mtimeLabel}
        </span>
      ) : null}
      <div className="hidden flex-shrink-0 items-center group-hover/file:flex">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCopy();
          }}
          aria-label={t("files.tree.copyPath")}
          title={t("files.tree.copyPath")}
          data-testid="files-tree-file-copy"
          className="flex h-5 items-center gap-1 rounded px-1.5 text-caption-small-strong text-icon_default_tertiary hover:bg-bg_interaction_tertiary_selected hover:text-icon_default_primary"
        >
          {copied ? <Icon name="check" size={12} /> : <Icon name="copy" size={12} />}
          <span>{copied ? t("files.tree.copied") : t("files.tree.copyPath")}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Server-search footer (slice 19b). Renders the structured list of
 * segments produced by `searchFootSegments`. The footer is the
 * "honest" copy — it always tells the user what was skipped and,
 * when truncated, which budget fired. Acceptance pinned
 * `skipped.huge` as a mandatory segment even when `truncated` is
 * false; the helper never drops that signal.
 */
function SearchFooter({
  result,
  t,
}: {
  result: api.FsSearchResult;
  t: (key: MessageKey) => string;
}) {
  const segments = searchFootSegments(result, {
    templates: {
      scanned: t("files.search.footer.scanned"),
      matches: t("files.search.footer.matches"),
      "skipped-node_modules": t("files.search.footer.skipped.node_modules"),
      "skipped-git": t("files.search.footer.skipped.git"),
      "skipped-credential": t("files.search.footer.skipped.credential"),
      "skipped-huge": t("files.search.footer.skipped.huge"),
      "skipped-optional": t("files.search.footer.skipped.optional"),
      truncated: t("files.search.footer.truncated"),
      elapsed: t("files.search.footer.elapsed"),
    },
    budgetLabels: {
      depth: t("files.search.footer.budget.depth"),
      nodes: t("files.search.footer.budget.nodes"),
      wallClock: t("files.search.footer.budget.wallClock"),
      matches: t("files.search.footer.budget.matches"),
    },
    formatElapsed: (ms) => t("files.search.footer.elapsedValue").replace("{ms}", String(ms)),
  });
  if (segments.length === 0) return null;
  // Render with a middot separator so the row reads as a single
  // meta line, not a stack of pills. The footer is intentionally
  // small — its job is "trust the result is honest", not "explain
  // every line".
  const optionalDetail = Object.entries(result.skipped?.optional ?? {})
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  return (
    <p
      data-testid="files-tree-server-footer"
      data-truncated={result.truncated ? "true" : "false"}
      className="flex flex-wrap gap-x-1 gap-y-0.5 px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
      title={
        optionalDetail
          ? `${t("files.search.footer.skipped.optional")} (${optionalDetail})`
          : undefined
      }
    >
      {segments.map((segment, index) => (
        <span
          key={`${segment.kind}:${index}`}
          data-testid={`files-tree-server-footer-segment-${segment.kind}`}
        >
          {segment.text}
        </span>
      ))}
    </p>
  );
}

function baseName(path: string): string {
  if (!path) return "";
  const stripped = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const i = stripped.lastIndexOf("/");
  return i === -1 ? stripped : stripped.slice(i + 1);
}


/**
 * Git panel — right-panel git surface (slice 03 of webui-parity).
 *
 * Drives three things:
 *
 *   - Workspace status: current branch + ahead/behind + changed files
 *     (staged / unstaged / untracked). Source = `GET /api/git/status`.
 *   - Per-file diff: clicking a file row fetches its diff via
 *     `GET /api/git/diff` and renders it inline.
 *   - Branch switch: a dropdown of local branches
 *     (`GET /api/git/branches`) plus a confirmation-gated destructive
 *     `POST /api/git/checkout`. The panel never sends a switch
 *     without an explicit user OK.
 *
 * Empty states are explicit, not error toasts:
 *
 *   - no workspace      → `t("git.empty.noWorkspace")`
 *   - non-git directory → `t("git.empty.notRepo")`
 *   - clean working tree → `t("git.empty.clean")`
 *
 * Containment is enforced server-side; the panel reads `ok` from the
 * payload and renders the empty state for `ok:false` answers rather
 * than showing a red toast.
 */
export function GitPanel({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  const workspaceDir = state?.workspace.dir ?? "";

  const [status, setStatus] = useState<api.GitStatusPayload | null>(null);
  const [branches, setBranches] = useState<api.GitBranch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Branch-switch confirmation. The destructive confirmation lives
  // here (the panel) rather than in a global modal because the
  // confirmation must be tied to the very branch that was clicked —
  // a single confirmation modal per switch is what the ticket pins.
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchResult, setSwitchResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Per-request generation counter — race safety so an in-flight
  // workspace switch never overwrites a fresher status response.
  const loadGen = useRef(0);
  const diffGen = useRef(0);

  const refreshStatus = useCallback(async () => {
    if (!workspaceDir) {
      setStatus(null);
      setBranches(null);
      return;
    }
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const [statusResult, branchesResult] = await Promise.all([
        api.getGitStatus(workspaceDir),
        api.getGitBranches(workspaceDir),
      ]);
      if (gen !== loadGen.current) return;
      setStatus(statusResult);
      setBranches(Array.isArray(branchesResult.branches) ? branchesResult.branches : []);
    } catch (cause) {
      if (gen !== loadGen.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [workspaceDir]);

  // Re-fetch on workspace change + manual refresh. The status helper
  // itself does not poll — the panel only refreshes on user request
  // (the Refresh button) or when the workspace dir changes.
  useEffect(() => {
    void refreshStatus();
    setSelectedFile(null);
    setDiff(null);
    setSwitchResult(null);
  }, [refreshStatus]);

  const loadDiff = useCallback(
    async (file: string) => {
      const gen = ++diffGen.current;
      setSelectedFile(file);
      setDiffLoading(true);
      setDiffError(null);
      setDiff(null);
      try {
        const result = await api.getGitDiff(workspaceDir, file);
        if (gen !== diffGen.current) return;
        if (!result.ok) {
          setDiffError(result.error || "diff failed");
          return;
        }
        setDiff(previewDiff(result.diff, 400));
      } catch (cause) {
        if (gen !== diffGen.current) return;
        setDiffError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (gen === diffGen.current) setDiffLoading(false);
      }
    },
    [workspaceDir],
  );

  const confirmSwitch = useCallback(async () => {
    if (!pendingBranch || !workspaceDir) return;
    setSwitchBusy(true);
    try {
      const result = await api.gitCheckout(workspaceDir, pendingBranch);
      if (result.ok) {
        setSwitchResult({ ok: true, message: t("git.switch.success").replace("{{branch}}", pendingBranch) });
      } else {
        setSwitchResult({
          ok: false,
          message: t("git.switch.failed").replace("{{error}}", result.error || "unknown"),
        });
      }
      setPendingBranch(null);
      // Refresh status — branch may have changed; old files list is stale.
      void refreshStatus();
      setSelectedFile(null);
      setDiff(null);
    } catch (cause) {
      setSwitchResult({
        ok: false,
        message: t("git.switch.failed").replace("{{error}}", cause instanceof Error ? cause.message : String(cause)),
      });
      setPendingBranch(null);
    } finally {
      setSwitchBusy(false);
    }
  }, [pendingBranch, workspaceDir, t, refreshStatus]);

  if (!workspaceDir) {
    return (
      <div className="flex flex-col gap-2" data-testid="git-panel-empty-no-workspace">
        <span className="desktop-text-dialog-medium flex items-center gap-2 text-base font-medium leading-6 text-text_default_primary">
          <Icon name="git" size={16} />
          {t("git.title")}
        </span>
        <p className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-2 text-caption-small-strong text-text_default_tertiary">
          {t("git.empty.noWorkspace")}
        </p>
      </div>
    );
  }

  const notRepo =
    status &&
    ((status.ok && status.isRepo === false) ||
      (!status.ok && status.isRepo === false));

  if (notRepo) {
    return (
      <div className="flex flex-col gap-2" data-testid="git-panel-empty-not-repo">
        <span className="desktop-text-dialog-medium flex items-center gap-2 text-base font-medium leading-6 text-text_default_primary">
          <Icon name="git" size={16} />
          {t("git.title")}
        </span>
        <p className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-2 text-caption-small-strong text-text_default_tertiary">
          {t("git.empty.notRepo")}
        </p>
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={loading}
          aria-label={t("git.refreshAria")}
          data-testid="git-panel-refresh"
          className="flex h-7 w-fit items-center gap-1 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
        >
          <Icon name="refresh" size={12} />
          {t("git.refresh")}
        </button>
      </div>
    );
  }

  const buckets = splitFilesByBucket(status?.files);
  const hasFiles =
    buckets.staged.length + buckets.unstaged.length + buckets.untracked.length > 0;
  const currentBranch = branches?.find((b) => b.current)?.name ?? status?.branch ?? null;
  const upstream = status?.upstream ?? null;

  return (
    <div className="flex flex-col gap-3" data-testid="git-panel">
      {/* Header: title + refresh + branch switcher. */}
      <div className="flex items-center gap-1">
        <span className="desktop-text-dialog-medium flex flex-1 items-center gap-2 text-base font-medium leading-6 text-text_default_primary">
          <Icon name="git" size={16} />
          {t("git.title")}
        </span>
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={loading}
          aria-label={t("git.refreshAria")}
          title={t("git.refresh")}
          data-testid="git-panel-refresh"
          className="flex size-7 flex-shrink-0 items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary disabled:opacity-50"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {/* Branch summary + switcher. */}
      <div className="flex flex-col gap-1">
        <span className="desktop-text-ui-assist text-text_default_tertiary">
          {t("git.branch.label")}
        </span>
        {currentBranch ? (
          upstream ? (
            <span
              className="font-family-code text-caption-small-strong text-text_default_secondary"
              data-testid="git-panel-branch-label"
              title={`${currentBranch} tracking ${upstream} (ahead ${status?.ahead ?? 0}, behind ${status?.behind ?? 0})`}
            >
              {t("git.branch.tracking")
                .replace("{{branch}}", currentBranch)
                .replace("{{upstream}}", upstream)
                .replace("{{ahead}}", String(status?.ahead ?? 0))
                .replace("{{behind}}", String(status?.behind ?? 0))}
            </span>
          ) : (
            <span
              className="font-family-code text-caption-small-strong text-text_default_secondary"
              data-testid="git-panel-branch-label"
              title={currentBranch}
            >
              {t("git.branch.tracking.noUpstream").replace("{{branch}}", currentBranch)}
            </span>
          )
        ) : (
          <span className="text-caption-small-strong text-text_default_tertiary">—</span>
        )}
        {branches && branches.length > 0 ? (
          <select
            value={currentBranch ?? ""}
            onChange={(event) => {
              const next = event.target.value;
              if (next && next !== currentBranch) setPendingBranch(next);
              // Always reset the select to the current branch — the
              // real change happens only after the user confirms.
              event.currentTarget.value = currentBranch ?? "";
            }}
            disabled={switchBusy}
            data-testid="git-panel-branch-switcher"
            className="mavis-input mt-1"
          >
            {(branches ?? []).map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {/* Changed files. Empty state when the working tree is clean. */}
      <div className="flex flex-col gap-1">
        <span className="desktop-text-ui-assist text-text_default_tertiary">
          {t("git.files.title")}
        </span>
        {!hasFiles ? (
          <p
            data-testid="git-panel-clean"
            className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-2 text-caption-small-strong text-text_default_tertiary"
          >
            {t("git.empty.clean")}
          </p>
        ) : (
          <ul className="flex flex-col gap-px" data-testid="git-panel-files">
            {[...buckets.staged, ...buckets.unstaged, ...buckets.untracked].map((file) => {
              const isSelected = file.path === selectedFile;
              const bucketLabel = file.staged
                ? t("git.files.staged")
                : file.x === "?" && file.y === "?"
                  ? t("git.files.untracked")
                  : t("git.files.unstaged");
              return (
                <li key={`${file.x}${file.y}:${file.path}`}>
                  <button
                    type="button"
                    onClick={() => void loadDiff(file.path)}
                    aria-label={t("git.file.openDiff")}
                    title={file.path}
                    data-testid={`git-panel-file-${file.path}`}
                    data-bucket={file.staged ? "staged" : file.x === "?" ? "untracked" : "unstaged"}
                    data-selected={isSelected ? "true" : "false"}
                    className={[
                      "flex h-7 w-full items-center gap-1 rounded-lg px-1.5 text-left transition-colors",
                      isSelected
                        ? "bg-bg_interaction_tertiary_selected"
                        : "hover:bg-bg_interaction_tertiary_hover",
                    ].join(" ")}
                  >
                    <span
                      className="min-w-[28px] flex-none font-family-code text-caption-small-strong text-text_default_tertiary"
                      data-testid={`git-panel-file-tags-${file.path}`}
                    >
                      {formatStatusTags(file)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text_default_primary">
                      {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                    </span>
                    <span className="flex-none text-caption-small-strong text-text_default_tertiary">
                      {bucketLabel}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Inline diff preview. */}
      {selectedFile ? (
        <div className="flex flex-col gap-1" data-testid="git-panel-diff">
          <span className="desktop-text-ui-assist truncate text-text_default_tertiary" title={selectedFile}>
            {selectedFile}
          </span>
          {diffLoading ? (
            <p className="text-caption-small-strong text-text_default_tertiary">
              {t("git.file.diff.loading")}
            </p>
          ) : diffError ? (
            <p
              data-testid="git-panel-diff-error"
              className="text-caption-small-strong text-text_status_error"
            >
              {t("git.file.diff.failed")}: {diffError}
            </p>
          ) : diff && diff.text ? (
            <pre className="thin-scrollbar max-h-[280px] overflow-auto rounded-[8px] bg-bg_grouped_secondary_elevated p-2 font-family-code text-caption-small-strong text-text_default_secondary">
              {diff.text}
              {diff.truncated ? (
                <span className="block pt-1 text-text_default_tertiary">
                  …{t("git.file.diff.truncated")}
                </span>
              ) : null}
            </pre>
          ) : (
            <p className="text-caption-small-strong text-text_default_tertiary">
              {t("git.file.diff.empty")}
            </p>
          )}
        </div>
      ) : null}

      {/* Switch outcome (transient). A success means the branch /
          file list re-fetched; a failure stays visible until the
          next action. */}
      {switchResult ? (
        <p
          data-testid={switchResult.ok ? "git-panel-switch-success" : "git-panel-switch-error"}
          className={[
            "rounded-[8px] px-2 py-1.5 text-caption-small-strong",
            switchResult.ok
              ? "bg-bg_grouped_secondary_elevated text-text_default_secondary"
              : "bg-bg_grouped_secondary_elevated text-text_status_error",
          ].join(" ")}
        >
          {switchResult.message}
        </p>
      ) : null}

      {/* Surface unexpected errors that are neither a non-git dir nor
          a containment rejection (those render their own empty state). */}
      {error ? (
        <p
          data-testid="git-panel-error"
          className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5 text-caption-small-strong text-text_status_error"
        >
          {error}
        </p>
      ) : null}

      {/* Destructive branch switch — confirmed client-side. */}
      <AntModal
        open={pendingBranch !== null}
        onCancel={() => !switchBusy && setPendingBranch(null)}
        footer={null}
        width={420}
        rootClassName="mavis-confirm-modal-compact"
        classNames={{
          mask: "mavis-confirm-modal-compact-mask",
          content: "mavis-confirm-modal-compact-surface",
        }}
        title={
          <span className="mavis-confirm-modal-compact-title text-heading3 text-text_default_primary">
            {t("git.switch.confirm.title")}
          </span>
        }
      >
        <div className="flex flex-col gap-3" data-testid="git-switch-confirm">
          <p className="text-sm leading-5 text-text_default_secondary">
            {t("git.switch.confirm.body").replace("{{branch}}", pendingBranch ?? "")}
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={switchBusy}
              onClick={() => setPendingBranch(null)}
              data-testid="git-switch-cancel"
              className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
            >
              {t("git.switch.confirm.cancel")}
            </button>
            <button
              type="button"
              disabled={switchBusy}
              onClick={() => void confirmSwitch()}
              data-testid="git-switch-ok"
              className="h-8 rounded-lg bg-bg_status_positive px-3 text-sm font-medium text-text_inverse transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {t("git.switch.confirm.ok")}
            </button>
          </div>
        </div>
      </AntModal>
    </div>
  );
}

function WorkspacePanel({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
  // The git rows are active in upstream — disabled would lie. The webui does
  // not yet expose these endpoints, so a click surfaces an explicit transient
  // notice inside the section itself (instead of mutating the global alert
  // ring buffer, which is reserved for engine-emitted events).
  const [missingEndpoint, setMissingEndpoint] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div
      className="flex w-full flex-col gap-3"
      data-testid="workspace-section-group"
    >
      {/* §1 section_environmental — branch in subtitle, the current workspace
          directory underneath, a "Switch workspace" button, and 3 git
          entries as active buttons. Branch placeholder uses `\u00a0`
          (upstream's choice) rather than `undefined` so the header keeps its
          height when the engine has not yet picked a workspace. */}
      <WorkspaceSection
        title={t("workspace.sectionEnvironment")}
        subtitle={state?.workspace.branch ?? "\u00a0"}
      >
        <div className="flex flex-col gap-2">
          {/* The current workspace — the directory itself, plus the
              "Switch workspace" button next to it. Empty when the server
              has not reported one yet (the message is the "no workspace"
              hint the picker renders for an unset state). */}
          <div
            data-testid="workspace-current-dir"
            className="flex items-center gap-2 rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5"
          >
            <span className="flex size-5 flex-none items-center justify-center text-icon_default_secondary">
              <Icon name="folder" size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate font-family-code text-caption-small-strong text-text_default_primary">
              {state?.workspace.dir || t("workspace.picker.noWorkspace")}
            </span>
            <button
              type="button"
              data-testid="workspace-switch-button"
              onClick={() => setPickerOpen(true)}
              className="flex h-7 flex-none items-center gap-1 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
            >
              <Icon name="folderEmpty" size={14} />
              <span>{t("workspace.switch")}</span>
            </button>
          </div>

          <div className="flex flex-col gap-px">
            {(
              [
                { row: "changes", testid: "workspace-changes-entry", icon: "file" },
                { row: "commitAndPush", testid: "workspace-commit-entry", icon: "file" },
                { row: "openTerminal", testid: "workspace-open-terminal-entry", icon: "terminal" },
              ] as const
            ).map(({ row, testid, icon }) => (
              <button
                key={row}
                type="button"
                data-testid={testid}
                title={t("workspace.env.activeHint")}
                onClick={() => setMissingEndpoint(row)}
                className="flex h-8 w-full items-center gap-2 rounded-[8px] pl-1.5 pr-2 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
              >
                <span className="flex size-5 flex-none items-center justify-center text-icon_default_primary">
                  <Icon name={icon} size={20} />
                </span>
                <span className="desktop-text-ui-body min-w-0 flex-1 truncate text-sm text-text_default_primary">
                  {t(`workspace.${row}` as MessageKey)}
                </span>
              </button>
            ))}
            {missingEndpoint ? (
              <p
                data-testid="workspace-env-missing-endpoint"
                className="mt-1 rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5 text-caption-small-strong text-text_default_tertiary"
              >
                {t("workspace.env.activeHint")}
              </p>
            ) : null}
          </div>
        </div>
      </WorkspaceSection>

      {/* §2 section_plan — upstream shows the run's plan review card. */}
      <WorkspaceSection title={t("workspace.sectionPlan")}>
        <SectionPlaceholder testid="workspace-plan" t={t} />
      </WorkspaceSection>

      {/* §3 agent_team — upstream renders the `PreviewerMini` embedded variant
          listing delegated runs. */}
      <WorkspaceSection title={t("workspace.sectionAgentTeam")}>
        <SectionPlaceholder testid="workspace-agent-team" t={t} />
      </WorkspaceSection>

      {/* §4 working_folders — upstream renders the folder tree of the active
          workspace. */}
      <WorkspaceSection title={t("workspace.sectionWorkingFolders")}>
        <SectionPlaceholder testid="workspace-working-folders" t={t} />
      </WorkspaceSection>

      {/* §5 sources — upstream renders a card with the icons of sources the
          run has read from. */}
      <WorkspaceSection title={t("workspace.sectionSources")}>
        <SectionPlaceholder testid="workspace-sources" t={t} />
      </WorkspaceSection>

      {/* §6 cloudResultReview / 交付物 — upstream renders the cloud-session
          result review (its "deliverables" surface). */}
      <WorkspaceSection title={t("workspace.sectionDeliverables")}>
        <SectionPlaceholder testid="workspace-cloud-result" t={t} />
      </WorkspaceSection>

      <WorkspacePickerModal
        t={t}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentDir={state?.workspace.dir ?? null}
      />
    </div>
  );
}

/**
 * A named section inside the workspace panel.
 *
 * Upstream's section header carries an optional subtitle — for 环境信息 that is
 * the current git branch. The upstream code falls back to `\u00a0` (a
 * non-breaking space) when the branch is missing, so the header keeps its
 * height; we mirror that. Body styling matches upstream's `_.N` section
 * wrapper: vertical stack, 4px gap, 6px left padding on the header so the
 * title aligns with the row icons.
 */
function WorkspaceSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex w-full flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2 px-1.5">
        <span className="desktop-text-ui-small-strong text-text_default_primary">{title}</span>
        {subtitle ? (
          <span className="desktop-text-ui-assist min-w-0 truncate text-text_default_tertiary">
            {subtitle}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Honest placeholder used inside sections whose upstream data (planReview,
 * teamMembers, files / fileSource, sourceHistory, cloudResultReview) the
 * webui does not yet expose. Reads as "this section is real, the data is
 * not yet wired" rather than as an empty list ("no plan yet").
 */
function SectionPlaceholder({ testid, t }: { testid: string; t: (key: MessageKey) => string }) {
  return (
    <div
      data-testid={testid}
      className="flex items-center gap-2 rounded-[8px] px-1.5 py-2 text-text_default_tertiary"
    >
      <span className="desktop-text-ui-assist text-sm">{t("workspace.section.development")}</span>
    </div>
  );
}

/**
 * Workspace picker — modal that drives the workspace switch flow.
 *
 * Implements the PR #22 fs-picker feature checklist (path input, parent
 * navigation, directory listing, glob filter, create-new-folder, recents
 * tab, native OS picker) using antd primitives in the current Next.js
 * stack. Two tabs: `Recents` shows the server's recent-workspaces list
 * (from session activity) and a "no workspace" button (uses tmpdir);
 * `Browse` is the in-product directory navigator.
 *
 * The browser tab is the workhorse — it is the one that always works,
 * including in token-gated / no-native-picker environments. The native
 * picker button is opportunistic: when it succeeds, the picked path is
 * fed straight into the same `setWorkspace` call.
 *
 * Exported so other surfaces (the home-screen workspace chip's "选择新
 * 项目" affordance, see `components/workspace-picker.tsx`) can mount it
 * without going through the conversation-view WorkspacePanel. The modal
 * is one component, one source of truth — each caller owns its own open
 * state and never shares an instance.
 *
 * Wire: the modal is dismissible (settings-modal-style), and the picked
 * path is forwarded to `POST /api/workspace` (the same handler the rest
 * of the app uses). On success the picker closes; the state snapshot
 * update carries the new directory through the SSE stream, so any
 * downstream consumer (composer attachments, session tree) sees it
 * without further wiring.
 */
export function WorkspacePickerModal({
  t,
  open,
  onClose,
  currentDir,
}: {
  t: (key: MessageKey) => string;
  open: boolean;
  onClose: () => void;
  currentDir: string | null;
}) {
  return (
    <AntModal
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={560}
      rootClassName="mavis-confirm-modal-compact"
      classNames={{
        mask: "mavis-confirm-modal-compact-mask",
        content: "mavis-confirm-modal-compact-surface",
      }}
      styles={{ header: { background: "transparent" } }}
      title={
        <span className="flex items-center gap-2">
          <span className="mavis-confirm-modal-compact-title text-heading3 text-text_default_primary">
            {t("workspace.picker.title")}
          </span>
        </span>
      }
    >
      <WorkspacePickerBody t={t} onClose={onClose} currentDir={currentDir} />
    </AntModal>
  );
}

/**
 * The modal body. State machine: `Browse` reads `/api/workspace/browse`
 * (containment-checked server-side), `Recents` reads `/api/workspace/recent`.
 * Both feeds feed the same confirmation handler (`setWorkspace`).
 */
function WorkspacePickerBody({
  t,
  onClose,
  currentDir,
}: {
  t: (key: MessageKey) => string;
  onClose: () => void;
  currentDir: string | null;
}) {
  const [tab, setTab] = useState<"recents" | "browse">("recents");

  return (
    <div className="flex flex-col gap-3" data-testid="workspace-picker">
      <AntTabs
        activeKey={tab}
        onChange={(key) => setTab(key as "recents" | "browse")}
        items={[
          {
            key: "recents",
            label: t("workspace.picker.tabs.recents"),
          },
          {
            key: "browse",
            label: t("workspace.picker.tabs.browse"),
          },
        ]}
      />

      {tab === "recents" ? (
        <WorkspaceRecentsTab
          t={t}
          onClose={onClose}
          currentDir={currentDir}
          onSwitchToBrowse={() => setTab("browse")}
        />
      ) : (
        <WorkspaceBrowseTab t={t} onClose={onClose} currentDir={currentDir} />
      )}
    </div>
  );
}

interface RecentPick {
  dir: string;
  name: string;
  sessionCount: number;
  lastActiveAt: number;
}

function WorkspaceRecentsTab({
  t,
  onClose,
  currentDir,
  onSwitchToBrowse,
}: {
  t: (key: MessageKey) => string;
  onClose: () => void;
  currentDir: string | null;
  onSwitchToBrowse: () => void;
}) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<RecentPick[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tmpDir, setTmpDir] = useState<string | null>(null);

  // Last-write-wins: a search query that lands after a broader one
  // should not silently re-replace the displayed list. Same trick as
  // the FilesPanel.
  const loadGen = useRef(0);
  const load = useCallback(
    async (q: string) => {
      const gen = ++loadGen.current;
      setLoading(true);
      setError(null);
      try {
        const result = await api.recentWorkspaces(q, 20);
        if (gen !== loadGen.current) return;
        setItems(result.items ?? []);
        if (result.tmpDir) setTmpDir(result.tmpDir);
      } catch (cause) {
        if (gen !== loadGen.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (gen === loadGen.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load(search);
    }, 120);
    return () => window.clearTimeout(handle);
  }, [load, search]);

  const pick = async (dir: string | null) => {
    setBusy(true);
    try {
      if (dir === null) {
        // "No workspace" uses tmpdir: same behaviour as the chat composer
        // when launched without an explicit workspace. The server
        // resolves the temp directory as the workspace.
        if (!tmpDir) {
          setError(t("workspace.picker.error"));
          return;
        }
        await api.setWorkspace(tmpDir);
      } else {
        await api.setWorkspace(dir);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const filtered = items.filter(
    (it) =>
      !search.trim() ||
      it.dir.toLowerCase().includes(search.trim().toLowerCase()) ||
      it.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-2">
      <AntInput
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t("workspace.picker.recents.search")}
        data-testid="workspace-recents-search"
        className="mavis-input"
      />

      {error ? (
        <p
          data-testid="workspace-recents-error"
          className="text-caption-small-strong text-text_status_error"
        >
          {error}
        </p>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="text-caption-small-strong text-text_default_tertiary">
          {t("workspace.picker.loading")}
        </p>
      ) : null}

      {!loading && items.length === 0 && !error ? (
        <p
          data-testid="workspace-recents-empty"
          className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-2 text-caption-small-strong text-text_default_tertiary"
        >
          {t("workspace.picker.recents.empty")}
        </p>
      ) : null}

      {filtered.length > 0 ? (
        <ul
          data-testid="workspace-recents-list"
          className="flex max-h-[260px] flex-col gap-px overflow-y-auto"
        >
          {filtered.map((item) => {
            const isCurrent = item.dir === currentDir;
            return (
              <li key={item.dir}>
                <button
                  type="button"
                  data-testid={`workspace-recents-row-${item.dir}`}
                  disabled={busy}
                  onClick={() => void pick(item.dir)}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-text_default_primary">
                      {item.name}
                    </span>
                    {isCurrent ? (
                      <span
                        data-testid={`workspace-recents-current-${item.dir}`}
                        className="rounded-full bg-bg_interaction_tertiary_selected px-1.5 py-0.5 text-caption-small-strong text-text_default_primary"
                      >
                        ✓
                      </span>
                    ) : null}
                  </span>
                  <span
                    title={item.dir}
                    className="truncate font-family-code text-caption-small-strong text-text_default_tertiary"
                  >
                    {item.dir}
                  </span>
                  <span className="text-caption-small-strong text-text_default_tertiary">
                    {item.sessionCount} session{item.sessionCount === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void pick(null)}
          data-testid="workspace-recents-no-workspace"
          className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
        >
          {t("workspace.picker.noWorkspace")}
        </button>
        <button
          type="button"
          onClick={onSwitchToBrowse}
          data-testid="workspace-recents-browse"
          className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("workspace.picker.tabs.browse")}…
        </button>
      </div>
    </div>
  );
}

function WorkspaceBrowseTab({
  t,
  onClose,
  currentDir,
}: {
  t: (key: MessageKey) => string;
  onClose: () => void;
  currentDir: string | null;
}) {
  // Seed the directory from the active workspace when one is set —
  // most of the time the user opens the picker to "go up one level",
  // not to navigate from the platform root.
  const [path, setPath] = useState<string>(() => currentDir ?? "");
  const [listing, setListing] = useState<api.BrowseResult | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRoots, setErrorRoots] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadGen = useRef(0);
  const load = useCallback(async (target: string) => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    setErrorRoots(null);
    try {
      const result = await api.browseWorkspace(target || undefined);
      if (gen !== loadGen.current) return;
      if (result.ok) {
        setListing(result);
      } else {
        // The server carries `roots` on the containment error payload
        // (server/lib/workspace.js#assertWorkspacePath /
        // resolveWithinRoots) so the picker can render "must be under:
        // …" instead of a bare "非法". Surface them in the UI.
        setError(result.error ?? t("workspace.picker.error"));
        if (Array.isArray(result.roots)) setErrorRoots(result.roots);
      }
    } catch (cause) {
      if (gen !== loadGen.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const entries = listing?.children ?? [];
  // Dirs first, then alphabetical — the same shape FilesPanel uses.
  const sorted = useMemo(() => {
    const dirs = entries.filter((e) => e.isDir);
    const rest = entries.filter((e) => !e.isDir);
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    rest.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...rest];
  }, [entries]);
  const matched = filter
    ? sorted.filter((e) => matchFilter(e.name, filter))
    : sorted;
  const visible = matched.slice(0, 200);
  const hidden = matched.length - visible.length;

  const pick = async () => {
    // Server wire field is `dir` (see server/lib/workspace.js#browseWorkspace).
    // The wire name used to drift to the wrong field in the webapp type and
    // reading code — that regression was the root cause of the picker
    // silently doing nothing (confirm button permanently disabled). Keep
    // this on `listing.dir`; the regression test in
    // webapp/test/workspace-picker-wire.test.ts pins both the type and
    // the read site.
    if (!listing?.dir) {
      setError(t("workspace.picker.error"));
      return;
    }
    setBusy(true);
    try {
      await api.setWorkspace(listing.dir);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mkdir = async () => {
    if (!listing?.dir) return;
    const name = window.prompt(t("workspace.picker.newFolderPrompt"), "");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const next = `${listing.dir.replace(/\/+$/, "")}/${trimmed}`;
      const result = await api.mkdir(next);
      if (!result.ok) {
        setError(result.path ? "mkdir failed" : "mkdir failed");
        return;
      }
      // Re-list the parent to surface the new folder.
      await load(listing.dir);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Toolbar: parent, path, home, root, mkdir. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && setPath(listing.parent)}
          data-testid="workspace-picker-up"
          aria-label={t("workspace.picker.up")}
          title={t("workspace.picker.up")}
          className="flex size-7 flex-none items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-40"
        >
          <Icon name="chevronRight" size={14} className="rotate-180" />
        </button>
        <AntInput
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onPressEnter={() => setPath(path.trim())}
          placeholder={t("workspace.picker.pathPlaceholder")}
          aria-label={t("workspace.picker.pathPlaceholder")}
          data-testid="workspace-picker-path"
          className="mavis-input min-w-0 flex-1"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setPath("~")}
          data-testid="workspace-picker-home"
          className="h-7 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("workspace.picker.home")}
        </button>
        <button
          type="button"
          onClick={() => setPath("")}
          data-testid="workspace-picker-roots"
          className="h-7 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("workspace.picker.root")}
        </button>
        <button
          type="button"
          disabled={!listing?.dir}
          onClick={() => void mkdir()}
          data-testid="workspace-picker-mkdir"
          className="h-7 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-40"
        >
          {t("workspace.picker.newFolder")}
        </button>
        {/* Native OS picker (zenity/kdialog/osascript/PowerShell) removed
            per ticket feedback — the in-product WorkspacePickerModal is the
            only path now. See routes/workspace.js#v0.5.by comment. */}
      </div>

      {/* Filter row — same matcher as FilesPanel. */}
      <div className="flex items-center gap-1">
        <AntInput
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("workspace.picker.filterPlaceholder")}
          data-testid="workspace-picker-filter"
          className="mavis-input min-w-0 flex-1"
        />
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter("")}
            aria-label={t("files.clearFilter")}
            data-testid="workspace-picker-filter-clear"
            className="flex size-8 flex-none items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>

      {error ? (
        <div
          data-testid="workspace-picker-error"
          className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5 text-caption-small-strong text-text_status_error"
        >
          <span className="block">{error}</span>
          {errorRoots && errorRoots.length > 0 ? (
            <span
              data-testid="workspace-picker-error-roots"
              className="mt-1 block text-text_default_tertiary"
            >
              {t("workspace.picker.mustBeUnder")} {errorRoots.join(", ")}
            </span>
          ) : null}
        </div>
      ) : null}

      {loading && entries.length === 0 ? (
        <p className="text-caption-small-strong text-text_default_tertiary">
          {t("workspace.picker.loading")}
        </p>
      ) : null}

      {/* When no path has been given yet, the Browse tab's root view
          shows the allowed roots rather than a folder list — clicking
          one enters it. */}
      {!path && !loading ? (
        <ul
          data-testid="workspace-picker-roots-list"
          className="flex max-h-[260px] flex-col gap-px overflow-y-auto"
        >
          {(listing?.roots ?? []).map((root) => (
            <li key={root}>
              <button
                type="button"
                onClick={() => setPath(root)}
                data-testid={`workspace-picker-root-${root}`}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
              >
                <span className="flex size-5 flex-none items-center justify-center text-icon_default_secondary">
                  <Icon name="folder" size={15} />
                </span>
                <span
                  title={root}
                  className="min-w-0 flex-1 truncate font-family-code text-caption-small-strong text-text_default_primary"
                >
                  {root}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {path && visible.length > 0 ? (
        <ul
          data-testid="workspace-picker-listing"
          className="flex max-h-[260px] flex-col gap-px overflow-y-auto"
        >
          {visible.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => entry.isDir && setPath(entry.path)}
                data-testid={`workspace-picker-entry-${entry.path}`}
                data-entry-type={entry.isDir ? "dir" : "file"}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
              >
                <span className="flex size-4 flex-none items-center justify-center text-icon_default_secondary">
                  <Icon name={entry.isDir ? "folder" : "file"} size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-text_default_primary">
                  {entry.name}
                </span>
              </button>
            </li>
          ))}
          {hidden > 0 ? (
            <li
              data-testid="workspace-picker-truncated"
              className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
            >
              {t("files.showing")} {visible.length} / {matched.length}
            </li>
          ) : null}
        </ul>
      ) : null}

      {!loading && path && matched.length === 0 && !error ? (
        <p
          data-testid="workspace-picker-empty"
          className="px-1.5 py-1 text-caption-small-strong text-text_default_tertiary"
        >
          {filter
            ? t("files.noMatch")
            : t("workspace.picker.empty")}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          data-testid="workspace-picker-cancel"
          className="h-8 rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
        >
          {t("workspace.picker.cancel")}
        </button>
        <button
          type="button"
          disabled={busy || !listing?.dir}
          onClick={() => void pick()}
          data-testid="workspace-picker-confirm"
          className="h-8 rounded-lg bg-bg_interaction_primary_default px-3 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover disabled:opacity-50"
        >
          {t("workspace.picker.useWorkspace")}
        </button>
      </div>
    </div>
  );
}

// --- settings ---------------------------------------------------------------

function SettingsPanel({
  t,
  locale,
  setLocale,
  section,
  autoAddProvider,
  onAutoAddConsumed,
}: {
  t: (key: MessageKey) => string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Which category to render; undefined means a disabled (unsupported) one. */
  section?: "general" | "appearance" | "connection" | "providers";
  /** Forwarded to `ProviderManagementPanel` when `section === "providers"`. */
  autoAddProvider?: boolean;
  onAutoAddConsumed?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<api.SettingsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.getSettings());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const next = await api.postSettings(body);
        setSnapshot((current) => ({ ...(current ?? {}), ...next }));
        setNotice(t("settings.saved"));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  if (!snapshot) {
    return <p className="text-text_default_tertiary">{error ?? t("app.connecting")}</p>;
  }

  // A category with no section behind it is one this server cannot drive. Say so
  // rather than showing an empty page: the desktop has these categories, so their
  // absence would otherwise read as a bug.
  if (!section) {
    return (
      <p className="text-text_default_tertiary">{t("common.unsupported")}</p>
    );
  }

  const exposure = (
    <>
      {snapshot.lanExposureNotice ? (
        <p className="rounded-lg border border-border_default bg-bg_grouped_tertiary px-2 py-1.5 text-caption-small-strong text-text_status_warning">
          {snapshot.lanExposureNotice}
        </p>
      ) : null}
      {snapshot.bindRestartPending ? (
        <p className="text-caption-small-strong text-text_status_warning">
          {t("settings.lanBind")} — {t("settings.saved")}
        </p>
      ) : null}
    </>
  );

  const body = {
    general: (
      <>
        <Field label={t("settings.engine")}>
          <div className="break-all text-caption-small-strong text-text_default_secondary">
            {snapshot.mcodeVersion ?? "—"}
          </div>
          <div className="text-caption-small-strong text-text_default_tertiary">
            {snapshot.defaultModel ?? ""}
          </div>
        </Field>
        <Field label={t("settings.localUrl")}>
          <div className="break-all text-text_default_secondary">{snapshot.localUrl ?? "—"}</div>
        </Field>
        <Field label={t("settings.lanUrl")}>
          <div className="break-all text-text_default_secondary">{snapshot.lanUrl ?? "—"}</div>
        </Field>
      </>
    ),
    appearance: (
      /* Appearance — theme and language switches folded into settings. */
      <Field label={t("settings.appearance")}>
        <div className="flex flex-col gap-2">
          <ThemeSwitch t={t} />
          <LanguageSwitch t={t} locale={locale} setLocale={setLocale} />
        </div>
      </Field>
    ),
    connection: (
      <>
        <Field label={t("settings.security")}>
          <div className="flex flex-col gap-2">
            <Toggle
              label={t("settings.readOnly")}
              checked={snapshot.readOnly ?? false}
              disabled={busy}
              onChange={(value) => void patch({ readOnly: value })}
            />
            <Toggle
              label={t("settings.lan")}
              checked={snapshot.lanBroadcast ?? false}
              disabled={busy}
              onChange={(value) => void patch({ lanBroadcast: value })}
            />
            <Toggle
              label={t("settings.lanBind")}
              checked={snapshot.lanBind ?? false}
              disabled={busy}
              onChange={(value) => void patch({ lanBind: value })}
            />
            <Toggle
              label={t("settings.tokenEnabled")}
              checked={snapshot.tokenEnabled ?? false}
              disabled={busy}
              onChange={(value) => void patch({ tokenEnabled: value })}
            />
          </div>
        </Field>
        {exposure}
        {snapshot.currentToken ? (
          <Field label={t("settings.tokenValue")}>
            <div className="break-all font-family-code text-caption-small-strong text-text_default_secondary">
              {snapshot.currentToken}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void patch({ acknowledgeToken: true })}
              className="mt-2 h-8 self-start rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
            >
              {t("settings.ackToken")}
            </button>
          </Field>
        ) : null}
        <div className="px-3 py-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void patch({ resetToken: true })}
            className="h-8 self-start rounded-lg border border-border_default px-3 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50"
          >
            {t("settings.resetToken")}
          </button>
        </div>
      </>
    ),
    providers: (
      // The provider management panel owns its own loading / saving
      // state — wrapping it in a card here keeps the section chrome
      // consistent with the rest of SettingsPanel. The autoAdd flag
      // and its consumer callback are forwarded so the model's
      // "Add provider" deep-link can land the user mid-add.
      <ProviderManagementPanel
        t={t}
        autoAddProvider={autoAddProvider}
        onAutoAddConsumed={onAutoAddConsumed}
      />
    ),
  }[section];

  return (
    /* Upstream's section shell: a `gap-3` column of cards. */
    <div className="flex w-full flex-col gap-3">
      <section className="flex w-full flex-col gap-3">
        <div className="rounded-[16px] bg-bg_grouped_tertiary p-1">{body}</div>
      </section>

      {notice ? <p className="text-caption-small-strong text-text_status_success">{notice}</p> : null}
      {error ? <p className="text-caption-small-strong text-text_status_error">{error}</p> : null}
    </div>
  );
}

// --- alerts -----------------------------------------------------------------

function AlertsPanel({ t }: { t: (key: MessageKey) => string }) {
  // 站内信 (the inbox). The bell opens the anchored flyout (components/inbox.tsx);
  // this drawer view stays for the `alerts` panel kind and renders the same rows
  // from the same stream.
  return <InboxList t={t} />;
}

// --- shared pieces ----------------------------------------------------------

/**
 * One settings row inside a section card.
 *
 * Upstream's row component is a 14px label with the control beside or beneath it,
 * inside a card whose padding provides the inset — so the padding lives here rather
 * than on the card, which keeps a row's hit area continuous.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <span className="desktop-text-ui-body text-text_default_primary">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2">
      <span className="text-sm text-text_default_primary">{label}</span>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(value) => onChange(value)}
      />
    </label>
  );
}

/**
 * Theme picker.
 *
 * The document owns the applied theme (see lib/theme.ts), and the class on <html>
 * is not reactive state, so this reads it on mount and keeps a local mirror to
 * re-render the selected segment immediately after a write.
 */
function ThemeSwitch({ t }: { t: (key: MessageKey) => string }) {
  const [theme, setTheme] = useState<ThemeName>("light");
  useEffect(() => setTheme(currentTheme()), []);
  return (
    <Segmented
      label={t("settings.theme")}
      value={theme}
      options={[
        { id: "light", label: t("settings.themeLight") },
        { id: "dark", label: t("settings.themeDark") },
      ]}
      onChange={(id) => {
        const next = id as ThemeName;
        applyTheme(next);
        setTheme(next);
      }}
    />
  );
}

/** Language picker. Writes through the same store the rest of the UI reads. */
function LanguageSwitch({
  t,
  locale,
  setLocale,
}: {
  t: (key: MessageKey) => string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}) {
  return (
    <Segmented
      label={t("settings.language")}
      value={locale}
      options={[
        { id: "zh", label: "中文" },
        { id: "en", label: "English" },
      ]}
      onChange={(id) => setLocale(id as Locale)}
    />
  );
}

/** A labelled two-or-more-way pill switch. */
function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-text_default_primary">{label}</span>
      <AntSegmented
        className="mavis-segmented"
        // antd's options carry {label, value}; we accept {id, label} from
        // callers for backwards compatibility (see ThemeSwitch /
        // LanguageSwitch).
        options={options.map((option) => ({
          label: option.label,
          value: option.id,
        }))}
        value={value}
        onChange={(next) => onChange(String(next))}
      />
    </div>
  );
}

/**
 * Session search.
 *
 * Backed by `GET /api/sessions/search`, which scores a session title first and its
 * id second and returns the best hit per workspace (see the route). The query is
 * debounced because every keystroke would otherwise be a round trip, and the route
 * reads the session store on each call.
 */
function SearchPanel({
  onClose,
  t,
}: {
  onClose: () => void;
  t: (key: MessageKey) => string;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<api.SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<InputRef>(null);

  useEffect(() => {
    inputRef.current?.input?.focus();
  }, []);

  // Last-write-wins across in-flight searches. The cleanup only cancels the
  // debounce timer; once a request has actually been issued, an older response
  // can still land after a newer one and replace the right results with stale
  // ones. A generation counter drops the stale response. The counter is bumped
  // in the cleanup too, so a response that lands after the query changed (or
  // was cleared) is discarded rather than repopulating an empty box.
  const searchGen = useRef(0);
  useEffect(() => {
    const gen = ++searchGen.current;
    const trimmed = query.trim();
    if (trimmed === "") {
      setHits([]);
      setSearched(false);
      return;
    }
    const handle = window.setTimeout(() => {
      setBusy(true);
      setError(null);
      void api
        .searchSessions(trimmed)
        .then((payload) => {
          if (gen !== searchGen.current) return;
          setHits(payload.results ?? []);
          setSearched(true);
        })
        .catch((cause) => {
          if (gen !== searchGen.current) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (gen === searchGen.current) setBusy(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(handle);
      searchGen.current += 1;
    };
  }, [query]);

  return (
    <div className="flex flex-col gap-3">
      <AntInput
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("search.placeholder")}
        className="mavis-input"
      />

      {busy ? <span className="text-caption-small-strong text-text_default_tertiary">…</span> : null}
      {searched && hits.length === 0 && !busy ? (
        <span className="text-text_default_tertiary">{t("search.empty")}</span>
      ) : null}
      {hits.length > 0 ? (
        <span className="text-caption-small-strong text-text_default_tertiary">
          {t("search.results").replace("%n", String(hits.length))}
        </span>
      ) : null}

      <div className="flex flex-col gap-0.5">
        {hits.map((hit) => (
          <button
            key={hit.id}
            type="button"
            title={hit.workspace}
            onClick={() => {
              void api.switchSession(hit.id).finally(onClose);
            }}
            className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            <span className="min-w-0 truncate text-sm text-text_default_primary">
              {hit.title || t("sidebar.untitled")}
            </span>
            <span className="min-w-0 truncate text-caption-small-strong text-text_default_tertiary">
              {hit.workspace.split("/").filter(Boolean).pop() ?? hit.workspace}
            </span>
          </button>
        ))}
      </div>

      {error ? <p className="text-caption-small-strong text-text_status_error">{error}</p> : null}
    </div>
  );
}
