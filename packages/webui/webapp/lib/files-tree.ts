// webapp/lib/files-tree.ts
//
// Pure-logic helpers backing the collapsible file tree in
// `components/panels.tsx#FilesPanel`. The component owns the React
// state and side effects (fetch, sessionStorage, clipboard); this
// module owns the bits the webapp test suite can drive without a DOM
// — sort order, ancestor computation, filter-driven auto-expansion,
// and the persistence wire format.
//
// Why split it out: the panel was getting large enough that its
// interactions were hard to read end-to-end. Pulling the pure pieces
// here lets `webapp/test/files-tree.test.ts` pin every invariant
// directly. None of these helpers touch `fetch`, `document`, or
// `window`, so the test imports stay free of jsdom.
//
// Persistence channel: this slice stores `expanded` + `filter` +
// `showHidden` in `sessionStorage`, keyed per workspace directory.
// The ticket accepted either channel ("本片先落地到会话级存储/服务端
// settings 均可"). The trade-off: sessionStorage survives a page
// refresh but not a tab close, while server settings survive both.
// Ticket 07 ("重开页面状态一致") is the future owner of
// cross-restart durability; it will read what this slice writes and
// promote the storage when its policy lands. The on-disk shape
// (`{version, workspace, expanded, filter, showHidden}`) is shared
// between both channels so the migration is a read + rewrite, not a
// rewrite.

import type { FsEntry } from "./api";
import { matchFilter } from "./workspace-filter";

/** Maximum number of directory entries rendered in a single view.
 *  Mirrors the server cap (`server/lib/fs-util.js#readDirectory`
 *  default `limit = 500`); when `skipped > 0` the row count above the
 *  cap must be shown explicitly rather than silently dropped. */
export const FILES_VISIBLE_LIMIT = 500;

export interface ExpandedState {
  /** Path set the user has explicitly opened in this workspace. */
  expanded: string[];
  /** Last filter string the user typed. Empty means no filter. */
  filter: string;
  /** Whether dot-files participate in the listing. */
  showHidden: boolean;
}

export const EXPANDED_STATE_VERSION = 1;

/**
 * Comparator for the per-directory ordering rule.
 *
 * Rule (carried over from the legacy flat browser): directories first,
 * then files; within each group, alphabetical by `localeCompare`. The
 * server already returns this order in `readDirectory`, but we still
 * sort here because filter operations clone + reorder the array, and
 * the same shape needs to apply after a filter narrows the list.
 */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  const copy = entries.slice();
  copy.sort((a, b) => {
    const aDir = a.type === "dir";
    const bDir = b.type === "dir";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return copy;
}

/**
 * Return the ancestor paths of `target`, exclusive of `target` itself
 * and exclusive of `root`. The tree root is implicit; the caller
 * passes it as the stopping point.
 *
 * Example: `ancestorsOf('/a/b/c', '/a')` → `['/a/b']`. (Excludes both
 * the target and the root.)
 *
 * The function is robust to relative-style paths and to the empty
 * string; empty / falsy `target` returns `[]`.
 */
export function ancestorsOf(target: string, root: string): string[] {
  if (!target) return [];
  if (target === root) return [];
  const normalisedTarget = stripTrailingSlash(target);
  const out: string[] = [];
  // Walk via parent segments. We avoid `path.posix.dirname` so this
  // module stays pure-JS and browser-safe (no node:path import).
  //
  // The accumulation rule is: collect `cursor` only when `parent` is
  // still inside the workspace. Once we step above the root we stop
  // — entries above the root are not ancestors the tree should
  // reveal.
  let cursor = normalisedTarget;
  while (cursor && cursor !== root) {
    const parent = parentOf(cursor);
    if (!parent || parent === cursor) break;
    if (!isInside(parent, root)) break;
    out.unshift(cursor);
    if (parent === root) break;
    cursor = parent;
  }
  // Drop the target itself if the loop prepended it (compare against
  // the stripped form so a trailing slash on the caller's input does
  // not let the target leak back in).
  if (out[out.length - 1] === normalisedTarget) out.pop();
  return out;
}

function isInside(p: string, root: string): boolean {
  if (root === "/") return p.startsWith("/");
  return p === root || p.startsWith(root + "/");
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

/**
 * Given a map of already-loaded directory listings, plus an optional
 * pre-existing expanded set, return the expanded-set that reveals
 * every entry matching `pattern`. Ancestors that are not yet loaded
 * are still added — they will lazy-fetch on next render.
 *
 * The "ancestor for filter hit" walk only traverses loaded nodes; an
 * unloaded ancestor's children are not in scope, so a hidden match
 * deep inside a never-expanded subtree is silently absent. That is
 * the intended trade-off against recursive prefetch: the user sees
 * only what they (or the filter) opened.
 */
export function filterAncestors(
  loaded: Record<string, FsEntry[]>,
  pattern: string,
  root: string,
  initialExpanded: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>(initialExpanded);
  if (!pattern.trim()) return next;
  // Pre-compute the set of loaded directories whose OWN entries match.
  // Ancestors are walked up the path of each matching entry.
  for (const [dirPath, entries] of Object.entries(loaded)) {
    for (const entry of entries) {
      if (entry.type === "dir") continue; // folders aren't themselves file hits
      if (!matchFilter(entry.name, pattern)) continue;
      for (const ancestor of ancestorsOf(dirPath, root)) {
        next.add(ancestor);
      }
      // Also expose the directory the match lives in.
      next.add(dirPath);
    }
  }
  return next;
}

/**
 * Filter entries by the pattern, returning the visible slice plus a
 * count of the rows that did not fit under `FILES_VISIBLE_LIMIT`. The
 * filter is applied first so the cap bounds the matches, not the
 * directory — otherwise a wide glob on a noisy folder would silently
 * show nothing (the rows the user was looking for were cut before the
 * filter ran).
 */
export function applyFilterAndCap(
  entries: FsEntry[],
  pattern: string,
  limit: number = FILES_VISIBLE_LIMIT,
): { visible: FsEntry[]; hidden: number; matched: number } {
  const sorted = sortEntries(entries);
  const matched = pattern.trim()
    ? sorted.filter((entry) => matchFilter(entry.name, pattern))
    : sorted;
  const visible = matched.slice(0, limit);
  return { visible, hidden: matched.length - visible.length, matched: matched.length };
}

/**
 * Serialize an expanded set + filter + showHidden flag for the
 * persistence channel. The wire format is a flat JSON object; the
 * `version` field lets future ticket-07 migrations reject old payloads
 * instead of silently interpreting them.
 */
export function serializeExpansion(
  state: ExpandedState,
  workspaceDir: string,
): string {
  const payload = {
    version: EXPANDED_STATE_VERSION,
    workspace: workspaceDir,
    expanded: dedupe(state.expanded).sort(),
    filter: state.filter,
    showHidden: state.showHidden,
  };
  return JSON.stringify(payload);
}

export function deserializeExpansion(raw: string | null | undefined, workspaceDir: string): ExpandedState {
  if (!raw) return { expanded: [], filter: "", showHidden: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { expanded: [], filter: "", showHidden: false };
  }
  if (!parsed || typeof parsed !== "object") return { expanded: [], filter: "", showHidden: false };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== EXPANDED_STATE_VERSION) return { expanded: [], filter: "", showHidden: false };
  // Workspace mismatch: the persisted slice is per-workspace; if the
  // user switched projects, drop the previous project's tree rather
  // than apply it on top of the new one.
  if (typeof obj.workspace === "string" && obj.workspace !== workspaceDir) {
    return { expanded: [], filter: "", showHidden: false };
  }
  const expanded = Array.isArray(obj.expanded)
    ? dedupe(obj.expanded.filter((p): p is string => typeof p === "string"))
    : [];
  const filter = typeof obj.filter === "string" ? obj.filter : "";
  const showHidden = obj.showHidden === true;
  return { expanded, filter, showHidden };
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Visual class for the small color chip drawn beside a file row.
 * Approximates the upstream desktop's file-type colour cues (md blue,
 * env / lock red, json green, yaml / yml purple, images purple, code
 * blue, log orange) so the rendered row reads at a glance. The
 * upstream shows inline type icons, but no upstream icon set ships
 * per-extension glyphs — a coloured dot is the smallest visual hook
 * that does not need a new icon registry.
 */
export function fileTypeColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.endsWith(".env") || lower === "dockerfile" || lower.endsWith(".dockerfile")) {
    return "text-text_status_warning";
  }
  if (lower.endsWith(".lock") || lower === "package-lock.json" || lower === "yarn.lock" || lower === "pnpm-lock.yaml") {
    return "text-text_status_warning";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "text-text_status_positive";
  }
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) {
    return "text-text_status_positive";
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".toml")) {
    return "text-icon_default_accent";
  }
  if (
    lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") ||
    lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs") ||
    lower.endsWith(".py") || lower.endsWith(".go") || lower.endsWith(".rs")
  ) {
    return "text-text_default_secondary";
  }
  if (
    lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") || lower.endsWith(".svg") || lower.endsWith(".webp")
  ) {
    return "text-icon_default_accent";
  }
  if (lower.endsWith(".log")) {
    return "text-text_status_warning";
  }
  return "text-text_default_tertiary";
}

/**
 * Should the directory row render its "加载中…" suffix?
 *
 * Two states look superficially the same on screen — a row exists
 * for a dir but its body text is empty / light — but they must be
 * rendered differently:
 *
 *   - **placeholder**: the row exists because its parent told us
 *     there was a directory here, but we have NOT issued a fetch
 *     yet. The target desktop UI shows only the folder name; no
 *     spinner, no "loading…" text. A sidebar of 30 collapsed dirs
 *     therefore renders 30 plain folder rows, not 30 "loading…"
 *     labels.
 *
 *   - **fetching**: a fetch IS in flight for a node that already
 *     has cache state (a refresh, or the auto-rehydration on
 *     page-load that re-issues requests for persisted `expanded`
 *     paths). The "加载中…" suffix is rendered so the user knows
 *     the action they triggered is still in progress.
 *
 * The rule is therefore: show the suffix only when `loading` is
 * true AND `placeholder` is false. Everything else (idle, errored,
 * or placeholder for a never-fetched dir) renders no suffix.
 *
 * Pinned in `webapp/test/files-tree.test.ts#shouldShowDirLoadingSuffix`.
 */
export function shouldShowDirLoadingSuffix(
  loading: boolean,
  placeholder: boolean,
): boolean {
  return loading === true && placeholder !== true;
}

/**
 * Render an mtime (ms epoch) as a coarse relative-time string. The
 * component uses the i18n strings; this helper returns the untranslated
 * bucket key so the component can interpolate `t(...)` itself.
 */
export function relativeMtimeBucket(nowMs: number, mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs)) return "";
  const delta = Math.max(0, nowMs - mtimeMs);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  if (delta < min) return "now";
  if (delta < hour) return `minutesAgo:${Math.floor(delta / min)}`;
  if (delta < day) return `hoursAgo:${Math.floor(delta / hour)}`;
  if (delta < week) return `daysAgo:${Math.floor(delta / day)}`;
  if (delta < month) return `weeksAgo:${Math.floor(delta / week)}`;
  if (delta < year) return `monthsAgo:${Math.floor(delta / month)}`;
  return `yearsAgo:${Math.floor(delta / year)}`;
}

/**
 * Format a byte count as a short human-readable size. Same rule the
 * legacy flat browser used: B / KB / MB / GB, one decimal below 10
 * otherwise rounded.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}
