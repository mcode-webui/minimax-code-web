// webapp/components/edited-files-card.tsx — the 「已编辑 N 个文件」 summary card.
//
// Ticket 77 (G3 of ticket 61). Structure follows the reference implementation
// (`other-minimax-code/.../DiffCard.tsx`): a header row and a file list, driven
// by a pure state machine kept beside the component so the transitions are
// testable without a DOM.
//
// The reference's card is fed by `getTurnDiff` / `revertTurnDiff` /
// `reapplyTurnDiff` — a per-turn changeset the runtime owns. This repo has no
// reachable equivalent (the audit is in
// `.tickets/webui-parity/77-edited-files-card.md`), so the card renders only
// what `collectEditedFiles` can prove: the paths the turn's edit tools named.
// Consequences, all deliberate and none cosmetic:
//
//   * no green/red added-deleted badges — no line counts exist to show;
//   * no 撤销 button — there is no per-turn revert to call, and a button that
//     does nothing is worse than an absent one;
//   * no Review button — clicking a file row opens the real file preview
//     instead, which is the affordance this codebase can actually honour.
//
// The header reuses the existing `activity.editedFiles` key rather than adding
// a near-duplicate: the activity-group summary and this card are the same
// sentence, so they must stay the same sentence.

"use client";

import { useState } from "react";
import { Icon } from "./icons";
import type { EditedFile } from "../lib/edited-files";
import type { MessageKey } from "../lib/i18n";

/** Rows shown before the card needs the expand toggle. */
export const COLLAPSED_FILE_ROWS = 3;

export interface EditedFilesCardState {
  /** Whether the file list is showing all rows rather than the first few. */
  readonly expanded: boolean;
}

export type EditedFilesCardAction = { readonly type: "toggle-expanded" };

export function initialEditedFilesCardState(): EditedFilesCardState {
  return { expanded: false };
}

export function reduceEditedFilesCardState(
  state: EditedFilesCardState,
  action: EditedFilesCardAction,
): EditedFilesCardState {
  switch (action.type) {
    case "toggle-expanded":
      return { ...state, expanded: !state.expanded };
  }
}

export function EditedFilesCard({
  files,
  t,
  onOpenFile,
}: {
  readonly files: readonly EditedFile[];
  readonly t: (key: MessageKey) => string;
  readonly onOpenFile?: (path: string) => void;
}) {
  const [state, setState] = useState<EditedFilesCardState>(initialEditedFilesCardState);
  // A1: with no files there is nothing truthful to say, so the card is not in
  // the tree at all — not an empty shell, not a 「0 个文件」 placeholder.
  if (files.length === 0) return null;

  const shown = state.expanded ? files : files.slice(0, COLLAPSED_FILE_ROWS);
  const hidden = files.length - shown.length;
  const title = t("activity.editedFiles").replace("{{count}}", String(files.length));

  return (
    <section
      data-testid="edited-files-card"
      data-edited-files-count={files.length}
      aria-label={title}
      className="mb-3 rounded-[10px] border border-border_default bg-bg_default_primary px-3 py-2.5"
    >
      <header className="flex items-center gap-2">
        <span className="text-icon_default_tertiary" data-testid="edited-files-card-icon">
          <Icon name="pencil" size={16} />
        </span>
        <span className="text-body-small-strong text-text_default_primary">{title}</span>
      </header>
      <ul className="mt-1.5 flex flex-col" data-testid="edited-files-card-list">
        {shown.map((file) => (
          <li
            key={file.path}
            data-testid="edited-files-card-row"
            data-file-path={file.path}
            className="flex min-h-[28px] items-center gap-2"
          >
            <span className="text-icon_default_tertiary">
              <Icon name="file" size={14} />
            </span>
            {onOpenFile ? (
              <button
                type="button"
                onClick={() => onOpenFile(file.path)}
                title={file.path}
                data-testid="edited-files-card-file"
                className="truncate text-left font-mono text-caption-small text-text_default_primary underline-offset-2 hover:underline"
              >
                {file.name}
              </button>
            ) : (
              <span
                title={file.path}
                data-testid="edited-files-card-file"
                className="truncate font-mono text-caption-small text-text_default_primary"
              >
                {file.name}
              </span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 || state.expanded ? (
        <button
          type="button"
          data-testid="edited-files-card-toggle"
          data-expanded={state.expanded}
          onClick={() => setState((current) => reduceEditedFilesCardState(current, { type: "toggle-expanded" }))}
          className="mt-1 flex items-center gap-1 text-caption-small text-text_default_tertiary transition-colors hover:text-text_default_primary"
        >
          <Icon name={state.expanded ? "chevronUp" : "chevronDown"} size={12} />
          {state.expanded ? t("activity.collapse") : t("activity.expand")}
        </button>
      ) : null}
    </section>
  );
}
