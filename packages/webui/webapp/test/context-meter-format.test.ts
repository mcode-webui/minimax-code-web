// webapp/test/context-meter-format.test.ts
//
// The context-window panel (roadmap H, 模型与用量).
//
// Split in two on purpose:
//
// 1. The pure logic — `formatPercent`, `contextBreakdownRows`,
//    `quotaPlanRows` — lives in `lib/context-breakdown.ts` and is DRIVEN HERE
//    as imported product code. The previous version of this file re-declared
//    `formatPercent` locally and asserted its own copy, so editing the
//    component could not fail it; that mirror is gone.
//
// 2. The panel's SHAPE is a tripwire over the component's source, because a
//    unit test cannot see that the component calls the right things: a panel
//    that inlined its own percentage math, or went back to reading the dead
//    `context.plan`, would leave every assertion above green.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  CONTEXT_BREAKDOWN_CATEGORIES,
  contextBreakdownRows,
  formatPercent,
  quotaPlanRows,
  showPlanSection,
} from "../lib/context-breakdown";
import type { QuotaSnapshot } from "../lib/api";

const here = dirname(fileURLToPath(import.meta.url));
const meterSource = readFileSync(
  resolve(here, "../components/context-meter.tsx"),
  "utf8",
);
const i18nSource = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");
const typesSource = readFileSync(resolve(here, "../lib/types.ts"), "utf8");
const stateBusSource = readFileSync(
  resolve(here, "../../server/lib/state-bus.js"),
  "utf8",
);

/** The five bands the header percentage has. The panel is a 1:1 replica, so
 *  "29%" for 29.4 and "<1%" for a real-but-tiny reading are both load-bearing:
 *  a user watching a long session must be able to tell "nothing yet" from
 *  "a little". */
const T = (key: string) => (key === "context.lessThanOne" ? "<1%" : key);

/**
 * `rows[i]`, with the element's existence asserted.
 *
 * `noUncheckedIndexedAccess` makes every index `T | undefined`, and a `!`
 * would say "trust me" at each of a dozen call sites. This says it once, and
 * turns a shape change into a failure HERE rather than an `undefined`
 * comparison three assertions later — which reads as a wrong value instead of
 * a missing one.
 */
function row<T>(rows: T[], index: number): T {
  const value = rows[index];
  assert.ok(value !== undefined, `row ${index} is missing (length ${rows.length})`);
  return value;
}

/**
 * What a row PRINTS — the same two branches the component renders, one decimal
 * or a dash. A helper rather than a string literal at each call site so the
 * expectation cannot drift from the rule the component is held to.
 */
function printed(r: { percent: number | null }): string {
  return r.percent === null ? "—" : `${r.percent.toFixed(1)}%`;
}

describe("formatPercent — the five bands", () => {
  test("zero and negative are 0%", () => {
    assert.equal(formatPercent(0, T), "0%");
    assert.equal(formatPercent(-3.7, T), "0%");
  });

  test("a real but sub-1% reading is <1%, never 0%", () => {
    // 1521/512000 ≈ 0.297% — the case that motivated the band.
    assert.equal(formatPercent(0.3, T), "<1%");
    assert.equal(formatPercent(0.999, T), "<1%");
  });

  test("1–10% keeps one decimal, 10%+ is an integer", () => {
    assert.equal(formatPercent(1, T), "1.0%");
    assert.equal(formatPercent(3.5, T), "3.5%");
    assert.equal(formatPercent(9.94, T), "9.9%");
    assert.equal(formatPercent(10, T), "10%");
    assert.equal(formatPercent(47.4, T), "47%");
    assert.equal(formatPercent(99.5, T), "100%");
  });
});

describe("contextBreakdownRows — all six, always, and never a number we made up", () => {
  test("an absent block still lists all six rows, every share unknown", () => {
    // The engine emits no `breakdown` today and nothing in this stack can
    // reconstruct one. That is not a reason to hide the section: the six
    // categories ARE the reference's, so the panel lists them and says it
    // has no figure for each. Returning an empty list here is what made the
    // section undrawable.
    for (const absent of [null, undefined]) {
      const rows = contextBreakdownRows(absent, 1000);
      assert.equal(rows.length, CONTEXT_BREAKDOWN_CATEGORIES.length);
      for (const r of rows) {
        assert.equal(r.tokens, null, `${r.key} was not reported`);
        assert.equal(r.percent, null, `${r.key} must not carry a share`);
      }
    }
  });

  test("rows come back in the screenshot's order, not the payload's key order", () => {
    const rows = contextBreakdownRows(
      { systemPrompt: 30, other: 32, skills: 33, memory: 55, tools: 131, messages: 719 },
      1000,
    );
    assert.deepEqual(
      rows.map((r) => r.key),
      ["messages", "tools", "memory", "skills", "other", "systemPrompt"],
      "the reference draws 消息 → 工具 → 记忆 → 技能 → 其他 → 系统提示词",
    );
  });

  test("a category reported as 0 is 0%, not a dash", () => {
    // The distinction the dash exists to preserve: the engine SAID this
    // category is empty, which is a fact worth printing. Silence is not.
    const rows = contextBreakdownRows({ messages: 90, tools: 10, memory: 0 }, 100);
    assert.equal(row(rows, 0).percent, 90);
    assert.equal(row(rows, 1).percent, 10);
    assert.equal(row(rows, 2).tokens, 0);
    assert.equal(row(rows, 2).percent, 0);
  });

  test("a category missing from a block that did arrive is still a dash", () => {
    // A partial payload is the realistic shape of a feature being turned on
    // engine-side, and it must not make the unreported half look empty.
    const rows = contextBreakdownRows({ messages: 100 }, 100);
    assert.equal(row(rows, 0).percent, 100);
    assert.equal(row(rows, 1).tokens, null);
    assert.equal(row(rows, 1).percent, null);
  });

  test("a non-finite or negative count is unknown, not a share", () => {
    // NaN / Infinity arriving over SSE must not become NaN% in the panel, and
    // a negative count is not a share of anything.
    const rows = contextBreakdownRows({ messages: NaN, tools: Infinity, memory: -50 }, 100);
    assert.equal(row(rows, 0).percent, null);
    assert.equal(row(rows, 1).percent, null);
    assert.equal(row(rows, 2).tokens, 0, "a negative count clamps to 0, it is not unknown");
    assert.equal(row(rows, 2).percent, 0);
  });

  test("a reported count with a zero total is unknown — no division by zero", () => {
    const rows = contextBreakdownRows({ messages: 500 }, 0);
    assert.equal(row(rows, 0).tokens, 500, "the engine did report it");
    assert.equal(row(rows, 0).percent, null, "but its share of nothing is not a number");
  });

  test("percentages are the share of the window actually used", () => {
    const rows = contextBreakdownRows({ messages: 719, tools: 131, other: 150 }, 1000);
    // Asserted as the panel PRINTS them (toFixed(1)), not as raw floats:
    // 719/1000*100 is 71.89999999999999 in binary, and a strictEqual on the
    // un-rounded number would be asserting the float, not the product.
    // Indexed by position in the full six, so a row this block skipped is
    // still asserted — as a dash, at its own slot.
    assert.equal(printed(row(rows, 0)), "71.9%");
    assert.equal(printed(row(rows, 1)), "13.1%");
    assert.equal(printed(row(rows, 2)), "—");
    assert.equal(printed(row(rows, 3)), "—");
    assert.equal(printed(row(rows, 4)), "15.0%");
    assert.equal(printed(row(rows, 5)), "—");
  });

  test("every row carries a label key the dictionaries define in both languages", () => {
    for (const key of CONTEXT_BREAKDOWN_CATEGORIES) {
      assert.equal(
        (i18nSource.match(new RegExp(`"${key.labelKey}"`, "g")) ?? []).length,
        2,
        `${key.labelKey} must exist in the en and zh buckets`,
      );
    }
  });

  test("the dash has words behind it in both languages", () => {
    // An em dash alone tells a screen-reader user nothing about whether the
    // figure is zero or merely absent, which is the whole distinction here.
    assert.equal(
      (i18nSource.match(/"context\.breakdown\.unreported"/g) ?? []).length,
      2,
      "context.breakdown.unreported must exist in the en and zh buckets",
    );
  });
});

describe("quotaPlanRows — the settings page's two figures, read the same way", () => {
  const snapshot = (over: Partial<QuotaSnapshot>): QuotaSnapshot => ({ ok: true, ...over });

  test("there are exactly two rows, and the video figure is not one of them", () => {
    assert.deepEqual(quotaPlanRows(snapshot({})).map((r) => r.key), ["fiveHour", "weekly"]);
  });

  test("remaining is what is left; the bar reports what was used", () => {
    const rows = quotaPlanRows(snapshot({ remaining: 100, weeklyRemaining: 84 }));
    assert.equal(row(rows, 0).used, 0);
    assert.equal(row(rows, 1).used, 16);
  });

  test("a missing figure stays null — 'we know nothing' is not 0%", () => {
    const rows = quotaPlanRows(snapshot({}));
    assert.equal(row(rows, 0).used, null);
    assert.equal(row(rows, 1).used, null);
  });

  test("a failed read is not a figure", () => {
    const rows = quotaPlanRows({ ok: false, remaining: 100, weeklyRemaining: 84 });
    assert.equal(row(rows, 0).used, null);
    assert.equal(row(rows, 1).used, null);
  });

  test("out-of-range remaining is clamped, not trusted", () => {
    const rows = quotaPlanRows(snapshot({ remaining: 140, weeklyRemaining: -20 }));
    assert.equal(row(rows, 0).used, 0);
    assert.equal(row(rows, 1).used, 100);
  });

  test("the 5-hour row prints a total, the weekly row does not", () => {
    const rows = quotaPlanRows(snapshot({}));
    assert.equal(row(rows, 0).withTotal, true);
    assert.equal(row(rows, 1).withTotal, false);
  });

  test("the reset instants travel with the rows", () => {
    const rows = quotaPlanRows(snapshot({ resetAt: 111, weeklyResetAt: 222 }));
    assert.equal(row(rows, 0).resetAt, 111);
    assert.equal(row(rows, 1).resetAt, 222);
  });
});

describe("showPlanSection — Token Plan meters MiniMax usage, so it follows the model", () => {
  test("a MiniMax builtin model gets the section", () => {
    for (const name of ["minimax_api/MiniMax-M3", "minimax_api/MiniMax-M3.1-Flash-Preview", "minimax_api/MiniMax-M2"]) {
      assert.equal(showPlanSection(name), true, name);
    }
  });

  test("every other provider's model does not", () => {
    // The case this rule exists for: a Token Plan subscriber driving a BYOK
    // model. The 5-hour and weekly windows meter MiniMax usage, so beside
    // glm-5.3 they are a factually wrong reading rather than a stale one.
    for (const name of [
      "zhipu-ai-coding-plan/glm-5.3",
      "openai_compat/gpt-4o-mini",
      "anthropic/claude-sonnet-4",
      "__engine/m:minimax_api:MiniMax-M3:u",
    ]) {
      assert.equal(showPlanSection(name), false, name);
    }
  });

  test("no model, or an id with no readable provider, hides it", () => {
    // The failure directions are not symmetric: hiding the block costs a
    // missing section, showing MiniMax's plan next to someone else's model is
    // a wrong fact. Anything unrecognised therefore takes the safe branch.
    for (const name of [null, undefined, "", "   ", "MiniMax-M3", "/MiniMax-M3", "minimax_api/"]) {
      assert.equal(showPlanSection(name), false, JSON.stringify(name));
    }
  });

  test("the decision reads the provider prefix, not a substring of the model name", () => {
    // A BYOK provider may legitimately ship a model NAMED something with
    // "minimax" in it; matching anywhere in the string would grant it the
    // MiniMax plan.
    assert.equal(showPlanSection("openai_compat/my-MiniMax-M3-clone"), false);
    assert.equal(showPlanSection("not_minimax_api/MiniMax-M3"), false);
  });
});

/**
 * The component's code with its comments removed.
 *
 * Two guards below assert that a field is NOT read, and the file explains in
 * prose that it used to read it — so a plain `includes` matches the sentence
 * saying so and the guard fails on correct code. Stripping the comments first
 * is what makes "the code does not touch X" mean the code, not the writing
 * about it.
 *
 * Scoped to this one file, which contains no `//` inside a string literal; a
 * general-purpose stripper would need to tokenise, and a tokeniser here would
 * be a second thing to keep correct.
 */
const meterCode = meterSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the panel is the reference's, not a shape of its own", () => {
  test("the disclosure chevron points down collapsed and up expanded", () => {
    // The panel grows upward (it opens above the composer), so the arrow
    // points the way the content went. chevronRight was a sideways
    // affordance for a vertical one.
    assert.match(
      meterSource,
      /name=\{expanded \? "chevronUp" : "chevronDown"\}/,
      "collapsed → chevronDown, expanded → chevronUp",
    );
    assert.ok(
      !meterSource.includes('"chevronRight"'),
      "the context panel no longer draws a right-chevron",
    );
  });

  test("the bar is one segment; the composition lives in the rows", () => {
    assert.ok(
      !meterSource.includes("context-progress-segmented"),
      "the segmented bar is gone — the reference draws one solid bar",
    );
    assert.match(meterSource, /data-testid="context-progress-bar"/);
  });

  test("the 已用 row is gone — the header's percentage already says it", () => {
    assert.ok(
      !meterSource.includes('t("context.used")'),
      "the panel must not print 已用 / 总量 a second time",
    );
    assert.equal(
      (i18nSource.match(/"context\.used"/g) ?? []).length,
      0,
      "and the label loses its last consumer, so it leaves both dictionaries",
    );
  });

  test("the plan section draws the settings page's UsageBar, off the quota store", () => {
    assert.match(meterSource, /const \{ state, quota \} = useSessionContext\(\)/);
    assert.match(meterSource, /<UsageBar/);
    assert.match(meterSource, /resetCaption\(row\.resetAt, t\)/);
    // `context.planTitle` is the 套餐用量 label and shares the prefix, so
    // the guard excludes it — a plain `includes("context.plan")` fails on
    // the legitimate key and would have been "fixed" by renaming it.
    assert.ok(
      !/context\.plan(?!Title)/.test(meterCode),
      "the panel must not read the state block's dead `plan` field",
    );
  });

  test("`context.plan` is gone from the wire too, not just unread", () => {
    // A field with no producer and no reader is the same dead chain the
    // model picker's add-provider deep-link was, one round earlier.
    assert.ok(
      !/plan\?: ContextPlanSection/.test(typesSource),
      "ContextPlanSection had one reader, the panel, and it is gone",
    );
    assert.ok(
      !/ContextPlanSection|ContextPlanRow/.test(typesSource),
      "neither shape survives in the client contract",
    );
    const contextBlock = stateBusSource.slice(
      stateBusSource.indexOf("context: {"),
      stateBusSource.indexOf("usage: {"),
    );
    assert.ok(
      !/^\s*plan: null,/m.test(contextBlock),
      "the server stops shipping a `context.plan` nobody can reach",
    );
  });

  test("the panel's title carries the plan name only when there is one", () => {
    assert.match(
      meterSource,
      /\{planTitle \? ` · \$\{planTitle\}` : ""\}/,
      "套餐用法 · <tier> when the engine names a plan, bare 套餐用量 when it does not",
    );
  });

  test("the six rows draw on `expanded` alone, not on the engine having answered", () => {
    // This is the guard the bug needed. The section was gated on
    // `breakdown.length > 0`, so with no engine data the whole block never
    // rendered and the panel looked unfinished — the exact symptom the
    // section is now always-on to fix. Re-gating it on a non-empty list
    // silently undoes the change with every test above still green.
    assert.ok(
      !/breakdown\.length\s*[><=]/.test(meterCode),
      "the breakdown must not be gated on the engine having reported rows",
    );
    assert.match(meterCode, /\{expanded \? \(/, "expansion alone decides the section");
  });

  test("an unknown share prints a dash, and only a dash", () => {
    // `percent.toFixed(1)` unguarded would print "NaN%" for a category the
    // engine skipped, and `?? "—"` after a division would print it for a
    // reported 0. The branch has to test the null itself.
    assert.match(meterCode, /row\.percent === null/);
    assert.ok(
      !/row\.percent\?\.toFixed/.test(meterCode),
      "the share must not be printed by optional-chaining a null to undefined",
    );
    assert.match(meterSource, /<span aria-hidden="true">—<\/span>/);
    assert.match(meterSource, /sr-only">\{t\("context\.breakdown\.unreported"\)\}/);
  });

  test("the 套餐 section is gated on the model, not left unconditional", () => {
    // The pure `showPlanSection` tests above pin the decision; this pins the
    // wiring, because a panel that computed the flag and then rendered the
    // section anyway would leave every one of them green.
    assert.match(meterCode, /const showPlan = showPlanSection\(state\?\.model\?\.name\)/);
    assert.match(meterCode, /\{showPlan \? \(\s*<section/, "the section is conditional");
  });

  test("the ring's hover names the control; the aria-label keeps the action", () => {
    // A tooltip that repeats the aria-label told the user nothing they could
    // not read off the button they were pointing at — and the panel's own
    // title already says 上下文窗口.
    assert.match(meterSource, /title=\{t\("context\.title"\)\}/);
    assert.match(meterSource, /aria-label=\{t\("context\.show"\)\}/);
  });
});
