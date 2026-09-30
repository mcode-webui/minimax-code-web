// webapp/lib/edited-files.ts — which files each turn edited, and what it cost.
//
// Ticket 77 (G3 of ticket 61) derived one thing: the file paths a turn's
// `file-edit` tool calls named, de-duplicated. Webui-parity 83 replaced the
// guesswork with the engine's own per-turn record, and this module now holds
// BOTH tiers, with one rule between them:
//
//   * no engine record → the transcript's own paths, and NOTHING else. No
//     `+0`, no disabled button, no grey placeholder. A card that draws
//     "0 additions" says the turn changed nothing; it may simply predate the
//     record. The absence is reported as an absence (`counts === undefined`).
//   * an engine record → the record REPLACES the scan, it does not merge with
//     it. The engine captured what actually landed on disk; the tool scan only
//     knows what a tool was *asked* to write. A tool that failed leaves a path
//     in the scan and nothing in the record, and a write the scan never saw
//     (`bash` heredoc, a patch applied by a subagent) is in the record only.
//     Picking one authority per turn is what stops the header count and the
//     line totals from describing two different sets of files.
//
// Which record to ask for is decided elsewhere (`lib/turn-diff.ts`): by the
// turn's `assistantMessageId`, never by a turn ordinal, because the engine's
// selector falls back to the session's LATEST turn when handed no id.

import { editedFileKey, isFileEditTool, type RenderUnit } from "./transcript";
import type { FileDiffInfo, TurnDiff } from "./turn-diff";

/** One file the turn edited, in the transcript's own terms. */
export interface EditedFile {
  /** Workspace-normalised path, exactly as the decoder produced it. */
  readonly path: string;
  /** The trailing path segment — what the desktop card's file row shows. */
  readonly name: string;
  /**
   * Lines the engine recorded as added, or `undefined` when this row comes
   * from the transcript scan rather than an engine record. `undefined` is not
   * zero and must never be rendered as `+0` — see the module header.
   */
  readonly additions?: number;
  /** Deleted lines, with the same `undefined`-means-unknown contract. */
  readonly deletions?: number;
}

/** The turn's edited files, in first-seen order. Empty means "nothing to say". */
export type EditedFiles = readonly EditedFile[];

/**
// "The same file named twice" is decided by `editedFileKey`, which this module
// does NOT own: it lives in `lib/transcript.ts` beside `isFileEditTool`, so the
// activity-group summary and this card count files on one key by construction.
// A private copy here would be a second caliber, and the two would drift the
// moment either side folded a separator differently.

/** The trailing path segment, with both separator styles honoured. */
export function basenameOf(path: string): string {
  const normalised = editedFileKey(path);
  const index = normalised.lastIndexOf("/");
  return index === -1 ? normalised : normalised.slice(index + 1);
}

// --- per-turn aggregation (webui-parity 83) -------------------------------

/**
 * The transcript's own per-turn file lists, keyed by turn ordinal.
 *
 * `turnIndexByUnit` is `computeTurnLayout`'s layout ordinal — it says which
 * turn a unit *renders* in, which is what a per-turn card needs. It is NOT an
 * engine selector: turns with no file change never reach the engine's table at
 * all, so the two sequences drift. The ordinals here only ever pair a unit
 * with the turn it is drawn in.
 *
 * Distinctness is `editedFileKey`, the summary's own key, so a file named five
 * times in one turn is one file here and one file in the group header above it.
 */
export function collectEditedFilesByTurn(
  units: readonly RenderUnit[],
  turnIndexByUnit: readonly number[],
): ReadonlyMap<number, EditedFiles> {
  const byTurn = new Map<number, EditedFile[]>();
  units.forEach((unit, index) => {
    const turnIndex = turnIndexByUnit[index];
    if (turnIndex === undefined) return;
    if (unit.kind !== "activity") return;
    const seen = new Set(byTurn.get(turnIndex)?.map((f) => editedFileKey(f.path)) ?? []);
    for (const block of unit.blocks) {
      if (block.role !== "tool" || !isFileEditTool(block.toolName)) continue;
      for (const path of block.toolPaths ?? []) {
        const key = editedFileKey(path);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const files = byTurn.get(turnIndex) ?? [];
        files.push({ path, name: basenameOf(path) });
        byTurn.set(turnIndex, files);
      }
    }
  });
  return byTurn;
}

/**
 * The files this turn's card should list, and where they came from.
 *
 * `diff` is the engine's record for THIS turn's coordinate. Present → it is
 * the whole answer (with real line counts). Absent → the transcript's own
 * scan, with no counts, which renders exactly the ticket-77 card.
 */
export function resolveEditedFiles(
  scanned: EditedFiles,
  diff: TurnDiff | null | undefined,
): EditedFiles {
  if (!diff) return scanned;
  return diff.fileChanges.map((change) => toEditedFile(change));
}

/** One engine file-change row in the card's vocabulary. */
function toEditedFile(change: FileDiffInfo): EditedFile {
  return {
    path: change.file,
    name: basenameOf(change.file),
    additions: change.additions,
    deletions: change.deletions,
  };
}

/**
 * The header's `+N -N` totals, or `null` when the turn has no counts.
 *
 * `null` is the honest answer for a transcript-scanned turn and for an empty
 * one; the card then draws no totals at all. Returning `0` would be a claim
 * ("this turn added nothing") that the data does not support — the same
 * failure mode as a disabled button, and the one this card has to avoid.
 */
export function totalLineChanges(
  files: EditedFiles,
): { readonly additions: number; readonly deletions: number } | null {
  if (files.length === 0) return null;
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    if (typeof file.additions !== "number" || typeof file.deletions !== "number") {
      return null;
    }
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

/**
 * Turn ordinal → the engine coordinate for that turn.
 *
 * The coordinate is the `assistantMessageId` `decodeTranscript` attached from
 * the `§§ turn_msg=<id>` marker, and the value the engine persisted the turn's
 * record under. A turn with no marker (recorded before the marker shipped,
 * read through the legacy probe, or run over the exec transport) is simply
 * absent from the map, and its card stays the path-only one.
 *
 * Only the LAST assistant block of a turn is consulted: the engine stores the
 * turn's final assistant message id, and a turn split by a tool call has
 * several blocks. Taking the first would ask the engine about a message it
 * never keyed a record to.
 */
export function turnCoordinatesByTurn(
  units: readonly RenderUnit[],
  turnIndexByUnit: readonly number[],
): ReadonlyMap<number, string> {
  const coordinates = new Map<number, string>();
  units.forEach((unit, index) => {
    const turnIndex = turnIndexByUnit[index];
    if (turnIndex === undefined) return;
    if (unit.kind !== "block" || unit.block.role !== "assistant") return;
    const id = unit.block.assistantMessageId;
    if (id) coordinates.set(turnIndex, id);
  });
  return coordinates;
}

/**
 * True when unit `index` is the LAST unit of its turn — the turn's card slot.
 *
 * The card is a turn footer, so it renders after the turn's final block. A
 * user block opens the next turn, so the unit before it is always a tail; a
 * transcript that ends on a user block (a prompt just sent) has no closed turn
 * to hang a card on, and correctly yields no tail at all.
 */
export function isTurnTailUnit(
  turnIndexByUnit: readonly number[],
  index: number,
): boolean {
  const turnIndex = turnIndexByUnit[index];
  if (turnIndex === undefined) return false;
  const next = turnIndexByUnit[index + 1];
  return next === undefined || next !== turnIndex;
}
