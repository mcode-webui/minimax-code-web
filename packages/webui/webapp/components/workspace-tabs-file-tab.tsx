"use client";

/**
 * File tab body (slice 15).
 *
 * Renders the file tab content for a single open file: the
 * breadcrumb row + the existing `FilePreview` component + the
 * reveal-in-tree / copy-path affordances the 08 reference shows.
 *
 * The component owns its own scroll container (the breadcrumb row
 * is fixed, the body scrolls). Scroll position is reported up via
 * `onScrollPersist` so a refresh restores the user's place in a
 * long file. The scroll position is persisted in
 * `lib/workspace-tabs-state.ts#recordFileTabScroll` and shipped
 * back through the workspace-tabs payload on next cold load.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import { FilePreview } from "@/components/file-preview";
import { basenameOf } from "@/lib/file-preview";
import { copyPathToClipboard } from "@/lib/path-clipboard";
import type { Locale, MessageKey } from "@/lib/i18n";
import { tWorkspaceTab } from "@/lib/i18n-workspace-tabs";
import { Icon } from "./icons";

export interface WorkspaceTabsFileTabProps {
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
  path,
  locale,
  t,
  initialScrollTop,
  onScrollPersist,
  onRevealInTree,
}: WorkspaceTabsFileTabProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lastReportedRef = useRef<number>(initialScrollTop);

  // Restore the persisted scroll position. The preview body's own
  // content takes a render to mount its inner scrollers; we apply
  // the offset on a microtask + on every load.
  useEffect(() => {
    if (!scrollerRef.current) return;
    if (initialScrollTop <= 0) return;
    scrollerRef.current.scrollTop = initialScrollTop;
    lastReportedRef.current = initialScrollTop;
  }, [path, initialScrollTop]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const next = event.currentTarget.scrollTop;
      if (next === lastReportedRef.current) return;
      lastReportedRef.current = next;
      onScrollPersist?.(next);
    },
    [onScrollPersist],
  );

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

      {/* Scrollable preview body. `FilePreview` itself owns an
          inner scroll region for long markdown / code files; the
          outer wrapper here only scrolls when the inner content
          overflows the viewport. */}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="thin-scrollbar min-h-0 flex-1 overflow-auto"
        data-testid="workspace-tabs-file-tab-scroll"
        aria-label={tWorkspaceTab(locale, "workspaceTabs.fileTab.pathAria").replace("{path}", path)}
      >
        <FilePreview path={path} t={t} locale={locale} />
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