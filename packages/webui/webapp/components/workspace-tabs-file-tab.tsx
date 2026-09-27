"use client";

/**
 * File tab body (slice 15).
 *
 * Renders the file tab content for a single open file: the
 * breadcrumb row + the existing `FilePreview` component + the
 * reveal-in-tree / copy-path affordances the 08 reference shows.
 *
 * Scroll handling.
 *
 * The visible scroll container is `FilePreview`'s inner
 * `.file-preview-body` div — NOT this component's wrapper. The
 * wrapper used to host a scroll handler on a div that never
 * actually scrolled, so the persisted `fileScrolls` entry was
 * always 0 (the regression the acceptance run caught). The
 * `FilePreview` component owns the scroll persistence:
 *
 *   - On mount, `initialScrollTop` restores the persisted offset
 *     via a rAF loop that waits for the inner scrollHeight to
 *     settle.
 *   - On every scroll of the inner div, `onScrollPersist` fires
 *     with the new `scrollTop`; the page-level wiring debounces
 *     the value into the `recordFileTabScroll` reducer.
 *
 * Per-tab independence.
 *
 * The page-level `ActiveBody` keys the active body by
 * `tab.id`, so a tab switch unmounts and remounts this entire
 * component. The new mount calls `FilePreview` with a fresh
 * `initialScrollTop` from THIS tab's persisted state — no scroll
 * bleeds across tabs.
 */

import { useCallback, useMemo } from "react";

import { FilePreview } from "@/components/file-preview";
import { basenameOf } from "@/lib/file-preview";
import { copyPathToClipboard } from "@/lib/path-clipboard";
import type { Locale, MessageKey } from "@/lib/i18n";
import { tWorkspaceTab } from "@/lib/i18n-workspace-tabs";
import { Icon } from "./icons";

export interface WorkspaceTabsFileTabProps {
  /** Stable id of the tab this body belongs to. Used as the
   *  React key on `FilePreview` so a tab switch unmounts the
   *  previous preview and remounts a fresh one — that is the
   *  single-source fix for "switching tabs carries the scroll
   *  over" the acceptance run pinned. */
  tabId: string;
  /** Absolute path being previewed. */
  path: string;
  /** Locale (used for the breadcrumb's aria + disabled hint copy). */
  locale: Locale;
  /** Translator — the same `t()` the rest of the panels use. */
  t: (key: MessageKey) => string;
  /** Initial scroll position from persisted state. */
  initialScrollTop: number;
  /** Fired when the user scrolls the body — the page wires this to
   *  the `recordFileTabScroll` reducer so a refresh restores it. */
  onScrollPersist?: (scrollTop: number) => void;
  /** Fired when the user clicks the "reveal in files" affordance —
   *  the page wires this to open the Files tab and (if available)
   *  expand the file's directory. */
  onRevealInTree?: () => void;
}

export function WorkspaceTabsFileTab({
  tabId,
  path,
  locale,
  t,
  initialScrollTop,
  onScrollPersist,
  onRevealInTree,
}: WorkspaceTabsFileTabProps) {
  const fileName = useMemo(() => basenameOf(path), [path]);
  const dir = useMemo(() => parentDir(path), [path]);

  const onCopyPath = useCallback(async () => {
    try {
      await copyPathToClipboard(path);
    } catch {
      // best-effort; the global alert ring would surface a copy
      // failure but the breadcrumb's copy is a tiny affordance and
      // swallowing here matches the file-tree copy affordance.
    }
  }, [path]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="workspace-tabs-file-tab" data-path={path}>
      {/* Breadcrumb row: filename + parent directory + affordances.
          Matches the 08 reference: full-width pill with the file
          name, a folder icon, and a "reveal" button on the right. */}
      <div className="flex items-center gap-1 rounded-[8px] bg-bg_grouped_secondary_elevated px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text_default_primary" title={path}>
          {fileName || path}
        </span>
        <span
          className="flex min-w-0 flex-[2] items-center gap-1 truncate font-family-code text-caption-small-strong text-text_default_tertiary"
          title={dir}
        >
          <Icon name="folderEmpty" size={12} />
          <span className="truncate">{dir}</span>
        </span>
        {onRevealInTree ? (
          <button
            type="button"
            onClick={onRevealInTree}
            aria-label={t("workspaceTabs.fileTab.revealInTree")}
            title={t("workspaceTabs.fileTab.revealInTree")}
            data-testid="workspace-tabs-file-tab-reveal"
            className="flex h-7 flex-none items-center gap-1 rounded-[8px] border border-border_default px-2 text-caption-small-strong text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            <Icon name="folder" size={12} />
            <span>{t("workspaceTabs.fileTab.revealInTree")}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void onCopyPath()}
          aria-label={t("workspaceTabs.fileTab.copyPath")}
          title={path}
          data-testid="workspace-tabs-file-tab-copy"
          className="flex size-7 flex-none items-center justify-center rounded-[8px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
        >
          <Icon name="copy" size={12} />
        </button>
      </div>

      {/* File body. The wrapper around FilePreview has
          `overflow-hidden` so the breadcrumb stays pinned and the
          preview fills the rest. `FilePreview` owns its own
          scroll position; we key it by tab id so a tab switch
          remounts the inner view and the previous tab's scroll
          stays on the previous tab. */}
      <div
        className="min-h-0 flex-1 overflow-hidden"
        data-testid="workspace-tabs-file-tab-scroll"
        aria-label={tWorkspaceTab(locale, "workspaceTabs.fileTab.pathAria").replace("{path}", path)}
      >
        <FilePreview
          key={tabId}
          path={path}
          t={t}
          locale={locale}
          initialScrollTop={initialScrollTop}
          onScrollPersist={onScrollPersist}
        />
      </div>
    </div>
  );
}

function parentDir(path: string): string {
  if (!path) return "";
  const stripped = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const i = stripped.lastIndexOf("/");
  if (i === -1) return stripped;
  return stripped.slice(0, i) || "/";
}