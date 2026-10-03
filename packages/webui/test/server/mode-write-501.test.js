// webui/test/server/mode-write-501.test.js
//
// M3-B9 — the USER-VISIBLE half of the batch, asserted over HTTP.
//
// The engine-layer suite (test/lib/engine/mode-writes.test.js) proves
// the gate throws and what body the router will build from it. This file
// proves the thing a client actually receives, on the real Hono app and
// the real provider registry:
//
//   runtime transport — the behaviour change
//     POST /api/protocol/set-mode                     → 501 structured
//     POST /api/protocol/set-config-option (generic)  → 501 structured
//     POST /api/protocol/set-config-option (bridged)  → 200, unchanged
//
//   acp transport — no behaviour change at all
//     both endpoints, every config id                  → 200, unchanged
//
// Both halves run from ONE file under both gate invocations
// (`pnpm test:webui` and `MCODE_WEBUI_TRANSPORT=acp pnpm test:webui`),
// because the transport is a MODULE-INIT-TIME read in `lib/config.js`:
// a second file per transport would need its own process, and the point
// of this batch is that the two transports now differ.
//
// The RPC wrapper is mocked so no `mcode acp` subprocess is spawned, and
// its call log is the second assertion in every "unchanged" case: a 200
// is only the old behaviour if the engine was still reached.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { absPath } from "../helpers/_setup.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

// Pinned BEFORE anything reads the config. `lib/config.js` evaluates the
// env at module-init time, so a later assignment is a no-op.
const TRANSPORT = process.env.MCODE_WEBUI_TRANSPORT || "acp";
const tmpBase = mkTmpDir("mcode-webui-b9-mode-write-");
process.env.MINIMAX_DATA_DIR = tmpBase;
process.env.MCODE_WEBUI_DATA_DIR = tmpBase;
process.env.MCODE_WEBUI_SETTINGS_PATH = `${tmpBase}/settings.json`;
process.env.MCODE_WEBUI_EVENTS_PATH = `${tmpBase}/events.jsonl`;
process.env.MCODE_WEBUI_SESSIONS_DB = `${tmpBase}/sessions.db`;
process.env.MCODE_WEBUI_UPLOAD_DIR = `${tmpBase}/uploads`;

const RUNTIME = TRANSPORT === "runtime";

/** Every RPC the two endpoints make, plus the log they append to. */
let rpcCalls;
let createHonoApp;

/**
 * A Node request stand-in the route handlers can actually read.
 *
 * Not optional detail: these are LEGACY-shaped handlers, so they consume
 * `c.env.incoming` as a stream through `lib/read-json.js` and never look
 * at the Hono request. A plain `{method, url}` object gets past the gate
 * chain and then fails `readJson` with "req is not async iterable" —
 * which surfaces as a 500 and reads like a server bug rather than a
 * broken fixture.
 */
function incoming(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}), "utf8")]);
  req.method = "POST";
  req.url = url;
  req.headers = { "content-type": "application/json" };
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

async function post(path, body) {
  const app = createHonoApp();
  const res = await app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) },
    { incoming: incoming(path, body) },
  );
  const text = await res.text();
  // A non-JSON body here would be a fixture failure, not a contract
  // failure, and must not be reported as one.
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async (t) => {
  // The mock is the REAL namespace with two functions replaced, not a
  // hand-written one: `lib/mcode-rpc.js` is imported by half the server
  // (usage.js, model.js, session-reads.js, protocol.js) and a partial
  // mock namespace turns each of those into a SyntaxError at import time
  // — a failure that reads as "app.js cannot boot" rather than as "the
  // test's mock was incomplete". The real module is safe to import here:
  // it reaches `acp-client.js` through a lazy import and spawns no
  // subprocess until a call is made.
  const realRpc = await import(absPath("lib/mcode-rpc.js"));
  t.mock.module(absPath("lib/mcode-rpc.js"), {
    namedExports: {
      ...realRpc,
      setMode: async (sessionId, modeId) => {
        rpcCalls.push({ fn: "setMode", sessionId, modeId });
        return { ok: true, data: { modeId } };
      },
      setConfigOption: async (sessionId, configId, value, cid) => {
        rpcCalls.push({ fn: "setConfigOption", sessionId, configId, value, cid });
        return { ok: true, data: { applied: true } };
      },
    },
  });
  const appModule = await import(absPath("app.js"));
  createHonoApp = appModule.createHonoApp;
});

beforeEach(() => {
  rpcCalls = [];
});

after(() => {
  rmTmpDir(tmpBase);
});

const SID = "mvs_b9_b9_b9_b9_b9_b9_b9_b9_b9";

describe(`M3-B9 · the mode-write endpoints on the ${TRANSPORT} transport`, () => {
  // -------------------------------------------------------------------------
  // The OLD STATE. On acp nothing changes, and on runtime the two bridged
  // config ids do not change. Pinned as whole bodies, because "the control
  // still works" is a claim about the response a browser parses.
  // -------------------------------------------------------------------------
  test("set-mode answers the pre-B9 200 body — on acp only", async () => {
    // #67 is the endpoint this batch actually cuts, so "unchanged" is
    // only true where no provider is registered. On the runtime
    // transport the same request is the 501 below; asserting 200 there
    // would assert the regression this batch exists to make.
    const r = await post("/api/protocol/set-mode", { sessionId: SID, mode: "plan" });
    if (RUNTIME) {
      assert.equal(r.status, 501);
      return;
    }
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, mode: "plan", data: { modeId: "plan" } });
    assert.deepEqual(rpcCalls, [{ fn: "setMode", sessionId: SID, modeId: "plan" }]);
  });

  test("set-mode still answers 400 for a missing sessionId or mode, before anything else", async () => {
    // The 400s are the route's and run before the gate: a caller mistake
    // must never be reported as an engine limitation.
    assert.equal((await post("/api/protocol/set-mode", { mode: "plan" })).status, 400);
    assert.equal((await post("/api/protocol/set-mode", { sessionId: SID })).status, 400);
    assert.deepEqual(rpcCalls, [], "a 400 must not reach the engine");
  });

  test("set-config-option answers the pre-B9 200 body for `permissionMode`", async () => {
    const r = await post("/api/protocol/set-config-option", {
      sessionId: SID,
      key: "permissionMode",
      value: "auto",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      ok: true,
      key: "permissionMode",
      value: "auto",
      data: { applied: true },
    });
    if (RUNTIME) {
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].configId, "permissionMode");
    }
  });

  test("set-config-option answers the pre-B9 200 body for `model`", async () => {
    const r = await post("/api/protocol/set-config-option", {
      sessionId: SID,
      key: "model",
      value: "gpt-x",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    if (RUNTIME) assert.equal(rpcCalls[0].configId, "model");
  });

  test("set-config-option still answers 400 for a missing sessionId or key", async () => {
    assert.equal(
      (await post("/api/protocol/set-config-option", { key: "model", value: "x" })).status,
      400,
    );
    assert.equal(
      (await post("/api/protocol/set-config-option", { sessionId: SID, value: "x" })).status,
      400,
    );
    assert.deepEqual(rpcCalls, []);
  });

  // -------------------------------------------------------------------------
  // The NEW STATE. Only reachable where a provider declares the capability
  // absent, which today means the runtime transport.
  // -------------------------------------------------------------------------
  test(RUNTIME ? "set-mode answers 501 with the structured capability body" : "set-mode is untouched on acp", async () => {
    const r = await post("/api/protocol/set-mode", { sessionId: SID, mode: "plan" });
    if (!RUNTIME) {
      assert.equal(r.status, 200, "acp has no registered provider, so acp must not change");
      assert.deepEqual(rpcCalls.length, 1, "and the engine is still reached");
      return;
    }
    assert.equal(r.status, 501);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, "engine_capability_not_supported");
    assert.equal(r.body.capability, "toolSkillInvocation");
    assert.equal(r.body.provider, "local-runtime-v2");
    assert.deepEqual(r.body.missing, ["setMode"]);
    // The pre-existing degraded-action hint is NOT on this body: there is
    // no way to enter plan mode here to fall back FROM.
    assert.equal("fallback" in r.body, false);
    assert.deepEqual(rpcCalls, [], "a refused write must never reach the engine");
  });

  test(
    RUNTIME
      ? "a generic config id answers 501 with the structured capability body"
      : "a generic config id is untouched on acp",
    async () => {
      const r = await post("/api/protocol/set-config-option", {
        sessionId: SID,
        key: "thinkingEffort",
        value: "high",
      });
      if (!RUNTIME) {
        assert.equal(r.status, 200);
        assert.equal(r.body.key, "thinkingEffort");
        assert.equal(rpcCalls.length, 1);
        return;
      }
      assert.equal(r.status, 501);
      assert.equal(r.body.code, "engine_capability_not_supported");
      assert.equal(r.body.capability, "authCredentials");
      assert.deepEqual(r.body.missing, ["setConfigOption"]);
      assert.equal("fallback" in r.body, false);
      assert.deepEqual(rpcCalls, [], "a refused write must never reach the engine");
    },
  );

  // -------------------------------------------------------------------------
  // The boundary itself: same route, same body, two config ids, two
  // outcomes. Without this the two cases above could each be passing for
  // the wrong reason (a broken route, a broken mock).
  // -------------------------------------------------------------------------
  test("one request, two config ids, two answers — the bridge is the difference", async () => {
    const bridged = await post("/api/protocol/set-config-option", {
      sessionId: SID,
      key: "permissionMode",
      value: "auto",
    });
    const generic = await post("/api/protocol/set-config-option", {
      sessionId: SID,
      key: "thinkingEffort",
      value: "high",
    });
    assert.equal(bridged.body.key, "permissionMode");
    assert.equal(generic.body.key === "permissionMode", false);
    if (RUNTIME) {
      assert.equal(bridged.status, 200);
      assert.equal(generic.status, 501);
      // Exactly one engine call: the bridged one.
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].configId, "permissionMode");
    } else {
      assert.equal(bridged.status, 200);
      assert.equal(generic.status, 200);
      assert.equal(rpcCalls.length, 2);
    }
  });
});
