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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Locale, MessageKey } from "@/lib/i18n";
import { Icon, type IconName } from "./icons";
import { FilesPanel, GitPanel } from "./panels";
import { PluginsSurface } from "./plugins-surface";
import { WorkspaceTabsTasks } from "./workspace-tabs-tasks";
import {
  columnRoleForKind,
  type SurfaceTabKind,
  type WorkspaceTab,
} from "@/lib/workspace-tabs-state";
import * as api from "@/lib/api";
import { searchFootSegments } from "@/lib/fs-search";
import { useFsTreeReveal, FsTreeRevealProvider } from "@/lib/fs-tree-reveal";
import { useSessionContext } from "@/lib/store";

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
  // Wrap the column body in the reveal provider so the sidebar
  // 搜索 surface and the file-tree panel share the cross-surface
  // expand-to-hit channel. Single instance per column; harmless
  // to nest, but unnecessary.
  return (
    <FsTreeRevealProvider>
      <TreeColumnInner {...props} />
    </FsTreeRevealProvider>
  );
}

function TreeColumnInner(props: TreeColumnProps) {
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

  // Close the active surface. The page's `applyTabs` wrapper
  // (see app/page.tsx) syncs `collapsed.tree` in the same React
  // batch as the tab reducer, so closing the last tree surface
  // collapses the column with no visual seam. Discard semantics
  // by surface:
  //   - files: expanded paths + filter live in sessionStorage
  //     keyed by workspace dir (slice 01), NOT in this tab; the
  //     user's expand state survives the close and returns when
  //     the user re-opens Files.
  //   - search: query + server result live in `SearchSurface`'s
  //     local state; closing unmounts the component and
  //     discards the query. The aria-label announces this so
  //     screen-reader users are warned before they act.
  //   - git / tasks / plugins: read-only views of session-wide
  //     data; closing just hides the surface.
  // All branches are silent discards — none of the surfaces
  // hold user-authored content that warrants a confirm prompt,
  // but the close affordance is always keyboard-reachable and
  // announces the consequence via aria-label.
  const onCloseActive = useCallback(() => {
    if (!activeTab) return;
    props.onClose(activeTab.id);
  }, [activeTab, props]);
  const closeAria =
    activeKind === "search"
      ? t("workspaceTabs.tree.close.search.aria")
      : t("workspaceTabs.tree.close.aria");

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col gap-2"
      data-testid="tree-column"
      data-has-tabs={hasTabs ? "true" : "false"}
      data-active={activeKind ?? "none"}
    >
      {/* Top bar — surface selector + close button. The close
          button is the user-visible counterpart to slice 21's
          `applyTabs` wrapper: it closes the active surface tab
          and the column auto-collapses when the last one closes. */}
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
          {activeTab ? (
            <button
              type="button"
              onClick={onCloseActive}
              // `aria-label` is the only announcement of the
              // consequence. The close button itself uses the
              // generic "close" icon (an `✕`); a screen reader
              // reading just the role + icon would say
              // "button close", which says nothing. The full
              // label says "close the active surface and hide
              // the navigation column" — and the
              // search-specific override adds "discard the
              // current query" so the warning lands before the
              // user commits the gesture.
              aria-label={closeAria}
              title={closeAria}
              data-testid="tree-column-close"
              data-surface={activeKind ?? "none"}
              className="flex size-6 flex-shrink-0 items-center justify-center rounded-[6px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border_accent"
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
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
          <SearchSurface
            t={t}
            locale={locale}
            onOpenFile={props.onOpenFile}
            onPickSurface={onPickSurface}
          />
        ) : activeTab && activeKind === "plugins" ? (
          <PluginsSurfacePanel t={t} />
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
 * The search surface (column 4, "search" tab). Slice 19b wires
 * this to the same `/api/fs/search` endpoint the file-tree's
 * filter box uses (slice 19a). The two surfaces share the same
 * debounce + cancel + footer pattern so the sidebar 搜索 entry is
 * a first-class surface rather than the slice-17 placeholder.
 *
 * Clicking a result calls `onOpenFile(path)` (page wires this to
 * `openFileTab`) and `onPickSurface("files")` (page wires this to
 * switch the active surface) so the user lands inside the file
 * tree with the match highlighted via the panel's expand-to-hit
 * effect.
 */
function SearchSurface({
  t,
  locale: _locale,
  onOpenFile,
  onPickSurface,
}: {
  t: (key: MessageKey) => string;
  locale: Locale;
  /** Forwarded so a click reveals the match in the file tree. */
  onOpenFile: (path: string) => void;
  /** Used to switch the active surface to "files" once a result is
   *  clicked, so the user sees the expanded tree with the hit. */
  onPickSurface: (kind: SurfaceTabKind) => void;
}) {
  void _locale;
  const { state } = useSessionContext();
  const workspaceDir = state?.workspace.dir ?? "";

  const [query, setQuery] = useState("");
  const [serverSearch, setServerSearch] = useState<{
    result: api.FsSearchResult | null;
    loading: boolean;
    error: string | null;
  }>({ result: null, loading: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !workspaceDir) {
      abortRef.current?.abort();
      abortRef.current = null;
      genRef.current = -1;
      setServerSearch({ result: null, loading: false, error: null });
      return;
    }
    // 200ms debounce — same as the file-tree filter, so the two
    // surfaces feel consistent for a fast typist.
    const handle = window.setTimeout(() => {
      const gen = ++genRef.current;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setServerSearch((prev) => ({ ...prev, loading: true, error: null }));
      void api
        .searchFs(workspaceDir, trimmed, { signal: controller.signal })
        .then((result) => {
          if (gen !== genRef.current) return;
          setServerSearch({ result, loading: false, error: null });
        })
        .catch((cause) => {
          if (gen !== genRef.current) return;
          if (cause instanceof Error && cause.name === "AbortError") return;
          setServerSearch({
            result: null,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query, workspaceDir]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Slice 19b follow-up — sidebar click reveals the match in the
  // file tree. We use the shared `fs-tree-reveal` channel so the
  // tree panel applies the same expand-to-hit + highlight it
  // already uses for its own server search. Order matters: we
  // request the reveal BEFORE switching surface, so when the
  // files surface mounts it can immediately consume the request
  // (the channel is fire-and-forget — if no subscriber is mounted
  // yet the request is dropped, which is fine because the user is
  // moving to the surface that owns the panel). The reveal channel
  // keeps the latest `serverSearch.result` accessible via a ref
  // so the click handler does not need to close over the result.
  const latestResultRef = useRef(serverSearch.result);
  latestResultRef.current = serverSearch.result;
  const { requestReveal } = useFsTreeReveal();
  const onPickMatch = useCallback(
    (path: string) => {
      // Find the match in the most recent result so the panel can
      // expand-to-hit using the same `ancestors` chain the in-panel
      // search uses. If the panel subscriber is not mounted yet
      // (we are still on the search surface), the request is
      // dropped — switching to files surface is what activates
      // the panel.
      const result = latestResultRef.current;
      const match = result?.matches.find((m) => m.path === path);
      if (match && workspaceDir) {
        requestReveal({ matches: [match], root: workspaceDir });
      }
      onOpenFile(path);
      onPickSurface("files");
    },
    [onOpenFile, onPickSurface, requestReveal, workspaceDir],
  );

  const footerSegments = useMemo(
    () =>
      searchFootSegments(serverSearch.result, {
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
        formatElapsed: (ms) =>
          t("files.search.footer.elapsedValue").replace("{ms}", String(ms)),
      }),
    [serverSearch.result, t],
  );

  const matches = serverSearch.result?.matches ?? [];

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
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="tree-surface-search-input"
          placeholder={t("workspaceTabs.search.placeholder")}
          aria-label={t("workspaceTabs.search.placeholder")}
          className="min-w-0 flex-1 bg-transparent text-sm text-text_default_primary placeholder:text-text_default_tertiary focus:outline-none"
        />
        {serverSearch.loading ? (
          <span
            data-testid="tree-surface-search-loading"
            className="text-caption-small-strong text-text_default_tertiary"
          >
            {t("files.search.loading")}
          </span>
        ) : null}
      </div>
      <p
        data-testid="tree-surface-search-tip"
        className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5 text-caption-small-strong text-text_default_tertiary"
      >
        {query.trim()
          ? t("workspaceTabs.search.tipExhaustive")
          : t("workspaceTabs.search.tip")}
      </p>
      {serverSearch.error ? (
        <p
          data-testid="tree-surface-search-error"
          className="text-caption-small-strong text-text_status_error"
        >
          {t("files.search.error").replace("{{error}}", serverSearch.error)}
        </p>
      ) : null}
      {serverSearch.result && matches.length === 0 && !serverSearch.loading ? (
        <p
          data-testid="tree-surface-search-empty"
          className="rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-2 text-caption-small-strong text-text_default_tertiary"
        >
          {t("workspaceTabs.search.empty")}
        </p>
      ) : null}
      {matches.length > 0 ? (
        <ul
          data-testid="tree-surface-search-results"
          className="flex flex-col gap-px"
        >
          {matches.map((match) => {
            const isCredential = !!match.credential;
            return (
              <li key={match.path}>
                <button
                  type="button"
                  onClick={() => onPickMatch(match.path)}
                  data-testid={`tree-surface-search-hit-${match.path}`}
                  data-credential={isCredential ? "true" : "false"}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-bg_interaction_tertiary_hover"
                >
                  <Icon
                    name={match.type === "dir" ? "folder" : "file"}
                    size={12}
                    className="flex-shrink-0 text-icon_default_secondary"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-text_default_primary">
                    {match.name}
                  </span>
                  <span className="min-w-0 flex-shrink truncate text-caption-small-strong text-text_default_tertiary">
                    {match.ancestors.length > 0
                      ? `…/${match.ancestors.slice(-2).join("/")}/`
                      : ""}
                  </span>
                  {isCredential ? (
                    <span
                      data-testid={`tree-surface-search-hit-credential-${match.path}`}
                      className="flex-shrink-0 rounded bg-bg_grouped_tertiary px-1 py-0.5 text-caption-small-strong text-text_status_warning"
                    >
                      {t("files.search.credential")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {footerSegments.length > 0 ? (
        <p
          data-testid="tree-surface-search-footer"
          data-truncated={serverSearch.result?.truncated ? "true" : "false"}
          className="flex flex-wrap gap-x-1 gap-y-0.5 px-1 py-1 text-caption-small-strong text-text_default_tertiary"
        >
          {footerSegments.map((segment, index) => (
            <span
              key={`${segment.kind}:${index}`}
              data-testid={`tree-surface-search-footer-${segment.kind}`}
            >
              {segment.text}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The plugins surface (column 4, "plugins" tab).
 *
 * Since ticket 60 phase 1 this is a forwarding shell: the five capability
 * areas live in `plugins-surface.tsx`, which the suite renders directly.
 * The wrapper keeps the two attributes the column body is selected by —
 * `data-testid="tree-surface-body-plugins"` and `data-active-surface` —
 * and the local name avoids colliding with the imported component.
 *
 * The two placeholder-copy testids that used to sit here
 * (`tree-surface-plugins-title` / `-body`) went with the placeholder they
 * named: that copy is gone by design, and a testid whose only content was
 * the retired sentence would outlive the thing it described.
 */
function PluginsSurfacePanel({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto px-3 py-3"
      data-testid="tree-surface-body-plugins"
      data-active-surface="plugins"
    >
      <PluginsSurface t={t} />
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