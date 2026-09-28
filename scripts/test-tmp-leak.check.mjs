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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

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
  "mcode-exec-test-",
  "mcode-resolver-bad-",
  "mcode-resolver-empty-",
  "mcode-resolver-mac-",
  "mcode-resolver-valid-",
  "mcode-resolver-win-",
  "mcode-webui-bind-",
  "mcode-webui-c08-",
  "mcode-webui-d02-chain-",
  "mcode-webui-d02-router-",
  "mcode-webui-d02-sse-",
  "mcode-webui-libsettings-iso-",
  "mcode-webui-mock-",
  "mcode-webui-port-fallback-",
  "mcode-webui-readonly-",
  "mcode-webui-test-",
  "mcode-webui-upload-e2e-",
  "mcode-webui-upload-lib-",
  "mcode-webui-usage-",
  "mcode-webui-w2-gate-",
  "minimax-code-engine-cat-",
  "minimax-code-engine-sync-",
  "sessions-single-id-",
  "state-bus-restore-",
  "webui-acp-answer-",
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
  "webui-db-out-lock-",
  "webui-db-out-schema-",
  "webui-db-out-zero-",
  "webui-db-outcomes-events-",
  "webui-db-test-",
  "webui-db-test2-",
  "webui-dryrun-",
  "webui-events-concurrency-test-",
  "webui-events-hash-test-",
  "webui-events-ro-",
  "webui-events-test-",
  "webui-export-test-",
  "webui-first-turn-guard-",
  "webui-lan-gate-test-events-",
  "webui-model-engine-cat-",
  "webui-model-user-level-",
  "webui-models-merge-",
  "webui-origingate-events-",
  "webui-origingate-settings-",
  "webui-parent-out-",
  "webui-parent-root-",
  "webui-paths-",
  "webui-presets-route-",
  "webui-presets-route-cwd-",
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
  "webui-sessions-search-check-",
  "webui-sessions-test-events-",
  "webui-settings-test-events-",
  "webui-switch-test-db-",
  "webui-switch-test-events-",
  "webui-transcript-test-",
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
];

/**
 * Scan packages/webui/test/ for every mkTmpDir / mkTmpDirAsync /
 * mkSubTmpDir invocation and return the set of literal prefix arguments
 * the repo's tests use. Driven by ripgrep so we stay consistent with the
 * rest of the repo's grep-style scanning.
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
  // — POSIX ERE cannot reliably exclude newlines inside a character
  // class (`\n` is treated as the literal two-character sequence, and
  // raw newlines break the class), so we limit ourselves to the
  // characters that prefixes can actually contain. Anything more exotic
  // (e.g. a prefix containing a quote) is a deliberate exception the
  // author should have escaped by then, and the registry check would
  // surface the missing entry on the next run anyway.
  const PREFIX_CHAR = `[a-zA-Z0-9_-]`;
  const pattern = [
    `mkTmpDir\\(\\s*["${BACKTICK}"]${PREFIX_CHAR}*["${BACKTICK}"]`,
    `mkTmpDirAsync\\(\\s*["${BACKTICK}"]${PREFIX_CHAR}*["${BACKTICK}"]`,
    `mkSubTmpDir\\([^,]+,\\s*["${BACKTICK}"]${PREFIX_CHAR}*["${BACKTICK}"]`,
  ].join("|");
  let out = "";
  try {
    out = execFileSync(
      "grep",
      [
        "-rEoh",
        "--include=*.js",
        "--include=*.mjs",
        pattern,
        join(repoRoot, "packages", "webui", "test"),
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (e) {
    if (e.status !== 1) throw e;
    out = "";
  }
  const set = new Set();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const matches = line.match(/["`][^"`\n]+["`]/g);
    if (!matches) continue;
    const last = matches[matches.length - 1].slice(1, -1);
    if (EXAMPLE_PREFIXES.has(last)) continue;
    set.add(last);
  }
  return set;
}

export function verifyPrefixRegistry() {
  const actual = collectActualPrefixes();
  const known = new Set(KNOWN_PREFIXES);
  // Stale entries: in KNOWN_PREFIXES but no test code uses them any more.
  // (We tolerate KNOWN_PREFIXES entries that are catch-alls subsumed by a
  // sibling entry, e.g. a wider "fs-" would still be stale if no test
  // calls it directly. Same rule for both sides.)
  const stale = KNOWN_PREFIXES.filter((p) => !actual.has(p));
  // Unregistered: actual prefixes not present in KNOWN_PREFIXES. The
  // helper order matters here — `webui-events-test-` should match before
  // a hypothetical `webui-` catch-all; we treat any actual prefix that
  // has no exact entry as unregistered.
  const unregistered = [];
  for (const p of actual) {
    if (!known.has(p)) unregistered.push(p);
  }
  return { unregistered, stale };
}

function scan(under) {
  const found = {};
  if (!existsSync(under)) return found;
  let entries;
  try {
    entries = readdirSync(under);
  } catch {
    return found;
  }
  for (const name of entries) {
    for (const prefix of KNOWN_PREFIXES) {
      if (name.startsWith(prefix)) {
        const full = join(under, name);
        found[full] = existsSync(full) ? "dir" : "missing";
        break;
      }
    }
  }
  return found;
}

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
export function formatPrefixRegistry({ unregistered, stale }) {
  const lines = [];
  if (unregistered.length) {
    lines.push("test-tmp-leak prefix registry: UNREGISTERED (test uses a prefix the lint does not know about):");
    for (const p of unregistered) lines.push(`  + ${p}`);
  }
  if (stale.length) {
    lines.push("test-tmp-leak prefix registry: STALE (lint knows a prefix no test uses any more):");
    for (const p of stale) lines.push(`  - ${p}`);
  }
  if (lines.length === 0) lines.push("test-tmp-leak prefix registry: clean");
  return lines.join("\n");
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
    if (!prevKeys.has(path)) newLeaks.push({ path, kind });
  }
  if (newLeaks.length === 0) {
    console.log(`leak-lint: clean — no new well-known-prefix directories leaked (${Object.keys(after).length} entries present, all pre-existing).`);
    return;
  }
  console.error(`test-tmp-leak: ${newLeaks.length} NEW well-known-prefix directories leaked after the suite:\n`);
  for (const { path } of newLeaks) console.error(`  ${path}`);
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
  if (verdict.unregistered.length === 0 && verdict.stale.length === 0) {
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