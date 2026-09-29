"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/lib/api";
import { Chat, HomeState } from "@/components/chat";
import { Composer } from "@/components/composer";
import { TranscriptSkeleton } from "@/components/loading-states";
import { Modals } from "@/components/modals";
import { ActionErrorBanner } from "@/components/action-error-banner";
// Settings modal port (webui-parity 58): the reference SettingsModal
// structure; the shim keeps this import shape unchanged.
import { SettingsModal } from "@/components/settings-modal-port";
import { AppShell } from "@/components/shell";
import { ConversationToolbar, useAlertCount } from "@/components/toolbar";
import { WorkspaceColumns } from "@/components/workspace-columns";
import { PreviewColumn, PreviewColumnMounted } from "@/components/workspace-tabs";
import { TreeColumn } from "@/components/workspace-tree-column";
import { runAction } from "@/lib/action-errors";
import { SessionProvider, useSessionContext } from "@/lib/store";
import { decodeTranscript } from "@/lib/transcript";
import { useLocale } from "@/lib/use-locale";
import {
  DEFAULT_UI_STATE,
  DEFAULT_WORKSPACE_TABS_STATE,
  readScrollPosition,
  readUiState,
  readWorkspaceTabs,
  writeScrollPosition,
  writeUiState,
  writeWorkspaceTabs,
  type UiState,
} from "@/lib/persist";
import {
  applySessionRestore,
  dropSessionFromUrl,
  parseSessionFromUrl,
  writeSessionToUrl,
  type SessionRestoreOutcome,
} from "@/lib/url-restore";
import { openFileInWeb, closeOpenFile } from "@/lib/open-file";
import { readFileOpenInNewTab } from "@/lib/settings-local";
import {
  closeTab,
  openTab,
  recordFileTabScroll,
  resetColumnWidth,
  setColumnCollapsed,
  setColumnWidth,
  setLauncherOpen,
  activateTab,
  DEFAULT_COLUMN_LAYOUT,
  fileTabFromPath,
  surfaceTab,
  syncColumnVisibility,
  type ColumnId,
  type SurfaceTabKind,
  type TabStripState,
  type WorkspaceTabsState,
} from "@/lib/workspace-tabs-state";
import { isHtmlPath } from "@/lib/browser-nav";

/**
 * The application root.
 *
 * `SessionProvider` owns the single SSE subscription; the shell, the toolbar, the
 * transcript and the panels all read the same snapshot from context, so no
 * component opens its own connection.
 */
export default function Page() {
  return (
    <SessionProvider>
      <App />
    </SessionProvider>
  );
}

function App() {
  const { locale, setLocale, t } = useLocale();
  const { state, connected, error } = useSessionContext();
  // Webui-parity 07 — restore UI state synchronously from localStorage
  // BEFORE the first paint, so a refresh on /?session=A lands on the
  // same right-panel / sidebar collapsed choice the user previously
  // had open rather than flashing the default first.
  const [persisted] = useState<UiState>(() => readUiState());
  // Slice 17 — restore the workspace-tabs payload (open tabs +
  // per-column active ids + column widths + collapsed flags) the
  // same way. The first paint already knows whether the preview /
  // tree columns should be open and which tabs are inside them, so
  // a refresh on the new shell does not flash the empty launcher
  // before restoring the saved tabs.
  const [workspaceTabs] = useState<WorkspaceTabsState>(() => readWorkspaceTabs());
  // The legacy `panel` mirror is still kept around so the
  // toolbar's existing "active panel" highlight survives the
  // refactor without a fresh state mirror — slice 17 keeps the
  // toolbar / panel highlight working through the new tab strip
  // system (the active tab's kind is the toolbar highlight).
  const [panel, setPanel] = useState<typeof persisted.panel>(persisted.panel);
  // Settings is a dialog rather than a drawer panel, so it has its own state.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "connection" | "providers">("general");
  const [pendingProviderAdd, setPendingProviderAdd] = useState(false);
  const [browserPath, setBrowserPath] = useState<string | null>(null);
  const [sessionHint, setSessionHint] = useState<{ kind: "not-found"; sessionId: string } | null>(null);
  const alertCount = useAlertCount();

  // Workspace tabs live-state (slice 17). The `useState` initializer
  // seeds from the persisted payload; subsequent edits mutate via
  // the pure reducers and the effect below mirrors them back into
  // `lib/persist.ts` storage.
  const [tabState, setTabState] = useState<TabStripState>(workspaceTabs.tabStrip);
  const [columnState, setColumnState] = useState<typeof DEFAULT_COLUMN_LAYOUT>(workspaceTabs.columnLayout);
  // Slice 17 — WorkspaceColumns self-measures via
  // ResizeObserver, so the page does not need to feed
  // containerWidth anymore. viewportWidth is still threaded
  // through for the future auto-collapse ladder; today it is
  // accepted but unused inside computeColumnLayout.
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;

  // Mirror panel changes into localStorage. The write helper is
  // debounced; mounting/de-mounting the panel quickly during a
  // refresh never floods storage.
  useEffect(() => {
    writeUiState({
      ...DEFAULT_UI_STATE,
      ...persisted,
      panel,
    });
    // intentionally not adding `persisted` to deps — the persist
    // module already guards the debounced write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  // Slice 17 — mirror workspace-tabs state into localStorage. The
  // debounced writer coalesces open + activate + scroll edits into
  // one write.
  useEffect(() => {
    writeWorkspaceTabs({ tabStrip: tabState, columnLayout: columnState });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabState, columnState]);

  // ============================================================
  // Workspace tabs reducers (the page wires every action through
  // these helpers; the panel component stays a pure renderer)
  // ============================================================

  /**
   * Open a surface tab. The reducer routes the tab to the right
   * column by role: files / git / tasks land in the tree column,
   * browser lands in the preview column. If a tab of the same
   * kind is already open, it is activated instead of duplicated.
   */
  /**
   * Slice 21 — apply a tab reducer and synchronously mirror the
   * column visibility. Every reducer that touches the tab strip
   * goes through this helper so the preview / tree columns
   * appear and disappear in the same React batch as the tab
   * change. The sync is idempotent — reducers that do not add or
   * remove tabs (e.g. `activateTab`, `recordFileTabScroll`,
   * `setLauncherOpen`) hit `syncColumnVisibility` with the same
   * tabs and get back the same layout, so they do not bounce
   * through a no-op state update.
   */
  const applyTabs = useCallback(
    (updater: (state: TabStripState) => TabStripState) => {
      setTabState((current) => {
        const nextTabs = updater(current);
        setColumnState((currentLayout) => syncColumnVisibility(nextTabs, currentLayout));
        return nextTabs;
      });
    },
    [],
  );

  const openSurfaceTab = useCallback((kind: SurfaceTabKind) => {
    applyTabs((current) => openTab(current, surfaceTab(kind)));
  }, [applyTabs]);

  /**
   * Open a file tab in the preview column. If a tab for the same
   * path is already open, just activate it. Also calls
   `openFileInWeb` so any legacy subscriber (the FilesPanel
   preview pane) stays in sync.
   *
   * Ticket 48 (`file_open_in_new_tab`, default ON): when the switch
   * is off, opening a different file REPLACES the active file tab
   * rather than adding one — the webui analogue of the desktop's
   * "reuse the unpinned tab". The strip has no pinned-tab concept
   * (see `lib/workspace-tabs-state.ts`), so the active file tab is
   * the reuse target; when no file tab exists the open-a-new-tab
   * path applies. The default stays ON so existing users keep the
   * one-tab-per-file behaviour this strip has always had.
   */
  const openFileTab = useCallback((path: string) => {
    if (!path) return;
    const reuseActiveTab = !readFileOpenInNewTab();
    applyTabs((current) => {
      const existing = current.tabs.find(
        (tab) => tab.kind === "file" && tab.path === path,
      );
      if (existing) {
        return openTab(current, existing);
      }
      if (reuseActiveTab && current.previewActiveId) {
        const active = current.tabs.find(
          (tab) => tab.id === current.previewActiveId,
        );
        if (active?.kind === "file") {
          const replacement = fileTabFromPath(path, 0);
          return {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === active.id ? replacement : tab,
            ),
            previewActiveId: replacement.id,
            launcherOpen: false,
          };
        }
      }
      return openTab(current, fileTabFromPath(path, 0));
    });
    // Publish through the slice-12 channel — the FilesPanel's
    // embedded preview pane is still subscribed, so this keeps
    // its empty-state copy consistent.
    openFileInWeb(path);
  }, [applyTabs]);

  /**
   * Open a browser tab in the preview column + set the browser
   * path. Used by both the file tree (HTML rows) and any future
   * "open in browser" link.
   */
  const openBrowserTab = useCallback((path: string) => {
    if (!path) return;
    setBrowserPath(path);
    applyTabs((current) => openTab(current, surfaceTab("browser")));
  }, [applyTabs]);

  /**
   * Close a tab by id. The reducer handles per-column active
   * promotion. The legacy `panel` mirror reflects the active
   * preview surface so the toolbar highlight stays correct.
   */
  const closeOneTab = useCallback((id: string) => {
    applyTabs((current) => {
      const next = closeTab(current, id);
      const closingFile = current.tabs.find((tab) => tab.id === id);
      if (closingFile && closingFile.kind === "file" && !next.tabs.some((tab) => tab.kind === "file")) {
        closeOpenFile();
      }
      return next;
    });
  }, [applyTabs]);

  /**
   * Toggle the launcher popover. Pure flag toggle.
   */
  const toggleLauncher = useCallback(() => {
    applyTabs((current) => setLauncherOpen(current, !current.launcherOpen));
  }, [applyTabs]);

  /**
   * Reset a column width to its default.
   */
  const resetOneColumnWidth = useCallback((column: ColumnId) => {
    setColumnState((current) => resetColumnWidth(current, column));
  }, []);

  /**
   * Record a file tab's scroll position.
   */
  const recordFileScroll = useCallback((id: string, scrollTop: number) => {
    applyTabs((current) => recordFileTabScroll(current, id, scrollTop));
  }, [applyTabs]);

  /**
   * Switch the active preview tab by id (no-op if unknown).
   */
  const switchPreviewTab = useCallback((id: string) => {
    applyTabs((current) => activateTab(current, id));
  }, [applyTabs]);

  /**
   * Switch the active tree tab by id (no-op if unknown).
   */
  const switchTreeTab = useCallback((id: string) => {
    applyTabs((current) => activateTab(current, id));
  }, [applyTabs]);

  /**
   * Collapse / expand a column. The preview and tree columns
   * are the foldable ones per the user's priority (chrome
   * sidebar is owned by AppShell; chat column never folds).
   */
  const toggleColumnCollapsed = useCallback((column: ColumnId) => {
    setColumnState((current) => setColumnCollapsed(current, column, !current.collapsed[column]));
  }, []);

  // ============================================================
  // Backward-compat layer
  //
  // The toolbar's existing launchers (workspace, files, git,
  // browser) call `openPanel(kind)`. To keep the buttons alive
  // without re-architecting the toolbar, that callback now fans
  // out into the workspace-tabs system: workspace / files /
  // git open a tree tab, browser opens a preview tab. Slice 17
  // also restores the sidebar's legacy 搜索 / 插件 entries —
  // both classify as tree surfaces (see SurfaceTabKind in
  // workspace-tabs-state.ts and the SearchSurface / PluginsSurface
  // bodies in workspace-tree-column.tsx) so the column renders a
  // visible landing surface, not a silent no-op.
  //
  // Out of scope for slice 17 (filed as follow-ups in the report):
  //   - `progress` — has no entry point in the UI today
  //   - `alerts` — handled by the sidebar's 站内信 bell flyout
  //     (AppShell owns it; `openPanel("alerts")` is dead code)
  // ============================================================

  const openPanel = useCallback(
    (kind: "workspace" | "files" | "git" | "plugins" | "browser") => {
      switch (kind) {
        case "files":
          openSurfaceTab("files");
          setPanel("files");
          break;
        case "git":
          openSurfaceTab("git");
          setPanel("git");
          break;
        case "browser":
          openSurfaceTab("browser");
          setPanel("browser");
          break;
        case "plugins":
          // Plugins surface lives in the tree column (column 4).
          // The card is a placeholder pending the engine's
          // plugin-install contract; the sidebar entry visibly
          // produces a surface rather than silently no-op'ing.
          openSurfaceTab("plugins");
          setPanel("plugins");
          break;
        case "workspace":
          // No workspace surface tab — open the closest analog
          // (Files tab) and leave the toolbar highlight on. A
          // future slice can add a real workspace surface tab.
          openSurfaceTab("files");
          setPanel("workspace");
          break;
        default:
          setPanel((current) => (current === kind ? null : kind));
          break;
      }
    },
    [openSurfaceTab],
  );

  const openSettings = useCallback(() => {
    setSettingsSection("general");
    setPendingProviderAdd(false);
    setSettingsOpen(true);
  }, []);

  // The user menu's usage row lands here (ticket 37): the quota figures live
  // in the settings page's 用量与模型 section, so the entry jumps to that
  // section instead of opening a flyout of its own.
  const openUsage = useCallback(() => {
    setSettingsSection("providers");
    setPendingProviderAdd(false);
    setSettingsOpen(true);
  }, []);

  const openProviderAdd = useCallback(() => {
    setSettingsSection("providers");
    setPendingProviderAdd(true);
    setSettingsOpen(true);
  }, []);

  // File-open callback wired to the FilesPanel and the chat
  // transcript. Routes through the slice-17 file-tab system
  // (multi-tab) — clicking a row opens a new file tab in the
  // preview column.
  const onOpenFile = useCallback(
    (path: string) => {
      openFileTab(path);
    },
    [openFileTab],
  );

  // HTML-row click — opens a browser tab in the preview column
  // AND records the path so the BrowserPanel renders the iframe.
  const onOpenInBrowser = useCallback(
    (path: string) => {
      openBrowserTab(path);
    },
    [openBrowserTab],
  );

  const onBrowserNavigate = useCallback((path: string | null) => {
    setBrowserPath(path);
  }, []);

  const workspaceDir = state?.workspace.dir ?? "";
  useEffect(() => {
    setBrowserPath(null);
  }, [workspaceDir]);

  // Ctrl+N mirrors the sidebar's "新建任务" shortcut. Ctrl+K
  // used to open a legacy "search" panel kind that slice 17
  // removed — the search surface now lives in the tree column
  // and is reached through the sidebar's 搜索 nav entry (which
  // dispatches `openSurfaceTab("search")` from shell.tsx).
  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void runAction(t("topbar.newSession"), api.newSession());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, openPanel, t]);

  // URL ↔ session reconcile.
  const [urlRestored, setUrlRestored] = useState(false);
  const lastAppliedRef = useRef<string | null>(null);
  const urlSession = typeof window !== "undefined" ? parseSessionFromUrl() : null;

  useEffect(() => {
    if (urlRestored) return;
    if (!state) return;
    if (!urlSession) {
      setUrlRestored(true);
      return;
    }
    if (state.mcodeSessionId === urlSession) {
      lastAppliedRef.current = state.mcodeSessionId;
      writeSessionToUrl(state.mcodeSessionId);
      setUrlRestored(true);
      return;
    }
    let cancelled = false;
    void applySessionRestore(urlSession, state.mcodeSessionId ?? null).then((outcome: SessionRestoreOutcome) => {
      if (cancelled) return;
      if (outcome.status === "ok" || outcome.status === "no-op") {
        lastAppliedRef.current = urlSession;
      } else {
        setSessionHint({ kind: "not-found", sessionId: urlSession });
        dropSessionFromUrl();
        window.setTimeout(() => {
          setSessionHint((current) => (current && current.sessionId === urlSession ? null : current));
        }, 6000);
      }
      setUrlRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [state, urlSession, urlRestored]);

  useEffect(() => {
    if (!urlRestored) return;
    const active = state?.mcodeSessionId ?? null;
    if (active === lastAppliedRef.current && active === urlSession) return;
    if (active !== lastAppliedRef.current) {
      lastAppliedRef.current = active;
    }
    writeSessionToUrl(active);
  }, [state?.mcodeSessionId, urlSession, urlRestored]);

  useEffect(() => {
    if (!urlRestored) return;
    const active = state?.mcodeSessionId ?? null;
    writeUiState({
      ...DEFAULT_UI_STATE,
      ...persisted,
      panel,
      lastSessionId: active,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.mcodeSessionId, urlRestored]);

  useEffect(() => {
    const onPop = () => {
      setUrlRestored(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Active panel kind for the toolbar's legacy highlight. Maps
  // to the active preview / tree surface tab so the toolbar
  // still reads as "Files tab is active" when the Files tab is
  // open. Slice 17: the highlight prefers the active preview
  // tab; falls back to the active tree tab when no preview tab
  // exists.
  const activeSurfaceKind: "workspace" | "files" | "git" | "browser" | null = useMemo(() => {
    const previewTab = tabState.tabs.find((tab) => tab.id === tabState.previewActiveId);
    if (previewTab && previewTab.kind === "browser") return "browser";
    const treeTab = tabState.tabs.find((tab) => tab.id === tabState.treeActiveId);
    if (treeTab && treeTab.kind === "files") return "files";
    if (treeTab && treeTab.kind === "git") return "git";
    return null;
  }, [tabState.previewActiveId, tabState.treeActiveId, tabState.tabs]);

  // webui-parity 47 (N2) — which sidebar nav row reads as active. The tab
  // strip is owned by this page, so the shell cannot derive the signal
  // itself: the tree column's active tab being search / plugins lights the
  // matching sidebar row, and `panel === "plugins"` keeps the legacy mirror
  // (set by openPanel) in agreement with openSurfaceTab.
  const activeNavSurface: "search" | "plugins" | null = useMemo(() => {
    const treeTab = tabState.tabs.find((tab) => tab.id === tabState.treeActiveId);
    if (treeTab && (treeTab.kind === "search" || treeTab.kind === "plugins")) {
      return treeTab.kind;
    }
    return panel === "plugins" ? "plugins" : null;
  }, [tabState.tabs, tabState.treeActiveId, panel]);

  // ============================================================
  // Reveal-in-tree handler. Defined BEFORE the early return for
  // `!state` because hooks must be called in the same order on
  // every render. The handler opens (or activates) the Files
  // tab in the tree column; the FilesPanel inside the tree
  // column owns the directory expansion (a future slice can
  // wire expansion through a context channel).
  // ============================================================

  const onRevealInTree = useCallback(
    (path: string) => {
      applyTabs((current) => {
        const filesTab = current.tabs.find((tab) => tab.kind === "files");
        if (filesTab) return activateTab(current, filesTab.id);
        return openTab(current, surfaceTab("files"));
      });
      void path;
    },
    [applyTabs],
  );

  // Upstream shows a centred three-dot loader while the renderer waits for its
  // first state push; webui ticket U8 replaces it with the transcript-shaped
  // shimmer skeleton — a bare spinner gives no hint of the layout that is
  // about to land, and the blank column reads as "broken" on a slow engine
  // boot. The skeleton sits inside the same 960px content cap the conversation
  // uses, so the first real paint does not reflow sideways. The connection
  // copy stays: it is the only part of this screen that says WHY it is
  // loading (connecting vs disconnected).
  if (!state) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg_grouped_secondary text-text_default_secondary">
        <div className="w-full max-w-[960px] px-6">
          <TranscriptSkeleton />
        </div>
        <p className="text-caption-small-strong">
          {connected || !error ? t("app.connecting") : t("app.disconnected")}
        </p>
      </div>
    );
  }

  const hasConversation = decodeTranscript(state.chat).length > 0;

  // ============================================================
  // Column children for the four-column shell. The sidebar slot
  // is null because AppShell renders its own sidebar. The
  // preview and tree slots are always present (column collapse
  // is a visual flag in the layout state, not a render-or-decide
  // choice — the layout passes through the appropriate slot and
  // WorkspaceColumns hides collapsed segments via zero-width).
  // ============================================================

  const conversationColumn = hasConversation ? (
    // The conversation column carries the chat transcript +
    // the composer. Both live INSIDE the new workspace shell so
    // the preview and tree columns can sit beside them. The
    // previous wiring had the composer outside the shell
    // (AppShell rendered it after the children flex row), which
    // is what the reload regression exposed.
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ScrollRestoredChat
          t={t}
          locale={locale}
          sessionId={state.mcodeSessionId ?? null}
          onOpenFile={onOpenFile}
        />
      </div>
      <Composer t={t} onAddProvider={openProviderAdd} />
      <p
        data-testid="app-disclaimer"
        className="flex-none px-4 pt-1 pb-2 text-center text-caption-small-strong text-text_default_secondary"
      >
        {t("home.disclaimer")}
      </p>
    </div>
  ) : (
    <HomeState t={t} locale={locale}>
      <Composer t={t} inline onAddProvider={openProviderAdd} />
    </HomeState>
  );

  // Slice 21 — the preview column is on-demand. The page wires
  // the tabs + column flags through `applyTabs` so the wrapper
  // hides this slot when no preview tab is open (its width
  // collapses to 0 and the divider disappears). The slot is
  // still always mounted so a tab reducer that opens the
  // preview column does not need to wait for a mount cycle.
  const previewSlot = (
    <PreviewColumnMounted
      tabs={tabState.tabs}
      previewActiveId={tabState.previewActiveId}
      workspaceDir={workspaceDir}
      browserPath={browserPath}
      onBrowserNavigate={onBrowserNavigate}
      onActivate={switchPreviewTab}
      onClose={closeOneTab}
      onRecordFileScroll={recordFileScroll}
      onRevealInTree={onRevealInTree}
      t={t}
    />
  );

  const treeSlot = (
    <TreeColumn
      tabs={tabState.tabs}
      treeActiveId={tabState.treeActiveId}
      workspaceDir={workspaceDir}
      locale={locale}
      t={t}
      onPickSurface={openSurfaceTab}
      onClose={closeOneTab}
      // File-row clicks from the tree column route through the
      // page's tab openers: `onOpenFile` opens a preview tab in
      // the preview column; `onOpenInBrowser` opens a browser
      // tab. Slice 17 re-wired these after a regression that
      // left them as no-ops (the previous code shipped empty
      // arrow bodies here).
      onOpenFile={onOpenFile}
      onOpenInBrowser={onOpenInBrowser}
    />
  );

  const columnChildren = {
    sidebar: null,
    conversation: conversationColumn,
    preview: previewSlot,
    tree: treeSlot,
  };

  const newShell = hasConversation ? (
    <WorkspaceColumns
      layout={columnState}
      // Self-measure via ResizeObserver — the AppShell's
      // sidebar + chrome are accounted for automatically, so
      // dragging can never push a column off-window.
      containerWidth={null}
      viewportWidth={viewportWidth}
      onColumnResize={(column, width) =>
        setColumnState((current) => setColumnWidth(current, column, width))
      }
      onColumnReset={(column) =>
        setColumnState((current) => resetColumnWidth(current, column))
      }
    >
      {columnChildren}
    </WorkspaceColumns>
  ) : null;

  return (
    <>
      <AppShell
        t={t}
        toolbar={
          hasConversation ? (
            <ConversationToolbar
              t={t}
              onOpenWorkspace={() => openPanel("workspace")}
              onOpenFiles={() => openPanel("files")}
              onOpenGit={() => openPanel("git")}
              onOpenBrowser={() => openPanel("browser")}
              activePanel={activeSurfaceKind ?? (panel === "files" || panel === "git" || panel === "browser" || panel === "workspace" ? panel : null)}
            />
          ) : null
        }
        panel={null}
        onOpenPanel={openPanel}
        onOpenSurfaceTab={openSurfaceTab}
        activeNavSurface={activeNavSurface}
        onOpenSettings={openSettings}
        onOpenUsage={openUsage}
        alertCount={alertCount}
        hasConversation={hasConversation}
      >
        {hasConversation ? newShell : conversationColumn}
      </AppShell>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        t={t}
        locale={locale}
        setLocale={setLocale}
        initialSection={settingsSection}
        autoAddProvider={pendingProviderAdd}
        onAutoAddConsumed={() => setPendingProviderAdd(false)}
      />
      {sessionHint ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="session-hint-banner"
          className="fixed bottom-4 left-1/2 z-[1100] flex max-w-[560px] -translate-x-1/2 items-center gap-3 rounded-[10px] border border-border_default bg-bg_default_scrim px-4 py-3 text-sm text-text_default_primary shadow-shadow_default"
        >
          <span className="flex-1">{t("session.hint.notFound")}</span>
          <button
            type="button"
            onClick={() => {
              setSessionHint(null);
              if (typeof window !== "undefined") {
                dropSessionFromUrl();
              }
            }}
            className="h-7 rounded-[8px] border border-border_default px-3 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {t("session.hint.notFound.dismiss")}
          </button>
        </div>
      ) : null}
      <ActionErrorBanner t={t} />
      <Modals t={t} />
    </>
  );
}

/**
 * Scroll-restored chat wrapper — unchanged from slice 07.
 */
function ScrollRestoredChat({
  t,
  locale,
  sessionId,
  onOpenFile,
}: {
  t: (key: import("@/lib/i18n").MessageKey) => string;
  locale: import("@/lib/i18n").Locale;
  sessionId: string | null;
  onOpenFile?: (path: string) => void;
}) {
  const initial = sessionId ? readScrollPosition(sessionId) : 0;
  return (
    <Chat
      t={t}
      locale={locale}
      sessionKey={sessionId}
      initialScrollTop={initial}
      onScrollPersist={(top) => {
        if (!sessionId) return;
        writeScrollPosition(sessionId, top);
      }}
      onOpenFile={onOpenFile}
    />
  );
}

// keep the unused-export lint happy: slice 17 deliberately does
// not pull `panel` / `openPanel` / `openSettings` / `DEFAULT_UI_STATE`
// from the legacy path. They stay in scope so a future ticket can
// revive them without re-importing the modules.
void PreviewColumn;
void DEFAULT_WORKSPACE_TABS_STATE;
void isHtmlPath;
void useRef;