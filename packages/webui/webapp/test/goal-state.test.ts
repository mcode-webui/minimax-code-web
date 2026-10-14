// webapp/test/goal-state.test.ts
//
// PB-14 batch C — the pure projection behind the goal banner.
//
// These are the decisions the banner cannot be asked about in a screenshot:
// which actions a status may offer, which copy an unknown engine value falls
// back to, and what the edit form's two fields become as a wire body. The
// render branches live in `goal-banner-ui.test.ts`; what is pinned here is
// that no status, no wait reason and no malformed frame reaches the
// component as something it would have to guess about.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildGoalEditPatch,
  formatGoalDuration,
  goalActions,
  goalGuidanceKey,
  goalPhase,
  goalStatusKey,
  goalWaitKey,
  isGoalOpen,
  parseGoalBudgetValue,
  readGoalEnabled,
  readThreadGoal,
  type ThreadGoal,
} from "../lib/goal-state";

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    goalId: "goal_01",
    sessionId: "sess_01",
    objective: "ship the goal banner",
    status: "active",
    updatedAt: 2,
    tokensUsed: 4096,
    turnsUsed: 7,
    timeUsedSeconds: 91,
    tokenBudget: 50_000,
    ...overrides,
  };
}

describe("readThreadGoal — the one reader for a frame that arrived over a wire", () => {
  test("a complete frame is passed through, whole", () => {
    const raw = goal({ statusReason: "user_created", hasKickoffAttachments: true });
    assert.equal(readThreadGoal(raw), raw);
  });

  // Each of these is a frame the banner would otherwise paint `undefined`
  // into a chip. `null` is the answer because "this conversation has no
  // goal" is the frame's own spelling of the absence.
  const unreadable: readonly [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "goal"],
    ["a number", 7],
    ["an array", [goal()]],
    ["no goalId", { sessionId: "s", objective: "o", status: "active" }],
    ["an empty goalId", { goalId: "", sessionId: "s", objective: "o", status: "active" }],
    ["no sessionId", { goalId: "g", objective: "o", status: "active" }],
    ["a numeric objective", { goalId: "g", sessionId: "s", objective: 7, status: "active" }],
    ["no status", { goalId: "g", sessionId: "s", objective: "o" }],
    ["an empty status", { goalId: "g", sessionId: "s", objective: "o", status: "" }],
  ];
  for (const [name, raw] of unreadable) {
    test(`${name} is not a goal`, () => {
      assert.equal(readThreadGoal(raw), null);
    });
  }

  test("a status this build does not name still renders", () => {
    // The engine may add a seventh status. Refusing the whole goal over one
    // unfamiliar field would lose the objective and the token count too;
    // the chip is the only place that needs to be wrong about it.
    const read = readThreadGoal(goal({ status: "hibernating" }));
    assert.ok(read, "an unfamiliar status must not cost the user their banner");
    assert.equal(read?.status, "hibernating");
  });
});

describe("readGoalEnabled — the composer's permission to offer /goal", () => {
  test("only an explicit ok+enabled pair is true", () => {
    assert.equal(readGoalEnabled({ ok: true, enabled: true }), true);
  });
  for (const raw of [
    null,
    undefined,
    {},
    { ok: true },
    { enabled: true },
    { ok: false, enabled: true },
    { ok: true, enabled: "yes" },
    { ok: true, enabled: 1 },
    "yes",
  ]) {
    test(`${JSON.stringify(raw) ?? "undefined"} is not permission`, () => {
      // Fail-CLOSED, unlike `lib/engine-capabilities.ts`: a false negative
      // hides a control, a false positive offers a command that accepts an
      // objective and then answers 501. Refusing to offer is recoverable.
      assert.equal(readGoalEnabled(raw), false);
    });
  }
});

describe("goalPhase and goalActions — what a status may offer", () => {
  const phases: readonly [string, string][] = [
    ["active", "running"],
    ["paused", "paused"],
    ["blocked", "paused"],
    ["complete", "closed"],
    ["budget_limited", "closed"],
    ["usage_limited", "closed"],
    // A status this build does not know is treated as paused rather than
    // running: offering only "clear" on an unknown state is reversible,
    // while offering "pause" on something already stopped is a 400.
    ["hibernating", "paused"],
  ];
  for (const [status, phase] of phases) {
    test(`${status} is ${phase}`, () => {
      assert.equal(goalPhase(status), phase);
    });
  }

  test("an active goal offers pause", () => {
    assert.deepEqual(goalActions(goal({ status: "active" })), ["pause"]);
  });

  test("an active goal that is WAITING offers nothing — pausing strands the prompt", () => {
    // `executionWait` means the engine is blocked on something the USER owes
    // it. Pausing now would leave a pending question with no goal to resume
    // into, and the engine has no way to leave that state.
    assert.deepEqual(
      goalActions(goal({ status: "active", executionWait: { reason: "permission" } })),
      [],
    );
  });

  test("paused and blocked both offer resume and clear", () => {
    for (const status of ["paused", "blocked"]) {
      assert.deepEqual(goalActions(goal({ status })), ["resume", "clear"], status);
    }
  });

  test("a complete goal offers close, not clear — they are different promises", () => {
    // Clearing a live goal says "stop pursuing this"; closing a finished one
    // only takes the card away. One button would promise both.
    assert.deepEqual(goalActions(goal({ status: "complete" })), ["close"]);
  });

  test("budget_limited offers nothing, because the answer is a NEW goal", () => {
    // `isGoalOpen` says the banner still belongs (the tokens were spent);
    // `goalActions` says resume would 400. Both are right, and collapsing
    // them is the bug this pair of functions exists to prevent.
    assert.equal(isGoalOpen(goal({ status: "budget_limited" })), true);
    assert.deepEqual(goalActions(goal({ status: "budget_limited" })), []);
  });

  test("usage_limited offers nothing — the provider, not the user, decides", () => {
    assert.deepEqual(goalActions(goal({ status: "usage_limited" })), []);
  });
});

describe("the copy tables are total over any string", () => {
  test("the six engine statuses each have their own key", () => {
    const keys = [
      "active",
      "paused",
      "blocked",
      "complete",
      "budget_limited",
      "usage_limited",
    ].map(goalStatusKey);
    assert.equal(new Set(keys).size, keys.length, "two statuses share one chip key");
  });

  test("an unknown status falls back rather than rendering an identifier", () => {
    assert.equal(goalStatusKey("hibernating"), "goal.status.unknown");
    assert.equal(goalStatusKey(""), "goal.status.unknown");
  });

  test("the eight wait reasons each have their own key", () => {
    const keys = [
      "questionnaire",
      "permission",
      "plan",
      "required_background",
      "automation_owner_conflict",
      "dependency_unavailable",
      "verification",
      "unknown",
    ].map(goalWaitKey);
    assert.equal(new Set(keys).size, keys.length, "two wait reasons share one line");
  });

  test("an unknown wait reason still says the goal is waiting", () => {
    // The row's job is "it is waiting"; the reason word is a refinement. A
    // missing line renders a running goal as if nothing were happening.
    assert.equal(goalWaitKey("teleportation"), "goal.wait.unknown");
    assert.equal(goalWaitKey(undefined), "goal.wait.unknown");
    assert.equal(goalWaitKey(7), "goal.wait.unknown");
  });

  test("guidance names the one thing that resolves each closed status", () => {
    assert.equal(goalGuidanceKey("budget_limited"), "goal.guidance.budgetLimited");
    assert.equal(goalGuidanceKey("usage_limited"), "goal.guidance.usageLimited");
    assert.equal(goalGuidanceKey("complete"), "goal.guidance.complete");
    assert.equal(goalGuidanceKey("active"), null);
    assert.equal(goalGuidanceKey("paused"), null);
  });
});

describe("formatGoalDuration", () => {
  test("seconds, minutes and hours, dropping a zero component", () => {
    assert.equal(formatGoalDuration(0), "0s");
    assert.equal(formatGoalDuration(9), "9s");
    assert.equal(formatGoalDuration(59), "59s");
    assert.equal(formatGoalDuration(60), "1min");
    assert.equal(formatGoalDuration(75), "1min15s");
    assert.equal(formatGoalDuration(3600), "1h");
    assert.equal(formatGoalDuration(3660), "1h1min");
    // Once there is an hour, the seconds are dropped: the desktop formatter
    // stops at minutes in the hours branch, and a banner whose timer grew a
    // third component only above an hour would be a different widget from the
    // reference for most of a goal's life and the same one for the rest.
    assert.equal(formatGoalDuration(3725), "1h2min");
  });

  test("a value that came off the wire and is not a number renders 0s, not NaN", () => {
    // A banner that reads `NaNs` has told the user something false.
    for (const bad of [NaN, Infinity, -Infinity, -5, 1.9]) {
      assert.equal(formatGoalDuration(bad).includes("NaN"), false, `${bad} leaked NaN`);
    }
    assert.equal(formatGoalDuration(NaN), "0s");
    assert.equal(formatGoalDuration(-5), "0s");
  });
});

describe("buildGoalEditPatch — the inline editor's two fields into a PATCH body", () => {
  test("a plain objective and no budget means 'remove the cap'", () => {
    // `null` and "leave it alone" are different patches to the engine, so
    // the empty field is `null` and never an omitted key.
    assert.deepEqual(buildGoalEditPatch("ship it", ""), {
      ok: true,
      patch: { objective: "ship it", tokenBudget: null },
    });
  });

  test("K/M suffixes are accepted, and whitespace is trimmed", () => {
    assert.deepEqual(buildGoalEditPatch("  ship it  ", " 50K ").ok && buildGoalEditPatch("ship it", " 50K "), {
      ok: true,
      patch: { objective: "ship it", tokenBudget: 50_000 },
    });
    assert.deepEqual(buildGoalEditPatch("ship it", "2M"), {
      ok: true,
      patch: { objective: "ship it", tokenBudget: 2_000_000 },
    });
    // `1.5K` is 1500 tokens — a decimal is fine when a suffix carries it.
    assert.deepEqual(buildGoalEditPatch("ship it", "1.5K"), {
      ok: true,
      patch: { objective: "ship it", tokenBudget: 1_500 },
    });
  });

  test("an empty objective is refused", () => {
    for (const objective of ["", "   ", "\n\t"]) {
      assert.deepEqual(buildGoalEditPatch(objective, "50K"), {
        ok: false,
        errorKey: "goal.error.objectiveRequired",
      });
    }
  });

  test("a budget that is not a positive integer is refused", () => {
    // A bare `1.5` is 1.5 TOKENS, which is not a budget — rounding it to 2
    // would spend something nobody asked for, so it is refused. `1.5K` above
    // is the same digits with a suffix and is accepted.
    for (const budget of ["0", "-1", "1.5", "lots", "50 K", "1e5", "1.5.2"]) {
      const result = buildGoalEditPatch("ship it", budget);
      assert.equal(result.ok, false, `${budget} must be refused`);
      if (!result.ok) assert.equal(result.errorKey, "goal.error.budgetInvalid");
    }
  });
});

describe("parseGoalBudgetValue", () => {
  test("multipliers, and a decimal only with a suffix", () => {
    assert.equal(parseGoalBudgetValue("50000"), 50_000);
    assert.equal(parseGoalBudgetValue("50K"), 50_000);
    assert.equal(parseGoalBudgetValue("50k"), 50_000);
    assert.equal(parseGoalBudgetValue("2M"), 2_000_000);
    assert.equal(parseGoalBudgetValue("1.5K"), 1_500);
    assert.equal(parseGoalBudgetValue("1.5"), null);
  });

  test("anything else is null, which the caller reads as invalid or as no cap", () => {
    // The two meanings never share a sentinel: `buildGoalEditPatch` tells
    // them apart by whether the input was empty.
    for (const raw of ["0", "-5", "lots", "", "  ", "1.5"]) {
      assert.equal(parseGoalBudgetValue(raw), null, raw);
    }
  });
});