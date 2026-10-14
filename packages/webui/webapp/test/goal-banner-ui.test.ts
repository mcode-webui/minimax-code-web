// webapp/test/goal-banner-ui.test.ts
//
// PB-14 batch C — the banner's render branches, and the wiring that puts it
// on the page.
//
// Same harness as `conversation-usage-banner.test.ts`: the real component
// through `renderToStaticMarkup`, plus source-level tripwires for the two
// wirings that SSR cannot reach (the chat column's gates and the composer's
// `/goal` branch). The tripwires are assertions about the DECISION the
// source makes, not that a testid string exists — each one would fail if the
// gate were inverted or the branch removed.
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

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), "utf8");

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

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(GoalBanner, { locale: "en", ...props } as never),
  );
}

describe("GoalBanner — the render branches", () => {
  test("an active goal shows its status, objective and the three usage numbers", () => {
    const markup = render({ goal: goal() });
    assert.ok(markup.includes('data-goal-status="active"'), markup.slice(0, 400));
    // The STATUS is data, so pin the rendered word: a chip that rendered the
    // key or the raw identifier would still carry the testid.
    assert.ok(markup.includes("In progress"), "the status chip must carry its copy");
    assert.ok(markup.includes("ship the goal banner"), "the objective must be the button's text");
    assert.ok(markup.includes("4096"), "tokensUsed");
    assert.ok(markup.includes(">7<"), "turnsUsed, in its own element");
    // 91 seconds formats as `1min31s`.
    assert.ok(markup.includes("1min31s"), "the elapsed timer");
  });

  test("the banner announces itself politely, and the objective is the edit control", () => {
    const markup = render({ goal: goal() });
    assert.ok(markup.includes('role="status"'));
    assert.ok(markup.includes('aria-live="polite"'));
    // The objective IS the button — one control, not a button plus a
    // separate "edit" button that does the same thing.
    assert.ok(
      /<button[^>]*data-testid="thread-goal-objective"/.test(markup),
      "the objective must be a button",
    );
    assert.ok(!markup.includes('data-testid="thread-goal-edit-button"'), "no second edit control");
  });

  test("an active goal offers exactly pause", () => {
    const markup = render({ goal: goal() });
    assert.ok(markup.includes('data-testid="thread-goal-pause"'));
    assert.ok(!markup.includes('data-testid="thread-goal-resume"'));
    assert.ok(!markup.includes('data-testid="thread-goal-clear"'));
  });

  test("an active goal that is WAITING shows the wait line and offers nothing", () => {
    // Pausing a goal that owes the user a permission prompt would strand the
    // prompt with no goal to resume into, so the action slot is empty.
    const markup = render({
      goal: goal({ executionWait: { reason: "permission" } }),
    });
    assert.ok(markup.includes('data-testid="thread-goal-wait"'));
    assert.ok(markup.includes("Waiting for your permission"), markup);
    assert.ok(!markup.includes('data-testid="thread-goal-pause"'));
  });

  test("an unknown wait reason still renders a waiting line", () => {
    const markup = render({
      goal: goal({ executionWait: { reason: "teleportation" } }),
    });
    assert.ok(markup.includes('data-testid="thread-goal-wait"'));
    assert.ok(markup.includes("Waiting for the runtime to be ready"));
  });

  test("a paused goal offers resume and clear", () => {
    const markup = render({ goal: goal({ status: "paused" }) });
    assert.ok(markup.includes("Paused"));
    assert.ok(markup.includes('data-testid="thread-goal-resume"'));
    assert.ok(markup.includes('data-testid="thread-goal-clear"'));
    assert.ok(!markup.includes('data-testid="thread-goal-pause"'));
  });

  test("a complete goal says so, offers close, and is not editable", () => {
    const markup = render({ goal: goal({ status: "complete" }) });
    assert.ok(markup.includes("Completed"));
    assert.ok(markup.includes("This goal is complete"), "the guidance line");
    assert.ok(markup.includes('data-testid="thread-goal-close"'));
    assert.ok(!markup.includes('data-testid="thread-goal-clear"'));
    // A finished goal has nothing left to edit, so the objective control is
    // disabled rather than opening an editor that would PATCH a closed goal.
    assert.ok(
      /data-testid="thread-goal-objective"[^>]*disabled/.test(markup),
      "a complete goal's objective must be disabled",
    );
  });

  test("a budget-limited goal keeps its banner, explains itself, and offers no action", () => {
    const markup = render({ goal: goal({ status: "budget_limited" }) });
    assert.ok(markup.includes("Budget reached"));
    assert.ok(markup.includes("Create a new goal to carry on"));
    assert.ok(!markup.includes('data-testid="thread-goal-resume"'));
    assert.ok(!markup.includes('data-testid="thread-goal-clear"'));
  });

  test("a usage-limited goal names the provider, not the user", () => {
    const markup = render({ goal: goal({ status: "usage_limited" }) });
    assert.ok(markup.includes("Provider limited"));
    // The apostrophe is HTML-escaped by `renderToStaticMarkup`, so the
    // assertion stops before it rather than asserting on the escape.
    assert.ok(markup.includes("once the provider"));
  });

  test("a status this build does not name still renders the whole banner", () => {
    // Losing the objective and the token count over one unfamiliar field
    // would be a far worse failure than an unrecognised chip.
    const markup = render({ goal: goal({ status: "hibernating" }) });
    assert.ok(markup.includes('data-goal-status="hibernating"'));
    assert.ok(markup.includes("Unrecognised state"));
    assert.ok(markup.includes("ship the goal banner"));
  });

  test("a goal with no usage numbers renders zeros, not blanks", () => {
    const markup = render({
      goal: { goalId: "g", sessionId: "s", objective: "bare", status: "active" },
    });
    assert.ok(markup.includes(">0<"), "tokens and turns default to zero");
    assert.ok(markup.includes(">0s<"), "and the timer to zero");
  });

  test("the localised copy follows the locale, not the component", () => {
    const zh = renderToStaticMarkup(
      createElement(GoalBanner, { locale: "zh", goal: goal() } as never),
    );
    assert.ok(zh.includes("进行中"), zh.slice(0, 300));
    assert.ok(zh.includes("轮"), "the turns unit is localised too");
    const en = render({ goal: goal() });
    assert.ok(en.includes("turns"));
  });

  test("a busy turn disables the action slot", () => {
    const markup = render({ goal: goal(), busy: true });
    assert.ok(
      /data-testid="thread-goal-pause"[^>]*disabled/.test(markup),
      "the pause control must be disabled while a turn runs",
    );
  });
});

describe("the two wirings SSR cannot reach", () => {
  const chat = read("../components/chat.tsx");
  const composer = read("../components/composer.tsx");
  const commands = read("../../server/lib/interaction/commands.js");
  const registry = read("../../server/lib/interaction/command-registry.js");

  test("the chat column gates the banner on BOTH the engine flag and a readable frame", () => {
    // Either gate alone would be a defect: `threadGoal` alone paints a card
    // on an engine that has goals switched off, and the flag alone paints a
    // permanently empty card on one that has none.
    //
    // PB-14 batch D rewrote the first half of this assertion. Batch C read the
    // snapshot inline (`goalEnabled === true ? readThreadGoal(state.threadGoal)
    // : null`), and batch D moved that decision into `useThreadGoal`, which
    // additionally refuses a frame it cannot attribute to the session on
    // screen. The gate is still two gates — it is simply expressed as the
    // `enabled:` argument to the hook rather than as a ternary in the column.
    assert.ok(
      /enabled:\s*goalEnabled === true/.test(chat),
      "the banner must require the enabled flag AND a frame readThreadGoal accepted",
    );
    assert.ok(
      /useThreadGoal\(\{/.test(chat),
      "the banner's goal must come from the session-bound hook, not a raw snapshot read",
    );
    assert.ok(
      /\{threadGoal \? \(\s*<GoalBanner/.test(chat),
      "the banner must be mounted on the threadGoal, not on the flag",
    );
  });

  test("the composer claims /goal only when the engine has goals on", () => {
    assert.ok(
      /peekGoalEnabled\(\) === true[^\n]*parseGoalCommand\(/.test(composer),
      "the /goal branch must be gated on the engine's own flag",
    );
    assert.ok(
      /peekGoalEnabled\(\) === true && attachments\.length === 0 \? parseGoalCommand/.test(composer),
      "and must not claim a line that carries an @file attachment",
    );
  });

  test("the composer never routes a goal line to /api/send", () => {
    // The failure this batch removes: `bodyGoal` returned
    // `continueMcode: true`, so `/goal <text>` was forwarded to the engine as
    // an ordinary message while the chat line claimed a goal had been set.
    assert.ok(
      /if \(goalIntent\) \{\s*await dispatchGoalCommand\(goalIntent, content\);\s*return;/.test(composer),
      "a parsed goal must leave the composer before routeSlashInput is reached",
    );
    const branchAt = composer.indexOf("parseGoalCommand(content)");
    const routeAt = composer.indexOf("routeSlashInput(content)");
    assert.ok(branchAt < routeAt, "the goal branch must come first in submit()");
  });

  test("the retired webui-local goal handlers are GONE, not merely unused", () => {
    // Retiring a command means the code that produced the illusion is
    // deleted. Leaving it behind would keep `cs.goal` writable through a
    // path that still claims to the user that a goal had been set.
    assert.ok(!/function bodyGoal\b/.test(commands), "bodyGoal must not exist");
    assert.ok(!/function bodyGoalClose\b/.test(commands), "bodyGoalClose must not exist");
    assert.ok(!/case "goal-done":/.test(commands), "no local /goal-done case");
    assert.ok(!/cs\.goal =/.test(commands), "nothing may still write the cs.goal slot");
  });

  test("PB-14 batch D: no writer of the retired `goal` slot survives anywhere", () => {
    // Batch C removed the `/goal` handler; batch D removes the SLOT. The
    // handler was not the only writer: `server/lib/mcode-acp.js` still had a
    // `goal_update` branch and `server/routes/debug.js` could inject the field
    // from a request body. Both are how a browser ends up showing a goal the
    // engine does not have, so the sweep covers all three files rather than
    // trusting the one batch C touched.
    const acp = read("../../server/lib/mcode-acp.js");
    const debugRoute = read("../../server/routes/debug.js");
    const bus = read("../../server/lib/state-bus.js");
    assert.ok(!/cs\.goal\s*=/.test(acp), "the ACP goal_update branch must not write cs.goal");
    assert.ok(!/cs\.goal\s*=/.test(debugRoute), "the debug route must not write cs.goal");
    assert.ok(
      !/^\s*goal:\s*\{/m.test(bus),
      "the default per-cid state must no longer declare a `goal` slot",
    );
    // `threadGoal` is the engine's and must survive — this assertion is what
    // makes the two above a retirement rather than a blanket deletion.
    assert.ok(/threadGoal:\s*null/.test(bus), "the engine's goal slot must remain");
  });

  test("the send-path command declaration no longer advertises the goal words", () => {
    // The 400 branch names `SEND_SLASH_COMMANDS` to the user, so leaving the
    // three names here would keep advertising a command nothing implements.
    const block = registry.slice(
      registry.indexOf("export const SEND_SLASH_COMMANDS"),
      registry.indexOf("const CMD_BUTTON_NAME_SET"),
    );
    for (const name of ["goal", "goal-done", "goal-blocked"]) {
      assert.ok(
        !new RegExp(`"${name}"`).test(block),
        `${name} must be out of SEND_SLASH_COMMANDS`,
      );
    }
  });
});