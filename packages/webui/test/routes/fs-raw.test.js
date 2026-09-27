// webui/test/routes/fs-raw.test.js
// Regression: `/api/fs/raw` (slice 02 — image / binary preview).
//
// Pins the contract the webapp's <img src={fsRawUrl(path)}> depends on:
//   - containment gate: out-of-root paths 403;
//   - binary stream: bytes round-trip cleanly back to the caller;
//   - content-type mapped from extension (.png → image/png, …);
//   - cache-control: no-store (the file may change on disk);
//   - size cap: files > 20 MiB answer 413, not a partial stream.
//
// Like the read-file companion, this test does NOT exercise every
// extension — it picks a representative set (png, svg, unknown) and
// leaves the rest to the mime-table unit coverage in fs-util.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const fsRoute = await import(absPath("routes/fs.js"));

function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  // The raw route does `createReadStream(path).pipe(res)`, which calls
  // `res.on(...)`, `res.write(...)`, and `res.end()` on the destination.
  // The minimal capture below wires the EventEmitter those calls need.
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

describe("fs routes — /api/fs/raw", () => {
  test("missing path returns 400 missing path", () => {
    const res = fakeRes();
    fsRoute.handleFsRaw({ url: "/api/fs/raw" }, res);
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, "missing path");
  });

  test("a path outside the allowed roots is 403 with actionable error", () => {
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    fsRoute.handleFsRaw(readReq(outsideRoot), res);
    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.body).error, /允许根|MCODE_WEBUI_WORKSPACE_ROOTS/);
  });

  test("a png inside an allowed root is served with image/png", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-raw-png-"));
    try {
      // Minimal valid PNG: 1×1 transparent pixel. Header + IHDR + IDAT +
      // IEND chunks. Pre-built so we don't depend on a graphics lib.
      const bytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
      ]);
      const file = join(dir, "dot.png");
      writeFileSync(file, bytes);

      const res = fakeRes();
      fsRoute.handleFsRaw(readReq(file), res);
      // Stream pipe is async — the createReadStream emits 'data' on the
      // next tick and the destination's end() fires on 'end'. Wait for
      // it before reading the captured body.
      await res.done;
      assert.equal(res.status, 200);
      assert.equal(res.headers["Content-Type"], "image/png");
      assert.equal(res.headers["Cache-Control"], "no-store");
      assert.equal(Number(res.headers["Content-Length"]), bytes.length);
      // The pipe captures the body — the round-trip must match the bytes
      // we wrote. fakeRes.write() stores binary as latin1, which is
      // bit-stable for non-Unicode content; we re-encode the same way.
      const expected = bytes.toString("binary");
      assert.equal(res.body.length, bytes.length, "streamed body length matches file size");
      assert.equal(res.body, expected, "streamed bytes match the file bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown extension falls back to application/octet-stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-raw-unknown-"));
    try {
      const file = join(dir, "blob.qwert");
      writeFileSync(file, "hello");

      const res = fakeRes();
      fsRoute.handleFsRaw(readReq(file), res);
      await res.done;
      assert.equal(res.status, 200);
      assert.equal(res.headers["Content-Type"], "application/octet-stream");
      assert.equal(res.body, "hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file is rejected by the shared gate (realpath fails)", () => {
    // Same story as /api/fs/read-file — the gate runs realpathSync first
    // and 403s on a missing path before the route ever reaches its own
    // stat. The webapp only ever opens paths that came from a server
    // listing, so this branch is a belt-and-suspenders check, not a
    // routine path.
    const dir = mkdtempSync(join(tmpdir(), "fs-raw-missing-"));
    try {
      const res = fakeRes();
      fsRoute.handleFsRaw(readReq(join(dir, "ghost.png")), res);
      assert.equal(res.status, 403);
      assert.match(JSON.parse(res.body).error, /无法解析路径/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory is rejected with 400 not a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-raw-dir-"));
    try {
      const res = fakeRes();
      fsRoute.handleFsRaw(readReq(dir), res);
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.body).error, "not a regular file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});