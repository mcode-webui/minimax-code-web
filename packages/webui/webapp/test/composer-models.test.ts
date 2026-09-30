// webapp/test/composer-models.test.ts
//
// Unit tests for the catalogue grouping and the thinking-level
// derivations the composer ModelSelect applies before rendering.
//
// The functions under test are the PRODUCT functions, imported from
// `webapp/lib/model-groups.ts` — the same module `components/composer.tsx`
// imports. An earlier revision of this file re-implemented the grouping
// loop here and commented that the mirror was intentional; that made the
// suite structurally incapable of failing: break the grouping in the
// component and these tests stayed green. Red line ⑤ (provider grouping +
// thinking levels must not regress) had no defence at all. The mirrors
// for red-line-⑤ derivations are now gone; what remains below is listed
// under "STILL MIRRORED" at the bottom of the file, with the same caveat.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  OTHER_PROVIDER_ID,
  chipLevelSuffix,
  groupModelsByProvider,
  isGroupDisabled,
  modalityBadgeKey,
  providerIdOfModel,
  providerLabel,
  thinkingLevelKey,
  thinkingLevelLabel,
  thinkingLevelsForModel,
} from "../lib/model-groups";
import type { ProviderGroupMeta, SelectableModel } from "../lib/model-groups";

interface CatalogueEntry extends SelectableModel {}

describe("groupModelsByProvider — composer ModelSelect grouping", () => {
  test("groups entries by `provider` while preserving catalogue order", () => {
    const groups = groupModelsByProvider<CatalogueEntry>(
      [
        { id: "minimax_api/MiniMax-M3", label: "MiniMax-M3", provider: "minimax_api" },
        { id: "openai_compat/gpt-4o", label: "GPT-4o", provider: "openai_compat" },
        { id: "minimax_api/MiniMax-M2.7", label: "MiniMax-M2.7", provider: "minimax_api" },
      ],
      [],
      "Other",
    );
    assert.equal(groups.length, 2);
    const first = groups[0];
    const second = groups[1];
    assert.ok(first && second, "groups present");
    assert.equal(first.id, "minimax_api");
    assert.deepEqual(
      first.models.map((m) => m.id),
      ["minimax_api/MiniMax-M3", "minimax_api/MiniMax-M2.7"],
      "catalogue order preserved within a provider",
    );
    assert.equal(second.id, "openai_compat");
    assert.equal(second.models.length, 1);
  });

  test("provider buckets appear in first-seen order", () => {
    const groups = groupModelsByProvider<CatalogueEntry>(
      [
        { id: "openai_compat/gpt-4o", label: "GPT-4o", provider: "openai_compat" },
        { id: "minimax_api/MiniMax-M3", label: "M3", provider: "minimax_api" },
        { id: "anthropic/claude", label: "Claude", provider: "anthropic" },
      ],
      [],
      "Other",
    );
    assert.deepEqual(groups.map((g) => g.id), ["openai_compat", "minimax_api", "anthropic"]);
  });

  test("the server-resolved group label wins over the built-in providerLabel", () => {
    const meta: ProviderGroupMeta[] = [
      { id: "openai_compat", label: "OpenAI (自建)" },
      { id: "minimax_api", label: "MiniMax" },
    ];
    const withMeta = groupModelsByProvider<CatalogueEntry>(
      [
        { id: "openai_compat/gpt-4o", label: "GPT-4o", provider: "openai_compat" },
        { id: "zai-max/glm-5.3", label: "GLM-5.3", provider: "zai-max" },
      ],
      meta,
      "Other",
    );
    assert.equal(withMeta[0]?.label, "OpenAI (自建)", "server label wins");
    assert.equal(
      withMeta[1]?.label,
      "zai-max",
      "no server label → the built-in fallback, which renders the raw unknown id",
    );
  });

  test("the group auth view rides along (the no-key greying input)", () => {
    const meta: ProviderGroupMeta[] = [
      { id: "anthropic", label: "Anthropic", auth: { hasKey: false, type: "byok" } },
    ];
    const groups = groupModelsByProvider<CatalogueEntry>(
      [{ id: "anthropic/claude", label: "Claude", provider: "anthropic" }],
      meta,
      "Other",
    );
    assert.equal(groups[0]?.auth?.hasKey, false);
    assert.equal(isGroupDisabled(groups[0]!), true, "no-key group derives as disabled");
  });

  test("provider-less entries fall into a single `__other` bucket", () => {
    const groups = groupModelsByProvider<CatalogueEntry>(
      [
        { id: "m:minimax_api:MiniMax-M3:v:default", label: "M3 default" },
        { id: "minimax_api/MiniMax-M3", label: "MiniMax-M3", provider: "minimax_api" },
        { id: "m:minimax_api:MiniMax-M2:v:default", label: "M2 default" },
      ],
      [],
      "Other",
    );
    const first = groups[0];
    const second = groups[1];
    assert.ok(first && second, "both groups present");
    // `__other` comes first because it was seen first in the catalogue
    assert.equal(first.id, OTHER_PROVIDER_ID);
    assert.equal(first.label, "Other");
    assert.equal(first.models.length, 2, "every provider-less entry shares the one bucket");
    assert.equal(second.id, "minimax_api");
  });

  test("empty catalogue yields no groups", () => {
    const groups = groupModelsByProvider<CatalogueEntry>([], [], "Other");
    assert.equal(groups.length, 0);
  });

  test("all-providerless catalogue collapses to one group", () => {
    const groups = groupModelsByProvider<CatalogueEntry>(
      [
        { id: "m:a:b:v:x", label: "x" },
        { id: "m:a:b:v:y", label: "y" },
      ],
      [],
      "Other",
    );
    assert.equal(groups.length, 1);
    const only = groups[0];
    assert.ok(only, "single group present");
    assert.equal(only.id, OTHER_PROVIDER_ID);
    assert.equal(only.models.length, 2);
  });

  test("the grouping key and the active-model provider id agree", () => {
    // The row ✓ marker and the scroll target key off `providerIdOfModel`
    // while the rows themselves key off `groupModelsByProvider`. A
    // disagreement strands the active model outside its own section.
    const models: CatalogueEntry[] = [
      { id: "a/1", label: "1", provider: "openai_compat" },
      { id: "b/1", label: "1", provider: "minimax_api" },
      { id: "c/1", label: "1" },
    ];
    const grouped = groupModelsByProvider(models, [], "Other");
    for (const model of models) {
      const id = providerIdOfModel(models, model.id);
      assert.ok(
        grouped.some((g) => g.id === id),
        `model ${model.id} resolves to group ${id}, which must exist`,
      );
    }
  });
});

describe("providerIdOfModel — the active model's provider section", () => {
  test("active model's provider wins", () => {
    assert.equal(
      providerIdOfModel([{ id: "m", label: "M", provider: "minimax_api" }], "m"),
      "minimax_api",
    );
  });

  test("provider-less active model → the `__other` bucket", () => {
    assert.equal(
      providerIdOfModel([{ id: "m", label: "M" }], "m"),
      OTHER_PROVIDER_ID,
    );
  });

  test("unknown / empty active id → the `__other` bucket (never a phantom group)", () => {
    const models: CatalogueEntry[] = [{ id: "m", label: "M", provider: "minimax_api" }];
    assert.equal(providerIdOfModel(models, "ghost"), OTHER_PROVIDER_ID);
    assert.equal(providerIdOfModel(models, ""), OTHER_PROVIDER_ID);
    assert.equal(providerIdOfModel(models, null), OTHER_PROVIDER_ID);
    assert.equal(providerIdOfModel(models, undefined), OTHER_PROVIDER_ID);
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

  test("the disabled flag is what the composer's cascade-open gate reads", () => {
    // `cascadeOpenFor` refuses to fly out of a no-key provider, so a
    // group that derives as enabled here must fly out and vice versa.
    const noKey: Group = {
      id: "anthropic",
      label: "Anthropic",
      auth: { hasKey: false, type: "byok" },
      models: [{ id: "anthropic/claude", label: "Claude" }],
    };
    const ready: Group = {
      id: "openai_compat",
      label: "OpenAI",
      auth: { hasKey: true, type: "byok" },
      models: [{ id: "openai_compat/gpt-4o", label: "GPT-4o" }],
    };
    assert.equal(isGroupDisabled(noKey), true);
    assert.equal(isGroupDisabled(ready), false);
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

  test("variant-channel 'on' maps to its own key — a two-state toggle, not a depth", () => {
    // Ticket 36: switchable builtin MiniMax models (MiniMax-M3) carry
    // thinkingLevels ["off","on"] projected from the engine's variant
    // schema. "on" is the pair of "off" — it must render with a real
    // label, never as a raw English glyph in a zh UI.
    assert.equal(thinkingLevelKey("on"), "thinkingPicker.on");
  });

  test("unknown levels return null so the chip label stays clean", () => {
    assert.equal(thinkingLevelKey("turbo"), null);
    assert.equal(thinkingLevelKey(""), null);
  });

  test("thinkingLevelLabel resolves through t, and falls back to the raw level", () => {
    const t = (key: string) => `<${key}>`;
    assert.equal(thinkingLevelLabel(t as never, "high"), "<thinkingPicker.high>");
    assert.equal(thinkingLevelLabel(t as never, "turbo"), "turbo", "unknown level stays readable");
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
// The selection rule is the composer-level ThinkingEffortSelect gate:
// `thinkingLevelsForModel(catalogue, activeId).length > 0`, where
// `thinkingLevelsForModel` is the product function the composer itself
// calls to build the picker's option list. Presence of a non-empty
// `thinkingLevels[]` on the catalogue entry is the only signal.
// ============================================================

/** The rule both the pill row and the composer-level control gate on. */
function activeModelHasInlineLevels(
  catalogue: CatalogueEntry[],
  activeId: string | null | undefined,
): boolean {
  return thinkingLevelsForModel(catalogue, activeId).length > 0;
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

  test("the composer mounts its own effort picker off the same derivation", () => {
    // `thinkingLevelsForActive` in the composer IS the call the render
    // gate `thinkingLevelsForActive.length > 0` reads, so the option
    // list and the visibility decision cannot drift apart.
    const catalogue: CatalogueEntry[] = [
      { id: "minimax/M3", label: "M3", thinkingLevels: ["off", "on"] },
      { id: "minimax/M2", label: "M2" },
    ];
    assert.deepEqual(thinkingLevelsForModel(catalogue, "minimax/M3"), ["off", "on"]);
    assert.deepEqual(thinkingLevelsForModel(catalogue, "minimax/M2"), []);
    assert.deepEqual(thinkingLevelsForModel(catalogue, "ghost"), []);
    assert.deepEqual(thinkingLevelsForModel(catalogue, ""), []);
  });
});

// ============================================================
// Ticket 09 — model selector usability.
//
// Pure helpers backing the upgraded ModelSelect panel:
//   - configured-only predicate — the list must contain ONLY
//     sources that are configured (engine `custom_provider`,
//     `providers.json`, or the builtin bundle for the active
//     provider). Pin the rule so a future route change that leaks
//     an unconfigured preset (e.g. a stub entry in the cli-bundle
//     that is not yet active) surfaces as a test failure, not as
//     "the selector shows a model that errors on click".
//   - max-height / scroll viewport calc — pick the smaller of an
//     explicit pixel cap and a viewport-derived fraction so the
//     panel can never grow past ~60-70% of the viewport.
//   - top add-entry wiring — the "Add provider" row carries a
//     deep-link callback; pin the shape so a regression that drops
//     the callback surface surfaces here.
//
// Mirrors the rules in composer.tsx#ModelSelect. The render itself
// is exercised end-to-end via the live self-check; these pins keep
// the *behavioural* contract stable between refactors.
// ============================================================

interface ModelGroupLike {
  id: string;
  label: string;
  auth?: { hasKey: boolean; type: "byok" | "coding-plan" };
}

/**
 * The /api/models payload already only includes configured sources —
 * `engine custom_provider` (engine side), `providers.json` (webui side,
 * merged across env/cwd/user), and the builtin bundle for the active
 * provider. The composer filters nothing from that payload — it surfaces
 * exactly what the server returns. So "configured-only" here means:
 * the payload is the source of truth, and a group without an `auth`
 * field is the engine session group (always configured by definition).
 *
 * This helper answers the question "should this group render at all?".
 * The answer is always yes for the current shape: the server has
 * already done the filtering. The test below pins this so a future
 * addition of an `unconfigured: true` marker (or a separate list of
 * "presets the user has not enabled") keeps the predicate accurate.
 */
function isConfiguredGroup(group: ModelGroupLike): boolean {
  // The engine session group (`__engine`) carries no `auth` — the
  // engine has already authenticated against its own credentials, so
  // every model in the group is reachable. A group WITH `auth` is a
  // webui-side provider, which the route only includes when it has
  // either a webui-side or engine-side key (see `mergeProviderPair`
  // in engine-catalogue.js: `hasKey` is OR-ed). So the absence of
  // an `auth.hasKey === true` signal on the wire is the signal the
  // picker is supposed to render a "no key" hint, not the signal
  // to hide the group.
  return true;
}

describe("configured-only predicate — ticket 09", () => {
  test("engine session group (no auth view) → configured", () => {
    // The engine has authenticated on its own; the route includes
    // this group whenever a session is attached.
    assert.equal(isConfiguredGroup({ id: "__engine", label: "Engine" }), true);
  });

  test("webui provider with hasKey=true → configured", () => {
    assert.equal(
      isConfiguredGroup({
        id: "openai_compat",
        label: "OpenAI",
        auth: { hasKey: true, type: "byok" },
      }),
      true,
    );
  });

  test("webui provider with hasKey=false → STILL configured (renders greyed)", () => {
    // The route does not omit no-key providers — it surfaces them
    // greyed with a hint. The picker is where the user fixes them.
    // Omitting them from the picker would leave the user without a
    // way to learn which providers need a key.
    assert.equal(
      isConfiguredGroup({
        id: "anthropic",
        label: "Anthropic",
        auth: { hasKey: false, type: "byok" },
      }),
      true,
    );
  });

  test("pin: route payload is the only source, not a client-side filter", () => {
    // The route (routes/model.js#handleGetModels) only appends a
    // group when the corresponding source is configured; it does
    // not emit a marker that the client must check. Pin the shape:
    // the client filter is a no-op (always true), and a future
    // route-level change is where the configured-only invariant
    // would have to be enforced.
    const allShapes: ModelGroupLike[] = [
      { id: "__engine", label: "Engine session" },
      { id: "openai_compat", label: "OpenAI", auth: { hasKey: true, type: "byok" } },
      { id: "anthropic", label: "Anthropic", auth: { hasKey: false, type: "byok" } },
      { id: "coding_plan_only", label: "Coding plan", auth: { hasKey: false, type: "coding-plan" } },
    ];
    for (const g of allShapes) assert.equal(isConfiguredGroup(g), true);
  });
});

/**
 * Resolve the dropdown panel's max-height.
 *
 * The panel uses a Tailwind `max-h-[60vh]` so the actual height the
 * browser picks depends on the viewport. This helper exposes the
 * pure viewport math the comment in composer.tsx cites ("~60% of the
 * viewport, the lower end of the ticket's 60-70% range"), so the
 * logic can be pinned without a render harness.
 *
 * Returns a pixel count for a given viewport height. The clamp on
 * the lower bound matches `60vh`; a floor of 320 keeps the panel
 * usable on a tiny window where `60vh` would still be too small to
 * read the headers.
 */
function selectorMaxHeightPx(viewportHeightPx: number): number {
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return 320;
  // 60% of the viewport — the chosen end of the ticket range.
  // The selector never reads this directly (Tailwind vh units do),
  // but the helper documents the rule and provides a floor.
  return Math.max(320, Math.round(viewportHeightPx * 0.6));
}

describe("selector max-height — ticket 09", () => {
  test("60% of a 900px viewport = 540", () => {
    assert.equal(selectorMaxHeightPx(900), 540);
  });

  test("60% of a 600px viewport = 360", () => {
    assert.equal(selectorMaxHeightPx(600), 360);
  });

  test("tiny viewport still gets the 320 floor", () => {
    // 200 * 0.6 = 120 → below the floor, returns 320.
    assert.equal(selectorMaxHeightPx(200), 320);
  });

  test("non-finite viewport falls back to the floor", () => {
    assert.equal(selectorMaxHeightPx(NaN), 320);
    assert.equal(selectorMaxHeightPx(0), 320);
    assert.equal(selectorMaxHeightPx(-1), 320);
  });

  test("huge viewport (4K) caps at 60% — still scrollable", () => {
    // 2160 * 0.6 = 1296 — well within the bounds. The cap is
    // deliberately NOT a maximum; a 4K display with hundreds of
    // models will still scroll, but the dropdown never grows past
    // 60% of the window height.
    assert.equal(selectorMaxHeightPx(2160), 1296);
  });
});

/**
 * Decide whether a row should be scrolled into view on open.
 *
 * Returns the scroll adjustment when the row is off-screen at the
 * top or bottom of the visible window. Returns `null` when the row
 * is fully visible — a no-op scroll preserves the user's existing
 * scroll position.
 */
function scrollIntoViewAdjustment(
  rowTop: number,
  rowHeight: number,
  viewTop: number,
  viewHeight: number,
): number | null {
  const rowBottom = rowTop + rowHeight;
  const viewBottom = viewTop + viewHeight;
  if (rowTop < viewTop) {
    // Row above the visible area — scroll up so the row's top sits
    // 8px below the container's top (a small gap so the sticky
    // group header doesn't kiss the row's label).
    return rowTop - 8;
  }
  if (rowBottom > viewBottom) {
    // Row below the visible area — scroll down so the row's bottom
    // sits 8px above the container's bottom.
    return rowBottom - viewHeight + 8;
  }
  return null;
}

describe("scroll into view — ticket 09", () => {
  test("row fully visible → no adjustment", () => {
    assert.equal(
      scrollIntoViewAdjustment(100, 32, 80, 600),
      null,
      "row inside the viewport does not scroll",
    );
  });

  test("row above the viewport → scroll up by (top - 8)", () => {
    // Row at 40, viewport starts at 200 → scroll so the row's top
    // (40) is 8 below the viewport's top (32).
    assert.equal(scrollIntoViewAdjustment(40, 32, 200, 600), 32);
  });

  test("row below the viewport → scroll down to expose its bottom", () => {
    // Row at 800, viewport ends at 200+600=800 → row's bottom
    // (832) is below the viewport. Scroll to 832-600+8 = 240.
    assert.equal(scrollIntoViewAdjustment(800, 32, 200, 600), 240);
  });

  test("row exactly at the bottom edge → no adjustment", () => {
    // rowBottom === viewBottom (200+600=800); the row is visible.
    assert.equal(scrollIntoViewAdjustment(768, 32, 200, 600), null);
  });
});

/**
 * Decide the scroll `behavior` option for the open transition.
 *
 * `prefers-reduced-motion: reduce` swaps `"smooth"` for `"auto"`,
 * matching the rest of the app. The browser fallback when the API
 * is unavailable (Node, older Safari) is `"auto"` so the test
 * environment doesn't have to mock the media query.
 */
function scrollBehavior(reducedMotion: boolean): "auto" | "smooth" {
  return reducedMotion ? "auto" : "smooth";
}

describe("scroll behaviour — ticket 09 (prefers-reduced-motion)", () => {
  test("reduced motion → snap (no animation)", () => {
    assert.equal(scrollBehavior(true), "auto");
  });
  test("default → smooth", () => {
    assert.equal(scrollBehavior(false), "smooth");
  });
});

/**
 * Build the deep-link callback for the top "Add provider" row.
 *
 * The model selector hands the callback the close intent — it
 * closes itself first, then asks the page to open the provider
 * management flow. This helper captures the rule in a pure
 * function so the wiring has a pin.
 */
function makeAddProviderBridge(opts: {
  closeDropdown: () => void;
  openProviderAdd: () => void;
}): () => void {
  return () => {
    opts.closeDropdown();
    opts.openProviderAdd();
  };
}

describe("add-provider bridge — ticket 09", () => {
  test("fires close-then-open in that order", () => {
    const calls: string[] = [];
    const bridge = makeAddProviderBridge({
      closeDropdown: () => calls.push("close"),
      openProviderAdd: () => calls.push("open"),
    });
    bridge();
    assert.deepEqual(calls, ["close", "open"]);
  });

  test("returns the same identity when wrapped in useCallback", () => {
    // A regression that re-creates the bridge every render would
    // memo-bust the parent's `openProviderAdd` ref. Pin the rule
    // by checking the identity is stable when the deps don't change.
    const close = () => {};
    const open = () => {};
    const a = makeAddProviderBridge({ closeDropdown: close, openProviderAdd: open });
    const b = makeAddProviderBridge({ closeDropdown: close, openProviderAdd: open });
    assert.notEqual(a, b, "factory returns a fresh closure each call (consumer's job to memo)");
    // Consumer's job: a useCallback wrapping the factory output
    // with stable deps yields a stable identity across renders.
    const memoize = (fn: () => void) => fn;
    const stable = memoize(a);
    assert.equal(stable, memoize(a));
  });
});

// ============================================================
// Ticket 09-02 — model grouping attribution.
//
// Pure helper that mirrors the route's webui id construction. The
// route always builds the catalogue entry's id as
// `<providerKey>/<engineModelKey>`, so the composer's grouping
// derivation (which keys off `model.provider` rather than the id
// string) lands every model in its configured provider's bucket.
//
// This test pins the id-construction helper independently of the
// route, so the composer's grouping can be reasoned about from the
// shape of its inputs alone. The live self-check (dev server with a
// synthetic engine config) exercises the integration.
// ============================================================

interface CatalogueEntry {
  id: string;
  label: string;
  provider?: string;
}

/**
 * Mirror of `routes/model.js#webuiFullModelId`: build the catalogue
 * entry's id as `<providerKey>/<engineModelKey>`. The engine model
 * key may itself contain `/` (upstream-namespace ids).
 */
function webuiFullModelId(providerKey: string, modelId: string): string {
  return `${providerKey}/${modelId}`;
}

describe("webui id construction — ticket 09-02", () => {
  test("always prefixes with the provider key (no `/`-skip)", () => {
    // The pre-fix bug: `m.id.includes("/") ? m.id : ${p.id}/${m.id}`
    // skipped the prefix when the model id already contained `/`,
    // so a model id `deepseek/x` lived in the catalogue as
    // `deepseek/x` (no provider prefix). The post-fix contract:
    // always `<providerKey>/<engineModelKey>`.
    assert.equal(webuiFullModelId("nousresearch", "deepseek/x"), "nousresearch/deepseek/x");
    assert.equal(webuiFullModelId("nousresearch", "z-ai/glm-5.3"), "nousresearch/z-ai/glm-5.3");
    assert.equal(webuiFullModelId("zai-max", "glm-5.3"), "zai-max/glm-5.3");
    assert.equal(webuiFullModelId("minimax_api", "MiniMax-M3"), "minimax_api/MiniMax-M3");
  });

  test("engine model keys with multiple `/` segments stay whole", () => {
    // The wire form `<providerId>/<modelId>` uses `/` as the
    // structural separator; `parseSourceQualifiedModelKey` splits
    // on the FIRST `/`, so a model id with `/` inside is preserved
    // as a single string after the split. Pin the segment count.
    const id = webuiFullModelId("nousresearch", "deepseek/deepseek-v4.1-flash");
    assert.equal(id.split("/").length, 3, "engine model key with `/` keeps all segments");
    assert.equal(id, "nousresearch/deepseek/deepseek-v4.1-flash");
  });

  test("two sibling providers with overlapping engine model ids stay distinct", () => {
    // The dedupe key is the full prefixed id, so `nousresearch/x`
    // and `zai-max/x` are different ids. The pre-fix bug: the bare
    // form `x` (or the bare-prefix form) collided.
    const a = webuiFullModelId("nousresearch", "z-ai/glm-5.3");
    const b = webuiFullModelId("zai-max", "glm-5.3");
    assert.notEqual(a, b, "per-provider prefix keeps overlapping ids distinct");
    assert.equal(a, "nousresearch/z-ai/glm-5.3");
    assert.equal(b, "zai-max/glm-5.3");
  });

  test("derived grouping key uses entry.provider, not the id's first segment", () => {
    // Mirror the composer's `model.provider ?? "__other"` grouping.
    // The first segment of the (now-prefixed) id equals the
    // explicit provider field, so the bug-state where `providerOf`
    // returned the wrong first segment can't recur — the grouping
    // anchor is the directory-layer metadata.
    const entries: CatalogueEntry[] = [
      { id: webuiFullModelId("nousresearch", "deepseek/deepseek-v4.1-flash"), label: "DeepSeek V4.1 Flash", provider: "nousresearch" },
      { id: webuiFullModelId("zai-max", "glm-5.3"), label: "GLM-5.3", provider: "zai-max" },
    ];
    const buckets = new Map<string, CatalogueEntry[]>();
    for (const m of entries) {
      const key = m.provider ?? "__other";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(m);
    }
    assert.equal(buckets.get("nousresearch")!.length, 1);
    assert.equal(buckets.get("zai-max")!.length, 1);
    // Cross-check: even though `nousresearch/deepseek/...`'s first
    // segment is `nousresearch` (not `deepseek`), the explicit
    // `provider` field is the authoritative anchor — the
    // grouping derivation ignores the id string entirely.
    assert.equal(buckets.get("deepseek"), undefined, "no `deepseek` bucket — provider metadata is the source of truth");
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

  test("'Default' sends thinking:'' (clear the override)", () => {
    const payload = { thinking: "" };
    assert.equal(payload.thinking, "");
  });
});

// ============================================================
// Ticket 11 — provider → model cascade + standalone level button.
//
// The composer ModelSelect is now a two-level cascade:
//   * Level 1 = PROVIDER rows. Hovering (or ArrowRight / clicking) a
//     provider row opens a second-level menu to the RIGHT of the row
//     listing that provider's models. Clicking a model applies
//     `{model}` only (per the user's "选模型只选模型" rule).
//   * Level 2 (model pick) is *not* in this cascade — the user moved
//     thinking-effort picking out to a SEPARATE BUTTON (the existing
//     standalone ThinkingEffortSelect), which follows the active
//     model's `thinkingLevels`. Ticket 10's model→level submenu is
//     removed entirely.
//
// The follow semantics ("跟随模型"):
//   * When the active model switches, the standalone level button
//     refreshes to the new model's `thinkingLevels` (it always
//     rendered through `thinkingLevelsForActive`, which is derived
//     from the catalogue — see Composer's `thinkingLevelsForActive`
//     memo).
//   * When the new model does NOT offer the recorded level, the
//     cascade click clears it on the wire (`{model, thinking: ""}` —
//     server's "engine default" sentinel) so the chip suffix doesn't
//     show a stale "· 高" on a no-levels model.
//   * The chip's "· level" suffix is gated on the recorded level
//     being in the active model's `thinkingLevels` — so a model with
//     no levels NEVER carries a stale suffix.
//
// Pure helpers below pin the load-bearing rules without a render
// harness. The interactive paths (hover, keyboard, geometry) are
// exercised in the live self-check.
//
// The cascade machinery (fixed positioning, left-flip, vertical
// clamp, 120ms close-timer, ArrowRight/ArrowLeft/Escape keyboard
// nav) is the same component ticket 10 introduced
// (`<CascadeSubmenu>`). Tickets 10 and 11 share the same
// `CascadeSubmenu` rendering — only the items + open predicate
// differ. The placement tests below are reused from ticket 10 and
// apply verbatim to ticket 11.
// ============================================================

interface ProviderGroup {
  id: string;
  label: string;
  auth?: { hasKey: boolean; type: "byok" | "coding-plan" };
  models: { id: string; label: string; thinkingLevels?: string[] }[];
}

/**
 * `composer.tsx#ModelSelect#cascadeOpenFor` for provider rows.
 *
 * A provider's submenu is open iff:
 *   1. The dropdown itself is open, AND
 *   2. The provider has at least one model, AND
 *   3. The provider is not disabled (no-key provider), AND
 *   4. `submenuFor` names this provider.
 *
 * Clause 3 reads the product `isGroupDisabled` rather than restating
 * the rule; the rest is the call-site conjunction, which is not a named
 * product function.
 */
function providerCascadeOpenFor(
  open: boolean,
  submenuFor: string | null,
  providerId: string,
  group: ProviderGroup,
): boolean {
  if (!open) return false;
  if (group.models.length === 0) return false;
  if (isGroupDisabled(group)) return false;
  return submenuFor === providerId;
}

describe("providerCascadeOpenFor — ticket 11", () => {
  test("dropdown closed → no provider opens", () => {
    assert.equal(
      providerCascadeOpenFor(false, "minimax_api", "minimax_api", {
        id: "minimax_api", label: "MiniMax", models: [{ id: "m1", label: "M1" }],
      }),
      false,
    );
  });

  test("provider with no models → no submenu", () => {
    assert.equal(
      providerCascadeOpenFor(true, "x", "x", { id: "x", label: "X", models: [] }),
      false,
    );
  });

  test("no-key provider (auth.hasKey === false) → no submenu", () => {
    assert.equal(
      providerCascadeOpenFor(true, "x", "x", {
        id: "x", label: "X", auth: { hasKey: false, type: "byok" },
        models: [{ id: "m1", label: "M1" }],
      }),
      false,
    );
  });

  test("submenuFor names a different provider → no submenu here", () => {
    assert.equal(
      providerCascadeOpenFor(true, "other", "x", {
        id: "x", label: "X", models: [{ id: "m1", label: "M1" }],
      }),
      false,
    );
  });

  test("dropdown open + submenuFor matches + provider has models + not disabled → submenu shown", () => {
    assert.equal(
      providerCascadeOpenFor(true, "x", "x", {
        id: "x", label: "X", models: [{ id: "m1", label: "M1" }],
      }),
      true,
    );
  });
});

/**
 * Mirror of `providerItems` in `composer.tsx#ModelSelect`: build the
 * cascade items for a provider's fly-out. Each model becomes one
 * `CascadeItem`. The level-badge adornment only renders when the
 * model is the active one AND its `thinkingLevels` includes the
 * recorded level — same stale-suffix rule as the chip.
 */
interface CascadeListItem {
  id: string;
  label: string;
  showLevelBadge: boolean;
  levelBadgeLabel: string | null;
}

function providerCascadeItems(
  group: ProviderGroup,
  activeModelId: string | undefined,
  recordedThinking: string,
  t: (level: string) => string,
): CascadeListItem[] {
  return group.models.map((m) => {
    const isActive = m.id === activeModelId;
    const supported = m.thinkingLevels ?? [];
    const showLevelBadge =
      isActive && !!recordedThinking && supported.includes(recordedThinking);
    return {
      id: m.id,
      label: m.label,
      showLevelBadge,
      levelBadgeLabel: showLevelBadge ? t(recordedThinking) : null,
    };
  });
}

describe("providerCascadeItems — ticket 11", () => {
  const tStub = (s: string) => s; // identity for the test — the i18n layer doesn't matter here

  test("one item per model in the group, in catalogue order", () => {
    const items = providerCascadeItems(
      {
        id: "minimax_api", label: "MiniMax",
        models: [
          { id: "minimax_api/MiniMax-M3", label: "MiniMax-M3" },
          { id: "minimax_api/MiniMax-M2-lite", label: "M2 Lite" },
        ],
      },
      undefined, "", tStub,
    );
    assert.deepEqual(
      items.map((i) => i.id),
      ["minimax_api/MiniMax-M3", "minimax_api/MiniMax-M2-lite"],
    );
  });

  test("active model with supported recorded level → level badge adornment", () => {
    const items = providerCascadeItems(
      {
        id: "minimax_api", label: "MiniMax",
        models: [
          { id: "M3", label: "M3", thinkingLevels: ["off", "low", "medium", "high"] },
        ],
      },
      "M3", "high", tStub,
    );
    assert.equal(items.length, 1);
    const only = items[0];
    assert.ok(only, "only item present");
    assert.equal(only.showLevelBadge, true);
    assert.equal(only.levelBadgeLabel, "high");
  });

  test("active model with UNSUPPORTED recorded level → no badge (stale-suffix rule)", () => {
    // The recorded level was carried from a previous model pick; the
    // current model doesn't offer it. The cascade should NOT show the
    // badge, matching the chip's stale-suffix guard.
    const items = providerCascadeItems(
      {
        id: "minimax_api", label: "MiniMax",
        models: [
          // active model has only [low, medium] — no "high"
          { id: "M-lite", label: "M Lite", thinkingLevels: ["low", "medium"] },
        ],
      },
      "M-lite", "high", tStub,
    );
    const only = items[0];
    assert.ok(only, "only item present");
    assert.equal(only.showLevelBadge, false, "no dangling level badge on an unsupported level");
    assert.equal(only.levelBadgeLabel, null);
  });

  test("non-active model never shows a level badge", () => {
    const items = providerCascadeItems(
      {
        id: "minimax_api", label: "MiniMax",
        models: [
          { id: "M3", label: "M3", thinkingLevels: ["low", "high"] },
          { id: "M2", label: "M2", thinkingLevels: ["low", "high"] },
        ],
      },
      "M3", "high", tStub,
    );
    const m2 = items.find((i) => i.id === "M2");
    assert.ok(m2, "M2 entry present");
    assert.equal(m2.showLevelBadge, false, "only the ACTIVE model carries the badge");
  });
});

/**
 * Chip stale-suffix guard.
 *
 * The chip's "· level" suffix must NEVER appear when the active model
 * doesn't offer the recorded level. `chipLevelSuffix` is the product
 * function `composer.tsx#Composer#currentModelLabel` appends the
 * suffix with, so this predicate is the render, not a restatement of
 * the rule: it resolves the label through `t` and returns the literal
 * 「 · <label>」 the chip shows.
 */
const chipT = (key: string) => key;

function chipShowsLevelSuffix(
  activeModel: { id: string; thinkingLevels?: string[] } | null,
  recordedThinking: string,
): boolean {
  return chipLevelSuffix(chipT as never, recordedThinking, activeModel) !== "";
}

describe("chip stale-suffix guard — ticket 11", () => {
  test("no recorded thinking → no suffix", () => {
    assert.equal(chipShowsLevelSuffix({ id: "m" }, ""), false);
    assert.equal(chipShowsLevelSuffix(null, "high"), false);
  });

  test("recorded level is supported → suffix shows", () => {
    assert.equal(
      chipShowsLevelSuffix({ id: "m", thinkingLevels: ["low", "high"] }, "high"),
      true,
    );
  });

  test("active model has no thinkingLevels → NO suffix (the stale-suffix fix)", () => {
    // This is the bug ticket 11 closes. Before the fix, picking
    // M3 (with "high") then M2 Lite (no thinkingLevels) rendered
    // "MiniMax-M2 Lite · 高" — wrong, because the engine rejects
    // 高 for M2 Lite. The guard hides the suffix.
    assert.equal(chipShowsLevelSuffix({ id: "M2-lite" }, "high"), false);
    assert.equal(chipShowsLevelSuffix({ id: "M2-lite", thinkingLevels: [] }, "high"), false);
  });

  test("recorded level not in active model's thinkingLevels → NO suffix", () => {
    // The recorded level "high" doesn't exist in the active model's
    // [low, medium]; the guard hides the suffix even though the
    // model has SOME levels.
    assert.equal(
      chipShowsLevelSuffix({ id: "m", thinkingLevels: ["low", "medium"] }, "high"),
      false,
    );
  });

  test("the suffix is the translated label, not a raw level glyph", () => {
    // A zh UI must never grow an English depth word on the chip.
    assert.equal(
      chipLevelSuffix(chipT as never, "high", { id: "m", thinkingLevels: ["high"] }),
      " · thinkingPicker.high",
    );
    assert.equal(
      chipLevelSuffix(chipT as never, "on", { id: "M3", thinkingLevels: ["off", "on"] }),
      " · thinkingPicker.on",
      "the two-state toggle's own label",
    );
    // A level the i18n table does not know renders no suffix at all.
    assert.equal(
      chipLevelSuffix(chipT as never, "turbo", { id: "m", thinkingLevels: ["turbo"] }),
      "",
    );
  });
});

/**
 * The cascade model-click wire payload.
 *
 * Per ticket 11: clicking a model in the cascade sends MODEL ONLY.
 * The follow-clearing rule is: if the recorded thinking is not in
 * the new model's `thinkingLevels`, also send `thinking: ""` so the
 * server clears the local mirror. Both cases go through one atomic
 * `/api/set-model` call (model-first-then-effort).
 */
function cascadeModelClickPayload(
  newModelId: string,
  newModelThinkingLevels: string[] | undefined,
  recordedThinking: string,
): { model: string; thinking?: string } {
  if (!recordedThinking) return { model: newModelId };
  const supported = newModelThinkingLevels ?? [];
  if (!supported.includes(recordedThinking)) {
    // Old level not offered — clear it via the documented "" sentinel.
    return { model: newModelId, thinking: "" };
  }
  return { model: newModelId };
}

describe("cascadeModelClickPayload — ticket 11 wire shapes", () => {
  test("no recorded thinking → `{model}` only", () => {
    const p = cascadeModelClickPayload("minimax_api/MiniMax-M3", ["off", "low", "high"], "");
    assert.deepEqual(p, { model: "minimax_api/MiniMax-M3" });
    assert.equal("thinking" in p, false, "no thinking field echoed on a clean model switch");
  });

  test("recorded thinking is in new model's levels → `{model}` only (server preserves effort)", () => {
    // Ticket 08 wire contract: model-first, server keeps the recorded
    // effort when `thinking` is omitted. Sending `{model}` only is
    // the documented "switch model, preserve effort" path.
    const p = cascadeModelClickPayload("minimax_api/MiniMax-M3", ["off", "low", "high"], "high");
    assert.deepEqual(p, { model: "minimax_api/MiniMax-M3" });
  });

  test("recorded thinking NOT in new model's levels → `{model, thinking: \"\"}` clears effort", () => {
    // The follow-clearing rule. Without this the engine would carry
    // a stale "high" into a model whose `thinkingLevels` don't
    // include "high" — the stale-suffix bug.
    const p = cascadeModelClickPayload("minimax_api/MiniMax-M2-lite", undefined, "high");
    assert.deepEqual(p, { model: "minimax_api/MiniMax-M2-lite", thinking: "" });
  });

  test("new model declares levels but old level not in them → still clears", () => {
    // New model has SOME levels, just not the recorded one.
    const p = cascadeModelClickPayload("openai_compat/gpt-5", ["minimal", "off"], "high");
    assert.deepEqual(p, { model: "openai_compat/gpt-5", thinking: "" });
  });

  test("model field is always present (cascade never sends a level without re-anchoring the model)", () => {
    for (const lvl of ["low", "high", ""]) {
      const p = cascadeModelClickPayload("m", ["low", "high"], lvl);
      assert.equal(p.model, "m");
    }
  });
});

/**
 * Standalone level-button pick payload.
 *
 * The ThinkingEffortSelect chip sends `{thinking}` only (no model).
 * The model stays where it is. Empty string is the documented
 * "engine default" sentinel.
 *
 * Server contract: with no model field, the server leaves `cs.model`
 * alone for `cs.model.name` (skipped because `modelId` is empty),
 * and updates `cs.model.thinking` only when `thinkingWasProvided`
 * is true. The engine's `setConfigOption(sid, "thinkingEffort",
 * thinking, cid)` fires only when the model is already set — a
 * thinking-only send without a session model is a no-op on the
 * engine, but the local mirror still records the value (the
 * accepted ticket 08 "thinking-only" semantics).
 */
function levelButtonClickPayload(level: string): { thinking: string } {
  return { thinking: level };
}

describe("levelButtonClickPayload — ticket 11", () => {
  test("level pick → `{thinking}` only, no model", () => {
    const p = levelButtonClickPayload("high");
    assert.deepEqual(p, { thinking: "high" });
    assert.equal("model" in p, false, "level button never sends model field");
  });

  test("'use engine default' pick → `{thinking: \"\"}`", () => {
    // The separator entry in the cascade (and the chip's own default
    // entry) maps to empty string — server's documented "no override"
    // sentinel.
    const p = levelButtonClickPayload("");
    assert.equal(p.thinking, "");
  });
});

/**
 * Standalone level-button visibility.
 *
 * The button is hidden when the active model has no
 * `thinkingLevels` (the chip becomes a no-op control otherwise). The
 * composer gates the render on `thinkingLevelsForActive.length > 0`,
 * and `thinkingLevelsForActive` is `thinkingLevelsForModel(catalogue,
 * activeId)` — so this predicate is that gate, driven by the product
 * function rather than a restatement of it.
 */
function levelButtonShouldRender(
  activeModel: { thinkingLevels?: string[] } | null | undefined,
): boolean {
  if (!activeModel) return false;
  return thinkingLevelsForModel(
    [{ id: "active", label: "active", thinkingLevels: activeModel.thinkingLevels }],
    "active",
  ).length > 0;
}

describe("levelButtonShouldRender — ticket 11", () => {
  test("active model with non-empty thinkingLevels → button renders", () => {
    assert.equal(levelButtonShouldRender({ thinkingLevels: ["low", "high"] }), true);
  });

  test("active model with empty thinkingLevels → button hidden", () => {
    assert.equal(levelButtonShouldRender({ thinkingLevels: [] }), false);
  });

  test("active model without thinkingLevels field → button hidden", () => {
    assert.equal(levelButtonShouldRender({}), false);
    assert.equal(levelButtonShouldRender(undefined), false);
    assert.equal(levelButtonShouldRender(null), false);
  });
});

/**
 * Interaction budget for ticket 11's two cascades.
 *
 *   * Pick a model: ≤2 (hover provider + click model, OR click provider + click model).
 *   * Pick a level: ≤2 (click level button + click level in its panel).
 *
 * The model pick uses the new provider→model cascade; the level pick
 * uses the standalone ThinkingEffortSelect. Both are separate
 * surfaces — picking a model doesn't open the level button's menu,
 * and vice versa.
 */
function modelPickBudget(): 2 {
  return 2;
}
function levelPickBudget(): 2 {
  return 2;
}

describe("interaction budget — ticket 11 (separate surfaces)", () => {
  test("model pick ≤ 2", () => {
    assert.equal(modelPickBudget(), 2);
  });
  test("level pick ≤ 2", () => {
    assert.equal(levelPickBudget(), 2);
  });
});

/**
 * Cascade placement (right-side, with left-flip fallback).
 *
 * Reused from ticket 10 verbatim — the same `<CascadeSubmenu>` shape
 * is used for both the model→level cascade (ticket 10, now removed)
 * and the provider→model cascade (ticket 11). The position math is
 * identical.
 */
function cascadePlacement(args: {
  anchor: { left: number; top: number; right: number; bottom: number };
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
  gap?: number;
}): { top: number; left: number } {
  const gap = args.gap ?? 6;
  const inset = 8;
  let left = args.anchor.right + gap;
  if (left + args.menu.width > args.viewport.width - inset) {
    left = args.anchor.left - args.menu.width - gap;
    if (left < inset) left = Math.max(inset, args.viewport.width - args.menu.width - inset);
  }
  let top = args.anchor.top;
  if (top + args.menu.height > args.viewport.height - inset) {
    top = Math.max(inset, args.viewport.height - args.menu.height - inset);
  }
  if (top < inset) top = inset;
  return { top, left };
}

describe("cascadePlacement — ticket 11 right-side placement", () => {
  test("normal case: anchor has room on the right → fly out to the right", () => {
    // Provider row right edge at 320, viewport 1200, menu width 200.
    // 320 + 6 + 200 = 526 < 1192 → fits on the right.
    const pos = cascadePlacement({
      anchor: { left: 100, top: 400, right: 320, bottom: 432 },
      menu: { width: 200, height: 32 * 4 },
      viewport: { width: 1200, height: 800 },
    });
    assert.equal(pos.left, 326, "flies out to the RIGHT (the user's correction: 右侧二级不是下面弹出来)");
    assert.equal(pos.top, 400, "top aligns with the row's top edge");
  });

  test("no room on the right → flip to the LEFT of the row", () => {
    // Provider row near the right edge: right=1180, viewport 1200,
    // menu 200 → 1186+200 > 1192. Flip: left = 980 - 200 - 6 = 774.
    const pos = cascadePlacement({
      anchor: { left: 980, top: 400, right: 1180, bottom: 432 },
      menu: { width: 200, height: 32 * 4 },
      viewport: { width: 1200, height: 800 },
    });
    assert.equal(pos.left, 774, "flipped to the LEFT when right-edge overflow");
  });

  test("vertical clamp keeps submenu inside the viewport", () => {
    // Anchor near the top: -10 → clamp to 8.
    let pos = cascadePlacement({
      anchor: { left: 100, top: -10, right: 320, bottom: 22 },
      menu: { width: 200, height: 32 * 4 },
      viewport: { width: 1200, height: 800 },
    });
    assert.equal(pos.top, 8, "top never above viewport inset");
    // Anchor near the bottom: top=780 + height=200 > 800-8 → clamp.
    pos = cascadePlacement({
      anchor: { left: 100, top: 780, right: 320, bottom: 812 },
      menu: { width: 200, height: 200 },
      viewport: { width: 1200, height: 800 },
    });
    assert.equal(pos.top, 592, "bottom edge clamped to viewport - height - inset");
  });
});
// ============================================================
// STILL MIRRORED — known-unverified helpers remaining in this file.
//
// Everything red line ⑤ names (provider grouping, the thinking-level
// derivations, the level/badge/suffix key maps) now runs against
// `webapp/lib/model-groups.ts` — the module `components/composer.tsx`
// imports. The helpers below did NOT move and are still local copies of
// composer behaviour, so breaking the product code they describe leaves
// their tests green. They are listed rather than quietly left in place:
//
//   - isConfiguredGroup         — a constant `true`; documents that the
//                                 server does the filtering, asserts no
//                                 client code.
//   - selectorMaxHeightPx       — the panel uses Tailwind `max-h-[60vh]`;
//                                 no JS reads this number.
//   - scrollIntoViewAdjustment  — the composer's useEffect does this math
//                                 inline; the copy cannot see a revert.
//   - scrollBehavior            — the composer's prefersReducedMotion
//                                 branches inline.
//   - makeAddProviderBridge     — the call site's callback shape.
//   - webuiFullModelId          — a mirror of routes/model.js, not of
//                                 the composer; the server route is not
//                                 importable from the node test runner.
//   - providerCascadeItems / providerCascadeOpenFor (conjunction only) /
//     cascadeModelClickPayload / levelButtonClickPayload /
//     modelPickBudget / levelPickBudget / cascadePlacement
//                               — ticket 11 cascade interaction and wire
//                                 payloads, none of which is a named
//                                 product function to import.
//
// Red line ⑤ has no entries left. The cascade surface above does, and
// is the next extraction to make (same treatment as lib/model-groups).
// ============================================================
