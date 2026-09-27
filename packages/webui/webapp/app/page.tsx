"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/lib/api";
import { Chat, HomeState } from "@/components/chat";
import { Composer } from "@/components/composer";
import { Modals } from "@/components/modals";
import { ActionErrorBanner } from "@/components/action-error-banner";
import { SettingsModal } from "@/components/panels";
import { AppShell } from "@/components/shell";
import { ConversationToolbar, useAlertCount } from "@/components/toolbar";
import { WorkspaceColumns, useContainerWidth } from "@/components/workspace-columns";
import { WorkspaceTabsPanel } from "@/components/workspace-tabs";
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
import {
  closeTab,
  openTab,
  recordFileTabScroll,
  resetColumnWidth,
  resetTabs,
  setColumnCollapsed,
  setColumnWidth,
  setLauncherOpen,
  setSecondaryOpen,
  activateTab,
  DEFAULT_COLUMN_LAYOUT,
  fileTabFromPath,
  surfaceTab,
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
  // Slice 15 — restore the workspace-tabs payload (open tabs +
  // active tab + column widths + collapsed flags) the same way.
  // The first paint already knows whether the panel column should
  // be open and which tabs are inside it, so a refresh on the new
  // shell does not flash the empty launcher before restoring the
  // saved tabs.
  const [workspaceTabs] = useState<WorkspaceTabsState>(() => readWorkspaceTabs());
  // Right panel open/closed + which kind. Seeded from `persisted.panel`
  // for backward compatibility — the toolbar's legacy buttons still
  // call `openPanel(...)`, and that path now fans out through the
  // workspace-tabs system (open a tab of the matching kind instead
  // of a single-kind right panel). The state below is the legacy
  // mirror; it is no longer the source of truth for what shows in
  // the right column.
  const [panel, setPanel] = useState<typeof persisted.panel>(persisted.panel);
  // Settings is a dialog rather than a drawer panel, so it has its own state.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "appearance" | "connection" | "providers">("general");
  const [pendingProviderAdd, setPendingProviderAdd] = useState(false);
  const [browserPath, setBrowserPath] = useState<string | null>(null);
  const [sessionHint, setSessionHint] = useState<{ kind: "not-found"; sessionId: string } | null>(null);
  const alertCount = useAlertCount();

  // Workspace tabs live-state (slice 15). The `useState` initializer
  // seeds from the persisted payload; subsequent edits mutate via
  // the pure reducers and the effect below mirrors them back into
  // `lib/persist.ts` storage.
  const [tabState, setTabState] = useState<TabStripState>(workspaceTabs.tabStrip);
  const [columnState, setColumnState] = useState<typeof DEFAULT_COLUMN_LAYOUT>(workspaceTabs.columnLayout);
  const containerWidth = useContainerWidth();
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

  // Slice 15 — mirror workspace-tabs state into localStorage. The
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
   * Open a surface tab. If a tab of that kind is already open,
   * just activate it (the reducer handles the move-to-end
   * semantics).
   */
  const openSurfaceTab = useCallback((kind: SurfaceTabKind) => {
    setTabState((current) => openTab(current, surfaceTab(kind)));
    // Open the panel column when a surface tab is added. The
    // legacy `panel` state mirrors this for the toolbar's active
    // highlight and is reconciled below.
    setColumnState((current) => setColumnCollapsed(current, "panel", false));
  }, []);

  /**
   * Open a file tab. If a tab for the same path is already open,
   * just activate it. Also calls `openFileInWeb` so any legacy
   * subscriber (the FilesPanel preview pane) stays in sync.
   */
  const openFileTab = useCallback((path: string) => {
    if (!path) return;
    setTabState((current) => {
      const existing = current.tabs.find(
        (tab) => tab.kind === "file" && tab.path === path,
      );
      if (existing) {
        return openTab(current, existing);
      }
      return openTab(current, fileTabFromPath(path, 0));
    });
    setColumnState((current) => setColumnCollapsed(current, "panel", false));
    // Publish through the slice-12 channel — the FilesPanel's
    // embedded preview pane is still subscribed, so this keeps
    // its empty-state copy consistent.
    openFileInWeb(path);
  }, []);

  /**
   * Open a browser tab + set the browser path. Used by both the
   * file tree (HTML rows) and any future "open in browser" link.
   */
  const openBrowserTab = useCallback((path: string) => {
    if (!path) return;
    setBrowserPath(path);
    setTabState((current) => openTab(current, surfaceTab("browser")));
    setColumnState((current) => setColumnCollapsed(current, "panel", false));
  }, []);

  /**
   * Close a tab by id. The reducer handles active-tab neighbour
   * promotion. When the strip empties, the panel column collapses
   * so the workspace reverts to the "no right panel" state the
   * user expected before slice 15.
   */
  const closeOneTab = useCallback((id: string) => {
    setTabState((current) => {
      const next = closeTab(current, id);
      // The "close file" callback the file preview pane uses
      // should not interfere — open.file.in.web has its own
      // subscription. Clearing it when the LAST file tab closes
      // and the strip is empty would otherwise leave a stale
      // preview pane hanging.
      const closingFile = current.tabs.find((tab) => tab.id === id);
      if (closingFile && closingFile.kind === "file" && !next.tabs.some((tab) => tab.kind === "file")) {
        closeOpenFile();
      }
      if (next.tabs.length === 0) {
        setColumnState((layout) => setColumnCollapsed(layout, "panel", true));
      }
      return next;
    });
  }, []);

  /**
   * Toggle the launcher popover. Pure flag toggle.
   */
  const toggleLauncher = useCallback(() => {
    setTabState((current) => setLauncherOpen(current, !current.launcherOpen));
  }, []);

  /**
   * Toggle the secondary column.
   */
  const toggleSecondary = useCallback(() => {
    setColumnState((current) => setSecondaryOpen(current, !current.secondaryOpen));
  }, []);

  /**
   * Reset a column width to its default.
   */
  const resetOneColumnWidth = useCallback((column: import("@/lib/workspace-tabs-state").ColumnId) => {
    setColumnState((current) => resetColumnWidth(current, column));
  }, []);

  /**
   * Record a file tab's scroll position.
   */
  const recordFileScroll = useCallback((id: string, scrollTop: number) => {
    setTabState((current) => recordFileTabScroll(current, id, scrollTop));
  }, []);

  /**
   * Switch the active tab by id (no-op if unknown).
   */
  const switchTab = useCallback((id: string) => {
    setTabState((current) => activateTab(current, id));
  }, []);

  // ============================================================
  // Backward-compat layer
  //
  // The toolbar's existing launchers (workspace, files, git,
  // browser) call `openPanel(kind)`. To keep the buttons alive
  // without re-architecting the toolbar, that callback now fans
  // out into the workspace-tabs system: workspace opens the
  // Files tab (legacy workspace surface was a multi-section
  // "workspace" panel — slice 15 collapses it into Files for
  // now), files opens the Files tab, git opens the Git tab,
  // browser opens the Browser tab, search opens the search modal
  // (out of slice-15 scope).
  // ============================================================

  const openPanel = useCallback(
    (kind: "workspace" | "files" | "git" | "alerts" | "search" | "progress" | "plugins" | "browser") => {
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
        case "workspace":
          // No workspace surface tab in slice 15 — open the
          // closest analog (the Files tab) and leave the toolbar
          // highlight on. A future slice can add a real
          // workspace surface tab.
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

  const openProviderAdd = useCallback(() => {
    setSettingsSection("providers");
    setPendingProviderAdd(true);
    setSettingsOpen(true);
  }, []);

  // File-open callback wired to the FilesPanel and the chat
  // transcript. Routes through the slice-15 file-tab system
  // (multi-tab) — clicking a row opens a new file tab.
  const onOpenFile = useCallback(
    (path: string) => {
      openFileTab(path);
    },
    [openFileTab],
  );

  // HTML-row click — opens a browser tab AND records the path so
  // the BrowserPanel renders the iframe. Same wiring as
  // pre-slice-15 (the toolbar's "browser" button + the file tree
  // HTML row).
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

  // When the panel column collapses (all tabs closed) and the
  // user closes the last tab, the legacy `panel` state mirrors
  // that — the toolbar's active highlight clears. Without this
  // sync, the toolbar would still show "Files" as active even
  // though the panel column is collapsed.
  useEffect(() => {
    if (tabState.tabs.length === 0 && columnState.collapsed.panel) {
      setPanel(null);
    }
  }, [tabState.tabs.length, columnState.collapsed.panel]);

  // Ctrl+N / Ctrl+K mirror the shortcuts the sidebar advertises.
  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void runAction(t("topbar.newSession"), api.newSession());
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPanel("search");
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
  // to the active surface tab so the toolbar still reads as
  // "Files tab is active" when the Files tab is open.
  const activeSurfaceKind: "workspace" | "files" | "git" | "browser" | null = useMemo(() => {
    const active = tabState.tabs.find((tab) => tab.id === tabState.activeId);
    if (!active) return null;
    if (active.kind === "files") return "files";
    if (active.kind === "git") return "git";
    if (active.kind === "browser") return "browser";
    if (active.kind === "tasks") return null;
    return null;
  }, [tabState.activeId, tabState.tabs]);

  // Upstream shows a centred three-dot loader while the renderer waits for its
  // first state push; same treatment here.
  if (!state) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg_grouped_secondary text-text_default_secondary">
        <span className="mavis-loading">
          <span className="mavis-dot mavis-dot-a" />
          <span className="mavis-dot mavis-dot-b" />
          <span className="mavis-dot mavis-dot-c" />
        </span>
        <p className="text-caption-small-strong">
          {connected || !error ? t("app.connecting") : t("app.disconnected")}
        </p>
      </div>
    );
  }

  const hasConversation = decodeTranscript(state.chat).length > 0;

  // Column children for the new 4-column layout. The sidebar
  // slot is empty here — `AppShell` already renders its own
  // sidebar outside this column row, so passing `null` keeps the
  // slot invisible (collapsed sidebar → zero-width). The
  // conversation slot hosts the chat + composer; the panel slot
  // hosts the workspace-tabs panel; the secondary slot mirrors
  // the panel slot so the user can drag a second surface into
  // it (slice 15 leaves the secondary as a read-only mirror for
  // now — it shows the same active tab as the primary panel).
  const panelColumn = (
    <WorkspaceTabsPanel
      state={tabState}
      workspaceDir={workspaceDir}
      browserPath={browserPath}
      onBrowserNavigate={onBrowserNavigate}
      onActivate={switchTab}
      onClose={closeOneTab}
      onLauncherPick={openSurfaceTab}
      onLauncherToggle={toggleLauncher}
      onRecordFileScroll={recordFileScroll}
      t={t}
      onRevealInTree={(path) => {
        // Open the Files tab if it isn't already open, then
        // activate it. The FilesPanel inside the tab exposes the
        // tree; the "reveal in tree" affordance on the breadcrumb
        // does not currently expand the file's directory (a
        // future ticket can wire that through a context channel).
        setTabState((current) => {
          const filesTab = current.tabs.find((tab) => tab.kind === "files");
          if (filesTab) return activateTab(current, filesTab.id);
          return openTab(current, surfaceTab("files"));
        });
        setColumnState((current) => setColumnCollapsed(current, "panel", false));
        void path;
      }}
      onOpenFile={onOpenFile}
      onOpenInBrowser={onOpenInBrowser}
      hasSecondary={columnState.secondaryOpen}
      columnControls={{
        toggleSecondary,
        resetColumn: () => resetOneColumnWidth("panel"),
      }}
    />
  );

  // The secondary column re-uses the same WorkspaceTabsPanel
  // component but with its own (currently shared) tab strip and
  // an independent panel-control surface. Slice 15 ships a
  // mirror — the secondary hosts the same tabs as the primary,
  // useful for the DSH-style "file tree on the left, preview on
  // the right" side-by-side layout.
  const secondaryColumn = (
    <WorkspaceTabsPanel
      state={tabState}
      workspaceDir={workspaceDir}
      browserPath={browserPath}
      onBrowserNavigate={onBrowserNavigate}
      onActivate={switchTab}
      onClose={closeOneTab}
      onLauncherPick={openSurfaceTab}
      t={t}
      onLauncherToggle={toggleLauncher}
      onRecordFileScroll={recordFileScroll}
      onRevealInTree={(path) => {
        setTabState((current) => {
          const filesTab = current.tabs.find((tab) => tab.kind === "files");
          if (filesTab) return activateTab(current, filesTab.id);
          return openTab(current, surfaceTab("files"));
        });
        void path;
      }}
      onOpenFile={onOpenFile}
      onOpenInBrowser={onOpenInBrowser}
      hasSecondary={columnState.secondaryOpen}
      columnControls={{
        toggleSecondary,
        resetColumn: () => resetOneColumnWidth("secondary"),
      }}
    />
  );

  const conversationColumn = hasConversation ? (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ScrollRestoredChat
        t={t}
        locale={locale}
        sessionId={state.mcodeSessionId ?? null}
        onOpenFile={onOpenFile}
      />
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

  // Slice 15 — the new 4-column shell composes inside the
  // existing AppShell's panel prop. The shell keeps its own
  // sidebar (with drag-resize + collapse from slice 07), and the
  // right-hand panel slot hosts a 3-up flex row (conversation
  // + panel + secondary). The conversation column carries the
  // chat + composer; the panel column carries the multi-tab
  // workspace; the secondary column mirrors the panel column
  // when open. The home screen keeps the inline composer
  // layout and renders the conversation column without a
  // panel — the AppShell's panel slot is empty in that case.
  const columnChildren = {
    sidebar: null,
    conversation: conversationColumn,
    panel: columnState.collapsed.panel ? null : panelColumn,
    secondary: columnState.secondaryOpen ? secondaryColumn : null,
  };

  // The right-hand panel slot hosts a 4-column layout when
  // there is a conversation (the multi-tab workspace is part of
  // the same flex row as the chat), and nothing on the home
  // screen (where the composer is inline and there is no panel
  // to show).
  const newShell = hasConversation ? (
    <WorkspaceColumns
      layout={columnState}
      containerWidth={containerWidth}
      viewportWidth={viewportWidth}
      onColumnResize={(column, width) =>
        setColumnState((current) => setColumnWidth(current, column, width))
      }
      onColumnReset={(column) => setColumnState((current) => resetColumnWidth(current, column))}
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
        // Slice 15 — the legacy `panel` slot now hosts the new
        // 4-column workspace layout. AppShell wraps it with the
        // same shadow / border the right panel had before, so the
        // visual frame matches.
        panel={newShell}
        onOpenPanel={openPanel}
        onOpenSettings={openSettings}
        alertCount={alertCount}
        hasConversation={hasConversation}
      >
        {/* The conversation column lives INSIDE the new shell —
            AppShell renders children as the "conversation
            column" area, but slice 15 routes the chat + composer
            through the column-children system above. The home
            screen still wants the inline composer + greeting,
            so we pass that as the children. */}
        {!hasConversation ? conversationColumn : null}
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

// keep the unused-export lint happy: slice 15 deliberately does
// not pull `panel`/`openPanel`/`openSettings` / resetTabs from the
// legacy path. They stay in scope so a future ticket can revive
// them without re-importing the modules.
void resetTabs;
void DEFAULT_WORKSPACE_TABS_STATE;
void isHtmlPath;
void useRef;