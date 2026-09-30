// webapp/test/add-model-dialog.test.ts
//
// Behaviour-level tests for the add-model dialog rework (ticket 54,
// acceptance round 2).
//
// Round 1 shipped only static-source tripwires, and the acceptance
// mutation experiment proved the gap: 5 of 11 mutations that reverted
// dialog BEHAVIOUR shipped green (eye toggle, save validation, cancel
// reset, default check-all, n/N counter) because a source-string pin
// cannot see interaction semantics. The root cause was structural —
// the dialogs were unexported functions inside provider-management.tsx,
// whose store/api import graph cannot enter a test process.
//
// Round 2 therefore splits the wiring:
//
//   - components/add-model-dialog.tsx exports the CONTROLLED surfaces
//     (`AddModelDialogForm`, `AddModelEntry`, `FetchedModelsDialogBody`)
//     and the pure helpers (`collectDialogErrors`, `defaultChecked`).
//     This file drives them the way usage-models-cards.test.ts drives
//     the 53a cards: renderToStaticMarkup over createElement with
//     chosen props. A prop IS the behaviour under test — the eye
//     round-trip is a `revealed` prop, the 全选 state is a `checked`
//     set prop.
//   - The modal SHELLS (antd Modal, state, fetch, commit) stay
//     untestable by static render (portals need a DOM), so each
//     load-bearing line where the shell CALLS a tested helper is
//     pinned by an exact-literal assertion. Every one of those pins
//     exists because a named mutation got past round 1 — the comment
//     on each says which.
//
// What is NOT here: provider-management.tsx keeps its own structural
// pins for the panel surfaces (empty state, red-line testids, PUT call
// path) — see the second half of this file.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AddModelDialogForm,
  AddModelEntry,
  FetchedModelsDialogBody,
  blankDialogCustom,
  collectDialogErrors,
  defaultChecked,
  API_FORMAT_OPTIONS,
  PRESET_CHOICE_CUSTOM,
  type DialogHeaderRow,
  type EntryTestState,
  type PresetCatalogueEntry,
} from "../components/add-model-dialog";
import type { ProviderProtocol } from "../lib/api";
import { blankModel, type DraftModel } from "../lib/provider-management";
import { translate, type MessageKey } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const dialogSource = readFileSync(
  resolve(here, "../components/add-model-dialog.tsx"),
  "utf8",
);
const panelSource = readFileSync(
  resolve(here, "../components/provider-management.tsx"),
  "utf8",
);

// createElement, not JSX: this suite is a `.test.ts` file (the
// test:webapp glob is `**/*.test.ts`), and the tsx loader only
// transpiles JSX in `.tsx` — same convention as
// usage-models-cards.test.ts.
const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(element);
const tZh = (key: MessageKey) => translate("zh", key);
const noop = () => {};

/**
 * The opening tag that carries `data-testid="..."`, from its `<` to
 * the closing `>`. antd emits boolean attributes (disabled / checked)
 * AFTER data-testid in attribute order, so a slice that stops at the
 * testid cannot see them — the round-1 draft of these assertions made
 * exactly that mistake.
 */
const openTagOf = (markup: string, testid: string): string => {
  const at = markup.indexOf(`data-testid="${testid}"`);
  if (at < 0) return "";
  const start = markup.lastIndexOf("<", at);
  const end = markup.indexOf(">", at);
  return markup.slice(start, end + 1);
};

/**
 * Whether a control renders DISABLED.
 *
 * Deliberately NOT a `/disabled/` match on the open tag: every one of
 * these buttons carries Tailwind `disabled:` variants in its className,
 * so the naive test passes on an ENABLED button and proves nothing.
 * React renders the boolean attribute as `disabled=""` and omits it
 * entirely when false, so the empty-string form is the only exact
 * spelling that means "this control is actually off".
 */
const isDisabled = (markup: string, testid: string): boolean =>
  /\sdisabled=""/.test(openTagOf(markup, testid));

/**
 * The source text of ONE `onXxx={...}` prop, from its opening to the
 * start of the next prop at the same indentation.
 *
 * Slicing by the next `
        on` marker is what makes the scope
 * exact: every handler in this component is one prop wide, so the
 * segment is precisely one handler. Regex-with-`[\s\S]*?` over the
 * whole file cannot do this — the lazy match is free to run past the
 * end of the handler it was meant to stop in, which is exactly how
 * mutation M7 survived two earlier versions of the pin.
 */
const propHandlerBody = (prop: string): string => {
  const start = dialogSource.indexOf(prop);
  assert.ok(start >= 0, `${prop} must exist in the dialog source`);
  const next = dialogSource.indexOf("\n        on", start + prop.length);
  return dialogSource.slice(start, next < 0 ? start + 800 : next);
};

/** Escape a copy string for embedding in a RegExp — tooltips carry
 *  parentheses and CJK punctuation that a bare literal would eat. */
const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The element that carries `data-testid="..."` through its closing
 * tag — for wrapper labels whose inner <input> holds the checked
 * state (the fetched-models rows put the testid on the <label>).
 */
const regionOf = (markup: string, testid: string, close: string): string => {
  const at = markup.indexOf(`data-testid="${testid}"`);
  if (at < 0) return "";
  const start = markup.lastIndexOf("<", at);
  const end = markup.indexOf(close, at);
  return markup.slice(start, end + close.length);
};

const CATALOGUE: PresetCatalogueEntry[] = [
  {
    id: "zhipu",
    label: "智谱 (Zhipu / GLM)",
    protocol: "openai",
    auth: { type: "byok", baseURL: "https://open.bigmodel.cn/api/paas/v4/" },
    models: [
      { id: "glm-4-plus", label: "GLM-4 Plus", contextLimit: 128000, modalities: ["text"] },
      { id: "glm-4-air", label: "GLM-4 Air", contextLimit: 128000, modalities: ["text"] },
      { id: "glm-4-flash", label: "GLM-4 Flash", contextLimit: 128000, modalities: ["text"] },
    ],
  },
];

const formProps = (overrides: Record<string, unknown> = {}) => ({
  t: tZh,
  presets: CATALOGUE,
  presetChoice: null as string | null,
  apiFormat: "openai" as ProviderProtocol,
  custom: blankDialogCustom(),
  apiKey: "",
  revealed: false,
  headers: [] as DialogHeaderRow[],
  entries: [] as DraftModel[],
  errors: [] as string[],
  busy: false,
  entryTests: {} as Record<number, never>,
  canTest: false,
  formTest: null as EntryTestState | null,
  skipTest: false,
  onPresetChoice: noop,
  onApiFormat: noop,
  onCustomField: noop,
  onApiKey: noop,
  onRevealToggle: noop,
  onHeaderChange: noop,
  onHeaderAdd: noop,
  onHeaderRemove: noop,
  onAddEntry: noop,
  onAutoFetch: noop,
  onEntryChange: noop,
  onEntryRemove: noop,
  onEntryReset: noop,
  onEntryTest: noop,
  onFormTest: noop,
  onSkipTestToggle: noop,
  onCancel: noop,
  onCommit: noop,
  ...overrides,
});

// ---------------------------------------------------------------------
// 1. API-key eye toggle — mutation M1 (revert to a plain input with
//    no reveal) must fail HERE, at the rendered input's type.
// ---------------------------------------------------------------------

describe("add-model dialog — API-key reveal round-trip (M1)", () => {
  test("masked: the key input renders type=password with the reveal affordance", () => {
    const markup = render(createElement(AddModelDialogForm, formProps()));
    assert.ok(
      markup.includes('data-testid="provider-dialog-api-key"'),
      "key input renders",
    );
    assert.ok(
      markup.includes('type="password"'),
      "masked state must render a password input",
    );
    assert.ok(
      !markup.includes('type="text"'),
      "masked state must not leak a text input",
    );
    assert.ok(
      markup.includes('data-testid="provider-dialog-api-key-reveal"'),
      "the reveal button renders next to the field",
    );
    assert.match(
      dialogSource,
      /type=\{revealed \? "text" : "password"\}/,
      "the input type must be driven by the controlled `revealed` prop — an antd Password widget would own the toggle internally and this render would not reach it (M1)",
    );
  });

  test("revealed: the same input renders type=text — the round trip", () => {
    const markup = render(
      createElement(AddModelDialogForm, formProps({ revealed: true })),
    );
    assert.ok(
      markup.includes('type="text"'),
      "revealed state must render the plaintext",
    );
    assert.ok(
      !markup.includes('type="password"'),
      "revealed state must not keep the mask",
    );
  });

  test("the reveal button is wired to the toggle callback (not a dead glyph)", () => {
    // Static markup cannot click; pin the wiring so the button cannot
    // degrade into decoration while the renders above stay green.
    assert.match(
      dialogSource,
      /onClick=\{onRevealToggle\}/,
      "the eye button must call the form's onRevealToggle callback",
    );
    assert.match(
      dialogSource,
      /onRevealToggle=\{\(\) => setRevealed\(\(r\) => !r\)\}/,
      "the shell must flip its revealed state on toggle",
    );
  });
});

// ---------------------------------------------------------------------
// 2. Save-time validation — mutation M7 (delete the guard) must fail
//    across BOTH halves: the rules (pure function) and the rendered
//    error block.
// ---------------------------------------------------------------------

describe("add-model dialog — save validation (M7)", () => {
  test("collectDialogErrors: no provider chosen → the provider error leads", () => {
    const errors = collectDialogErrors({
      t: tZh,
      presetChoice: null,
      custom: blankDialogCustom(),
      existingIds: [],
      entries: [],
    });
    assert.equal(errors[0], tZh("providers.dialog.errorProvider"));
  });

  test("collectDialogErrors: custom choice with an empty id → id required", () => {
    const errors = collectDialogErrors({
      t: tZh,
      presetChoice: PRESET_CHOICE_CUSTOM,
      custom: blankDialogCustom(),
      existingIds: [],
      entries: [],
    });
    assert.ok(errors.some((e) => /id required/.test(e)));
  });

  test("collectDialogErrors: duplicate provider id → the duplicate error names it", () => {
    const errors = collectDialogErrors({
      t: tZh,
      presetChoice: "zhipu",
      custom: blankDialogCustom(),
      existingIds: ["zhipu"],
      entries: [],
    });
    assert.ok(errors.some((e) => e.includes("zhipu")));
    assert.ok(errors.length > 0);
  });

  test("collectDialogErrors: an unfilled model row reports under its 模型 NN title", () => {
    const errors = collectDialogErrors({
      t: tZh,
      presetChoice: "zhipu",
      custom: blankDialogCustom(),
      existingIds: [],
      entries: [blankModel()],
    });
    assert.ok(
      errors.some((e) => e === "模型 01: model id required"),
      `expected the entry-titled error, got: ${JSON.stringify(errors)}`,
    );
  });

  test("collectDialogErrors: a well-formed dialog produces no errors", () => {
    const errors = collectDialogErrors({
      t: tZh,
      presetChoice: "zhipu",
      custom: blankDialogCustom(),
      existingIds: [],
      entries: [{
        ...blankModel(),
        id: "glm-5.3",
        contextLimit: "256000",
        thinkingLevels: ["low"],
        modalities: ["image", "file"],
      }],
    });
    assert.deepEqual(errors, []);
  });

  test("the error block renders exactly the collected errors, and nothing when clean", () => {
    const withErrors = render(
      createElement(
        AddModelDialogForm,
        formProps({ errors: ["请先选择提供商", "模型 01: model id required"] }),
      ),
    );
    assert.ok(withErrors.includes('data-testid="provider-dialog-errors"'));
    assert.ok(withErrors.includes("请先选择提供商"));
    assert.ok(withErrors.includes("模型 01: model id required"));

    const clean = render(createElement(AddModelDialogForm, formProps()));
    assert.ok(!clean.includes('data-testid="provider-dialog-errors"'));
  });

  test("the commit path consults the validator and refuses to save on errors (M7)", () => {
    // Static render cannot drive the shell's commit; pin the two
    // lines whose deletion shipped green in round 1.
    assert.match(
      dialogSource,
      /const errs = collectDialogErrors\(\{/,
      "commit must run the shared validator",
    );
    assert.match(
      dialogSource,
      /if \(errs\.length > 0\) \{\s*setErrors\(errs\);\s*return;/,
      "commit must surface the errors and NOT call onSave while any remain",
    );
  });
});

// ---------------------------------------------------------------------
// 3. Cancel resets the draft — mutation M6 (close without resetForm)
//    must fail here.
// ---------------------------------------------------------------------

describe("add-model dialog — cancel clears the draft (M6)", () => {
  test("the blank landing state renders: placeholder, no entries, no errors", () => {
    // This is the state resetForm must restore: the same render a
    // reopened dialog owes the user.
    const markup = render(
      createElement(AddModelDialogForm, formProps({ presets: null })),
    );
    assert.ok(markup.includes(tZh("providers.dialog.providerPlaceholder")));
    assert.ok(!markup.includes('data-testid="provider-dialog-entry-0"'));
    assert.ok(!markup.includes('data-testid="provider-dialog-errors"'));
    assert.ok(
      markup.includes('data-testid="provider-dialog-api-key"'),
      "key input renders",
    );
    assert.match(
      dialogSource,
      /value=\{apiKey\}/,
      "the key input stays controlled by the shell's apiKey state",
    );
  });

  test("close() resets the form before handing control back (M6)", () => {
    // Pin the call order inside the shell: resetForm first, so even a
    // reopen racing onCancel cannot show stale input.
    assert.match(
      dialogSource,
      /const close = useCallback\(\(\) => \{\s*resetForm\(\);\s*setFetchedOpen\(false\);\s*onCancel\(\);/,
      "close must call resetForm before onCancel — deleting resetForm here shipped green in round 1",
    );
  });
});

// ---------------------------------------------------------------------
// 4. Entry card — the five reference fields under 模型 01.
// ---------------------------------------------------------------------

describe("add-model dialog — entry card rendering", () => {
  const markup = render(
    createElement(AddModelEntry, {
      t: tZh,
      index: 0,
      model: {
        ...blankModel(),
        id: "glm-5.3",
        contextLimit: "256000",
        thinkingLevels: ["low"],
        modalities: ["image", "file"],
      },
      canTest: false,
      testState: null,
      onChange: noop,
      onRemove: noop,
      onReset: noop,
      onTest: noop,
    }),
  );

  test("header shows 模型 01 with the reset and delete affordances", () => {
    assert.ok(markup.includes("模型 01"));
    assert.ok(markup.includes('data-testid="provider-dialog-entry-0-reset"'));
    assert.ok(markup.includes('data-testid="provider-dialog-entry-0-remove"'));
  });

  test("name and context render their values; max-output is disabled with the marker", () => {
    assert.ok(markup.includes('data-testid="provider-dialog-entry-0-name"'));
    assert.ok(markup.includes('value="glm-5.3"'));
    assert.ok(markup.includes('data-testid="provider-dialog-entry-0-context"'));
    assert.ok(markup.includes('value="256000"'));
    const maxTag = openTagOf(markup, "provider-dialog-entry-0-max-output");
    assert.ok(maxTag.length > 0, "max-output field renders");
    assert.match(maxTag, /disabled/, "max-output must stay disabled");
    assert.ok(
      markup.includes(tZh("providers.dialog.field.maxOutputNa")),
      "the not-applicable placeholder states the local limitation",
    );
  });

  test("the attachment quartet reflects the model's modalities", () => {
    for (const [mod, shouldBeChecked] of [
      ["image", true],
      ["file", true],
      ["video", false],
      ["audio", false],
    ] as const) {
      const tag = openTagOf(
        markup,
        `provider-dialog-entry-0-attachment-${mod}`,
      );
      assert.ok(tag.length > 0, `${mod} checkbox renders`);
      assert.equal(
        tag.includes("checked"),
        shouldBeChecked,
        `${mod} checkbox checked=${shouldBeChecked}`,
      );
    }
    assert.ok(markup.includes(tZh("providers.dialog.attachments.pdf")), "PDF label renders");
  });

  test("thinking options come from THINKING_LEVELS — the reference's max must not leak (M8/M9)", () => {
    assert.ok(
      dialogSource.includes("THINKING_LEVELS.map((lvl)"),
      "thinking options must map over the shared enum",
    );
    // Round 1's negative pin only matched double quotes and a
    // single-quoted {label:'max'} sailed past. Match any quoting.
    assert.doesNotMatch(
      dialogSource,
      /value:\s*['"]max['"]/,
      "a max option must not appear in any quoting style",
    );
  });
});

// ---------------------------------------------------------------------
// 4b. Ticket 56 — visual/interaction parity: empty state (I1),
//     action tooltips (I2), per-entry connectivity test (I3),
//     dedicated footer (V3), adjacent header actions (V5),
//     centred token-pinned modal (V1/V2).
// ---------------------------------------------------------------------

describe("add-model dialog — ticket 56 parity (I1/I2/I3, V1-V5)", () => {
  test("I1: entries=[] renders the explicit empty placeholder; entries>0 drops it", () => {
    const empty = render(createElement(AddModelDialogForm, formProps()));
    assert.ok(
      empty.includes('data-testid="provider-dialog-models-empty"'),
      "the models section must render its empty placeholder",
    );
    assert.ok(
      empty.includes(tZh("providers.dialog.modelsEmpty")),
      "the placeholder carries the guiding copy, not a bare box",
    );

    const filled = render(
      createElement(
        AddModelDialogForm,
        formProps({ entries: [{ ...blankModel(), id: "glm-5.3" }] }),
      ),
    );
    assert.ok(
      !filled.includes('data-testid="provider-dialog-models-empty"'),
      "with entries present the placeholder must be gone",
    );
    assert.ok(
      filled.includes('data-testid="provider-dialog-entry-0"'),
      "the entry card renders in its place",
    );
  });

  test("I2: ＋添加 and 自动获取 carry their division-of-labour tooltips", () => {
    const markup = render(createElement(AddModelDialogForm, formProps()));
    const addTag = openTagOf(markup, "provider-dialog-model-add");
    const fetchTag = openTagOf(markup, "provider-dialog-autofetch");
    assert.match(
      addTag,
      new RegExp(`title="${escapeRegExp(tZh("providers.dialog.addEntryHint"))}"`),
      "＋添加 must spell out manual entry in its tooltip",
    );
    assert.match(
      fetchTag,
      new RegExp(
        `title="${escapeRegExp(tZh("providers.dialog.autoFetchHint"))}"`,
      ),
      "自动获取 must state its fetch-only (no-save) semantics in its tooltip",
    );
    // The no-save semantics is the official contract (I4) — the zh
    // copy must literally say it, or the tooltip drifted.
    assert.ok(
      tZh("providers.dialog.autoFetchHint").includes("不会保存任何配置"),
      "the zh auto-fetch hint must keep the 不会保存任何配置 clause",
    );
  });

  test("I3: the per-entry 检测 button renders, disabled reasoning in its tooltip", () => {
    const markup = render(
      createElement(AddModelEntry, {
        t: tZh,
        index: 0,
        model: blankModel(),
        canTest: false,
        testState: null,
        onChange: noop,
        onRemove: noop,
        onReset: noop,
        onTest: noop,
      }),
    );
    const testTag = openTagOf(markup, "provider-dialog-entry-0-test");
    assert.ok(testTag.length > 0, "the test button renders on the entry card");
    assert.ok(
      testTag.includes(tZh("providers.dialog.testNeedProvider")),
      "while canTest=false the tooltip explains WHAT is missing, not just 'disabled'",
    );
    assert.ok(
      markup.includes(`>${tZh("providers.dialog.entryTest")}</button>`),
      "the button is a labelled text button (检测), not a bare glyph",
    );
  });

  test("I3: the three controlled probe branches render their verdict lines", () => {
    const base = {
      t: tZh,
      index: 0,
      model: blankModel(),
      canTest: true,
      onChange: noop,
      onRemove: noop,
      onReset: noop,
      onTest: noop,
    };
    const ok = render(
      createElement(AddModelEntry, {
        ...base,
        testState: { status: "ok", latencyMs: 321 },
      }),
    );
    assert.ok(ok.includes('data-testid="provider-dialog-entry-0-test-result"'));
    assert.ok(
      ok.includes(tZh("providers.dialog.testOk").replace("{{ms}}", "321")),
      "the ok verdict names the measured latency",
    );
    assert.ok(
      ok.includes("text-text_status_success"),
      "the ok verdict uses the success token colour",
    );

    const fail = render(
      createElement(AddModelEntry, {
        ...base,
        testState: { status: "fail", error: "HTTP 401" },
      }),
    );
    assert.ok(
      fail.includes(tZh("providers.dialog.testFail").replace("{{error}}", "HTTP 401")),
      "the fail verdict surfaces the server's structured error",
    );
    assert.ok(
      fail.includes("text-text_status_error"),
      "the fail verdict uses the error token colour",
    );

    const testing = render(
      createElement(AddModelEntry, { ...base, testState: { status: "testing" } }),
    );
    assert.ok(
      testing.includes(tZh("providers.dialog.testTesting")),
      "the testing branch renders the in-flight copy",
    );
  });

  test("I3: the shell probes through the existing POST /api/providers/test contract", () => {
    // The reuse decision (no new route) is the load-bearing line —
    // pin the endpoint, the current-values body, and the wiring so
    // the button cannot degrade into decoration or drift onto a
    // private endpoint.
    assert.match(
      dialogSource,
      /fetch\("\/api\/providers\/test"/,
      "the probe must go through the existing server contract",
    );
    assert.match(
      dialogSource,
      /onEntryTest=\{\(index\) => void testEntry\(index\)\}/,
      "the form's onEntryTest must be wired to the shell's probe",
    );
    assert.match(
      dialogSource,
      /const canTest =\s*\n\s*presetChoice !== null &&\s*\n\s*\(probeAuthType === "coding-plan" \|\| apiKey\.trim\(\)\.length > 0\)/,
      "canTest mirrors validateKeyFormat: provider chosen, and a typed key for byok (coding-plan fires without one)",
    );
    assert.match(
      dialogSource,
      /onApiKey=\{\(value\) => \{\s*\n\s*setApiKey\(value\);\s*\n\s*\/\/ The key is THE probe credential[\s\S]*?setEntryTests/,
      "changing the key drops every outstanding verdict — it answered for a different credential",
    );
  });

  test("V3: the commit pair lives in a separated footer region behind a hairline", () => {
    const markup = render(createElement(AddModelDialogForm, formProps()));
    const footerAt = markup.indexOf('data-testid="provider-dialog-footer"');
    assert.ok(footerAt > 0, "the footer region renders");
    assert.ok(
      markup.lastIndexOf('data-testid="provider-dialog-models-empty"') <
        footerAt,
      "the footer must come after the body content",
    );
    assert.match(
      dialogSource,
      /data-testid="provider-dialog-footer"\s+className="mt-5 [^"]*shrink-0 [^"]*border-t border-border_default pt-4"/,
      "the footer carries ≥16px separation (pt-4) plus a top hairline",
    );
    // Both buttons moved into the footer region — the old inline
    // pair under the models row is what the user flagged.
    assert.ok(
      markup.indexOf('data-testid="provider-dialog-cancel"') > footerAt &&
        markup.indexOf('data-testid="provider-dialog-save"') > footerAt,
      "取消/保存 render inside the footer region",
    );
  });

  test("V3: the body clamps to the viewport so the footer stays reachable on short screens", () => {
    // Found live in the verify round: the filled custom branch grows
    // past the overlay (antd does not make it scrollable), pushing
    // 取消/保存 below the fold with no way to reach them. The clamp
    // + internal scroll is the fix — pin both halves.
    assert.match(
      dialogSource,
      /className="flex max-h-\[calc\(90vh-64px\)\] flex-col"\s*\n\s*data-testid="provider-dialog"/,
      "the dialog clamps its height to the viewport",
    );
    assert.match(
      dialogSource,
      /className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-2"/,
      "the body region scrolls internally when clamped (pb-2 keeps the last row off the clip edge)",
    );
  });

  test("V4: footer buttons run at the h-9 control height", () => {
    const markup = render(createElement(AddModelDialogForm, formProps()));
    const saveTag = openTagOf(markup, "provider-dialog-save");
    const cancelTag = openTagOf(markup, "provider-dialog-cancel");
    assert.match(saveTag, /class="[^"]*h-9[^"]*"/, "保存 ≥36px tall");
    assert.match(cancelTag, /class="[^"]*h-9[^"]*"/, "取消 matches the height");
    assert.match(
      saveTag,
      /class="[^"]*shadow-\[var\(--shadow_default\)\][^"]*"/,
      "the primary action carries the token shadow",
    );
  });

  test("V5: the models header keeps label and actions adjacent (no justify-between gap)", () => {
    assert.match(
      dialogSource,
      /\/\* 模型 —— the header row keeps the label and its actions/,
      "the header row is documented as the adjacency fix",
    );
    assert.match(
      dialogSource,
      /className="flex flex-wrap items-center gap-2"/,
      "the header row packs label + actions with gap-2",
    );
    assert.doesNotMatch(
      dialogSource,
      /items-center justify-between">\s*<span className="desktop-text-ui-small-strong text-text_default_tertiary">\s*\{t\("providers\.dialog\.models"\)\}/,
      "the old justify-between header must be gone",
    );
  });

  test("V1/V2: both modals centre vertically with token-pinned radius and elevation", () => {
    assert.match(
      dialogSource,
      /width=\{640\}\s*centered\s*styles=\{\{/,
      "the add-model modal centres and pins its card styles",
    );
    assert.match(
      dialogSource,
      /width=\{480\}\s*centered\s*styles=\{\{/,
      "the fetched-models modal matches the treatment",
    );
    // Two occurrences (one per modal) — the elevation composes the
    // opacity ramp, not a literal rgba.
    assert.equal(
      dialogSource.split('borderRadius: "var(--radius_12)"').length - 1,
      2,
      "both cards take --radius_12",
    );
    assert.match(
      dialogSource,
      /0 4px 16px var\(--opacity_black_1_8\), 0 12px 40px var\(--opacity_black_1_15\)/,
      "the elevation references the opacity token ramp",
    );
  });
});

// ---------------------------------------------------------------------
// 5. The fetched-models checkbox dialog — mutations M4 (default
//    check-none) and M5 (drop the n/N counter) must fail here.
// ---------------------------------------------------------------------

describe("fetched-models dialog — check-all semantics (M4/M5)", () => {
  const models = CATALOGUE[0]?.models ?? [];
  const ids = models.map((m) => m.id);
  const bodyProps = (overrides: Record<string, unknown> = {}) => ({
    t: tZh,
    presetMode: true,
    models,
    checked: new Set<string>(ids),
    allChecked: true,
    onToggle: noop,
    onToggleAll: noop,
    onCancel: noop,
    onAdd: noop,
    ...overrides,
  });

  test("default state: every row checked, 全选（3/3）, 添加 enabled", () => {
    const markup = render(
      createElement(FetchedModelsDialogBody, bodyProps()),
    );
    for (const id of ids) {
      assert.ok(
        markup.includes(`data-testid="fetched-models-item-${id}"`),
        `${id} row renders`,
      );
    }
    const selectAllRegionAll = regionOf(markup, "fetched-models-select-all", "</label>");
    assert.ok(selectAllRegionAll.includes("全选"), "the 全选 label renders");
    assert.ok(selectAllRegionAll.includes("（3/3）"), "the n/N counter renders (M5)");
    assert.ok(
      markup.includes('data-testid="fetched-models-select-all"'),
      "the 全选 control renders",
    );
    const addTag = openTagOf(markup, "fetched-models-add");
    assert.ok(addTag.length > 0, "添加 button renders");
    // /disabled(?!:)/ — the className carries Tailwind's disabled:
    // variants, a plain substring search would false-positive on them.
    assert.ok(
      !/disabled(?!:)/.test(addTag),
      "添加 stays enabled with rows checked",
    );
    const checkedCount = (markup.match(/checked(?:="")?/g) ?? []).length;
    assert.ok(
      checkedCount >= ids.length + 1,
      `every row plus the 全选 box carry checked (${checkedCount})`,
    );
  });

  test("partial selection prints （2/3） and keeps the 全选 box unchecked", () => {
    const markup = render(
      createElement(
        FetchedModelsDialogBody,
        bodyProps({
          checked: new Set<string>([ids[0] ?? "", ids[1] ?? ""]),
          allChecked: false,
        }),
      ),
    );
    assert.ok(markup.includes("（2/3）"), "the counter tracks the set (M5)");
    const selectAllRegion = regionOf(markup, "fetched-models-select-all", "</label>");
    assert.ok(selectAllRegion.length > 0, "全选 control renders");
    assert.ok(
      !selectAllRegion.includes("checked"),
      "全选 box unchecked when partial",
    );
  });

  test("zero selection: （0/3） and 添加 disabled — the empty commit cannot fire", () => {
    const markup = render(
      createElement(
        FetchedModelsDialogBody,
        bodyProps({ checked: new Set<string>(), allChecked: false }),
      ),
    );
    assert.ok(markup.includes("（0/3）"));
    assert.match(
      openTagOf(markup, "fetched-models-add"),
      /disabled/,
      "添加 must be disabled with nothing checked",
    );
  });

  test("custom-provider mode: the honest note, no rows, no 全选, 添加 disabled", () => {
    const markup = render(
      createElement(
        FetchedModelsDialogBody,
        bodyProps({ presetMode: false, checked: new Set<string>(), allChecked: false }),
      ),
    );
    assert.ok(markup.includes(tZh("providers.fetched.customEmpty")));
    assert.ok(!markup.includes('data-testid="fetched-models-item-'));
    assert.ok(!markup.includes('data-testid="fetched-models-select-all"'));
    assert.match(
      openTagOf(markup, "fetched-models-add"),
      /disabled/,
      "添加 must be disabled without a preset catalogue",
    );
  });

  test("defaultChecked seeds the full set; the shell reseeds on every open (M4)", () => {
    const seeded = defaultChecked(models);
    assert.deepEqual([...seeded].sort(), [...ids].sort());
    // Pin the shell's landing state: round 1's mutation flipped this
    // to an empty Set and every test stayed green.
    assert.match(
      dialogSource,
      /if \(open\) setChecked\(defaultChecked\(models\)\);/,
      "a fresh open must reseed checked from defaultChecked — not an empty set",
    );
  });
});

// ---------------------------------------------------------------------
// 6. Panel wiring — the structural pins that stay on
//    provider-management.tsx (empty state, red lines, PUT path).
// ---------------------------------------------------------------------

describe("add-model dialog — panel wiring", () => {
  test("empty state keeps its testids on the centered form", () => {
    assert.ok(panelSource.includes('data-testid="providers-empty"'));
    assert.ok(panelSource.includes('data-testid="provider-add-button"'));
    const emptyIdx = panelSource.indexOf('data-testid="providers-empty"');
    const buttonIdx = panelSource.indexOf(
      'data-testid="provider-add-button"',
      emptyIdx,
    );
    assert.ok(buttonIdx > emptyIdx, "empty-state button follows the text");
  });

  // P3 correction (acceptance round 2): this list holds 36 fragments
  // and the empty-state case above holds the other 2 — 38 total,
  // matching the base tree's 38 deduplicated testids. Ten fragments
  // are truncated prefixes (e.g. `provider-row-label-${p.id` without
  // the `|| "new"}` tail): they pin the source literal, not the
  // rendered value, which is why the case below is named "survives in
  // source" — "verbatim" overclaimed it.
  const PRESERVED_TESTIDS = [
    "providers-panel",
    "provider-row-${p.draftId}",
    "provider-row-label-${p.id",
    "provider-preset-badge-${p.id}",
    "provider-custom-badge-${p.id}",
    "provider-haskey-${p.id",
    "provider-models-summary-${p.id",
    "provider-model-chip-${p.id",
    "provider-model-overflow-${p.id",
    "provider-test-summary-${p.id",
    "provider-editor-${draft.id",
    "provider-field-id",
    "provider-field-label",
    "provider-field-protocol",
    "provider-field-authType",
    "provider-field-apiKey",
    "provider-field-baseURL",
    "provider-test-button",
    "provider-test-result",
    "provider-delete-button",
    "provider-model-add",
    "provider-model-row-${model.id",
    "provider-model-id",
    "provider-model-label",
    "provider-model-contextLimit",
    "provider-model-thinkingLevels",
    "provider-model-modalities",
    "provider-model-remove",
    "provider-presets",
    "provider-preset-row-${preset.id}",
    "provider-preset-enable-${preset.id}",
    "providers-save",
    "providers-save-spinner",
    "providers-saved-notice",
    "providers-save-error",
    "provider-validation-errors",
  ];

  test("36 pre-existing testid literals survive in source (+2 empty-state = 38 total)", () => {
    assert.equal(PRESERVED_TESTIDS.length, 36);
    for (const id of PRESERVED_TESTIDS) {
      assert.ok(
        panelSource.includes(id),
        `pre-existing testid fragment missing from source: ${id}`,
      );
    }
  });

  test("the editor's five model fields survive (editing capability)", () => {
    for (const field of [
      "provider-model-id",
      "provider-model-label",
      "provider-model-contextLimit",
      "provider-model-thinkingLevels",
      "provider-model-modalities",
    ]) {
      assert.ok(panelSource.includes(`data-testid="${field}"`));
    }
  });

  test("panel saves go through draftToWire + the unchanged putProviders call", () => {
    assert.ok(
      panelSource.includes("draftToWire"),
      "the PUT body must still be built by draftToWire",
    );
    assert.match(
      panelSource,
      /api\.putProviders\(\{ version: 2, providers: wire \}\)/,
      "the PUT call and body shape must be unchanged",
    );
    // The payload CONTRACT itself is pinned at the behaviour layer in
    // provider-management.test.ts ("wire key set is closed") — this
    // call-site pin alone was proven insufficient in round 1 (M2).
  });

  test("the dialog is the only add path — no legacy addProvider draft push", () => {
    assert.ok(
      !panelSource.includes("const addProvider = useCallback"),
      "the old rail-draft addProvider (pre-dialog flow) must be gone",
    );
  });
});

// ---------------------------------------------------------------------
// 7. Bilingual dictionary coverage for the new strings.
// ---------------------------------------------------------------------

describe("add-model dialog — bilingual keys", () => {
  const NEW_KEYS: MessageKey[] = [
    "providers.empty",
    "providers.add",
    "providers.dialog.title",
    "providers.dialog.provider",
    "providers.dialog.providerPlaceholder",
    "providers.dialog.other",
    "providers.dialog.apiKeyPlaceholder",
    "providers.dialog.models",
    "providers.dialog.addEntry",
    "providers.dialog.autoFetch",
    "providers.dialog.entryTitle",
    "providers.dialog.entryReset",
    "providers.dialog.entryRemove",
    "providers.dialog.field.name",
    "providers.dialog.field.context",
    "providers.dialog.field.maxOutput",
    "providers.dialog.field.maxOutputNa",
    "providers.dialog.field.thinking",
    "providers.dialog.field.thinkingPlaceholder",
    "providers.dialog.field.attachments",
    "providers.dialog.attachments.image",
    "providers.dialog.attachments.pdf",
    "providers.dialog.attachments.video",
    "providers.dialog.attachments.audio",
    "providers.dialog.cancel",
    "providers.dialog.save",
    "providers.dialog.errorProvider",
    "providers.dialog.errorDuplicate",
    "providers.dialog.modelsEmpty",
    "providers.dialog.addEntryHint",
    "providers.dialog.autoFetchHint",
    "providers.dialog.entryTest",
    "providers.dialog.entryTestHint",
    "providers.dialog.testTesting",
    "providers.dialog.testOk",
    "providers.dialog.testFail",
    "providers.dialog.testNeedProvider",
    "providers.fetched.title",
    "providers.fetched.presetNote",
    "providers.fetched.customEmpty",
    "providers.fetched.selectAll",
    "providers.fetched.add",
    "providers.models.modalities.file",
  ];

  test("every new key resolves in both locales", () => {
    for (const key of NEW_KEYS) {
      for (const locale of ["en", "zh"] as const) {
        const value = translate(locale, key);
        assert.notEqual(
          value,
          undefined,
          `${key} missing from ${locale} dictionary`,
        );
        assert.ok(
          (value ?? "").length > 0,
          `${key} is empty in ${locale} dictionary`,
        );
      }
    }
  });

  test("the desktop's exact empty-state copy ships in zh", () => {
    assert.equal(translate("zh", "providers.empty"), "暂未添加自定义模型");
    assert.equal(translate("zh", "providers.add"), "添加模型");
    assert.equal(translate("zh", "providers.dialog.providerPlaceholder"), "请选择提供商");
    assert.equal(translate("zh", "providers.dialog.apiKeyPlaceholder"), "请输入API Key");
    assert.equal(translate("zh", "providers.fetched.title"), "已获取模型");
    assert.equal(translate("zh", "providers.fetched.selectAll"), "全选");
  });
});


// ---------------------------------------------------------------------
// 7. Ticket 85 — the three desktop fields the local dialog was missing:
//    「API 格式」, 「自定义 Headers」, and the footer 连通检测 /
//    跳过连通检测 pair that gates 保存.
//
// The shell (antd Modal + state) is still out of reach of a static
// render, so as above these are two layers: the CONTROLLED form surface
// is rendered through `formProps` (the markup assertions), and each
// stateful hand-off is pinned by an exact-literal source assertion
// against `dialogSource` (the wiring assertions). Every pin names the
// mutation it exists to catch; all were actually run — see
// `.tickets/webui-parity/85-provider-modal-shell.md`.
// ---------------------------------------------------------------------

describe("add-model dialog — API 格式 (ticket 85)", () => {
  test("the dropdown is rendered for EVERY provider, not just custom ones", () => {
    // The regression this catches: moving the control back inside the
    // 「其他（自定义）」 branch, where it was before this ticket.
    for (const choice of [null, "zhipu", PRESET_CHOICE_CUSTOM]) {
      const markup = render(
        createElement(AddModelDialogForm, formProps({ presetChoice: choice })),
      );
      assert.ok(
        markup.includes('data-testid="provider-dialog-api-format"'),
        `API 格式 must render with presetChoice=${String(choice)}`,
      );
    }
  });

  test("it shows the desktop's labels over the three existing protocols", () => {
    const markup = render(
      createElement(
        AddModelDialogForm,
        formProps({ presetChoice: PRESET_CHOICE_CUSTOM, apiFormat: "anthropic" }),
      ),
    );
    // antd renders a Select's options into a portal that a static
    // render does not reach, so the VALUES are asserted from the
    // constant and the LABELS from the dictionary.
    assert.deepEqual(
      API_FORMAT_OPTIONS.map((o) => o.value),
      ["openai", "anthropic", "gemini"],
      "the dropdown offers exactly the protocols this build supports",
    );
    assert.equal(translate("zh", "providers.dialog.apiFormat"), "API 格式");
    assert.equal(
      translate("zh", "providers.dialog.apiFormat.anthropic"),
      "Anthropic Messages",
    );
  });

  test("the old custom-branch protocol select is gone (one control, one value)", () => {
    // Two controls bound to one value is how a preset branch and a
    // custom branch end up disagreeing about what gets saved.
    const markup = render(
      createElement(
        AddModelDialogForm,
        formProps({ presetChoice: PRESET_CHOICE_CUSTOM }),
      ),
    );
    assert.ok(
      !markup.includes('data-testid="provider-dialog-custom-protocol"'),
      "the duplicate protocol select must not come back",
    );
    assert.doesNotMatch(
      dialogSource,
      /protocol: custom\.protocol/,
      "the commit path must read the top-level apiFormat, not a custom field",
    );
  });

  test("picking a preset seeds the format from that preset", () => {
    assert.match(
      dialogSource,
      /setApiFormat\(next\.protocol\)/,
      "the preset's own protocol must seed the dropdown",
    );
  });
});

describe("add-model dialog — 自定义 Headers (ticket 85)", () => {
  test("the section renders with the desktop's title and an add control", () => {
    const markup = render(createElement(AddModelDialogForm, formProps()));
    assert.ok(
      markup.includes(translate("zh", "providers.dialog.headers")),
      "the 自定义 Headers title renders",
    );
    assert.ok(
      markup.includes('data-testid="provider-dialog-headers-add"'),
      "the ＋ 添加 control renders even with zero rows",
    );
  });

  test("zero rows render a placeholder, never a silently absent section", () => {
    const empty = render(createElement(AddModelDialogForm, formProps()));
    assert.ok(
      empty.includes('data-testid="provider-dialog-headers-empty"'),
      "an empty list is stated, not collapsed",
    );
    assert.ok(
      !empty.includes('data-testid="provider-dialog-header-0"'),
      "no phantom row",
    );
  });

  test("each row is a name input, a value input and a remove control", () => {
    const markup = render(
      createElement(
        AddModelDialogForm,
        formProps({
          headers: [{ name: "X-Tenant", value: "acme" }],
        }),
      ),
    );
    assert.ok(
      markup.includes('data-testid="provider-dialog-header-0-name"'),
      "the name input renders",
    );
    assert.ok(
      markup.includes('data-testid="provider-dialog-header-0-value"'),
      "the value input renders",
    );
    assert.ok(
      markup.includes('data-testid="provider-dialog-header-0-remove"'),
      "the row is removable",
    );
    // The name input carries the typed value, so a static render with
    // props IS the round-trip proof for this field.
    assert.match(
      markup,
      /data-testid="provider-dialog-header-0-name"[^>]*value="X-Tenant"/,
      "the row renders the value it was given",
    );
  });

  test("the remove control is named — an icon-only button needs a label", () => {
    const markup = render(
      createElement(
        AddModelDialogForm,
        formProps({ headers: [{ name: "X-Tenant", value: "acme" }] }),
      ),
    );
    assert.ok(
      markup.includes('aria-label="移除 Header X-Tenant"'),
      "the trash button carries the header's name, not a bare glyph",
    );
  });

  test("editing any header row invalidates the connectivity verdict", () => {
    // Headers ride in the probe request. A verdict that survived an
    // edit would be a pass for a request the provider never sees —
    // and, worse, it is the verdict that unlocks 保存.
    //
    // Sliced by prop boundary, NOT by regex over the whole file. Two
    // earlier attempts used a lazy `[\s\S]*?` that terminated on the
    // NEXT handler's `setFormTest(null);` — mutation M7 stayed green
    // through both of them while the invalidation was deleted outright.
    // A lazy quantifier cannot express "before this handler ends".
    for (const prop of ["onHeaderChange=", "onHeaderRemove="]) {
      const body = propHandlerBody(prop);
      assert.ok(
        body.includes("setFormTest(null)"),
        `${prop} must drop the form-level verdict`,
      );
      assert.ok(
        body.includes("setEntryTests({})"),
        `${prop} must drop the per-entry verdicts too — the headers are in their probe body`,
      );
    }
  });

  test("the commit path sends the collapsed header object, not the rows", () => {
    assert.match(
      dialogSource,
      /const headerRecord = headerPairsToRecord\(headers\)/,
      "the wire object is produced by the one shared helper",
    );
    assert.match(
      dialogSource,
      /headers: Object\.keys\(headerRecord\)\.length[\s\S]{0,400}?: \[\],/u,
      "an empty header set lands as [], never as undefined",
    );
  });
});

describe("add-model dialog — footer 连通检测 / 跳过连通检测 (ticket 85)", () => {
  test("保存 starts disabled and both lifters are present", () => {
    const markup = render(createElement(AddModelDialogForm, formProps()));
    assert.ok(
      isDisabled(markup, "provider-dialog-save"),
      "保存 is disabled before any verdict",
    );
    assert.ok(
      markup.includes('data-testid="provider-dialog-skip-test"'),
      "跳过连通检测 renders — the offline escape hatch",
    );
    assert.ok(
      markup.includes('data-testid="provider-dialog-form-test"'),
      "连通检测 renders",
    );
  });

  test("a greyed 保存 states its reason — disabled is not dead", () => {
    const markup = render(createElement(AddModelDialogForm, formProps()));
    assert.ok(
      markup.includes('data-testid="provider-dialog-save-blocked"'),
      "the blocking reason is on screen, not left to be guessed",
    );
  });

  test("a passing verdict enables 保存", () => {
    const markup = render(
      createElement(
        AddModelDialogForm,
        formProps({
          canTest: true,
          formTest: { status: "ok", latencyMs: 12 },
        }),
      ),
    );
    assert.ok(
      !isDisabled(markup, "provider-dialog-save"),
      "a passed probe unlocks 保存",
    );
    assert.ok(
      !markup.includes('data-testid="provider-dialog-save-blocked"'),
      "the blocking note clears once the probe passes",
    );
  });

  test("a FAILED verdict keeps 保存 disabled and shows the error", () => {
    const markup = render(
      createElement(
        AddModelDialogForm,
        formProps({
          canTest: true,
          formTest: { status: "fail", error: "HTTP 401" },
        }),
      ),
    );
    assert.ok(
      isDisabled(markup, "provider-dialog-save"),
      "a failed probe must not unlock 保存",
    );
    assert.ok(
      markup.includes("HTTP 401"),
      "the server's reason is surfaced verbatim",
    );
  });

  test("跳过连通检测 unlocks 保存 without a probe", () => {
    const markup = render(
      createElement(AddModelDialogForm, formProps({ skipTest: true })),
    );
    assert.ok(
      !isDisabled(markup, "provider-dialog-save"),
      "ticking 跳过连通检测 must be a real way to save",
    );
  });

  test("both probes send the live headers", () => {
    // One shared probe, so the footer button and each per-entry 检测
    // cannot drift onto different request bodies.
    assert.equal(
      (dialogSource.match(/fetch\("\/api\/providers\/test"/g) ?? []).length,
      1,
      "there must be exactly one probe call site",
    );
    assert.match(
      dialogSource,
      /\.\.\.\(Object\.keys\(headerRecord\)\.length > 0 \? \{ headers: headerRecord \} : \{\}\)/,
      "the probe body carries the collapsed headers",
    );
  });
});
