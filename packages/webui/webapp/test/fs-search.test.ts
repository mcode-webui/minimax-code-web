// webapp/test/fs-search.test.ts
//
// Unit tests for the bounded workspace-search helpers (slice 19b).
// Pure-JS — no DOM, no fetch — so the suite stays in the
// `node:test` lane and runs as part of `pnpm test:webapp`.
//
// The acceptance contract pinned two invariants the helpers MUST
// honour:
//   1. `pathsToExpand` returns the exact ancestor chain between the
//      search root and the match's parent, so the tree panel can
//      expand-to-hit without guessing.
//   2. `searchFootSegments` surfaces `skipped.huge` even when
//      `truncated` is false — that is the only signal that tells
//      the user "the walk finished but a directory's tail was
//      deliberately not visited".
//
// Both invariants are pinned here so the next refactor cannot
// regress them silently.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ancestorChain,
  pathsToExpand,
  searchFootSegments,
  type FooterSegment,
} from "../lib/fs-search";
import type { FsSearchMatch, FsSearchResult } from "../lib/api";

const MATCH_BASE = (overrides: Partial<FsSearchMatch> = {}): FsSearchMatch => ({
  path: "/r/x.ts",
  name: "x.ts",
  type: "file",
  ancestors: [],
  credential: false,
  ...overrides,
});

const RESULT_BASE = (overrides: Partial<FsSearchResult> = {}): FsSearchResult => ({
  ok: true,
  root: "/r",
  q: "x",
  matches: [],
  scanned: { dirs: 0, files: 0, total: 0 },
  skipped: {
    "node_modules": 0,
    ".git": 0,
    credential: 0,
    huge: 0,
    optional: {},
  },
  truncated: false,
  truncatedReason: null,
  elapsedMs: 0,
  budgets: {
    maxDepth: 8,
    maxNodes: 5000,
    wallMs: 1500,
    maxMatches: 200,
    includeHidden: false,
    includeDirs: [],
  },
  ...overrides,
});

describe("ancestorChain", () => {
  it("returns an empty chain for a top-level match", () => {
    const chain = ancestorChain(MATCH_BASE({ path: "/r/x.ts", ancestors: [] }), "/r");
    assert.deepEqual(chain, []);
  });

  it("walks the segments in order to build the absolute paths", () => {
    const chain = ancestorChain(
      MATCH_BASE({
        path: "/r/src/lib/x.ts",
        ancestors: ["src", "lib"],
      }),
      "/r",
    );
    assert.deepEqual(chain, ["/r/src", "/r/src/lib"]);
  });

  it("returns an empty chain when the root is missing", () => {
    const chain = ancestorChain(
      MATCH_BASE({ ancestors: ["src"] }),
      "",
    );
    assert.deepEqual(chain, []);
  });

  it("normalises a trailing slash on the root", () => {
    const chain = ancestorChain(
      MATCH_BASE({ path: "/r/a/x.ts", ancestors: ["a"] }),
      "/r/",
    );
    assert.deepEqual(chain, ["/r/a"]);
  });
});

describe("pathsToExpand", () => {
  it("dedupes overlapping ancestor chains across matches", () => {
    const matches: FsSearchMatch[] = [
      MATCH_BASE({ path: "/r/src/a/x.ts", ancestors: ["src", "a"] }),
      MATCH_BASE({ path: "/r/src/b/y.ts", ancestors: ["src", "b"] }),
    ];
    const paths = pathsToExpand(matches, "/r");
    assert.deepEqual(paths, ["/r/src", "/r/src/a", "/r/src/b"]);
  });

  it("returns an empty list when no match has ancestors", () => {
    const matches: FsSearchMatch[] = [
      MATCH_BASE({ path: "/r/x.ts", ancestors: [] }),
    ];
    assert.deepEqual(pathsToExpand(matches, "/r"), []);
  });
});

describe("searchFootSegments — basic layout", () => {
  it("always emits scanned + matches segments in that order", () => {
    const result = RESULT_BASE({
      scanned: { dirs: 0, files: 12, total: 12 },
      matches: [MATCH_BASE()],
    });
    const segments = searchFootSegments(result, {
      templates: {
        scanned: "scanned {n}",
        matches: "{n} match",
      },
    });
    assert.ok(segments[0]);
    assert.equal(segments[0].kind, "scanned");
    assert.equal(segments[0].text, "scanned 12");
    assert.ok(segments[1]);
    assert.equal(segments[1].kind, "matches");
    assert.equal(segments[1].text, "1 match");
  });

  it("returns an empty list for a null result", () => {
    assert.deepEqual(searchFootSegments(null), []);
  });
});

describe("searchFootSegments — skipped signals", () => {
  it("surfaces node_modules and .git only when they fired", () => {
    const result = RESULT_BASE({
      skipped: {
        "node_modules": 3,
        ".git": 0,
        credential: 0,
        huge: 0,
        optional: {},
      },
    });
    const segments = searchFootSegments(result, {
      templates: {
        "skipped-node_modules": "skip node_modules {n}",
        "skipped-git": "skip .git {n}",
        "skipped-credential": "skip credentials {n}",
        "skipped-huge": "skip huge-dir tail {n}",
        "skipped-optional": "skip optional {n}",
      },
    });
    const kinds = segments.map((s: FooterSegment) => s.kind);
    assert.ok(kinds.includes("skipped-node_modules"));
    assert.ok(!kinds.includes("skipped-git"));
  });

  it("ALWAYS surfaces skipped.huge even when truncated is false", () => {
    // Acceptance pinned this — the obvious
    // `truncated === false → skipped.huge irrelevant` reading would
    // lie. The UI must say "we did not visit the tail of this
    // directory" so the user is not told "that's everything".
    const result = RESULT_BASE({
      truncated: false,
      truncatedReason: null,
      skipped: {
        "node_modules": 0,
        ".git": 0,
        credential: 0,
        huge: 5000,
        optional: {},
      },
    });
    const segments = searchFootSegments(result, {
      templates: {
        "skipped-huge": "skip huge-dir tail {n}",
      },
    });
    const huge = segments.find((s: FooterSegment) => s.kind === "skipped-huge");
    assert.ok(huge, "skipped-huge must surface even with truncated=false");
    assert.equal(huge!.text, "skip huge-dir tail 5000");
  });

  it("collapses OPTIONAL skip dirs into one segment with the total", () => {
    const result = RESULT_BASE({
      skipped: {
        "node_modules": 0,
        ".git": 0,
        credential: 0,
        huge: 0,
        optional: { dist: 4, build: 7, coverage: 0 },
      },
    });
    const segments = searchFootSegments(result, {
      templates: {
        "skipped-optional": "skip optional {n}",
      },
    });
    const optional = segments.find((s: FooterSegment) => s.kind === "skipped-optional");
    assert.ok(optional);
    assert.equal(optional!.text, "skip optional 11");
  });

  it("surfaces skipped.credential when at least one match flagged", () => {
    const result = RESULT_BASE({
      matches: [MATCH_BASE({ credential: true, credentialReason: "dotenv" })],
      skipped: {
        "node_modules": 0,
        ".git": 0,
        credential: 1,
        huge: 0,
        optional: {},
      },
    });
    const segments = searchFootSegments(result, {
      templates: {
        "skipped-credential": "skip credentials {n}",
      },
    });
    const cred = segments.find((s: FooterSegment) => s.kind === "skipped-credential");
    assert.ok(cred);
    assert.equal(cred!.text, "skip credentials 1");
  });
});

describe("searchFootSegments — truncated", () => {
  it("emits a truncated segment with the budget that fired", () => {
    const result = RESULT_BASE({
      truncated: true,
      truncatedReason: "wallClock",
    });
    const segments = searchFootSegments(result, {
      templates: {
        truncated: "truncated ({budget})",
      },
      budgetLabels: {
        wallClock: "wall-clock",
      },
    });
    const truncated = segments.find((s: FooterSegment) => s.kind === "truncated");
    assert.ok(truncated);
    assert.equal(truncated!.text, "truncated (wall-clock)");
  });

  it("falls back to the raw reason when no label is supplied", () => {
    const result = RESULT_BASE({
      truncated: true,
      truncatedReason: "nodes",
    });
    const segments = searchFootSegments(result, {
      templates: { truncated: "truncated ({budget})" },
    });
    const truncated = segments.find((s: FooterSegment) => s.kind === "truncated");
    assert.equal(truncated!.text, "truncated (nodes)");
  });

  it("omits the truncated segment when truncated is false even if a reason is set", () => {
    const result = RESULT_BASE({
      truncated: false,
      truncatedReason: "depth", // server should not send this combo but stay robust
    });
    const segments = searchFootSegments(result, {
      templates: { truncated: "truncated ({budget})" },
    });
    assert.equal(
      segments.find((s: FooterSegment) => s.kind === "truncated"),
      undefined,
    );
  });
});

describe("searchFootSegments — elapsed", () => {
  it("omits the elapsed segment when formatElapsed is absent", () => {
    const result = RESULT_BASE({ elapsedMs: 12 });
    const segments = searchFootSegments(result, {
      templates: { elapsed: "{n}" },
    });
    assert.equal(
      segments.find((s: FooterSegment) => s.kind === "elapsed"),
      undefined,
    );
  });

  it("renders the elapsed segment with the supplied formatter", () => {
    const result = RESULT_BASE({ elapsedMs: 12 });
    const segments = searchFootSegments(result, {
      templates: { elapsed: "{n}" },
      formatElapsed: (ms) => `${ms}ms`,
    });
    const elapsed = segments.find((s: FooterSegment) => s.kind === "elapsed");
    assert.ok(elapsed);
    assert.equal(elapsed!.text, "12ms");
  });
});
