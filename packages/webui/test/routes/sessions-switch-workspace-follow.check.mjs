// webui/test/routes/sessions-switch-workspace-follow.check.mjs
// (s39 — webui-parity ticket 39: file tree must follow the switched session)
//
// User reported: 切会话时,文件树显示的还是上一个项目的工作区,因为
// handleSwitchSession 只读 cs.workspace,从不写。还会把目标会话存的工作区
// 覆盖成当前工作区(把记录改坏)。
//
// Fix:
//   1. 切换后 cs.workspace.dir 跟随目标会话存的 workspace(target-first,
//      fallback DEFAULT_WORKSPACE if empty)。必须过 assertWorkspacePath
//      containment 闸门。
//   2. ensureOverlayForMcodeSid 不再用当前 cs.workspace 写 target 已有的
//      workspace — target 没存过工作区时回退 DEFAULT_WORKSPACE。
//
// 这些测试先会失败,然后在修复 commit 中变绿。
//
// Mutation-tripwires:
//   - ① 把 :309 的覆盖改回去(继续用当前 cs.workspace 写 target)→
//     "switch must not overwrite target.workspace" 必须变红。
//   - ② 让切换不带 containment 闸门 → "switch must go through containment gate"
//     必须变红。
//   - ③ (webui-parity 63 / 缺陷 F) 去掉 DEFAULT_WORKSPACE 回落分支 →
//     "the fallback is the live value" 必须变红。
//   - ④ (webui-parity 63 / 缺陷 F) 让改名路径重新用当前 cs.workspace 给
//     首次触碰的 mvs_ 记录盖章 → "the rename overlay" 必须变红。

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupMocks,
  absPath,
  registerSessionsStore,
  getSessionsStore,
  registerAcpMock,
} from "../helpers/_setup.js";

let handleSwitchSession;
let handleRenameSession;
let makeClientState;
let clients;

// Real containment roots — assertWorkspacePath walks `allowed roots`
// from env MCODE_WEBUI_WORKSPACE_ROOTS (or homedir/tmpdir/DEFAULT_WORKSPACE
// when unset). We pin MCODE_WEBUI_WORKSPACE_ROOTS to a freshly-created
// workspace tree so this test is self-contained and never lands on the
// host's real home / tmp. Both `projectA` and `projectB` live under the
// same root so containment accepts both; the test asserts that switching
// from one to the other re-points cs.workspace.dir to the OTHER project's
// workspace — not the FIRST project's.
const REAL_DEFAULT_WORKSPACE = "/usr"; // DEFAULT_WORKSPACE falls back through homedir, but env override forces it
let _tmpEventsDir;
let _tmpWorkspaceRoot;
let _tmpDbDir;
// DEFAULT_DIR is the value DEFAULT_WORKSPACE resolves to when
// MCODE_WORKSPACE is set at config-load time. Pinning it inside
// _tmpWorkspaceRoot lets the "empty target" tests assert exact equality
// on the fallback path. Set at top level so it is in scope before
// config.js (transitively imported by routes/sessions.js) evaluates
// DEFAULT_WORKSPACE at module-load time.
let DEFAULT_DIR;

before(async (t) => {
  _tmpEventsDir = mkdtempSync(join(tmpdir(), "webui-s39-events-"));
  process.env.MCODE_WEBUI_EVENTS_PATH = join(_tmpEventsDir, "events.ndjson");
  _tmpDbDir = mkdtempSync(join(tmpdir(), "webui-s39-db-"));
  process.env.MCODE_RUNTIME_DB = join(_tmpDbDir, "runtime-state.sqlite");
  writeFileSync(process.env.MCODE_RUNTIME_DB, "");
  _tmpWorkspaceRoot = mkdtempSync(join(tmpdir(), "webui-s39-roots-"));
  // DEFAULT_WORKSPACE fallback directory — set BEFORE config.js evaluates
  // DEFAULT_WORKSPACE (config.js runs at the SUT's first dynamic import
  // below). Must live inside _tmpWorkspaceRoot so containment accepts it.
  // assertWorkspacePath's realpathSync requires the path to exist, so we
  // mkdir it (and every other workspace dir the tests use) here.
  //
  // macOS /tmp is a symlink to /private/tmp — resolve once so the
  // env var AND the assertion constants use the SAME form
  // assertWorkspacePath normalizes to (see fs-write.test.js / #81
  // commit 7ac8f07 — the macOS CI fix the acceptance review cited).
  // mkdirSync first because realpathSync needs the target to exist.
  mkdirSync(join(_tmpWorkspaceRoot, "default-workspace"), { recursive: true });
  mkdirSync(join(_tmpWorkspaceRoot, "projectA"), { recursive: true });
  mkdirSync(join(_tmpWorkspaceRoot, "projectB"), { recursive: true });
  DEFAULT_DIR = realpathSync(join(_tmpWorkspaceRoot, "default-workspace"));
  process.env.MCODE_WORKSPACE = DEFAULT_DIR;
  // Allowed roots — only the test temp dir. DEFAULT_WORKSPACE lives
  // inside it (set just above); every per-test ws is also inside it;
  // nothing else is allowed, so out-of-bounds attempts 400.
  process.env.MCODE_WEBUI_WORKSPACE_ROOTS = _tmpWorkspaceRoot;

  await setupMocks(t, {
    mavis: { applyMavisUsageToCs: async () => {} },
  });
  // sqlite-resolver default no-op (no transcript backfill in this test):
  t.mock.module(absPath("lib/sqlite-resolver.js"), {
    namedExports: {
      getMcodeBetterSqlite3: () => {
        // Mimics the real behaviour when the real better-sqlite3 is
        // not loadable: every prepare throws, so transcript lookup
        // returns ok:false / no rows. This is the same shape the
        // real env produces when the mcode runtime db is missing —
        // both round-trip back to "no transcript" without erroring
        // the switch.
        return class FakeDb {
          prepare() {
            throw new Error("fake: no such column");
          }
          close() {}
        };
      },
      _getBetterSqlite3Candidates: () => [],
    },
  });
  t.mock.module(absPath("lib/mcode-session-delete.js"), {
    namedExports: {
      deleteMcodeSessionFromDb: () => ({ ok: false, reason: "test_mock" }),
      MCODE_SESSION_DELETE_TABLES: [],
    },
  });
  const sb = await import(absPath("lib/state-bus.js"));
  makeClientState = sb.makeClientState;
  clients = sb.clients;
  const sessionsMod = await import(absPath("routes/sessions.js"));
  handleSwitchSession = sessionsMod.handleSwitchSession;
  handleRenameSession = sessionsMod.handleRenameSession;
});

after(() => {
  delete process.env.MCODE_WEBUI_EVENTS_PATH;
  delete process.env.MCODE_RUNTIME_DB;
  delete process.env.MCODE_WEBUI_WORKSPACE_ROOTS;
  delete process.env.MCODE_WORKSPACE;
  if (_tmpEventsDir) {
    try { rmSync(_tmpEventsDir, { recursive: true, force: true }); } catch {}
  }
  if (_tmpDbDir) {
    try { rmSync(_tmpDbDir, { recursive: true, force: true }); } catch {}
  }
  if (_tmpWorkspaceRoot) {
    try { rmSync(_tmpWorkspaceRoot, { recursive: true, force: true }); } catch {}
  }
});

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) { this._body = b; },
  };
}

function newCs(ws = "/ws-current") {
  const cs = makeClientState();
  cs.workspace = { dir: ws, branch: null, tree: null };
  return cs;
}

async function doSwitch(id, cs, cid = "cid-1") {
  const res = fakeRes();
  await handleSwitchSession(fakeReq({ id }), res, { cs, cid, pathname: "" });
  return { res, body: res._body ? JSON.parse(res._body) : null };
}

async function doRename({ id, title }, cs, cid = "cid-1") {
  const res = fakeRes();
  await handleRenameSession(fakeReq({ id, title }), res, { cs, cid, pathname: "" });
  return { res, body: res._body ? JSON.parse(res._body) : null };
}

/** Every workspace value currently persisted, for "nothing was written" checks. */
function persistedWorkspaces() {
  return getSessionsStore().map((s) => s.workspace);
}

const A_ID = "webui-A";
const B_ID = "webui-B";
const A_WS = "/ws-current/projectA"; // same prefix as current — irrelevant for the test
// For real containment, the project dirs MUST exist under the allowed
// roots we just created. Pin absolute paths to the temp root so the
// containment gate passes for projectA / projectB but rejects everything
// else.
//
// macOS /tmp is a symlink to /private/tmp — on Linux the joined
// `/tmp/<...>` form equals the realpath form, on macOS they differ.
// Every assertion must compare against the SAME form
// assertWorkspacePath returns, so build the constants through
// realpathSync after the dirs exist (mirrors fs-write.test.js / #81
// commit 7ac8f07 — the macOS CI fix the acceptance review cited).
function realWs(name) {
  return realpathSync(join(_tmpWorkspaceRoot, name));
}
const A_REAL = realWs("projectA");
const B_REAL = realWs("projectB");

beforeEach(() => {
  clients.clear();
  registerAcpMock({
    getMcodeSessionsCacheSync: () => null,
    getMcodeSessionsStaleSync: () => null,
    getMcodeSessionTitle: async () => null,
  });
});

// ============================================================
// 1. 两会话 workspace 不同,A → B 必须把 cs.workspace.dir 切到 B
// ============================================================
describe("handleSwitchSession — workspace follow (s39 fix)", () => {
  test("switching to a session with a different workspace re-points cs.workspace.dir", async () => {
    registerSessionsStore({
      initial: [
        {
          id: A_ID,
          title: "Session A",
          workspace: A_REAL,
          createdAt: 1,
          updatedAt: 1,
          chat: ["● A-history"],
        },
        {
          id: B_ID,
          title: "Session B",
          workspace: B_REAL,
          createdAt: 2,
          updatedAt: 2,
          chat: ["● B-history"],
        },
      ],
    });
    // Current workspace starts on A's project (so the user is browsing A).
    const cs = newCs(A_REAL);
    assert.equal(cs.workspace.dir, A_REAL, "precondition: current ws is A");

    const { res, body } = await doSwitch(B_ID, cs);
    assert.equal(res._status, 200, `switch failed: ${res._body}`);
    assert.equal(body.ok, true);
    assert.equal(cs.workspace.dir, B_REAL, "cs.workspace.dir must follow to B");
    assert.equal(cs.sessionId, B_ID, "sessionId switches");
  });

  test("switching back to A from B re-points cs.workspace.dir back to A", async () => {
    registerSessionsStore({
      initial: [
        { id: A_ID, title: "Session A", workspace: A_REAL, createdAt: 1, updatedAt: 1, chat: [] },
        { id: B_ID, title: "Session B", workspace: B_REAL, createdAt: 2, updatedAt: 2, chat: [] },
      ],
    });
    // Start on B (different from previous test's starting point on A).
    const cs = newCs(B_REAL);
    const { res: res1 } = await doSwitch(A_ID, cs);
    assert.equal(res1._status, 200);
    assert.equal(cs.workspace.dir, A_REAL);
    const { res: res2 } = await doSwitch(B_ID, cs);
    assert.equal(res2._status, 200);
    assert.equal(cs.workspace.dir, B_REAL);
  });

  test("switching does NOT mutate the stored target.workspace (no overwrite)", async () => {
    // Tripwire for mutation ①: 旧代码 `ensureOverlayForMcodeSid(all, id, { workspace: ws })`
    // 用当前 cs.workspace 写 target 已有的 workspace → 把 B 的工作区覆盖成 A。
    registerSessionsStore({
      initial: [
        { id: A_ID, title: "Session A", workspace: A_REAL, createdAt: 1, updatedAt: 1, chat: [] },
        { id: B_ID, title: "Session B", workspace: B_REAL, createdAt: 2, updatedAt: 2, chat: [] },
      ],
    });
    const cs = newCs(A_REAL);
    await doSwitch(B_ID, cs);
    const stored = getSessionsStore().find((s) => s.id === B_ID);
    assert.equal(stored.workspace, B_REAL, "B.workspace MUST remain B (no overwrite by current ws)");
    const storedA = getSessionsStore().find((s) => s.id === A_ID);
    assert.equal(storedA.workspace, A_REAL, "A.workspace MUST remain A");
  });

  test("newly-created mvs_ overlay is NOT stamped with current cs.workspace (no ② pollution)", async () => {
    // Tripwire for mutation ①, second leg: the OLD code passed
    // `{ title, workspace: ws }` to ensureOverlayForMcodeSid, so a
    // freshly-created overlay for an mvs_ session inherited the
    // CURRENT cs.workspace. Switching back to that mvs_ from a
    // DIFFERENT workspace would then land on the polluted workspace.
    // The fix passes only `{ title }`, so the new overlay starts with
    // workspace:"" and the switch path's target-first read picks
    // DEFAULT_WORKSPACE instead of inheriting the pollution.
    registerSessionsStore({ initial: [] });
    const MVS_NEW = "mvs_dddd1111222233334444555566660000";
    // Start on projectA, switch to a brand-new mvs_ session (no overlay
    // exists). With the mutation re-introduced, the overlay would carry
    // workspace:A_REAL. After the fix it must carry workspace:"" so the
    // DEFAULT_WORKSPACE fallback governs the next switch back.
    const cs = newCs(A_REAL);
    const { res } = await doSwitch(MVS_NEW, cs);
    assert.equal(res._status, 200);
    const stored = getSessionsStore().find((s) => s.mcodeSessionId === MVS_NEW);
    assert.ok(stored, "overlay was created");
    assert.equal(
      stored.workspace,
      "",
      "newly-created mvs_ overlay MUST have workspace=\"\" (not current cs.workspace)",
    );
  });
});

// ============================================================
// 2. target.workspace 为空 → 回退 DEFAULT_WORKSPACE,不静默留当前
// ============================================================
describe("handleSwitchSession — workspace empty fallback (s39 fix)", () => {
  test("target.workspace === ''  → cs.workspace.dir falls back to DEFAULT_WORKSPACE", async () => {
    // DEFAULT_WORKSPACE is MCODE_WORKSPACE (set at top of file, before
    // config.js evaluates) → DEFAULT_DIR, which lives inside
    // _tmpWorkspaceRoot so the containment gate accepts it.
    registerSessionsStore({
      initial: [
        { id: A_ID, title: "Session A", workspace: A_REAL, createdAt: 1, updatedAt: 1, chat: [] },
        {
          id: "webui-orphan",
          title: "Orphan session",
          workspace: "", // ② pollution damage OR old session shape
          createdAt: 3,
          updatedAt: 3,
          chat: [],
        },
      ],
    });
    // Start on A; switching to orphan should NOT leave us on A.
    const cs = newCs(A_REAL);
    const { res } = await doSwitch("webui-orphan", cs);
    assert.equal(res._status, 200);
    assert.notEqual(
      cs.workspace.dir,
      A_REAL,
      "must NOT silently stay on current ws when target has none (this is the user-reported symptom)",
    );
    // The fallback resolves through DEFAULT_WORKSPACE; we just assert
    // it landed on the value the env pin dictated.
    assert.equal(cs.workspace.dir, DEFAULT_DIR);
  });

  test("target.workspace === null / non-string  → same DEFAULT_WORKSPACE fallback", async () => {
    registerSessionsStore({
      initial: [
        { id: A_ID, title: "A", workspace: A_REAL, createdAt: 1, updatedAt: 1, chat: [] },
        // The ② pollution + drift over time can also leave workspace
        // as null / undefined. lib/sessions.js normalize on write,
        // but the route must handle it.
        { id: "webui-null", title: "Null ws", workspace: null, createdAt: 3, updatedAt: 3, chat: [] },
      ],
    });
    const cs = newCs(A_REAL);
    const { res } = await doSwitch("webui-null", cs);
    assert.equal(res._status, 200);
    assert.notEqual(cs.workspace.dir, A_REAL);
    assert.equal(cs.workspace.dir, DEFAULT_DIR);
  });
});

// ============================================================
// 3. containment gate: target.workspace 越界 → 400
// ============================================================
describe("handleSwitchSession — containment gate (s39 fix)", () => {
  test("target.workspace is outside allowed roots → 400 with actionable error", async () => {
    // 越界路径: 不在 _tmpWorkspaceRoot 下,且 _tmpWorkspaceRoot 是
    // 唯一允许根。父目录是 /usr — 仍在 root 下,但 /usr 自己不在
    // _tmpWorkspaceRoot 下。我们用绝对路径 "/etc" 这种显然越界的。
    registerSessionsStore({
      initial: [
        { id: A_ID, title: "A", workspace: A_REAL, createdAt: 1, updatedAt: 1, chat: [] },
        {
          id: "webui-evil",
          title: "Out-of-bounds ws",
          workspace: "/etc",
          createdAt: 5,
          updatedAt: 5,
          chat: [],
        },
      ],
    });
    const cs = newCs(A_REAL);
    const { res } = await doSwitch("webui-evil", cs);
    assert.equal(res._status, 400, `expected 400, got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error || "", /工作区越界|越界|allowed|containment/i);
    // Crucial: cs.workspace.dir must NOT have been re-pointed to the
    // out-of-bounds path — it stays at A_REAL (the previous valid ws).
    assert.equal(cs.workspace.dir, A_REAL);
  });

  test("target.workspace traversal escape (`/tmpWorkspaceRoot/../escape`) → 400", async () => {
    // Traversal attempt: `..` escapes the allowed root.
    const escape = `${_tmpWorkspaceRoot}/../escape`;
    registerSessionsStore({
      initial: [
        { id: A_ID, title: "A", workspace: A_REAL, createdAt: 1, updatedAt: 1, chat: [] },
        {
          id: "webui-escape",
          title: "Traversal ws",
          workspace: escape,
          createdAt: 5,
          updatedAt: 5,
          chat: [],
        },
      ],
    });
    const cs = newCs(A_REAL);
    const { res } = await doSwitch("webui-escape", cs);
    assert.equal(res._status, 400, `expected 400, got ${res._status}: ${res._body}`);
    assert.equal(cs.workspace.dir, A_REAL);
  });
});
// ============================================================
// 4. 回落值只活在本次请求里,不得写进任何持久记录
//    (webui-parity 63, 缺陷 F)
// ============================================================
// 切换到没有 workspace 记录的会话时,cs.workspace.dir 会临时等于
// DEFAULT_WORKSPACE —— 那是为了让文件树有根可读,不是"这个会话就跑在
// 这里"。落库之后,下一次切换会 target-first 读回这个假值,文件树根就被
// 永久改写(质检实测:会话 1 的文件树根变成 demo002)。
//
// 剩下的唯一写入路径是改名时给纯 mvs_ 会话补 webui 壳:
// ensureOverlayForMcodeSid(all, id, { workspace: cs.workspace.dir }) ——
// 那等于把"我现在在哪"盖到别人的记录上,与 s39 在切换路径上删掉的是同一
// 段逻辑。修法是壳从 workspace:"" 起步(未知就写未知),回落只在读取时发生。
describe("handleSwitchSession — DEFAULT_WORKSPACE fallback never persists (webui-parity 63)", () => {
  const WS_LESS = {
    id: "webui-wsless",
    title: "No workspace",
    workspace: "", // 旧记录 / 早期引擎会话的形状
    createdAt: 4,
    updatedAt: 4,
    chat: [],
  };
  const FOREIGN_MVS = "mvs_aaaa1111222233334444555566667777";

  test("the fallback is the live value but never reaches the store", async () => {
    registerSessionsStore({
      initial: [
        { id: A_ID, title: "Session A", workspace: A_REAL, createdAt: 1, updatedAt: 1, chat: [] },
        WS_LESS,
      ],
    });
    const cs = newCs(A_REAL);
    const { res, body } = await doSwitch(WS_LESS.id, cs);
    assert.equal(res._status, 200, `switch failed: ${res._body}`);
    // The live fallback is the point of the fix — the file tree needs a root.
    assert.equal(cs.workspace.dir, DEFAULT_DIR, "the live value is the DEFAULT_WORKSPACE fallback");
    assert.equal(body.session.workspaceFallback, true, "the response must say it fell back");
    // …and it is live only: the store still holds exactly what it held.
    assert.deepEqual(
      persistedWorkspaces(),
      [A_REAL, ""],
      "the fallback must not be written into any persisted record",
    );
  });

  test("the rename overlay does not stamp the fallback onto a foreign session", async () => {
    registerSessionsStore({
      initial: [
        { id: A_ID, title: "Session A", workspace: A_REAL, createdAt: 1, updatedAt: 1, chat: [] },
        WS_LESS,
      ],
    });
    // Land on the workspace-less session, so cs.workspace.dir is the fallback
    // for the rest of this client state's life.
    const cs = newCs(A_REAL);
    const { res: switchRes } = await doSwitch(WS_LESS.id, cs);
    assert.equal(switchRes._status, 200);
    assert.equal(cs.workspace.dir, DEFAULT_DIR);

    // Now rename an engine session that has no webui record at all. The
    // overlay the rename has to create belongs to a conversation that never
    // ran in DEFAULT_WORKSPACE, so it must be created workspace-less.
    const { res: renameRes } = await doRename({ id: FOREIGN_MVS, title: "Renamed" }, cs);
    assert.equal(renameRes._status, 200, `rename failed: ${renameRes._body}`);
    const overlay = getSessionsStore().find((s) => s.mcodeSessionId === FOREIGN_MVS);
    assert.ok(overlay, "the rename must still create the overlay record");
    assert.equal(overlay.title, "Renamed", "the rename itself must still work");
    assert.equal(
      overlay.workspace,
      "",
      "the overlay MUST NOT inherit cs.workspace.dir (it may be a fallback)",
    );
    assert.ok(
      !persistedWorkspaces().includes(DEFAULT_DIR),
      `no record may carry the fallback: ${JSON.stringify(persistedWorkspaces())}`,
    );
  });
});
