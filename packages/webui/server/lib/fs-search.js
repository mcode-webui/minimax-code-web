// server/lib/fs-search.js — bounded workspace file search.
//
// Background. The file-tree filter (slice 01) matches names only
// against already-loaded (i.e. expanded) nodes, so a `package.json`
// three directories deep shows nothing until the user has manually
// expanded every intermediate directory. To a person that looks
// broken. Recursive prefetch is the wrong fix — it stalls on every
// `node_modules/` and slows the panel even when the user has not
// asked to search. The correct fix is a bounded server-side search
// that the panel issues only when the user types in the filter box.
//
// Hard budgets (the slice ticket says: "exceeding a budget is not
// silent — return an explicit `truncated: true`"):
//   - `maxDepth`   — directory depth from root; default 8, hard max 16
//   - `maxNodes`   — number of readdir entries visited (every
//                    file/dir entry the walker touches counts one);
//                    default 5000, hard max 50000. Counting per-entry
//                    visits keeps the cost model honest — a runaway
//                    directory cannot run past the cap.
//   - `wallMs`     — wall-clock cap; default 1500 ms, hard max 5000 ms
//   - `maxMatches` — cap on returned rows; default 200, hard max 1000.
//
// Exceeding any budget sets `truncated: true` and `truncatedReason`
// to one of `depth` / `nodes` / `wallClock` / `matches`. The walker
// aborts cleanly on whichever budget fires first.
//
// Skip policy. The slice ticket says "skip expensive directories by
// default (node_modules, .git, and any directory over a size
// threshold if you judge it useful) and report what was skipped".
// The skip list is intentionally small and explicit (see
// BASE_SKIP_DIRS / OPTIONAL_SKIP_DIRS below). `node_modules` and
// `.git` are non-overridable safety knobs — the test suite pins
// this and the docs say so. A directory whose own readdir entry
// count exceeds `HUGELY_LARGE_ENTRY_THRESHOLD` is also declared
// huge (no further descent beyond the boundary, but matches AT the
// boundary are still returned).
//
// Credential predicate. The slice ticket says "credential predicate
// from slice 16 (server/lib/credential-file.js) is the authority —
// reuse it rather than writing a second list". `classifyCredential`
// is imported from there. Each match is checked against the
// REALPATH basename (so a workspace symlink `innocent.txt → id_rsa`
// cannot hide the credential shape, mirroring slice 16's read-file
// symmetry). A match flags with `credential: true` +
// `credentialReason` AND increments `skipped.credential`. The path
// is still returned (mirrors `/api/fs/read`, which keeps
// credentials visible in the tree listing). The search never
// returns content; clicking the match lands on
// `/api/fs/read-file`, whose slice-16 gate refuses by default.
//
// Wire shape:
//   {
//     ok: true,
//     root: '<realpath>',
//     q: '<echoed>',
//     matches: [{ path, name, type: 'file'|'dir', ancestors: [...],
//                 credential, credentialReason? }],
//     scanned:  { dirs, files, total },
//     skipped:  { 'node_modules': n, '.git': n, credential: n, huge: n,
//                 optional: { dist:n, build:n, ... } },
//     truncated: false,
//     truncatedReason: null | 'depth'|'nodes'|'wallClock'|'matches',
//     elapsedMs: 12,
//     budgets:   { maxDepth, maxNodes, wallMs, maxMatches,
//                  includeHidden, includeDirs }
//   }
//
// `scanned.total` counts every readdir entry the walker opened,
// INCLUDING the ones the skip-dir / hidden gates filtered out.
// `scanned.dirs` and `scanned.files` count only the entries that
// passed both gates. When no skip / no hide fires
// `total == dirs + files`; otherwise `total >= dirs + files`. See
// the `scanned.total` / `scanned.dirs` / `scanned.files` field
// notes on `emptyResult` for the reader-facing rule.
//
// The walker pins the canonical / REALPATH form everywhere it
// emits a path: `out.root` is `realpathSync(rootAbs)`; every
// `matches[i].path` is `realpathSync(childAbs)`. This matches the
// slice-16 decision that the canonical form across the whole fs
// surface is the realpath — so a workspace symlink
// `innocent.txt → id_rsa` reaches the credential predicate with
// `id_rsa` as the basename, AND a caller that sees
// `/var/folders/.../id_rsa` on Linux and
// `/private/var/folders/.../id_rsa` on macOS gets the same
// downstream `/api/fs/read-file` behaviour on both.

import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { classifyCredential } from "./credential-file.js";
import { matchFilter } from "./glob-filter.js";

// Defaults — exported so the route layer can echo them in docs and
// the test layer can pin them. Tweaking a default is a wire-shape
// change (a client pinning an absent budget still gets the new
// default); raise defaults with a flag and a release note rather
// than silently.
export const DEFAULTS = Object.freeze({
  maxDepth: 8,
  maxNodes: 5000,
  wallMs: 1500,
  maxMatches: 200,
});

export const ABSOLUTE_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 50_000,
  wallMs: 5_000,
  maxMatches: 1_000,
});

/**
 * Directories the walker ALWAYS skips. There is no override knob
 * for these — the slice ticket calls them out by name and the
 * safety reasoning is the same for every workspace (node_modules
 * is the canonical search stall, .git the canonical privacy
 * surface). Tests pin that an `includeDirs: ["node_modules"]`
 * opt-in does NOT lift the skip.
 */
export const BASE_SKIP_DIRS = Object.freeze(new Set([
  "node_modules", ".git",
]));

/**
 * Directories the walker skips by default but a caller may opt
 * back into (via `includeDirs`). Each name must match a
 * directory's exact basename; we don't pattern-match here because
 * glob semantics on directory names have bitten this codebase
 * before.
 */
export const OPTIONAL_SKIP_DIRS = Object.freeze(new Set([
  ".svn", ".hg", ".next", ".cache", ".parcel-cache",
  "dist", "build", "coverage", ".turbo", ".nx", ".idea", ".vscode",
]));

/**
 * A directory whose own children (readdir entry count) exceed this
 * is declared "huge" — we capture matches already on the disk
 * (cheap), but we do NOT descend into it. `node_modules` at a real
 * project can hold 50 000 entries; this keeps the walker inside
 * its node budget on a worst-case workspace.
 */
export const HUGE_DIR_ENTRY_THRESHOLD = 10_000;

/**
 * Coerce an input value into a finite number clamped to
 * [lo, hi]. Anything unparseable falls back to `fallback`. The
 * route layer relies on this so the public parameters cannot be
 * made to throw by `?maxNodes=abc` etc.
 */
function clampInt(raw, { fallback, lo, hi }) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
}

function clampBudgets(opts = {}) {
  const d = DEFAULTS;
  const a = ABSOLUTE_LIMITS;
  return {
    maxDepth: clampInt(opts.maxDepth, { fallback: d.maxDepth, lo: 1, hi: a.maxDepth }),
    maxNodes: clampInt(opts.maxNodes, { fallback: d.maxNodes, lo: 1, hi: a.maxNodes }),
    wallMs: clampInt(opts.wallMs, { fallback: d.wallMs, lo: 50, hi: a.wallMs }),
    maxMatches: clampInt(opts.maxMatches, { fallback: d.maxMatches, lo: 1, hi: a.maxMatches }),
  };
}

/**
 * Build the live skip set: every BASE entry + every OPTIONAL entry,
 * minus any name the caller opted back into via `includeDirs`.
 */
function liveSkipSet(includeDirs) {
  const set = new Set(OPTIONAL_SKIP_DIRS);
  for (const base of BASE_SKIP_DIRS) set.add(base);
  if (Array.isArray(includeDirs)) {
    for (const name of includeDirs) {
      // NEVER honour an opt-in for BASE entries — node_modules /
      // .git are the two real safety knobs.
      if (BASE_SKIP_DIRS.has(name)) continue;
      set.delete(name);
    }
  }
  return set;
}

/**
 * Build the empty response shape returned to the caller.
 *
 * Field-by-field contract:
 *   - `root` is the walker-canonicalised (realpath'd) form of the
 *     search root.
 *   - `matches[i].path` is the realpath form (see the file header).
 *   - `scanned.total` counts every readdir entry the walker
 *     opened — INCLUDING the ones the skip-dir, hidden, and
 *     huge gates filtered out (the walker tracks them so the
 *     `nodes` budget and progress callbacks stay honest).
 *   - `scanned.dirs` and `scanned.files` count ONLY entries
 *     that passed BOTH the skip-dir gate and the hidden gate
 *     (they are mutually exclusive: an entry is either a
 *     directory or a file). When no skip / no hide / no huge
 *     slicing fires, `total == dirs + files`; otherwise
 *     `total > dirs + files`.
 *   - `skipped.huge` is the **unvisited tail** of any directory
 *     declared "huge". A response with `truncated: false` AND
 *     `skipped.huge > 0` is NOT contradictory — the walk
 *     completed within its budgets, but a single directory's
 *     tail was deliberately capped. The UI must surface this
 *     honestly (a plain "truncated" pill would lie).
 *   - `truncated` is FALSE unless a budget (depth / nodes /
 *     wall-clock / matches) actually fired.
 */
function emptyResult(rootAbs, q, budgets, opts) {
  return {
    root: rootAbs,
    q,
    matches: [],
    scanned: { dirs: 0, files: 0, total: 0 },
    skipped: {
      "node_modules": 0,
      ".git": 0,
      credential: 0,
      huge: 0,
      optional: Object.fromEntries([...OPTIONAL_SKIP_DIRS].map((n) => [n, 0])),
    },
    truncated: false,
    truncatedReason: null,
    elapsedMs: 0,
    budgets: {
      ...budgets,
      includeHidden: !!opts.includeHidden,
      includeDirs: Array.isArray(opts.includeDirs) ? opts.includeDirs.slice() : [],
    },
  };
}

/**
 * Increment the per-name `skipped.optional` counter without
 * resetting other keys.
 */
function bumpOptional(out, name, by = 1) {
  out.skipped.optional[name] = (out.skipped.optional[name] || 0) + by;
}

/**
 * Run a bounded search for entries under `rootAbs` whose basename
 * matches the glob `q`.
 *
 * `opts` (all optional):
 *   - maxDepth / maxNodes / wallMs / maxMatches — see DEFAULTS above.
 *   - includeHidden — when true, dotfile-prefixed entries are NOT
 *     skipped at the readdir level. Default mirrors the file
 *     tree's behaviour.
 *   - includeDirs — additive set of directory names NOT to skip
 *     (only honoured against OPTIONAL_SKIP_DIRS — `node_modules`
 *     and `.git` are always skipped, period).
 *   - onProgress — optional progress callback (untrusted; the route
 *     uses it for SSE and does NOT route trust decisions through
 *     it).
 *   - now — injectable clock for tests; defaults to
 *     `() => Date.now()`. A counter is enough to simulate
 *     wall-clock pressure deterministically.
 */
export function searchWorkspace(rootAbs, q, opts = {}) {
  const started = (opts.now ? opts.now() : Date.now());
  const budgets = clampBudgets(opts);
  const skipDirs = liveSkipSet(opts.includeDirs);
  // Realpath the root ONCE on entry. The route layer already
  // hands the walker the gate's realpath form (`safePath` returns
  // `gate.real`); this is the belt-and-braces pass that keeps a
  // direct call (e.g. a unit test or a future call site) honest
  // with the same "every emitted path is canonical" contract.
  // macOS's `/var/folders/... → /private/var/folders/...` is the
  // canonical reason: a literal-spelling root would surface a
  // different `out.root` than the per-match realpath'd paths,
  // confusing the panel and breaking containment symmetry.
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(rootAbs);
  } catch {
    canonicalRoot = rootAbs;
  }
  const out = emptyResult(canonicalRoot, q, budgets, opts);

  // Iterative walker (manual stack) — recursion blowup is not a
  // risk and depth bookkeeping stays explicit.
  const stack = [{ abs: canonicalRoot, chain: [] }];
  // nodes = total readdir entries processed so far this run.
  // Used as the early-exit bound for the maxNodes budget.
  let nodes = 0;
  let truncatedReason = null;

  while (stack.length) {
    // Outermost budget gates — cheapest first. Wall-clock needs
    // the correct started-at reference.
    if (out.matches.length >= budgets.maxMatches) {
      truncatedReason = truncatedReason || "matches";
      break;
    }
    if (nodes >= budgets.maxNodes) {
      truncatedReason = truncatedReason || "nodes";
      break;
    }
    if ((opts.now ? opts.now() : Date.now()) - started > budgets.wallMs) {
      truncatedReason = truncatedReason || "wallClock";
      break;
    }

    const frame = stack.pop();
    let entries;
    try {
      entries = readdirSync(frame.abs, { withFileTypes: true });
    } catch {
      // Unreadable dir (perm, race) — skip silently. The walker's
      // job is to fill a search result, not to surface every
      // permission error.
      continue;
    }
    // Huge-dir check — only meaningful for the entries we just
    // read. A directory with >threshold entries is declared
    // expensive and skipped for further descent; the entries we
    // already have in memory are still processed for matches at
    // the boundary (cheap).
    //
    // `skipped.huge` records the **unvisited tail** only (NOT the
    // whole `entries.length`). The boundary entries show up in
    // `scanned.total` / `scanned.dirs` / `scanned.files` as
    // ordinary entries; only the entries the walker refused to
    // descend into are counted as "huge skips". This is the
    // contract `truncated:false, skipped.huge>0` depends on —
//   that combination means "the walk finished but a directory's
    // tail was deliberately not visited", which the UI must
    // surface honestly rather than passing it off as a complete
    // result.
    let processableEntries = entries;
    const hugeThreshold = (typeof opts.hugeThreshold === "number" && opts.hugeThreshold > 0)
      ? opts.hugeThreshold
      : HUGE_DIR_ENTRY_THRESHOLD;
    const isHuge = entries.length > hugeThreshold;
    if (isHuge) {
      out.skipped.huge += entries.length - hugeThreshold;
      processableEntries = entries.slice(0, hugeThreshold);
    }
    // Sort for stable `matches` ordering: directories first (the
    // panel pattern matches either kind), then by basename.
    processableEntries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    // First pass — match. Going through the entries once keeps
    // the walker linear. The depth-push runs in a second pass
    // below so a budget hit during the match loop still aborts
    // cleanly.
    let matchesExhausted = false;
    for (const ent of processableEntries) {
      nodes += 1;
      out.scanned.total += 1;
      if (typeof opts.onProgress === "function") {
        try { opts.onProgress({ type: ent.isDirectory() ? "dir" : "file", path: join(frame.abs, ent.name) }); } catch {}
      }
      // Skip-dir gate runs FIRST so .git / node_modules are
      // unconditional skips regardless of includeHidden (they are
      // the two real safety knobs and the slice ticket calls them
      // out by name).
      const isSymlink = ent.isSymbolicLink();
      const isDir = ent.isDirectory() && !isSymlink;
      if (isDir && skipDirs.has(ent.name)) {
        if (ent.name === "node_modules") out.skipped["node_modules"] += 1;
        else if (ent.name === ".git") out.skipped[".git"] += 1;
        else bumpOptional(out, ent.name);
        continue;
      }

      // Hidden-file gate runs AFTER the skip-dir gate. The default
      // matches the file tree: dotfiles are skipped (mirrors
      // /api/fs/read showHidden=0). Credential-shaped dotfiles
      // STILL get caught when includeHidden flips: that's a
      // separate opt-in, not the credential predicate.
      if (!opts.includeHidden && ent.name.startsWith(".")) continue;

      // Counted entry (passed both gates) — bump `scanned.dirs`
      // or `scanned.files` here so the per-kind counter reflects
      // what the walker actually saw, not just what it matched.
      if (isDir) out.scanned.dirs += 1;
      else out.scanned.files += 1;

      // Inner-budget check — the per-entry increment above can
      // push `nodes` past the budget inside this loop body, so
      // the outer-loop check is not enough.
      if (nodes >= budgets.maxNodes) {
        truncatedReason = truncatedReason || "nodes";
        matchesExhausted = true;
        break;
      }
      if ((opts.now ? opts.now() : Date.now()) - started > budgets.wallMs) {
        truncatedReason = truncatedReason || "wallClock";
        matchesExhausted = true;
        break;
      }

      // Match pass.
      if (!matchFilter(ent.name, q)) continue;

      const childAbs = join(frame.abs, ent.name);
      // Always realpath the match — non-symlinks are an
      // idempotent no-op, symlinks resolve to the target. The
      // cost is one syscall per match (bounded by `maxMatches`,
      // default 200), and it is what lets the response carry a
      // uniform canonical form regardless of how the caller
      // spelled `root` (e.g. macOS's `/var/folders/...` vs
      // `/private/var/folders/...`). The credential predicate
      // runs against the resolved basename so a workspace
      // symlink `innocent.txt → id_rsa` still flags.
      let realChild;
      try {
        realChild = realpathSync(childAbs);
      } catch {
        // Unresolvable link or vanished entry — surface the
        // literal spelling the walker reached. The downstream
        // `/api/fs/read-file` gate handles the resolution /
        // credential check independently.
        realChild = childAbs;
      }
      const classification = classifyCredential(realChild);
      const isCredential = !!classification;
      if (isCredential) out.skipped.credential += 1;

      out.matches.push({
        // `path` is the realpath form, matching the slice-16
        // convention. The panel's click then lands on the
        // canonical path the downstream /api/fs/read-file gate
        // recognises.
        path: realChild,
        name: ent.name,
        type: isDir ? "dir" : "file",
        // ancestor chain = path components between search root
        // (exclusive) and the match (exclusive). For a top-level
        // match the chain is [] so the client can use `path`
        // directly.
        ancestors: frame.chain.slice(),
        // Slice 16 alignment: search results that happen to be
        // credential-shaped get the same flag the right-panel
        // preview uses, so the webapp can render a
        // credential-icon row without re-classifying.
        credential: isCredential,
        credentialReason: classification ? classification.reason : undefined,
      });

      if (out.matches.length >= budgets.maxMatches) {
        truncatedReason = truncatedReason || "matches";
        matchesExhausted = true;
        break;
      }
    }

    // Second pass — push child directories onto the stack. Done
    // after the match loop so a budget hit during matching still
    // aborts cleanly without an extra stack frame. Reversed so
    // the natural sort order is preserved (root children visited
    // left-to-right because the stack is LIFO).
    //
    // Symlinked directories are NOT pushed (security: prevents
    // cycles). The slice-16 test surface for the read-file route
    // covers symlink-aliased credential files; for the search
    // walker that case is captured at match time (see above).
    //
    // A directory declared `huge` (entries.length > hugeThreshold)
    // had its children processed for matches at the boundary, but
    // we MUST NOT descend into any of them — that is the
    // declaration we made when we counted `skipped.huge +=
    // entries.length`. Without this guard the sliced-but-not-pushed
    // invariant is broken.
    if (!matchesExhausted && !isHuge) {
      for (let i = processableEntries.length - 1; i >= 0; i -= 1) {
        const ent = processableEntries[i];
        // Skip-dir gate runs again here. We re-do the hidden
        // check rather than caching the decision because it is
        // trivially cheap.
        if (!opts.includeHidden && ent.name.startsWith(".")) continue;
        const isSymlink = ent.isSymbolicLink();
        if (!ent.isDirectory() || isSymlink) continue;
        if (skipDirs.has(ent.name)) continue;
        const childDepth = frame.chain.length + 1;
        if (childDepth >= budgets.maxDepth) {
          truncatedReason = truncatedReason || "depth";
          continue;
        }
        stack.push({
          abs: join(frame.abs, ent.name),
          chain: frame.chain.concat([ent.name]),
        });
      }
    }
  }

  out.truncated = !!truncatedReason;
  out.truncatedReason = truncatedReason;
  out.elapsedMs = (opts.now ? opts.now() : Date.now()) - started;
  return out;
}
