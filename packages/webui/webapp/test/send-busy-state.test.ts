// webapp/test/send-busy-state.test.ts
//
// P16 — sending into a conversation that is already running.
//
// The server refuses that send (409 `cid-busy` / `session-busy`) and never
// hands it to the engine. Before this the refusal arrived at the composer as
// a bare `new Error(string)`, so it rendered as the generic "消息发送失败"
// line with an internal English string glued to it, and the user read a
// refused message as a broken one. The state the banner must show is a
// THIRD one, distinct from both "could not send" and the unconfirmed
// banners: nothing is in flight on the engine, the text came back, and the
// only instruction is "send it again when the turn finishes".
//
// The invariants pinned here:
//   1. a 409 carrying the busy `reason` is recognised structurally, not by
//      message text, and not by `instanceof`;
//   2. a 409 with any other `reason` (at-capacity) and every other non-2xx
//      are NOT "busy" — collapsing them would repeat the same lie;
//   3. the two locales both carry the new key, and neither reuses the
//      unconfirmed wording that forbids resending.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ApiHttpError, isConversationBusy, isSendUnconfirmed } from "../lib/api";
import { translate, type Locale } from "../lib/i18n";

const BUSY_REASONS = ["cid-busy", "session-busy"] as const;

describe("isConversationBusy", () => {
  test("a 409 with a busy reason is a busy conversation", () => {
    for (const reason of BUSY_REASONS) {
      assert.equal(
        isConversationBusy(new ApiHttpError(409, "not delivered", reason)),
        true,
        `${reason} must read as busy`,
      );
    }
  });

  test("a structural object reads as busy without instanceof", () => {
    // Two module realms (the app bundle and a re-bundled copy) would make
    // `instanceof ApiHttpError` answer false for a real 409 — the same
    // trap `isSendUnconfirmed` exists to avoid.
    const crossRealm = { status: 409, reason: "session-busy" };
    assert.equal(isConversationBusy(crossRealm), true);
  });

  test("a capacity refusal is not a busy conversation", () => {
    assert.equal(
      isConversationBusy(new ApiHttpError(409, "server is at capacity", "at-capacity")),
      false,
    );
  });

  test("only 409 with a busy reason qualifies", () => {
    assert.equal(isConversationBusy(new ApiHttpError(400, "content required")), false);
    assert.equal(isConversationBusy(new Error("a turn is already running for this session")), false);
    assert.equal(isConversationBusy(null), false);
    assert.equal(isConversationBusy("cid-busy"), false);
  });

  test("a busy refusal is never the unconfirmed deadline error", () => {
    // The two are opposites: one means the engine has nothing, the other
    // means the engine may already be running it. The composer branches on
    // them separately, so neither may satisfy the other's check.
    const busy = new ApiHttpError(409, "not delivered", "cid-busy");
    assert.equal(isSendUnconfirmed(busy), false);
    assert.equal(isConversationBusy(new (class extends Error {})()), false);
  });
});

describe("error.busy copy", () => {
  for (const locale of ["en", "zh"] as Locale[]) {
    test(`${locale}: present, and does not forbid resending`, () => {
      const text = translate(locale, "error.busy");
      assert.ok(text.length > 0, "the key must resolve in every locale");
      assert.ok(
        !text.includes("请勿重复发送") && !/do not send it again/i.test(text),
        "the busy banner must NOT tell the user not to resend — nothing is running",
      );
      assert.ok(
        /未送达|not delivered/i.test(text),
        "the busy banner must state the message was not delivered",
      );
    });
  }
});
