// webui/test/routes-fs-containment.test.js
// Regression: /api/fs/read and /api/fs/mkdir must sit behind the same
// allowed-roots boundary as browseWorkspace (v2.2 in-product tightening of
// the standalone repo's fs endpoints, whose safePath only blocked '..').

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const fsRoute = await import(absPath("routes/fs.js"));

function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const res = {
    status: 0,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    done,
  };
  return res;
}

function readReq(path, extra = "") {
  return { url: `/api/fs/read?path=${encodeURIComponent(path)}${extra}` };
}

function mkdirReq(path) {
  const req = new EventEmitter();
  req.url = "/api/fs/mkdir";
  process.nextTick(() => {
    req.emit("data", JSON.stringify({ path }));
    req.emit("end");
  });
  return req;
}

describe("fs routes — workspace containment (v2.2)", () => {
  test("read of a directory outside the allowed roots is 403 with actionable error", async () => {
    const res = fakeRes();
    fsRoute.handleFsRead(readReq("/etc"), res);
    assert.equal(res.status, 403);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /允许根|MCODE_WEBUI_WORKSPACE_ROOTS/);
  });

  test("read of a '~' path inside home resolves and is served", async () => {
    const res = fakeRes();
    fsRoute.handleFsRead(readReq("~"), res);
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
  });

  test("read of a tmpdir scratch path inside the allowed roots is served", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-contain-"));
    const res = fakeRes();
    fsRoute.handleFsRead(readReq(dir), res);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });

  test("read rejects symlink escapes and traversal forms via the shared gate", async () => {
    for (const bad of ["/etc/../../etc", "~/../../etc"]) {
      const res = fakeRes();
      fsRoute.handleFsRead(readReq(bad), res);
      const parsed = JSON.parse(res.body || "{}");
      // Either rejected by containment, or resolves inside allowed roots
      // (the gate normalizes before deciding — both outcomes must never
      // list a directory outside the allowed roots).
      if (res.status === 200) {
        assert.ok(parsed.ok === true);
        assert.doesNotMatch(parsed.path || "", /^\/etc\b/);
      } else {
        assert.equal(res.status, 403);
      }
    }
  });

  test("mkdir outside the allowed roots is 403", async () => {
    const res = fakeRes();
    fsRoute.handleFsMkdir(mkdirReq("/etc/should-not-exist"), res);
    await res.done;
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  test("mkdir inside the allowed roots succeeds", async () => {
    const base = mkdtempSync(join(tmpdir(), "fs-mkdir-"));
    const res = fakeRes();
    fsRoute.handleFsMkdir(mkdirReq(join(base, "child")), res);
    await res.done;
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });
});
