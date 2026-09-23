// webui/server/lib/sqlite-resolver.js
// Single responsibility: locate and lazily load mcode's bundled better-sqlite3.
//
// Exposes a tiered candidate list (env override → MCODE_CMD-derived path
// → user-pinned ~/.mcode-webui/db-resolver.json → built-in home/dev
// layouts) plus a sticky cache. It has NO knowledge of which SQL we end
// up running — that's mcode-session-delete.js's job. The split lets a
// future round that drops the local_runtime_* delete loop (once the
// engine exposes `session/delete`) do so without dragging the resolver
// chain along.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { MCODE_CMD } from "./config.js";
import { WEBUI_ROOT } from "./layout.js";

// createRequire is anchored on import.meta.url (not WEBUI_ROOT) on purpose:
// after the esbuild bundle every workspace source is inlined and
// `require()` of a real npm package still needs a require context that
// is local to this file's URL — Node's createRequire binds the lookup
// relative to that URL regardless of layout.
const _webuiRequire = createRequire(import.meta.url);

// Real mcode session deletes must be SQL on the local_runtime_*
// runtime tables — the engine registers `session/delete` in its
// protocol layer but implements no handler, so the call returns
// "Method not found". Lazy init: only require() on first call. Multi-path
// probe covers non-canonical install layouts (registry, npm-global,
// monorepo).
let _McodeBetterSqlite3 = null;
let _McodeBetterSqlite3Failed = false;
// Per-candidate failure log, so the all-failed case can emit one
// consolidated warning listing every attempt instead of one terse line.
let _McodeBetterSqlite3Failures = null;

// Probe a single better-sqlite3 candidate. NEVER throws.
// Returns {path, exists, error}:
//   path   — resolved filesystem path attempted
//   exists — existsSync(path) result (true/false)
//   error  — null on success; otherwise:
//            * "path not found" — path doesn't exist
//            * require() error message — path exists but the module can't
//              be loaded (e.g. NODE_MODULE_VERSION mismatch, missing
//              native binding, ABI drift).
// Side-effect on success: caches the require result so the caller's
// follow-up `_webuiRequire(path)` is a cached no-op.
function _probeCandidate(path) {
    let exists = false;
    try {
        exists = existsSync(path);
    } catch {
        exists = false;
    }
    if (!exists) return { path, exists: false, error: "path not found" };
    try {
        _webuiRequire(path);
        return { path, exists: true, error: null };
    } catch (e) {
        return {
            path,
            exists: true,
            error: e && e.message ? e.message : String(e),
        };
    }
}

// Read `~/.mcode-webui/db-resolver.json` for user-pinned candidate paths.
// Schema (all fields optional):
//   { "better_sqlite3_candidates": [ "/abs/path/to/better-sqlite3", ... ] }
// Returns string[] of pinned paths. Silently returns [] on:
//   - missing file (default case — user hasn't pinned anything)
//   - bad JSON / non-array field
//   - non-string entries (filtered out)
// Tests inject a temp file via `MCODE_WEBUI_RESOLVER_JSON` env override
// so we don't pollute the real `~/.mcode-webui/` during unit tests.
export function _loadUserResolverConfig({ home = homedir() } = {}) {
    const envOverride = process.env.MCODE_WEBUI_RESOLVER_JSON;
    const candidatesPath =
        envOverride || join(home, ".mcode-webui", "db-resolver.json");
    if (!existsSync(candidatesPath)) return [];
    try {
        const raw = readFileSync(candidatesPath, "utf8");
        const cfg = JSON.parse(raw);
        if (!cfg || !Array.isArray(cfg.better_sqlite3_candidates)) return [];
        return cfg.better_sqlite3_candidates.filter(
            (p) => typeof p === "string" && p.length > 0,
        );
    } catch {
        // malformed JSON or unreadable — fail open (no candidates)
        return [];
    }
}

// Resolution priority for better-sqlite3 (4 tiers, reliability descending):
//   1. $MCODE_BETTER_SQLITE3 (explicit env override — highest)
//   2. <MCODE_CMD>/...node_modules/... (mcode binary → bundled deps,
//      emits BOTH npm-style `<dir>/../lib/...` AND flat `<dir>/...`
//      to cover both registry and npm-global layouts)
//   3. ~/.mcode-webui/db-resolver.json (user persistent config — power
//      user pinning, no per-session env needed)
//   4. Built-in fallback (lowest): <home>/.minimax-code/lib/... standard
//      install + <webui>/node_modules/... dev/monorepo layout
//
// Exported (underscore prefix = test-only) so install-layout tests can
// assert the candidate list without actually loading better-sqlite3.
// `mcodeCmd` and `home` are parameterized so tests can simulate any
// install layout without mutating module-level constants.
export function _getBetterSqlite3Candidates({ mcodeCmd = MCODE_CMD, home = homedir() } = {}) {
  const candidates = [];
  if (process.env.MCODE_BETTER_SQLITE3) {
    candidates.push(process.env.MCODE_BETTER_SQLITE3);
  }
  if (mcodeCmd && mcodeCmd !== "mcode") {
    // mcodeCmd is the mcode executable file path (e.g.
    // ~/.minimax-code/bin/mcode on macOS, or ~/.minimax-code/mcode.cmd
    // on Windows, or /usr/local/bin/mcode for npm-global). The mcode
    // package's node_modules/ lives in a sibling of the binary's dir,
    // depending on the install layout:
    //
    //   • npm-style install (macOS default): binary at <root>/bin/mcode,
    //     package at <root>/lib/, deps at <root>/lib/node_modules/...
    //     → up 1 from the binary's dir, then down to "lib/node_modules/".
    //   • flat install (some Linux): binary at <root>/mcode, package at
    //     <root>/, deps at <root>/node_modules/...
    //     → same dir as the binary.
    //
    // Emit BOTH the npm-style and flat-layout candidates below so the
    // candidate list works for either install style (registry vs
    // npm-global mcode).
    candidates.push(
      join(
        dirname(mcodeCmd), "..", "lib",
        "node_modules", "@minimax-ai", "code", "node_modules",
        "better-sqlite3",
      ),
    );
    candidates.push(
      join(
        dirname(mcodeCmd),
        "node_modules", "@minimax-ai", "code", "node_modules",
        "better-sqlite3",
      ),
    );
  }
  // Tier 3: user persistent resolver config (~/.mcode-webui/db-resolver.json).
  //   Emitted even when MCODE_CMD is the "mcode" PATH-placeholder, because
  //   the user's pinned path is independent of the mcode binary location.
  candidates.push(..._loadUserResolverConfig({ home }));
  // Tier 4a: standard install location: <home>/.minimax-code/lib/node_modules/...
  // Emitted unconditionally so we work even when MCODE_CMD is the
  // PATH-placeholder "mcode" (config.js can't find a mcode.cmd on
  // macOS where the binary is just "mcode").
  candidates.push(
    join(
      home, ".minimax-code", "lib",
      "node_modules", "@minimax-ai", "code", "node_modules",
      "better-sqlite3",
    ),
  );
  // Tier 4b: webui-local dev/monorepo layout — the source tree's own
  // node_modules.
  candidates.push(
    join(
      WEBUI_ROOT,
      "node_modules", "@minimax-ai", "code", "node_modules",
      "better-sqlite3",
    ),
  );
  // Tier 4c: monorepo root — better-sqlite3 is a workspace devDependency
  // at the repo root's node_modules in this repository. Probe both
  // layouts ("webui-local node_modules" and "one level up node_modules")
  // so the same source resolves the same paths whether the webui runs
  // from source (packages/webui) or from the built runtime copied into
  // dist/webui. Without these a clean environment (no ~/.minimax-code
  // install) resolves nothing and the session-switch transcript
  // backfill degrades to the "no history" placeholder.
  candidates.push(join(WEBUI_ROOT, "node_modules", "better-sqlite3"));
  candidates.push(join(WEBUI_ROOT, "..", "node_modules", "better-sqlite3"));
  return candidates;
}

export function getMcodeBetterSqlite3({ MCODE_RUNTIME_DB: _ignored } = {}) {
  if (_McodeBetterSqlite3) return _McodeBetterSqlite3;
  if (_McodeBetterSqlite3Failed) return null;
  // Probe every candidate with `_probeCandidate` (no-throw tuple),
  // then on success re-require (cached no-op) to grab the module export.
  // On all-fail, emit one console.warn per attempt + one summary so the
  // operator can tell "missing path" from "NODE_MODULE_VERSION mismatch"
  // without re-running with strace.
  const candidates = _getBetterSqlite3Candidates();
  const failures = [];
  for (const c of candidates) {
    const result = _probeCandidate(c);
    if (result.error === null && result.exists) {
      _McodeBetterSqlite3 = _webuiRequire(c);
      return _McodeBetterSqlite3;
    }
    failures.push(result);
  }
  _McodeBetterSqlite3Failures = failures;
  _McodeBetterSqlite3Failed = true;
  for (const f of failures) {
    console.warn(
      `[webui] better-sqlite3 candidate: ${f.path} → ${f.error}`,
    );
  }
  console.warn(
    `[webui] cannot load better-sqlite3 from any of ${failures.length} candidate(s). ` +
      `Fix by (a) setting $MCODE_BETTER_SQLITE3 to an absolute path, ` +
      `(b) writing ~/.mcode-webui/db-resolver.json with ` +
      `{"better_sqlite3_candidates":["/abs/path/..."]}, or ` +
      `(c) running \`npm rebuild better-sqlite3\` to repair the native binding.`,
  );
  return null;
}