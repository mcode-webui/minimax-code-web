// webapp/test/send-confirmation.test.ts
//
// webui-parity 81 D-2 — an expired acknowledgement is not a failure.
//
// `POST /api/send` writes its 200 before the turn runs, so the 30s deadline
// measures the round trip, not whether the engine took the prompt. The old
// behaviour reported a deadline as "消息发送失败", put the text back in the
// box, and waited for the user to press Enter again — the engine had already
// run the prompt, so `sleep 35` executed twice.
//
// The invariants pinned here:
//   1. the deadline error is a distinguishable type, not a message string;
//   2. the probe is BOUNDED and asks the server, not the clock;
//   3. a send the server is already running is never offered back for a
//      one-keypress resend, and never wears the "could not send" headline;
//   4. none of the three unconfirmed banners contains a claim of failure.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SEND_PROBE_ATTEMPTS,
  SEND_PROBE_DELAYS_MS,
  classifySendProbe,
  probeSend,
  shouldRestoreDraft,
  stateAcceptsSend,
} from "../lib/send-confirmation";
import { isSendUnconfirmed, SendUnconfirmedError } from "../lib/api";
import type { WebuiState } from "../lib/types";
import { translate } from "../lib/i18n";
import { resetComposerDraftForTests, setComposerDraft, getComposerDraft } from "../lib/composer-draft";

/** Minimal state stand-in — only the two fields the decision reads. */
function stateOf(over: { running?: boolean; chat?: string[] } = {}): WebuiState {
  return {
    running: { active: over.running === true },
    chat: over.chat ?? [],
  } as unknown as WebuiState;
}

// ============================================================
// 1. The error is a type
// ============================================================

describe("the acknowledgement deadline is typed, not worded", () => {
  test("the thrown error is recognisable structurally", () => {
    const err = new SendUnconfirmedError(30_000);
    assert.equal(isSendUnconfirmed(err), true);
    assert.equal(err.timeoutMs, 30_000);
  });

  test("an ordinary failure is NOT mistaken for a deadline", () => {
    assert.equal(isSendUnconfirmed(new Error("HTTP 409")), false);
    assert.equal(isSendUnconfirmed(new TypeError("failed to fetch")), false);
    assert.equal(isSendUnconfirmed("no response within 30000ms"), false);
    assert.equal(isSendUnconfirmed(null), false);
    assert.equal(isSendUnconfirmed(undefined), false);
  });

  test("a plain object carrying the flag still counts", () => {
    // Two realms / a re-bundled module would break `instanceof`; the marker
    // is what the composer branches on.
    assert.equal(isSendUnconfirmed({ unconfirmed: true, message: "x" }), true);
  });
});

// ============================================================
// 2. Asking the server
// ============================================================

describe("stateAcceptsSend — what counts as 'the engine took it'", () => {
  const CASES: { name: string; state: WebuiState; content: string; want: boolean }[] = [
    {
      name: "a running turn carrying this send's echo is accepted",
      state: stateOf({ running: true, chat: ["› sleep 35"] }),
      content: "sleep 35",
      want: true,
    },
    {
      // P16 — the false positive. This send was made INTO a running
      // conversation, so the 409 that came back belonged to a turn that was
      // already running: the running turn the probe sees is the PREVIOUS
      // one, and the transcript is the only thing that can tell them apart.
      // Reading the flag as acceptance answered "the engine is running your
      // message, do not send it again" for a message the engine never got.
      name: "a running turn with NO trace of this send is not accepted",
      state: stateOf({ running: true, chat: ["› ping", "● pong"] }),
      content: "sleep 35",
      want: false,
    },
    {
      // The one place the running flag still decides: a snapshot that
      // carries no transcript at all cannot contradict it, and webui-parity
      // 81 D-2 (`sleep 35` ran twice) is the price of ignoring it there.
      name: "a state with no transcript at all falls back to the running flag",
      state: { running: { active: true } } as unknown as WebuiState,
      content: "sleep 35",
      want: true,
    },
    {
      name: "an idle session with the prompt in the transcript is accepted",
      state: stateOf({ chat: ["› ping", "› sleep 35"] }),
      content: "sleep 35",
      want: true,
    },
    {
      name: "a session with no trace of the prompt is not",
      state: stateOf({ chat: ["› ping", "● pong"] }),
      content: "sleep 35",
      want: false,
    },
    {
      name: "an empty session is not",
      state: stateOf({}),
      content: "sleep 35",
      want: false,
    },
    {
      name: "a different prompt in the transcript is not this send",
      state: stateOf({ chat: ["› ping"] }),
      content: "sleep 35",
      want: false,
    },
    {
      name: "a /goal prompt is accepted under its rewritten echo too",
      // bodyGoal rewrites `› /goal <text>` to `› <text>` before forwarding;
      // a goal turn must never be called "not accepted" and refilled.
      state: stateOf({ chat: ["› 绘制绘.html讲述一个成语故事"] }),
      content: "/goal 绘制绘.html讲述一个成语故事",
      want: true,
    },
    {
      name: "a bare command with no argument is not confused by the rewrite rule",
      state: stateOf({ chat: ["› /goal"] }),
      content: "/goal",
      want: true,
    },
  ];

  for (const c of CASES) {
    test(c.name, () => {
      assert.equal(stateAcceptsSend(c.state, c.content), c.want);
    });
  }
});

describe("classifySendProbe — the decision table", () => {
  // A turn that is running AND holds this send's echo — the proof, not the
  // flag. A read showing only a running turn is the P16 false positive.
  const RUNNING = stateOf({ running: true, chat: ["› x"] });
  const RUNNING_OTHER_TURN = stateOf({ running: true, chat: ["› earlier"] });
  const IDLE_EMPTY = stateOf({ chat: [] });

  test("one read showing the turn running settles it as accepted", () => {
    assert.equal(classifySendProbe([null, RUNNING], "x"), "accepted");
  });

  test("a running turn that never took this send is a rejection, not acceptance", () => {
    assert.equal(classifySendProbe([RUNNING_OTHER_TURN], "x"), "rejected");
    assert.equal(shouldRestoreDraft(classifySendProbe([RUNNING_OTHER_TURN], "x")), true);
  });

  test("a read that came back with no trace is a rejection", () => {
    assert.equal(classifySendProbe([IDLE_EMPTY], "x"), "rejected");
  });

  test("a later accepted read still wins over an earlier empty one", () => {
    // The turn may not have started at the first read; a refusal must not be
    // declared from a snapshot taken too early.
    assert.equal(classifySendProbe([IDLE_EMPTY, IDLE_EMPTY, RUNNING], "x"), "accepted");
  });

  test("no read at all is unreachable, not rejected", () => {
    assert.equal(classifySendProbe([null, null, null], "x"), "unreachable");
  });

  test("an empty read list is unreachable", () => {
    assert.equal(classifySendProbe([], "x"), "unreachable");
  });
});

describe("probeSend — bounded, and it really reads", () => {
  test("it reads exactly SEND_PROBE_ATTEMPTS times and waits the declared delays", async () => {
    const waits: number[] = [];
    let reads = 0;
    const outcome = await probeSend("x", {
      read: async () => {
        reads += 1;
        return stateOf({ running: reads === 2, chat: ["› x"] });
      },
      delay: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(reads, SEND_PROBE_ATTEMPTS, "the probe must not poll without a bound");
    assert.deepEqual(waits, SEND_PROBE_DELAYS_MS.filter((ms) => ms > 0));
    assert.equal(outcome, "accepted");
  });

  test("the budget is small and finite", () => {
    // Guard against someone "fixing" the false negative by polling longer.
    assert.ok(SEND_PROBE_ATTEMPTS <= 5, `probe attempts ${SEND_PROBE_ATTEMPTS} is unbounded-ish`);
    const total = SEND_PROBE_DELAYS_MS.reduce((a, b) => a + b, 0);
    assert.ok(total <= 5_000, `probe waits ${total}ms before giving up`);
  });

  test("it stops early in the verdict but not in the reads — a bounded budget, not a guess", async () => {
    let reads = 0;
    const outcome = await probeSend("x", {
      read: async () => {
        reads += 1;
        return stateOf({ running: true, chat: ["› x"] });
      },
      delay: async () => {},
    });
    assert.equal(outcome, "accepted");
    assert.equal(reads, SEND_PROBE_ATTEMPTS);
  });

  test("a throwing read is treated as no read, never as a rejection", async () => {
    const outcome = await probeSend("x", {
      read: async () => {
        throw new Error("network down");
      },
      delay: async () => {},
    });
    assert.equal(outcome, "unreachable");
  });
});

// ============================================================
// 3. The rule that stops the duplicate execution
// ============================================================

describe("shouldRestoreDraft — never offer a one-keypress resend of a running send", () => {
  test("accepted: the text does NOT come back", () => {
    assert.equal(shouldRestoreDraft("accepted"), false);
  });

  test("rejected: the text comes back — the server holds no record of it", () => {
    assert.equal(shouldRestoreDraft("rejected"), true);
  });

  test("unreachable: the text comes back, because losing it is the worse defect", () => {
    assert.equal(shouldRestoreDraft("unreachable"), true);
  });
});

// ============================================================
// 4. The copy must not lie
// ============================================================

describe("the unconfirmed banner never claims the send failed", () => {
  const KEYS = [
    "error.unconfirmed.accepted",
    "error.unconfirmed.rejected",
    "error.unconfirmed.unreachable",
  ] as const;

  for (const locale of ["en", "zh"] as const) {
    for (const key of KEYS) {
      test(`${locale}/${key} exists and does not read as a failure verdict`, () => {
        const text = translate(locale, key);
        assert.ok(text.length > 0, "the banner must say something");
        // The old banner was `t("error.send") + ": " + message`, i.e. "消息发送失败"
        // / "Could not send the message". None of these may carry that claim.
        const failureClaim =
          locale === "zh"
            ? ["发送失败", "发送不成功", "没能发出"]
            : ["could not send", "failed to send", "message failed"];
        for (const phrase of failureClaim) {
          assert.ok(
            !text.toLowerCase().includes(phrase.toLowerCase()),
            `${locale}/${key} must not claim failure: ${JSON.stringify(text)}`,
          );
        }
      });
    }
  }

  test("the accepted banner tells the user not to resend", () => {
    const en = translate("en", "error.unconfirmed.accepted").toLowerCase();
    const zh = translate("zh", "error.unconfirmed.accepted");
    assert.ok(en.includes("do not send it again"), en);
    assert.ok(zh.includes("请勿重复发送"), zh);
  });

  test("the accepted banner names the real cause — a missing acknowledgement", () => {
    const en = translate("en", "error.unconfirmed.accepted").toLowerCase();
    assert.ok(en.includes("never confirmed"), en);
  });

  test("the unreachable banner tells the user to check the history first", () => {
    const en = translate("en", "error.unconfirmed.unreachable").toLowerCase();
    const zh = translate("zh", "error.unconfirmed.unreachable");
    assert.ok(en.includes("check the conversation history"), en);
    assert.ok(zh.includes("查看会话历史"), zh);
  });
});

// ============================================================
// 5. Wiring
// ============================================================

describe("the composer is wired to the probe, not to the deadline", () => {
  const source = readFileSync(fileURLToPath(new URL("../components/composer.tsx", import.meta.url)), "utf8");

  test("the catch branch classifies the failure and probes before deciding", () => {
    assert.match(source, /isSendUnconfirmed\(cause\)/);
    assert.match(source, /await probeSend\(content\)/);
    // The restore must be gated on the probe's answer, not on the catch
    // branch being reached at all.
    assert.match(
      source,
      /if \(restored && \(outcome === null \|\| shouldRestoreDraft\(outcome\)\)\)/,
      "the draft restore must be gated on shouldRestoreDraft",
    );
  });

  test("the banner is chosen by the outcome and never falls back to error.send", () => {
    assert.match(source, /unconfirmedBannerKey\(unconfirmedOutcome\)/);
    assert.match(
      source,
      /if \(outcome === "accepted"\) return "error\.unconfirmed\.accepted"/,
      "a missing outcome must not degrade to the failure headline",
    );
  });

  test("the unconfirmed banner does not wear the error colour", () => {
    assert.match(
      source,
      /errorKind === "unconfirmed"\s*\?\s*"text-caption-small-strong text-text_default_secondary"/,
      "an unconfirmed send must not be styled as a failure",
    );
  });
});

describe("the draft store carries the kind, not a string to match on", () => {
  test("reset gives a clean record", () => {
    resetComposerDraftForTests();
    assert.deepEqual(getComposerDraft("s1"), {
      value: "",
      error: null,
      errorKind: null,
      unconfirmed: null,
      attachments: [],
    });
  });

  test("the kind and the outcome are independent fields", () => {
    resetComposerDraftForTests();
    setComposerDraft("s1", { error: "", errorKind: "unconfirmed", unconfirmed: "accepted" });
    assert.equal(getComposerDraft("s1").errorKind, "unconfirmed");
    assert.equal(getComposerDraft("s1").unconfirmed, "accepted");
  });
});
