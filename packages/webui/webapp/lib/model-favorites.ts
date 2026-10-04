// webapp/lib/model-favorites.ts
//
// The starred-model set behind the selector's favourites section, and the
// pure toggle arithmetic behind it.
//
// Why localStorage and not the server: a star is a reading preference about
// THIS browser's list, not a fact about the account. Putting it on the wire
// would make it a per-account field that a model picker cannot express and
// that nothing else reads. It is also versioned, because a key whose stored
// shape can change must be able to move its version rather than be guessed at
// on read.
//
// The toggle is a pure function in its own right rather than a line inside
// the click handler, so the suite can drive the ORDER it returns — the star
// has to become the last-touched entry, because that order is what the
// favourites section falls back to when labels tie.

/** The storage key. The `v1` is load-bearing: see the file comment. */
export const MODEL_FAVORITES_KEY = "webui:model-favorites:v1";

/** A stored id list, guarded against a hand-edited or truncated value. */
function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Add or remove one id, returning the NEW list.
 *
 * Starring appends (so the array doubles as most-recent-first) and unstarring
 * removes every copy of the id — a hand-edited store can carry a duplicate,
 * and leaving one behind would render a model the user believes they unstarred.
 */
export function toggleFavoriteId(
  current: readonly string[],
  modelId: string,
): string[] {
  const id = modelId.trim();
  if (!id) return [...current];
  if (current.includes(id)) return current.filter((entry) => entry !== id);
  return [...current, id];
}

/** The persisted set, or empty when the store is absent or unreadable. */
export function readFavoriteModels(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MODEL_FAVORITES_KEY);
    if (!raw) return [];
    return toIdList(JSON.parse(raw));
  } catch {
    // A store written by an older build, or by a user with devtools open,
    // must not be able to take the selector down on open.
    return [];
  }
}

/** Persist the set. A store that refuses the write is not worth an error. */
export function writeFavoriteModels(ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(toIdList(ids)));
  } catch {
    // Private-mode and quota-exceeded both land here. The star still works
    // for this session; only the persistence is lost.
  }
}
