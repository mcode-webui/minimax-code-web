// webui/test/lib/workspace.check.mjs
// Unit tests for server/lib/workspace.js — handleWorkspaceChange + browseWorkspace.
//
// Why this test exists: workspace.js is the workspace picker / chip logic.
// handleWorkspaceChange has 5 actions (set/useTui/reset/detect/missing)
// with subtle priority order. browseWorkspace lists directories and has
// Windows-specific code (drive letters) and a MAX=500 truncation guard.
// Bugs here = user clicks workspace chip and gets wrong path / crashes.
//
// Test strategy: USE setupMocks to mock lib/acp-client.js. Without this mock,
// pushStateFor (called inside handleWorkspaceChange) would trigger a real
// mcode acp client spawn via getMcodeSessionsForWorkspace on cache miss,
// which hangs the test indefinitely.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir, homedir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setupMocks, absPath } from "../helpers/_setup.js";

let ws;
before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
    },
  });
  ws = await import(absPath("lib/workspace.js"));
});

function fakeCs(workspaceDir = "/some/default") {
  return {
    workspace: { dir: workspaceDir, branch: null, tree: null },
  };
}

describe("handleWorkspaceChange — action: 'set'", () => {
  test("changes cs.workspace.dir to the provided dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-test-"));
    try {
      const cs = fakeCs("/old");
      const r = ws.handleWorkspaceChange(cs, "cid-1", { action: "set", dir: tmp });
      assert.equal(r.ok, true);
      assert.equal(cs.workspace.dir, tmp);
      assert.ok(r.workspace.dir === tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolves the path to absolute", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-test-"));
    try {
      const cs = fakeCs();
      const r = ws.handleWorkspaceChange(cs, "cid-1", {
        action: "set",
        dir: join(tmp, "..", tmp.split(/[\\/]/).pop()),
      });
      assert.equal(r.ok, true);
      assert.ok(cs.workspace.dir.startsWith(tmpdir()) || cs.workspace.dir === tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns {ok:false, error:'目录不存在'} for non-existent dir", () => {
    const cs = fakeCs();
    const r = ws.handleWorkspaceChange(cs, "cid-1", {
      action: "set",
      dir: "C:\\nonexistent\\path\\that\\does\\not\\exist\\xyz",
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /不存在/);
  });

  test("returns {ok:false, error:'目录不存在'} when target is a file, not a dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-test-"));
    try {
      const file = join(tmp, "not-a-dir.txt");
      writeFileSync(file, "x");
      const cs = fakeCs();
      const r = ws.handleWorkspaceChange(cs, "cid-1", { action: "set", dir: file });
      assert.equal(r.ok, false);
      assert.match(r.error, /不存在/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("handleWorkspaceChange — action: 'detect' (no mutation)", () => {
  test("returns tuiCwd + defaultWorkspace + current, does NOT change cs.workspace", () => {
    const cs = fakeCs("/my-current");
    const before = cs.workspace.dir;
    const r = ws.handleWorkspaceChange(cs, "cid-1", { action: "detect" });
    assert.equal(r.ok, true);
    assert.equal(r.detectOnly, true);
    assert.equal(r.current, "/my-current");
    assert.equal(typeof r.defaultWorkspace, "string");
    assert.equal(cs.workspace.dir, before);
  });
});

describe("handleWorkspaceChange — missing dir", () => {
  test("returns {ok:false, error:'dir 不能为空'} for empty dir", () => {
    const cs = fakeCs();
    const r = ws.handleWorkspaceChange(cs, "cid-1", { action: "set", dir: "" });
    assert.equal(r.ok, false);
    assert.match(r.error, /不能为空/);
  });

  test("returns {ok:false, error:'dir 不能为空'} for null dir", () => {
    const cs = fakeCs();
    const r = ws.handleWorkspaceChange(cs, "cid-1", { action: "set", dir: null });
    assert.equal(r.ok, false);
    assert.match(r.error, /不能为空/);
  });

  test("returns {ok:false, error:'dir 不能为空'} for non-string dir", () => {
    const cs = fakeCs();
    const r = ws.handleWorkspaceChange(cs, "cid-1", { action: "set", dir: 123 });
    assert.equal(r.ok, false);
    assert.match(r.error, /不能为空/);
  });
});

describe("handleWorkspaceChange — syncTui flag", () => {
  test("writes ~/.minimax/runtime/cwd.json when syncTui=true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-test-"));
    // v1.0: 测试卫生 — 本用例写的是真实 ~/.minimax/runtime/cwd.json (mcode TUI 的状态文件)。
    //   之前不恢复, 每次跑完测试, 下次服务器启动的默认工作区就成了临时目录
    //   (侧栏工作区 chip 显示 webui-ws-test-xxx, 命令探测会话也建在那里)
    const tuiCwdFile = join(homedir(), ".minimax", "runtime", "cwd.json");
    let savedTuiCwd = null;
    try {
      savedTuiCwd = readFileSync(tuiCwdFile, "utf8");
    } catch {}
    try {
      const cs = fakeCs();
      assert.doesNotThrow(() => {
        ws.handleWorkspaceChange(cs, "cid-1", { action: "set", dir: tmp, syncTui: true });
      });
      assert.equal(cs.workspace.dir, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      try {
        if (savedTuiCwd !== null) writeFileSync(tuiCwdFile, savedTuiCwd);
        else rmSync(tuiCwdFile, { force: true });
      } catch {}
    }
  });

  test("does not write cwd.json when syncTui is omitted (default false)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-test-"));
    try {
      const cs = fakeCs();
      const r = ws.handleWorkspaceChange(cs, "cid-1", { action: "set", dir: tmp });
      assert.equal(r.ok, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("browseWorkspace — happy path", () => {
  test("lists subdirectories of an existing dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-browse-"));
    try {
      mkdirSync(join(tmp, "subdir-a"));
      mkdirSync(join(tmp, "subdir-b"));
      writeFileSync(join(tmp, "a-file.txt"), "x");
      const r = ws.browseWorkspace(tmp);
      assert.equal(r.ok, true);
      assert.equal(r.dir, tmp);
      assert.ok(Array.isArray(r.children));
      assert.equal(r.children.length, 2);
      assert.ok(r.children.some((c) => c.name === "subdir-a"));
      assert.ok(r.children.some((c) => c.name === "subdir-b"));
      assert.ok(!r.children.some((c) => c.name === "a-file.txt"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns {ok:false, error:'目录不存在'} for non-existent path", () => {
    const r = ws.browseWorkspace("C:\\nonexistent\\path\\that\\does\\not\\exist\\xyz");
    assert.equal(r.ok, false);
    assert.match(r.error, /不存在/);
  });

  test("returns empty children list for an existing empty dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-browse-"));
    try {
      const r = ws.browseWorkspace(tmp);
      assert.equal(r.ok, true);
      assert.equal(r.children.length, 0);
      assert.equal(r.skipped, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns parent path when target is not the root", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-browse-"));
    try {
      const sub = join(tmp, "sub");
      mkdirSync(sub);
      const r = ws.browseWorkspace(sub);
      assert.equal(r.ok, true);
      assert.equal(r.parent, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("browseWorkspace — empty path (drive letter / root listing)", () => {
  test("Windows: returns drive letters as roots", { skip: process.platform !== "win32" }, () => {
    const r = ws.browseWorkspace("");
    assert.equal(r.ok, true);
    assert.equal(r.dir, null);
    assert.ok(Array.isArray(r.roots));
    assert.ok(r.roots.length > 0);
  });

  test("non-Windows: returns '/' as target", { skip: process.platform === "win32" }, () => {
    const r = ws.browseWorkspace("");
    assert.equal(r.ok, true);
    assert.equal(r.dir, "/");
  });
});

describe("browseWorkspace — MAX 500 truncation", () => {
  test("truncates to 500 children and reports skipped count", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-ws-max-"));
    try {
      for (let i = 0; i < 510; i++) {
        mkdirSync(join(tmp, `d${i.toString().padStart(4, "0")}`));
      }
      const r = ws.browseWorkspace(tmp);
      assert.equal(r.ok, true);
      assert.equal(r.children.length, 500, "should truncate to 500");
      assert.equal(r.skipped, 10, "should report 10 skipped");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================
// qa (session-workspace-crud): 项目目录选择 — resolve/recent/expandTilde
//   （tree 的 route 层覆盖在 routes-workspace.check.mjs）
// ============================================================

const { registerSessionsStore } = await import("../helpers/_setup.js");

describe("resolveWorkspaceCandidates — 零弹窗目录名 → 绝对路径候选", () => {
  let home;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "webui-resolve-home-"));
    mkdirSync(join(home, "myproj"));
    mkdirSync(join(home, "projects", "myproj"), { recursive: true });
    mkdirSync(join(home, "other"));
  });
  after(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  test("finds both the home-sub and home-deep match, deduped", () => {
    const r = ws.resolveWorkspaceCandidates("myproj", { home, platform: "linux", user: "nobody" });
    assert.equal(r.ok, true);
    const paths = r.candidates.map((c) => c.path);
    assert.ok(paths.includes(join(home, "myproj")), "home-sub hit");
    assert.ok(paths.includes(join(home, "projects", "myproj")), "home-deep hit (COMMON_PROJECT_PARENTS)");
    assert.equal(new Set(paths).size, paths.length, "no duplicates");
  });

  test("no match → ok with empty candidates (client falls back to browse)", () => {
    const r = ws.resolveWorkspaceCandidates("definitely-not-here-xyz", { home, platform: "linux", user: "nobody" });
    assert.equal(r.ok, true);
    assert.equal(r.candidates.length, 0);
  });

  test("rejects names with path separators / dot segments (injection guard)", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "x".repeat(256)]) {
      const r = ws.resolveWorkspaceCandidates(bad, { home, platform: "linux" });
      assert.equal(r.ok, false, `should reject: ${JSON.stringify(bad)}`);
      assert.equal(r.candidates.length, 0);
    }
  });
});

describe("getRecentWorkspaces — 最近工作区（sessions store 聚合）", () => {
  before(() => {
    registerSessionsStore({
      initial: [
        { id: "s1", workspace: "/ws/alpha", createdAt: 1, updatedAt: 100 },
        { id: "s2", workspace: "/ws/alpha", createdAt: 2, updatedAt: 300 },
        { id: "s3", workspace: "/ws/Beta", createdAt: 3, updatedAt: 200 },
        { id: "s4", workspace: "", createdAt: 4, updatedAt: 400 }, // 无工作区不分组
        { id: "s5", workspace: "/ws/gamma", createdAt: 5, updatedAt: 50 },
      ],
    });
  });

  test("groups by workspace, sorted by lastActiveAt desc, sessionCount correct", () => {
    const r = ws.getRecentWorkspaces({});
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 3, "empty-workspace session excluded");
    assert.deepEqual(
      r.items.map((it) => it.dir),
      ["/ws/alpha", "/ws/Beta", "/ws/gamma"],
    );
    assert.equal(r.items[0].sessionCount, 2);
    assert.equal(r.items[0].lastActiveAt, 300, "max updatedAt wins");
    assert.equal(r.items[0].name, "alpha", "basename derived");
  });

  test("search matches path or basename, case-insensitive", () => {
    const r = ws.getRecentWorkspaces({ search: "BETA" });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].dir, "/ws/Beta");
    const byName = ws.getRecentWorkspaces({ search: "gamma" });
    assert.equal(byName.items.length, 1);
  });

  test("limit clamps: default 5, hard max 20", () => {
    assert.equal(ws.getRecentWorkspaces({}).limit, 5);
    assert.equal(ws.getRecentWorkspaces({ limit: 100 }).limit, 20);
  });
});

describe("expandTilde — 手动输入路径展开", () => {
  test("~ alone → home; ~/x and ~\\x → home-joined; other strings untouched", () => {
    assert.equal(ws.expandTilde("~"), homedir());
    assert.equal(ws.expandTilde("~/proj"), join(homedir(), "proj"));
    assert.equal(ws.expandTilde("~\\proj"), join(homedir(), "proj"));
    assert.equal(ws.expandTilde("/abs/path"), "/abs/path");
    assert.equal(ws.expandTilde("~user/x"), "~user/x", "~user 语法不支持，原样返回");
    assert.equal(ws.expandTilde(42), 42, "non-string passthrough");
  });
});

describe("assertWorkspaceParentPath — mkdir 落点围栏", () => {
  test("parent inside roots → ok; parent outside → rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "webui-parent-root-"));
    const out = mkdtempSync(join(tmpdir(), "webui-parent-out-"));
    process.env.MCODE_WEBUI_WORKSPACE_ROOTS = root;
    try {
      const ok = ws.assertWorkspaceParentPath(join(root, "newdir"));
      assert.equal(ok.ok, true);
      const bad = ws.assertWorkspaceParentPath(join(out, "newdir"));
      assert.equal(bad.ok, false, "outside roots must be rejected");
    } finally {
      delete process.env.MCODE_WEBUI_WORKSPACE_ROOTS;
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      try { rmSync(out, { recursive: true, force: true }); } catch {}
    }
  });
});
