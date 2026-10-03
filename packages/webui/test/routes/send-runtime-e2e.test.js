// webui/test/routes/send-runtime-e2e.test.js
//
// M3-B8b: the ONE test that drives the whole runtime send chain —
// `routes/chat.js#handleSend` → the REAL `runMcodeRuntime` → the state
// bus → the route's finalize drain → the draft promotion.
//
// WHY THIS IS A SEPARATE FILE. Every other B8b case mocks
// `lib/mcode-acp.js` and drives the runner directly. This one needs
// the real runner, which means its real static imports resolve BEFORE
// the test's mocks exist — mock trap #2, in its purest form. Getting
// that boot order right is incompatible with `setupMocks`, which
// always claims `lib/acp-client.js`, so this file registers its own
// namespaces (mocks first, real runner, then the route).
//
// It also has to be its own FILE. node's runner reuses a process
// across files, and in a shared process this case's module-state
// ordering interacts with the facade suite's and the turn never
// settles: 147 tests pass, the loop drains, and node then aborts the
// WHOLE FILE with "Promise resolution is still pending but the event
// loop has already resolved". A one-file scope is the fix that does
// not depend on load order.
//
// The fixtures the case needs are spelled out here rather than
// imported, so a reader never has to go looking for which shared
// helper happened to be in scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { absPath } from "../helpers/_setup.js";

const RUNTIME = "runtime";
const SID = "mvs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Fresh-cache counter for the route re-import. See the file header. */
let bust = 0;

/** A JSON request body the real `lib/read-json.js` can consume. */
function jsonReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}

/** A minimal `ServerResponse` stand-in that records what was written. */
function mkRes() {
  const written = [];
  return {
    written,
    writeHead(status, headers) {
      written.push({ status, headers });
      return this;
    },
    end(body) {
      written.push({ body });
      return this;
    },
  };
}

function lastResponse(res) {
  const head = res.written[res.written.length - 2];
  const tail = res.written[res.written.length - 1];
  assert.ok(head && head.status !== undefined, "the handler never wrote a head");
  return { status: head.status, headers: head.headers, body: tail ? tail.body : undefined };
}

function mkCs(overrides = {}) {
  return {
    sessionId: "webui-1",
    mcodeSessionId: null,
    chat: [],
    context: { thinkingStatus: "Idle", tps: 0 },
    usage: { sessionInput: 0, sessionOutput: 0, sessionTotal: 0 },
    model: { name: "minimax_api/MiniMax-M3" },
    workspace: { dir: "/tmp/b8-e2e" },
    running: { active: false, prompt: null, pid: null, sessionId: null, tps: 0 },
    ...overrides,
  };
}

/**
 * A fake runtime event stream. Yields the given events in order and
 * then completes.
 */
function mkStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    close() {},
  };
}

const EV = {
  deltaText: (text) => ({ type: "delta", messageId: "m1", role: "assistant", content: text }),
  settled: (message) => ({ type: "message", message: { id: "m1", role: "assistant", ...message } }),
  done: { type: "done", turnId: "t1" },
};

test("RED LINE 3, END TO END: route → real runner → drain → promotion", async (t) => {
  // The promotion is the ROUTE's and the drain is the ROUTE's, but
  // their INPUT comes from the runner — so the only honest way to
  // prove the red line on the runtime transport is to drive the whole
  // chain with the REAL `runMcodeRuntime`. A test that mocked the
  // runner would be asserting that a mock's return value reaches a
  // mock's promotion: true of a fake, worth nothing.
  //
  // ORDER IS LOAD-BEARING, twice over. The `openEngineSendStream` mock must be
  // registered BEFORE `lib/mcode-acp.js` is imported, because
  // `mock.module` does not reach a consumer that is already in the
  // registry (trap #2) — importing the runner first would bind it to
  // the real function, which would then try to boot a real host and
  // fail the turn. The facade's pure exports are read from a plain
  // import first so the mock namespace is whole (trap #1).
  const facade = await import(absPath("engine/streaming-send.js"));
  t.mock.module(absPath("engine/streaming-send.js"), {
    namedExports: {
      ...facade,
      openEngineSendStream: async () => ({
        ok: true,
        sessionId: SID,
        stream: mkStream([
          EV.deltaText("the answer"),
          EV.settled({ content: "the answer", finishReason: "stop", id: "msg-1" }),
          EV.done,
        ]),
        turnHost: { close() {} },
      }),
    },
  });
  // BOOT ORDER IS THE WHOLE PROBLEM, and it is mock trap #2 in its
  // purest form. This case needs the REAL runner, so the real
  // `lib/mcode-acp.js` has to be imported — and if that happens
  // before `setupMocks` registers the `lib/acp-client.js` mock, the
  // real module keeps the REAL binding, and its finalize's
  // `getMcodeSessionTitle` spawns a real `mcode acp` subprocess that
  // outlives the test and hangs the whole file. It did: one leaked
  // child turned 90 passing cases into a 280 s timeout.
  //
  // So this case does NOT use `setupMocks`. It registers the same
  // namespaces itself, in the one order that works: the mocks first,
  // then the real runner, then the route. `mock.module` re-registration
  // is ERR_INVALID_STATE, so there is no way to have both — which is
  // exactly why the helper exists rather than a flag on setupMocks.
  const acpNs = await import(absPath("lib/acp-client.js"));
  const sessionsNs = await import(absPath("lib/sessions.js"));
  t.mock.module(absPath("lib/acp-client.js"), {
    namedExports: {
      // The whole namespace FIRST, filled with throwers so an
      // unexpected call is loud — and then the real stubs override
      // them. The order is load-bearing, and getting it backwards was
      // the bug that made this case fail on its first run: with the
      // spread last, every thrower wins and every genuine call
      // reports "not stubbed".
      ...Object.fromEntries(
        Object.keys(acpNs).map((k) => [k, () => {
          throw new Error(`B8 test reached acp-client.js#${k}, which it did not stub`);
        }]),
      ),
      getMcodeSessionTitle: async () => null,
      invalidateMcodeSessionsCache: () => {},
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => null,
      getCachedMcodeCommands: () => [],
      getCatalogueHost: async () => null,
      listAllMcodeSessions: async () => [],
      getMcodeAcpClient: async () => null,
      getMcodeServerInfo: () => null,
      ensureMcodeCommands: async () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
      getMcodeSessionsStaleSync: () => null,
      deleteMcodeSessionFromDb: () => ({ ok: true }),
      shutdownMcodeAcpSingleton: () => {},
      dropMcodeSessionFromCache: () => {},
    },
  });
  t.mock.module(absPath("lib/sessions.js"), {
    namedExports: Object.fromEntries(
      Object.keys(sessionsNs).map((k) => [k, (...a) => sessionsNs[k](...a)]),
    ),
  });
  t.mock.module(absPath("lib/mavis-usage.js"), {
    namedExports: {
      getMavisTokenUsage: async () => null,
      getMavisTokenUsageModel: async () => null,
      applyMavisUsageToCs: async () => ({ applied: false }),
    },
  });
  t.mock.module(absPath("lib/mcode-rpc.js"), {
    namedExports: {
      cancelSession: async () => ({ ok: true, data: {} }),
      mcodePermissionToWebui: () => "Full access",
      webuiPermissionToMcode: () => "bypassPermissions",
    },
  });
  t.mock.module(absPath("lib/models.js"), {
    namedExports: { getMcodeModelLimit: async () => ({ context: 512000 }) },
  });
  t.mock.module(absPath("lib/mcode-exec.js"), {
    namedExports: { runMcodeExec: async () => ({ status: "succeeded", answer: "x" }), collectExecResult: async (p) => p },
  });
  t.mock.module(absPath("lib/slash.js"), {
    namedExports: {
      handleLocalSlash: async () => ({ handled: false, continueMcode: false }),
      handleCmdCommand: async () => ({ handled: true, continueMcode: false }),
    },
  });
  const realAcp = await import(absPath("lib/mcode-acp.js"));
  const config = await import(absPath("lib/config.js"));
  t.mock.module(absPath("lib/config.js"), {
    namedExports: { ...config, MCODE_WEBUI_TRANSPORT: RUNTIME },
  });
  const route = await import(`${absPath("routes/chat.js")}?bust=${bust++}`);
  const cs = mkCs({ sessionId: null });
  const res = mkRes();
  await route.handleSend(jsonReq({ content: "hello" }), res, { cs, cid: "b8-e2e" });
  assert.equal(lastResponse(res).status, 200);

  // 1. The runner bound the engine sid onto the turn's draft.
  assert.equal(cs.mcodeSessionId, SID);
  // 2. ONE identity, not a uuid orphan beside an engine entry — the
  //    double-sidebar the qa note records. Asserted on `cs` rather
  //    than on a store dump: this file deliberately uses the REAL
  //    session store (it needs the real runner, and mocking the store
  //    would mean a second mock namespace for the same case), so the
  //    shared in-memory `getSessionsStore()` helper is empty here and
  //    reading it would assert nothing. `cs.sessionId === cs.mcodeSessionId`
  //    is the post-promotion state the single-identity rule produces,
  //    and it is the same fact the store would show.
  assert.equal(
    cs.sessionId,
    SID,
    "the draft record was not promoted to the engine sid — two records would exist for one conversation",
  );
  // 3. The drained lines reached the live view with the `●` rewrite
  //    applied, and the user message the route persisted up front.
  assert.ok(cs.chat.some((l) => l === "› hello"), JSON.stringify(cs.chat));
  assert.ok(cs.chat.some((l) => l === "● the answer"), JSON.stringify(cs.chat));
  assert.equal(
    cs.context.assistantLast,
    "the answer",
    "the route's success tail reads the same accumulator on both transports",
  );
});
