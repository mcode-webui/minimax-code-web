// server/lib/glob-filter.js — server-side port of the workspace-filter
// glob matcher.
//
// Why a server copy of webapp/lib/workspace-filter.ts. The webapp's
// matchFilter is the canonical file-glob predicate (matches a single
// basenames against `*`/`?` patterns, case-insensitive, anchored).
// The server uses it inside the bounded search walker
// (lib/fs-search.js); the `node:test` runner cannot import the TS
// source without tsx, and the route itself is plain Node. Two
// implementations of the same 6 lines is intentional — they share
// the regression test `webapp/test/workspace-filter.test.ts` for the
// user-facing semantics and a server-side unit test for the canonical
// match table (server/test/lib/glob-filter.test.js).
//
// What this must NOT drift on. The semantics the placeholder
// promises (`*` any run, `?` one char, escape regex
// metacharacters, anchored) — adding `[]` / `{}` / `^…$` here
// would silently change what `/api/fs/search?q=…` accepts and what
// the placeholder advertises.

/**
 * Escape regex metacharacters so a glob pattern is safe to compile.
 * `*` and `?` are translated after this pass.
 */
function escapeRegex(source) {
  return String(source).replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob pattern into a case-insensitive anchored RegExp.
 *
 * - `*` -> `.*` (any run of chars)
 * - `?` -> `.`  (any single char)
 * - everything else literal (regex metachars escaped first)
 *
 * An empty pattern compiles to a regex that never matches — callers
 * MUST reject empty `q` before reaching here so they don't silently
 * return zero matches on a malformed input.
 */
export function globToRegex(pattern) {
  const body = escapeRegex(pattern).replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/**
 * Match `name` against `pattern`. Returns `false` for empty patterns
 * (server-side: empty `q` is a 400, never "everything matches").
 */
export function matchFilter(name, pattern) {
  if (typeof pattern !== "string") return false;
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (typeof name !== "string" || !name) return false;
  return globToRegex(trimmed).test(name);
}
