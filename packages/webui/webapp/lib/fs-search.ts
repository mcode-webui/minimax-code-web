// webapp/lib/fs-search.ts
//
// Pure helpers for the bounded workspace search (slice 19b — the
// panel-side wire of slice 19a's `/api/fs/search`).
//
// Why this module exists. The `panels.tsx#FilesPanel` and
// `workspace-tree-column.tsx#SearchSurface` components both consume
// the same search endpoint. To keep their behaviour aligned (loaded-
// first vs server fallback, footer text, expand-to-hit) we pull the
// shared pieces into a pure module:
//
//   - `searchFootSegments` — the footer string the panel renders
//     below its results. Decoupled from `t(...)` so the unit tests
//     can pin it without a DOM and a translator.
//   - `pathsToExpand` — the set of directory paths a server result
//     needs the tree to expand so the matches become visible.
//   - `ancestorChain` — the ordered list of intermediate directories
//     between the search root and a match (used by the highlight
//     effect and by the sidebar's "reveal in tree" affordance).
//
// None of these helpers touch `fetch` or `window`, so the tests stay
// in the `node:test` lane with no jsdom or DOM stubs — same precedent
// as `webapp/lib/files-tree.ts` and `webapp/lib/workspace-filter.ts`.

import type { FsSearchMatch, FsSearchResult } from "./api";

/**
 * Ordered chain of intermediate directories between `root` and the
 * parent of `match.path`. Both endpoints are exclusive.
 *
 * Example:
 *   ancestorChain(
 *     match={path:"/r/src/lib/x.ts", ancestors:["src","lib"]},
 *     root="/r"
 *   ) = ["/r/src", "/r/src/lib"]
 *
 * The chain is the precise set of dirs the tree panel must expand
 * to make the match visible. For a top-level match the chain is
 * empty.
 */
export function ancestorChain(match: FsSearchMatch, root: string): string[] {
  if (!root) return [];
  const rootNorm = root.replace(/\/+$/, "") || "/";
  const chain: string[] = [];
  let cursor = rootNorm;
  for (const segment of match.ancestors ?? []) {
    cursor = cursor === "/" ? `/${segment}` : `${cursor}/${segment}`;
    chain.push(cursor);
  }
  return chain;
}

/**
 * Union of every ancestor path across all matches. The caller
 * adds these to the tree's `expanded` set so the hits become visible.
 *
 * Idempotent — duplicates are deduped.
 */
export function pathsToExpand(matches: FsSearchMatch[], root: string): string[] {
  const set = new Set<string>();
  for (const match of matches) {
    for (const path of ancestorChain(match, root)) set.add(path);
  }
  return Array.from(set);
}

/**
 * Build the "已搜 N · 跳过 node_modules X / .git Y / 凭据 Z · 命中 M"
 * footer (or the equivalent English form) from a server result.
 *
 * The function returns a structured list of segments rather than a
 * pre-formatted string so the caller can render with whatever
 * separator it likes (the i18n string owns the wording and the
 * `{{n}}` interpolation) and so the unit tests can pin each
 * segment independently.
 *
 * The ticket is explicit about three signals:
 *   1. `skipped.node_modules` and `skipped..git` — always shown when
 *      > 0. The walker skips these unconditionally.
 *   2. `skipped.credential` — always shown when > 0. The user
 *      might have typed `*.env`; the footer must tell them why
 *      the match list differs from "what the walker saw".
 *   3. `skipped.huge` — ALWAYS surfaced when > 0, even when
 *      `truncated` is false. Acceptance explicitly calls this
 *      out as the "huge directory's tail was capped but the walk
 *      finished" footgun.
 *
 * Optional `OPTIONAL_SKIP_DIRS` keys (`dist` / `build` / …) are
 * surfaced as a single collapsed segment ("跳过分发目录 N") when
 * any of them is non-zero, so the footer does not bloat when a
 * project has both `dist` and `build`.
 *
 * When `truncated` is true, `truncatedReason` is rendered as its
 * own segment with the budget that fired (depth / nodes / wallClock
 * / matches).
 */
export type FooterSegmentKind =
  | "scanned"
  | "matches"
  | "skipped-node_modules"
  | "skipped-git"
  | "skipped-credential"
  | "skipped-huge"
  | "skipped-optional"
  | "truncated"
  | "elapsed";

export interface FooterSegment {
  /** Stable id used by the i18n layer to pick the right template
   *  and by the React layer to set `data-testid` attributes. */
  kind: FooterSegmentKind;
  /** Pre-substituted template — `{n}` placeholders are already
   *  replaced with the count. The caller does the final
   *  interpolation when needed (locale-specific). */
  text: string;
}

export interface SearchFootOpts {
  /** i18n templates keyed by segment kind. Callers build this from
   *  the `t(...)` function they already hold. Templates use `{n}`
   *  for numeric substitution; the helper does the substitution so the
   *  tests stay readable. */
  templates?: Partial<Record<FooterSegmentKind, string>>;
  /** Used to render the `elapsed` segment (e.g. "耗时 12ms"). When
   *  omitted the segment is omitted. */
  formatElapsed?: (ms: number) => string;
  /** Templates for the budget reason inside the `truncated`
   *  segment — one per `truncatedReason` value
   *  (`depth`/`nodes`/`wallClock`/`matches`). When omitted the raw
   *  reason is rendered verbatim. */
  budgetLabels?: Partial<Record<"depth" | "nodes" | "wallClock" | "matches", string>>;
}

/**
 * Render the structured footer for a server search result. The
 * returned list is empty when the result is `null` (no server
 * request has fired yet).
 *
 * Templates may include the substring `{n}` for numeric substitution
 * or omit it entirely; the helper does no other template work, so
 * complex strings must be pre-built by the i18n layer.
 */
export function searchFootSegments(
  result: FsSearchResult | null,
  opts: SearchFootOpts = {},
): FooterSegment[] {
  if (!result) return [];
  const out: FooterSegment[] = [];
  const t = (kind: FooterSegmentKind) => opts.templates?.[kind] ?? "";
  const push = (kind: FooterSegmentKind, text: string) => {
    if (!text) return;
    out.push({ kind, text });
  };
  const replaceN = (template: string, n: number | string) =>
    template.replace(/\{n\}/g, String(n));

  const scannedTotal = result.scanned?.total ?? 0;
  const matches = result.matches?.length ?? 0;
  push("scanned", replaceN(t("scanned"), scannedTotal));
  push("matches", replaceN(t("matches"), matches));

  const skipped = result.skipped;
  if (skipped?.["node_modules"]) {
    push("skipped-node_modules", replaceN(t("skipped-node_modules"), skipped["node_modules"]));
  }
  if (skipped?.[".git"]) {
    push("skipped-git", replaceN(t("skipped-git"), skipped[".git"]));
  }
  if (skipped?.credential) {
    push("skipped-credential", replaceN(t("skipped-credential"), skipped.credential));
  }
  // HUGE-DIR TAIL — ALWAYS surfaced when > 0, even when truncated
  // is false. This is the only signal that tells the user "we did
  // not visit the tail of this directory", and acceptance pinned
  // it because the obvious footer ("truncated=false → that is
  // everything") would lie.
  if (skipped?.huge) {
    push("skipped-huge", replaceN(t("skipped-huge"), skipped.huge));
  }
  // OPTIONAL skip dirs (dist / build / coverage / …) — collapsed
  // into one segment so the footer stays one line. The individual
  // counts are NOT lost: `result.skipped.optional` is the source
  // of truth and the React layer renders it as a `title` tooltip
  // on the segment so a curious user can drill in.
  const optional = skipped?.optional ?? {};
  let optionalTotal = 0;
  for (const count of Object.values(optional)) optionalTotal += count;
  if (optionalTotal > 0) {
    push("skipped-optional", replaceN(t("skipped-optional"), optionalTotal));
  }

  if (result.truncated && result.truncatedReason) {
    const reasonT = t("truncated");
    const budgetLabel = opts.budgetLabels?.[result.truncatedReason] ?? result.truncatedReason;
    push("truncated", reasonT.replace(/\{budget\}/g, budgetLabel));
  }

  if (opts.formatElapsed) {
    const elapsedText = opts.templates?.elapsed;
    if (elapsedText) push("elapsed", replaceN(elapsedText, opts.formatElapsed(result.elapsedMs ?? 0)));
  }

  return out;
}
