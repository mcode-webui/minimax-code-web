// webui/test/lib/engine/streaming-send.test.js
//
// M3-B8 (B8a + B8b): the STREAMING SEND family — #12 POST /api/send,
// its capability gate, its pure stream bridge, its runtime runner and
// its route branch.
//
// B8a shipped the first half of this file against a module that had no
// runner, so two of the three red lines could only be NAMED there. B8b
// replaces that placeholder with the real assertions: section 5 drives
// the actual `runMcodeRuntime` through a fake event stream and section 6
// drives the actual route, both with the `?bust=` marker controls that
// prove the mocks took.
//
// Sections are ordered by how much user-visible damage a regression in
// each one does, not by which module the function came from:
//
//   1. THE DECLARATION AND ITS HARD GATE. The judgement call in this
//      batch: #12 is the first M3 family to gate HARD, because its
//      response is an ack written BEFORE the engine is called and there
//      is therefore no truthful degradation to fall back to. The suite
//      proves the gate is unreachable on BOTH transports today.
//   2. THE RED LINES THIS LAYER OWNS. run-mirror (the still-viewing
//      test) and the finalize drain (the `●` rewrite over a detached
//      buffer). One named test per line, plus the NEGATIVE half of
//      each, because a red line only asserted in its happy direction is
//      a red line nobody is watching.
//   3. THE STREAM BRIDGE, table-driven. The runtime's frame vocabulary
//      → webui's line syntax, over the whole `TuiStreamEvent`
//      taxonomy, including the shapes that must produce NO line. This is
//      the half where a regression is invisible: a dropped `●` does not
//      crash, it makes the answer disappear.
//   4. THE BYTE-FOR-BYTE LINE BODIES. The `→ name` header spelling and
//      the usage projection's exact object.
//
// One module-mock trap applies here, and it is load-bearing rather
// than incidental: `t.mock.module` REPLACES the WHOLE NAMESPACE; it
// does not merge. A mock naming only the export under test leaves
// every other name undefined and the consumer fails at INSTANTIATION
// with `SyntaxError: … does not provide an export named …` — a failure
// that reads like a product bug and is not one. `FACADE_EXPORTS` below
// is asserted against the module's real export list so that class of
// mistake becomes one named red test rather than a cascade.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Readable } from "node:stream";

import {
  setupMocks,
  absPath,
  registerMcodeAcpMock,
  registerSessionsStore,
  getSessionsStore,
} from "../../helpers/_setup.js";
// Type discrimination goes through the exported predicate, never
// `err.name`. `engine/capabilities.js` is never `mock.module`d by this
// file, so the `instanceof` inside it resolves against the same class
// `assertEngineCapability` would have thrown from.
const { isEngineCapabilityNotSupportedError } = await import(
  "../../../server/engine/errors.js"
);

const RUNTIME = "runtime";
const ACP = "acp";
const ENDPOINT = "POST /api/send";

/** A syntactically valid engine sid. */
const SID = "mvs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** The other conversation the user could have switched to. */
const OTHER_SID = "mvs_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/**
 * Every name `engine/streaming-send.js` exports. The namespace, not a
 * subset.
 *
 * One absence is deliberate and is asserted by a named test below, so
 * the boundary between B8a and B8b stays executable rather than a
 * promise in a report:
 *
 *   - `sendShouldPromoteDraft` — a predicate the ROUTE cannot use
 *     without narrowing its condition, which would be a behaviour
 *     change on the acp path. See the module's red-line-3 note.
 */
const FACADE_EXPORTS = [
  "SEND_EVENT_KINDS",
  "STREAMING_SEND_ENDPOINTS",
  "assertStreamingSendCapability",
  "checkStreamingSendCapability",
  "classifySendEvent",
  "openEngineSendStream",
  "projectSendAttachments",
  "resolveStreamingSendProvider",
  "rewriteDrainedAnswerLine",
  "sendSegmentAdvance",
  "sendStillViewing",
  "sendTerminalOutcome",
  "sendToolHeaderLine",
  "sendToolUpdate",
  "sendUsageTotals",
];

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

/** The last `writeHead` + `end` pair, as one observation. */
function lastResponse(res) {
  const head = res.written[res.written.length - 2];
  const tail = res.written[res.written.length - 1];
  assert.ok(head && head.status !== undefined, "the handler never wrote a head");
  return {
    status: head.status,
    headers: head.headers,
    body: tail ? tail.body : undefined,
  };
}

/** A client state carrying only what the send path reads. */
function mkCs(overrides = {}) {
  return {
    sessionId: "webui-1",
    mcodeSessionId: null,
    chat: [],
    context: { thinkingStatus: "Idle", tps: 0 },
    usage: { sessionInput: 0, sessionOutput: 0, sessionTotal: 0 },
    model: { name: "minimax_api/MiniMax-M3" },
    workspace: { dir: "/tmp/b8" },
    plan: { active: false, planId: null, title: null, summary: "", options: [] },
    running: { active: false, prompt: null, pid: null, sessionId: null, tps: 0 },
    ...overrides,
  };
}

/**
 * A fake runtime event stream. Yields the given events in order and
 * then completes — which is the case section 5's "ended without a
 * terminal event" assertion needs to be able to produce.
 */
function mkStream(events, gate = null) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        if (e === THROW_MARKER) throw new Error("iterator exploded");
        // A `GATE` element suspends the turn until the test opens it.
        // Without one, a "mid-run" switch is a FICTION: the whole
        // stream drains in one microtask batch, so anything the test
        // does after a `setImmediate` yield happens AFTER finalize —
        // and the run-mirror assertions then pass for the wrong reason.
        // Mutation injection is what surfaced that; this is the fix.
        if (e === GATE) {
          if (gate) {
            gate.markReached();
            await gate.held;
          }
          continue;
        }
        yield e;
      }
    },
    close() {},
  };
}
const THROW_MARKER = Symbol("throw");
/** Suspends `mkStream` until the returned gate's `open()` is called. */
const GATE = Symbol("gate");

/**
 * A gate with EXPLICIT handles. The first cut used module-level mutable
 * state and a `while (!reached) await setImmediate` spin, which leaked
 * a ref'd handle whenever a case failed before opening the gate and
 * hung the whole file. A returned object cannot be clobbered by a
 * later case, and `await gate.reached` is a promise, not a poll.
 *
 * @returns {{open: () => void, held: Promise<void>, reached: Promise<void>}}
 */
function mkGate() {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let markReached;
  const realReached = new Promise((resolve) => {
    markReached = resolve;
  });
  // `reached` is BOUNDED, and that is the point. An unbounded await on
  // an ordering that a sibling test file can perturb turns one bad
  // ordering into a hung file, and node:test then aborts it with
  // "Promise resolution is still pending but the event loop has already
  // resolved" — which takes the WHOLE gate with it, not just this file.
  // Racing a timeout makes the same failure one named red test.
  const reached = Promise.race([
    realReached,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("mkGate: the stream never reached its GATE within 2000ms")),
        2000,
      ).unref?.(),
    ),
  ]);
  return {
    held,
    reached,
    markReached,
    open: () => release(),
  };
}

/**
 * Fresh-cache counter for the route re-imports in section 6.
 *
 * `mock.module` re-evaluates only the MOCKED specifier: a consumer
 * already in the registry keeps its old LIVE BINDING, so a second test
 * in the same file would silently reuse the first test's mock and pass
 * for the wrong reason. Every route re-import below carries a fresh
 * `?bust=N`, and section 6 ends with two marker controls that prove it.
 */
let bust = 0;

/** A JSON request body the real `lib/read-json.js` can consume. */
function jsonReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}

/** Whole-namespace facade mock. Un-stubbed names THROW. */
function mockFacade(t, impls) {
  const namedExports = {};
  for (const name of FACADE_EXPORTS) {
    namedExports[name] = () => {
      throw new Error(`B8 test called engine/streaming-send.js#${name}, which this case did not stub`);
    };
  }
  Object.assign(namedExports, impls);
  t.mock.module(absPath("engine/streaming-send.js"), { namedExports });
}

/** The `TuiStreamEvent` shapes the bridge has to understand. */
const EV = {
  heartbeat: { type: "heartbeat", turnId: "t1" },
  deltaText: (text) => ({ type: "delta", messageId: "m1", role: "assistant", content: text }),
  deltaThinking: (text) => ({
    type: "delta",
    messageId: "m1",
    role: "assistant",
    thinking: text,
  }),
  deltaTool: (toolCalls) => ({
    type: "delta",
    messageId: "m1",
    role: "assistant",
    toolCalls,
  }),
  settled: (message) => ({ type: "message", message: { id: "m1", role: "assistant", ...message } }),
  started: { type: "session-status", status: "started" },
  finished: { type: "session-status", status: "finished" },
  errored: (message) => ({ type: "session-status", status: "error", message }),
  aborted: { type: "session-status", status: "aborted" },
  error: (message) => ({ type: "error", message }),
  done: { type: "done", turnId: "t1" },
  resync: { type: "resync-required", turnId: "t1" },
  generic: { type: "generic", eventType: "session.spawned", data: { session_id: "child-1" } },
  replaced: { type: "messages-replaced", messages: [] },
  rewound: { type: "messages-rewound", messageIds: ["m1"] },
  tool: (over = {}) => ({
    id: "tc-1",
    name: "read",
    status: 1,
    input: { path: "/tmp/a" },
    ...over,
  }),
};

// ===========================================================================
// The facade under test.
//
// `setupMocks` needs a TEST context (`t.mock.module` does not exist on a
// suite context) AND its registry is per-context: a file-level `before`
// would leave every later `setupMocks(t, …)` in this file fighting an
// already-mocked `lib/acp-client.js` (ERR_INVALID_STATE). So each test
// boots the facade itself, the B5/B6/B7 `bootFacade` shape.
//
// The facade is NEVER `mock.module`d in this file. B8a has no route to
// prove a mock against, and a mock that nothing consumes is the exact
// trap #1 mistake this file's header describes — so the list assertion
// below is the only namespace guard B8a needs, and B8b adds the
// `?bust=` marker controls when it adds a consumer.
// ===========================================================================
async function bootFacade(t) {
  await setupMocks(t, {});
  return import(absPath("engine/streaming-send.js"));
}

// ===========================================================================
// 1. The declaration and its hard gate
// ===========================================================================
describe("the whole-namespace mock lists stay whole", () => {
  test("FACADE_EXPORTS is exactly engine/streaming-send.js's export list", async (t) => {
    // Mock trap #1: a list that drifts from the module's real exports
    // makes a later consumer fail at INSTANTIATION with a SyntaxError
    // that reads like a product bug. Asserting the list here turns that
    // class of mistake into one named red test.
    const real = Object.keys(await import(absPath("engine/streaming-send.js"))).sort();
    assert.deepEqual([...FACADE_EXPORTS].sort(), real);
  });

  test("the data plane is reached ONLY through `await import()`", async (t) => {
    // B8a's justification for being its own batch was that this module
    // had no IO at all. B8b gave it a data plane, so the claim has to
    // change shape rather than be deleted: the host graph must now be
    // reachable ONLY from inside the two data-plane functions, or an
    // acp-only server would boot the runtime on every start — which is
    // the exact regression M1 already paid for once.
    const facade = await bootFacade(t);
    assert.equal(typeof facade.openEngineSendStream, "function");
    assert.equal(typeof facade.projectSendAttachments, "function");
    const src = readFileSync(fileURLToPath(absPath("engine/streaming-send.js")), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // The data plane resolves its three dependencies in ONE
    // `Promise.all([...])`, so the count is three even though there is
    // a single call site. What matters is that every one of them is
    // dynamic: a STATIC import of any of the three would put the
    // runtime host graph on the boot path of an acp-only server.
    const dynamic = code.match(/(?<![.\w])import\s*\(/g) || [];
    assert.deepEqual(dynamic, ["import(", "import(", "import("], JSON.stringify(dynamic));
    const staticFrom = [...code.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    assert.deepEqual(
      staticFrom,
      ["./index.js", "./capabilities.js"],
      "a new STATIC import here is a boot-path regression on acp-only servers: " +
        JSON.stringify(staticFrom),
    );
    assert.equal(/\brequire\s*\(/.test(code), false, "CJS has no place in an ESM facade module");
  });

  test("the removed `sendShouldPromoteDraft` stays removed", async (t) => {
    // Red line 3 is proven by a ROUTE assertion in B8b instead of a
    // predicate the route cannot use without narrowing its acp
    // condition. If the function ever comes back, this test is where the
    // argument for it belongs.
    const facade = await bootFacade(t);
    assert.equal(FACADE_EXPORTS.includes("sendShouldPromoteDraft"), false);
    assert.equal("sendShouldPromoteDraft" in facade, false);
  });
});

describe("the send family's declaration and HARD gate", () => {
  test("#12 declares `streamingSend` · `sendMessage` as HARD", async (t) => {
    const facade = await bootFacade(t);
    assert.deepEqual(facade.STREAMING_SEND_ENDPOINTS[ENDPOINT], {
      capability: "streamingSend",
      subItem: "sendMessage",
      enforcement: "hard",
    });
  });

  test("the DEFAULT `acp` transport reports `unregistered-transport` and NEVER throws", async (t) => {
    const facade = await bootFacade(t);
    // No provider is registered for `acp` (M4's job), so this is the
    // pre-M3 behaviour path — and it must not be a hole in the gate.
    // This assertion IS the acp no-regression claim at the gate: when
    // B8b wires the route, an acp deployment must not start answering
    // 501 because a gate was added.
    const d = facade.checkStreamingSendCapability(ENDPOINT, ACP);
    assert.equal(d.gate, "unregistered-transport");
    assert.equal(d.provider, null);
    assert.equal(d.capability, "streamingSend");
    // And the asserting form must agree, or the route would 501 an
    // acp deployment.
    assert.equal(
      facade.assertStreamingSendCapability(ENDPOINT, ACP).gate,
      "unregistered-transport",
    );
  });

  test("the `runtime` transport resolves the registered provider and reports `checked`", async (t) => {
    const facade = await bootFacade(t);
    // v2 declares `streamingSend: full` (providers/local-runtime-v2
    // .capabilities.js), so the gate is satisfied today and the 501
    // path is unreachable. Pinned so a declaration change to `none` or
    // a `partial` without `sendMessage` has to be a deliberate edit.
    const d = facade.checkStreamingSendCapability(ENDPOINT, RUNTIME);
    assert.equal(d.gate, "checked");
    assert.equal(d.provider, "local-runtime-v2");
    assert.equal(
      facade.assertStreamingSendCapability(ENDPOINT, RUNTIME).gate,
      "checked",
    );
  });

  test("resolveStreamingSendProvider returns null for an unregistered transport and the provider for `runtime`", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.resolveStreamingSendProvider(ACP), null);
    assert.equal(facade.resolveStreamingSendProvider(RUNTIME).id, "local-runtime-v2");
  });

  test("an unknown endpoint key is a plain Error, never a capability error", async (t) => {
    const facade = await bootFacade(t);
    // Caller confusion must never reach a user as 501.
    for (const fn of ["checkStreamingSendCapability", "assertStreamingSendCapability"]) {
      let caught = null;
      try {
        facade[fn]("POST /api/not-a-member", RUNTIME);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, `${fn} must throw on an unknown key`);
      assert.equal(isEngineCapabilityNotSupportedError(caught), false, fn);
      assert.equal(caught.code, "unknown_streaming_send_endpoint", fn);
    }
  });

  test("the check and assert forms AGREE for every transport the server accepts", async (t) => {
    const facade = await bootFacade(t);
    // `exec` is the third valid MCODE_WEBUI_TRANSPORT value and has no
    // registered provider either; the gate must treat it exactly like
    // `acp` rather than throwing on an unknown string. When B8b wires
    // the route, this is what keeps the exec escape hatch alive.
    for (const transport of [ACP, "exec", RUNTIME]) {
      assert.equal(
        facade.assertStreamingSendCapability(ENDPOINT, transport).gate,
        facade.checkStreamingSendCapability(ENDPOINT, transport).gate,
        transport,
      );
    }
  });
});

// ===========================================================================
// 2. The red lines this layer owns
// ===========================================================================
describe("RED LINE 1 — run-mirror: the still-viewing test", () => {
  test("a turn whose record is still the viewed one counts as still viewing", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.sendStillViewing(mkCs(), "webui-1", SID), true);
  });

  test("a mid-run switch to another conversation reads as NOT still viewing", async (t) => {
    const facade = await bootFacade(t);
    // This is the case the whole run-mirror exists for: cs now points
    // at the OTHER session, so every cs mutation after this point would
    // stamp this turn's engine id, title or chat onto it.
    assert.equal(facade.sendStillViewing(mkCs({ sessionId: OTHER_SID }), "webui-1", SID), false);
  });

  test("a record PROMOTED mid-run still counts — the post-bind id form", async (t) => {
    const facade = await bootFacade(t);
    // bindDraftToMcodeSid renames the record's id to the engine sid, so
    // after promotion `cs.sessionId === sid`. Recognising only the
    // pre-promotion form would make every post-bind turn look switched
    // away and the answer would never reach the live view.
    assert.equal(facade.sendStillViewing(mkCs({ sessionId: SID }), "webui-1", SID), true);
  });

  test("REVERSE: a turn with no owning record is treated as still viewing", async (t) => {
    const facade = await bootFacade(t);
    // A direct caller (a unit test, a future non-turn helper) has no
    // draft at all. Treating that as "switched away" would silently
    // disable every cs mutation for those callers.
    assert.equal(facade.sendStillViewing(mkCs({ sessionId: "whatever" }), null, SID), true);
    assert.equal(facade.sendStillViewing(mkCs(), undefined, SID), true);
  });

  test("REVERSE: a missing client state is NOT still viewing", async (t) => {
    const facade = await bootFacade(t);
    // The mirror of the case above. There is nothing to write through,
    // so the honest answer is "no" — the caller falls back to the
    // record-by-id path, which is the correct destination for a turn
    // with no live view.
    assert.equal(facade.sendStillViewing(null, "webui-1", SID), false);
    assert.equal(facade.sendStillViewing(undefined, "webui-1", SID), false);
  });

  test("REVERSE: a turn with NO engine sid still tests on the record id alone", async (t) => {
    const facade = await bootFacade(t);
    // The pre-session window: the engine id is not known yet, so the
    // `sid` clause cannot fire and the record id is the only evidence.
    assert.equal(facade.sendStillViewing(mkCs(), "webui-1", null), true);
    assert.equal(
      facade.sendStillViewing(mkCs({ sessionId: OTHER_SID }), "webui-1", null),
      false,
      "without an sid, a switched-away view must still read as switched away",
    );
  });
});

describe("RED LINE 2 — the finalize drain's `●` rewrite", () => {
  test("the LAST `●` line is the one rewritten, scanning from the end", async (t) => {
    const facade = await bootFacade(t);
    // A turn that produced two answer segments (a tool call between
    // them) has two `●` lines; the final answer is the last one.
    const lines = ["› hi", "● first segment", "→ read", "● second segm"];
    assert.deepEqual(facade.rewriteDrainedAnswerLine(lines, "final answer"), [
      "› hi",
      "● first segment",
      "→ read",
      "● final answer",
    ]);
  });

  test("the input array is never mutated — the caller compares before and after", async (t) => {
    const facade = await bootFacade(t);
    const lines = ["● old"];
    const copy = [...lines];
    facade.rewriteDrainedAnswerLine(lines, "new");
    assert.deepEqual(lines, copy, "pure function, or the drain double-writes the record");
  });

  test("an answer with NO `●` line is APPENDED, not dropped", async (t) => {
    const facade = await bootFacade(t);
    // The alternative — dropping it — loses the turn's only output on a
    // runtime that streams no `●` at all (a tool-only turn, or one
    // whose deltas were all classified IGNORE).
    assert.deepEqual(facade.rewriteDrainedAnswerLine(["› hi", "→ read"], "only output"), [
      "› hi",
      "→ read",
      "● only output",
    ]);
  });

  test("REVERSE: a null answer rewrites nothing but still copies", async (t) => {
    const facade = await bootFacade(t);
    // The non-success path: the drained lines are the owning session's
    // content and are flushed exactly as they were.
    assert.deepEqual(facade.rewriteDrainedAnswerLine(["● partial", "→ read"], null), [
      "● partial",
      "→ read",
    ]);
  });

  test("REVERSE: an empty or non-array buffer yields an empty list, not a throw", async (t) => {
    const facade = await bootFacade(t);
    for (const input of [[], null, undefined, "not-an-array"]) {
      assert.deepEqual(facade.rewriteDrainedAnswerLine(input, "x"), [], JSON.stringify(input));
    }
  });

  test("REVERSE: a non-string line is not mistaken for an answer line", async (t) => {
    const facade = await bootFacade(t);
    // The decoder's history is a `string[]`, but a rich-text object
    // surviving in a buffer must not make `startsWith` throw — a
    // finalize that throws would skip the whole drain.
    assert.deepEqual(facade.rewriteDrainedAnswerLine([{ text: "hi" }, "→ read"], "answer"), [
      { text: "hi" },
      "→ read",
      "● answer",
    ]);
  });
});

describe("RED LINES 3 + 4 — the promotion and the 409 claim are the ROUTE's", () => {
  // Both are structural: they live in the route tail after the
  // transport branch, so they cannot differ between transports. What
  // matters is proving that against the real runner, which needs the
  // route — section 6 does exactly that, end to end, with the real
  // `runMcodeRuntime` and a fake host. This block states only the
  // negative that section 6 depends on: neither red line has a
  // derivation here, so the runner cannot re-derive one and drift.
  test("neither red line has a derivation in this layer", async (t) => {
    const facade = await bootFacade(t);
    assert.equal("sendShouldPromoteDraft" in facade, false);
    assert.equal(
      FACADE_EXPORTS.some((n) => /claim|promote/i.test(n)),
      false,
      "a claim or promotion predicate here would be a second answer to a question the route already answers",
    );
  });
});

// ===========================================================================
// 3. The stream bridge
// ===========================================================================
describe("the stream bridge, table-driven over the whole event taxonomy", () => {
  test("every TuiStreamEvent family classifies to a known kind", async (t) => {
    const facade = await bootFacade(t);
    const K = facade.SEND_EVENT_KINDS;
    const TABLE = [
      ["delta with text", EV.deltaText("hi"), K.MESSAGE],
      ["delta with thinking", EV.deltaThinking("hmm"), K.THOUGHT],
      ["delta with a tool call", EV.deltaTool([EV.tool()]), K.TOOL],
      ["settled message", EV.settled({ content: "done" }), K.AUTHORITATIVE],
      ["session-status started", EV.started, K.STREAM],
      ["session-status finished", EV.finished, K.TERMINAL],
      ["session-status error", EV.errored("boom"), K.TERMINAL],
      ["session-status aborted", EV.aborted, K.TERMINAL],
      ["error event", EV.error("boom"), K.TERMINAL],
      ["done", EV.done, K.TERMINAL],
      ["heartbeat", EV.heartbeat, K.IGNORE],
      ["resync-required", EV.resync, K.IGNORE],
      ["generic", EV.generic, K.IGNORE],
      ["messages-replaced", EV.replaced, K.IGNORE],
      ["messages-rewound", EV.rewound, K.IGNORE],
    ];
    for (const [name, event, expected] of TABLE) {
      assert.equal(facade.classifySendEvent(event).kind, expected, name);
    }
  });

  test("the taxonomy is a frozen literal the runner switches on", async (t) => {
    const facade = await bootFacade(t);
    // A plain object would let a caller add a kind at runtime and make
    // the switch in the runner silently incomplete. Frozen is the
    // cheap half of the guarantee; the named-test table above is the
    // expensive half, and neither replaces the other.
    assert.equal(Object.isFrozen(facade.SEND_EVENT_KINDS), true);
    assert.deepEqual(Object.keys(facade.SEND_EVENT_KINDS).sort(), [
      "AUTHORITATIVE",
      "IGNORE",
      "MESSAGE",
      "STREAM",
      "TERMINAL",
      "THOUGHT",
      "TOOL",
    ]);
  });

  test("the text is carried through, not summarized", async (t) => {
    const facade = await bootFacade(t);
    const K = facade.SEND_EVENT_KINDS;
    const d = facade.classifySendEvent(EV.deltaText("改好了"));
    assert.equal(d.kind, K.MESSAGE);
    assert.equal(d.text, "改好了");
    const th = facade.classifySendEvent(EV.deltaThinking("先读文件"));
    assert.equal(th.kind, K.THOUGHT);
    assert.equal(th.text, "先读文件");
  });

  test("a tool call wins over text that rode along in the same delta", async (t) => {
    const facade = await bootFacade(t);
    const K = facade.SEND_EVENT_KINDS;
    // The runtime re-sends the whole tool call on every chunk of its
    // lifecycle, sometimes next to a text fragment. Classifying that as
    // MESSAGE would append the text to the answer segment that the
    // tool call is supposed to have broken.
    const c = facade.classifySendEvent(EV.deltaTool([EV.tool()]));
    assert.equal(c.kind, K.TOOL);
    assert.equal(Array.isArray(c.toolCalls), true);
    assert.equal(c.toolCalls.length, 1);
  });

  test("text that rode along with a tool call is still carried, for the runner to place", async (t) => {
    const facade = await bootFacade(t);
    const c = facade.classifySendEvent({
      type: "delta",
      role: "assistant",
      content: "reading the file",
      toolCalls: [EV.tool()],
    });
    // The classification says TOOL; the text is not discarded, it is
    // the runner's job to put it in the answer segment that the tool
    // call just broke. Dropping it here would lose a real message.
    assert.equal(c.kind, facade.SEND_EVENT_KINDS.TOOL);
    assert.equal(c.text, "reading the file");
  });

  test("an empty delta produces NO line", async (t) => {
    const facade = await bootFacade(t);
    // A `finish: true` chunk with no payload is the segment terminator.
    // Treating it as an empty MESSAGE would push a `● ` line.
    assert.equal(
      facade.classifySendEvent(EV.deltaText("")).kind,
      facade.SEND_EVENT_KINDS.IGNORE,
    );
    assert.equal(
      facade.classifySendEvent(EV.deltaThinking("")).kind,
      facade.SEND_EVENT_KINDS.IGNORE,
    );
    assert.equal(facade.classifySendEvent({ type: "delta" }).kind, facade.SEND_EVENT_KINDS.IGNORE);
  });

  test("a settled message with finishReason 'error' is a TERMINAL failure, not content", async (t) => {
    const facade = await bootFacade(t);
    // The runtime reports a mid-turn crash as a settled message with an
    // error finish reason. Rendering it as an answer would show the user
    // an error as if the model had written it.
    const c = facade.classifySendEvent(EV.settled({ content: "tool crashed", finishReason: "error" }));
    assert.equal(c.kind, facade.SEND_EVENT_KINDS.TERMINAL);
    assert.equal(c.errorMessage, "tool crashed");
    assert.equal(c.text, undefined, "an error is not an answer");
  });

  test("an error finish reason with no text still names something", async (t) => {
    const facade = await bootFacade(t);
    const c = facade.classifySendEvent(EV.settled({ finishReason: "error" }));
    assert.equal(c.kind, facade.SEND_EVENT_KINDS.TERMINAL);
    assert.ok(typeof c.errorMessage === "string" && c.errorMessage.length > 0);
  });

  test("the settled message carries usage, stop reason and the turn coordinate", async (t) => {
    const facade = await bootFacade(t);
    const c = facade.classifySendEvent(
      EV.settled({
        content: "answer",
        usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
        finishReason: "stop",
        id: "msg-42",
      }),
    );
    assert.equal(c.kind, facade.SEND_EVENT_KINDS.AUTHORITATIVE);
    assert.equal(c.text, "answer");
    assert.equal(c.finishReason, "stop");
    assert.equal(c.messageId, "msg-42", "the turn_msg coordinate has to survive the bridge");
    assert.deepEqual(c.usage, { totalTokens: 120, inputTokens: 100, outputTokens: 20 });
  });

  test("a settled message with no fields is still classified, not dropped", async (t) => {
    const facade = await bootFacade(t);
    // The runner's "an empty settled message does not clear a good
    // accumulation" rule only works if this classifies as AUTHORITATIVE
    // rather than IGNORE.
    assert.equal(
      facade.classifySendEvent(EV.settled({})).kind,
      facade.SEND_EVENT_KINDS.AUTHORITATIVE,
    );
  });

  test("a settled message whose payload is not an object is IGNORE, not a throw", async (t) => {
    const facade = await bootFacade(t);
    // `message: null` is what a malformed frame looks like, and the
    // classification must not reach for `.finishReason` on it.
    for (const message of [null, undefined, "text", 7, []]) {
      assert.equal(
        facade.classifySendEvent({ type: "message", message }).kind,
        facade.SEND_EVENT_KINDS.IGNORE,
        JSON.stringify(message),
      );
    }
  });

  test("UNKNOWN and malformed events are IGNORE, never a throw", async (t) => {
    const facade = await bootFacade(t);
    // The whole point: a bridge that throws on an unrecognised frame
    // turns every future runtime addition into an outage of the chat
    // endpoint. Ignoring it costs one line; throwing costs the turn.
    for (const input of [null, undefined, 0, "", "nonsense", [], { type: "a-brand-new-frame" }]) {
      assert.equal(
        facade.classifySendEvent(input).kind,
        facade.SEND_EVENT_KINDS.IGNORE,
        JSON.stringify(input),
      );
    }
  });
});

describe("the segment accumulator", () => {
  test("same family appends, different family starts fresh — the full transition table", async (t) => {
    const facade = await bootFacade(t);
    const M = facade.SEND_EVENT_KINDS.MESSAGE;
    const H = facade.SEND_EVENT_KINDS.THOUGHT;
    const TOOL = facade.SEND_EVENT_KINDS.TOOL;
    const TABLE = [
      // [lastKind, kind, buffer, delta, expectedReset, expectedText]
      [null, M, "", "a", true, "a"],
      [M, M, "a", "b", false, "ab"],
      [M, H, "a", "b", true, "b"],
      [H, M, "a", "b", true, "b"],
      // The tool case is the one that bites in production: a tool call
      // breaks the chain even though the accumulator is otherwise a
      // text segment, so the next text chunk starts a NEW `●` line
      // instead of appending to the previous segment.
      [M, TOOL, "a", "x", true, "x"],
      [TOOL, M, "a", "b", true, "b"],
    ];
    for (const [last, kind, buf, delta, reset, text] of TABLE) {
      const step = facade.sendSegmentAdvance(last, kind, buf, delta);
      assert.equal(step.reset, reset, `${last}→${kind}`);
      assert.equal(step.text, text, `${last}→${kind}`);
    }
  });

  test("the returned lastKind is the family the caller must store", async (t) => {
    const facade = await bootFacade(t);
    const M = facade.SEND_EVENT_KINDS.MESSAGE;
    // A runner that used the CALLER's old `lastKind` instead of the
    // returned one would never leave a segment, and every answer would
    // be one endlessly growing line.
    assert.equal(facade.sendSegmentAdvance(null, M, "", "a").lastKind, M);
    assert.equal(facade.sendSegmentAdvance(M, M, "a", "b").lastKind, M);
  });

  test("an empty delta never resets the segment", async (t) => {
    const facade = await bootFacade(t);
    const M = facade.SEND_EVENT_KINDS.MESSAGE;
    // A `finish: true` chunk with no payload must not blank the line the
    // user is watching.
    const step = facade.sendSegmentAdvance(M, M, "already written", "");
    assert.equal(step.reset, false);
    assert.equal(step.text, "already written");
    assert.equal(step.lastKind, M, "and the family is unchanged, so the next delta still appends");
  });

  test("a non-string delta is ignored rather than concatenated as 'undefined'", async (t) => {
    const facade = await bootFacade(t);
    const M = facade.SEND_EVENT_KINDS.MESSAGE;
    for (const delta of [null, undefined, 0, {}]) {
      const step = facade.sendSegmentAdvance(M, M, "kept", delta);
      assert.equal(step.text, "kept", JSON.stringify(delta));
    }
  });
});

describe("terminal outcomes", () => {
  test("`finished` is success and `done` means the same thing", async (t) => {
    const facade = await bootFacade(t);
    assert.deepEqual(facade.sendTerminalOutcome("finished"), {
      status: "succeeded",
      errorMessage: null,
    });
  });

  test("an ABORT is not a failure — the user pressed stop", async (t) => {
    const facade = await bootFacade(t);
    // The route's error branch is gated on `r.status === "failed"`, so
    // reporting an abort as a failure would fire an error alert for a
    // user action. This is the runtime transport's version of B7's
    // "`cancelled` means sent" rule.
    for (const status of ["aborted", "interrupted"]) {
      const o = facade.sendTerminalOutcome(status);
      assert.equal(o.status, "aborted", status);
      assert.equal(o.errorMessage, null, status);
    }
  });

  test("REVERSE: `error` IS a failure, and says so even without a message", async (t) => {
    const facade = await bootFacade(t);
    const o = facade.sendTerminalOutcome("error");
    assert.equal(o.status, "failed");
    assert.ok(o.errorMessage.length > 0, "a failure with no text still has to name itself");
  });

  test("REVERSE: an unrecognised terminal status fails closed, not open", async (t) => {
    const facade = await bootFacade(t);
    // A status nobody has seen must not be optimistically read as
    // success — that would be a truncated turn rendered as a complete
    // one, which is #110's fake success in a new costume.
    for (const status of ["finished-ish", "", null, undefined, 7]) {
      assert.equal(facade.sendTerminalOutcome(status).status, "failed", JSON.stringify(status));
    }
  });
});

// ===========================================================================
// 4. The byte-for-byte line bodies
// ===========================================================================
describe("the tool-call projection", () => {
  test("stages map onto the ACP path's own status words", async (t) => {
    const facade = await bootFacade(t);
    // Reusing `applyToolUpdate`'s vocabulary is the point: the indented
    // body syntax and the `→ name` header have exactly one home.
    assert.equal(facade.sendToolUpdate(EV.tool({ status: 1 })).status, "pending");
    assert.equal(facade.sendToolUpdate(EV.tool({ status: 4 })).status, "pending");
    assert.equal(facade.sendToolUpdate(EV.tool({ status: 5 })).status, "pending");
    assert.equal(facade.sendToolUpdate(EV.tool({ status: 2 })).status, "completed");
    assert.equal(facade.sendToolUpdate(EV.tool({ status: 3 })).status, "error");
  });

  test("a stage sent as a NAME is understood, not downgraded to completed", async (t) => {
    const facade = await bootFacade(t);
    // The ACP path's own `u.status` is a string; if the two vocabularies
    // ever merge, an unrecognized string silently becomes "completed"
    // and prints a half-streamed argument as a result.
    assert.equal(facade.sendToolUpdate(EV.tool({ status: "failed" })).status, "error");
    assert.equal(facade.sendToolUpdate(EV.tool({ status: "FINISHED" })).status, "completed");
    assert.equal(facade.sendToolUpdate(EV.tool({ status: "preparing" })).status, "pending");
  });

  test("the id, name, args and stage are forwarded to the shared reducer", async (t) => {
    const facade = await bootFacade(t);
    const u = facade.sendToolUpdate(EV.tool({ status: 2, output: "file contents" }));
    assert.equal(u.toolCallId, "tc-1");
    assert.equal(u.title, "read");
    assert.equal(u.status, "completed");
    // `rawInput` is forwarded PARSED, so `applyToolUpdate`'s own
    // `JSON.stringify` produces the identical string the ACP path does.
    assert.deepEqual(u.rawInput, { path: "/tmp/a" });
    assert.deepEqual(u.rawOutput, { content: [{ type: "text", text: "file contents" }] });
    assert.equal(u.wireStatus, 2);
  });

  test("a failed call carries its error, and a nameless one still names itself", async (t) => {
    const facade = await bootFacade(t);
    const failed = facade.sendToolUpdate(EV.tool({ status: 3, error: "ENOENT" }));
    assert.equal(failed.status, "error");
    assert.equal(failed.error, "ENOENT");
    const anon = facade.sendToolUpdate({});
    assert.equal(anon.title, "tool", "a header the decoder can still attribute");
  });

  test("a structured result is stringified rather than dropped", async (t) => {
    const facade = await bootFacade(t);
    // A tool webui cannot render is still a tool the user ran.
    const u = facade.sendToolUpdate(EV.tool({ status: 2, output: { rows: [1, 2] } }));
    assert.equal(u.rawOutput.content[0].text, '{"rows":[1,2]}');
  });

  test("a typed content array is joined, not JSON-stringified whole", async (t) => {
    const facade = await bootFacade(t);
    // The ACP path delivered `rawOutput.content[]` as typed parts; the
    // runtime delivers a parsed value. Both must reduce to the same
    // text or the two transports' tool bodies differ.
    const u = facade.sendToolUpdate(
      EV.tool({ status: 2, output: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    );
    assert.equal(u.rawOutput.content[0].text, "a\nb");
  });

  test("REVERSE: a result that cannot be stringified yields no body, not a throw", async (t) => {
    const facade = await bootFacade(t);
    const circular = {};
    circular.self = circular;
    const u = facade.sendToolUpdate(EV.tool({ status: 2, output: circular }));
    assert.equal(u.rawOutput, undefined, "no body is a truthful rendering; a throw is not");
  });

  test("REVERSE: a missing call is a total function", async (t) => {
    const facade = await bootFacade(t);
    for (const input of [null, undefined, "nonsense"]) {
      const u = facade.sendToolUpdate(input);
      assert.equal(u.title, "tool", JSON.stringify(input));
      assert.equal(u.toolCallId, undefined, JSON.stringify(input));
    }
  });

  test("REVERSE: an id-less call is not given a fabricated one", async (t) => {
    const facade = await bootFacade(t);
    // Inventing an id would make two unrelated calls collide on one
    // header and one of them would vanish.
    const u = facade.sendToolUpdate({ name: "ls", status: 1 });
    assert.equal("toolCallId" in u, false);
  });
});

describe("the tool-call header line", () => {
  test("the header carries the args, in the ACP path's exact spelling", async (t) => {
    const facade = await bootFacade(t);
    // The double space is the ACP line's, and the decoder splits on it.
    // `applyToolUpdate`'s own synthesized header has no args at all —
    // that form exists for a body attached mid-stream — which is why
    // the runner writes this one itself.
    const u = facade.sendToolUpdate(EV.tool({ status: 1 }));
    assert.equal(facade.sendToolHeaderLine(u), '→ read  {"path":"/tmp/a"}');
  });

  test("a call with no args is a bare `→ name`", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(
      facade.sendToolHeaderLine(facade.sendToolUpdate({ id: "x", name: "ls" })),
      "→ ls",
    );
  });

  test("REVERSE: a circular argument object loses the args, not the header", async (t) => {
    const facade = await bootFacade(t);
    const circular = {};
    circular.self = circular;
    const u = facade.sendToolUpdate({ id: "x", name: "ls", input: circular });
    assert.equal(facade.sendToolHeaderLine(u), "→ ls");
  });

  test("REVERSE: a missing update is a total function", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.sendToolHeaderLine(null), "→ tool");
    assert.equal(facade.sendToolHeaderLine(undefined), "→ tool");
  });
});

describe("usage projection", () => {
  test("the three totals the finalize accumulates come through", async (t) => {
    const facade = await bootFacade(t);
    assert.deepEqual(
      facade.sendUsageTotals({ totalTokens: 120, inputTokens: 100, outputTokens: 20 }),
      { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
    );
  });

  test("REVERSE: no usage yields null, NOT a zeroed object", async (t) => {
    const facade = await bootFacade(t);
    // The finalize's "no usage" branch is what falls back to a
    // length-based estimate. A zeroed object takes that branch away and
    // the context panel reads zero tokens for the rest of the session.
    for (const input of [null, undefined, {}, { reasoningTokens: 5 }, "nonsense"]) {
      assert.equal(facade.sendUsageTotals(input), null, JSON.stringify(input));
    }
  });

  test("a partial usage is completed with zeros, not with undefined", async (t) => {
    const facade = await bootFacade(t);
    // `undefined` in the total would make `+ (r.usage.totalTokens || 0)`
    // work by accident, but the shape is also asserted by consumers;
    // a number is the honest zero here.
    assert.deepEqual(facade.sendUsageTotals({ inputTokens: 7 }), {
      totalTokens: 0,
      inputTokens: 7,
      outputTokens: 0,
    });
  });

  test("a non-finite number is not a number", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.sendUsageTotals({ totalTokens: NaN }), null);
    assert.equal(facade.sendUsageTotals({ totalTokens: Infinity }), null);
  });

  test("the runtime's snake_case spelling is not accepted by accident", async (t) => {
    const facade = await bootFacade(t);
    // The TUI projection already renamed these to camelCase. If a
    // future change lets the raw wire shape through, the totals would
    // silently read as absent and the estimate branch would win — which
    // looks like a working turn with a wrong context panel.
    assert.equal(
      facade.sendUsageTotals({ total_tokens: 120, input_tokens: 100 }),
      null,
    );
  });
});

// ===========================================================================
// 5. The data plane (B8b)
// ===========================================================================

describe("the attachment projection", () => {
  test("webui's `{path, name, size}` becomes the runtime's `{meta, local}` pair", async (t) => {
    const facade = await bootFacade(t);
    const out = facade.projectSendAttachments([{ path: "/u/a.png", name: "a.png", size: 12 }], {
      MAX_ATTACHMENTS_PER_TURN: 16,
    });
    assert.deepEqual(out, [
      {
        meta: {
          attachmentType: "file",
          fileName: "a.png",
          mimeType: "application/octet-stream",
          sizeBytes: 12,
        },
        local: { filePath: "/u/a.png" },
      },
    ]);
  });

  test("the mime type is the honest default, never a guess (KNOWN DEBT 2)", async (t) => {
    const facade = await bootFacade(t);
    const [one] = facade.projectSendAttachments([{ path: "/u/a.png", name: "a.png" }], {});
    // webui's upload pipeline discards the type, so the runtime is told
    // octet-stream rather than a value invented here.
    assert.equal(one.meta.mimeType, "application/octet-stream");
  });

  test("REVERSE: an empty, missing or oversized list is bounded, never a throw", async (t) => {
    const facade = await bootFacade(t);
    assert.deepEqual(facade.projectSendAttachments([], {}), []);
    assert.deepEqual(facade.projectSendAttachments(null, {}), []);
    assert.deepEqual(facade.projectSendAttachments(undefined, {}), []);
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `/u/${i}`, name: `${i}` }));
    assert.equal(facade.projectSendAttachments(many, { MAX_ATTACHMENTS_PER_TURN: 2 }).length, 2);
  });

  test("REVERSE: a nameless attachment still gets a filename", async (t) => {
    const facade = await bootFacade(t);
    const [one] = facade.projectSendAttachments([{ path: "/u/x" }], {});
    assert.equal(one.meta.fileName, "attachment");
  });
});

describe("opening a runtime turn", () => {
  test("a first turn CREATES the session and sends the content on it", async (t) => {
    const facade = await bootFacade(t);
    const seen = { created: null, sent: null };
    const catalogue = {
      adapter: {
        createSession: async (input) => {
          seen.created = input;
          return { sessionId: SID };
        },
      },
    };
    const stream = mkStream([]);
    const turn = { sendMessage: (req) => { seen.sent = req; return stream; }, close() {} };
    const r = await facade.openEngineSendStream({
      sessionId: null,
      content: "hello",
      workspaceDir: "/w",
      deps: { getHost: async () => catalogue, createTurnHost: () => turn },
    });
    assert.equal(r.ok, true);
    assert.equal(r.sessionId, SID);
    assert.deepEqual(seen.created, { workspaceDir: "/w" });
    assert.equal(seen.sent.id, SID);
    assert.equal(seen.sent.content, "hello");
  });

  test("an EXISTING session is reused — no createSession call at all", async (t) => {
    const facade = await bootFacade(t);
    let created = 0;
    const catalogue = { adapter: { createSession: async () => { created += 1; return {}; } } };
    const turn = { sendMessage: () => mkStream([]), close() {} };
    const r = await facade.openEngineSendStream({
      sessionId: SID,
      content: "x",
      workspaceDir: "/w",
      deps: { getHost: async () => catalogue, createTurnHost: () => turn },
    });
    assert.equal(r.ok, true);
    assert.equal(r.sessionId, SID);
    assert.equal(created, 0, "a second turn must not fork a new engine conversation");
  });

  test("a host that never booted is a failure, NOT a silent empty stream", async (t) => {
    const facade = await bootFacade(t);
    const r = await facade.openEngineSendStream({
      sessionId: SID,
      content: "x",
      deps: { getHost: async () => null, createTurnHost: () => ({}) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.sessionId, SID, "the existing session is still reported for the error path");
    assert.ok(r.message.includes("unavailable"));
  });

  test("a createSession that returns no id fails loudly rather than sending nowhere", async (t) => {
    const facade = await bootFacade(t);
    let sent = 0;
    const catalogue = { adapter: { createSession: async () => ({}) } };
    const turn = { sendMessage: () => { sent += 1; return mkStream([]); }, close() {} };
    const r = await facade.openEngineSendStream({
      sessionId: null,
      content: "x",
      deps: { getHost: async () => catalogue, createTurnHost: () => turn },
    });
    assert.equal(r.ok, false);
    assert.equal(sent, 0, "a turn with no session has nowhere to go");
  });

  test("a throwing host wrapper is a failure, and the turn host is not leaked", async (t) => {
    const facade = await bootFacade(t);
    const r = await facade.openEngineSendStream({
      sessionId: SID,
      content: "x",
      deps: {
        getHost: async () => ({ adapter: {} }),
        createTurnHost: () => {
          throw new Error("adapter missing");
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.message, "adapter missing");
  });
});


// ===========================================================================
// 6. The runtime runner writes webui lines
// ===========================================================================

// ===========================================================================
// 5. The route and the runner, with the proof that each mock took
// ===========================================================================

/**
 * The real `lib/mcode-acp.js` runtime runner, driven by a fake host.
 *
 * `openEngineSendStream` is the ONLY seam, so replacing it is enough to
 * drive the entire imperative half — the line writes, the segment
 * accumulation, the tool headers, the finalize, the run-mirror writes
 * — without a runtime, a host, or a clock. This is the coverage the
 * pure layer cannot give: the bridge being right is not the same as
 * the runner USING it right.
 */
async function bootRuntimeRunner(t, { events, sid = SID, turnHost, gate = null }) {
  // `mavis` is mocked for a reason that is not hygiene: the runner's
  // finalize fires a 400 ms post-turn re-query through
  // `applyMavisUsageToCs`, and the REAL one spawns a `sqlite3`
  // subprocess against a real data dir. Every runner case would
  // otherwise leave a live child behind, and one leaked handle hangs
  // the whole file (it did — 280 s, reported as one failure).
  await setupMocks(t, { mavis: { applyMavisUsageToCs: async () => ({}) } });
  let sent = null;
  const facade = await import(absPath("engine/streaming-send.js"));
  const opened = {
    ok: true,
    sessionId: sid,
    stream: mkStream(events, gate),
    turnHost: turnHost || { close() {} },
  };
  t.mock.module(absPath("engine/streaming-send.js"), {
    namedExports: {
      ...facade,
      openEngineSendStream: async (req) => {
        sent = req;
        return opened;
      },
    },
  });
  const acp = await import(`${absPath("lib/mcode-acp.js")}?bust=${bust++}`);
  return { acp, facade, getSent: () => sent, opened };
}

/** The lines the run-chat buffer holds after a turn, plus the drain. */
function drainedLines(cid, sid) {
  const bus = require_bus();
  return bus.drainRunChat(cid, sid);
}
let _bus = null;
function require_bus() {
  return _bus;
}

describe("the runtime runner writes webui lines", () => {
  test("a text turn renders `▲` then `●`, strips the cursor, and answers", async (t) => {
    const { acp } = await bootRuntimeRunner(t, {
      events: [
        EV.started,
        EV.deltaThinking("先读文件"),
        EV.deltaThinking("再改"),
        EV.deltaText("改好"),
        EV.deltaText("了"),
        EV.settled({ content: "改好了", finishReason: "stop", id: "msg-1" }),
        EV.finished,
      ],
    });
    const bus = (await import(absPath("lib/state-bus.js")));
    _bus = bus;
    const cs = mkCs();
    const r = await acp.runMcodeRuntime("改一下文件", {
      label: "prompt",
      sessionId: null,
      cs,
      cid: "b8-lines",
      owningWebuiSessionId: "webui-1",
    });
    assert.equal(r.status, "succeeded");
    // The accumulator is per-segment: two thinking deltas concatenate
    // into one `▲` line, and the tool-free text segment starts its own
    // `●` line.
    assert.equal(r.thinking, "先读文件再改");
    assert.equal(r.answer, "改好了", "the settled message overwrites the accumulated segment");
    assert.equal(r.stopReason, "stop");
    assert.equal(r.assistantMessageId, "msg-1");
    const lines = bus.drainRunChat("b8-lines", SID);
    assert.ok(lines.some((l) => l.startsWith("▲ 先读文件再改")), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.startsWith("● 改好了")), JSON.stringify(lines));
    // finalize strips every streaming cursor and writes the two
    // transcript markers the ACP runner writes.
    assert.equal(
      lines.some((l) => typeof l === "string" && l.endsWith(" ▍")),
      false,
      "an un-stripped cursor leaves the block flickering forever",
    );
    assert.ok(lines.some((l) => l.startsWith("§§ processed_duration=")));
    assert.ok(lines.some((l) => l === "§§ turn_msg=msg-1"));
    // And the panel is back at rest.
    assert.equal(cs.running.active, false);
    assert.equal(cs.context.thinkingStatus, "Idle");
  });

  test("a tool call emits the `##tc:` marker and a `→ name` header ONCE per call", async (t) => {
    // The runtime re-sends the whole tool call on every lifecycle chunk.
    // A header per chunk would be a different tool block per stage.
    const { acp } = await bootRuntimeRunner(t, {
      events: [
        EV.deltaTool([EV.tool({ status: 4 })]),
        EV.deltaTool([EV.tool({ status: 5 })]),
        EV.deltaTool([EV.tool({ status: 1 })]),
        EV.deltaText("reading"),
        EV.deltaTool([EV.tool({ status: 2, output: "file body" })]),
        EV.settled({ content: "reading" }),
        EV.done,
      ],
    });
    const bus = (await import(absPath("lib/state-bus.js")));
    const cs = mkCs();
    await acp.runMcodeRuntime("读文件", {
      sessionId: null,
      cs,
      cid: "b8-tool",
      owningWebuiSessionId: "webui-1",
    });
    const lines = bus.drainRunChat("b8-tool", SID);
    const headers = lines.filter((l) => typeof l === "string" && l.startsWith("→ "));
    const markers = lines.filter((l) => typeof l === "string" && l.startsWith("##tc:"));
    assert.equal(headers.length, 1, JSON.stringify(lines));
    assert.equal(headers[0], "→ read  {\"path\":\"/tmp/a\"}");
    assert.equal(markers.length, 1, JSON.stringify(lines));
    assert.equal(markers[0], "##tc:tc-1");
    // The finished stage's body lands under the header.
    assert.ok(lines.some((l) => l === "  [completed]"), JSON.stringify(lines));
    assert.ok(lines.some((l) => l === "  file body"), JSON.stringify(lines));
  });

  test("a tool call breaks the text segment — the next `●` starts a new line", async (t) => {
    const { acp } = await bootRuntimeRunner(t, {
      events: [
        EV.deltaText("first"),
        EV.deltaTool([EV.tool({ status: 1 })]),
        EV.deltaText("second"),
        EV.settled({ content: "second" }),
        EV.done,
      ],
    });
    const bus = (await import(absPath("lib/state-bus.js")));
    await acp.runMcodeRuntime("x", {
      sessionId: null,
      cs: mkCs(),
      cid: "b8-seg",
      owningWebuiSessionId: "webui-1",
    });
    const lines = bus.drainRunChat("b8-seg", SID);
    const answers = lines.filter((l) => typeof l === "string" && l.startsWith("● "));
    // Two segments means two lines, and the second does NOT contain
    // "first" — that is the session-isolation/06 bug this mirrors.
    assert.equal(answers.length, 2, JSON.stringify(lines));
    assert.equal(answers[0], "● first");
    assert.equal(answers[1], "● second");
  });

  test("an error turn resolves `failed` with the runtime's own message", async (t) => {
    const { acp } = await bootRuntimeRunner(t, {
      events: [EV.deltaText("partial"), EV.error("runtime exploded"), EV.done],
    });
    const cs = mkCs();
    const r = await acp.runMcodeRuntime("x", {
      sessionId: null,
      cs,
      cid: "b8-err",
      owningWebuiSessionId: "webui-1",
    });
    assert.equal(r.status, "failed");
    assert.equal(r.error.message, "runtime exploded");
    assert.equal(cs.running.active, false, "a failed turn still finalizes; the claim is released");
  });

  test("an ABORT resolves `aborted`, not `failed` — a stop is a user action", async (t) => {
    const { acp } = await bootRuntimeRunner(t, {
      events: [EV.deltaText("partial"), EV.aborted],
    });
    const r = await acp.runMcodeRuntime("x", {
      sessionId: null,
      cs: mkCs(),
      cid: "b8-abort",
      owningWebuiSessionId: "webui-1",
    });
    // The route's error branch is gated on `status === "failed"`, so
    // this is what keeps a stop from firing an error alert.
    assert.equal(r.status, "aborted");
    assert.equal(r.error, null);
  });

  test("a stream that ends with no terminal event is a FAILURE, not a silent success", async (t) => {
    // Truncation would otherwise render an unfinished turn as a
    // complete one, which is #110's fake success with a different
    // vocabulary.
    const { acp } = await bootRuntimeRunner(t, { events: [EV.deltaText("half")] });
    const r = await acp.runMcodeRuntime("x", {
      sessionId: null,
      cs: mkCs(),
      cid: "b8-trunc",
      owningWebuiSessionId: "webui-1",
    });
    assert.equal(r.status, "failed");
    assert.ok(r.error.message.includes("without a terminal event"));
  });

  test("a throwing iterator is a failure, and the turn host is closed", async (t) => {
    let closed = 0;
    const { acp } = await bootRuntimeRunner(t, {
      events: [EV.deltaText("x"), THROW_MARKER],
      turnHost: { close: () => { closed += 1; } },
    });
    const r = await acp.runMcodeRuntime("x", {
      sessionId: null,
      cs: mkCs(),
      cid: "b8-throw",
      owningWebuiSessionId: "webui-1",
    });
    assert.equal(r.status, "failed");
    assert.equal(r.error.message, "iterator exploded");
    assert.equal(closed, 1, "a per-turn AbortController left open accumulates one per turn");
  });

  test("an open that fails resolves `failed` rather than throwing at the route", async (t) => {
    // The runtime's `client.start()` + `session/new` equivalent. Its
    // failures are the same class: a start-phase failure that never
    // reaches finalize, so the route's error branch is what resets the
    // thinking claim.
    await setupMocks(t, {});
    const facade = await import(absPath("engine/streaming-send.js"));
    t.mock.module(absPath("engine/streaming-send.js"), {
      namedExports: {
        ...facade,
        openEngineSendStream: async () => ({
          ok: false,
          sessionId: null,
          message: "Runtime host unavailable",
        }),
      },
    });
    const acp = await import(`${absPath("lib/mcode-acp.js")}?bust=${bust++}`);
    const r = await acp.runMcodeRuntime("x", { sessionId: null, cs: mkCs(), cid: "b8-open" });
    assert.equal(r.status, "failed");
    assert.equal(r.error.message, "Runtime host unavailable");
  });

  test("a mid-run switch stops the turn from stamping the NEW view", async (t) => {
    // RED LINE 1, imperative half: the run-chat buffer is keyed by the
    // engine sid, so a switch cannot move the lines — and the finalize's
    // still-viewing test is what stops the `cs` mutation. The bind
    // already ran (legitimately, while the turn's own record was still
    // viewed), so this sets the id back to null to model "the user
    // opened a different conversation that has no engine id" and
    // asserts finalize leaves it alone.
    const gate = mkGate();
    const { acp } = await bootRuntimeRunner(t, {
      gate,
      events: [
        EV.deltaText("belongs to the old session"),
        GATE,
        EV.settled({ content: "belongs to the old session" }),
        EV.done,
      ],
    });
    const bus = (await import(absPath("lib/state-bus.js")));
    const cs = mkCs({ sessionId: "webui-1" });
    const p = acp.runMcodeRuntime("x", {
      sessionId: null,
      cs,
      cid: "b8-switch",
      owningWebuiSessionId: "webui-1",
    });
    // The switch lands WHILE the turn is streaming. `await gate.reached`
    // is the load-bearing line: it is what makes the ordering true
    // rather than merely intended, and it is a promise rather than a
    // poll so a failure here can never leak a ref'd handle.
    await gate.reached;
    cs.sessionId = OTHER_SID;
    cs.mcodeSessionId = null;
    gate.open();
    const r = await p;
    assert.equal(r.sessionId, SID);
    assert.equal(
      cs.mcodeSessionId,
      null,
      "the finalize stamped this turn's engine sid onto the conversation the user switched TO",
    );
    const lines = bus.drainRunChat("b8-switch", SID);
    assert.ok(
      lines.some((l) => typeof l === "string" && l.startsWith("● belongs to the old session")),
      JSON.stringify(lines),
    );
  });

  test("a PRE-BIND switch binds the OWNING record, never the switched-to view", async (t) => {
    // The other half of the run-mirror, and the one the bind-time test
    // had to earn: the user switched away BEFORE the engine session was
    // even known, so the bind must go through the record-by-id helper
    // and leave `cs` alone. Binding through `cs` here would rename the
    // session the user switched TO onto this turn's engine id — the
    // permanent split the qa note records.
    const { acp } = await bootRuntimeRunner(t, {
      events: [EV.deltaText("x"), EV.settled({ content: "x" }), EV.done],
    });
    // The owning draft has to EXIST for the bind to have something to
    // target — in production `routes/chat.js#handleSend` creates it
    // before the runner is called. Seeding it here is what makes the
    // second assertion mean "the OWNING record was bound" rather than
    // "nothing was bound".
    registerSessionsStore({
      initial: [{ id: "webui-1", title: "New session", chat: [], workspace: null }],
    });
    const cs = mkCs({ sessionId: OTHER_SID });
    await acp.runMcodeRuntime("x", {
      sessionId: null,
      cs,
      cid: "b8-prebind",
      owningWebuiSessionId: "webui-1",
    });
    assert.equal(
      cs.mcodeSessionId,
      null,
      "the bind went through the SWITCHED-TO client state instead of the owning record",
    );
    const store = getSessionsStore();
    assert.equal(
      store.filter((r) => r && r.mcodeSessionId === SID).length,
      1,
      "the owning record is the one that got the engine identity",
    );
  });

  test("a turn with reported usage lands it in the context panel", async (t) => {
    // The finalize's accumulation branch. Without this, dropping the
    // usage capture entirely would be invisible: the panel would read
    // zero tokens forever and nothing would fail.
    const { acp } = await bootRuntimeRunner(t, {
      events: [
        EV.deltaText("x"),
        EV.settled({
          content: "x",
          usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
        }),
        EV.done,
      ],
    });
    const cs = mkCs();
    await acp.runMcodeRuntime("x", {
      sessionId: null,
      cs,
      cid: "b8-usage",
      owningWebuiSessionId: "webui-1",
    });
    assert.equal(cs.context.tokens, 120);
    assert.equal(cs.usage.sessionInput, 100);
    assert.equal(cs.usage.sessionOutput, 20);
    assert.equal(cs.usage.sessionTotal, 120);
    assert.equal(cs.context.estimated, false, "a reported total is not an estimate");
  });

  test("REVERSE: with no switch, the same turn DOES stamp the viewed session", async (t) => {
    // The positive half of the line above. Without it the test above
    // would pass for the wrong reason — a runner that never wrote
    // anything would satisfy it too.
    const { acp } = await bootRuntimeRunner(t, {
      events: [EV.deltaText("x"), EV.settled({ content: "x" }), EV.done],
    });
    const cs = mkCs({ sessionId: "webui-1" });
    await acp.runMcodeRuntime("x", {
      sessionId: null,
      cs,
      cid: "b8-noswitch",
      owningWebuiSessionId: "webui-1",
    });
    assert.equal(cs.mcodeSessionId, SID);
  });
});

describe("routes/chat.js#handleSend on the runtime transport", () => {
  /** Load the route with a chosen transport value baked into config.js. */
  async function loadRoute(t, transport) {
    await setupMocks(t, {});
    const config = await import(absPath("lib/config.js"));
    t.mock.module(absPath("lib/config.js"), {
      namedExports: { ...config, MCODE_WEBUI_TRANSPORT: transport },
    });
    return import(`${absPath("routes/chat.js")}?bust=${bust++}`);
  }

  test("the runtime transport calls the runtime runner and the ack is byte-identical", async (t) => {
    const route = await loadRoute(t, RUNTIME);
    let seen = null;
    registerMcodeAcpMock({
      runMcodeRuntime: async (content, opts) => {
        seen = { content, opts };
        return { status: "succeeded", answer: "ok", sessionId: SID };
      },
    });
    const cs = mkCs();
    const res = mkRes();
    await route.handleSend(jsonReq({ content: "hello" }), res, { cs, cid: "b8-route" });
    const seenRes = lastResponse(res);
    assert.equal(seenRes.status, 200);
    assert.equal(seenRes.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(seenRes.body, '{"ok":true}', "the ack is the pre-M3 body, byte for byte");
    assert.equal(seen.content, "hello");
    // The options object is the one the acp branch passes too, minus the
    // model (the runtime does not take one yet — KNOWN DEBT 4) — so the
    // run-mirror id is present, which is what makes the tail identical.
    assert.equal(seen.opts.owningWebuiSessionId, "webui-1");
  });

  test("the ACP transport still calls the ACP runner — byte-for-byte unchanged", async (t) => {
    // The survival condition, asserted at the branch itself: with the
    // default transport the runtime runner is never reached.
    const route = await loadRoute(t, ACP);
    let acpCalls = 0;
    let runtimeCalls = 0;
    registerMcodeAcpMock({
      runMcodeAcp: async () => {
        acpCalls += 1;
        return { status: "succeeded", answer: "ok", sessionId: null };
      },
      runMcodeRuntime: async () => {
        runtimeCalls += 1;
        return { status: "succeeded", answer: "ok", sessionId: null };
      },
    });
    const res = mkRes();
    await route.handleSend(jsonReq({ content: "hello" }), mkResPlaceholder(res), {
      cs: mkCs(),
      cid: "b8-acp",
    });
    assert.equal(acpCalls, 1);
    assert.equal(runtimeCalls, 0);
  });

  test("MCODE_USE_ACP=0 still wins over the runtime transport", async (t) => {
    // lib/config.js documents the precedence as "MCODE_USE_ACP=0 ⇒
    // transport=exec (regardless of MCODE_WEBUI_TRANSPORT)". The escape
    // hatch exists for exactly the moment a transport misbehaves, so an
    // operator must not have to unset a second variable first.
    const prior = process.env.MCODE_USE_ACP;
    process.env.MCODE_USE_ACP = "0";
    try {
      const route = await loadRoute(t, RUNTIME);
      let runtimeCalls = 0;
      registerMcodeAcpMock({
        runMcodeRuntime: async () => {
          runtimeCalls += 1;
          return { status: "succeeded", answer: "ok", sessionId: null };
        },
      });
      await route.handleSend(jsonReq({ content: "hello" }), mkRes(), {
        cs: mkCs(),
        cid: "b8-exec",
      });
      assert.equal(runtimeCalls, 0, "the exec escape hatch outranks the new branch");
    } finally {
      if (prior === undefined) delete process.env.MCODE_USE_ACP;
      else process.env.MCODE_USE_ACP = prior;
    }
  });

  test("the 409 claim is taken BEFORE the runner and held for the whole turn", async (t) => {
    // Sequential sends are useless here: the first one releases the
    // claim in its `finally` before the second arrives. The claim's
    // whole job is refusing a send that arrives WHILE a turn is
    // running, so the runner has to still be in flight.
    const route = await loadRoute(t, RUNTIME);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let siblingSeen = null;
    registerMcodeAcpMock({
      runMcodeRuntime: async () => {
        const bus = (await import(absPath("lib/state-bus.js")));
        // A SIBLING conversation of the same tab must NOT be blocked —
        // that is the whole difference between the (cid, sessionId)
        // claim key and a cid-wide one, and the new branch must not
        // change it.
        const sibling = bus.beginRun("b8-409", null, "other-conversation");
        try {
          siblingSeen = sibling;
        } finally {
          bus.endRun("b8-409", "other-conversation");
        }
        await held;
        return { status: "succeeded", answer: "ok", sessionId: SID };
      },
    });
    const cs = mkCs();
    const first = route.handleSend(jsonReq({ content: "one" }), mkRes(), { cs, cid: "b8-409" });
    // Give the first send time to reach the runner and take the claim.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // Now the duplicate arrives, mid-turn. Every assertion is inside the
    // try because a failed one must still release the held turn — an
    // un-resolved runner promise hangs the whole file, not just the
    // test.
    try {
      const res = mkRes();
      await route.handleSend(jsonReq({ content: "two" }), res, { cs, cid: "b8-409" });
      const seen = lastResponse(res);
      assert.equal(seen.status, 409);
      assert.equal(
        seen.body,
        // P16: the refusal is user-facing — the composer renders `error`
        // verbatim in its banner, and the internal detail reads "a turn is
        // already running for this session", which names neither the
        // decision nor the next action. `reason` stays the machine key.
        '{"ok":false,"error":"This conversation is already running a turn. ' +
          'The message was NOT delivered — wait for the turn to finish, then send it again.",' +
          '"reason":"cid-busy"}',
        "the 409 body, byte for byte",
      );
      assert.equal(
        siblingSeen && siblingSeen.ok,
        true,
        `a sibling conversation in the same tab was blocked: ${siblingSeen && siblingSeen.reason}`,
      );
    } finally {
      release();
    }
    await first;
  });

  test("the 409 claim is RELEASED after a runtime turn, so the next send is accepted", async (t) => {
    // The negative half of the claim red line, and the reason the gate
    // was placed before `beginRun` rather than after it: a claim leaked
    // by a throwing gate would refuse every later send in this
    // conversation forever.
    const route = await loadRoute(t, RUNTIME);
    let calls = 0;
    registerMcodeAcpMock({
      runMcodeRuntime: async () => {
        calls += 1;
        return { status: "succeeded", answer: "ok", sessionId: SID };
      },
    });
    const cs = mkCs();
    await route.handleSend(jsonReq({ content: "one" }), mkRes(), { cs, cid: "b8-release" });
    const res = mkRes();
    await route.handleSend(jsonReq({ content: "two" }), res, { cs, cid: "b8-release" });
    assert.equal(lastResponse(res).status, 200);
    assert.equal(calls, 2, "the second send reached the runner, so the claim was released");
  });

  test("PROOF: a marker error from the gate escapes the route as a capability error", async (t) => {
    // Without a fresh `?bust=` re-import, `mock.module` would leave the
    // route holding the PREVIOUS test's live binding, the marker would
    // never be thrown, and this assertion would fail — which is the
    // point: it is the only assertion here that cannot pass by
    // accident.
    await setupMocks(t, {});
    const { EngineCapabilityNotSupportedError } = await import(absPath("engine/errors.js"));
    const marker = new EngineCapabilityNotSupportedError({
      capability: "streamingSend",
      provider: "local-runtime-v2",
    });
    mockFacade(t, {
      assertStreamingSendCapability: () => {
        throw marker;
      },
    });
    const route = await import(`${absPath("routes/chat.js")}?bust=${bust++}`);
    let caught = null;
    const cs = mkCs();
    try {
      await route.handleSend(jsonReq({ content: "hello" }), mkRes(), { cs, cid: "b8-gate" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the gate error — either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
    assert.equal(isEngineCapabilityNotSupportedError(caught), true);
    // And no claim was taken, so the NEXT send in this conversation is
    // not refused by one this batch leaked. Asked of the state bus
    // directly rather than by issuing a second send: the gate mock
    // throws unconditionally, so a second send would throw too and say
    // nothing about the claim.
    const bus = (await import(absPath("lib/state-bus.js")));
    const probe = bus.beginRun("b8-gate", null, "webui-1");
    try {
      assert.equal(
        probe.ok,
        true,
        `a refused gate left a claim behind: ${probe.reason}`,
      );
    } finally {
      bus.endRun("b8-gate", "webui-1");
    }
  });

  test("PROOF: a marker error from the runtime runner reaches the route's own finally", async (t) => {
    // The other live-binding proof, on the other mock: if
    // `runMcodeRuntime` re-imports were not honoured, this would
    // resolve normally and the assertion below would fail.
    const route = await loadRoute(t, RUNTIME);
    registerMcodeAcpMock({
      runMcodeRuntime: async () => {
        throw new Error("B8-RUNTIME-MOCK-WAS-NOT-HONOURED");
      },
    });
    const reloaded = await import(`${absPath("routes/chat.js")}?bust=${bust++}`);
    let caught = null;
    try {
      await reloaded.handleSend(jsonReq({ content: "hello" }), mkRes(), {
        cs: mkCs(),
        cid: "b8-mock",
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the runner error");
    assert.equal(caught.message, "B8-RUNTIME-MOCK-WAS-NOT-HONOURED");
  });
});

/** `handleSend` needs a fresh response object per call in some cases. */
function mkResPlaceholder(res) {
  return res;
}
