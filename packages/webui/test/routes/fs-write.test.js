// webui/test/routes/fs-write.test.js
// Regression: `POST /api/fs/write` (slice 27 — preview edit path).
//
// Pins the contract the webapp's preview toolbar saves through:
//   - containment: out-of-root paths 403 via the SAME shared gate
//     (`assertWorkspacePath` through `safePath`) the read routes use —
//     the write path must not be a new escape hatch;
//   - credential guard: `.env` / `*.pem` / `id_rsa` … default-refuse
//     (403 `code:'credential'`), released only by `confirm:true` with
//     an audit line on stderr — identical posture to slice 16 reads;
//   - conflict detection: a body carrying `expectedMtime`/`expectedSize`
//     that no longer matches the disk is 409 `code:'conflict'` and the
//     file on disk is LEFT UNTOUCHED — never a silent overwrite;
//   - controlled write: the endpoint writes the body's `content` with
//     `writeFileSync` — no shell, no command interpolation anywhere;
//   - caps: >512 KiB bodies are 413; missing files 404; directories 400.
//
// The mtime/size baseline travels on the plain read too — see the
// companion assertion in fs-read-file.test.js.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function writeReq(body) {
  // A minimal IncomingMessage stand-in: the handler only reads the JSON
  // body through the shared reader, which iterates `req` as an async
  // iterable.
  const chunks = [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    url: "/api/fs/write",
    headers: { "content-type": "application/json" },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
      };
    },
  };
}

/** Make a temp dir that is inside an allowed root (tmpdir is allowed). */
function tempWorkspace(prefix = "fs-write-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Coarse mtime bump that survives filesystem timestamp resolution. */
function bumpMtime(file) {
  const st = statSync(file);
  const later = new Date(st.mtimeMs + 2500);
  utimesSync(file, later, later);
  return statSync(file).mtimeMs;
}

describe("fs routes — POST /api/fs/write", () => {
  test("missing path returns 400 with a structured code", async () => {
    const res = fakeRes();
    await fsRoute.handleFsWrite(writeReq({ content: "x" }), res);
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).code, "missing-path");
  });

  test("missing content returns 400 with a structured code", async () => {
    const dir = tempWorkspace();
    try {
      const res = fakeRes();
      await fsRoute.handleFsWrite(writeReq({ path: join(dir, "a.txt") }), res);
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.body).code, "missing-content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-string content returns 400 with a structured code", async () => {
    const dir = tempWorkspace();
    try {
      const res = fakeRes();
      await fsRoute.handleFsWrite(writeReq({ path: join(dir, "a.txt"), content: 42 }), res);
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.body).code, "invalid-content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path outside the allowed roots is 403 with the shared gate's message", async () => {
    const outsideRoot = process.platform === "win32"
      ? process.env.SystemRoot || "C:\\Windows"
      : "/etc/passwd";
    const res = fakeRes();
    await fsRoute.handleFsWrite(writeReq({ path: outsideRoot, content: "x" }), res);
    assert.equal(res.status, 403);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /允许根|MCODE_WEBUI_WORKSPACE_ROOTS/);
  });

  test("a symlink that resolves outside the allowed roots is 403 (same gate)", async () => {
    const dir = tempWorkspace("fs-write-symlink-");
    try {
      const link = join(dir, "escape.txt");
      writeFileSync(link + ".real", "x"); // placeholder, replaced below
      rmSync(link + ".real");
      const { symlinkSync } = await import("node:fs");
      symlinkSync("/etc/hostname", link);
      const res = fakeRes();
      await fsRoute.handleFsWrite(writeReq({ path: link, content: "x" }), res);
      assert.equal(res.status, 403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a plain text file is written byte-for-byte and the answer carries the new baseline", async () => {
    const dir = tempWorkspace();
    try {
      const file = join(dir, "note.md");
      writeFileSync(file, "# old\n", "utf8");
      const res = fakeRes();
      await fsRoute.handleFsWrite(writeReq({ path: file, content: "# new heading\n" }), res);
      assert.equal(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.path, file);
      assert.equal(readFileSync(file, "utf8"), "# new heading\n");
      assert.equal(parsed.size, Buffer.byteLength("# new heading\n", "utf8"));
      assert.equal(typeof parsed.mtime, "number");
      // The returned baseline must match the file we just wrote.
      assert.equal(parsed.mtime, statSync(file).mtimeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("credential-shaped files default-refuse with the slice-16 reason vocabulary", async () => {
    const dir = tempWorkspace();
    try {
      for (const name of [".env", "server.pem", "id_rsa"]) {
        const file = join(dir, name);
        writeFileSync(file, "synthetic-fixture-value", "utf8");
        const res = fakeRes();
        await fsRoute.handleFsWrite(writeReq({ path: file, content: "changed" }), res);
        assert.equal(res.status, 403, `${name} must default-refuse`);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.code, "credential");
        assert.ok(parsed.credentialReason, `${name} must carry a credentialReason`);
        // Default-refuse means the file is NOT modified.
        assert.equal(readFileSync(file, "utf8"), "synthetic-fixture-value");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("confirm:true releases a credential write and emits an audit line", async () => {
    const dir = tempWorkspace();
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "SYNTHETIC_TOKEN=synthetic\n", "utf8");
      // Capture stderr for the audit assertion.
      const originalWrite = process.stderr.write;
      let stderr = "";
      process.stderr.write = (chunk) => {
        stderr += String(chunk);
        return true;
      };
      const res = fakeRes();
      try {
        await fsRoute.handleFsWrite(writeReq({ path: file, content: "SYNTHETIC_TOKEN=rotated\n", confirm: true }), res);
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.equal(res.status, 200);
      assert.equal(readFileSync(file, "utf8"), "SYNTHETIC_TOKEN=rotated\n");
      const audit = stderr.split("\n").filter((l) => l.includes("credential.override"));
      assert.equal(audit.length, 1);
      const entry = JSON.parse(audit[0]);
      assert.equal(entry.endpoint, "write");
      assert.equal(entry.reason, "dotenv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale expectedMtime is 409 conflict and the disk file is untouched", async () => {
    const dir = tempWorkspace();
    try {
      const file = join(dir, "doc.md");
      writeFileSync(file, "v1\n", "utf8");
      const baseline = statSync(file);
      // External editor writes v2 while the panel holds the v1 baseline.
      writeFileSync(file, "v2 (external edit)\n", "utf8");
      bumpMtime(file);

      const res = fakeRes();
      await fsRoute.handleFsWrite(
        writeReq({
          path: file,
          content: "v1 (panel edit)\n",
          expectedMtime: baseline.mtimeMs,
          expectedSize: baseline.size,
        }),
        res,
      );
      assert.equal(res.status, 409);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, "conflict");
      assert.equal(typeof parsed.diskMtime, "number");
      assert.equal(typeof parsed.diskSize, "number");
      // The whole point: the external edit survives.
      assert.equal(readFileSync(file, "utf8"), "v2 (external edit)\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale expectedSize alone (mtime unchanged) is still 409", async () => {
    const dir = tempWorkspace();
    try {
      const file = join(dir, "doc.md");
      writeFileSync(file, "long enough v1\n", "utf8");
      const baseline = statSync(file);
      writeFileSync(file, "v2 shorter\n", "utf8");
      const res = fakeRes();
      await fsRoute.handleFsWrite(
        writeReq({
          path: file,
          content: "panel edit\n",
          expectedMtime: baseline.mtimeMs, // deliberately stale-but-equal is impossible here
          expectedSize: baseline.size,
        }),
        res,
      );
      assert.equal(res.status, 409);
      assert.equal(readFileSync(file, "utf8"), "v2 shorter\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh baseline writes through (no false conflict)", async () => {
    const dir = tempWorkspace();
    try {
      const file = join(dir, "doc.md");
      writeFileSync(file, "v1\n", "utf8");
      const baseline = statSync(file);
      const res = fakeRes();
      await fsRoute.handleFsWrite(
        writeReq({
          path: file,
          content: "panel edit\n",
          expectedMtime: baseline.mtimeMs,
          expectedSize: baseline.size,
        }),
        res,
      );
      assert.equal(res.status, 200);
      assert.equal(readFileSync(file, "utf8"), "panel edit\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("omitting the baseline writes without a conflict check (explicit overwrite)", async () => {
    // After the panel surfaces the conflict, the user may choose to
    // overwrite; that decision is modelled by re-saving WITHOUT the
    // baseline rather than by a `force` flag the server re-checks.
    const dir = tempWorkspace();
    try {
      const file = join(dir, "doc.md");
      writeFileSync(file, "v1\n", "utf8");
      writeFileSync(file, "v2 (external)\n", "utf8");
      const res = fakeRes();
      await fsRoute.handleFsWrite(writeReq({ path: file, content: "v3 (panel wins)\n" }), res);
      assert.equal(res.status, 200);
      assert.equal(readFileSync(file, "utf8"), "v3 (panel wins)\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writing a non-existent file is caught by the shared gate (same as read)", async () => {
    // The shared gate runs realpathSync before anything else, so a
    // missing path fails CONTAINMENT (403 无法解析路径) — exactly the
    // contract /api/fs/read-file documents ("a user-after-free should
    // be loud"). The handler's 404 branch is TOCTOU defense (gate
    // passed, file vanished before stat) and is not reachable through
    // the normal request path by design.
    const dir = tempWorkspace();
    try {
      const res = fakeRes();
      await fsRoute.handleFsWrite(writeReq({ path: join(dir, "ghost.md"), content: "x" }), res);
      assert.equal(res.status, 403);
      assert.match(JSON.parse(res.body).error, /无法解析路径/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writing a directory is 400 not-a-regular-file", async () => {
    const dir = tempWorkspace();
    try {
      const sub = join(dir, "subdir");
      mkdirSync(sub);
      const res = fakeRes();
      await fsRoute.handleFsWrite(writeReq({ path: sub, content: "x" }), res);
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.body).code, "not-a-regular-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a body over the write cap is 413 and the file is untouched", async () => {
    const dir = tempWorkspace();
    try {
      const file = join(dir, "big.md");
      writeFileSync(file, "small\n", "utf8");
      const res = fakeRes();
      await fsRoute.handleFsWrite(writeReq({ path: file, content: "a".repeat(600 * 1024) }), res);
      assert.equal(res.status, 413);
      assert.equal(JSON.parse(res.body).code, "too-large");
      assert.equal(readFileSync(file, "utf8"), "small\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
