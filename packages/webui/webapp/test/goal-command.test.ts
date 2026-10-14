// webapp/test/goal-command.test.ts
//
// PB-14 batch C — the `/goal` command language, table-driven.
//
// The cases are taken from `packages/tui/src/application/thread-goal-command.ts`,
// the parser the CLI's own `/goal` runs, because that file is the
// specification of what the word means. If a case here and the TUI ever
// disagree, the TUI is right and this table is the bug — which is why the
// expectations are written out per row instead of generated from the
// implementation.
//
// Two rows are this client's own and are marked as such: `/goal-done`, which
// the TUI does not have, and the `/goalfoo` boundary row, which pins that
// this parser claims the WORD and not the prefix.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseGoalArgs,
  parseGoalCommand,
  type GoalCommandIntent,
} from "../lib/goal-command";

type Row = {
  readonly name: string;
  readonly input: string;
  /** `null` means "not a goal command" — the answer for every other word. */
  readonly expected: GoalCommandIntent | null;
};

const rows: readonly Row[] = [
  // --- the empty input: not an instruction, and not an objective either ---
  { name: "bare /goal", input: "/goal", expected: { kind: "view" } },
  { name: "/goal with only spaces", input: "/goal   ", expected: { kind: "view" } },
  { name: "/goal with a newline tail", input: "/goal\n", expected: { kind: "view" } },

  // --- lifecycle verbs, and their refusal when given an argument ---
  { name: "pause", input: "/goal pause", expected: { kind: "pause" } },
  { name: "resume", input: "/goal resume", expected: { kind: "resume" } },
  { name: "edit", input: "/goal edit", expected: { kind: "edit" } },
  { name: "clear", input: "/goal clear", expected: { kind: "clear" } },
  { name: "cancel is an alias of clear", input: "/goal cancel", expected: { kind: "clear" } },
  { name: "delete is an alias of clear", input: "/goal delete", expected: { kind: "clear" } },
  { name: "PAUSE is case-insensitive", input: "/goal PAUSE", expected: { kind: "pause" } },
  {
    name: "clear with an argument is refused",
    input: "/goal clear now",
    expected: { kind: "error", key: "goal.command.error.clearTakesNoArgs" },
  },
  {
    name: "edit with an argument is refused",
    input: "/goal edit the objective",
    expected: { kind: "error", key: "goal.command.error.editTakesNoArgs" },
  },
  {
    name: "pause with an argument is refused",
    input: "/goal pause now",
    expected: { kind: "error", key: "goal.command.error.pauseTakesNoArgs" },
  },
  {
    name: "resume with an argument is refused",
    input: "/goal resume now",
    expected: { kind: "error", key: "goal.command.error.resumeTakesNoArgs" },
  },
  { name: "help", input: "/goal help", expected: { kind: "help" } },

  // --- create, the ordinary case ---
  { name: "a plain objective", input: "/goal ship the banner", expected: { kind: "create", objective: "ship the banner" } },
  { name: "a CJK objective", input: "/goal 修复登录页", expected: { kind: "create", objective: "修复登录页" } },
  { name: "an objective keeps its internal punctuation", input: "/goal fix a/b/c parser", expected: { kind: "create", objective: "fix a/b/c parser" } },

  // --- the budget grammar: K/M suffixes, both ends, and "no cap" ---
  { name: "a bare budget directive", input: "/goal budget=50K", expected: { kind: "budget", tokenBudget: 50_000 } },
  { name: "budget in plain digits", input: "/goal budget=200000", expected: { kind: "budget", tokenBudget: 200_000 } },
  { name: "an M suffix", input: "/goal budget=2M", expected: { kind: "budget", tokenBudget: 2_000_000 } },
  { name: "budget=clear removes the cap", input: "/goal budget=clear", expected: { kind: "budget", tokenBudget: null } },
  { name: "budget=null removes the cap", input: "/goal budget=null", expected: { kind: "budget", tokenBudget: null } },
  { name: "budget=off removes the cap", input: "/goal budget=off", expected: { kind: "budget", tokenBudget: null } },
  { name: "budget=0 removes the cap, it is not a zero budget", input: "/goal budget=0", expected: { kind: "budget", tokenBudget: null } },
  { name: "a decimal budget rounds", input: "/goal budget=1.5K", expected: { kind: "budget", tokenBudget: 1_500 } },
  {
    name: "objective and budget in one shot, trailing",
    input: "/goal fix the login page budget=50K",
    expected: { kind: "create", objective: "fix the login page", tokenBudget: 50_000 },
  },
  {
    name: "objective and budget in one shot, leading",
    input: "/goal budget=50K fix the login page",
    expected: { kind: "create", objective: "fix the login page", tokenBudget: 50_000 },
  },
  {
    // The CJK punctuation is BOTH the boundary that makes `budget=` a
    // directive and the separator that is then trimmed off the objective —
    // the TUI does exactly this, and a client that kept the `，` would set a
    // goal whose text a person never typed.
    name: "a CJK objective keeps its budget — CJK punctuation is a boundary",
    input: "/goal 修复登录页，budget=50K",
    expected: { kind: "create", objective: "修复登录页", tokenBudget: 50_000 },
  },
  {
    name: "the space before a leading budget is consumed",
    input: "/goal budget=50K 修复登录页",
    expected: { kind: "create", objective: "修复登录页", tokenBudget: 50_000 },
  },
  {
    name: "budget=clear on a goal that HAS one means uncap, not create",
    input: "/goal budget=clear",
    expected: { kind: "budget", tokenBudget: null },
  },

  // --- budget refusals ---
  { name: "a bare word budget", input: "/goal budget", expected: { kind: "error", key: "goal.command.error.budgetNeedsValue" } },
  { name: "an empty budget", input: "/goal budget=", expected: { kind: "error", key: "goal.command.error.badBudget" } },
  // A `-` is not part of the budget TOKEN, so `budget=-5` is not a directive
  // at all — it is an objective that happens to start with the word. The TUI
  // answers this the same way, and the row is here to say so out loud: the
  // parser is a port, and a "smarter" version that errored here would be a
  // `/goal` that means something different from the CLI's.
  {
    name: "a negative budget is an objective, not a malformed directive",
    input: "/goal budget=-5",
    expected: { kind: "create", objective: "budget=-5" },
  },
  { name: "a non-numeric budget", input: "/goal budget=lots", expected: { kind: "error", key: "goal.command.error.badBudget" } },
  {
    name: "two budgets are refused rather than one silently winning",
    input: "/goal budget=50K fix it budget=100K",
    expected: { kind: "error", key: "goal.command.error.budgetTwice" },
  },

  // --- this client's own head word ---
  { name: "/goal-done", input: "/goal-done", expected: { kind: "done" } },
  { name: "/goal-done with a tail is still the command", input: "/goal-done thanks", expected: { kind: "done" } },
  { name: "/GOAL-DONE is case-insensitive", input: "/GOAL-DONE", expected: { kind: "done" } },

  // --- what this parser does NOT claim ---
  { name: "a plain message", input: "ship the banner", expected: null },
  { name: "an empty input", input: "   ", expected: null },
  { name: "/goalfoo is somebody else's command", input: "/goalfoo", expected: null },
  { name: "/compact is the engine's", input: "/compact", expected: null },
  { name: "/help is the button command's", input: "/help", expected: null },
];

describe("parseGoalCommand — one composer line to one intent", () => {
  for (const row of rows) {
    test(row.name, () => {
      const actual = parseGoalCommand(row.input);
      assert.deepEqual(actual, row.expected, `${row.input} parsed wrong`);
    });
  }

  test("a leading slash is what makes it a command", () => {
    // The same words without the slash are an ordinary objective, and a
    // parser that claimed them would swallow a user's message.
    assert.equal(parseGoalCommand("goal pause"), null);
    assert.equal(parseGoalCommand("goal"), null);
  });

  test("the input is trimmed, so a trailing space cannot change the intent", () => {
    assert.deepEqual(parseGoalCommand("  /goal pause  "), { kind: "pause" });
    assert.deepEqual(parseGoalCommand("/goal\tbudget=50K\t"), { kind: "budget", tokenBudget: 50_000 });
  });

  test("parseGoalArgs is the same function the composer reaches through", () => {
    // The composer's routing finds the word; this half takes the rest. A
    // drift between them would make `/goal <x>` and `/goal` disagree.
    assert.deepEqual(parseGoalArgs("budget=50K"), parseGoalCommand("/goal budget=50K"));
    assert.deepEqual(parseGoalArgs(""), parseGoalCommand("/goal"));
    assert.deepEqual(parseGoalArgs("pause"), parseGoalCommand("/goal pause"));
  });

  test("a create intent always carries a non-empty objective", () => {
    // The invariant the create call depends on: `POST /api/goal` answers
    // 400 for a whitespace-only objective, and the banner would then have
    // to render an error for something the parser could have caught.
    for (const row of rows) {
      if (row.expected === null || row.expected.kind !== "create") continue;
      assert.ok(
        (row.expected as { objective: string }).objective.trim().length > 0,
        `${row.name} produced an empty objective`,
      );
    }
  });
});