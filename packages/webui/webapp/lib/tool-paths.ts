// webapp/lib/tool-paths.ts
//
// Slice 20 (webui-parity): derive candidate file paths for the turn-
// summary chip row from a tool call's name + JSON arguments.
//
// Why this exists.
// The `  @ <path>` body the server writes is driven by
// `tool_update.locations`, and a direct read of the engine's own runtime
// sqlite (`SELECT data_json LIKE '%"locations":[%'`) returns 0 of 7,609
// real tool calls — the engine does not emit `locations` in normal
// operation, so the chip row upstream `ToolCard` already renders was
// always empty in real sessions. Tool inputs ARE the data that actually
// exists, and this module extracts the path-shaped fields they carry.
//
// Public surface:
//   extractToolPaths(toolName, toolArgs, opts) → string[] | undefined
//
// The decoder in lib/transcript.ts wires this in alongside the existing
// `  @ path` source so the chip row lights up from the data the engine
// actually emits today AND keeps working if the engine ever starts
// emitting `tool_update.locations`. Both sources merge and dedupe
// before the chip row paints.
//
// Glob/grep pattern decision (called out so a reviewer does not have
// to guess):
//   • glob's `pattern` is a search SCOPE across many files (e.g.
//     `**/*.desktop`, `src/**/foo.ts`); promoting it to a single
//     "file chip" would mislead the user, and there is no second
//     `path`-shaped field to fall back on. NO chip is emitted for glob.
//   • grep's `pattern` is the SEARCH TERM, not a file path. A chip
//     labelled with `用户假设` is useless. grep ALSO accepts a `path`
//     argument for the search scope (confirmed against 372 real
//     `grep` tool calls in the engine's own sqlite: every observed
//     call carries a `path`). We extract that `path` and ignore
//     `pattern`. A grep with no `path` (whole-tree search) yields no
//     chip rather than a fake one.
//   • bash's `command` regularly embeds real paths but they are mixed
//     with everything else the shell did; regex-harvesting them would
//     surface every file the agent glanced at. bash has no
//     first-class "this is the file I touched" field. NO chip is
//     emitted for bash.

/** Per-call cap. Tool args can list a single file or a tiny array of
 *  files; 10 is a generous ceiling that still fits the chip row. */
export const TOOL_PATHS_PER_CALL = 10;

export interface ExtractToolPathsOptions {
  /**
   * Workspace directory the chat is bound to (`state.workspace.dir`).
   * Relative paths returned by the tool are absolutised against this
   * so the chip click can hit the file-open endpoint without a
   * second round-trip. `null` or `""` means "no workspace known";
   * relative paths stay relative and the user sees them as-is.
   */
  workspaceDir?: string | null;
}

// Tool name → which JSON field carries the path. Lower-cased keys so
// the lookup tolerates the variety of names the engine actually emits
// (`read`/`Read`/`READ`/`readFile`, `notebook_read` / `NotebookRead`,
// etc.). Every key here is matched case-insensitively against the
// caller-supplied tool name.
//
// Field choice rationale:
//   read-family tools → `path` (the engine's actual schema)
//   write / edit-family → `path` for write, `file_path` for edit
//                          (both shapes observed in real data)
//   notebook_*        → `notebook_path` (a notebook URI, not a fs path;
//                          still useful as a chip when a notebook
//                          preview is ever wired up)
//   grep / search     → `path` (the search scope; NOT `pattern`)
//
// Notes per tool:
//   - `read` and `read_file` both map to `path`.
//   - `write`, `create_file`, `write_file` all map to `path`.
//   - `edit`, `apply_patch`, `str_replace`, `multi_edit`, `notebook_edit`
//     map to `file_path`. `notebook_edit` could in principle also
//     accept `notebook_path`, but the live data shows it always uses
//     `file_path`; staying conservative avoids guessing wrong.
//   - `grep` / `search` map to `path` — the scope, not the term.
const TOOL_PATH_FIELDS: Record<string, readonly string[]> = {
  read: ["path"],
  read_file: ["path"],
  view: ["path"],
  view_file: ["path"],

  write: ["path"],
  write_file: ["path"],
  create_file: ["path"],

  edit: ["file_path", "path"],
  edit_file: ["file_path", "path"],
  apply_patch: ["file_path", "path"],
  multi_edit: ["file_path", "path"],
  str_replace: ["file_path", "path"],
  file_edit: ["file_path", "path"],
  notebook_edit: ["file_path", "notebook_path"],

  notebook_read: ["notebook_path", "path"],

  grep: ["path"],
  search: ["path"],
  find: ["path"],
  workspace_semantic_search: ["path"],

  // glob intentionally omitted — see header comment.
};

/**
 * Extract candidate file paths from a tool call's name + arguments.
 *
 * The arguments string is the raw JSON the server wrote after the
 * `→ name` header (`server/lib/mcode-acp.js` does `JSON.stringify(rawInput)`
 * — note there is NO leading space; the two-space separator is the
 * line grammar). The decoder's `block.toolArgs` value carries exactly
 * that string, with leading whitespace stripped, so this function can
 * be fed `block.toolArgs` directly.
 *
 * Returns `undefined` when nothing usable was found, so callers can
 * spread the result onto `block.toolPaths` without polluting the array
 * with an empty marker. Returns `string[]` (possibly empty after the
 * caller merges with `@ path` lines) when at least one candidate
 * survived the filters.
 *
 * Guarantees:
 *   - Glob / grep-pattern calls NEVER return the search term.
 *   - Bash calls NEVER regex-mine paths out of `command`.
 *   - Relative paths get absolutised against `workspaceDir` only when
 *     `workspaceDir` is a non-empty string. The caller passes
 *     `state.workspace.dir`; for the default workspace that resolves
 *     to a real absolute path, for an unset workspace the call is a
 *     no-op and the path is returned unchanged.
 *   - Output is deduped (first occurrence wins) and capped at
 *     `TOOL_PATHS_PER_CALL`.
 */
export function extractToolPaths(
  toolName: string | undefined,
  toolArgs: string | undefined,
  opts: ExtractToolPathsOptions = {},
): string[] | undefined {
  const name = (toolName ?? "").trim();
  if (!name) return undefined;
  const lowered = name.toLowerCase();

  // Glob's pattern is a search scope, not a file path — never extract.
  // We keep the gate explicit (rather than just omitting from the map)
  // because a future schema might add a `path` field and we want the
  // decision to be visible at the call site.
  if (lowered === "glob") return undefined;
  // Bash's command embeds paths but they are not "files the tool
  // touched" in any clean sense; mining them produces noisy chips.
  if (lowered === "bash" || lowered === "shell" || lowered === "run_command" ||
      lowered === "execute_command" || lowered === "terminal" || lowered === "command") {
    return undefined;
  }

  const fields = TOOL_PATH_FIELDS[lowered];
  if (!fields) return undefined;

  const args = (toolArgs ?? "").trim();
  if (!args) return undefined;
  const parsed = safeParseJson(args);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field];
    for (const candidate of collectStringValues(value)) {
      const normalised = normalisePath(candidate, opts.workspaceDir);
      if (!normalised) continue;
      if (seen.has(normalised)) continue;
      seen.add(normalised);
      out.push(normalised);
      if (out.length >= TOOL_PATHS_PER_CALL) return out;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * `JSON.parse` is permissive — it accepts `{"path":/foo/}`? No, that
 * is not valid JSON. The decoder-side contract is well-formed JSON
 * because the server does `JSON.stringify(rawInput)`; if the field is
 * malformed JSON we treat it as "no path" (return undefined). This
 * keeps an upstream bug from crashing the decoder.
 */
function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Flatten a parsed JSON value into the candidate string paths it
 * might be hiding in. A field can be:
 *   - a plain string (`"path":"/abs/foo.ts"`) → one candidate
 *   - a string with surrounding whitespace / quotes (`"  '/abs/foo.ts'  "`) → one candidate
 *   - an array of strings (`"path":["a.ts","b.ts"]`) → many candidates
 *   - null / undefined / object → no candidates
 *
 * Objects are not stringified into a path; that would surface
 * internal IPC shapes (e.g. notebook metadata) as opaque chips. The
 * upstream tools that have a list of files pass them as a JSON array,
 * not an object keyed by something we can guess.
 */
function collectStringValues(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") out.push(item);
    }
    return out;
  }
  return [];
}

/**
 * Normalise a single path string:
 *   - trim
 *   - strip one layer of surrounding single/double quotes (some
 *     shells / agents wrap args; observed in real transcripts)
 *   - unescape the simple JSON escapes a path can carry (\\ -> \, \" -> ")
 *   - drop empty / whitespace / "."
 *   - absolutise a relative path against `workspaceDir` (when present
 *     and itself an absolute path)
 *   - leave absolute paths, `~`-prefixed paths, and paths that look
 *     like URLs untouched (the file-open endpoint rejects URLs already;
 *     a stray chip is the failure mode; "open the wrong thing" is
 *     not on the table because the server gates containment)
 */
export function normalisePath(raw: string, workspaceDir?: string | null): string | null {
  let p = raw;
  // JSON unescape (the server's stringify already did this; we re-do
  // it for any manually-typed or test-side string that bypassed JSON).
  p = p.replace(/\\([\\"'ntr])/g, (_, ch) =>
    ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "r" ? "\r" : ch,
  );
  // Strip surrounding single or double quotes once. Repeat so a
  // path like `""'/abs/foo'""` (rare) collapses too.
  for (let i = 0; i < 2; i++) {
    if (p.length >= 2 && (p.startsWith('"') && p.endsWith('"') || p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1);
    }
  }
  p = p.trim();
  if (!p || p === "." || p === "./") return null;

  // URL or home-relative — leave untouched.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p;
  if (p.startsWith("~")) return p;

  // Absolute paths stay absolute.
  if (p.startsWith("/")) return collapseTrailingSlash(p);

  // Relative — absolutise against the workspace when we have one.
  // Workspace dir must itself look absolute; a misconfigured "" or
  // null falls through and we leave the path relative. The chip will
  // still display, the click just won't open (the server gates).
  const ws = (workspaceDir ?? "").trim();
  if (ws && ws.startsWith("/")) {
    // Drop any leading "./" segments then join with a single "/".
    const rel = p.replace(/^\.\//, "");
    return collapseTrailingSlash(ws.replace(/\/+$/, "") + "/" + rel);
  }
  return collapseTrailingSlash(p);
}

function collapseTrailingSlash(p: string): string {
  if (p.length <= 1) return p;
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}