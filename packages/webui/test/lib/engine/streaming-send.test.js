// webui/test/lib/engine/streaming-send.test.js
//
// M3-B8a: the STREAMING SEND family's PURE LAYER and its capability
// gate — #12 POST /api/send.
//
// WHAT THIS SUITE DOES NOT COVER, stated first because a reader will
// otherwise assume the endpoint is tested: #12 is not wired. B8a ships
// the declaration, the gate and the derivations; B8b ships the runner
// and the route branch. There is no route re-import in this file, no
// `?bust=` marker control, and no assertion about a response body,
// because there is no response to assert. The two red lines whose
// evidence lives in the ROUTE (the draft promotion and the 409 claim)
// are named below and deferred, with the reason.
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

import { setupMocks, absPath } from "../../helpers/_setup.js";
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
 * Three absences are deliberate and each is asserted by a named test
 * below, so the boundary between B8a and B8b is executable rather than
 * a promise in a report:
 *
 *   - `openEngineSendStream` / `projectSendAttachments` — the data
 *     plane. They are B8b's, and shipping them here would put host
 *     access and `await import()` on a module whose whole value is that
 *     it has neither.
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
  "resolveStreamingSendProvider",
  "rewriteDrainedAnswerLine",
  "sendSegmentAdvance",
  "sendStillViewing",
  "sendTerminalOutcome",
  "sendToolHeaderLine",
  "sendToolUpdate",
  "sendUsageTotals",
];

/** A client state carrying only what the still-viewing test reads. */
function mkCs(overrides = {}) {
  return { sessionId: "webui-1", ...overrides };
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

  test("the data plane is B8b's — this layer has no host access at all", async (t) => {
    // The reason B8a is a separate batch is this assertion: the module
    // is pure, so it can be reviewed and trusted on its own. A stray
    // `openEngineSendStream` would put host access and `await import()`
    // on a module whose whole value is that it has neither, and it would
    // do it invisibly — nothing would fail until the boot path got
    // heavier.
    const facade = await bootFacade(t);
    assert.equal("openEngineSendStream" in facade, false);
    assert.equal("projectSendAttachments" in facade, false);
    // And the source really has no dynamic import, which is the same
    // claim stated about the text rather than the namespace. A static
    // tripwire is the right shape here: there is no runtime harness in
    // B8a that could observe a boot-weight regression otherwise.
    const src = readFileSync(fileURLToPath(absPath("engine/streaming-send.js")), "utf8");
    // Comments are stripped first, and that is not a detail: this
    // module's own header DISCUSSES `await import()` in prose, so a
    // naive text search would fail on the documentation of the thing it
    // is forbidding. What the assertion is about is the executable text.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(
      /\bawait\s+import\s*\(/.test(code),
      false,
      "a pure layer that reaches for a dynamic import is not a pure layer",
    );
    assert.equal(
      /\brequire\s*\(/.test(code),
      false,
      "CJS has no place in an ESM facade module either",
    );
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

describe("RED LINE 3 + 4 — the promotion and the 409 claim are the ROUTE's", () => {
  // Both are structural: they live in the route tail after the
  // transport branch, so they cannot differ between transports. What
  // matters is proving that against the real runner, which needs the
  // route — B8b's job. Asserting it here would be a test of a comment,
  // so the honest thing is to name the gap rather than fill it with a
  // placeholder that passes.
  test("DEFERRED to B8b — this layer owns no predicate for either", async (t) => {
    const facade = await bootFacade(t);
    // The claim B8a can make today: neither red line has a derivation
    // here, which is the design (see the module's red-line-3 note for
    // the promotion; the claim was never a derivation at all). B8b
    // replaces this with the real route assertions.
    assert.equal("sendShouldPromoteDraft" in facade, false);
    assert.equal(FACADE_EXPORTS.some((n) => /claim|promote/i.test(n)), false);
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
