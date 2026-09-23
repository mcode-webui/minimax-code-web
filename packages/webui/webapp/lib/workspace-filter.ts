// Glob-style matcher for the workspace picker's filter input. The semantics the
// placeholder promises ("Filter… (globs like *.txt)") are: `*` matches any run
// of characters, `?` matches a single character, everything else is taken
// literally, and the comparison is case-insensitive. The matcher is
// intentionally tiny — there is no character-class support, no alternation, no
// anchors beyond "^…$" — because the picker has never promised those.
//
// Kept as a pure function so the panel can hand it `(name, pattern)` and so
// `webapp/test/workspace-filter.test.ts` can exercise every branch without a
// DOM. The panel applies it after the server returns the listing, *not* in
// place of the server's query — the `FILES_VISIBLE_LIMIT` cap that the file
// browser already enforces therefore still bounds what is rendered.

/**
 * Escape regex metacharacters so a glob pattern is safe to compile.
 *
 * `*` and `?` are glob operators and are translated separately, after this
 * pass.
 */
function escapeRegex(source: string): string {
  return source.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a glob pattern into a RegExp.
 *
 * - `*` → `.*` (any run of chars)
 * - `?` → `.`  (any single char)
 * - everything else is literal (regex metacharacters are escaped first)
 *
 * Case-insensitive, anchored at both ends. Empty patterns compile to a
 * regex that never matches — callers should treat an empty pattern as "no
 * filter" rather than running this through.
 */
export function globToRegex(pattern: string): RegExp {
  const body = escapeRegex(pattern).replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/**
 * Match `name` against `pattern`. Returns `true` for an empty pattern (no
 * filter applied) so callers can pass the raw input straight in without
 * branching on whether the user has typed anything.
 */
export function matchFilter(name: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return true;
  return globToRegex(trimmed).test(name);
}