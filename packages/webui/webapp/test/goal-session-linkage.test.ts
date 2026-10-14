// webapp/test/goal-session-linkage.test.ts
//
// PB-14 batch D — the three behaviours batch C could not have: a goal bound to
// the conversation on screen, a blocked goal that can be taken to the request
// unblocking it, and the engine's usage counters refreshed when a turn ends.
//
// Same harness as `goal-banner-ui.test.ts`: the real component through
// `renderToStaticMarkup`, the real predicates, and source-level tripwires for
// the two wirings SSR cannot reach (the chat column's props, and the store
// channel into the authorize modal).
//
// WHAT IS PURE AND WHAT IS NOT, and why the split is where it is. The hook's
// effects need React's runtime, which `renderToStaticMarkup` does not drive —
// so the DECISIONS the effects make (does this frame belong here, is this the
// falling edge of a turn) are exported as predicates and tested directly, and
// the effect wiring itself is pinned by tripwires on the source. Asserting on
// the decision and on the wiring separately is what makes each one falsifiable;
// a single "it works in a browser" assertion would fail on both counts at once
// and say which one broke for neither.
//
// createElement, not JSX: the `test:webapp` glob matches `*.test.ts`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { GoalBanner } from "../components/goal-banner";
import type { ThreadGoal } from "../lib/goal-state";
import { frameMatchesSession, isTurnComplete } from "../lib/use-thread-goal";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), "utf8");

// Read once at module scope: the same three sources back several assertions,
// and reading them inside each `describe` would give every suite its own copy
// of the same string without saying anything different.
const chat = read("../components/chat.tsx");
const store = read("../lib/store.tsx");
const modals = read("../components/modals.tsx");

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    goalId: "goal_01",
    sessionId: "sess_01",
    objective: "ship the goal banner",
    status: "active",
    tokensUsed: 4096,
    turnsUsed: 7,
    timeUsedSeconds: 91,
    ...overrides,
  };
}

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(GoalBanner, { locale: "en", ...props } as never),
  );
}

describe("PB-14 batch D — a frame belongs to the conversation on screen", () => {
  // The table is the whole rule: `GlobalThreadGoal.sessionId` is the ENGINE's
  // id, and the sidebar's `state.sessionId` is a different identifier, so
  // matching the wrong pair either rejects every real frame or accepts every
  // ghost. Each row is a case that has actually shipped in one direction or
  // the other.
  const cases: Array<[string, ThreadGoal | null, string | null, boolean]> = [
    ["a frame for the current engine session", goal({ sessionId: "m1" }), "m1", true],
    ["a frame for a DIFFERENT engine session", goal({ sessionId: "m0" }), "m1", false],
    // The ghost this batch exists for: the user switched away and the frame
    // for the previous conversation is still the one on screen.
    ["the previous session's frame after a switch", goal({ sessionId: "m0" }), "m1", false],
    // "I do not know which conversation this is" is not permission to paint.
    ["an unknown engine session", goal({ sessionId: "m1" }), null, false],
    ["no frame at all", null, "m1", false],
  ];
  for (const [label, frame, mcodeSessionId, expected] of cases) {
    test(`${label} → ${expected ? "drawn" : "not drawn"}`, () => {
      assert.equal(frameMatchesSession(frame, mcodeSessionId), expected);
    });
  }

  test("a frame is matched against the ENGINE id, never the sidebar id", () => {
    // `frameMatchesSession` is a string comparison and CANNOT know which id
    // space it is handed — comparing a frame whose `sessionId` is the sidebar
    // `randomUUID` against the same string passes, as it must. The guard
    // therefore lives in the CALLER, so that is what is asserted here rather
    // than a predicate claim the predicate does not make. Getting this wrong
    // paints another conversation's objective, status and token count over
    // this one's transcript.
    assert.ok(
      /mcodeSessionId:\s*state\?\.mcodeSessionId \?\? null/.test(chat),
      "the hook must receive the ENGINE session id",
    );
    assert.ok(
      /sessionId:\s*state\?\.sessionId \?\? null/.test(chat),
      "and the webui conversation id as the re-read key",
    );
    assert.ok(
      !/mcodeSessionId:\s*state\?\.sessionId/.test(chat),
      "passing the sidebar id as the engine id would accept every ghost",
    );
  });
});

describe("PB-14 batch D — the turn boundary is the falling edge", () => {
  // Only the falling edge moves the engine's counters (`timeUsedSeconds`,
  // `tokensUsed`, `turnsUsed` are advanced when a turn closes). Re-reading on
  // the rising edge would spend a request on a turn that has not produced
  // anything yet and still leave the banner one turn behind.
  const cases: Array<[string, boolean, boolean, boolean]> = [
    ["a turn ending", true, false, true],
    ["a turn starting", false, true, false],
    ["still running", true, true, false],
    ["still idle", false, false, false],
  ];
  for (const [label, before, after, expected] of cases) {
    test(`${label} → ${expected ? "re-read" : "no re-read"}`, () => {
      assert.equal(isTurnComplete(before, after), expected);
    });
  }
});

describe("PB-14 batch D — a blocked goal's wait line is the way to the request", () => {
  const waiting = { executionWait: { reason: "permission" } };

  test("blocked + waiting + a focus handler → the wait line is a button", () => {
    const markup = render({
      goal: goal({ status: "blocked", ...waiting }),
      onFocusAuthorize: () => {},
      authorizePending: true,
    });
    assert.ok(markup.includes('data-testid="thread-goal-wait-action"'), markup.slice(0, 600));
    // The reason must still be readable inside the control — a button whose
    // label is only "Answer the pending request" hides WHAT is being asked.
    assert.ok(markup.includes("Waiting for your permission"));
  });

  test("blocked + waiting + NO handler → the wait line stays text", () => {
    // A control that cannot act is worse than no control: it looks actionable
    // and swallows the click.
    const markup = render({ goal: goal({ status: "blocked", ...waiting }) });
    assert.ok(markup.includes('data-testid="thread-goal-wait"'));
    assert.ok(!markup.includes('data-testid="thread-goal-wait-action"'));
  });

  test("an ACTIVE goal that is waiting does not offer the shortcut", () => {
    // Mid-turn is not stuck. The user has nothing to decide, and offering a
    // "go answer it" button for a turn that is progressing is a false alarm.
    const markup = render({
      goal: goal({ status: "active", ...waiting }),
      onFocusAuthorize: () => {},
      authorizePending: true,
    });
    assert.ok(markup.includes('data-testid="thread-goal-wait"'));
    assert.ok(!markup.includes('data-testid="thread-goal-wait-action"'));
  });

  test("blocked with no wait reason has no shortcut and no wait line", () => {
    const markup = render({
      goal: goal({ status: "blocked" }),
      onFocusAuthorize: () => {},
      authorizePending: true,
    });
    assert.ok(!markup.includes('data-testid="thread-goal-wait-action"'));
    assert.ok(!markup.includes('data-testid="thread-goal-wait"'));
  });

  test("the 'nothing to focus' guidance is absent before the click", () => {
    // `renderToStaticMarkup` runs no effects, so the post-click state is
    // unreachable here by construction — which is exactly why its presence in
    // the INITIAL markup is the assertion worth making. A banner that opened
    // with "nothing is waiting here" would be contradicting its own wait line.
    const markup = render({
      goal: goal({ status: "blocked", ...waiting }),
      onFocusAuthorize: () => {},
      authorizePending: false,
    });
    assert.ok(!markup.includes('data-testid="thread-goal-no-authorize"'));
  });

  test("the shortcut is bilingual like everything else in the banner", () => {
    const zh = renderToStaticMarkup(
      createElement(GoalBanner, {
        locale: "zh",
        goal: goal({ status: "blocked", ...waiting }),
        onFocusAuthorize: () => {},
        authorizePending: true,
      } as never),
    );
    assert.ok(zh.includes("处理当前待办请求"), zh.slice(0, 600));
    assert.ok(zh.includes("等待你确认权限"));
  });
});

describe("PB-14 batch D — the wirings SSR cannot reach", () => {
  test("the chat column hands the banner the focus handler and the pending flag", () => {
    // Without `authorizePending` the banner cannot tell "take me there" from
    // "there is nothing there", and the click would silently do nothing.
    assert.ok(
      /onFocusAuthorize=\{focusPendingAuthorize\}/.test(chat),
      "the banner must be given a way to focus the pending authorize request",
    );
    assert.ok(
      /authorizePending=\{Boolean\(authorize\)\}/.test(chat),
      "the banner must be told whether a request is actually open",
    );
    assert.ok(
      /import \{ focusAuthorize, useSessionContext \} from "@\/lib\/store"/.test(chat),
      "the focus call must be the store action, not a second modal",
    );
  });

  test("the store's focus channel is a revision bump, not a boolean", () => {
    // A boolean cannot express "again", so a second request while the modal
    // is already open would be invisible to the effect that watches it.
    assert.ok(
      /authorizeFocusRevision:\s*number/.test(store),
      "the snapshot must carry a focus REVISION",
    );
    assert.ok(
      /export function focusAuthorize\(\)[\s\S]{0,160}authorizeFocusRevision: snapshot\.authorizeFocusRevision \+ 1/.test(
        store,
      ),
      "focusAuthorize must bump the revision",
    );
  });

  test("the authorize modal actually reacts to the channel", () => {
    // The channel is only worth adding if the far end consumes it. This is the
    // assertion that fails when someone adds `focusAuthorize()` and wires
    // nothing to it — the failure mode of every cross-component signal.
    assert.ok(
      /const \{ authorize, authorizeFocusRevision \} = useSessionContext\(\)/.test(modals),
      "AuthModal must read the focus revision",
    );
    assert.ok(
      /authorizeFocusRevision > 0\) approveRef\.current\?\.focus\(\)/.test(modals),
      "AuthModal must move focus to the approve button",
    );
    assert.ok(
      /ref=\{approveRef\}/.test(modals) && /ref\?: React\.Ref<HTMLButtonElement>/.test(modals),
      "the shared primary button must forward a ref for that focus",
    );
  });

  test("the focus effect sits above the early return, or it is skipped on re-render", () => {
    // Hooks cannot be called conditionally. `if (!authorize) return null;`
    // before the effect would make the hook count depend on whether a request
    // is open, which React answers by throwing the moment it changes.
    const body = modals.slice(modals.indexOf("function AuthModal"), modals.indexOf("function GhostButton"));
    assert.ok(
      body.indexOf("useEffect(") < body.indexOf("if (!authorize) return null;"),
      "the effect must be declared before the early return",
    );
  });
});
