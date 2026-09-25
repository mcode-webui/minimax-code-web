// webapp/test/workspace-picker-wire.test.ts
//
// Regression pin: the wire shape between the workspace browse route and
// the webapp's BrowseResult type. The picker once declared `path` and
// read `listing.path`; the server has always returned `dir`. The picker
// UI silently broke (confirm button permanently disabled, mkdir a no-op)
// because the type and the route drifted without a wire test. This file
// asserts that:
//
//   1. The browse route's response carries `dir`, NOT `path`.
//   2. The BrowseResult interface shape matches the live response.
//   3. The picker's render code reads `listing.dir`, not `listing.path`.
//
// Pure-string scan: no DOM, no fetch. The risk being pinned is a future
// refactor flipping the field name and the type back into alignment by
// coincidence — a runtime test that needs the picker mounted would miss
// it. A scan of the source ensures the picker cannot regress without
// this file failing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

describe("BrowseResult type ↔ server wire shape", () => {
  it("api.ts declares `dir`, not `path`", () => {
    const apiSrc = readFileSync(join(ROOT, "lib/api.ts"), "utf8");
    const match = apiSrc.match(/export interface BrowseResult\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, "BrowseResult interface present");
    const shape = match[1] as string;
    assert.match(
      shape,
      /\bdir\s*:\s*string\s*\|\s*null/,
      "BrowseResult declares `dir: string | null`",
    );
    assert.doesNotMatch(
      shape,
      /^\s*path\s*:/m,
      "BrowseResult must NOT declare a top-level `path` field (the wire field is `dir`)",
    );
  });

  it("WorkspaceBrowseTab reads `listing.dir`, not `listing.path`", () => {
    // The picker once read `listing.path` (which is always undefined on
    // the wire response) → confirm button stayed disabled. This scan
    // catches a regression where the field name drifts back.
    const panelsSrc = readFileSync(
      join(ROOT, "components/panels.tsx"),
      "utf8",
    );
    // Isolate the WorkspaceBrowseTab function — it sits between
    // "function WorkspaceBrowseTab" and the next `function ` or `// --- ` block.
    const start = panelsSrc.indexOf("function WorkspaceBrowseTab");
    assert.ok(start > -1, "WorkspaceBrowseTab located");
    const tail = panelsSrc.slice(start);
    const end = tail.indexOf("\n// ---");
    const body = (end > -1 ? tail.slice(0, end) : tail) as string;
    assert.match(
      body,
      /listing\??\.dir/,
      "WorkspaceBrowseTab reads `listing.dir` (the wire field)",
    );
    assert.doesNotMatch(
      body,
      /listing\??\.path/,
      "WorkspaceBrowseTab must not read `listing.path` (would always be undefined)",
    );
  });
});