"use client";

/**
 * Tree column (slice 17).
 *
 * Renders the right-most **tree** column of the four-column
 * shell. Mental model: this column is **the navigation /
 * listing surface** — file tree, git, tasks.
 *
 * Layout (matches the desktop reference at
 * `refs/ui/02-workspace-shell.jpg`, right column):
 *
 *   ┌─────────────────────────────────────────┐
 *   │ [搜索]   [view-mode toolbar]   [files▾] │  ← Top bar
 *   ├─────────────────────────────────────────┤
 *   │ ▼ src                                   │
 *   │ │  file-a.md                            │
 *   │ │  file-b.md                            │
 *   │ ▼ docs                                  │
 *   │   …                                     │
 *   └─────────────────────────────────────────┘
 *
 * The top bar holds:
 *
 *   - **Search box** — the file-tree filter (slice 01 contract)
 *   - **View-mode toolbar** — refresh / show-hidden / collapse-
 *     all (the slice-01 FilesPanel affordances, surfaced at the
 *     top of the column so the tree feels like a tool, not a
 *     passive panel)
 *   - **Surface selector** — a segmented control with
 *     Files / Changes / Tasks (the three tree surfaces). The
 *     active one is shown in the column body below.
 *
 * The surface selector renders only surfaces that have been
 * "opened" — opening happens through the toolbar buttons
 * (Files / Changes / Browser) which dispatch through the page's
 * reducer. When a surface tab is opened for the first time the
 * selector appears and the column body shows it.
 */

import { useCallback } from "react";

import type { Locale, MessageKey } from "@/lib/i18n";
import { Icon, type IconName } from "./icons";
import { FilesPanel, GitPanel } from "./panels";
import { WorkspaceTabsTasks } from "./workspace-tabs-tasks";
import {
  columnRoleForKind,
  type SurfaceTabKind,
  type WorkspaceTab,
} from "@/lib/workspace-tabs-state";

/**
 * The five surfaces the tree column hosts. The selector pill
 * grid renders every kind the column CAN host; the body renders
 * the active one. Adding a new tree surface means adding to this
 * array AND wiring the body in `TreeColumn`'s render.
 */
const TREE_SURFACES: ReadonlyArray<SurfaceTabKind> = [
  "files",
  "git",
  "tasks",
  "search",
  "plugins",
];

export interface TreeColumnProps {
  /** All tabs in the workspace; the column filters to the
   *  tree-role subset (files / git / tasks). */
  tabs: WorkspaceTab[];
  /** Tree column's active tab id. */
  treeActiveId: string | null;
  workspaceDir: string;
  locale: Locale;
  t: (key: MessageKey) => string;
  /** Called when the user picks a different tree surface in the
   *  selector. The page wires this to `openTab(state, surfaceTab(kind))`
   *  which sets `treeActiveId` to the matching tab id. */
  onPickSurface: (kind: SurfaceTabKind) => void;
  /** Called when the user clicks the close button on a tree tab. */
  onClose: (id: string) => void;
  /** Called when the user clicks a non-HTML file row. Wired by
   *  the page to `openFileTab(path)` so a click opens a preview
   *  tab in the preview column. Slice 17 — this is the path the
   *  reference flow uses ("click `README.md` in the tree →
   *  preview opens"); the no-op wiring here would sever it. */
  onOpenFile: (path: string) => void;
  /** Called when the user clicks an `.html` / `.htm` row. Wired
   *  by the page to `openBrowserTab(path)` so a click opens a
   *  browser tab in the preview column. */
  onOpenInBrowser: (path: string) => void;
}

/**
 * The render-only tree-column widget.
 *
 * Two visual modes:
 *   - Tree tabs exist   → top bar (search + toolbar + selector) +
 *                          the active tree surface (files / git / tasks)
 *   - No tree tabs yet  → top bar + an inline empty state hinting
 *                          that the user can pick a surface; the
 *                          default opening through the page's
 *                          openTab reducer will activate the first
 *                          tree surface (files) and the column
 *                          will render the file tree.
 */
export function TreeColumn(props: TreeColumnProps) {
  const { tabs, treeActiveId, workspaceDir, locale, t, onPickSurface } = props;
  const treeTabs = tabs.filter((tab) => columnRoleForKind(tab.kind) === "tree");
  const activeTab = treeTabs.find((tab) => tab.id === treeActiveId) ?? null;
  const activeKind: SurfaceTabKind | null = activeTab
    ? activeTab.kind === "file"
      ? null
      : (activeTab.kind as SurfaceTabKind)
    : null;
  const hasTabs = treeTabs.length > 0;

  const onSelector = useCallback(
    (kind: SurfaceTabKind) => () => {
      onPickSurface(kind);
    },
    [onPickSurface],
  );

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col gap-2"
      data-testid="tree-column"
      data-has-tabs={hasTabs ? "true" : "false"}
      data-active={activeKind ?? "none"}
    >
      {/* Top bar — search box + view-mode toolbar + surface selector */}
      <header
        className="flex min-h-0 flex-shrink-0 flex-col gap-1"
        data-testid="tree-column-topbar"
      >
        <div className="flex items-center gap-1">
          <SurfaceSelector
            activeKind={activeKind}
            visibleSurfaces={treeTabs.map((tab) => tab.kind as SurfaceTabKind)}
            onPick={onPickSurface}
            t={t}
          />
        </div>
        {activeKind === "files" ? (
          <FileTreeToolbar t={t} />
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab && activeKind === "files" ? (
          <FilesPanel
            t={t}
            locale={locale}
            // The tree column owns the file tree. The page-level
            // callbacks route file rows through `openFileTab` /
            // `openBrowserTab`, which open a preview tab (or
            // browser tab) in the preview column. Slice 17 wired
            // these back in after a regression that left them as
            // no-ops and severed the click-a-file-to-preview-it
            // reference flow.
            onOpenFile={props.onOpenFile}
            onOpenInBrowser={props.onOpenInBrowser}
          />
        ) : activeTab && activeKind === "git" ? (
          <GitPanel t={t} />
        ) : activeTab && activeKind === "tasks" ? (
          <WorkspaceTabsTasks t={t} locale={locale} />
        ) : activeTab && activeKind === "search" ? (
          <SearchSurface t={t} locale={locale} />
        ) : activeTab && activeKind === "plugins" ? (
          <PluginsSurface t={t} />
        ) : (
          <EmptyHint t={t} onPickSurface={onSelector} />
        )}
      </div>
    </aside>
  );
}

function SurfaceSelector({
  activeKind,
  visibleSurfaces,
  onPick,
  t,
}: {
  activeKind: SurfaceTabKind | null;
  /** The set of surfaces the user has explicitly opened — every
   *  selector pill renders for every surface the user has
   *  visited, not just the active one, so re-picking a surface
   *  after closing it never disappears. */
  visibleSurfaces: SurfaceTabKind[];
  onPick: (kind: SurfaceTabKind) => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-px rounded-[8px] bg-bg_grouped_secondary_elevated p-0.5"
      role="tablist"
      aria-label={t("workspaceTabs.tree.selector.aria")}
      data-testid="tree-column-selector"
    >
      {TREE_SURFACES.map((kind) => {
        const isActive = activeKind === kind;
        const label = surfaceLabel(t, kind);
        const aria = surfaceAria(t, kind);
        const icon = surfaceIcon(kind);
        return (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={aria}
            title={label}
            onClick={() => onPick(kind)}
            data-testid={`tree-surface-${kind}`}
            data-active={isActive ? "true" : "false"}
            data-visible={visibleSurfaces.includes(kind) ? "true" : "false"}
            className={[
              "flex h-6 flex-1 items-center justify-center gap-1 rounded-[6px] px-2 text-caption-small-strong transition-colors",
              isActive
                ? "bg-bg_default_scrim text-text_default_primary shadow-[0_1px_0_rgba(0,0,0,0.04)]"
                : "text-text_default_secondary hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary",
            ].join(" ")}
          >
            <Icon name={icon} size={12} />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function surfaceLabel(t: (key: MessageKey) => string, kind: SurfaceTabKind): string {
  switch (kind) {
    case "files":
      return t("workspaceTabs.tab.files");
    case "git":
      return t("workspaceTabs.tab.git");
    case "tasks":
      return t("workspaceTabs.tab.tasks");
    case "browser":
      return t("workspaceTabs.tab.browser");
    case "search":
      return t("workspaceTabs.tab.search");
    case "plugins":
      return t("workspaceTabs.tab.plugins");
  }
}

function surfaceAria(t: (key: MessageKey) => string, kind: SurfaceTabKind): string {
  switch (kind) {
    case "files":
      return t("workspaceTabs.tree.selector.files.aria");
    case "git":
      return t("workspaceTabs.tree.selector.git.aria");
    case "tasks":
      return t("workspaceTabs.tree.selector.tasks.aria");
    case "search":
      return t("workspaceTabs.tree.selector.search.aria");
    case "plugins":
      return t("workspaceTabs.tree.selector.plugins.aria");
    // browser lives in the preview column, never rendered as a
    // tree selector pill — but the type is exhaustive so we
    // fall back to its preview-column aria label.
    case "browser":
      return t("workspaceTabs.tab.browser.aria");
  }
}

function surfaceIcon(kind: SurfaceTabKind): IconName {
  switch (kind) {
    case "files":
      return "folder";
    case "git":
      return "git";
    case "tasks":
      return "workspace";
    case "search":
      return "search";
    case "plugins":
      return "plugins";
    // browser lives in the preview column, never rendered as a
    // tree selector pill — fallback to the preview icon.
    case "browser":
      return "browserGlobe";
  }
}

/**
 * The search surface (column 4, "search" tab). Slice 17 ships a
 * placeholder: a centred input box with a results region. The
 * search backend wire-up is out of scope for this slice — the
 * sidebar's 搜索 entry is now a no-network landing surface, not a
 * silent no-op. A future slice can wire `/api/...` behind the
 * submit handler.
 */
function SearchSurface({
  t,
  locale: _locale,
}: {
  t: (key: MessageKey) => string;
  locale: Locale;
}) {
  void _locale;
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2 px-2 py-2"
      data-testid="tree-surface-body-search"
      data-active-surface="search"
    >
      <div className="flex items-center gap-1 rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1">
        <Icon name="search" size={12} />
        <input
          type="search"
          data-testid="tree-surface-search-input"
          placeholder={t("workspaceTabs.search.placeholder")}
          aria-label={t("workspaceTabs.search.placeholder")}
          className="min-w-0 flex-1 bg-transparent text-sm text-text_default_primary placeholder:text-text_default_tertiary focus:outline-none"
        />
      </div>
      <p
        data-testid="tree-surface-search-empty"
        className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-2 text-caption-small-strong text-text_default_tertiary"
      >
        {t("workspaceTabs.search.empty")}
      </p>
    </div>
  );
}

/**
 * The plugins surface (column 4, "plugins" tab). The plugin
 * marketplace is a placeholder — the engine has not yet exposed
 * the plugin-install contract — so the surface renders a
 * centred "this is coming" card with the i18n explanation.
 * The card is mounted AND labelled so a click on the sidebar's
 * 插件 entry visibly produces a surface rather than silently
 * no-op'ing.
 */
function PluginsSurface({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-text_default_secondary"
      data-testid="tree-surface-body-plugins"
      data-active-surface="plugins"
    >
      <span
        className="flex size-10 items-center justify-center rounded-full bg-bg_grouped_secondary_elevated text-icon_default_tertiary"
        aria-hidden
      >
        <Icon name="plugins" size={18} />
      </span>
      <h2
        data-testid="tree-surface-plugins-title"
        className="desktop-text-dialog-medium text-base font-medium leading-6 text-text_default_primary"
      >
        {t("workspaceTabs.plugins.title")}
      </h2>
      <p
        data-testid="tree-surface-plugins-body"
        className="max-w-[260px] text-caption-small-strong text-text_default_tertiary"
      >
        {t("workspaceTabs.plugins.placeholder")}
      </p>
    </div>
  );
}

/**
 * The view-mode toolbar that lives at the top of the tree column
 * when the file tree is the active surface. The slice-01 FilesPanel
 * already owns its own toolbar inside the tree itself — this
 * widget mirrors the desktop reference's "view-mode toolbar"
 * (refresh + show-hidden + collapse-all), and dispatches the
 * equivalent actions through the FilesPanel's own callbacks.
 *
 * Out of scope for slice 17: a future slice can wire the
 * dedicated buttons to the FilesPanel state. For now this row is
 * reserved real estate so the layout matches the reference.
 */
function FileTreeToolbar({ t: _t }: { t: (key: MessageKey) => string }) {
  return (
    <div
      className="flex items-center gap-1"
      data-testid="tree-column-toolbar"
      aria-hidden
    >
      {/* The view-mode toolbar is reserved real estate per the
          desktop reference (the four small icons in the top
          right of the tree column). Slice 17 keeps the slot
          visible so the layout matches the reference; a future
          ticket can wire the buttons to FilesPanel state. */}
    </div>
  );
}

function EmptyHint({
  t,
  onPickSurface,
}: {
  t: (key: MessageKey) => string;
  onPickSurface: (kind: SurfaceTabKind) => () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-text_default_secondary">
      <span
        className="flex size-10 items-center justify-center rounded-full bg-bg_grouped_secondary_elevated text-icon_default_tertiary"
        aria-hidden
      >
        <Icon name="folder" size={18} />
      </span>
      <p
        data-testid="tree-column-empty"
        className="max-w-[260px] text-caption-small-strong text-text_default_tertiary"
      >
        {t("workspaceTabs.tree.empty")}
      </p>
      <div className="flex flex-col gap-1">
        {TREE_SURFACES.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={onPickSurface(kind)}
            data-testid={`tree-column-empty-pick-${kind}`}
            className="flex h-7 items-center gap-2 rounded-[8px] px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            <Icon name={surfaceIcon(kind)} size={12} />
            <span>{surfaceLabel(t, kind)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}