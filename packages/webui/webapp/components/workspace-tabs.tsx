"use client";

/**
 * Preview column (slice 17).
 *
 * Renders the right-side **preview** column of the four-column
 * shell:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  README.md ×   other-file.md ×    +                    │  ← Tab strip (preview tabs only)
 *   ├──────────────────────────────────────────────────────────┤
 *   │  vmaker › README.md                                       │  ← Breadcrumb (file tabs only)
 *   ├──────────────────────────────────────────────────────────┤
 *   │  … active tab content …                                   │
 *   │  - markdown / code / image (slice 16 PreviewError        │
 *   │    covers credential refusal + open-anyway override      │
 *   │    and the other unsupported states)                     │
 *   │  - browser iframe (slice 04b)                            │
 *   │                                                            │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Two visual modes:
 *   - Tabs open     → tab strip + active body (with breadcrumb row
 *                     for file tabs)
 *   - No tabs open  → the column renders an empty hint that
 *                     mirrors the desktop reference (no launcher
 *                     popover; the "+" pill on the strip is the
 *                     affordance for adding a file tab)
 *
 * Slice-17 mental model: this column is **the viewing surface**.
 * It hosts file previews and the built-in browser. The tree
 * column (files / git / tasks) lives in a separate column with its
 * own selector — see `workspace-tree-column.tsx`.
 *
 * The component is controlled — the page owns the
 * `WorkspaceTabsState` and passes the current state + dispatchers
 * down. All state transitions run through the pure reducers in
 * `lib/workspace-tabs-state.ts`; this file is only the renderer.
 */

import { useCallback, useRef, type UIEvent } from "react";

import { useLocale } from "@/lib/use-locale";
import { Icon } from "./icons";
import { WorkspaceTabsFileTab } from "./workspace-tabs-file-tab";
import { FilePreviewPane } from "./file-preview-pane";
import { BrowserPanel } from "./browser-panel";
import {
  columnRoleForKind,
  type WorkspaceTab,
} from "@/lib/workspace-tabs-state";
import type { Locale, MessageKey } from "@/lib/i18n";

// ============================================================
// Tab strip (preview tabs only)
// ============================================================

interface TabStripProps {
  /** All tabs in the workspace; the strip filters to the
   *  preview-role tabs (file:<path>, browser). */
  tabs: WorkspaceTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAddFile?: () => void;
  t: (key: MessageKey) => string;
}

export interface ColumnControlsApi {
  /** Optional callback to collapse the column (e.g. an "x" pill on the strip). */
  onCollapse?: () => void;
}

/**
 * The tab strip itself: one pill per tab, the active one styled,
 * each with a close ×. The far-right has an "+" pill that triggers
 * the caller-supplied `onAddFile` (a file picker — out of scope
 * for this slice, so the wiring defaults to a no-op).
 */
function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onAddFile,
  t,
}: TabStripProps) {
  return (
    <div
      className="thin-scrollbar flex min-h-0 flex-shrink-0 items-center gap-px overflow-x-auto"
      data-testid="workspace-tabs-strip"
      role="tablist"
      aria-label={t("workspaceTabs.tabs.aria")}
    >
      {tabs.map((tab) => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          onActivate={() => onActivate(tab.id)}
          onClose={() => onClose(tab.id)}
          t={t}
        />
      ))}
      <button
        type="button"
        onClick={onAddFile}
        aria-label={t("workspaceTabs.addTab.aria")}
        title={t("workspaceTabs.addTab.aria")}
        data-testid="workspace-tabs-add"
        className="flex h-7 flex-shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-caption-small-strong text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
      >
        <Icon name="plusSmall" size={12} />
      </button>
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
    case "browser":
      return {
        label: t("workspaceTabs.tab.browser"),
        ariaCloseLabel: t("workspaceTabs.tab.browser.aria"),
        icon: "browserGlobe",
      };
    case "file":
      // File tabs get their own close label so screen readers
      // announce "Close file <name>" rather than the generic
      // "Close Files tab" — the previous reuse leaked the kind
      // across tab variants.
      return {
        label: tab.name,
        ariaCloseLabel: t("workspaceTabs.tab.file.aria").replace("{name}", tab.name),
        icon: "file",
      };
    // Surface tabs that classify as preview roles do not exist
    // (only `browser` and `file`); the tree-only kinds fall
    // through to a generic fallback so the type checker stays
    // honest.
    case "files":
    case "git":
    case "tasks":
    case "search":
    case "plugins":
      // Surface tabs that classify as tree roles never appear in
      // the preview column's strip (the column only hosts file +
      // browser tabs), but the type checker requires an exhaustive
      // switch — fall back to a generic label so a future bug that
      // leaks a tree tab into the preview column surfaces with
      // its kind name rather than crashing.
      return {
        label: tab.kind,
        ariaCloseLabel: tab.kind,
        icon: "file",
      };
  }
}

// ============================================================
// Active body
// ============================================================

interface ActiveBodyProps {
  tab: WorkspaceTab;
  workspaceDir: string;
  browserPath: string | null;
  onBrowserNavigate: (path: string | null) => void;
  locale: Locale;
  t: (key: MessageKey) => string;
  onRecordFileScroll: (id: string, scrollTop: number) => void;
  onRevealInTree?: (path: string) => void;
}

/**
 * Renders the body for the active preview tab. The browser tab
 * mounts `BrowserPanel` (slice 04b); file tabs mount
 * `WorkspaceTabsFileTab` (which in turn mounts `FilePreview` —
 * slice 02 + slice 16 credential refusal).
 */
function ActiveBody(props: ActiveBodyProps) {
  const { tab } = props;
  switch (tab.kind) {
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
    case "file":
      return (
        <div className="flex h-full min-h-0 flex-col" data-testid="workspace-tab-body-file">
          <WorkspaceTabsFileTab
            tabId={tab.id}
            path={tab.path}
            locale={props.locale}
            t={props.t}
            initialScrollTop={tab.scrollTop}
            onScrollPersist={(scrollTop) => props.onRecordFileScroll(tab.id, scrollTop)}
            onRevealInTree={props.onRevealInTree ? () => props.onRevealInTree?.(tab.path) : undefined}
          />
        </div>
      );
    default:
      // Should not happen — only browser and file tabs land in
      // the preview column. The exhaustive switch above covers
      // every WorkspaceTab kind; this branch exists only for the
      // TypeScript narrowing.
      return null;
  }
}

// ============================================================
// Public widget
// ============================================================

export interface PreviewColumnProps {
  /** All tabs in the workspace; the column filters to the
   *  preview-role subset (file:<path> + browser). */
  tabs: WorkspaceTab[];
  /** Preview column's active tab id. */
  previewActiveId: string | null;
  workspaceDir: string;
  browserPath: string | null;
  onBrowserNavigate: (path: string | null) => void;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Optional callback for the "+" pill on the strip — wired
   *  to a file picker by the page. Out of scope for slice 17;
   *  defaults to a no-op so the column still renders. */
  onAddFile?: () => void;
  onRecordFileScroll: (id: string, scrollTop: number) => void;
  onRevealInTree?: (path: string) => void;
  /** Translator. Same shape as the rest of the panels. */
  t: (key: MessageKey) => string;
}

/**
 * The render-only preview-column widget.
 *
 * The strip shows ONLY preview tabs (file + browser). Tree
 * tabs (files / git / tasks) live in the tree column. When no
 * preview tab is open the column renders the empty hint copy
 * (no launcher popover — the tree column is where users pick
 * the surfaces they want to see).
 */
export function PreviewColumn(props: PreviewColumnProps) {
  const { locale } = useLocale();
  const { tabs, previewActiveId } = props;
  const previewTabs = tabs.filter((tab) => columnRoleForKind(tab.kind) === "preview");
  const activeTab = previewTabs.find((tab) => tab.id === previewActiveId) ?? null;
  const hasTabs = previewTabs.length > 0;

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col gap-2"
      data-testid="preview-column"
      data-has-tabs={hasTabs ? "true" : "false"}
    >
      <TabStrip
        tabs={previewTabs}
        activeId={previewActiveId}
        onActivate={props.onActivate}
        onClose={props.onClose}
        onAddFile={props.onAddFile}
        t={props.t}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab ? (
          <ActiveBody
            tab={activeTab}
            workspaceDir={props.workspaceDir}
            browserPath={props.browserPath}
            onBrowserNavigate={props.onBrowserNavigate}
            locale={locale}
            t={props.t}
            onRecordFileScroll={props.onRecordFileScroll}
            onRevealInTree={props.onRevealInTree}
          />
        ) : (
          <EmptyHint t={props.t} locale={locale} />
        )}
      </div>
    </aside>
  );
}

function EmptyHint({ t, locale }: { t: (key: MessageKey) => string; locale: Locale }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-text_default_secondary">
      <span
        className="flex size-10 items-center justify-center rounded-full bg-bg_grouped_secondary_elevated text-icon_default_tertiary"
        aria-hidden
      >
        <Icon name="file" size={18} />
      </span>
      <p
        data-testid="preview-column-empty"
        className="max-w-[260px] text-caption-small-strong text-text_default_tertiary"
      >
        {t("workspaceTabs.preview.empty")}
      </p>
      {/* Mounted so an external `open.file.in.web` action still
          re-hydrates the inline preview pane if a legacy
          subscriber fires before the user picks a file tab. */}
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
 * Mounted preview-column wrapper — keeps the scroll position of
 * the body synchronised with persisted state on tab switch and
 * on resize.
 *
 * The `onBodyScroll` handler reads the body's scrollTop; it is
 * currently a no-op because the page already records per-file-tab
 * scroll position through `onRecordFileScroll` in
 * `ActiveBody`. Kept for symmetry / future scrollable surfaces.
 */
export function PreviewColumnMounted(
  props: PreviewColumnProps,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    // No-op at the panel level — per-file-tab persistence lives
    // in `WorkspaceTabsFileTab`. Reserved for surfaces that
    // scroll here later.
    void event;
    void scrollRef;
  }, []);
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex h-full min-h-0 flex-col"
      data-testid="preview-column-mounted"
    >
      <PreviewColumn {...props} />
    </div>
  );
}

// Legacy export — slice 15 callers (tests, deprecated page wiring)
// still reference `WorkspaceTabsPanel`. Re-export the new
// `PreviewColumn` under that name so the type checker stops
// complaining about the rename. The semantics match what the
// tests already expect (preview tabs only).
export const WorkspaceTabsPanel = PreviewColumn;
export const WorkspaceTabsPanelMounted = PreviewColumnMounted;