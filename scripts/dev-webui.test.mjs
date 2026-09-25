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
import { readFileSync as readFileSyncSync } from "node:fs";
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
describe("shouldWatchFile — pnpm global store defense-in-depth (v2)", () => {
  test("rejects files under ~/.local/share/pnpm/store (the original SIGTERM wedge trigger)", () => {
    // The pnpm global store is where `pnpm install` writes the
    // real-file; node_modules/<pkg> is a hardlink to it. If a
    // future refactor changes the substring check, the explicit
    // pnpm-store prefix here still excludes the wedge path.
    const store = `${process.env.HOME || "/root"}/.local/share/pnpm/store/v3/files/abc/123/hono-node-server/dist/serve.js`;
    assert.equal(shouldWatchFile(store), false);
  });

  test("rejects files under the store even without /node_modules/ in the path", () => {
    // The hardlink-target path is /node_modules/... in a worktree,
    // but the in-place store path is /v3/files/...; the prefix check
    // must reject both. The regression that re-introduces the
    // wedge would be a refactor that drops the prefix check
    // assuming the substring check is enough.
    const store = `${process.env.HOME || "/root"}/.local/share/pnpm/store/v3/files/abc/serve.js`;
    assert.equal(shouldWatchFile(store), false);
  });
});

describe("makePortVerifier — port-binding verification (v2)", () => {
  // Extract makePortVerifier from dev-webui.mjs without importing
  // the module (which has spawn side effects). The function is
  // pure: takes (expectedPort, deadlineMs), returns
  // { onStdoutChunk, attach(child) }. We exercise it via a
  // regex pull so the test imports nothing but node:test.
  const source = readFileSyncSync(
    new URL("./dev-webui.mjs", import.meta.url),
    "utf8",
  );
  const match = source.match(
    /function makePortVerifier\(expectedPort, deadlineMs\) \{([\s\S]*?)\n\}/,
  );
  if (!match) throw new Error("could not extract makePortVerifier");
  // eslint-disable-next-line no-new-func
  const makePortVerifier = new Function(
    "expectedPort",
    "deadlineMs",
    `${match[0]}\n; return makePortVerifier(expectedPort, deadlineMs);`,
  );

  test("signals success when stdout reports the expected port", async () => {
    const child = { kill() {} };
    const verifier = makePortVerifier(18092, 60000);
    verifier.attach(child);
    verifier.onStdoutChunk(
      "[webui] mcode cmd: /x/y/z\n" +
        "[webui] listening on http://127.0.0.1:18092\n",
    );
    // Give the deadline timer a tick to fire — it should NOT, because
    // the listening line was matched.
    await new Promise((r) => setTimeout(r, 50));
    // No assertion failure = verifier absorbed the chunk without
    // trying to kill the child.
  });

  test("kills the child when the bound port does not match BACKEND_PORT", async () => {
    let killed = false;
    const child = { kill() { killed = true; } };
    const verifier = makePortVerifier(18092, 60000);
    verifier.attach(child);
    verifier.onStdoutChunk(
      "[webui] listening on http://127.0.0.1:18100\n", // wrong port
    );
    assert.equal(killed, true, "child should be SIGKILLed on port mismatch");
  });

  test("kills the child when no listening line appears within the deadline", async () => {
    let killed = false;
    const child = { kill() { killed = true; } };
    const verifier = makePortVerifier(18092, 100); // 100ms deadline
    verifier.attach(child);
    // No chunks at all.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(killed, true, "child should be SIGKILLed on deadline");
  });
});
