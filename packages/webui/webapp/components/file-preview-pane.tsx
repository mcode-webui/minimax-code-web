"use client";

import { useEffect, useState } from "react";

import { FilePreview } from "@/components/file-preview";
import { closeOpenFile, subscribeOpenFile } from "@/lib/open-file";
import type { Locale, MessageKey } from "@/lib/i18n";
import { Icon } from "@/components/icons";

/**
 * The right-hand preview pane (webui-parity 12).
 *
 * Mounted inside `FilesPanel` — the only place in the shell that the
 * file tree also lives, which is also where the target desktop UI
 * places its preview pane (see `refs/ui/02-workspace-shell.jpg`,
 * right column: tree + preview).
 *
 * The pane subscribes to the `open.file.in.web` action in
 * `lib/open-file.ts`. Two entry points call that action (the file
 * tree and the turn summary in `ActivitySummary`); both land here,
 * so the preview surface is the same regardless of where the user
 * triggered it.
 *
 * The component owns no path state of its own. The single-source
 * promise is the subscription — there is exactly one place the open
 * path lives (`lib/open-file.ts#currentPath`) and exactly one
 * subscriber contract. Refreshing the page reopens the same file
 * because the action persists its last value in `localStorage` (see
 * the module doc on the persistence contract).
 */

export interface FilePreviewPaneProps {
  t: (key: MessageKey) => string;
  locale: Locale;
}

export function FilePreviewPane({ t, locale }: FilePreviewPaneProps) {
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => subscribeOpenFile(setPath), []);

  return (
    <div
      className="mt-2 flex min-h-0 flex-col gap-2 border-t border-border_light pt-3"
      data-testid="file-preview-pane"
    >
      {path ? (
        <>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span
              className="min-w-0 truncate text-caption-small-strong text-text_default_tertiary"
              data-testid="file-preview-pane-active"
              title={path}
            >
              {path}
            </span>
            <button
              type="button"
              onClick={closeOpenFile}
              aria-label={t("files.preview.close")}
              title={t("files.preview.close")}
              data-testid="file-preview-pane-close"
              className="flex size-6 flex-none items-center justify-center rounded-[6px] text-icon_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-icon_default_primary"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="min-h-[120px] flex-1 overflow-hidden">
            <FilePreview path={path} t={t} locale={locale} />
          </div>
        </>
      ) : (
        <p
          className="px-1.5 py-2 text-caption-small-strong text-text_default_tertiary"
          data-testid="file-preview-pane-empty"
        >
          {t("files.preview.empty")}
        </p>
      )}
    </div>
  );
}