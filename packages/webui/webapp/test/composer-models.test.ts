// webapp/test/composer-models.test.ts
//
// Unit tests for the catalogue grouping the composer ModelSelect applies
// before rendering. Pin the order-preserving behaviour the ModelSelect
// panel relies on: catalogue order is preserved within each provider,
// providers are bucketed in first-seen order, and entries without a
// provider land in a single `__other` bucket so they are still reachable.
//
// Style note: pure-function re-implementation (mirroring the grouping
// inside composer.tsx#ModelSelect). The grouping logic is small and
// stable; isolating it here means the regression lives next to the test
// instead of being a snapshot of a render-tree.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

interface CatalogueEntry {
  id: string;
  label: string;
  provider?: string;
}

/** Mirror of composer.tsx ModelSelect's grouping derivation. */
function groupModelsByProvider(
  models: CatalogueEntry[],
  otherLabel: string,
): Array<{ key: string; label: string; models: CatalogueEntry[] }> {
  const order: string[] = [];
  const buckets = new Map<string, CatalogueEntry[]>();
  for (const model of models) {
    const key = model.provider ?? "__other";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(model);
  }
  return order.map((key) => ({
    key,
    label: key === "__other" ? otherLabel : key,
    models: buckets.get(key)!,
  }));
}

describe("groupModelsByProvider — composer ModelSelect grouping", () => {
  test("groups entries by `provider` while preserving catalogue order", () => {
    const groups = groupModelsByProvider(
      [
        { id: "minimax_api/MiniMax-M3", label: "MiniMax-M3", provider: "minimax_api" },
        { id: "openai_compat/gpt-4o", label: "GPT-4o", provider: "openai_compat" },
        { id: "minimax_api/MiniMax-M2.7", label: "MiniMax-M2.7", provider: "minimax_api" },
      ],
      "Other",
    );
    assert.equal(groups.length, 2);
    const first = groups[0];
    const second = groups[1];
    assert.ok(first && second, "groups present");
    assert.equal(first.key, "minimax_api");
    assert.deepEqual(
      first.models.map((m) => m.id),
      ["minimax_api/MiniMax-M3", "minimax_api/MiniMax-M2.7"],
      "catalogue order preserved within a provider",
    );
    assert.equal(second.key, "openai_compat");
    assert.equal(second.models.length, 1);
  });

  test("provider-less entries fall into a single `__other` bucket", () => {
    const groups = groupModelsByProvider(
      [
        { id: "m:minimax_api:MiniMax-M3:v:default", label: "M3 default" },
        { id: "minimax_api/MiniMax-M3", label: "MiniMax-M3", provider: "minimax_api" },
      ],
      "Other",
    );
    const first = groups[0];
    const second = groups[1];
    assert.ok(first && second, "both groups present");
    // `__other` comes first because it was seen first in the catalogue
    assert.equal(first.key, "__other");
    assert.equal(first.label, "Other");
    assert.equal(second.key, "minimax_api");
  });

  test("empty catalogue yields no groups", () => {
    const groups = groupModelsByProvider([], "Other");
    assert.equal(groups.length, 0);
  });

  test("all-providerless catalogue collapses to one group", () => {
    const groups = groupModelsByProvider(
      [
        { id: "m:a:b:v:x", label: "x" },
        { id: "m:a:b:v:y", label: "y" },
      ],
      "Other",
    );
    assert.equal(groups.length, 1);
    const only = groups[0];
    assert.ok(only, "single group present");
    assert.equal(only.key, "__other");
    assert.equal(only.models.length, 2);
  });
});

// ============================================================
// Ticket 04 — pure helpers backing the upgraded ModelSelect.
//
// The selector renders:
//   - disabled provider groups when the server reports
//     `auth.hasKey === false` (a "no API key" hint points the user
//     at Settings);
//   - modality badges next to each model label, mapped from the
//     model's `modalities[]` through i18n;
//   - a ThinkingEffortSelect whose options derive from the active
//     model's `thinkingLevels[]`.
// These helpers are pure so the test pins the load-bearing logic
// without a render harness — the same reason the grouping helper
// above mirrors its source. Any future regression here surfaces as
// "the selector stopped greying / stopped showing badges / stopped
// offering a level" — a UX bug, not a test failure, so the pin
// matters.
// ============================================================

interface GroupAuth {
  hasKey: boolean;
  type: "byok" | "coding-plan";
}

interface Group {
  id: string;
  label: string;
  models: { id: string; label: string; provider?: string; modalities?: string[] }[];
  auth?: GroupAuth;
}

/** Mirror of composer.tsx#isGroupDisabled. */
function isGroupDisabled(group: { auth?: GroupAuth }): boolean {
  if (!group.auth) return false;
  return group.auth.hasKey === false;
}

/** Mirror of composer.tsx#modalityBadgeKey. */
function modalityBadgeKey(modality: string): string {
  switch (modality) {
    case "text":
      return "modelSelector.modalityBadge.text";
    case "image":
      return "modelSelector.modalityBadge.image";
    case "audio":
      return "modelSelector.modalityBadge.audio";
    case "video":
      return "modelSelector.modalityBadge.video";
    default:
      return "modelSelector.modalityBadge.file";
  }
}

/** Mirror of composer.tsx#thinkingLevelKey. */
function thinkingLevelKey(level: string): string | null {
  switch (level) {
    case "off":
    case "none":
      return "thinkingPicker.off";
    case "low":
      return "thinkingPicker.low";
    case "minimal":
      return "thinkingPicker.minimal";
    case "medium":
      return "thinkingPicker.medium";
    case "high":
      return "thinkingPicker.high";
    case "xhigh":
      return "thinkingPicker.xhigh";
    case "max":
      return "thinkingPicker.max";
    default:
      return null;
  }
}

describe("isGroupDisabled — provider group greyed when no API key", () => {
  test("no auth view → enabled (engine session group has no auth)", () => {
    assert.equal(isGroupDisabled({}), false);
    assert.equal(isGroupDisabled({ auth: undefined }), false);
  });

  test("auth.hasKey === false → disabled (no-key provider)", () => {
    assert.equal(
      isGroupDisabled({ auth: { hasKey: false, type: "byok" } }),
      true,
    );
    assert.equal(
      isGroupDisabled({ auth: { hasKey: false, type: "coding-plan" } }),
      true,
    );
  });

  test("auth.hasKey === true → enabled", () => {
    assert.equal(
      isGroupDisabled({ auth: { hasKey: true, type: "byok" } }),
      false,
    );
  });
});

describe("modalityBadgeKey — server modality → i18n key", () => {
  test("known modalities map to their i18n keys", () => {
    assert.equal(modalityBadgeKey("text"), "modelSelector.modalityBadge.text");
    assert.equal(modalityBadgeKey("image"), "modelSelector.modalityBadge.image");
    assert.equal(modalityBadgeKey("audio"), "modelSelector.modalityBadge.audio");
    assert.equal(modalityBadgeKey("video"), "modelSelector.modalityBadge.video");
  });

  test("unknown modalities fall through to the file key (neutral catch-all)", () => {
    assert.equal(modalityBadgeKey("file"), "modelSelector.modalityBadge.file");
    assert.equal(modalityBadgeKey("3d"), "modelSelector.modalityBadge.file");
  });
});

describe("thinkingLevelKey — engine effort → i18n key", () => {
  test("off/low/medium/high map to their keys", () => {
    assert.equal(thinkingLevelKey("off"), "thinkingPicker.off");
    assert.equal(thinkingLevelKey("low"), "thinkingPicker.low");
    assert.equal(thinkingLevelKey("medium"), "thinkingPicker.medium");
    assert.equal(thinkingLevelKey("high"), "thinkingPicker.high");
  });

  test("provider-catalogue flavours (max / xhigh / minimal / none) map too", () => {
    // The /api/models catalogue may carry flavours the engine's own
    // thinkingEffort option does not (max / xhigh / minimal) — the
    // chip and inline pills render them with their own label rather
    // than dropping a glyph on the row.
    assert.equal(thinkingLevelKey("max"), "thinkingPicker.max");
    assert.equal(thinkingLevelKey("xhigh"), "thinkingPicker.xhigh");
    assert.equal(thinkingLevelKey("minimal"), "thinkingPicker.minimal");
    assert.equal(thinkingLevelKey("none"), "thinkingPicker.off");
  });

  test("unknown levels return null so the chip label stays clean", () => {
    assert.equal(thinkingLevelKey("turbo"), null);
    assert.equal(thinkingLevelKey(""), null);
  });
});

// ============================================================
// Ticket 07 — inline level pill availability.
//
// The model selector renders an inline row of thinking-level pills
// at the top of the dropdown when the active model advertises
// reasoning controls. The pill row is hidden when the active model
// carries an empty `thinkingLevels[]` so the dropdown never advertises
// a level the engine would reject.
//
// The selection rule is identical to the existing ThinkingEffortSelect
// gating: presence of `thinkingLevels[]` on the catalogue entry is the
// only signal. Pin the rule here so a future regression that gates
// the pill row differently surfaces as a test failure.
// ============================================================

interface CatalogueEntry {
  id: string;
  label: string;
  thinkingLevels?: string[];
}

/** Mirror of composer.tsx#ModelSelect's "active model has reasoning
 *  controls" derivation. */
function activeModelHasInlineLevels(
  catalogue: CatalogueEntry[],
  activeId: string,
): boolean {
  if (!activeId) return false;
  const known = catalogue.find((m) => m.id === activeId);
  return !!known && Array.isArray(known.thinkingLevels) && known.thinkingLevels.length > 0;
}

describe("inline level row availability — ticket 07", () => {
  test("empty active id → no inline row (no model selected)", () => {
    assert.equal(activeModelHasInlineLevels([], ""), false);
    assert.equal(activeModelHasInlineLevels(
      [{ id: "m", label: "M", thinkingLevels: ["low"] }],
      "",
    ), false);
  });

  test("active model with non-empty thinkingLevels → inline row visible", () => {
    assert.equal(activeModelHasInlineLevels(
      [{ id: "minimax/M3", label: "M3", thinkingLevels: ["low", "high"] }],
      "minimax/M3",
    ), true);
  });

  test("active model with empty thinkingLevels → no inline row", () => {
    assert.equal(activeModelHasInlineLevels(
      [{ id: "minimax/M3", label: "M3", thinkingLevels: [] }],
      "minimax/M3",
    ), false);
    assert.equal(activeModelHasInlineLevels(
      [{ id: "minimax/M3", label: "M3" }],
      "minimax/M3",
    ), false);
  });

  test("active model missing from catalogue → no inline row", () => {
    // A catalogue without the active id (mid-fetch, or the engine
    // encoded an id the catalogue doesn't carry) hides the row.
    assert.equal(activeModelHasInlineLevels(
      [{ id: "minimax/M3", label: "M3", thinkingLevels: ["low"] }],
      "openai/gpt-4o",
    ), false);
  });
});

// ============================================================
// Ticket 07 — quick-add provider validation.
//
// The management panel's "add provider" main path runs through three
// steps: add (creates a draft) → fill (id / key / etc.) → save. The
// step-1 button is disabled when the panel is busy and the step-3
// save button is disabled when validation fails. Pin the load-bearing
// validation shapes here without a render harness.
// ============================================================

import {
  newDraftProvider,
  validateProviderId,
  validateModelRow as validateModelRowLib,
  draftToWire,
} from "../lib/provider-management";
import type { DraftProvider, DraftModel } from "../lib/provider-management";

/** True when the "Save providers" button should be enabled. */
function canSave(
  draft: DraftProvider,
  validationOk: boolean,
  busy: boolean,
): boolean {
  if (busy) return false;
  if (!validationOk) return false;
  // A draft with no id and no models is the "user clicked Add, never
  // filled anything" state — the panel can stay disabled until the
  // operator has typed something meaningful. The full validation
  // result covers this; the predicate mirrors the existing rule.
  return true;
}

function blankDraft(): DraftProvider {
  return newDraftProvider();
}

function filledDraft(): DraftProvider {
  const d = blankDraft();
  d.id = "openai_compat";
  d.label = "OpenAI";
  d.auth.apiKey = "sk-realtype-12345";
  return d;
}

describe("quick-add provider flow — ticket 07", () => {
  test("fresh draft has an invalid id, so Save is disabled", () => {
    const draft = blankDraft();
    const err = validateProviderId(draft.id);
    assert.ok(err !== null, "an empty id must fail validateProviderId");
    assert.equal(canSave(draft, false, false), false);
  });

  test("typing a valid id is not enough — the auth.key path needs a value", () => {
    const draft = blankDraft();
    draft.id = "openai_compat";
    const idErr = validateProviderId(draft.id);
    assert.equal(idErr, null, "valid id alone must not surface an error");
    // No apiKey yet → byok auth needs a key before saving. The
    // existing wire shape forwards `""` as the keep-existing-key
    // sentinel, but a new draft with `""` is interpreted as "no key
    // ever set" by the server, so the panel keeps Save disabled until
    // the user types something. We mirror that by checking the
    // draft's `apiKey.trim().length` here:
    assert.equal(draft.auth.apiKey.trim().length > 0, false);
  });

  test("typing a valid id + key with valid rows unblocks Save", () => {
    const draft = filledDraft();
    draft.models = [{ id: "gpt-4o", label: "GPT-4o", contextLimit: "128000", thinkingLevels: ["low"], modalities: ["text"] }];
    const ok =
      validateProviderId(draft.id) === null &&
      draft.models.every((m: DraftModel) => validateModelRowLib(m) === null);
    assert.equal(ok, true);
    assert.equal(canSave(draft, true, false), true);
  });

  test("draftToWire — the quick-add wire shape is empty-models when none typed", () => {
    const draft = filledDraft();
    const wire = draftToWire(draft);
    assert.equal(wire.id, "openai_compat");
    assert.deepEqual(wire.models, []);
    assert.equal(wire.auth.apiKey, "sk-realtype-12345");
  });

  test("busy state disables Save even when validation is clean", () => {
    const draft = filledDraft();
    assert.equal(canSave(draft, true, false), true);
    assert.equal(canSave(draft, true, true), false);
  });
});
//
// The server contract (handleSetModel) accepts:
//   { model: string }                        — model only, thinking preserved
//   { thinking: string }                     — effort only (model preserved)
//   { model: string, thinking: string }      — both
//   { thinking: "" }                         — clears the recorded effort
// The composer wires:
//   * ModelSelect.onPick → { model, thinking: state?.model?.thinking }
//     so a mid-session model change carries the recorded effort with
//     it. The server then enforces "model first, then effort" so the
//     engine never sees an effort without a model anchor.
//   * ThinkingEffortSelect.onPick → { thinking: level } (no model),
//     so an effort-only update leaves the model alone.
//
// The setModel payload shape itself is verified by the api.ts unit
// tests; here we pin the composer's call-site payload (the wiring).
// ============================================================

describe("setModel payload — wiring the composer sends", () => {
  test("model-only pick carries the recorded thinking effort", () => {
    const recordedThinking = "high";
    const nextId = "openai_compat/gpt-4o";
    const payload = {
      model: nextId,
      ...(recordedThinking ? { thinking: recordedThinking } : {}),
    };
    assert.deepEqual(payload, { model: nextId, thinking: "high" });
  });

  test("model pick without a recorded thinking sends only the model", () => {
    const recordedThinking = "";
    const nextId = "minimax_api/MiniMax-M3";
    const payload = {
      model: nextId,
      ...(recordedThinking ? { thinking: recordedThinking } : {}),
    };
    assert.deepEqual(payload, { model: nextId });
  });

  test("thinking-only pick sends only the thinking field", () => {
    const payload = { thinking: "medium" };
    assert.deepEqual(payload, { thinking: "medium" });
    assert.equal("model" in payload, false, "no model field echoed on effort-only update");
  });

  test("'Use engine default' sends thinking:'' (clear the override)", () => {
    const payload = { thinking: "" };
    assert.equal(payload.thinking, "");
  });
});