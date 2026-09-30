// webapp/lib/edited-files.ts — which files this turn's edit tools touched.
//
// Ticket 77 (G3 of ticket 61). The desktop's 「已编辑 N 个文件」 card is fed by
// a turn-level changeset the runtime owns. This repo has no such contract, so
// this module derives the one thing the transcript *does* carry truthfully: the
// file paths the turn's `file-edit` tool calls named, de-duplicated.
//
// What this deliberately does NOT produce, and why (see
// `.tickets/webui-parity/77-edited-files-card.md` for the full audit):
//
//   * per-file added/deleted line counts — the transcript records no line
//     statistics, and `LocalTurnFileChangeCaptureService` (the runtime's real
//     changeset producer) is not reachable per turn from webui;
//   * an undo affordance — no per-turn revert endpoint exists.
//
// Guessing either would put invented numbers in front of the user, so callers
// get `null` / an empty list instead and render nothing.

import { isFileEditTool, type RenderUnit } from "./transcript";

/** One file the turn's edit tools named, in the transcript's own terms. */
export interface EditedFile {
  /** Workspace-normalised path, exactly as the decoder produced it. */
  readonly path: string;
  /** The trailing path segment — what the desktop card's file row shows. */
  readonly name: string;
}

/** The turn's edited files, in first-seen order. Empty means "nothing to say". */
export type EditedFiles = readonly EditedFile[];

/**
 * Distinct files written by this turn's edit tool calls, in first-seen order.
 *
 * Only `activity` units carry tool blocks; plain `block` units are prose and
 * are skipped. An edit tool that named no path (a `bash` heredoc, an unparsed
 * arg shape) contributes nothing rather than a placeholder row — the count in
 * the card header is a count of files we can actually name.
 */
export function collectEditedFiles(units: readonly RenderUnit[]): EditedFiles {
  const files: EditedFile[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    if (unit.kind !== "activity") continue;
    for (const block of unit.blocks) {
      if (block.role !== "tool" || !isFileEditTool(block.toolName)) continue;
      for (const path of block.toolPaths ?? []) {
        const key = dedupeKey(path);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        files.push({ path, name: basenameOf(path) });
      }
    }
  }
  return files;
}

/**
 * Identity for "the same file named twice".
 *
 * Separators are folded so a Windows-style `a\b.ts` and an `a/b.ts` do not read
 * as two files. Case is left alone on purpose: macOS and Linux are
 * case-sensitive, and folding case there would merge two genuinely distinct
 * files into one row.
 */
function dedupeKey(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

/** The trailing path segment, with both separator styles honoured. */
export function basenameOf(path: string): string {
  const normalised = dedupeKey(path);
  const index = normalised.lastIndexOf("/");
  return index === -1 ? normalised : normalised.slice(index + 1);
}
