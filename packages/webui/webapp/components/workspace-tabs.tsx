"use client";

/**
 * Workspace Tabs column (slice 15).
 *
 * The DSH-style multi-tab sidebar:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  task  │ browser │ files │ start │ file-tab.png × │ + ⤬ ⤡ ⤢ │  ← Tab strip + controls
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Files  >  file-tab.png     [reveal in tree] [⧉]            │  ← Breadcrumb (file tabs only)
 *   ├──────────────────────────────────────────────────────────┤
 *   │  … active tab content …                                     │
 *   │                                                            │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Two visual modes:
 *   - Tabs open     → tab strip + active body (with breadcrumb row
 *                     for file tabs)
 *   - No tabs open  → launcher list IS the body (07 reference)
 *
 * The component is controlled — the page owns the
 * `WorkspaceTabsState` and passes the current state + dispatchers
 * down. All state transitions run through the pure reducers in
 * `lib/workspace-tabs-state.ts`; this file is only the renderer.
 */

import { useCallback, useRef, type UIEvent } from "react";

import { useLocale } from "@/lib/use-locale";
import { Icon } from "./icons";
import { WorkspaceTabsLauncher } from "./workspace-tabs-launcher";
import { WorkspaceTabsTasks } from "./workspace-tabs-tasks";
import { WorkspaceTabsFileTab } from "./workspace-tabs-file-tab";
import { FilePreviewPane } from "./file-preview-pane";
import { FilesPanel, GitPanel } from "./panels";
import { BrowserPanel } from "./browser-panel";
import {
  type SurfaceTabKind,
  type TabStripState,
  type WorkspaceTab,
} from "@/lib/workspace-tabs-state";
import type { Locale, MessageKey } from "@/lib/i18n";

// ============================================================
// Tab strip
// ============================================================

interface TabStripProps {
  state: TabStripState;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onLauncherToggle: () => void;
  onColumnControls?: ColumnControlsApi;
  hasSecondary?: boolean;
  t: (key: MessageKey) => string;
}

export interface ColumnControlsApi {
  toggleSecondary: () => void;
  resetColumn: () => void;
}

/**
 * The tab strip itself: one pill per tab, the active one styled,
 * each with a close ×. The far-right has the launcher "+" pill
 * and the column controls (the reference shows three small icons
 * in that slot — secondary column toggle + reset).
 */
function TabStrip({
  state,
  onActivate,
  onClose,
  onLauncherToggle,
  onColumnControls,
  hasSecondary,
  t,
}: TabStripProps) {
  return (
    <div
      className="thin-scrollbar flex min-h-0 flex-shrink-0 items-center gap-px overflow-x-auto"
      data-testid="workspace-tabs-strip"
      role="tablist"
      aria-label={t("workspaceTabs.tabs.aria")}
    >
      {state.tabs.map((tab) => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === state.activeId}
          onActivate={() => onActivate(tab.id)}
          onClose={() => onClose(tab.id)}
          t={t}
        />
      ))}
      <button
        type="button"
        onClick={onLauncherToggle}
        aria-label={t("workspaceTabs.addTab.aria")}
        aria-expanded={state.launcherOpen}
        title={t("workspaceTabs.addTab.aria")}
        data-testid="workspace-tabs-add"
        className={[
          "flex h-7 flex-shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-caption-small-strong transition-colors",
          state.launcherOpen
            ? "bg-bg_interaction_tertiary_selected text-text_default_primary"
            : "text-icon_default_tertiary hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary",
        ].join(" ")}
      >
        <Icon name="plusSmall" size={12} />
      </button>
      {onColumnControls ? (
        <div className="ml-auto flex flex-shrink-0 items-center gap-px pr-1">
          <button
            type="button"
            onClick={onColumnControls.toggleSecondary}
            aria-pressed={hasSecondary ?? false}
            aria-label={t("workspaceTabs.column.secondaryAria")}
            title={t("workspaceTabs.column.secondaryAria")}
            data-testid="workspace-tabs-secondary-toggle"
            className="flex size-6 items-center justify-center rounded-[6px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
          >
            <Icon name="sidebar" size={12} className="rotate-180" />
          </button>
          <button
            type="button"
            onClick={onColumnControls.resetColumn}
            aria-label={t("workspaceTabs.column.resetAria")}
            title={t("workspaceTabs.column.resetAria")}
            data-testid="workspace-tabs-column-reset"
            className="flex size-6 items-center justify-center rounded-[6px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TabPill({
  tab,
  active,
  onActivate,
  onClose,
  t,
}: {
  tab: WorkspaceTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  t: (key: MessageKey) => string;
}) {
  const { label, ariaCloseLabel, icon } = tabVisual(tab, t);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onActivate}
      data-testid={`workspace-tab-${tab.id}`}
      data-active={active ? "true" : "false"}
      data-kind={tab.kind}
      className={[
        "group/tab flex h-7 flex-shrink-0 items-center gap-1 rounded-[8px] px-2 text-caption-small-strong transition-colors",
        active
          ? "bg-bg_interaction_tertiary_selected text-text_default_primary"
          : "text-text_default_secondary hover:bg-bg_interaction_tertiary_hover",
      ].join(" ")}
    >
      <span className="flex size-3.5 flex-shrink-0 items-center justify-center text-icon_default_secondary">
        <Icon name={icon} size={12} />
      </span>
      <span className="min-w-0 max-w-[160px] truncate text-left">{label}</span>
      <span
        role="button"
        aria-label={ariaCloseLabel}
        title={ariaCloseLabel}
        data-testid={`workspace-tab-close-${tab.id}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={[
          "flex size-4 flex-shrink-0 items-center justify-center rounded-full text-icon_default_tertiary transition-colors",
          active
            ? "hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary"
            : "group-hover/tab:bg-bg_interaction_tertiary_hover",
        ].join(" ")}
      >
        <Icon name="close" size={10} />
      </span>
    </button>
  );
}

function tabVisual(
  tab: WorkspaceTab,
  t: (key: MessageKey) => string,
): { label: string; ariaCloseLabel: string; icon: Parameters<typeof Icon>[0]["name"] } {
  switch (tab.kind) {
    case "files":
      return { label: t("workspaceTabs.tab.files"), ariaCloseLabel: t("workspaceTabs.tab.files.aria"), icon: "folder" };
    case "git":
      return { label: t("workspaceTabs.tab.git"), ariaCloseLabel: t("workspaceTabs.tab.git.aria"), icon: "git" };
    case "browser":
      return {
        label: t("workspaceTabs.tab.browser"),
        ariaCloseLabel: t("workspaceTabs.tab.browser.aria"),
        icon: "browserGlobe",
      };
    case "tasks":
      return {
        label: t("workspaceTabs.tab.tasks"),
        ariaCloseLabel: t("workspaceTabs.tab.tasks.aria"),
        icon: "workspace",
      };
    case "file":
      return {
        label: tab.name,
        ariaCloseLabel: t("workspaceTabs.tab.files.aria"),
        icon: "file",
      };
  }
}

// ============================================================
// Active body
// ============================================================

interface ActiveBodyProps {
  state: TabStripState;
  workspaceDir: string;
  browserPath: string | null;
  onBrowserNavigate: (path: string | null) => void;
  locale: Locale;
  t: (key: MessageKey) => string;
  onRecordFileScroll: (id: string, scrollTop: number) => void;
  onRevealInTree?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenInBrowser?: (path: string) => void;
}

/**
 * Renders the body for the active tab. Each surface has its own
 * component contract — the FilesPanel needs locale + onOpenInBrowser
 * + onOpenFile; the BrowserPanel needs workspaceDir + currentPath +
 * onNavigate; etc. The component dispatches on `state.activeId`
 * and wires each surface with the page's callbacks.
 */
function ActiveBody(props: ActiveBodyProps) {
  const activeId = props.state.activeId;
  if (!activeId) return null;
  const tab = props.state.tabs.find((entry) => entry.id === activeId);
  if (!tab) return null;

  switch (tab.kind) {
    case "files":
      if (props.onOpenFile && props.onOpenInBrowser) {
        return (
          <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="workspace-tab-body-files">
            <FilesTabBody
              locale={props.locale}
              t={props.t}
              onOpenFile={props.onOpenFile}
              onOpenInBrowser={props.onOpenInBrowser}
            />
          </div>
        );
      }
      return (
        <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="workspace-tab-body-files">
          <FilesEmptyHint t={props.t} />
        </div>
      );
    case "git":
      return (
        <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="workspace-tab-body-git">
          <GitPanel t={props.t} />
        </div>
      );
    case "browser":
      return (
        <div className="flex h-full min-h-0 flex-col" data-testid="workspace-tab-body-browser">
          <BrowserPanel
            t={props.t}
            locale={props.locale}
            workspaceDir={props.workspaceDir}
            currentPath={props.browserPath}
            onNavigate={props.onBrowserNavigate}
          />
        </div>
      );
    case "tasks":
      return (
        <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="workspace-tab-body-tasks">
          <WorkspaceTabsTasks t={props.t} locale={props.locale} />
        </div>
      );
    case "file":
      return (
        <div className="flex h-full min-h-0 flex-col" data-testid="workspace-tab-body-file">
          <WorkspaceTabsFileTab
            path={tab.path}
            locale={props.locale}
            t={props.t}
            initialScrollTop={tab.scrollTop}
            onScrollPersist={(scrollTop) => props.onRecordFileScroll(tab.id, scrollTop)}
            onRevealInTree={props.onRevealInTree ? () => props.onRevealInTree?.(tab.path) : undefined}
          />
        </div>
      );
  }
}

function FilesEmptyHint({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div className="flex flex-col gap-2 rounded-[8px] bg-bg_grouped_secondary_elevated px-3 py-3">
      <span className="desktop-text-dialog-medium text-base font-medium leading-6 text-text_default_primary">
        {t("workspaceTabs.tab.files")}
      </span>
      <span className="text-caption-small-strong text-text_default_tertiary">
        {t("workspaceTabs.fileTab.pathAria").replace("{path}", "files")}
      </span>
    </div>
  );
}

/**
 * The full Files tab body — the slice-01 file tree + a fallback
 * preview pane. Mounted only when the page passes
 * `onOpenFile` / `onOpenInBrowser` callbacks. Clicking a row in
 * the tree triggers a page-level callback that opens a new file
 * tab AND publishes the path through `openFileInWeb`; the
 * `FilePreviewPane` keeps its subscription so its empty-state
 * stays correct while the user has not picked a file yet, and
 * the actual preview is hosted in the new file tab (slice 15).
 */
function FilesTabBody({
  locale,
  t,
  onOpenFile,
  onOpenInBrowser,
}: {
  locale: Locale;
  t: (key: MessageKey) => string;
  onOpenFile: (path: string) => void;
  onOpenInBrowser: (path: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pr-4">
      <FilesPanel
        t={t}
        locale={locale}
        onOpenFile={onOpenFile}
        onOpenInBrowser={onOpenInBrowser}
      />
    </div>
  );
}

// ============================================================
// Public widget
// ============================================================

export interface WorkspaceTabsPanelProps {
  state: TabStripState;
  workspaceDir: string;
  browserPath: string | null;
  onBrowserNavigate: (path: string | null) => void;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onLauncherPick: (kind: SurfaceTabKind) => void;
  onLauncherDisabledHint?: (kind: "btw" | "terminal") => void;
  onLauncherToggle: () => void;
  onRecordFileScroll: (id: string, scrollTop: number) => void;
  onRevealInTree?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenInBrowser?: (path: string) => void;
  /** True when the secondary column is open; used to style the
   *  column-toggle control in the tab strip. */
  hasSecondary: boolean;
  /** Column-control callbacks (only used by the primary column). */
  columnControls?: ColumnControlsApi;
  /** Translator. Same shape as the rest of the panels. */
  t: (key: MessageKey) => string;
}

/**
 * The render-only workspace-tabs widget.
 *
 * Two visual modes: tabs open → tab strip + active body;
 * tabs closed → inline launcher + heading copy. The launcher
 * popover (anchored under the "+" pill) is mounted in both modes;
 * an external controller (the page) sets `state.launcherOpen`.
 */
export function WorkspaceTabsPanel(props: WorkspaceTabsPanelProps) {
  const { locale } = useLocale();
  const { state, onActivate, onClose, onLauncherToggle, onLauncherPick, onLauncherDisabledHint } = props;
  const hasTabs = state.tabs.length > 0;
  const activeId = state.activeId;

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col gap-2"
      data-testid="workspace-tabs-panel"
      data-has-tabs={hasTabs ? "true" : "false"}
    >
      {/* Tab strip + column controls (always mounted; the strip is
          empty when there are no tabs). */}
      <TabStrip
        state={state}
        onActivate={onActivate}
        onClose={onClose}
        onLauncherToggle={onLauncherToggle}
        onColumnControls={props.columnControls}
        hasSecondary={props.hasSecondary}
        t={props.t}
      />

      {/* Launcher popover — anchored to the strip's "+" pill. The
          `WorkspaceTabsLauncher` body handles its own disable hints
          for the two "not implemented" rows. */}
      {state.launcherOpen ? (
        <div
          className="flex-shrink-0 rounded-[10px] border border-border_default bg-bg_default_scrim p-2"
          data-testid="workspace-tabs-launcher-popover"
        >
          <WorkspaceTabsLauncher
            locale={locale}
            t={props.t}
            onPick={onLauncherPick}
            onDisabledHint={onLauncherDisabledHint}
            mode="popover"
          />
        </div>
      ) : null}

      {/* Body — tab content or empty-state launcher. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {hasTabs && activeId ? (
          <ActiveBody
            state={state}
            workspaceDir={props.workspaceDir}
            browserPath={props.browserPath}
            onBrowserNavigate={props.onBrowserNavigate}
            locale={locale}
            t={props.t}
            onRecordFileScroll={props.onRecordFileScroll}
            onRevealInTree={props.onRevealInTree}
            onOpenFile={props.onOpenFile}
            onOpenInBrowser={props.onOpenInBrowser}
          />
        ) : (
          <EmptyLauncher
            locale={locale}
            t={props.t}
            onPick={onLauncherPick}
            onDisabledHint={onLauncherDisabledHint}
          />
        )}
      </div>
    </aside>
  );
}

function EmptyLauncher({
  locale,
  t,
  onPick,
  onDisabledHint,
}: {
  locale: Locale;
  t: (key: MessageKey) => string;
  onPick: (kind: SurfaceTabKind) => void;
  onDisabledHint?: (kind: "btw" | "terminal") => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-6 overflow-y-auto pt-8">
      <div className="flex size-10 items-center justify-center rounded-full bg-bg_grouped_secondary_elevated text-icon_default_tertiary">
        <Icon name="browserGlobe" size={18} />
      </div>
      <div className="flex flex-col items-center gap-1 px-4 text-center">
        <h2 className="desktop-text-dialog-medium text-base font-medium leading-6 text-text_default_primary">
          {t("workspaceTabs.empty.heading")}
        </h2>
        <p className="max-w-[260px] text-caption-small-strong text-text_default_tertiary">
          {t("workspaceTabs.empty.subtitle")}
        </p>
      </div>
      <div className="w-[280px] max-w-full">
        <WorkspaceTabsLauncher
          locale={locale}
          t={t}
          onPick={onPick}
          onDisabledHint={onDisabledHint}
          mode="inline"
        />
      </div>
      {/* The legacy preview pane is kept mounted (it subscribes to
          `open.file.in.web`) so a click on a file row that lands
          while only the Files tab is open still renders the empty
          hint copy. The pane stays collapsed until the user opens
          a file in a tab of its own. */}
      <div className="hidden">
        <FilePreviewPane t={t} locale={locale} />
      </div>
    </div>
  );
}

// ============================================================
// Mounted panel with persisted scroll + drag affordance
// ============================================================

/**
 * Mounted panel wrapper — keeps the scroll position of the body
 * synchronised with persisted state on tab switch and on resize.
 *
 * The `onBodyScroll` handler reads the body's scrollTop; it is
 * currently a no-op because the page already records per-file-tab
 * scroll position through `onRecordFileScroll` in
 * `ActiveBody`. Kept for symmetry / future scrollable surfaces.
 */
export function WorkspaceTabsPanelMounted(
  props: WorkspaceTabsPanelProps,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    // No-op at the panel level — per-file-tab persistence lives in
    // `WorkspaceTabsFileTab`. Reserved for surfaces that scroll
    // here later.
    void event;
    void scrollRef;
  }, []);
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex h-full min-h-0 flex-col"
      data-testid="workspace-tabs-panel-mounted"
    >
      <WorkspaceTabsPanel {...props} />
    </div>
  );
}