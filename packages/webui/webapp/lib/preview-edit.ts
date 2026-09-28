/**
 * Preview-edit decision helpers (slice 27 — preview toolbar).
 *
 * The toolbar's affordances are pure functions of (preview kind, path)
 * so the component stays a presenter and the rules are unit-testable
 * without React:
 *
 *   - `canEditPreview(kind)` — WHICH renderer shapes have an honest
 *     text round-trip (markdown + code: the editor shows exactly the
 *     bytes the read returned). Images and the unsupported placeholder
 *     never offer editing.
 *   - `editRequiresCredentialConfirm(path)` — WHICH paths must pass the
 *     explicit confirmation card before the editor opens. It is the
 *     same slice-16 predicate the server re-checks on save
 *     (`lib/credential-file.ts` on both sides); the client gate is UX,
 *     the server gate is the boundary.
 *   - `formatSaveClock(date)` — the "已保存 HH:MM" stamp.
 */

import type { PreviewKind } from "./file-preview";
import { isCredentialPath } from "./credential-file";

/** May this preview kind flip into the text editor? */
export function canEditPreview(kind: PreviewKind | null): boolean {
  if (kind === null) return false;
  return kind === "markdown" || kind === "code";
}

/**
 * Must the user pass the credential confirmation card before this
 * path's editor opens? True exactly for the slice-16 credential
 * shapes; the server refuses the actual save without `confirm` anyway,
 * so this only decides whether the UI asks BEFORE the user types.
 */
export function editRequiresCredentialConfirm(path: string): boolean {
  return isCredentialPath(path);
}

/** Local HH:MM for the save stamp (both locales render digits). */
export function formatSaveClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
