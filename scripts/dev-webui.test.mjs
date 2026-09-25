// scripts/dev-webui.test.mjs
//
// Unit tests for the dev-watcher's file-scope filter. The filter
// lives in scripts/lib/dev-watch-scope.mjs; importing it directly
// keeps the test dependency-free of the launcher's child_process /
// process.on side effects, so this file can run in any order with
// the other unit tests.
//
// Reproduces the original ticket evidence: an mtime change inside
// `node_modules/@hono/node-server/dist/*.mjs` (a sibling worktree's
// `pnpm install` activity reaches this checkout through the shared
// pnpm-store hardlinks) used to trigger a backend restart, and the
// SIGTERM that followed wedged the watcher. The fix removes every
// non-source path from the watcher's include list, and these tests
// pin the result so a future refactor cannot silently re-introduce
// the wedge.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { shouldWatchFile } from "./lib/dev-watch-scope.mjs";

describe("shouldWatchFile — dev-watcher scope filter", () => {
  test("accepts the entry point and the server/ tree", () => {
    assert.equal(shouldWatchFile("/abs/packages/webui/server.js"), true);
    assert.equal(shouldWatchFile("/abs/packages/webui/server/router.js"), true);
    assert.equal(shouldWatchFile("/abs/packages/webui/server/lib/foo.js"), true);
  });

  test("rejects node_modules paths (the original SIGTERM wedge trigger)", () => {
    assert.equal(
      shouldWatchFile("/abs/packages/webui/node_modules/@hono/node-server/dist/index.js"),
      false,
    );
    assert.equal(
      shouldWatchFile("/abs/node_modules/@hono/node-server/dist/serve.js"),
      false,
    );
    assert.equal(
      shouldWatchFile("/abs/packages/webui/server/node_modules/anything.js"),
      false,
    );
  });

  test("rejects .next, dist, .turbo, webapp, third_party, .git", () => {
    assert.equal(shouldWatchFile("/abs/packages/webui/webapp/.next/server/foo.js"), false);
    assert.equal(shouldWatchFile("/abs/packages/webui/webapp/lib/x.ts"), false);
    assert.equal(shouldWatchFile("/abs/packages/webui/dist/webui/server.js"), false);
    assert.equal(shouldWatchFile("/abs/.turbo/cache.json"), false);
    assert.equal(shouldWatchFile("/abs/third_party/pi-mono/cli.js"), false);
    assert.equal(shouldWatchFile("/abs/.git/HEAD"), false);
  });

  test("rejects editor temp files", () => {
    assert.equal(shouldWatchFile("/abs/foo.swp"), false);
    assert.equal(shouldWatchFile("/abs/foo.tmp"), false);
    assert.equal(shouldWatchFile("/abs/.DS_Store"), false);
  });

  test("normalizes Windows-style backslashes before matching", () => {
    assert.equal(
      shouldWatchFile("C:\\packages\\webui\\node_modules\\@hono\\node-server\\dist\\serve.js"),
      false,
      "backslashes should be treated like forward slashes so a Windows path doesn't escape the filter",
    );
    assert.equal(
      shouldWatchFile("C:\\packages\\webui\\server\\router.js"),
      true,
      "backslash form of a server/ path still matches the include rule",
    );
  });

  test("treats the bare `server.js` as the entry point (no leading path)", () => {
    assert.equal(shouldWatchFile("server.js"), true);
  });

  test("rejects empty / nullish filenames", () => {
    assert.equal(shouldWatchFile(""), false);
    assert.equal(shouldWatchFile(null), false);
    assert.equal(shouldWatchFile(undefined), false);
  });
});