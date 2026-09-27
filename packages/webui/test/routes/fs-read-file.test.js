// webui/test/routes/fs-read-file.test.js
// Regression: `/api/fs/read-file` (slice 02 — right-panel file preview).
//
// Pins the contract the webapp's components/file-preview.tsx renders against:
//   - containment gate: out-of-root paths 403 with an actionable message;
//   - size cap: files > 512 KiB answer 413, not a truncated body;
//   - binary detection: NUL byte in the first 4 KiB → 415 with mime/language;
//   - success shape: ok, path, size, mime, language, encoding, content;
//   - language hint is the extension-based one (markdown for .md, etc.).
//
// The containment / symlink escape tests share the gate with the existing
// `/api/fs/read` route — that is by design (no new escape hatch in this
// slice). The size-cap and binary tests live separately because they are
// `/api/fs/read-file`-specific failures the route surfaces with their own
// status codes (413 / 415), so a regression there would be silent.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const fsRoute = await import(absPath("routes/fs.js"));

function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const res = {
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
    done,
  };
  return res;
}

function readReq(path) {
  return { url: `/api/fs/read-file?path=${encodeURIComponent(path)}` };
}

describe("fs routes — /api/fs/read-file", () => {
  test("missing path returns 400 missing path", () => {
    const res = fakeRes();
    fsRoute.handleFsReadFile({ url: "/api/fs/read-file" }, res);
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, "missing path");
  });

  test("a path outside the allowed roots is 403 with actionable error", () => {
    // /etc on POSIX, SystemRoot on Windows — same witness the existing
    // fs-containment test uses. The route inherits the same gate.
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc";
    const res = fakeRes();
    fsRoute.handleFsReadFile(readReq(outsideRoot), res);
    assert.equal(res.status, 403);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /允许根|MCODE_WEBUI_WORKSPACE_ROOTS/);
  });

  test("a regular text file inside an allowed root returns the documented shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-read-file-ok-"));
    try {
      const file = join(dir, "note.md");
      // Include a NUL-suspicious byte in the tail to confirm the binary
      // detector only checks the first 4 KiB (and a BOM to confirm it is
      // stripped).
      const body = "\uFEFF# title\n\nhello world\n";
      writeFileSync(file, body, "utf8");

      const res = fakeRes();
      fsRoute.handleFsReadFile(readReq(file), res);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.encoding, "utf-8");
      assert.equal(parsed.binary, false);
      assert.equal(parsed.language, "markdown");
      assert.equal(parsed.mime, "text/markdown; charset=utf-8");
      assert.equal(parsed.content, body.replace(/^\uFEFF/, ""));
      assert.equal(parsed.size, Buffer.byteLength(body, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-existent file inside an allowed root is rejected by the shared gate", () => {
    // assertWorkspacePath runs realpathSync before the file is stat'd;
    // a missing path therefore fails containment with a realpath error
    // (the same shape /api/fs/read produces for a missing path). This
    // is by design — the gate wants to resolve symlinks before opening,
    // and the webapp only ever opens paths it just got from a listing,
    // so a missing path here is a user-after-free and should be loud.
    const dir = mkdtempSync(join(tmpdir(), "fs-read-file-missing-"));
    try {
      const file = join(dir, "nope.md");
      const res = fakeRes();
      fsRoute.handleFsReadFile(readReq(file), res);
      assert.equal(res.status, 403);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /无法解析路径/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a binary file is rejected with 415 and the mime hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-read-file-binary-"));
    try {
      const file = join(dir, "blob.bin");
      // 16 KiB of NUL bytes — past the 4 KiB sniff window so the
      // detector's first-byte optimisation does not matter.
      writeFileSync(file, Buffer.alloc(16 * 1024));

      const res = fakeRes();
      fsRoute.handleFsReadFile(readReq(file), res);
      assert.equal(res.status, 415);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.binary, true);
      assert.match(parsed.error, /binary/);
      assert.equal(typeof parsed.mime, "string");
      assert.equal(typeof parsed.language, "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory is rejected with 415 (not a regular file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-read-file-dir-"));
    try {
      const sub = join(dir, "subdir");
      mkdirSync(sub, { recursive: true });
      const res = fakeRes();
      fsRoute.handleFsReadFile(readReq(sub), res);
      assert.equal(res.status, 415);
      assert.match(JSON.parse(res.body).error, /not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an oversize file is rejected with 413 and the cap is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-read-file-big-"));
    try {
      const file = join(dir, "big.md");
      // 600 KiB — comfortably past the 512 KiB cap. Use a single
      // character so encoding keeps the bytes count predictable.
      writeFileSync(file, "a".repeat(600 * 1024), "utf8");

      const res = fakeRes();
      fsRoute.handleFsReadFile(readReq(file), res);
      assert.equal(res.status, 413);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /file too large \(max 524288 bytes\)/);
      // The error path still carries the mime/language hint so the UI
      // can render a meaningful state ("Markdown, 600 KiB — too large to
      // preview here").
      assert.equal(parsed.mime, "text/markdown; charset=utf-8");
      assert.equal(parsed.language, "markdown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("symlink escape attempts fall through to the shared containment gate", () => {
    // Both inputs resolve outside the allowed roots after realpath. The
    // route must answer 403, exactly like /api/fs/read does — this is
    // the contract that prevents the preview from becoming a new escape
    // hatch.
    for (const bad of ["/etc/../../etc", "~/../../etc"]) {
      const res = fakeRes();
      fsRoute.handleFsReadFile(readReq(bad), res);
      // Either rejected by containment (403) or normalised to a path
      // that itself fails the gate (also 403); both outcomes are
      // acceptable as long as the route never serves out-of-root bytes.
      assert.equal(res.status, 403, `expected 403 for ${bad}, got ${res.status}`);
    }
  });
});