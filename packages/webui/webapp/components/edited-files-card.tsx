// webapp/components/edited-files-card.tsx — the 「已编辑 N 个文件」 summary card.
//
// Ticket 77 (G3 of ticket 61) built the card from what the transcript could
// prove: the paths a turn's edit tools named, and nothing else. Webui-parity
// 83 gave the same card the engine's own per-turn record, so four of the
// desktop's twelve elements are now reachable: real green `+N` / red `-N`
// per file and in the header, and a real 撤销 / 重做 pair.
//
// The card is mounted once per TURN (it is a turn footer), fed by the turn's
// `assistantMessageId`. Three absences are deliberate and are what keeps the
// card honest:
//
//   * no engine record → the ticket-77 card, unchanged. No `+0`, no disabled
//     button, no "nothing changed" claim. A turn recorded before the engine
//     began persisting diffs has no numbers, and "no numbers" is not "zero";
//   * no `canUndo` from the engine → no undo button AT ALL, not a greyed one.
//     Only the latest turn is revertible and the engine is the only party that
//     knows which turn that is; a disabled button would promise an action the
//     engine has already refused (409), which is the dead control this
//     repository had to delete once already (ticket 114);
//   * no `previewState`. The protocol declares the field, the runtime never
//     fills it, so nothing here reads it.
//
// The header reuses the existing `activity.editedFiles` key rather than adding
// a near-duplicate: the activity-group summary and this card are the same
// sentence, so they must stay the same sentence.

"use client";

import { useState } from "react";
import { Icon } from "./icons";
import { totalLineChanges, type EditedFile } from "../lib/edited-files";
import type { TurnDiffFailure } from "../lib/turn-diff";
import type { ReviewLink, ReviewLinkDisabled, ReviewLinkState } from "../lib/review-link";
import type { MessageKey } from "../lib/i18n";

/** Rows shown before the card needs the expand toggle. */
export const COLLAPSED_FILE_ROWS = 3;

/**
 * Why the 「Review」 control is inert, as one key per reason.
 *
 * The four absences are four different sentences on purpose. 「没有记录」 (nobody
 * ran `gh pr view` / `glab mr view` on this branch), 「没有分支」 (a detached
 * HEAD, or a folder that is not a Git repository), 「工作区未知」 (this tab has
 * no conversation) and 「引擎不可用」 (501 / 503 / a network failure) each tell
 * the user a different thing to do next, and one vague tooltip would tell them
 * nothing. The mapping lives beside the card rather than inside it so a test
 * can pin the whole table without a renderer.
 */
export const REVIEW_DISABLED_KEYS: Readonly<Record<ReviewLinkDisabled, MessageKey>> = Object.freeze({
  unknown_workspace: "turnDiff.review.absent.workspace",
  no_branch: "turnDiff.review.absent.branch",
  no_review_link: "turnDiff.review.absent.none",
  engine_unavailable: "turnDiff.review.absent.engine",
});

/** The states in which the control cannot open anything. */
export type ReviewLinkInertState = Exclude<ReviewLinkState, { readonly status: "available" }>;

/** The sentence for a state that cannot offer a clickable control. */
export function reviewDisabledReasonKey(state: ReviewLinkInertState): MessageKey {
  return state.status === "loading"
    ? "turnDiff.review.absent.loading"
    : REVIEW_DISABLED_KEYS[state.reason];
}

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

/**
 * One file's own line counts.
 *
 * A side at zero draws nothing rather than `+0` / `-0`: the desktop shows a
 * badge only for the side that moved, and a `+0` next to a file the engine did
 * record reads as a number the card made up. An unknown count is not zero, so
 * this component is only ever handed real numbers — `totalLineChanges` is the
 * gate that keeps a transcript-scanned row from reaching it.
 */
function LineCounts({
  additions,
  deletions,
  testId,
}: {
  readonly additions: number;
  readonly deletions: number;
  readonly testId: string;
}) {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span
      data-testid={`${testId}-wrapper`}
      className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-caption-small"
    >
      {additions > 0 ? (
        <span data-testid={testId} className="text-[color:var(--color-text_success_default)]">
          {`+${additions}`}
        </span>
      ) : null}
      {deletions > 0 ? (
        <span data-testid={`${testId}-deletions`} className="text-[color:var(--color-text_error_default)]">
          {`-${deletions}`}
        </span>
      ) : null}
    </span>
  );
}

export function EditedFilesCard({
  files,
  t,
  onOpenFile,
  canUndo,
  canReapply,
  onUndo,
  onRedo,
  busy,
  error,
  review,
  onOpenReview,
}: {
  readonly files: readonly EditedFile[];
  readonly t: (key: MessageKey) => string;
  readonly onOpenFile?: (path: string) => void;
  /** Straight from the engine's record. Never re-derived from a turn ordinal. */
  readonly canUndo?: boolean;
  /** Straight from the engine's record. Never re-derived from a turn ordinal. */
  readonly canReapply?: boolean;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  /** A mutation this card started is in flight. */
  readonly busy?: boolean;
  /** The last revert/reapply failure, shown verbatim. */
  readonly error?: TurnDiffFailure | null;
  /**
   * PB-16: what the engine knows about this workspace's review.
   *
   * `undefined` means the caller never asked (no conversation yet), and the
   * control is then NOT rendered — an unasked question has no answer to
   * disable. Every other state renders the button, enabled only for a link it
   * can really open.
   */
  readonly review?: ReviewLinkState;
  /** Opens the review. Required for an enabled control: no click path, no button. */
  readonly onOpenReview?: (link: ReviewLink) => void;
}) {
  const [state, setState] = useState<EditedFilesCardState>(initialEditedFilesCardState);
  // A1: with no files there is nothing truthful to say, so the card is not in
  // the tree at all — not an empty shell, not a 「0 个文件」 placeholder.
  if (files.length === 0) return null;

  const shown = state.expanded ? files : files.slice(0, COLLAPSED_FILE_ROWS);
  const hidden = files.length - shown.length;
  const title = t("activity.editedFiles").replace("{{count}}", String(files.length));
  // `null` for a transcript-scanned turn: the header then shows the file
  // count and nothing else rather than a `+0 / -0` the card cannot back up.
  const totals = totalLineChanges(files);
  // Gate AND handler, not gate alone: a button with no click path is exactly
  // the dead control #114 had to delete.
  const showUndo = canUndo === true && Boolean(onUndo);
  const showRedo = canReapply === true && Boolean(onRedo);
  // Same gate-and-handler rule as the two mutation buttons: an enabled control
  // needs a click path. A link with nowhere to go is drawn disabled, with the
  // engine's own sentence in its tooltip.
  const reviewLink = review && review.status === "available" ? review.link : null;
  const showReview = review !== undefined;
  const canReview = reviewLink !== null && Boolean(onOpenReview);
  // A link with no click path is the one state the reason table does not
  // cover, and it falls to `engine_unavailable` on purpose: nothing about this
  // control can be opened, so the tooltip must not promise a link.
  const inertReview: ReviewLinkInertState =
    review !== undefined && review.status !== "available"
      ? review
      : { status: "unavailable", reason: "engine_unavailable" };

  return (
    <section
      data-testid="edited-files-card"
      data-edited-files-count={files.length}
      data-has-turn-diff={totals === null ? "false" : "true"}
      data-can-undo={canUndo === true ? "true" : "false"}
      data-can-reapply={canReapply === true ? "true" : "false"}
      aria-label={title}
      className="mb-3 rounded-[10px] border border-border_default bg-bg_default_primary px-3 py-2.5"
    >
      <header className="flex items-center gap-2">
        <span className="text-icon_default_tertiary" data-testid="edited-files-card-icon">
          <Icon name="pencil" size={16} />
        </span>
        <span className="text-body-small-strong text-text_default_primary">{title}</span>
        {totals === null || (totals.additions <= 0 && totals.deletions <= 0) ? null : (
          <span
            data-testid="edited-files-card-totals"
            className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-caption-small"
          >
            {totals.additions > 0 ? (
              <span
                data-testid="edited-files-card-additions"
                className="text-[color:var(--color-text_success_default)]"
              >
                {`+${totals.additions}`}
              </span>
            ) : null}
            {totals.deletions > 0 ? (
              <span
                data-testid="edited-files-card-deletions"
                className="text-[color:var(--color-text_error_default)]"
              >
                {`-${totals.deletions}`}
              </span>
            ) : null}
          </span>
        )}
      </header>
      {error ? (
        <p
          data-testid="edited-files-card-error"
          data-error-kind={error.kind}
          className="mt-1.5 text-caption-small text-text_default_secondary"
        >
          {t("turnDiff.error")} {error.message}
        </p>
      ) : null}
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
            {typeof file.additions === "number" && typeof file.deletions === "number" ? (
              <LineCounts
                additions={file.additions}
                deletions={file.deletions}
                testId="edited-files-card-row-additions"
              />
            ) : null}
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
      {showUndo || showRedo || showReview ? (
        <div className="mt-1.5 flex items-center gap-3" data-testid="edited-files-card-actions">
          {showUndo ? (
            <button
              type="button"
              data-testid="edited-files-card-undo"
              disabled={busy === true}
              aria-busy={busy === true}
              onClick={() => onUndo?.()}
              className="text-caption-small text-text_default_tertiary transition-colors hover:text-text_default_primary disabled:opacity-60"
            >
              {busy === true ? t("turnDiff.working") : t("turnDiff.undo")}
            </button>
          ) : null}
          {showRedo ? (
            <button
              type="button"
              data-testid="edited-files-card-redo"
              disabled={busy === true}
              aria-busy={busy === true}
              onClick={() => onRedo?.()}
              className="text-caption-small text-text_default_tertiary transition-colors hover:text-text_default_primary disabled:opacity-60"
            >
              {busy === true ? t("turnDiff.working") : t("turnDiff.redo")}
            </button>
          ) : null}
          {/* Rightmost, as on the desktop card (06-browser-tree-tasks-review.jpg):
              撤销 then Review. Outlined there and here — the one control in this
              row that leaves the transcript, so it is the one that looks like it. */}
          {showReview ? (
            <button
              type="button"
              data-testid="edited-files-card-review"
              data-review-state={review?.status ?? "unavailable"}
              disabled={!canReview}
              aria-disabled={!canReview}
              title={
                canReview
                  ? t("turnDiff.review.open")
                  : `${t("turnDiff.review")} — ${t(reviewDisabledReasonKey(inertReview))}`
              }
              onClick={() => {
                if (canReview && reviewLink) onOpenReview?.(reviewLink);
              }}
              className="ml-auto rounded-[6px] border border-border_default px-2 py-0.5 text-caption-small text-text_default_primary transition-colors hover:bg-bg_default_secondary disabled:cursor-not-allowed disabled:border-border_weak disabled:text-text_default_tertiary"
            >
              {t("turnDiff.review")}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
