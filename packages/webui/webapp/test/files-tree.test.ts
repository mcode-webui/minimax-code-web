// webapp/test/files-tree.test.ts
//
// Pure-logic pins for the collapsible file tree added in webui-parity
// 01. Every helper under test lives in `webapp/lib/files-tree.ts` and
// is React-free (no DOM, no fetch, no sessionStorage), so the webapp
// `node:test` runner covers it directly with no jsdom harness.
//
// What is pinned here:
//   * Child ordering: directories first, alphabetical within groups.
//   * Ancestor computation: stops at the workspace root, never
//     produces a path above the root, excludes the target itself.
//   * Filter-driven auto-expansion: ancestors of every matching
//     loaded entry are added; the union with the existing expanded
//     set is returned unchanged when the filter is empty.
//   * Cumulative cap: filter is applied before the visible-cap so a
//     wide glob on a noisy folder never silently renders nothing.
//   * Persistence round-trip: serialize / deserialize are stable and
//     safe against garbage input (bad JSON, missing fields, version
//     mismatch, workspace mismatch).
//   * Type colour buckets: cover the extensions the ticket lists
//     (md/env/json/lock/yaml/images/code/log) and an unknown default.
//   * Relative-mtime bucketing: pins the bucket key the component
//     reads from `t(...)`.
//
// The component itself (lazy fetch, race-safe gen counter, keyboard,
// sessionStorage hydrate/save) lives in
// `components/panels.tsx#FilesPanel` and is exercised end-to-end by
// the live self-check against an isolated dev instance. The component
// has no DOM render path to test from `node:test` (no jsdom), so the
// pure logic + the live render are the two halves of the regression.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { FsEntry } from "../lib/api";
import {
  applyFilterAndCap,
  ancestorsOf,
  deserializeExpansion,
  EXPANDED_STATE_VERSION,
  fileTypeColor,
  FILES_VISIBLE_LIMIT,
  filterAncestors,
  formatSize,
  relativeMtimeBucket,
  serializeExpansion,
  sortEntries,
} from "../lib/files-tree";

function entry(name: string, type: "dir" | "file", extras: Partial<FsEntry> = {}): FsEntry {
  return {
    name,
    path: `/proj/${name}`,
    type,
    size: type === "dir" ? 0 : 10,
    mtime: 0,
    mode: "644",
    icon: type === "dir" ? "folder" : "file",
    ...extras,
  };
}

describe("sortEntries", () => {
  test("puts directories before files and sorts each group alphabetically", () => {
    const ordered = sortEntries([
      entry("zeta.md", "file"),
      entry("alfa", "dir"),
      entry("beta.txt", "file"),
      entry("aardvark", "dir"),
      entry("alfa.txt", "file"),
    ]);
    assert.deepEqual(
      ordered.map((e) => e.name),
      ["aardvark", "alfa", "alfa.txt", "beta.txt", "zeta.md"],
    );
  });

  test("returns a copy (does not mutate the input)", () => {
    const input = [entry("z", "file"), entry("a", "dir")];
    const snapshot = input.map((e) => e.name);
    sortEntries(input);
    assert.deepEqual(
      input.map((e) => e.name),
      snapshot,
    );
  });
});

describe("ancestorsOf", () => {
  test("returns empty when target is the root", () => {
    assert.deepEqual(ancestorsOf("/proj", "/proj"), []);
  });

  test("returns empty for an empty target", () => {
    assert.deepEqual(ancestorsOf("", "/proj"), []);
  });

  test("returns an empty list one level below the root (root is implicit)", () => {
    // The root is implicitly expanded by the panel — there is no row
    // to mark "expanded" for it. So a target one level deep has no
    // ancestor that needs to be flagged.
    assert.deepEqual(ancestorsOf("/proj/src", "/proj"), []);
  });

  test("returns ancestors in top-down order, excluding the target and the root", () => {
    assert.deepEqual(
      ancestorsOf("/proj/src/lib/deep", "/proj"),
      ["/proj/src", "/proj/src/lib"],
    );
  });

  test("stops at the workspace root even when target is far above it", () => {
    // A path outside the workspace must produce no ancestors, since
    // the tree cannot reveal what sits above the root.
    assert.deepEqual(ancestorsOf("/proj", "/proj/inside"), []);
  });

  test("handles a trailing slash on the target", () => {
    assert.deepEqual(ancestorsOf("/proj/src/", "/proj"), []);
  });

  test("handles the filesystem root as the workspace root", () => {
    assert.deepEqual(ancestorsOf("/var/log", "/"), ["/var"]);
  });
});

describe("filterAncestors", () => {
  test("returns the original set when the filter is empty", () => {
    const loaded = {
      "/proj/src": [entry("index.ts", "file"), entry("lib", "dir")],
    };
    const initial = new Set<string>(["/proj/src"]);
    const next = filterAncestors(loaded, "", "/proj", initial);
    assert.deepEqual([...next].sort(), ["/proj/src"]);
  });

  test("whitespace-only filter is treated as no filter", () => {
    const loaded = {
      "/proj/src": [entry("index.ts", "file")],
    };
    const initial = new Set<string>(["/proj/src"]);
    const next = filterAncestors(loaded, "   ", "/proj", initial);
    assert.deepEqual([...next].sort(), ["/proj/src"]);
  });

  test("auto-expands the matching entry's directory chain", () => {
    const loaded = {
      "/proj/src": [entry("lib", "dir"), entry("index.ts", "file")],
      "/proj/src/lib": [entry("util.ts", "file")],
      "/proj/docs": [entry("README.md", "file")],
    };
    const initial = new Set<string>();
    const next = filterAncestors(loaded, "*.ts", "/proj", initial);
    assert.ok(next.has("/proj/src"));
    assert.ok(next.has("/proj/src/lib"));
    assert.ok(!next.has("/proj/docs"));
  });

  test("directory matches themselves are skipped (only files are hits)", () => {
    const loaded = {
      "/proj": [entry("build", "dir")],
    };
    const next = filterAncestors(loaded, "build", "/proj", new Set());
    // "build" is a directory, not a file, so it is not surfaced as a
    // hit — but its directory (/) doesn't qualify either since `/proj`
    // is the root.
    assert.equal(next.size, 0);
  });

  test("preserves the user's explicit expansion when adding ancestors", () => {
    const loaded = {
      "/proj/src": [entry("index.ts", "file")],
    };
    const initial = new Set<string>(["/proj/something-else"]);
    const next = filterAncestors(loaded, "*.ts", "/proj", initial);
    assert.ok(next.has("/proj/something-else"));
    assert.ok(next.has("/proj/src"));
  });

  test("does not recurse into unloaded subtrees (no recursive prefetch)", () => {
    // `/proj/unloaded` is in the listing but its children were never
    // fetched. Filter hits that would live inside it must NOT cause
    // a fetch or a synthetic ancestor — the helper must silently
    // skip them. The ticket forbids recursive prefetch.
    const loaded = {
      "/proj": [entry("unloaded", "dir"), entry("README.md", "file")],
    };
    const next = filterAncestors(loaded, "*", "/proj", new Set());
    assert.deepEqual([...next].sort(), ["/proj"]);
  });
});

describe("applyFilterAndCap", () => {
  test("filters first, caps second", () => {
    // 600 files, filter to *.md: only 2 match, so visible=2 hidden=0.
    const entries = [
      entry("a.md", "file"),
      entry("b.md", "file"),
      entry("c.txt", "file"),
      entry("d.txt", "file"),
    ];
    const out = applyFilterAndCap(entries, "*.md");
    assert.deepEqual(out.visible.map((e) => e.name), ["a.md", "b.md"]);
    assert.equal(out.hidden, 0);
    assert.equal(out.matched, 2);
  });

  test("reports hidden rows when the cap cuts the match list", () => {
    const entries: FsEntry[] = [];
    for (let i = 0; i < FILES_VISIBLE_LIMIT + 50; i++) {
      entries.push(entry(`note-${i}.md`, "file"));
    }
    const out = applyFilterAndCap(entries, "*.md");
    assert.equal(out.visible.length, FILES_VISIBLE_LIMIT);
    assert.equal(out.hidden, 50);
    assert.equal(out.matched, FILES_VISIBLE_LIMIT + 50);
  });

  test("treats an empty filter as 'no filter'", () => {
    const entries = [entry("a", "dir"), entry("b", "file")];
    const out = applyFilterAndCap(entries, "  ");
    assert.equal(out.matched, 2);
    assert.equal(out.hidden, 0);
  });

  test("respects a caller-supplied cap (the per-node FILES_VISIBLE_LIMIT default)", () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry(`x${i}.ts`, "file"));
    const out = applyFilterAndCap(entries, "*", 3);
    assert.equal(out.visible.length, 3);
    assert.equal(out.hidden, 4);
  });
});

describe("serializeExpansion / deserializeExpansion", () => {
  test("round-trips expanded + filter + showHidden", () => {
    const state = {
      expanded: ["/proj/src", "/proj/src/lib"],
      filter: "*.ts",
      showHidden: true,
    };
    const wire = serializeExpansion(state, "/proj");
    const back = deserializeExpansion(wire, "/proj");
    assert.deepEqual(back, state);
  });

  test("workspace mismatch drops the previous workspace's slice", () => {
    const wire = serializeExpansion(
      { expanded: ["/other/x"], filter: "x", showHidden: false },
      "/other",
    );
    const back = deserializeExpansion(wire, "/proj");
    assert.deepEqual(back, { expanded: [], filter: "", showHidden: false });
  });

  test("returns the empty default for null / non-JSON / wrong-version payloads", () => {
    const empty = { expanded: [], filter: "", showHidden: false };
    assert.deepEqual(deserializeExpansion(null, "/p"), empty);
    assert.deepEqual(deserializeExpansion("", "/p"), empty);
    assert.deepEqual(deserializeExpansion("not json", "/p"), empty);
    assert.deepEqual(deserializeExpansion(JSON.stringify({}), "/p"), empty);
    assert.deepEqual(
      deserializeExpansion(JSON.stringify({ version: 999, workspace: "/p" }), "/p"),
      empty,
    );
  });

  test("stamps version + workspace into the wire shape", () => {
    const wire = JSON.parse(
      serializeExpansion({ expanded: [], filter: "", showHidden: false }, "/proj"),
    );
    assert.equal(wire.version, EXPANDED_STATE_VERSION);
    assert.equal(wire.workspace, "/proj");
    assert.deepEqual(wire.expanded, []);
  });

  test("dedupes the expanded array on serialize", () => {
    const wire = JSON.parse(
      serializeExpansion(
        { expanded: ["/a", "/b", "/a", "/b", "/c"], filter: "", showHidden: false },
        "/p",
      ),
    );
    assert.deepEqual(wire.expanded, ["/a", "/b", "/c"]);
  });
});

describe("fileTypeColor", () => {
  test("maps the extensions the ticket lists to non-default buckets", () => {
    assert.notEqual(fileTypeColor("README.md"), fileTypeColor("notes.txt"));
    assert.notEqual(fileTypeColor(".env"), fileTypeColor("notes.txt"));
    assert.notEqual(fileTypeColor("package-lock.json"), fileTypeColor("notes.txt"));
    assert.notEqual(fileTypeColor("tsconfig.json"), fileTypeColor("notes.txt"));
    assert.notEqual(fileTypeColor("settings.yaml"), fileTypeColor("notes.txt"));
    assert.notEqual(fileTypeColor("hero.png"), fileTypeColor("notes.txt"));
    assert.notEqual(fileTypeColor("server.log"), fileTypeColor("notes.txt"));
  });

  test("returns the default bucket for unknown extensions", () => {
    assert.equal(fileTypeColor("a.txt"), fileTypeColor("b.unknownext"));
  });

  test("matches case-insensitively", () => {
    assert.equal(fileTypeColor("README.MD"), fileTypeColor("README.md"));
    assert.equal(fileTypeColor("YAML.YML"), fileTypeColor("yaml.yml"));
  });
});

describe("relativeMtimeBucket", () => {
  const now = 1_700_000_000_000;
  test("returns 'now' for very recent files", () => {
    assert.equal(relativeMtimeBucket(now, now - 5_000), "now");
    assert.equal(relativeMtimeBucket(now, now - 59_000), "now");
  });

  test("buckets to minutes / hours / days / weeks / months / years", () => {
    assert.equal(relativeMtimeBucket(now, now - 3 * 60_000), "minutesAgo:3");
    assert.equal(relativeMtimeBucket(now, now - 2 * 3_600_000), "hoursAgo:2");
    assert.equal(relativeMtimeBucket(now, now - 4 * 86_400_000), "daysAgo:4");
    assert.equal(relativeMtimeBucket(now, now - 2 * 7 * 86_400_000), "weeksAgo:2");
    assert.equal(relativeMtimeBucket(now, now - 3 * 30 * 86_400_000), "monthsAgo:3");
    assert.equal(relativeMtimeBucket(now, now - 2 * 365 * 86_400_000), "yearsAgo:2");
  });

  test("returns empty string for non-finite mtimes", () => {
    assert.equal(relativeMtimeBucket(now, Number.NaN), "");
    assert.equal(relativeMtimeBucket(now, Number.POSITIVE_INFINITY), "");
  });
});

describe("formatSize", () => {
  test("renders small byte counts without a unit prefix noise", () => {
    assert.equal(formatSize(0), "");
    assert.equal(formatSize(-1), "");
  });

  test("switches units at 1024 with one decimal below 10, rounded otherwise", () => {
    assert.equal(formatSize(500), "500B");
    assert.equal(formatSize(1024), "1.0KB");
    assert.equal(formatSize(2500), "2.4KB");
    assert.equal(formatSize(15 * 1024), "15KB");
    assert.equal(formatSize(1024 * 1024), "1.0MB");
    assert.equal(formatSize(50 * 1024 * 1024), "50MB");
  });
});
