// webui/test/lib/state-bus.check.mjs
// Unit tests for server/lib/state-bus.js — pushStateFor + ensureMcodeSessionsFetchedAndPush
//
// Why this test exists: v0.5.bx-31 broadcast bug — when the first event
// stream (/api/stream) subscriber is attached and the mcodeSessions
// cache is empty, the SUT must fire-and-forget fetch the sessions and
// then publish the authoritative state to all subscribed cids. The
// dedup test ensures a second call with the same workspace is a no-op
// while the first is in flight.
//
// [decision 20] SSE 已移除：下行唯一通道是 event-bus（WebSocket
// /api/stream 订阅面），旧 SSE 适配器与 per-cid 连接映射一并删除。本文件的捕获模式：
//   const cap = capture(cid);   // 触发推送“之前”订阅
//   <触发推送>;
//   lastSnapshot(cap.box);      // 从尾部反向找 type==="state.snapshot" 的快照
//   snapshotAt(cap.box, n);     // 多次推送时取第 N 条快照（原 writes[0] 清空语义）
// onlineCount 语义 = getSubscribedCids().length —— capture 即“在线”。

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  subscribeEvents,
  resetEventBusForTests,
} from "../server/lib/event-bus.js";
import {
  setupMocks,
  absPath,
  registerAcpMock,
  registerSessionsStore,
} from "../helpers/_setup.js";

let pushStateFor, mcodeSessionsSnapshotFields;
let clients, makeClientState;
let pushOnlineCount, setActiveChild, getActiveChild, clearActiveChild;
let getCidsByMcodeSession, getClient, getCidFromReq;
let acpFetchCalls, cachedByWs;

before(async (t) => {
  await setupMocks(t);
  const mod = await import(absPath("lib/state-bus.js"));
  pushStateFor = mod.pushStateFor;
  mcodeSessionsSnapshotFields = mod.mcodeSessionsSnapshotFields;
  clients = mod.clients;
  makeClientState = mod.makeClientState;
  pushOnlineCount = mod.pushOnlineCount;
  setActiveChild = mod.setActiveChild;
  getActiveChild = mod.getActiveChild;
  clearActiveChild = mod.clearActiveChild;
  getCidsByMcodeSession = mod.getCidsByMcodeSession;
  getClient = mod.getClient;
  getCidFromReq = mod.getCidFromReq;
});

// Mock acp-client to track fetch calls and serve cache from in-memory map
beforeEach(async () => {
  acpFetchCalls = [];
  cachedByWs = new Map();
  registerAcpMock({
    getMcodeSessionsForWorkspace: async (ws) => {
      acpFetchCalls.push(ws);
      return [{ id: "mock-" + ws, workspace: ws }];
    },
    getMcodeSessionsCacheSync: (ws) =>
      cachedByWs.has(ws) ? cachedByWs.get(ws) : null,
    getMcodeSessionsStaleSync: () => null,
  });
  // 清 client 状态 + 重置事件总线。注意：reset 之后要重新 capture
  // （“先 capture 后触发”），所以下面每个用例都在触发推送前订阅。
  clients.clear();
  resetEventBusForTests();
  registerSessionsStore({
    initial: [
      {
        id: "sess-1",
        title: "old",
        workspace: "/w",
        createdAt: 1,
        updatedAt: 1,
        chat: [],
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// 事件总线捕获（原 fakeSse + SSE 连接映射模式的等价替换）
// ---------------------------------------------------------------------------
function capture(cid) {
  const box = [];
  const unsub = subscribeEvents(cid, (item) => box.push(item));
  return { box, unsub };
}

function snapshotsOf(box) {
  return box
    .filter((i) => i && i.event && i.event.type === "state.snapshot")
    .map((i) => i.event.snapshot);
}

// 从尾部反向找最后一条 state.snapshot —— 等价于旧的“读最后一帧写入”。
function lastSnapshot(box) {
  const snaps = snapshotsOf(box);
  assert.ok(snaps.length > 0, "expected at least one state.snapshot event");
  return snaps[snaps.length - 1];
}

// 多次推送序列里的第 N 条快照（0-based）—— 等价于旧的“清空 writes[0] 再读”。
function snapshotAt(box, n) {
  const snaps = snapshotsOf(box);
  assert.ok(
    snaps.length > n,
    `expected snapshot #${n}, only got ${snaps.length}`,
  );
  return snaps[n];
}

describe("pushStateFor", () => {
  test("uses opts.mcodeSessions when provided (skips cache lookup)", () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    const cap = capture(cid);
    const sessions = [{ id: "direct-1" }];
    pushStateFor(cid, { mcodeSessions: sessions });
    const payload = lastSnapshot(cap.box);
    assert.deepEqual(payload.mcodeSessions, sessions);
  });

  test("reads from cache when available (no fire-and-forget fetch)", () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/cached-ws";
    clients.set(cid, cs);
    const cap = capture(cid);
    cachedByWs.set("/cached-ws", [{ id: "cached-1" }]);
    pushStateFor(cid);
    const payload = lastSnapshot(cap.box);
    assert.deepEqual(payload.mcodeSessions, [{ id: "cached-1" }]);
    // No fetch should have been triggered
    assert.equal(acpFetchCalls.length, 0);
  });

  test("falls back to [] + fire-and-forget fetch on cache miss", () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/uncached-ws";
    clients.set(cid, cs);
    const cap = capture(cid);
    pushStateFor(cid);
    // 断言第一条（同步）快照：cache miss → 空占位立即发布。异步的
    // authoritative 推送走 microtask，不会落在这个同步断言里。
    const payload = snapshotAt(cap.box, 0);
    // Immediately sees [] (cache miss → empty placeholder)
    assert.deepEqual(payload.mcodeSessions, []);
  });
});

describe('pushStateFor "__broadcast__"', () => {
  test("publishes one snapshot to every subscribed cid", () => {
    clients.set("a", makeClientState());
    clients.set("b", makeClientState());
    const ca = capture("a");
    const cb = capture("b");
    pushStateFor("__broadcast__", { mcodeSessions: [{ id: "bcast" }] });
    assert.equal(snapshotsOf(ca.box).length, 1);
    assert.equal(snapshotsOf(cb.box).length, 1);
    assert.deepEqual(lastSnapshot(ca.box).mcodeSessions, [{ id: "bcast" }]);
    assert.deepEqual(lastSnapshot(cb.box).mcodeSessions, [{ id: "bcast" }]);
  });
});

// ============================================================
// 批次 D 扩展: 覆盖事件流订阅面（在线数）+ active child 管理
// ============================================================

describe("pushOnlineCount", () => {
  test("publishes online count to every subscribed stream client", () => {
    clients.set("a", makeClientState());
    clients.set("b", makeClientState());
    const ca = capture("a");
    const cb = capture("b");
    pushOnlineCount(false);
    assert.equal(snapshotsOf(ca.box).length, 1);
    assert.equal(snapshotsOf(cb.box).length, 1);
    // onlineCount 语义 = getSubscribedCids().length → 两个订阅 cid = 2
    const pa = lastSnapshot(ca.box);
    assert.equal(pa.onlineCount, 2);
  });

  test("does not throw when no stream clients are subscribed", () => {
    resetEventBusForTests();
    assert.doesNotThrow(() => pushOnlineCount(false));
  });
});

describe("active child management", () => {
  test("setActiveChild + getActiveChild + clearActiveChild", () => {
    const cid = "cid-active-1";
    assert.equal(getActiveChild(cid), null, "should be null initially");
    const fakeChild = { id: "child-1" };
    setActiveChild(cid, fakeChild);
    assert.strictEqual(getActiveChild(cid), fakeChild);
    clearActiveChild(cid);
    assert.equal(getActiveChild(cid), null);
  });

  test("clearActiveChild on unregistered cid is a no-op (no throw)", () => {
    assert.doesNotThrow(() => clearActiveChild("never-set-cid"));
  });

  test("setActiveChild overwrites previous child for same cid", () => {
    const cid = "cid-active-2";
    const c1 = { id: "c1" };
    const c2 = { id: "c2" };
    setActiveChild(cid, c1);
    setActiveChild(cid, c2);
    assert.strictEqual(getActiveChild(cid), c2, "should be overwritten");
    clearActiveChild(cid);
  });
});

describe("getCidsByMcodeSession", () => {
  test("empty sid returns []", () => {
    assert.deepEqual(getCidsByMcodeSession(""), []);
  });

  test("null sid returns []", () => {
    assert.deepEqual(getCidsByMcodeSession(null), []);
  });

  test("no matches returns []", () => {
    clients.clear();
    assert.deepEqual(getCidsByMcodeSession("mvs_nonexistent"), []);
  });

  test("matches one cid", () => {
    clients.clear();
    const cs = makeClientState();
    cs.mcodeSessionId = "mvs_match_one_aaaa0000000000000000";
    clients.set("cid-match-1", cs);
    const out = getCidsByMcodeSession("mvs_match_one_aaaa0000000000000000");
    assert.equal(out.length, 1);
    assert.equal(out[0].cid, "cid-match-1");
  });

  test("matches multiple cids (same mcode session open in multiple tabs)", () => {
    clients.clear();
    const cs1 = makeClientState();
    cs1.mcodeSessionId = "mvs_shared_bbbb0000000000000000";
    const cs2 = makeClientState();
    cs2.mcodeSessionId = "mvs_shared_bbbb0000000000000000";
    clients.set("cid-tab-1", cs1);
    clients.set("cid-tab-2", cs2);
    const out = getCidsByMcodeSession("mvs_shared_bbbb0000000000000000");
    assert.equal(out.length, 2);
  });
});

describe("getClient + getCidFromReq", () => {
  test("getClient creates a fresh state for unknown cid", () => {
    const cid = "cid-fresh-1";
    const cs = getClient(cid);
    assert.ok(cs);
    assert.equal(cs.sessionId, null);
    assert.ok(cs.workspace);
  });

  test("getClient returns same state for same cid (singleton per cid)", () => {
    const cid = "cid-fresh-2";
    const a = getClient(cid);
    const b = getClient(cid);
    assert.strictEqual(a, b);
  });

  test("getClient with empty cid returns 'default' client", () => {
    const a = getClient("");
    assert.ok(a);
  });

  test("getCidFromReq parses cid from query string", () => {
    const req = { url: "/api/state?cid=my-cid-123" };
    assert.equal(getCidFromReq(req), "my-cid-123");
  });

  test("getCidFromReq returns '' when no cid param", () => {
    const req = { url: "/api/state" };
    assert.equal(getCidFromReq(req), "");
  });

  test("getCidFromReq returns '' on malformed URL", () => {
    const req = { url: "not-a-valid-url" };
    // URL constructor will throw on bad input → caught → return ""
    assert.equal(getCidFromReq(req), "");
  });
});

// ============================================================
// v1.0 推送字段回归 — 侧栏闪跌三连修:
//   1) pushOnlineCount / 首推曾不带 mcodeSessions → 客户端 undefined 闪跌
//   2) 缓存过期时曾推空占位 → 闪跌后弹回
//   3) 统一走 mcodeSessionsSnapshotFields, 过期推旧值 (pending=true)
// ============================================================
describe("v1.0 push fields — mcodeSessions 永不缺失、永不空占位", () => {
  test("pushOnlineCount 的推送必须带 mcodeSessions 字段 (fresh cache)", () => {
    cachedByWs.set("/w", [{ id: "s1" }]);
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    const cap = capture(cid);
    pushOnlineCount(true);
    const payload = lastSnapshot(cap.box);
    assert.ok(Array.isArray(payload.mcodeSessions),
      "回归: pushOnlineCount 曾不带该字段, 客户端整包替换后 undefined → 侧栏闪跌");
    assert.equal(payload.mcodeSessions.length, 1);
    assert.equal(payload.mcodeSessionsPending, false);
  });

  test("pushOnlineCount 缓存过期时推过期列表, 不推空占位", () => {
    // fresh miss (cachedByWs 空) + stale hit → 旧值 + pending
    registerAcpMock({ getMcodeSessionsStaleSync: () => [{ id: "stale-1" }, { id: "stale-2" }] });
    const cid = "cid-2";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    const cap = capture(cid);
    pushOnlineCount(true);
    const payload = lastSnapshot(cap.box);
    assert.ok(Array.isArray(payload.mcodeSessions));
    assert.equal(payload.mcodeSessions.length, 2, "过期值好过空值 — 不允许闪跌到空列表");
    assert.equal(payload.mcodeSessionsPending, true);
  });

  test("mcodeSessionsSnapshotFields: fresh / stale / 全miss 三态", () => {
    // fresh
    cachedByWs.set("/w", [{ id: "f" }]);
    assert.deepEqual(mcodeSessionsSnapshotFields("/w"),
      { mcodeSessions: [{ id: "f" }], mcodeSessionsPending: false });
    // stale (fresh miss, stale hit)
    cachedByWs.delete("/w");
    registerAcpMock({ getMcodeSessionsStaleSync: () => [{ id: "s" }] });
    assert.deepEqual(mcodeSessionsSnapshotFields("/w"),
      { mcodeSessions: [{ id: "s" }], mcodeSessionsPending: true });
    // 全 miss → 空占位 + 触发后台拉取
    registerAcpMock({ getMcodeSessionsStaleSync: () => null });
    acpFetchCalls.length = 0;
    const fields = mcodeSessionsSnapshotFields("/other-ws");
    assert.deepEqual(fields, { mcodeSessions: [], mcodeSessionsPending: true });
    assert.ok(acpFetchCalls.includes("/other-ws"), "miss 时必须 fire-and-forget 拉取");
  });

  test("pushStateFor (单播) 在 stale 缓存下带 pending 标记且列表非空", () => {
    registerAcpMock({ getMcodeSessionsStaleSync: () => [{ id: "stale-x" }] });
    const cid = "cid-3";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    const cap = capture(cid);
    pushStateFor(cid);
    const payload = lastSnapshot(cap.box);
    assert.ok(Array.isArray(payload.mcodeSessions));
    assert.equal(payload.mcodeSessions.length, 1);
    assert.equal(payload.mcodeSessionsPending, true);
  });
});
