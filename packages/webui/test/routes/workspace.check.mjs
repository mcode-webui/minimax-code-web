// webui/test/routes/workspace.check.mjs
// Unit tests for server/routes/workspace.js — handleWorkspace + handleWorkspaceBrowse.
//
// Why this test exists: routes/workspace.js is a thin HTTP wrapper over
// lib/workspace.js. It just unpacks req.body, calls the lib, and translates
// the {ok, error} return into an HTTP status code. The translation rule
// matters: 400 only when error includes "不存在".
//
// Test strategy: USE setupMocks to mock lib/acp-client.js. Without this mock,
// pushStateFor (called inside handleWorkspace → handleWorkspaceChange) would
// trigger a real mcode acp client spawn on cache miss, hanging the test.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupMocks, absPath } from "../helpers/_setup.js";

let wsRoute;
before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
    },
  });
  wsRoute = await import(absPath("routes/workspace.js"));
});

function fakeReq(body, withHost = true) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  if (withHost) stream.headers = { host: "localhost" };
  return stream;
}
function fakeRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
  return res;
}
function fakeCs(workspaceDir = null) {
  return {
    workspace: { dir: workspaceDir, branch: null, tree: null },
  };
}

describe("handleWorkspace — /api/workspace POST", () => {
  test("returns 200 on successful set", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-rws-test-"));
    try {
      const cs = fakeCs("/old");
      const res = fakeRes();
      await wsRoute.handleWorkspace(
        fakeReq({ action: "set", dir: tmp }),
        res,
        { cs, cid: "cid-1" },
      );
      assert.equal(res._status, 200);
      const body = JSON.parse(res._body);
      assert.equal(body.ok, true);
      assert.equal(cs.workspace.dir, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 400 when target dir does not exist (error contains '不存在')", async () => {
    const cs = fakeCs();
    const res = fakeRes();
    await wsRoute.handleWorkspace(
      fakeReq({ action: "set", dir: "C:\\nonexistent\\xyz\\abc" }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
  });

  test("returns 200 on 'detect' action (detectOnly mode)", async () => {
    const cs = fakeCs("/my-current");
    const res = fakeRes();
    await wsRoute.handleWorkspace(
      fakeReq({ action: "detect" }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.detectOnly, true);
  });

  test("returns 200 with ok:false when dir is missing for 'set' action", async () => {
    // Note: routes/workspace.js only returns 400 when error includes "不存在".
    // For "dir 不能为空" error, the response is 200 with ok:false in the body.
    const cs = fakeCs();
    const res = fakeRes();
    await wsRoute.handleWorkspace(
      fakeReq({ action: "set" }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /不能为空/);
  });
});

describe("handleWorkspaceBrowse — /api/workspace/browse GET", () => {
  test("returns 200 + children list for existing dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-browse-"));
    try {
      mkdirSync(join(tmp, "sub1"));
      mkdirSync(join(tmp, "sub2"));
      writeFileSync(join(tmp, "f.txt"), "x");
      const req = Readable.from([Buffer.from("")]);
      req.url = `/api/workspace/browse?path=${encodeURIComponent(tmp)}`;
      req.headers = { host: "localhost" };
      const res = fakeRes();
      wsRoute.handleWorkspaceBrowse(req, res, {});
      assert.equal(res._status, 200);
      const body = JSON.parse(res._body);
      assert.equal(body.ok, true);
      assert.equal(body.children.length, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 400 for non-existent path", () => {
    const req = Readable.from([Buffer.from("")]);
    req.url = "/api/workspace/browse?path=" + encodeURIComponent("C:\\nonexistent\\xyz");
    req.headers = { host: "localhost" };
    const res = fakeRes();
    wsRoute.handleWorkspaceBrowse(req, res, {});
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
  });

  test("returns 200 with roots on Windows when no path given", { skip: process.platform !== "win32" }, () => {
    const req = Readable.from([Buffer.from("")]);
    req.url = "/api/workspace/browse";
    req.headers = { host: "localhost" };
    const res = fakeRes();
    wsRoute.handleWorkspaceBrowse(req, res, {});
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.roots));
  });

  test("browse wire shape — `dir`, `parent`, `children` (no `path`)", () => {
    // Regression pin: the picker UI reads `listing.dir` for confirm / mkdir,
    // and the webapp's BrowseResult type declares `dir`. The server has
    // always returned `dir`, but the picker once read `listing.path` and the
    // type used to claim `path` — both wrong, and the bug shipped because
    // the wire shape had no test. This test pins every field the picker
    // consumes so a future rename is caught at the route layer rather than
    // by the next acceptance pass.
    const tmp = mkdtempSync(join(tmpdir(), "webui-browse-shape-"));
    try {
      mkdirSync(join(tmp, "sub"));
      const req = Readable.from([Buffer.from("")]);
      req.url = `/api/workspace/browse?path=${encodeURIComponent(tmp)}`;
      req.headers = { host: "localhost" };
      const res = fakeRes();
      wsRoute.handleWorkspaceBrowse(req, res, {});
      const body = JSON.parse(res._body);
      assert.equal(res._status, 200);
      assert.equal(body.ok, true);
      // The directory the listing is for — picker reads this for confirm/mkdir.
      assert.equal(body.dir, tmp);
      // One level up (tmpdir has a parent on POSIX; on Windows it may be null).
      assert.ok("parent" in body, "parent key present");
      // Children — picker reads this for the listing rows.
      assert.ok(Array.isArray(body.children));
      assert.equal(body.children.length, 1);
      assert.equal(body.children[0].name, "sub");
      assert.equal(body.children[0].path, join(tmp, "sub"));
      // browseWorkspace only enumerates directories (files are filtered
      // out at the server), so every child must carry `isDir: true`.
      // The picker's row click navigates on `entry.isDir && setPath(...)`
      // — without this flag the click handler never fires and the only
      // way to navigate was the path input / up / home / roots buttons.
      assert.equal(body.children[0].isDir, true);
      // The `path` field MUST NOT exist on the browse response — a future
      // rename to add it would mask the existing `dir` and re-introduce
      // the picker bug. Asserting absence here keeps the contract tight.
      assert.equal(body.path, undefined, "no `path` field on browse response");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================
// qa (session-workspace-crud): 项目目录选择 route 层 — tree / resolve / recent
// ============================================================

const { registerSessionsStore } = await import("../helpers/_setup.js");

function fakeGet(url) {
  const stream = Readable.from([Buffer.from("")]);
  stream.url = url;
  stream.method = "GET";
  stream.headers = { host: "localhost" };
  return stream;
}

describe("handleWorkspaceTree — 工作区→会话树", () => {
  test("groups sessions by workspace, current pinned first, empty current still listed", () => {
    registerSessionsStore({
      initial: [
        { id: "s1", workspace: "/ws/old", title: "a", createdAt: 1, updatedAt: 10 },
        { id: "s2", workspace: "/ws/old", title: "b", createdAt: 2, updatedAt: 30 },
        { id: "s3", workspace: "/ws/other", title: "c", createdAt: 3, updatedAt: 20 },
        { id: "s4", workspace: "", title: "no-ws", createdAt: 4, updatedAt: 40 },
      ],
    });
    const cs = fakeCs("/ws/current-with-no-sessions");
    const res = fakeRes();
    wsRoute.handleWorkspaceTree(fakeGet("/api/workspace/tree"), res, { cs, cid: "cid-1" });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.current, "/ws/current-with-no-sessions");
    assert.ok(body.tmpDir, "tmpDir provided for 'no workspace' button");
    // current first even with zero sessions; then others by lastActiveAt desc
    assert.equal(body.workspaces[0].current, true);
    assert.equal(body.workspaces[0].sessionCount, 0);
    const names = body.workspaces.map((w) => w.dir);
    assert.ok(names.includes("/ws/old") && names.includes("/ws/other"));
    assert.ok(!names.includes(""), "workspace-less sessions not grouped");
    const old = body.workspaces.find((w) => w.dir === "/ws/old");
    assert.equal(old.sessionCount, 2);
    assert.deepEqual(old.sessions.map((s) => s.id), ["s2", "s1"], "sessions sorted by updatedAt desc");
    assert.equal(old.sessions[0].title, "b");
  });
});

describe("handleWorkspaceResolve — 文件夹名 → 候选", () => {
  test("invalid name → 400 with ok:false", () => {
    const res = fakeRes();
    wsRoute.handleWorkspaceResolve(fakeGet("/api/workspace/resolve?name=a%2Fb"), res, {});
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
  });

  test("valid name → 200 with candidates array (may be empty)", () => {
    const res = fakeRes();
    wsRoute.handleWorkspaceResolve(fakeGet("/api/workspace/resolve?name=some-unique-name-xyz"), res, {});
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.candidates));
  });
});

describe("handleWorkspaceRecent — 最近工作区", () => {
  test("returns aggregated items + tmpDir, honors search & limit", () => {
    registerSessionsStore({
      initial: [
        { id: "r1", workspace: "/ws/alpha", createdAt: 1, updatedAt: 100 },
        { id: "r2", workspace: "/ws/alpha", createdAt: 2, updatedAt: 300 },
        { id: "r3", workspace: "/ws/beta", createdAt: 3, updatedAt: 200 },
      ],
    });
    const res = fakeRes();
    wsRoute.handleWorkspaceRecent(fakeGet("/api/workspace/recent?limit=1"), res, {});
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 1, "limit honored");
    assert.equal(body.items[0].dir, "/ws/alpha", "most recent first");
    assert.equal(body.items[0].sessionCount, 2);
    assert.ok(body.tmpDir, "tmpDir attached");

    const res2 = fakeRes();
    wsRoute.handleWorkspaceRecent(fakeGet("/api/workspace/recent?search=beta"), res2, {});
    const body2 = JSON.parse(res2._body);
    assert.equal(body2.items.length, 1);
    assert.equal(body2.items[0].dir, "/ws/beta", "search filter honored");
  });
});
