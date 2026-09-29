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
  PRESET_CHOICE_CUSTOM,
  type PresetCatalogueEntry,
} from "../components/add-model-dialog";
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
  custom: blankDialogCustom(),
  apiKey: "",
  revealed: false,
  entries: [] as DraftModel[],
  errors: [] as string[],
  busy: false,
  onPresetChoice: noop,
  onCustomField: noop,
  onApiKey: noop,
  onRevealToggle: noop,
  onAddEntry: noop,
  onAutoFetch: noop,
  onEntryChange: noop,
  onEntryRemove: noop,
  onEntryReset: noop,
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
      onChange: noop,
      onRemove: noop,
      onReset: noop,
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
