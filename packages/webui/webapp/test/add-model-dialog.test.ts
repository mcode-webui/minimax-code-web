// webapp/test/add-model-dialog.test.ts
//
// Static-source tripwire for the add-model dialog rework (ticket 54).
//
// Why a tripwire and not a render test: the webapp suite has no
// render harness (see settings-parity-nav.test.ts for the standing
// pattern), and the dialog lives inside the settings modal on the
// client, where server tests cannot see it either. What the ticket
// needs pinned is render-critical wiring that a refactor can silently
// break while typecheck stays green:
//
//   1. The dialog's desktop form is complete — provider select with
//      the 「请选择提供商」 placeholder, the password key input with
//      its eye toggle, the ＋添加 / 自动获取 pair, the per-entry five
//      fields, the 取消 / 保存 footer, and the 「已获取模型」
//      checkbox dialog with its 全选 counter. A dropped prop or a
//      renamed testid fails here.
//
//   2. The red lines survive: every pre-existing data-testid on the
//      panel/editor surfaces still appears verbatim (the ticket
//      forbids renames), the thinkingLevels options still come from
//      THINKING_LEVELS (low/medium/high contract), and the save path
//      still goes through api.putProviders with draftToWire — the
//      /api/providers body is untouched.
//
//   3. Honesty markers: the max-output-tokens input is disabled with
//      the not-applicable placeholder, and the auto-fetch dialog
//      carries the preset-note / custom-empty strings, so no
//      fabricated capability ships silently.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { translate, type MessageKey } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(
  resolve(here, "../components/provider-management.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------
// 1. The dialog's desktop form is present, testid for testid.
// ---------------------------------------------------------------------

describe("add-model dialog — desktop form wiring", () => {
  const DIALOG_TESTIDS = [
    "provider-dialog",
    "provider-dialog-title",
    "provider-dialog-provider-select",
    "provider-dialog-api-key",
    "provider-dialog-custom-id",
    "provider-dialog-custom-label",
    "provider-dialog-custom-protocol",
    "provider-dialog-custom-authType",
    "provider-dialog-custom-baseURL",
    "provider-dialog-model-add",
    "provider-dialog-autofetch",
    "provider-dialog-cancel",
    "provider-dialog-save",
    "provider-dialog-errors",
  ];
  const FETCHED_TESTIDS = [
    "fetched-models-dialog",
    "fetched-models-title",
    "fetched-models-select-all",
    "fetched-models-cancel",
    "fetched-models-add",
  ];
  const ENTRY_TESTIDS = [
    "provider-dialog-entry-${index}",
    "provider-dialog-entry-${index}-name",
    "provider-dialog-entry-${index}-context",
    "provider-dialog-entry-${index}-max-output",
    "provider-dialog-entry-${index}-thinking",
    "provider-dialog-entry-${index}-attachment-${mod}",
    "provider-dialog-entry-${index}-reset",
    "provider-dialog-entry-${index}-remove",
  ];

  test("dialog container testids render", () => {
    for (const id of [...DIALOG_TESTIDS, ...FETCHED_TESTIDS]) {
      assert.ok(
        componentSource.includes(`data-testid="${id}"`),
        `missing data-testid="${id}"`,
      );
    }
  });

  test("per-entry testids render as templates over index/mod", () => {
    for (const id of ENTRY_TESTIDS) {
      const literal = "`" + id + "`";
      assert.ok(
        componentSource.includes(literal),
        `missing template literal ${literal}`,
      );
    }
  });

  test("provider select carries the desktop placeholder key", () => {
    assert.ok(
      componentSource.includes('t("providers.dialog.providerPlaceholder")'),
      "provider select must render the 请选择提供商 placeholder",
    );
  });

  test("API key input is the password variant (eye reveal)", () => {
    assert.ok(
      componentSource.includes("AntInput.Password"),
      "the dialog's key field must be AntInput.Password — the eye toggle is the reference's form",
    );
    assert.ok(
      componentSource.includes('data-testid="provider-dialog-api-key"'),
      "the password input must carry provider-dialog-api-key",
    );
  });

  test("thinking levels options come from THINKING_LEVELS (contract)", () => {
    // The dialog must feed its select from the shared enum, never a
    // local list — a hand-rolled ["low","high","max"] would break the
    // low/medium/high contract the ticket freezes.
    assert.ok(
      componentSource.includes("THINKING_LEVELS.map((lvl)"),
      "dialog thinking options must map over THINKING_LEVELS",
    );
    assert.ok(
      !componentSource.includes('"max"'),
      'the reference\'s "max" level must not leak into the form vocabulary',
    );
  });

  test("attachment checkboxes iterate ATTACHMENT_MODALITIES", () => {
    assert.ok(
      componentSource.includes("ATTACHMENT_MODALITIES.map((mod)"),
      "attachment checkboxes must iterate the quartet constant",
    );
    assert.ok(
      componentSource.includes("ATTACHMENT_LABEL_KEYS[mod]"),
      "each checkbox label resolves through the B5 label map",
    );
  });

  test("max-output-tokens is disabled with the not-applicable marker", () => {
    const idx = componentSource.indexOf("provider-dialog-entry-${index}-max-output");
    assert.ok(idx > 0, "max-output testid missing");
    const region = componentSource.slice(idx - 400, idx + 400);
    assert.match(region, /disabled/, "the max-output input must be disabled");
    assert.match(
      region,
      /providers\.dialog\.field\.maxOutputNa/,
      "the max-output placeholder must state the local limitation",
    );
  });

  test("auto-fetch honesty strings are wired", () => {
    assert.ok(
      componentSource.includes('t("providers.fetched.presetNote")'),
      "preset-mode dialog must state the catalogue source",
    );
    assert.ok(
      componentSource.includes('t("providers.fetched.customEmpty")'),
      "custom-mode dialog must state the missing capability",
    );
  });

  test("empty state keeps its testids on the centered form", () => {
    assert.ok(componentSource.includes('data-testid="providers-empty"'));
    assert.ok(componentSource.includes('data-testid="provider-add-button"'));
    // the empty state centers; the rail variant keeps the border style
    const emptyIdx = componentSource.indexOf('data-testid="providers-empty"');
    const buttonIdx = componentSource.indexOf(
      'data-testid="provider-add-button"',
      emptyIdx,
    );
    assert.ok(buttonIdx > emptyIdx, "empty-state button follows the text");
  });
});

// ---------------------------------------------------------------------
// 2. Red lines — pre-existing testids and the PUT path.
// ---------------------------------------------------------------------

describe("add-model dialog — red lines", () => {
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

  test("every pre-existing provider-surface testid survives verbatim", () => {
    for (const id of PRESERVED_TESTIDS) {
      assert.ok(
        componentSource.includes(id),
        `pre-existing testid fragment missing: ${id}`,
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
      assert.ok(componentSource.includes(`data-testid="${field}"`));
    }
  });

  test("dialog saves go through draftToWire + api.putProviders", () => {
    assert.ok(
      componentSource.includes("draftToWire"),
      "the PUT body must still be built by draftToWire",
    );
    assert.match(
      componentSource,
      /api\.putProviders\(\{ version: 2, providers: wire \}\)/,
      "the PUT call and body shape must be unchanged",
    );
  });

  test("the dialog is the only add path — no legacy addProvider draft push", () => {
    assert.ok(
      !componentSource.includes("const addProvider = useCallback"),
      "the old rail-draft addProvider (pre-dialog flow) must be gone",
    );
  });
});

// ---------------------------------------------------------------------
// 3. Bilingual dictionary coverage for the new strings.
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
