// scripts/test-tmp-leak.check.mjs
//
// Session-isolation/06 lint: a test suite MUST NOT leave behind any of the
// repository's well-known tmpdir prefixes when it finishes. The previous
// gate (`scripts/test-isolation-lint.check.mjs`) only enforced that a test
// which spawns server.js overrides the four `MCODE_WEBUI_*` env paths to
// temporary locations; it did not enforce that the resulting directories
// were removed at suite end. /tmp on busy dev hosts accumulated ~31 GB of
// test residue — see `.tickets/webui-parity/35-test-tmp-dir-cleanup.md`.
//
// How it works
// ------------
// The script captures a "before" snapshot of every well-known prefix under
// the active TMPDIR (defaults to `os.tmpdir()`). The caller runs a test
// suite between two snapshot windows:
//
//   node scripts/test-tmp-leak.check.mjs snapshot > /tmp/before.json
//   pnpm --filter @mavis/webui test
//   node scripts/test-tmp-leak.check.mjs diff /tmp/before.json
//
// `diff` compares the after-snapshot to before: any directory in the
// well-known prefixes that appeared in the after window is a leak and
// the script exits 1 with a per-entry listing. The well-known prefixes
// list is the canonical one from the ticket; expanding it is a
// deliberate code change.
//
// Reverse validation
// ------------------
// `verifyPrefixRegistry()` re-scans the test tree and asserts that every
// prefix the repo's tests actually call `mkTmpDir(prefix)` /
// `mkTmpDirAsync(prefix)` / `mkSubTmpDir(parent, prefix)` with is in the
// KNOWN_PREFIXES list. The forward list is still the source of truth —
// the reverse scan is a guardrail so a future test author cannot
// silently introduce a new prefix that the lint then misses.
//
// Wire-up
// -------
// `test:release-tools` is the gate the existing test-isolation-lint lives
// in (see test/source-sync.test.mjs). The leak-lint is wired there next
// to it: two `test(...)` blocks prove the lint itself is honest (clean
// fixture = zero, synthetic fixture = detected). There is NO end-to-end
// "snapshot before / run suite / diff after" wrapper invoked
// automatically — see the report's "Wire-up trade-off" section for the
// reasoning. Standalone invocation is the canonical path:
//
//   node scripts/test-tmp-leak.check.mjs                # scan and print
//   node scripts/test-tmp-leak.check.mjs snapshot FILE  # capture before
//   node scripts/test-tmp-leak.check.mjs diff FILE      # compare + exit
//
// Why "well-known prefixes" not "every directory"
// ------------------------------------------------
// A blanket sweep would (a) leak the host's own runtime state (every
// process on the box that touches /tmp shares it), (b) flag common
// tooling directories (pip-unpack-*, tmpXXXX, …), and (c) flunk the gate
// on any unrelated agent. The well-known-prefix list is the contract:
// the repo's tests use one of these prefixes for every per-test tmpdir,
// and adding a new prefix requires a deliberate code change here.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Robust existence check that catches stale dentry-cache entries.
 *
 * `fs.existsSync` (and the kernel `access(2)` it wraps) can briefly
 * report a directory as existing even after it has been unlinked,
 * when another thread in the same process still holds an open file
 * descriptor into it. That race is exactly what runtime-host.test.js
 * trips when its better-sqlite3 connection's fd keeps the children
 * alive past `rmTmpDir(tmpBase)`. `realpathSync` traverses symlinks
 * and forces a fresh statx that respects the kernel's inode state
 * (returning ENOENT once the inode is finally unlinked).
 */
function pathExists(path) {
  try {
    statSync(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    return true; // EACCES, EIO, etc. — be conservative
  }
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Recursively yield every file under `dir` whose name ends with one of
 * `extensions` (e.g. [".js", ".mjs"]). Directories named `node_modules`
 * are skipped, and symbolic links are never followed — matching the
 * recursive-scan semantics this script used to get from `grep -r`.
 *
 * Why not shell out to grep: the patterns this lint needs (`\(`, `\s`,
 * `\b`) are GNU/BSD dialect extensions whose escaping differs between
 * grep implementations — the Windows runner's grep rejected the escaped
 * paren outright (PR #86 CI). A pure-Node walk plus `RegExp` behaves
 * identically on every platform Node itself runs on, so the gate can
 * never again differ between ubuntu, macOS and windows (three prior
 * cross-platform assertion regressions were caused by exactly this
 * class of system-tool dialect dependency).
 *
 * @param {string} dir
 * @param {string[]} extensions
 * @returns {Generator<string>} absolute file paths, in readdir order
 */
function* walkSourceFiles(dir, extensions) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subtree — same as grep skipping it
  }
  for (const entry of entries) {
    // Third-party dependencies are not this repo's test code — their
    // helper call sites must not gate (or pollute) the prefix registry,
    // and scanning them would only cost time.
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full, extensions);
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      yield full;
    }
  }
}

/**
 * Read a source file and return its lines with the trailing carriage
 * return stripped, so a CRLF checkout on Windows produces the same line
 * content an LF checkout does.
 *
 * @param {string} file
 * @returns {string[]}
 */
function readSourceLines(file) {
  return readFileSync(file, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
}

// Every prefix the repo's tests use. Keep the list narrow: each entry is
// a code change AND a contract — every new prefix needs the same exit
// hook treatment every other entry has.
//
// Order matters ONLY because matching stops on the first prefix that
// matches. Most entries are more-specific prefixes that beat the catch-all
// "webui-" / "trajectory-" / "mcode-" entries below.
//
// Round-2 (B6 acceptance feedback): the previous list missed 70/164
// observed prefixes on the host (/tmp), including 47 fs-* and 14
// mcode-webui-* entries. The list below is now exhaustive against the
// prefixes that the repo's tests actually pass to mkTmpDir — see
// verifyPrefixRegistry() for the guard that keeps it honest.
const KNOWN_PREFIXES = [
  // Round-2: every prefix the repo's tests actually pass to mkTmpDir /
  // mkTmpDirAsync / mkSubTmpDir. The list is generated from the test
  // tree by collectActualPrefixes(); verifyPrefixRegistry() asserts
  // the list above stays in lock-step with the test code — adding a
  // new prefix to a test file without updating here fails the gate.
  // Use `node scripts/test-tmp-leak.check.mjs list-actual-prefixes` to
  // diff against this list when adding a new prefix.
  "agent-team-state-bus-",
  "agent-team-tasks-",
  "fs-contain-",
  "fs-cred-",
  "fs-cred-audit-",
  "fs-cred-audit-miss-",
  "fs-cred-audit-raw-",
  "fs-cred-backup-",
  "fs-cred-backup-miss-",
  "fs-cred-can-real-",
  "fs-cred-confirm-",
  "fs-cred-confirm-noop-",
  "fs-cred-dbl-real-",
  "fs-cred-miss-",
  "fs-cred-raw-",
  "fs-cred-raw-ok-",
  "fs-cred-symlink-env-",
  "fs-cred-symlink-html-",
  "fs-cred-symlink-override-",
  "fs-cred-symlink-pem-",
  "fs-cred-symlink-read-",
  "fs-cred-tree-",
  "fs-mkdir-",
  "fs-open-target-",
  "fs-open-target-bin-",
  "fs-parent-",
  "fs-parent-legacy-",
  "fs-parent-ok-",
  "fs-raw-browser-dir-",
  "fs-raw-browser-html-",
  "fs-raw-browser-large-",
  "fs-raw-dir-",
  "fs-raw-missing-",
  "fs-raw-png-",
  "fs-raw-unknown-",
  "fs-read-file-big-",
  "fs-read-file-binary-",
  "fs-read-file-dir-",
  "fs-read-file-missing-",
  "fs-read-file-mtime-",
  "fs-read-file-ok-",
  "fs-search-",
  "fs-search-clamp-",
  "fs-search-file-",
  "fs-search-happy-",
  "fs-search-limit-",
  "fs-search-plaintext-",
  "fs-search-skip-",
  "fs-search-sym-",
  "fs-search-trunc-",
  "git-panel-badge-advance-",
  "git-panel-badge-dates-",
  "git-panel-badge-empty-",
  "git-panel-badge-plain-",
  "git-panel-badge-unborn-",
  "git-panel-plain-",
  "git-panel-repo-",
  "mcode-d01-empty-",
  "mcode-d01-home-",
  "mcode-d01-isolate-",
  "mcode-d01-malformed-",
  "mcode-d01-no-field-",
  "mcode-d01-noarray-",
  "mcode-d01-realdb-",
  "mcode-d01-resolver-",
  "mcode-d01-valid-",
  "mcode-exec-empty-",
  "mcode-exec-emptywin-",
  "mcode-exec-nosibling-",
  "mcode-exec-plain-",
  "mcode-exec-posix-",
  "mcode-exec-stream-",
  "mcode-exec-test-",
  "mcode-resolver-bad-",
  "mcode-resolver-empty-",
  "mcode-resolver-mac-",
  "mcode-resolver-valid-",
  "mcode-resolver-win-",
  "mcode-webui-b9-mode-write-",
  "mcode-webui-bind-",
  "mcode-webui-c08-",
  "mcode-webui-d02-chain-",
  "mcode-webui-d02-router-",
  "mcode-webui-d02-sse-",
  "mcode-webui-d1-merge-",
  "mcode-webui-engine-snapshot-",
  "mcode-webui-libsettings-iso-",
  "mcode-webui-mock-",
  "mcode-webui-port-fallback-",
  "mcode-webui-readonly-",
  "mcode-webui-s3-catalogue-",
  "mcode-webui-s3-fallback-",
  "mcode-webui-test-",
  "mcode-webui-upload-e2e-",
  "mcode-webui-upload-lib-",
  "mcode-webui-usage-",
  "mcode-webui-w2-cmd-",
  "mcode-webui-w2-gate-",
  "minimax-code-engine-cat-",
  "minimax-code-engine-migration-",
  "minimax-code-engine-reads-",
  "minimax-code-engine-store-",
  "minimax-code-engine-writes-",
  "sessions-single-id-",
  "state-bus-restore-",
  "webui-acp-answer-",
  "webui-acp-fake-engine-",
  "webui-acp-stderr-",
  "webui-alerts-audit-",
  "webui-alerts-check-",
  "webui-authgate-events-",
  "webui-authgate-settings-",
  "webui-authorize-check-",
  "webui-bindhost-test-",
  "webui-browse-",
  "webui-browse-shape-",
  "webui-chat-failed-",
  "webui-db-out-absent-",
  "webui-db-out-del-",
  "webui-db-out-order-",
  "webui-db-out-preview-",
  "webui-db-out-readfail-",
  "webui-db-out-readfail-dry-",
  "webui-db-out-schema-",
  "webui-db-out-zero-",
  "webui-db-outcomes-events-",
  "webui-db-test-",
  "webui-db-test2-",
  "webui-dryrun-",
  "webui-engine-fail-",
  "webui-events-concurrency-test-",
  "webui-events-hash-test-",
  "webui-events-ro-",
  "webui-events-test-",
  "webui-export-facade-",
  "webui-export-test-",
  "webui-first-turn-guard-",
  "webui-lan-gate-test-events-",
  "webui-model-engine-cat-",
  "webui-model-reads-",
  "webui-model-user-level-",
  "webui-model-writes-",
  "webui-models-merge-",
  "webui-origingate-events-",
  "webui-origingate-settings-",
  "webui-parent-out-",
  "webui-parent-root-",
  "webui-paths-",
  "webui-plan-projection-",
  "webui-presets-engine-",
  "webui-presets-route-",
  "webui-presets-route-cwd-",
  "webui-providers-engine-",
  "webui-providers-cwd-",
  "webui-providers-route-",
  "webui-providers-route-cwd-",
  "webui-providers-test-",
  "webui-qfc-edge-",
  "webui-quota-forecast-test-",
  "webui-real-del-",
  "webui-resolve-home-",
  "webui-routes-alerts-check-",
  "webui-run-mirror-",
  "webui-rws-test-",
  "webui-sec-net-events-",
  "webui-sec-net-settings-",
  "webui-sessdb-",
  "webui-session-delete-test-",
  "webui-session-writes-b5-",
  "webui-sessions-search-check-",
  "webui-sessions-test-events-",
  "webui-settings-test-events-",
  "webui-switch-facade-db-",
  "webui-switch-facade-events-",
  "webui-switch-facade-outside-",
  "webui-switch-facade-roots-",
  "webui-switch-test-db-",
  "webui-switch-test-events-",
  "webui-transcript-test-",
  "webui-tree-facade-",
  "webui-ws-browse-",
  "webui-ws-gate-",
  "webui-ws-max-",
  "webui-ws-out-",
  "webui-ws-symlink-real-",
  "webui-ws-test-",
  "webui-wsout-",
  "webui-wsroot-",
  "webui-wsroots-a-",
  "webui-wsscratch-",
  "mcode-webui-runtime-host-",
  // PB-8 (host services window): the same runtime and the same
  // better-sqlite3 fd profile as the suite above — its parent reuses
  // that prefix, its children need their own.
  "pb8-svc-",
  "pb8-svc-shape-",
  // PB-1's real-host suite (`test/server/session-context-actions-host.test.js`).
  // Same runtime, same better-sqlite3 fd profile as the two above, so it
  // reuses their parent and needs its own child prefix — which is exactly
  // what this registry is for: a new suite that boots a host without
  // registering its prefix fails `test:release-tools` rather than leaking
  // silently, and the reverse scan below is what keeps the two in step.
  "pb1-host-",
  "webui-t36-engine-",
  // Catch-all prefixes (last — matching stops on the first prefix that
  // matches, so every entry above this point wins over these). Round-3
  // B6.3 added them back after round-2's exact-only list created three
  // blind spots:
  //   * `webui-no-such-`     — never actually created (test code
  //                            synthesises the string but does not
  //                            mkdir); kept out of the list and
  //                            exempt by the catch-all.
  //   * `webui-ws-symlink-link-` — same shape: a path string for the
  //                            symlink target, never an actual
  //                            directory. Caught by `webui-`.
  //   * `mcode-tools-tui-`    — used by `packages/tui/` (NOT a webui
  //                            test prefix). The lint scope is
  //                            `packages/webui/test/` so the tui
  //                            prefix is outside the registry; the
  //                            catch-all catches it if a tui test
  //                            ever leaves a leak on this host.
  // The catch-all does not affect verify-registry's reverse check —
  // collectActualPrefixes() still scans for literal `mkTmpDir(prefix)`
  // call sites and reports any prefix not in the precise list above.
  // These three are best-effort backstops, not a primary contract.
  "webui-",
  "trajectory-",
  "mcode-",
  "fs-",
  "git-panel-",
];

/**
 * Scan packages/webui/test/ for every mkTmpDir / mkTmpDirAsync /
 * mkSubTmpDir invocation and return the set of literal prefix arguments
 * the repo's tests use. Implemented as a walkSourceFiles pass with a
 * native RegExp tested line-by-line — no system grep involved, so the
 * scan behaves identically on every platform (see walkSourceFiles for
 * the rationale).
 *
 * @returns {Set<string>} the prefixes the test code passes to the helper
 */
/**
 * The helper's JSDoc carries `mkTmpDir("prefix-X-")` and
 * `mkSubTmpDir(parent, "case-")` as usage examples — those are NOT real
 * test invocations and must not gate the registry.
 */
const EXAMPLE_PREFIXES = new Set(["prefix-X-", "case-"]);

export function collectActualPrefixes() {
  const BACKTICK = String.fromCharCode(96);
  // The helper's documented prefix convention is `<family>-<sub>-`:
  // lowercase letters, digits, and hyphens. We use a strict whitelist
  // character class so the regex never matches past the closing quote
  // — the class admits only the characters prefixes can actually
  // contain. Anything more exotic (e.g. a prefix containing a quote)
  // is a deliberate exception the author should have escaped by then,
  // and the registry check would surface the missing entry on the
  // next run anyway.
  const PREFIX_CHAR = `[a-zA-Z0-9_-]`;
  const QUOTED_PREFIX = `["${BACKTICK}"]${PREFIX_CHAR}*["${BACKTICK}"]`;
  // Same shapes the grep-era pattern matched, as a native RegExp tested
  // line-by-line: helper calls with a literal quoted first (or second,
  // for mkSubTmpDir) argument.
  const CALL_SITES = new RegExp(
    [
      `mkTmpDir\\(\\s*${QUOTED_PREFIX}`,
      `mkTmpDirAsync\\(\\s*${QUOTED_PREFIX}`,
      `mkSubTmpDir\\([^,]+,\\s*${QUOTED_PREFIX}`,
    ].join("|"),
    "g",
  );
  const set = new Set();
  for (const file of walkSourceFiles(join(repoRoot, "packages", "webui", "test"), [".js", ".mjs"])) {
    for (const line of readSourceLines(file)) {
      for (const match of line.matchAll(CALL_SITES)) {
        const quoted = match[0].match(/["`][^"`\n]+["`]/g);
        if (!quoted) continue;
        const last = quoted[quoted.length - 1].slice(1, -1);
        if (EXAMPLE_PREFIXES.has(last)) continue;
        set.add(last);
      }
    }
  }
  return set;
}

export function verifyPrefixRegistry() {
  const actual = collectActualPrefixes();
  const known = new Set(KNOWN_PREFIXES);
  // Stale entries: in KNOWN_PREFIXES but no test code uses them any more.
  // The 5 trailing catch-all entries (`webui-`, `trajectory-`, `mcode-`,
  // `fs-`, `git-panel-`) are always stale under this definition because
  // no test calls `mkTmpDir("webui-")` literally — collectActualPrefixes
  // extracts only the literal arguments passed to the helper, and tests
  // always pass longer sub-prefixes like `webui-events-test-`. The
  // catch-alls are intentionally a runtime backstop for missing
  // registrations, NOT a forward contract for the test tree. Filter
  // them out before computing stale.
  const CATCHALL = new Set(["webui-", "trajectory-", "mcode-", "fs-", "git-panel-"]);
  const stale = KNOWN_PREFIXES.filter((p) => !actual.has(p) && !CATCHALL.has(p));
  // Unregistered: actual prefixes not present in KNOWN_PREFIXES. The
  // helper order matters here — `webui-events-test-` should match before
  // the `webui-` catch-all; we treat any actual prefix that has no exact
  // entry as unregistered.
  const unregistered = [];
  for (const p of actual) {
    if (!known.has(p)) unregistered.push(p);
  }
  // Bare-mkdtemp check: any test that calls `mkdtempSync(...)` or
  // `await mkdtemp(...)` directly is a leak vector the helper cannot
  // sweep. Surface those call sites as a third verdict class so the
  // gate also catches "added a new test but bypassed the helper".
  const bare = collectBareMkdtemp();
  return { unregistered, stale, bare };
}

function scan(under) {
  const found = {};
  if (!pathExists(under)) return found;
  let entries;
  try {
    entries = readdirSync(under);
  } catch {
    return found;
  }
  for (const name of entries) {
    // Apply known-issue exemption list (see KNOWN_LEAK_EXEMPTIONS above
    // for the upstream issues each entry cites).
    let exempt = null;
    for (const exemptPrefix of KNOWN_LEAK_EXEMPTIONS) {
      if (name.startsWith(exemptPrefix)) {
        exempt = exemptPrefix;
        break;
      }
    }
    if (exempt !== null) continue;
    for (const prefix of KNOWN_PREFIXES) {
      if (name.startsWith(prefix)) {
        const full = join(under, name);
        found[full] = pathExists(full) ? "dir" : "missing";
        break;
      }
    }
  }
  return found;
}

/**
 * Round-3 B6.3 known-issue exemption: runtime-host.test.js (merged
 * in main as part of S2 / PR #78) opens a better-sqlite3 connection
 * per `dataDir/rhXX-XXX/v2/runtime-state.sqlite` but never closes it
 * inside `await host.close()`. The fd keeps the children inode
 * alive past `rmTmpDir(tmpBase)`, so the helper's exit hook leaves a
 * stale empty directory per file run. The root fix is in
 * packages/local-runtime-v2/src/runtime.ts#closeRuntime — it must
 * call `database.close()` before returning. Until that lands, this
 * lint accepts the known leak under `mcode-webui-runtime-host-` so
 * the gate can stay green.
 *
 * The exemption list is intentionally narrow and explicit. Each entry
 * MUST cite the ticket / PR that introduced the upstream issue. When
 * the upstream fix lands, delete the entry — the lint will then
 * re-flag the leak, which is the signal that the upstream fix is
 * correct.
 */
const KNOWN_LEAK_EXEMPTIONS = new Set([
  "mcode-webui-runtime-host-", // PR #78 (S2 / in-process runtime host).
                                 // close() does not call database.close(),
                                 // so the per-test tmpBase stays open as a
                                 // empty directory until the test process
                                 // exits.
]);

/**
 * Round-3 B6.3 follow-up: the bare mkdtempSync / await mkdtemp()
 * check trips on test files that landed on main before this lint was
 * merged (PRs #78 / #81 / #82 / #85 each added bare mkdtempSync
 * calls in tests that we cannot touch in this round). The list below
 * exempts those specific files; each entry MUST cite the upstream PR
 * and a TODO pointing at the follow-up that converts the bare
 * mkdtempSync call into the helper. When a file is migrated to
 * `mkTmpDir`, delete the entry — the bare check will then report
 * zero hits and the exemption becomes noise.
 */
const BARE_EXEMPTIONS = new Set([
  "packages/webui/test/routes/fs-write.test.js",
  "packages/webui/test/routes/sessions.check.mjs",
  "packages/webui/test/routes/sessions-switch-workspace-follow.check.mjs",
  "packages/webui/test/routes/sessions-switch.check.mjs",
]);

/**
 * Public API used by test/source-sync.test.mjs's bidirectional
 * verification. Walks `under` (defaults to the active TMPDIR) and returns
 * an array of absolute paths that match one of KNOWN_PREFIXES.
 *
 * @param {object} [opts]
 * @param {string} [opts.under]  override the directory to scan (used by the
 *   synthetic-leak fixture so the test can prove the detector flags
 *   well-known prefixes without contaminating the host's /tmp).
 * @returns {string[]} absolute paths of well-known-prefix entries
 */
export function scanTmpLeaks({ under } = {}) {
  const root = under ?? (process.env.TMPDIR ?? tmpdir());
  const found = scan(root);
  return Object.keys(found);
}

/**
 * Render the leak list as a human-readable string for `assert.match`
 * assertions in tests. Same shape as `diff`'s stderr listing.
 *
 * @param {string[]} leaks
 * @returns {string}
 */
export function formatTmpLeaks(leaks) {
  if (!leaks || leaks.length === 0) return "no well-known-prefix leaks";
  return ["test-tmp-leak:", ...leaks.map((p) => `  ${p}`)].join("\n");
}

/**
 * Render the prefix-registry verdict the same way — for `assert.match`
 * assertions in test/source-sync.test.mjs.
 */
export function formatPrefixRegistry({ unregistered, stale, bare = [] }) {
  const lines = [];
  if (unregistered.length) {
    lines.push("test-tmp-leak prefix registry: UNREGISTERED (test uses a prefix the lint does not know about):");
    for (const p of unregistered) lines.push(`  + ${p}`);
  }
  if (stale.length) {
    lines.push("test-tmp-leak prefix registry: STALE (lint knows a prefix no test uses any more):");
    for (const p of stale) lines.push(`  - ${p}`);
  }
  if (bare.length) {
    lines.push("test-tmp-leak prefix registry: BARE mkdtemp call sites (bypass the helper — the exit hook cannot sweep these):");
    for (const p of bare) lines.push(`  ! ${p}`);
  }
  if (lines.length === 0) lines.push("test-tmp-leak prefix registry: clean");
  return lines.join("\n");
}

/**
 * Scan the test tree for any DIRECT call to mkdtempSync / await
 * mkdtemp() — i.e. tests that bypass the helper. Returns an array of
 * "<file>:<line>: <call>" entries, one per offending call site. The
 * helper's exit-hook only cleans directories registered through it,
 * so any bare mkdtemp call IS a leak vector that the lint cannot
 * close by design. This surface is the third verdict class returned
 * by verifyPrefixRegistry().
 */
function collectBareMkdtemp() {
  // Match the two call shapes the helper supports:
  //   mkdtempSync(path.join(tmpdir(), "<prefix>-"))
  //   await mkdtemp(path.join(tmpdir(), "<prefix>-"))
  // The helper itself (packages/webui/test/helpers/tmp.js) is excluded
  // by basename below — it MUST call mkdtempSync / mkdtemp, that is its
  // purpose, and we do not want the gate to flag the implementation as
  // a leak.
  const BARE_CALL = /\bmkdtempSync\s*\(|\bawait\s+mkdtemp\s*\(/;
  // BARE_EXEMPTIONS paths are repo-relative with forward slashes; match
  // by basename via path.basename so the exemption holds on every
  // platform (path separators differ on Windows).
  const exemptNames = new Set(Array.from(BARE_EXEMPTIONS).map((p) => basename(p)));
  const hits = [];
  for (const file of walkSourceFiles(join(repoRoot, "packages", "webui", "test"), [".js", ".mjs", ".ts"])) {
    if (basename(file) === "tmp.js") continue;
    if (exemptNames.has(basename(file))) continue;
    const lines = readSourceLines(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!BARE_CALL.test(line)) continue;
      // Comment lines are documentation, not code — they describe the
      // helper's contract by quoting its name. Skip them so the lint
      // does not false-positive on `// ... mkdtempSync ...`.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      hits.push(`${file}:${i + 1}:${line}`.trim());
    }
  }
  return hits;
}

function snapshot(outPath) {
  const under = process.env.TMPDIR ?? tmpdir();
  const found = scan(under);
  writeFileSync(
    outPath,
    JSON.stringify({ under, prefixes: KNOWN_PREFIXES, snapshot: found }, null, 2),
  );
  console.log(`snapshot written: ${outPath} (${Object.keys(found).length} entries under ${under})`);
}

function diff(prevPath) {
  const prev = JSON.parse(readFileSync(prevPath, "utf8"));
  const after = scan(prev.under);
  const prevKeys = new Set(Object.keys(prev.snapshot));
  const newLeaks = [];
  for (const [path, kind] of Object.entries(after)) {
    if (prevKeys.has(path)) continue;
    newLeaks.push({ path, kind });
  }
  if (newLeaks.length === 0) {
    console.log(`leak-lint: clean — no new well-known-prefix directories leaked (${Object.keys(after).length} entries present, all pre-existing).`);
    return;
  }
  // Round-3 B6.3 sub-issue: a few test files (notably runtime-host.test.js,
  // merged in main as part of S2 / PR #78) hold open better-sqlite3
  // connections asynchronously inside `await host.close()`. The
  // connection's fd keeps the children directory's inode alive even
  // after rmSync unlinks it, so tmpBase (which still has those inode-
  // referenced children) cannot be unlinked until those fds close. The
  // kernel reaps the inode after the process's last fd closes, but
  // rmSync runs synchronously and races with the close. We re-stat
  // once more after a small delay — most of these entries disappear
  // within 200ms once node:test's process teardown closes the
  // lingering fds. Anything that survives is reported as a leak.
  const persistent = [];
  if (newLeaks.length > 0) {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, 250);
  }
  for (const { path, kind } of newLeaks) {
    if (!pathExists(path)) continue;
    persistent.push({ path, kind });
  }
  if (persistent.length === 0) {
    console.log(`leak-lint: clean — no new well-known-prefix directories leaked (${Object.keys(after).length} entries present, all pre-existing).`);
    return;
  }
  console.error(`test-tmp-leak: ${persistent.length} NEW well-known-prefix directories leaked after the suite:\n`);
  for (const { path } of persistent) console.error(`  ${path}`);
  console.error(
    `\nEvery entry above is a directory the test suite created under ${prev.under} but did not remove.`,
  );
  console.error(
    "Use packages/webui/test/helpers/tmp.js#mkTmpDir / mkTmpDirAsync / rmTmpDir instead of bare mkdtempSync so the process-exit hook can sweep it.",
  );
  process.exit(1);
}
const cmd = process.argv[2];
// CLI dispatch — only runs when the script is invoked directly
// (not when imported from a test). When `cmd` is undefined and the
// script is the entry point, fall through to the default scan-and-print.
const isEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (cmd === "snapshot") {
  const out = process.argv[3] ?? "/tmp/webui-leak-before.json";
  snapshot(out);
} else if (cmd === "diff") {
  const prev = process.argv[3];
  if (!prev) {
    console.error("usage: test-tmp-leak.check.mjs diff <before.json>");
    process.exit(2);
  }
  diff(prev);
} else if (cmd === "verify-registry") {
  const verdict = verifyPrefixRegistry();
  if (verdict.unregistered.length === 0 && verdict.stale.length === 0 && verdict.bare.length === 0) {
    console.log(`prefix registry: clean (${KNOWN_PREFIXES.length} entries, all referenced by test code)`);
  } else {
    console.error(formatPrefixRegistry(verdict));
    process.exit(1);
  }
} else if (cmd === "list-actual-prefixes") {
  // Diagnostic for the dev: print every prefix the test tree uses, so
  // diffing against KNOWN_PREFIXES is one command away.
  const actual = Array.from(collectActualPrefixes()).sort();
  for (const p of actual) console.log(p);
} else if (cmd !== undefined) {
  console.error(`usage: test-tmp-leak.check.mjs [snapshot FILE | diff FILE | verify-registry | list-actual-prefixes]`);
  process.exit(2);
} else if (cmd === undefined && isEntry) {
  const under = process.env.TMPDIR ?? tmpdir();
  const found = scan(under);
  console.log(`scanned ${under}: ${Object.keys(found).length} well-known-prefix directories present`);
  for (const path of Object.keys(found)) console.log(`  ${path}`);
  console.log(`\nrun 'node scripts/test-tmp-leak.check.mjs snapshot > /tmp/before.json' before a suite, then 'node scripts/test-tmp-leak.check.mjs diff /tmp/before.json' after.`);
}