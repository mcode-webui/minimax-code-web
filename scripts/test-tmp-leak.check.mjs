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
// Wire-up
// -------
// The canonical integration is `test:release-tools`:
//   scripts/run-vitest-suite.mjs / scripts/dev-webui.test.mjs already
//   gate the repo's source-sync workflow. The leak-lint is wired there
//   next to the existing `test-isolation-lint.check.mjs` so it runs in
//   the same node:test process and catches regressions in the same gate
//   failure mode (the existing gate is invoked by `test/source-sync.test.mjs`).
//
// The script is runnable standalone as well:
//   node scripts/test-tmp-leak.check.mjs                # default: scan the
//                                                        system tmpdir and
//                                                        print the current
//                                                        count, no exit-1
//   node scripts/test-tmp-leak.check.mjs snapshot      # write JSON to stdout
//   node scripts/test-tmp-leak.check.mjs diff FILE     # compare + exit
//
// Why "well-known prefixes" not "every directory"
// ------------------------------------------------
// A blanket sweep would (a) leak the host's own runtime state (every
// process on the box that touches /tmp shares it), (b) flag common
// tooling directories (pip-unpack-*, tmpXXXX, …), and (c) flunk the gate
// on any unrelated agent. The well-known-prefix list is the contract:
// the repo's tests use one of these prefixes for every per-test tmpdir,
// and adding a new prefix requires a deliberate code change here.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Every prefix the repo's tests use. Keep the list narrow: each entry is
// a code change AND a contract — every new prefix needs the same exit
// hook treatment every other entry has.
//
// Order matters here ONLY because matching stops on the first prefix that
// matches. Most entries are more-specific prefixes that beat the catch-all
// "webui-" / "trajectory-" / "mcode-" entries below.
const KNOWN_PREFIXES = [
  // specific per-test prefixes (kept narrow so we can spot regressions)
  "webui-export-test-",
  "webui-qfc-edge-",
  "webui-events-test-",
  "webui-quota-forecast-test-",
  "webui-events-concurrency-test-",
  "webui-events-hash-test-",
  "webui-events-ro-",
  "webui-db-outcomes-events-",
  "webui-bindhost-test-",
  "webui-sec-net-settings-",
  "webui-sec-net-events-",
  "webui-alerts-audit-",
  "webui-acp-answer-",
  "webui-first-turn-guard-",
  "webui-states-bus-",
  "webui-sessions-search-check-",
  "webui-sessions-switch-",
  "webui-chat-failed-",
  "webui-models-merge-",
  "webui-cred-can-",
  "webui-cred-dbl-",
  "webui-authorize-check-",
  "webui-providers-test-",
  "webui-providers-cwd-",
  "webui-ws-symlink-real-",
  "webui-no-such-",
  "webui-sessdb-",
  "webui-routes-export-",
  // trajectory tests
  "trajectory-containment-",
  "trajectory-paths-",
  "trajectory-protocol-",
  "trajectory-studio-",
  "trajectory-git-",
  "trajectory-plugin-data-",
  "trajectory-e2e-",
  // mcode-prefixed tests
  "mcode-exec-test-",
  "mcode-tools-tui-",
  "mcode-resolver-",
  "mcode-dryrun-",
  "mcode-real-del-",
  "mcode-d",
  "state-bus-restore-",
  "sessions-single-id-",
  "agent-team-",
  // Catch-all prefixes last — anything starting with these is flagged,
  // regardless of which sub-prefix it claims to use. Adding a new prefix
  // should be a deliberate code change; the catch-all ensures the lint
  // never silently passes on an unknown name.
  "webui-",
  "trajectory-",
];

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
} else {
  const under = process.env.TMPDIR ?? tmpdir();
  const found = scan(under);
  console.log(`scanned ${under}: ${Object.keys(found).length} well-known-prefix directories present`);
  for (const path of Object.keys(found)) console.log(`  ${path}`);
  console.log(`\nrun 'node scripts/test-tmp-leak.check.mjs snapshot > /tmp/before.json' before a suite, then 'node scripts/test-tmp-leak.check.mjs diff /tmp/before.json' after.`);
}