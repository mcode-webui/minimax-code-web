// webapp/test/fs-tree-reveal.test.tsx
//
// Slice 19b follow-up — cross-surface reveal channel between the
// sidebar 搜索 surface and the file-tree panel. The hook is a
// simple pub/sub, but it pins the contract the sidebar click
// relies on (the panel may not be mounted when the click fires;
// we order the request + surface switch so the subscriber
// receives the request BEFORE the surface swap mounts the
// panel — if no subscriber is mounted the request is dropped,
// which is the documented fallback).
//
// The tests run in node:test via the React package already loaded
// for the webapp suite (no jsdom — the hook returns plain
// functions, not DOM nodes).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FsSearchMatch } from "../lib/api";

// We re-import the helper shapes without pulling in the React
// tree (the helper itself is pure pub/sub); a smoke test through
// the React context is left to the existing render-driven
// test suite — `panels-search.test.ts` style coverage is what
// catches the consumer side, and the live evidence in
// /tmp/dev-search/*.png is what catches the integration.

const MATCH_BASE = (overrides: Partial<FsSearchMatch> = {}): FsSearchMatch => ({
  path: "/r/x.ts",
  name: "x.ts",
  type: "file",
  ancestors: [],
  credential: false,
  ...overrides,
});

describe("pathsToExpand (reused by the reveal channel)", () => {
  it("returns an empty array when no match has ancestors", async () => {
    const { pathsToExpand } = await import("../lib/fs-search");
    const out = pathsToExpand([MATCH_BASE({ path: "/r/x.ts", ancestors: [] })], "/r");
    assert.deepEqual(out, []);
  });

  it("walks the ancestor chain in root -> leaf order", async () => {
    const { pathsToExpand } = await import("../lib/fs-search");
    const out = pathsToExpand(
      [MATCH_BASE({ path: "/r/src/lib/x.ts", ancestors: ["src", "lib"] })],
      "/r",
    );
    assert.deepEqual(out, ["/r/src", "/r/src/lib"]);
  });
});

describe("fs-search foot segments — credential signal survives loaded transition", () => {
  it("surfaces skipped.credential when any match flagged", async () => {
    const { searchFootSegments } = await import("../lib/fs-search");
    const segments = searchFootSegments(
      {
        ok: true,
        root: "/r",
        q: "x",
        matches: [MATCH_BASE({ credential: true, credentialReason: "dotenv" })],
        scanned: { dirs: 0, files: 1, total: 1 },
        skipped: {
          "node_modules": 0,
          ".git": 0,
          credential: 1,
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
      },
      {
        templates: { "skipped-credential": "skip credentials {n}" },
      },
    );
    const cred = segments.find((s) => s.kind === "skipped-credential");
    assert.ok(cred);
    assert.equal(cred!.text, "skip credentials 1");
  });
});

describe("fs-tree-reveal contract", () => {
  it("exposes a requestReveal function from useFsTreeReveal", async () => {
    // We can't easily mount a provider in this pure node test
    // (no React renderer), so the test simply asserts that the
    // module's surface is importable and the hook is exported.
    // Render-driven behaviour is pinned in the live evidence
    // (sidebar 搜索 → click → tree auto-expands, see
    // /tmp/dev-search/*.png after this slice's commit).
    const mod = await import("../lib/fs-tree-reveal");
    assert.equal(typeof mod.useFsTreeReveal, "function");
    assert.equal(typeof mod.useFsTreeRevealSubscriber, "function");
    assert.equal(typeof mod.FsTreeRevealProvider, "function");
  });
});
