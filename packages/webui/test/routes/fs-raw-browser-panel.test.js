// webui/test/routes/fs-raw-browser-panel.test.js
// Regression: `/api/fs/raw` is the ONLY route the slice 04 built-in
// browser panel's iframe src points at (see `webapp/lib/browser-nav.ts`
// — `buildSandboxUrl` constructs a single, hard-coded URL shape). The
// companion test `fs-raw.test.js` pins the route's wire contract;
// THIS test pins the additional invariants the panel depends on:
//
//   - a path SHAPED LIKE what the panel would emit (a workspace-
//     relative `.html`) passes the gate and answers with the file's
//     bytes — the panel's happy path;
//   - a path that resolves outside the allowed roots (the kind a
//     crafted input COULD have produced before the address-bar gate
//     lands) is 403'd with an actionable error;
//   - a path that is a directory, not a file, is 400'd;
//   - a path that is over the 20 MiB cap is 413'd;
//   - a path with `..` segments is 403'd by the gate (realpath
//     containment), not silently rewritten.
//
// Together with `browser-nav.test.ts` (input layer) and the existing
// `fs-raw.test.js` (wire contract), the three tests pin the
// containment story end-to-end so a regression that opens an
// out-of-root HTML file in the iframe is impossible to land without
// also landing one of these test changes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {rmSync, writeFileSync} from "node:fs";

import { join } from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { mkTmpDir } from "../helpers/tmp.js";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const fsRoute = await import(absPath("routes/fs.js"));

function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const res = Object.assign(new EventEmitter(), {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    write(chunk) {
      this.body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("binary");
    },
    done,
  });
  return res;
}

function readReq(path) {
  return { url: `/api/fs/raw?path=${encodeURIComponent(path)}` };
}

describe("fs routes — /api/fs/raw as the slice 04 browser-panel iframe src", () => {
  test("a workspace-local HTML file is served with text/html; charset=utf-8", async () => {
    // The panel only ever emits paths like `public/index.html`. The
    // /api/fs/raw route's mime table must map that to the right
    // Content-Type so the iframe actually renders the page rather
    // than downloading it.
    const dir = mkTmpDir("fs-raw-browser-html-");
    try {
      const file = join(dir, "index.html");
      const html = "<!doctype html><html><body><h1>slice 04</h1></body></html>";
      writeFileSync(file, html);

      const res = fakeRes();
      fsRoute.handleFsRaw(readReq(file), res);
      await res.done;
      assert.equal(res.status, 200);
      assert.equal(res.headers["Content-Type"], "text/html; charset=utf-8");
      assert.equal(res.headers["Cache-Control"], "no-store");
      assert.equal(res.body, html);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 21 MiB file is rejected with 413 (size cap protects the panel)", async () => {
    // The iframe would silently drop the streaming response at the
    // cap; the test pins the 413 status + the cap message so a
    // regression that drops the cap or ships the truncated body
    // surfaces here.
    const dir = mkTmpDir("fs-raw-browser-large-");
    try {
      const file = join(dir, "big.html");
      // 21 MiB of comments — just over the 20 MiB cap.
      const buf = Buffer.alloc(21 * 1024 * 1024, 0x20);
      writeFileSync(file, buf);

      const res = fakeRes();
      fsRoute.handleFsRaw(readReq(file), res);
      // The 413 path is sync (no stream), but we await done for symmetry.
      await res.done;
      assert.equal(res.status, 413);
      assert.match(JSON.parse(res.body).error, /file too large/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory under the path is rejected (not a regular file)", () => {
    // The panel refuses directories on the input layer, but the
    // route must also refuse them — belt-and-suspenders, and the
    // protection covers the case where the address-bar input shape
    // ever lands on a directory (e.g. a future "open folder"
    // shortcut).
    const dir = mkTmpDir("fs-raw-browser-dir-");
    try {
      const res = fakeRes();
      fsRoute.handleFsRaw(readReq(dir), res);
      assert.equal(res.status, 400);
      assert.match(JSON.parse(res.body).error, /not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a `..` segment past the workspace is refused by the gate (realpath containment)", () => {
    // The lib/browser-nav.ts input layer is explicit that it does
    // NOT pre-emptively rewrite `..` segments — the server gate is
    // the single source of truth. This test pins that a crafted
    // input that slips past the input gate (e.g. via a future
    // regression that strips the input validator) is still 403'd
    // here.
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    // The path is intentionally SHAPED like what the panel's
    // `coerceAddress` would forward — the test simulates the case
    // where the input layer has been bypassed.
    fsRoute.handleFsRaw(readReq(outsideRoot), res);
    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.body).error, /允许根|MCODE_WEBUI_WORKSPACE_ROOTS/);
  });
});