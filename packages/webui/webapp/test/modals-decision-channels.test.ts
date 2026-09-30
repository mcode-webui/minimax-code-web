// webapp/test/modals-decision-channels.test.ts
//
// Ticket 70 — the ask / plan modals had four buttons that accepted a
// click and reached nothing.
//
// The defect: all four posted to `POST /api/answer`, and
// `server/routes/model.js#handleAnswer` was a legacy no-op answering
// `{ok:true, deprecated:true}` without ever touching the engine.
//
// This file pins the fix from three sides, because the three fail in
// different ways:
//
//   1. CHANNEL pins (source, modals.tsx + lib/api.ts) — the four dead
//      call sites are gone and the ask Skip button names the channel it
//      uses. A source pin is the right tool here: the wiring is one call
//      expression, and the component's store/api import graph cannot
//      enter a test process (same structural reason
//      add-model-dialog.test.ts gives for its split).
//
//   2. DICTIONARY pins (behaviour, lib/i18n.ts) — the three labels that
//      named a non-existent capability (Agree / Add context / Skip on the
//      plan prompt) are gone from BOTH dictionaries, and the new keys
//      resolve in both languages. These are real calls into `translate`,
//      not source strings, so a key that drifts back in fails here.
//
//   3. The plan prompt renders no decision at all. The engine has no
//      webui-reachable exit for a plan decision (full trace in
//      components/modals.tsx#PlanModal), so the honest surface is a
//      dismissible notice. Pinned by pins 1 + 2 plus the server-side
//      projection test in test/lib/plan-update-projection.test.js.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { translate, type MessageKey } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const modalsSource = readFileSync(resolve(here, "../components/modals.tsx"), "utf8");
const apiSource = readFileSync(resolve(here, "../lib/api.ts"), "utf8");

/**
 * Source with comments removed.
 *
 * Both files NARRATE the defect in their doc comments (that is where the
 * protocol trace lives), so a raw substring scan would flag the
 * explanation as the crime. The assertions below are about CODE, so the
 * comments are stripped first. String literals are left alone: there is
 * no legitimate reason for a component to hold the dead path as a value,
 * and `"/api/answer"` inside a string would still be a real finding.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const modalsCode = stripComments(modalsSource);
const apiCode = stripComments(apiSource);

describe("ticket 70 — the dead /api/answer channel is unreachable from the modals", () => {
  test("modals.tsx never calls the removed `api.answer` client", () => {
    assert.ok(
      !/api\.answer\s*\(/.test(modalsCode),
      "modals.tsx still calls api.answer(...) — that client hit a no-op endpoint",
    );
  });

  test("modals.tsx never names the /api/answer path", () => {
    assert.ok(
      !modalsCode.includes("/api/answer"),
      "modals.tsx still references /api/answer",
    );
  });

  test("lib/api.ts exports no client for /api/answer", () => {
    // The tombstone comment in api.ts deliberately NAMES the path, so
    // assert on the code with comments stripped, not on the raw file.
    assert.ok(
      !/export const answer\b/.test(apiCode),
      "api.ts re-exported an `answer` client for the removed endpoint",
    );
    assert.ok(
      !/request<[^>]*>\(\s*"\/api\/answer"/.test(apiCode),
      "api.ts still issues a request to /api/answer",
    );
  });

  test("the ask Skip button sends on the isAskAnswer channel", () => {
    // The ask_user answer channel is the ONLY one the engine receives
    // (routes/chat.js reads `isAskAnswer`). Pin the exact expression: a
    // refactor that keeps the button but swaps the channel must fail.
    assert.ok(
      modalsCode.includes(
        '<GhostButton disabled={busy} onClick={() => void reply(t("ask.skipReply"))}>',
      ),
      "the ask Skip button must route through reply(), which posts isAskAnswer",
    );
    assert.ok(
      modalsCode.includes("await api.sendMessage({ content, isAskAnswer: true });"),
      "reply() must keep sending {content, isAskAnswer:true}",
    );
  });
});

describe("ticket 70 — the plan prompt offers no decision it cannot deliver", () => {
  test("none of the three plan decision labels survive in modals.tsx", () => {
    for (const key of ["plan.agree", "plan.addContext", "plan.skip"]) {
      assert.ok(
        !modalsCode.includes(`t("${key}")`),
        `modals.tsx still renders t("${key}") — that button reached a no-op endpoint`,
      );
    }
  });

  test("the plan dialog is dismissible (onClose), not a trap", () => {
    // With no working button, a non-dismissable dialog is a dead end the
    // user cannot leave. The plan prompt is the one blocking-flavour
    // prompt that must pass `onClose`.
    assert.ok(
      /<Modal title=\{plan\.title \|\| t\("plan\.title"\)\} onClose=/.test(modalsCode),
      "the plan dialog must pass onClose so the user can dismiss it",
    );
  });

  test("the plan notice says the review cannot be answered here", () => {
    assert.ok(
      modalsCode.includes('t("plan.readOnlyNotice")'),
      "the plan dialog must state that it cannot answer the review",
    );
    assert.ok(
      modalsCode.includes('data-testid="plan-review-body"'),
      "the plan dialog must render the plan body it received",
    );
  });
});

describe("ticket 70 — dictionary parity for the changed keys", () => {
  const LOCALES = ["en", "zh"] as const;

  test("the removed plan decision labels are gone from BOTH dictionaries", () => {
    const i18nCode = stripComments(
      readFileSync(resolve(here, "../lib/i18n.ts"), "utf8"),
    );
    for (const key of ["plan.agree", "plan.addContext", "plan.skip"]) {
      assert.ok(
        !i18nCode.includes(`"${key}":`),
        `${key} is still in the dictionaries — it labels a capability that does not exist`,
      );
    }
  });

  test("every key the modals need resolves in both languages", () => {
    const needed: MessageKey[] = [
      "plan.title",
      "plan.readOnlyNotice",
      "plan.close",
      "ask.title",
      "ask.other",
      "ask.submit",
      "ask.skip",
      "ask.skipReply",
      "ask.multiSelectHint",
      "auth.title",
      "auth.requested",
      "auth.approve",
      "auth.deny",
    ];
    for (const locale of LOCALES) {
      for (const key of needed) {
        const value = translate(locale, key);
        assert.equal(
          typeof value,
          "string",
          `${locale}.${key} must resolve to a string`,
        );
        assert.ok(
          value.trim().length > 0,
          `${locale}.${key} resolved to an empty string`,
        );
      }
    }
  });

  test("the Skip reply is a real sentence in both languages, not a bare label", () => {
    // It is sent as prompt CONTENT, so a one-word label would reach the
    // agent as a context-free token. Both languages must be non-trivial.
    for (const locale of LOCALES) {
      const reply = translate(locale, "ask.skipReply");
      assert.ok(
        reply.length >= 16,
        `${locale}.ask.skipReply is too short to be a usable prompt: ${JSON.stringify(reply)}`,
      );
    }
  });

  test("the two languages do not carry the same string (no untranslated copy)", () => {
    assert.notEqual(
      translate("en", "ask.skipReply"),
      translate("zh", "ask.skipReply"),
      "ask.skipReply was copy-pasted across languages",
    );
    assert.notEqual(
      translate("en", "plan.readOnlyNotice"),
      translate("zh", "plan.readOnlyNotice"),
      "plan.readOnlyNotice was copy-pasted across languages",
    );
  });
});
