// webapp/test/follow-up-behavior.test.ts
//
// Contract pins for SB-4 — the 跟进消息行为 row
// (`webui-follow-up-behavior`) reaching the composer, and the composer
// reaching the engine's queue / steering methods.
//
// Before this change the key was written by the settings page and read by
// nothing, and the composer's own comment said so. What is pinned here:
//
//   1. The three stored values, their default, and the fact that a stored
//      OFF value survives a round trip — a switch that cannot be turned
//      back off is a behaviour change wearing a switch's clothes.
//   2. The live channel, driven for real: subscribe, notify, unsubscribe,
//      survive a throwing listener, and reach subscribers from the
//      settings row's commit helper (so flipping the switch takes effect
//      in the already-open composer, with no reload).
//   3. `lib/follow-up.ts`'s decision, as a table over every
//      (behaviour × running) pair — the OFF position must collapse to
//      "render no send control", and no other pair may.
//   4. The refusal mapping, which is what stops an engine code from
//      being rendered raw into the banner.
//   5. The composer's wiring, on the source. The webapp suite has no
//      client-render harness (see context-meter-toggle.test.ts for why a
//      markup assertion would pass in both states), so the wiring is
//      pinned the way settings-general-sections.test.ts pins the
//      consumers it cannot drive — with the ORDER asserted as well as
//      the presence, because a guard that runs after the send would be
//      present and useless.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// --- window stub (before the module import) ---------------------------------

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  },
});

import {
  FOLLOW_UP_BEHAVIOR_KEY,
  commitFollowUpBehavior,
  readFollowUpBehavior,
  subscribeFollowUpBehavior,
  writeFollowUpBehavior,
  type FollowUpBehavior,
} from "../lib/settings-local";
import {
  FOLLOW_UP_NO_ACTIVE_TURN,
  FOLLOW_UP_TURN_NOT_OWNED,
  followUpFailureKey,
  isFollowUpRefusal,
  normalizeFollowUpBehavior,
  resolveFollowUpAction,
} from "../lib/follow-up";
import { ApiHttpError } from "../lib/api";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), "utf8");

beforeEach(() => {
  storage.clear();
});

describe("webui-follow-up-behavior: the stored value", () => {
  test("the key name and the default are unchanged", () => {
    // The bare-string format and the reference's default both stay: an
    // untouched profile behaves like the desktop's, and the key does not
    // move onto the webui envelope.
    assert.equal(FOLLOW_UP_BEHAVIOR_KEY, "webui-follow-up-behavior");
    assert.equal(readFollowUpBehavior(), "queue");
  });

  test("all three values round-trip through storage", () => {
    for (const value of ["off", "queue", "steer"] as FollowUpBehavior[]) {
      writeFollowUpBehavior(value);
      assert.equal(storage.get(FOLLOW_UP_BEHAVIOR_KEY), value);
      assert.equal(readFollowUpBehavior(), value);
    }
  });

  test("an unknown stored value falls back to queue rather than to a broken control", () => {
    for (const stored of ["", "steering", "QUEUE", "null"]) {
      storage.set(FOLLOW_UP_BEHAVIOR_KEY, stored);
      assert.equal(readFollowUpBehavior(), "queue", `stored ${JSON.stringify(stored)}`);
    }
  });

  test("storage that throws reads as the default instead of throwing at the composer", () => {
    const getItem = (): never => {
      throw new Error("storage disabled");
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { getItem, setItem: getItem } },
    });
    assert.equal(readFollowUpBehavior(), "queue");
    // Restore the stub for the remaining tests in this file.
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
          setItem: (key: string, value: string) => void storage.set(key, value),
          removeItem: (key: string) => void storage.delete(key),
        },
      },
    });
  });
});

describe("webui-follow-up-behavior: live channel", () => {
  test("a write notifies every subscriber with the value the user picked", () => {
    const seen: FollowUpBehavior[] = [];
    const off = subscribeFollowUpBehavior((value) => void seen.push(value));
    commitFollowUpBehavior(() => {}, "steer");
    commitFollowUpBehavior(() => {}, "off");
    off();
    writeFollowUpBehavior("queue");
    assert.deepEqual(seen, ["steer", "off"]);
  });

  test("the settings row's commit helper reaches subscribers AND persists", () => {
    // Both halves matter and in this order: the composer's control must
    // follow the pick, and the pick must survive a reload.
    let calls = 0;
    const off = subscribeFollowUpBehavior(() => void (calls += 1));
    commitFollowUpBehavior(() => {}, "off");
    off();
    assert.equal(calls, 1);
    assert.equal(storage.get(FOLLOW_UP_BEHAVIOR_KEY), "off");
  });

  test("unsubscribing stops the updates", () => {
    let calls = 0;
    const off = subscribeFollowUpBehavior(() => void (calls += 1));
    off();
    writeFollowUpBehavior("off");
    assert.equal(calls, 0);
  });

  test("a listener that throws does not cost the others their update", () => {
    const seen: FollowUpBehavior[] = [];
    subscribeFollowUpBehavior(() => {
      throw new Error("subscriber blew up");
    });
    const off = subscribeFollowUpBehavior((value) => void seen.push(value));
    writeFollowUpBehavior("steer");
    off();
    assert.deepEqual(seen, ["steer"]);
  });
});

describe("lib/follow-up: what one send does", () => {
  const table: ReadonlyArray<readonly [FollowUpBehavior, boolean, string]> = [
    // Not running: every stored value means the same thing — an ordinary
    // send. The switch is about what happens WHILE a turn runs, and
    // claiming otherwise would change the idle path too.
    ["off", false, "direct"],
    ["queue", false, "direct"],
    ["steer", false, "direct"],
    // Running: the switch decides, and OFF collapses to "render nothing".
    ["off", true, "wait"],
    ["queue", true, "queue"],
    ["steer", true, "steer"],
  ];

  for (const [behavior, running, expected] of table) {
    test(`${behavior} while running=${running} → ${expected}`, () => {
      assert.equal(resolveFollowUpAction(behavior, running), expected);
    });
  }

  test("a value that never came from the reader cannot become a behaviour", () => {
    // The composer receives the behaviour from a React state update; a
    // value outside the three must not silently resolve to something the
    // user did not choose.
    assert.equal(normalizeFollowUpBehavior(undefined), "queue");
    assert.equal(normalizeFollowUpBehavior("nonsense"), "queue");
    assert.equal(resolveFollowUpAction("nonsense" as FollowUpBehavior, true), "queue");
  });

  test("OFF renders no send control — the pre-SB-4 composer", () => {
    // The contract of the third value, stated as a fact about the action
    // rather than about markup: `wait` is the absence of a send, not a
    // disabled control that still sends.
    assert.equal(resolveFollowUpAction("off", true), "wait");
  });
});

describe("lib/follow-up: refusals", () => {
  test("the two refusals map to their own sentences and nothing else does", () => {
    assert.equal(
      followUpFailureKey(new ApiHttpError(409, "x", null, FOLLOW_UP_TURN_NOT_OWNED)),
      "error.followUp.notOwned",
    );
    assert.equal(
      followUpFailureKey(new ApiHttpError(409, "x", null, FOLLOW_UP_NO_ACTIVE_TURN)),
      "error.followUp.noActiveTurn",
    );
    // Anything else keeps the caller's own fallback — a generic engine
    // failure must not borrow a sentence that names the turn.
    assert.equal(followUpFailureKey(new ApiHttpError(500, "boom", null, "engine_error")), null);
    assert.equal(followUpFailureKey(new Error("plain")), null);
  });

  test("isFollowUpRefusal recognises exactly those two codes", () => {
    assert.equal(isFollowUpRefusal(new ApiHttpError(409, "x", null, "no_active_turn")), true);
    assert.equal(isFollowUpRefusal(new ApiHttpError(409, "x", null, "turn_not_owned")), true);
    assert.equal(isFollowUpRefusal(new ApiHttpError(409, "x", "cid-busy", null)), false);
    assert.equal(isFollowUpRefusal(null), false);
  });
});

describe("composer.tsx: the wiring", () => {
  const source = () => read("../components/composer.tsx");

  test("the composer reads the behaviour at mount and follows the channel", () => {
    assert.ok(
      source().includes("readFollowUpBehavior()"),
      "the composer must read the stored behaviour at mount",
    );
    assert.ok(
      source().includes("subscribeFollowUpBehavior(setFollowUp)"),
      "the composer must follow the live channel, or the switch needs a reload",
    );
  });

  test("the decision goes through the shared function, not a local condition", () => {
    assert.ok(
      source().includes("resolveFollowUpAction(followUp, running)"),
      "the composer must route through lib/follow-up, the one place the mapping is written",
    );
  });

  test("the WAIT guard runs before the request is built", () => {
    // The send button is not rendered while `wait`, but the textarea's
    // Enter handler calls `submit` directly — so the guard has to be
    // inside `submit`, and it has to be before the outbox records the
    // message as sent. A guard after the clear would wipe the user's text
    // without sending it.
    const body = source();
    const submitStart = body.indexOf("const submit = useCallback(async () => {");
    assert.ok(submitStart !== -1, "expected the submit callback");
    const guard = body.indexOf('if (action === "wait") return;', submitStart);
    const outbox = body.indexOf("startComposerSent({", submitStart);
    assert.ok(guard !== -1, "submit must refuse the wait action");
    assert.ok(outbox !== -1, "expected the optimistic-clear outbox record");
    assert.ok(
      guard < outbox,
      "the wait guard must run before the outbox records the message, or the text is cleared and lost",
    );
  });

  test("the follow-up branch is reached only for queue and steer", () => {
    const body = source();
    assert.ok(
      body.includes('if (action === "queue" || action === "steer") {'),
      "the follow-up request must be gated on the two engine actions",
    );
    assert.ok(
      body.includes("api.submitFollowUp({"),
      "a follow-up must go to the follow-up endpoint, never to /api/send",
    );
    // A slash command is a /api/cmd concern; sending one into a running
    // turn as a follow-up would hand the engine a message the command
    // dispatcher never saw. The branch therefore has to come first and
    // the slash routing after it, and it must not run for a wait.
    const followUpBranch = body.indexOf('if (action === "queue" || action === "steer") {');
    const slashRouting = body.indexOf("const route = routeSlashInput(content);", followUpBranch);
    assert.ok(slashRouting !== -1, "the direct path must still route slash input");
    assert.ok(
      followUpBranch < slashRouting,
      "the follow-up branch must decide before the slash router, or a command could be queued as a message",
    );
  });

  test("both controls are rendered while a turn runs", () => {
    // Stop and Send are two different things a user may want in the same
    // second, so neither may be replaced by the other: the stop control is
    // rendered on `running` alone, and the send group is suppressed only
    // for the `wait` action.
    const body = source();
    assert.ok(
      /\{running \? \(/.test(body) && /\) : null\}/.test(body),
      "the stop control must render whenever a turn is running",
    );
    assert.ok(
      body.includes('running && followUpAction === "wait" ? null : ('),
      "the send group must be suppressed only for the wait action",
    );
  });

  test("the refused follow-up keeps its own banner kind and colour", () => {
    const body = source();
    assert.ok(
      body.includes('? "followUp"'),
      "a refused follow-up must record its own error kind, or it renders as a raw engine string",
    );
    assert.ok(
      body.includes('errorKind === "busy" || errorKind === "followUp"'),
      "a refused follow-up is a not-delivered fact and wears the warning colour",
    );
    assert.ok(
      body.includes("t(followUpRefusal)"),
      "the banner text must be the translated refusal, not the engine's message",
    );
  });
});

describe("panels.tsx: the settings row offers all three positions", () => {
  test("the segmented control carries off, queue and steer", () => {
    const source = read("../components/panels.tsx");
    for (const id of ["off", "queue", "steer"]) {
      assert.ok(
        source.includes(`{ id: "${id}", label: t("settings.followUp.${id}") }`),
        `the 跟进消息行为 row must offer "${id}"`,
      );
    }
    assert.ok(
      source.includes('id === "steer" ? "steer" : id === "off" ? "off" : "queue"'),
      "the row's onChange must map every segment id to its stored value",
    );
  });
});

describe("i18n: both locales carry the new keys", () => {
  const i18n = () => read("../lib/i18n.ts");

  test("each new key exists in the English block and the Chinese block", () => {
    const source = i18n();
    for (const key of [
      "settings.followUp.off",
      "composer.followUp",
      "error.followUp.noActiveTurn",
      "error.followUp.notOwned",
    ]) {
      const occurrences = source.split(`"${key}":`).length - 1;
      assert.equal(occurrences, 2, `${key} must be defined in both locales (found ${occurrences})`);
    }
  });
});
