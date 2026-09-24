// webui/test/routes/handleStop-dispatch.test.js
// Dispatch test for /api/stop → cancelSession. Asserts the new cid arg in
// chat.js#handleStop lands the session/cancel notification on the registered
// active child, not the (mocked) mcode-rpc default.
//
// Background: every webui prompt creates a fresh `McodeAcpClient` and registers
// it on `state-bus.activeChildByCid`. The cancel / set_config_option /
// model / permission requests must go to that subprocess, not the singleton
// (which holds a different session map). The previous PR did not pass cid to
// mcode-rpc, so the wrapper fell back to the singleton — the engine answered
// "session not found" and the route silently returned `cancelled:false` (or
// worse, claimed `cancelled:true` while the prompt kept running).
//
// This file sets up a live-shaped child that records notify() calls, registers
// it as the cid's active child, and asserts that handleStop dispatches through
// the cid path.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import {
  setupMocks,
  absPath,
  registerRpcMock,
} from "../helpers/_setup.js";

let bus;
let clients;
let child;
let childLog;

before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
      getMcodeAcpClient: async () => null,
    },
  });
  bus = await import(absPath("lib/state-bus.js"));
  clients = (await import(absPath("lib/state-bus.js"))).clients;

  // Wire mcode-rpc's cancelSession to call the child we register below.
  // setupMocks already gave us a thin wrapper for mcode-rpc.js; we override
  // it here so the wrapper uses our live child (the wrapper is mutable by
  // design — see _rpcMock declaration in helpers/_setup.js).
  childLog = { notify: [] };
  child = {
    get alive() {
      return true;
    },
    notify(method, params) {
      childLog.notify.push({ method, params });
    },
    request(method, params) {
      childLog.notify.push({ method, params });
      return Promise.resolve({ ok: true });
    },
  };
});

/** Minimal fake cs. */
function makeCs(overrides = {}) {
  return {
    workspace: { dir: "/ws-X", branch: null, tree: null },
    mcodeSessionId: "mvs_test_dispatch",
    running: null,
    ...overrides,
  };
}

function fakeReq() {
  return {
    method: "POST",
    url: "/api/stop",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    body: "{}",
  };
}

function fakeRes() {
  const state = { _status: 200, _body: "" };
  return {
    get statusCode() {
      return state._status;
    },
    setHeader() {},
    writeHead(s) {
      state._status = s;
      return this;
    },
    async text() {
      return state._body;
    },
    async json() {
      return JSON.parse(state._body || "{}");
    },
    end(b) {
      state._body = b != null ? b : state._body;
      return this;
    },
    get writableEnded() {
      return true;
    },
  };
}

describe("/api/stop dispatches session/cancel to the cid's active child", () => {
  test("handleStop routes session/cancel through the active child, not the singleton", async () => {
    // Sentinel: if the singleton path is touched, the wrapper returns
    // singleton_touched and handleStop records cancelled=false.
    let singletonCalls = 0;
    registerRpcMock({
      cancelSession: async (sessionId, cid) => {
        singletonCalls++;
        // If cid is passed through correctly, the wrapper is supposed to
        // consult the active child first. Simulate the fix by dispatching
        // directly to the registered child when cid is provided.
        if (cid) {
          const active = bus.getActiveChild(cid);
          if (active && active.alive) {
            active.notify("session/cancel", { sessionId });
            return { ok: true, data: { notified: true } };
          }
        }
        return { ok: false, code: "singleton_touched", error: "wrong subprocess" };
      },
    });

    const cid = "cid-dispatch";
    const cs = makeCs();
    clients.set(cid, cs);
    bus.setActiveChild(cid, child);

    const { handleStop } = await import(absPath("routes/chat.js"));
    const res = fakeRes();
    await handleStop(fakeReq(), res, { cs, cid });
    const parsed = await res.json();
    assert.equal(parsed.ok, true);
    assert.equal(
      parsed.cancelled,
      true,
      "session/cancel must reach the active child (cid was not passed before this PR)",
    );
    assert.equal(
      singletonCalls,
      1,
      "the wrapper is dispatched exactly once — via the cid path",
    );
    assert.equal(childLog.notify.length, 1);
    assert.equal(childLog.notify[0].method, "session/cancel");
    assert.deepEqual(childLog.notify[0].params, { sessionId: cs.mcodeSessionId });
    bus.clearActiveChild(cid);
  });

  test("handleStop without an active child falls back to the singleton", async () => {
    let singletonCalls = 0;
    let receivedSessionId = null;
    let receivedCid = null;
    registerRpcMock({
      cancelSession: async (sessionId, cid) => {
        singletonCalls++;
        receivedSessionId = sessionId;
        receivedCid = cid;
        return { ok: true, data: { notified: true } };
      },
    });

    const cid = "cid-nochild";
    const cs = makeCs();
    clients.set(cid, cs);

    const { handleStop } = await import(absPath("routes/chat.js"));
    const res = fakeRes();
    await handleStop(fakeReq(), res, { cs, cid });
    const parsed = await res.json();
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cancelled, true);
    assert.equal(singletonCalls, 1);
    assert.equal(receivedSessionId, cs.mcodeSessionId);
    assert.equal(receivedCid, cid, "the cid must be passed to the wrapper for the singleton path");
  });
});