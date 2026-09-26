// webapp/test/sse.test.ts
// Unit tests for lib/sse.ts — the state-stream frame contract.
//
// Why this test exists: `GET /api/events` is where the ACP bridge's output becomes
// UI state. The server sends two frame shapes — unnamed frames carrying a whole
// state snapshot, and named control frames (`needs_authorization`,
// `authorization_decided`, `token.first_run`, `auth.token_rotated`, `heartbeat`) —
// and the client has to route each one correctly. Misrouting is silent: a dropped
// authorisation frame leaves a tool prompt invisible, and a dropped snapshot leaves
// the UI frozen on stale state.
//
// Test strategy: parseSseFrame is a pure function of (event name, data), so the
// contract is pinned without an EventSource or a DOM. These tests cover:
//   - routing for every event the server actually emits
//   - forward compatibility: unknown events are ignored, not treated as failures
//   - malformed payloads are reported rather than thrown
//   - the token-rotation frame is deliberately inert (no secret handling here)

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { NAMED_EVENTS, isConnectedAction, parseSseFrame } from "../lib/sse";

const SNAPSHOT = { version: "1.0", chat: [], sessionId: null };

describe("parseSseFrame — snapshot frames", () => {
  test("the default message event carries the state snapshot", () => {
    const action = parseSseFrame("", JSON.stringify(SNAPSHOT));
    assert.equal(action.kind, "state");
    if (action.kind === "state") assert.equal(action.state.version, "1.0");
  });

  test("the explicit `message` name behaves like the default", () => {
    assert.equal(parseSseFrame("message", JSON.stringify(SNAPSHOT)).kind, "state");
  });

  test("a malformed snapshot is reported, not thrown", () => {
    const action = parseSseFrame("", "{not json");
    assert.equal(action.kind, "malformed");
    if (action.kind === "malformed") assert.equal(action.event, "");
  });
});

describe("parseSseFrame — control frames", () => {
  test("needs_authorization yields the request", () => {
    const request = { requestId: "r1", action: "bash", ctx: {}, expiresAt: 123 };
    const action = parseSseFrame("needs_authorization", JSON.stringify(request));
    assert.equal(action.kind, "authorize");
    if (action.kind === "authorize") assert.equal(action.request.requestId, "r1");
  });

  test("authorization_decided clears without needing a payload", () => {
    assert.equal(parseSseFrame("authorization_decided", "").kind, "authorize-cleared");
  });

  test("token.first_run yields the bootstrap payload", () => {
    const payload = { token: "abc", persistPath: "/tmp/x", ts: 1 };
    const action = parseSseFrame("token.first_run", JSON.stringify(payload));
    assert.equal(action.kind, "first-run");
    if (action.kind === "first-run") assert.equal(action.payload.token, "abc");
  });

  test("heartbeat is inert but counts as liveness", () => {
    const action = parseSseFrame("heartbeat", "");
    assert.equal(action.kind, "heartbeat");
    assert.equal(isConnectedAction(action), true);
  });

  test("a malformed control frame is reported with its event name", () => {
    const action = parseSseFrame("needs_authorization", "nope");
    assert.equal(action.kind, "malformed");
    if (action.kind === "malformed") assert.equal(action.event, "needs_authorization");
  });

  test("token rotation is intentionally not acted on by this store", () => {
    // The rotated value is only needed by the settings surface, which fetches it
    // through the API. Keeping it out of the stream handler avoids spreading the
    // secret through component state.
    const action = parseSseFrame("auth.token_rotated", "deadbeef");
    assert.equal(action.kind, "ignored");
  });

  test("providers.updated yields the masked provider array", () => {
    // Ticket 03: the server broadcasts this after a successful
    // PUT on /api/providers. The store forwards the array; the
    // management panel and model selector bump a revision counter
    // and re-fetch through the typed API rather than trust the
    // SSE payload shape for masking + auth headers.
    const payload = {
      version: 2,
      providers: [{ id: "p1", label: "P1", auth: { hasKey: true, apiKeyMasked: "sk-a***b" } }],
    };
    const action = parseSseFrame("providers.updated", JSON.stringify(payload));
    assert.equal(action.kind, "providers-updated");
    if (action.kind === "providers-updated") {
      assert.equal(action.providers.length, 1);
      assert.equal((action.providers[0] as { id: string }).id, "p1");
    }
  });

  test("providers.updated with no providers key falls back to an empty array", () => {
    // Server contract is { version, providers }; the parser is
    // defensive so a malformed shape cannot crash the stream.
    const action = parseSseFrame("providers.updated", JSON.stringify({ version: 2 }));
    assert.equal(action.kind, "providers-updated");
    if (action.kind === "providers-updated") {
      assert.deepEqual(action.providers, []);
    }
  });

  test("providers.updated with malformed JSON is reported", () => {
    const action = parseSseFrame("providers.updated", "{not json");
    assert.equal(action.kind, "malformed");
    if (action.kind === "malformed") assert.equal(action.event, "providers.updated");
  });
});

describe("parseSseFrame — forward compatibility", () => {
  test("an unknown named event is ignored, not an error", () => {
    // The server may add events; an older client must keep working, mirroring the
    // server's own tolerance for missing ACP methods.
    const action = parseSseFrame("some.future.event", "{}");
    assert.equal(action.kind, "ignored");
  });

  test("every named event the server documents is classified explicitly", () => {
    for (const name of NAMED_EVENTS) {
      const action = parseSseFrame(name, "{}");
      // Falling through to the unknown-event branch would mean a documented event
      // is silently unhandled. Handled-but-deliberately-inert is fine.
      const unknown = action.kind === "ignored" && action.reason.startsWith("unknown event");
      assert.equal(unknown, false, `${name} must not fall through to the unknown branch`);
    }
  });
});

describe("isConnectedAction", () => {
  test("only state and heartbeat prove the stream is alive", () => {
    assert.equal(isConnectedAction({ kind: "heartbeat" }), true);
    assert.equal(isConnectedAction({ kind: "state", state: SNAPSHOT as never }), true);
    assert.equal(isConnectedAction({ kind: "authorize-cleared" }), null);
    assert.equal(isConnectedAction({ kind: "ignored", reason: "x" }), null);
  });
});
