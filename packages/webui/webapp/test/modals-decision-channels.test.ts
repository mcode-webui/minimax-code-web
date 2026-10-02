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

describe("UAT fix — the authorize button's label is legible in BOTH themes", () => {
  // The reported symptom was a blank 「批准」 button. The string was always
  // there (pinned above); the LABEL COLOUR was the defect, so a
  // string assertion could never have caught it. These tests resolve the
  // real design tokens out of styles/tokens.css and assert the pair the
  // button renders is legible in each theme.

  const tokensCss = readFileSync(resolve(here, "../styles/tokens.css"), "utf8");

  /**
   * The declarations of every top-level `:root { }` / `.dark { }` block,
   * merged. tokens.css is split into many sibling blocks (primitives, then
   * one per semantic group) rather than a single one, so a reader that
   * stops at the first block would only ever see the colour ramp.
   */
  const blockVars = (selector: ":root" | ".dark"): Map<string, string> => {
    const vars = new Map<string, string>();
    const open = new RegExp(`^${selector} \\{`, "gm");
    let match: RegExpExecArray | null;
    while ((match = open.exec(tokensCss)) !== null) {
      const body = tokensCss.slice(match.index, tokensCss.indexOf("\n}", match.index));
      for (const line of body.split("\n")) {
        const declaration = /^\s*(--[\w-]+):\s*(.+?);\s*$/.exec(line);
        if (declaration) vars.set(declaration[1]!, declaration[2]!);
      }
    }
    assert.ok(vars.size > 0, `no ${selector} block found in tokens.css`);
    return vars;
  };

  /** Follow `var(--x)` indirections until a literal value is reached. */
  const resolveToken = (vars: Map<string, string>, name: string, depth = 0): string => {
    if (depth > 8) throw new Error(`token cycle at ${name}`);
    const value = vars.get(name);
    if (value === undefined) throw new Error(`token ${name} is not defined`);
    const inner = /^var\((--[\w-]+)\)$/.exec(value);
    return inner ? resolveToken(vars, inner[1]!, depth + 1) : value.trim();
  };

  // `.dark` only carries the semantic overrides; the primitives stay in
  // `:root`, so the dark resolution layers the two.
  const light = blockVars(":root");
  const dark = new Map([...light, ...blockVars(".dark")]);

  /**
   * Composite a text colour over an opaque fill — the colour a pixel of the
   * label actually takes.
   *
   * Needed because the old label is not pure white: the dark theme sets it
   * to 80%-white (`#fffc`, the four-digit `#rgba` CSS form). Over an opaque
   * white fill that composites to exactly the fill, which is why comparing
   * the raw hex strings would have missed the defect while the button was
   * plainly unreadable.
   */
  const compositeOver = (text: string, fill: string): string => {
    /** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → [r, g, b, a] with a in 0..1. */
    const channels = (value: string): [number, number, number, number] => {
      const digits = value.slice(1).toLowerCase();
      assert.match(digits, /^([0-9a-f]{3,8})$/, `unsupported colour literal: ${value}`);
      const wide = digits.length <= 4
        ? [...digits].map((digit) => digit + digit).join("")
        : digits;
      const byte = (index: number) => Number.parseInt(wide.slice(index, index + 2), 16);
      return [byte(0), byte(2), byte(4), wide.length === 8 ? byte(6) / 255 : 1];
    };
    const [tr, tg, tb, alpha] = channels(text);
    const [fr, fg, fb] = channels(fill);
    const over = (t: number, f: number) =>
      Math.round(t * alpha + f * (1 - alpha))
        .toString(16)
        .padStart(2, "0");
    return `#${over(tr, fr)}${over(tg, fg)}${over(tb, fb)}`;
  };

  test("the defect is reproducible on the token pair the button used to render", () => {
    // Regression context, stated as an executable claim: the old pairing
    // composited to the fill in the dark theme. If a future token
    // regeneration ever themes `--text_default_inverted_static`, this stops
    // holding and the note in modals.tsx must be revisited.
    const background = resolveToken(dark, "--bg_interaction_primary_default");
    const oldLabel = resolveToken(dark, "--text_default_inverted_static");
    assert.equal(
      compositeOver(oldLabel, background),
      compositeOver(background, background),
      "the dark theme is expected to invert the primary fill to white and leave " +
        "the label 80%-white — that pair is what made 「批准」 unreadable",
    );
    // Light theme was never affected, and saying so keeps the fix honest
    // about what it changes.
    const lightFill = resolveToken(light, "--bg_interaction_primary_default");
    const lightLabel = resolveToken(light, "--text_default_inverted_static");
    assert.notEqual(
      compositeOver(lightLabel, lightFill),
      compositeOver(lightFill, lightFill),
    );
  });

  test("the label token the button now uses contrasts with the fill in BOTH themes", () => {
    for (const theme of [
      { name: ":root", vars: light },
      { name: ".dark", vars: dark },
    ]) {
      const background = resolveToken(theme.vars, "--bg_interaction_primary_default");
      const label = resolveToken(theme.vars, "--text_label_primary_default");
      assert.notEqual(
        compositeOver(label, background),
        compositeOver(background, background),
        `${theme.name}: the primary button would render its label invisibly ` +
          `(${label} on ${background})`,
      );
    }
  });

  test("PrimaryButton pairs the primary fill with the matching label token", () => {
    // The same pairing the upstream `.mavis-button.black` rule uses
    // (styles/official-utilities.css), so this button now matches the
    // reference skin in both themes.
    const primary = /<button[\s\S]*?className="([^"]*bg-bg_interaction_primary_default[^"]*)"/.exec(
      modalsCode,
    );
    assert.ok(primary, "PrimaryButton must keep the primary fill");
    assert.match(
      primary[1]!,
      /text-text_label_primary_default/,
      "the label must use --text_label_primary_default, the token that pairs with the fill",
    );
    assert.doesNotMatch(
      primary[1]!,
      /text-text_default_inverted_static/,
      "--text_default_inverted_static is near-white in BOTH themes and vanishes on the dark fill",
    );
  });

  test("the upstream reference rule agrees on the pairing", () => {
    const utilities = readFileSync(
      resolve(here, "../styles/official-utilities.css"),
      "utf8",
    );
    assert.match(
      utilities,
      /\.mavis-button\.black \{[^}]*background-color:var\(--bg_interaction_primary_default\);color:var\(--text_label_primary_default\)/,
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
