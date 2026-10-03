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

describe("contextBreakdownRows — the reference's order, and no invented rows", () => {
  test("an absent block produces no rows at all", () => {
    // The engine does not emit `breakdown` today. A panel that drew six
    // zero rows here would be claiming a composition it has no source for.
    assert.deepEqual(contextBreakdownRows(null, 1000), []);
    assert.deepEqual(contextBreakdownRows(undefined, 1000), []);
    assert.deepEqual(contextBreakdownRows({ messages: 10 }, 0), []);
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

  test("a category the engine reported zero for is not drawn", () => {
    const rows = contextBreakdownRows({ messages: 90, tools: 10, memory: 0 }, 100);
    assert.deepEqual(rows.map((r) => r.key), ["messages", "tools"]);
  });

  test("percentages are the share of the window actually used", () => {
    const rows = contextBreakdownRows({ messages: 719, tools: 131, other: 150 }, 1000);
    // Asserted as the panel PRINTS them (toFixed(1)), not as raw floats:
    // 719/1000*100 is 71.89999999999999 in binary, and a strictEqual on the
    // un-rounded number would be asserting the float, not the product.
    assert.equal(row(rows, 0).percent.toFixed(1), "71.9");
    assert.equal(row(rows, 1).percent.toFixed(1), "13.1");
    assert.equal(row(rows, 2).percent.toFixed(1), "15.0");
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
});
