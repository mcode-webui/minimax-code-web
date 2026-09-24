// webui/test/server/fs-parent-reachability.test.js
//
// `/api/fs/read` reports a parent only when the containment gate would accept
// it, so the panel's "up" control disables at the boundary.
//
// Why. `readDirectory` computed `parent` as a pure path operation, so at the
// outermost reachable directory it still reported one level further up — which
// is outside the allowed roots by definition. The client disables the control
// on `!listing.parent` (panels.tsx `files-up`), so the affordance existed but
// could never work: clicking it could only ever answer 403. That is exactly
// where a user clicks to discover they are already at the top.
//
// The reachability predicate is injected by the route rather than imported here,
// so this module keeps no dependency on the workspace roots.

import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { readDirectory } from "../../server/lib/fs-util.js";

const HOME = resolve(homedir());

test("readDirectory — parent is null at a root the predicate rejects", (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "fs-parent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A predicate that only accepts paths under `dir` — so `dir`'s own parent
  // (the system temp dir) is out of bounds, exactly like `/home` is out of
  // bounds for the real home root.
  const within = (p) => p === dir || p.startsWith(`${dir}/`);

  const inner = resolve(dir, "a", "b");
  t.diagnostic(`fixture: ${inner}`);

  // Nothing to read at `inner` (it does not exist), so assert through the
  // listing of `dir` itself, whose parent is the temp root.
  const withoutPredicate = readDirectory(dir, {});
  assert.equal(typeof withoutPredicate.parent, "string", "sanity: parent exists unfiltered");

  const withPredicate = readDirectory(dir, { reachableParent: within });
  assert.equal(
    withPredicate.parent,
    null,
    "parent outside the allowed roots must be reported as null so the control disables",
  );
});

test("readDirectory — parent is kept when the predicate accepts it", (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "fs-parent-ok-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inner = resolve(dir, "child");
  mkdirSync(inner, { recursive: true });

  // Predicate mirrors the real one: accept everything under `dir`, and `dir`
  // itself. `inner`'s parent is `dir`, so it is accepted.
  const within = (p) => p === dir || p.startsWith(`${dir}/`);
  const listing = readDirectory(inner, { reachableParent: within });
  assert.equal(listing.parent, dir);
});

test("readDirectory — behaviour is unchanged when no predicate is supplied", (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "fs-parent-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const listing = readDirectory(dir, {});
  assert.equal(listing.parent, dirname(dir), "callers that pass no predicate still get a parent");
});

test("readDirectory — the real home root reports no parent", () => {
  // HOME is an allowed root in the default configuration, so its parent is not
  // reachable. This is the exact case that produced the 403.
  const listing = readDirectory(HOME, { reachableParent: (p) => p.startsWith(HOME) });
  assert.equal(listing.parent, null);
  assert.equal(listing.path, HOME);
});
