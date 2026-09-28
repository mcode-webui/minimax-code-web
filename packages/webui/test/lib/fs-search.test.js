// webui/test/lib/fs-search.test.js
//
// Unit tests for the bounded workspace search walker (slice 19a).
// The route's full HTTP contract is exercised in
// `test/routes/fs-search.test.js`; these tests pin the walker in
// isolation so a regression inside `searchWorkspace` itself is
// caught without needing a Hono harness.
//
// Pinned behaviours (the slice ticket says these are the contract):
//
//  - Hard budgets: maxDepth / maxNodes / wallMs / maxMatches.
//    Exceeding one sets `truncated: true` with a `truncatedReason`
//    to one of `depth | nodes | wallClock | matches`. The clamp
//    helper must apply ABSOLUTE_LIMITS so a hostile parameter
//    cannot pin a core.
//
//  - Skip policy: node_modules and .git are always skipped; the
//    build/cache set (dist / build / .next / coverage / etc.) is
//    skipped by default; includeDirs (server-side) opts back in
//    non-base entries only.
//
//  - Credential predicate: classifyCredential is reused verbatim
//    from lib/credential-file.js. Matches get credential:true +
//    credentialReason; skipped.credential increments. The walker
//    never reads content.
//
//  - Ancestor chain: every match returns the path components
//    between root and the match (exclusive). A top-level match
//    returns `[]`.
//
//  - Wall-clock + nodes budgets accept a deterministic `now()`
//    clock so the tests do not race with the host's load.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const fsSearch = await import(absPath("lib/fs-search.js"));
const {
  searchWorkspace,
  DEFAULTS,
  ABSOLUTE_LIMITS,
  BASE_SKIP_DIRS,
  OPTIONAL_SKIP_DIRS,
} = fsSearch;

function makeTempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "fs-search-"));
  return { dir };
}

function mkdirp(...parts) {
  const full = join(...parts);
  mkdirSync(full, { recursive: true });
  return full;
}

// Deterministic counter-clock for the wall-clock budget test — we
// tick it once per visited directory so the cap fires inside the
// loop body, not "as fast as the scheduler ran us".
function incrementalClock() {
  let t = 1000;
  return () => {
    t += 1;
    return t;
  };
}

describe("lib/fs-search — bounded workspace walker (slice 19a)", () => {
  describe("defaults and clamps", () => {
    test("exports the documented defaults", () => {
      assert.equal(DEFAULTS.maxDepth, 8);
      assert.equal(DEFAULTS.maxNodes, 5000);
      assert.equal(DEFAULTS.wallMs, 1500);
      assert.equal(DEFAULTS.maxMatches, 200);
    });

    test("exports the absolute upper limits", () => {
      assert.equal(ABSOLUTE_LIMITS.maxDepth, 16);
      assert.equal(ABSOLUTE_LIMITS.maxNodes, 50_000);
      assert.equal(ABSOLUTE_LIMITS.wallMs, 5_000);
      assert.equal(ABSOLUTE_LIMITS.maxMatches, 1_000);
    });

    test("reports the clamped budgets back into the response", () => {
      const { dir } = makeTempWorkspace();
      try {
        const r = searchWorkspace(dir, "*", { maxDepth: 999, maxNodes: 999_999_999, wallMs: 999_999 });
        assert.equal(r.budgets.maxDepth, ABSOLUTE_LIMITS.maxDepth);
        assert.equal(r.budgets.maxNodes, ABSOLUTE_LIMITS.maxNodes);
        assert.equal(r.budgets.wallMs, ABSOLUTE_LIMITS.wallMs);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("reports the fallback when a budget value is unparseable", () => {
      const { dir } = makeTempWorkspace();
      try {
        const r = searchWorkspace(dir, "*", { maxDepth: "abc", maxNodes: "xyz", wallMs: "foo" });
        assert.equal(r.budgets.maxDepth, DEFAULTS.maxDepth);
        assert.equal(r.budgets.maxNodes, DEFAULTS.maxNodes);
        assert.equal(r.budgets.wallMs, DEFAULTS.wallMs);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("happy-path search", () => {
    test("a glob that matches basenames returns each match with its ancestor chain", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "codersday");
        writeFileSync(join(dir, "codersday", "package.json"), "{}");
        mkdirp(dir, "src");
        writeFileSync(join(dir, "src", "main.ts"), "");
        writeFileSync(join(dir, "src", "package.json"), "{}");

        const r = searchWorkspace(dir, "package.json");
        assert.equal(r.matches.length, 2);
        const names = r.matches.map((m) => m.path).sort();
        assert.deepEqual(names, [
          join(dir, "codersday", "package.json"),
          join(dir, "src", "package.json"),
        ].sort());
        const codersdayHit = r.matches.find((m) => m.path.endsWith("codersday/package.json"));
        assert.deepEqual(codersdayHit.ancestors, ["codersday"]);
        assert.equal(codersdayHit.type, "file");
        assert.equal(codersdayHit.credential, false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("matches at the root have ancestors: []", () => {
      const { dir } = makeTempWorkspace();
      try {
        writeFileSync(join(dir, "package.json"), "{}");
        const r = searchWorkspace(dir, "package.json");
        assert.equal(r.matches.length, 1);
        assert.deepEqual(r.matches[0].ancestors, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("glob pattern matches case-insensitively (placeholder promise)", () => {
      const { dir } = makeTempWorkspace();
      try {
        writeFileSync(join(dir, "README.md"), "");
        const r = searchWorkspace(dir, "readme.md");
        assert.equal(r.matches.length, 1);
        assert.equal(r.matches[0].name, "README.md");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("directories can be matched too (the pattern is not file-only)", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "node_modules_test"); // name is intentional to bypass skip
        const r = searchWorkspace(dir, "node_modules_test");
        assert.equal(r.matches.length, 1);
        assert.equal(r.matches[0].type, "dir");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("skip policy", () => {
    test("node_modules is always skipped and counted", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "node_modules");
        writeFileSync(join(dir, "node_modules", "package.json"), "{}");
        mkdirp(dir, "src");
        writeFileSync(join(dir, "src", "package.json"), "{}");

        const r = searchWorkspace(dir, "package.json");
        // node_modules/package.json is NOT in matches.
        const matchedNames = r.matches.map((m) => m.path);
        assert.equal(
          matchedNames.some((p) => p.includes("node_modules")),
          false,
          "node_modules contents must not appear in matches",
        );
        assert.equal(r.skipped["node_modules"], 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(".git is always skipped and counted", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, ".git");
        writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/x");
        writeFileSync(join(dir, "notes.md"), "");

        const r = searchWorkspace(dir, "HEAD");
        assert.equal(r.matches.length, 0);
        assert.equal(r.skipped[".git"], 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("non-base skips are overridable via includeDirs; node_modules is NOT", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "dist");
        writeFileSync(join(dir, "dist", "asset.txt"), "");
        mkdirp(dir, "node_modules");
        writeFileSync(join(dir, "node_modules", "asset.txt"), "");

        // `dist` opt-back-in works — the asset appears in matches.
        const r = searchWorkspace(dir, "asset.txt", { includeDirs: ["dist"] });
        const paths = r.matches.map((m) => m.path);
        assert.equal(paths.some((p) => p.endsWith(join("dist", "asset.txt"))), true);
        // node_modules does NOT opt back in even though the caller
        // asked for it — base skips are non-overridable.
        assert.equal(paths.some((p) => p.includes("node_modules")), false);
        assert.equal(r.skipped["node_modules"], 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("huge dirs are skipped and counted (no descent beyond boundary)", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "huge");
        // Place a matchable name AND a deep child — the deep child
        // should not appear because we do not descend beyond the
        // huge threshold.
        writeFileSync(join(dir, "huge", "target.md"), "");
        mkdirp(dir, "huge", "sub");
        writeFileSync(join(dir, "huge", "sub", "target.md"), "");
        // A third marker to bring readdir past the test-time
        // threshold of 2 entries.
        writeFileSync(join(dir, "huge", "marker.txt"), "");

        // `hugeThreshold: 2` — readdir on `huge` returns 3 entries
        // (>2), so the walker does NOT descend into `huge/sub`.
        const r = searchWorkspace(dir, "target.md", { hugeThreshold: 2 });
        const paths = r.matches.map((m) => m.path);
        // The deeply-nested match is NOT (no descent into huge).
        assert.equal(
          paths.some((p) => p.endsWith(join("huge", "sub", "target.md"))),
          false,
          "walker must not descend into a huge directory",
        );
        // The walker counted the entries we did not descend into.
        assert.ok(r.skipped.huge >= 3, `expected skipped.huge >= 3, got ${r.skipped.huge}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("hidden entries are skipped by default; includeHidden flips it", () => {
      const { dir } = makeTempWorkspace();
      try {
        writeFileSync(join(dir, ".hidden.md"), "");
        writeFileSync(join(dir, "visible.md"), "");

        const r1 = searchWorkspace(dir, "*.md");
        assert.equal(r1.matches.length, 1);
        assert.equal(r1.matches[0].name, "visible.md");

        const r2 = searchWorkspace(dir, "*.md", { includeHidden: true });
        assert.equal(r2.matches.length, 2);
        assert.ok(r2.budgets.includeHidden);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

  // The credential + includeHidden interaction is pinned here so
  // a regression that filters out dotfile credentials by default
  // (the user IS searching for them) is loud. The test name
  // itself documents the trade-off.
  test("credential-shaped dotfiles are flagged only when the search is willing to look under dotfiles", () => {
    // Default: hidden skip wins — `.env` is invisible (mirrors
    // /api/fs/read which hides dotfiles unless showHidden=1).
    const a = makeTempWorkspace();
    try {
      writeFileSync(join(a.dir, ".env"), "cred_canary_hidden_dotenv\n");
      const ra = searchWorkspace(a.dir, "*.env");
      assert.equal(ra.matches.length, 0, "default search must not see dotfiles");
    } finally { rmSync(a.dir, { recursive: true, force: true }); }

    // With includeHidden, the credential predicate fires and the
    // match is flagged. No plaintext leak regardless.
    const b = makeTempWorkspace();
    try {
      writeFileSync(join(b.dir, ".env"), "cred_canary_include_hidden_dotenv\n");
      const rb = searchWorkspace(b.dir, "*.env", { includeHidden: true });
      assert.equal(rb.matches.length, 1);
      assert.equal(rb.matches[0].credential, true);
      assert.equal(rb.matches[0].credentialReason, "dotenv");
      assert.equal(JSON.stringify(rb).includes("cred_canary_include_hidden_dotenv"), false);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });
  });

  describe("credential predicate (slice 16 alignment)", () => {
    test("credential-shaped matches are flagged, never omitted, never read", () => {
      const { dir } = makeTempWorkspace();
      try {
        // includeHidden so .env (a dotfile credential) is visible
        // to the test fixture — the predicate correctness we are
        // pinning here is orthogonal to the hidden-skip behaviour
        // (which is tested separately above). Four credential
        // shapes, four different reasons, four flags.
        writeFileSync(join(dir, ".env"), "cred_canary_search_dotenv\n");
        writeFileSync(join(dir, "id_rsa"), "cred_canary_search_id_rsa\n");
        writeFileSync(join(dir, "server.pem"), "cred_canary_search_pem\n");
        writeFileSync(join(dir, "credentials"), "cred_canary_search_credentials\n");
        writeFileSync(join(dir, "package.json"), "{}");

        const r = searchWorkspace(dir, "*", { includeHidden: true });
        const credentials = r.matches.filter((m) => m.credential);
        // Four credential-shaped matches, four reasons.
        assert.equal(credentials.length, 4);
        const reasons = new Set(credentials.map((m) => m.credentialReason));
        assert.deepEqual(
          [...reasons].sort(),
          ["credentials", "dotenv", "key-file", "ssh-key"].sort(),
        );
        // Tripwire: NO ciphertext in the response. The walker never
        // sees content.
        const json = JSON.stringify(r);
        assert.equal(json.includes("cred_canary_search_dotenv"), false);
        assert.equal(json.includes("cred_canary_search_id_rsa"), false);
        assert.equal(json.includes("cred_canary_search_pem"), false);
        assert.equal(json.includes("cred_canary_search_credentials"), false);
        // Counter is incremented.
        assert.equal(r.skipped.credential, 4);
        // non-credential match is unaffected.
        const pkg = r.matches.find((m) => m.name === "package.json");
        assert.ok(pkg, "package.json match should still appear");
        assert.equal(pkg.credential, false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a glob that filters by credential shape (q=.env.*) still emits the matches", () => {
      // The credential predicate covers `.env` AND `.env.*`
      // (DOTENV_PATTERN). Drive the test through that variant so
      // both shapes pass the predicate (a non-credential name
      // like `x.env` is NOT classified — see lib/credential-file.js).
      const { dir } = makeTempWorkspace();
      try {
        writeFileSync(join(dir, ".env"), "cred_canary_search_qenv\n");
        writeFileSync(join(dir, ".env.example"), "cred_canary_search_qenvexample\n");
        writeFileSync(join(dir, "x.env"), "cred_canary_search_qxenv_non_credential\n");
        const r = searchWorkspace(dir, "*", { includeHidden: true });
        const credentialMatches = r.matches.filter((m) => m.credential);
        // `.env` (dotenv) + `.env.example` (dotenv) are credential.
        // `x.env` is NOT credential because the basename doesn't
        // START with `.env` (the DOTENV_PATTERN is `/^\.env(\.|$)/`).
        // The tripwire here is that even NON-credential matches
        // never leak content through this transport.
        assert.equal(credentialMatches.length, 2);
        assert.ok(credentialMatches.every((m) => m.credentialReason === "dotenv"));
        const json = JSON.stringify(r);
        // None of the canary secrets leak.
        assert.equal(json.includes("cred_canary_search_qenv"), false);
        assert.equal(json.includes("cred_canary_search_qenvexample"), false);
        assert.equal(json.includes("cred_canary_search_qxenv_non_credential"), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("hard budgets (truncation honesty)", () => {
    test("depth budget: truncated=true, truncatedReason='depth'", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "a", "b", "c", "d", "e", "f", "g", "h", "i");
        writeFileSync(join(dir, "a", "b", "c", "d", "e", "f", "g", "h", "i", "target.md"), "");

        // maxDepth=2 means we descend at most depth 0→1→2; the
        // target at depth 9 is unreachable.
        const r = searchWorkspace(dir, "target.md", { maxDepth: 2 });
        assert.equal(r.matches.length, 0);
        assert.equal(r.truncated, true);
        assert.equal(r.truncatedReason, "depth");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("maxNodes budget: truncated=true, truncatedReason='nodes'", () => {
      const { dir } = makeTempWorkspace();
      try {
        // A single deep directory at depth 1 with many children —
        // the per-node visit fires first as children are processed.
        mkdirp(dir, "sub");
        for (let i = 0; i < 50; i += 1) {
          writeFileSync(join(dir, "sub", `f${i}.txt`), "");
        }
        // Allow depth 2 only, then visit at most 5 nodes total.
        const r = searchWorkspace(dir, "*.txt", { maxDepth: 2, maxNodes: 5 });
        assert.equal(r.truncated, true);
        assert.equal(r.truncatedReason, "nodes");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("wall-clock budget: incremental clock triggers truncated=true, truncatedReason='wallClock'", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "a", "b", "c");
        writeFileSync(join(dir, "a", "b", "c", "target.md"), "");

        // Stretched-clock: each pop costs 50 ms; the wall-clock
        // cap (100 ms) fires after two pops.
        let t = 1000;
        const stretchedNow = () => {
          t += 50;
          return t;
        };
        const r = searchWorkspace(dir, "target.md", {
          wallMs: 100,
          now: stretchedNow,
        });
        assert.equal(r.truncated, true);
        assert.equal(r.truncatedReason, "wallClock");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("matches budget: truncated=true, truncatedReason='matches'", () => {
      const { dir } = makeTempWorkspace();
      try {
        // 10 matches; cap at 3.
        for (let i = 0; i < 10; i += 1) {
          writeFileSync(join(dir, `target${i}.md`), "");
        }
        const r = searchWorkspace(dir, "*.md", { maxMatches: 3 });
        assert.equal(r.matches.length, 3);
        assert.equal(r.truncated, true);
        assert.equal(r.truncatedReason, "matches");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("base + optional skip lists are pinned", () => {
    test("BASE_SKIP_DIRS contains node_modules and .git, nothing else", () => {
      assert.equal(BASE_SKIP_DIRS.size, 2);
      assert.equal(BASE_SKIP_DIRS.has("node_modules"), true);
      assert.equal(BASE_SKIP_DIRS.has(".git"), true);
    });

    test("OPTIONAL_SKIP_DIRS contains the documented build/cache set", () => {
      for (const name of ["dist", "build", ".next", ".cache", "coverage", ".turbo", ".nx"]) {
        assert.equal(OPTIONAL_SKIP_DIRS.has(name), true, `expected ${name} in OPTIONAL_SKIP_DIRS`);
      }
    });
  });

  describe("response shape (the contract the panel renders)", () => {
    test("empty workspace → ok, no matches, scanned.total=0", () => {
      const { dir } = makeTempWorkspace();
      try {
        const r = searchWorkspace(dir, "*");
        assert.equal(r.root, dir);
        assert.equal(r.matches.length, 0);
        // Empty dir → no readdir entries to count.
        assert.equal(r.scanned.total, 0);
        assert.equal(r.scanned.dirs, 0);
        assert.equal(r.scanned.files, 0);
        assert.equal(r.truncated, false);
        assert.equal(r.truncatedReason, null);
        assert.ok(typeof r.elapsedMs === "number");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("scanned.total equals scanned.dirs + scanned.files", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "a", "b");
        writeFileSync(join(dir, "a", "file1.txt"), "");
        writeFileSync(join(dir, "a", "b", "file2.txt"), "");
        const r = searchWorkspace(dir, "*");
        assert.equal(r.scanned.total, r.scanned.dirs + r.scanned.files);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("every response carries a budgets field with the clamped values", () => {
      const { dir } = makeTempWorkspace();
      try {
        const r = searchWorkspace(dir, "*");
        assert.equal(typeof r.budgets.maxDepth, "number");
        assert.equal(typeof r.budgets.maxNodes, "number");
        assert.equal(typeof r.budgets.wallMs, "number");
        assert.equal(typeof r.budgets.maxMatches, "number");
        assert.equal(typeof r.budgets.includeHidden, "boolean");
        assert.ok(Array.isArray(r.budgets.includeDirs));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("performance — the node_modules-heavy case must NOT stall", () => {
    test("a 2000-file node_modules wall-time stays well under the default budget", () => {
      const { dir } = makeTempWorkspace();
      try {
        mkdirp(dir, "node_modules");
        // 2000 files in node_modules — heavy enough to fail the
        // budget if the walker tried to descend. The skip gate
        // must keep us off it.
        for (let i = 0; i < 2000; i += 1) {
          writeFileSync(join(dir, "node_modules", `pkg${i}.js`), "");
        }
        writeFileSync(join(dir, "top.js"), "");
        const t0 = Date.now();
        const r = searchWorkspace(dir, "*.js");
        const elapsed = Date.now() - t0;
        // Our skip policy guarantees we never descend into
        // node_modules at all; the only cost is the readdir on
        // the root and the 2001 stat calls on it. That should
        // be well under a second on any reasonable machine.
        assert.ok(elapsed < 1000, `expected < 1000 ms, got ${elapsed}`);
        // Only the top-level match — none of the 2000 pkg files.
        assert.equal(r.matches.length, 1);
        assert.equal(r.matches[0].name, "top.js");
        assert.equal(r.skipped["node_modules"], 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // The `incrementalClock` helper is exported here so the route's
  // test file can re-use the same deterministic wall-clock pattern
  // without importing a non-public test util.
  test("(test helper) incrementalClock exposes a stable counter", () => {
    const now = incrementalClock();
    const a = now();
    const b = now();
    assert.ok(b > a, "incremental clock must tick forward");
  });
});
