import type { GitStatusFile } from "./api";

/**
 * Pure routing / bucketing logic for the right-panel Git panel
 * (slice 03). Extracted from the React surface so unit tests can pin
 * the mapping without spinning up React — Node's loader does not
 * honour the Next.js `@/lib/...` alias the component itself uses.
 *
 * What lives here:
 *   - `splitFilesByBucket` — porcelain-status → staged / unstaged /
 *     untracked grouping. Mirrors what `git status -s` would print
 *     and what the `/review` slash command renders into the chat.
 *   - `formatStatusTags` — short visual chip for the file row
 *     (e.g. "M " for "M ", "??" for untracked).
 *   - `describeCleanliness` — single-line summary string for the
 *     panel header (clean / dirty / not-repo / no-workspace).
 *
 * What does NOT live here:
 *   - Network calls. The panel fetches via `lib/api.ts` and feeds the
 *     payload through these helpers.
 *   - React components. See `components/panels.tsx#GitPanel`.
 */

/**
 * Three buckets the panel renders, matching the TUI `/review`
 * command's output. `staged` is the index side, `unstaged` is the
 * worktree side, `untracked` is the files `git status` lists as `??`.
 */
export interface GitBuckets {
  staged: GitStatusFile[];
  unstaged: GitStatusFile[];
  untracked: GitStatusFile[];
}

export type CleanlinessState =
  | "no-workspace"
  | "not-repo"
  | "error"
  | "clean"
  | "dirty";

export interface CleanlinessReport {
  state: CleanlinessState;
  /** One-line summary for the panel header (already-localised strings go through `t()` separately). */
  message: string;
}

/**
 * Group porcelain entries into staged / unstaged / untracked buckets.
 *
 * git porcelain semantics:
 *   - `x` is the index status: a non-space / non-`?` char means a
 *     staged change.
 *   - `y` is the worktree status: a non-space char means an unstaged
 *     change.
 *   - `??` (both x and y are `?`) marks an untracked file.
 *   - An entry like `MM` belongs to *both* buckets (staged AND
 *     unstaged); we keep them in `staged` so the rendered count
 *     matches `git diff --cached` rather than counting twice.
 *
 * The helper never throws and never mutates the input array.
 */
export function splitFilesByBucket(files: GitStatusFile[] | undefined | null): GitBuckets {
  const staged: GitStatusFile[] = [];
  const unstaged: GitStatusFile[] = [];
  const untracked: GitStatusFile[] = [];
  if (!Array.isArray(files)) return { staged, unstaged, untracked };
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    if (file.x === "?" && file.y === "?") {
      untracked.push(file);
      continue;
    }
    if (file.staged) staged.push(file);
    if (file.y !== " " && file.y !== "?") unstaged.push(file);
  }
  return { staged, unstaged, untracked };
}

/** Human-readable chip text for a single porcelain row. */
export function formatStatusTags(file: GitStatusFile): string {
  return `${file.x}${file.y}`;
}

/**
 * Reduce the panel header to a single state + copy-friendly message.
 * The panel renders this through `t()` — we return the state so the
 * React side picks the right key, not the literal text.
 */
export function describeCleanliness(input: {
  workspaceDir?: string | null;
  status:
    | { ok: true; isRepo?: boolean; files?: GitStatusFile[] }
    | { ok: false; isRepo?: boolean; error?: string };
  hasError: boolean;
}): CleanlinessReport {
  if (!input.workspaceDir) {
    return { state: "no-workspace", message: "no workspace" };
  }
  if (!input.status.ok) {
    if (input.status.isRepo === false) {
      return { state: "not-repo", message: "not a git repository" };
    }
    return { state: "error", message: input.status.error || "git status failed" };
  }
  if (input.status.isRepo === false) {
    return { state: "not-repo", message: "not a git repository" };
  }
  const files = Array.isArray(input.status.files) ? input.status.files : [];
  const hasAny = files.length > 0;
  return {
    state: hasAny ? "dirty" : "clean",
    message: hasAny ? `${files.length} changed files` : "working tree clean",
  };
}

/**
 * Truncate a diff to a soft preview budget. The preview route on the
 * server returns the full diff in a single string; the panel caps the
 * visible body so a 50 KiB diff doesn't dominate the scroll column.
 * This is display-only — the truncated marker makes it clear to the
 * user that the panel has more.
 */
export function previewDiff(diff: string | undefined | null, maxLines: number): {
  text: string;
  truncated: boolean;
} {
  if (!diff) return { text: "", truncated: false };
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return { text: diff, truncated: false };
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}
