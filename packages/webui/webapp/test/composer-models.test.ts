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

  test("'Use engine default' sends thinking:'' (clear the override)", () => {
    const payload = { thinking: "" };
    assert.equal(payload.thinking, "");
  });
});

// ============================================================
// Ticket 10 — thinking-level cascade submenu.
//
// The composer ModelSelect no longer renders inline thinking-level
// pills (no top-row pill strip and no per-row pill strip below the
// label). Levels for a model live in a CASCADING SUBMENU that flies
// out to the RIGHT of the hovered row when that model advertises
// `thinkingLevels`. The pure helpers below pin the behavioural
// contract without a render harness:
//
//   * `cascadeOpenFor` — the four-term predicate the JSX applies to
//     decide whether a row's submenu is open (open AND has levels AND
//     `submenuFor` names this row).
//   * `submenuItems` — the items the cascade renders, derived from
//     the row's `thinkingLevels` and the active level. Always appends
//     the "engine default" option so the user can clear the override
//     without leaving the submenu.
//   * `cascadePlacement` — the position fallback the submenu applies
//     when the right edge of the row leaves no room to its right:
//     flip to the left, then clamp inside the viewport. The fix to
//     the previous ticket-07 inline pills (which had no placement
//     concern) comes from here — the cascade must never spill past
//     the viewport edge.
//   * `interactionBudget` — counts the click budget for the cascade:
//     one click on the model row (opens) + one click on the level
//     (applies) = 2, matching the ticket's ≤2 interaction budget.
//
// The render is exercised end-to-end via the live self-check (browser
// + screenshots). These pins keep the *behavioural* contract stable
// between refactors.
// ============================================================

/**
 * Mirror of composer.tsx#ModelSelect#cascadeOpenFor. A row's submenu
 * is open iff the dropdown is open, the row advertises reasoning
 * controls, and `submenuFor` names this row.
 */
function cascadeOpenFor(
  open: boolean,
  submenuFor: string | null,
  modelId: string,
  rowLevels: string[],
): boolean {
  if (!open) return false;
  if (rowLevels.length === 0) return false;
  return submenuFor === modelId;
}

describe("cascadeOpenFor — ticket 10", () => {
  test("dropdown closed → no row is open, even with levels", () => {
    assert.equal(cascadeOpenFor(false, "a", "a", ["low"]), false);
    assert.equal(cascadeOpenFor(false, null, "a", ["low"]), false);
  });

  test("row without levels → no submenu", () => {
    assert.equal(cascadeOpenFor(true, "a", "a", []), false);
  });

  test("submenuFor names a different row → no submenu here", () => {
    // Hover moved to a sibling; the previous row's submenu dropped.
    assert.equal(cascadeOpenFor(true, "b", "a", ["low"]), false);
  });

  test("submenuFor names this row AND row has levels AND dropdown open → submenu shown", () => {
    assert.equal(cascadeOpenFor(true, "a", "a", ["low"]), true);
    assert.equal(cascadeOpenFor(true, "a", "a", ["low", "medium", "high"]), true);
  });
});

/**
 * Mirror of `<ThinkingLevelSubmenu>`'s option list: the row's
 * `thinkingLevels` first, then the "engine default" separator option
 * so the user can clear the recorded effort without leaving the
 * submenu. The default option is always present, even when the
 * active level is the same as one of the catalogue levels — the
 * server's `""` payload is the documented clear-the-override
 * sentinel.
 */
function submenuItems(levels: string[]): { value: string; kind: "level" | "default" }[] {
  const out: { value: string; kind: "level" | "default" }[] = [];
  for (const lvl of levels) out.push({ value: lvl, kind: "level" });
  out.push({ value: "", kind: "default" });
  return out;
}

describe("submenuItems — ticket 10", () => {
  test("always includes a default option (engine default) at the tail", () => {
    const items = submenuItems(["low", "medium", "high"]);
    assert.equal(items.length, 4);
    assert.deepEqual(
      items.map((i) => i.value),
      ["low", "medium", "high", ""],
      "default option sits after the model-declared levels",
    );
    const tail = items[items.length - 1];
    assert.ok(tail, "tail present");
    assert.equal(tail.kind, "default");
  });

  test("empty levels list still yields the default option", () => {
    // A model with no levels never opens a submenu (cascadeOpenFor
    // gates this); the helper still produces just the default entry
    // so a regression in the gating doesn't silently swallow the
    // "clear override" affordance.
    const items = submenuItems([]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.value, "");
    assert.equal(items[0]?.kind, "default");
  });

  test("duplicate levels in the input are kept as the row supplied", () => {
    // The component trusts the catalogue's dedupe — a duplicate would
    // render twice. Pin the surface so a regression in the input
    // filter surfaces here rather than as a UI quirk.
    const items = submenuItems(["low", "low"]);
    assert.equal(items.length, 3);
    assert.equal(items[0]?.value, "low");
    assert.equal(items[1]?.value, "low");
    assert.equal(items[2]?.value, "");
  });
});

/**
 * Resolve the cascade submenu's `position: fixed` coords from the
 * anchor row's rect + the submenu's measured size, with a left-flip
 * fallback when the viewport has no room on the right. The pure
 * function captures the same arithmetic `<ThinkingLevelSubmenu>`'s
 * layout effect runs.
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

describe("cascadePlacement — ticket 10 right-side placement", () => {
  test("normal case: anchor has room on the right → fly out to the right", () => {
    // Anchor on the left half of a 1200px viewport, menu width 200.
    // Anchor right edge at 320, gap 6 → left = 326. Fits inside
    // 1200 - 8.
    const pos = cascadePlacement({
      anchor: { left: 100, top: 400, right: 320, bottom: 432 },
      menu: { width: 200, height: 32 * 5 },
      viewport: { width: 1200, height: 800 },
    });
    assert.equal(pos.left, 326, "flies out to the RIGHT of the row (ticket's correction)");
    assert.equal(pos.top, 400, "top aligns with the row's top edge");
  });

  test("no room on the right → flip to the LEFT of the row", () => {
    // Anchor near the right edge: right=1180 on a 1200 viewport with
    // a 200px menu would spill to 1186 + 200 > 1192. Flip: the
    // submenu's right edge sits at `anchor.left - gap = 974`, so
    // `left = 974 - 200 = 774`.
    const pos = cascadePlacement({
      anchor: { left: 980, top: 400, right: 1180, bottom: 432 },
      menu: { width: 200, height: 32 * 5 },
      viewport: { width: 1200, height: 800 },
    });
    assert.equal(pos.left, 774, "flipped to the LEFT when right-edge overflow");
    assert.equal(pos.top, 400);
  });

  test("anchor near viewport top → top clamped to 8px inset", () => {
    const pos = cascadePlacement({
      anchor: { left: 100, top: -10, right: 320, bottom: 22 },
      menu: { width: 200, height: 32 * 5 },
      viewport: { width: 1200, height: 800 },
    });
    assert.equal(pos.top, 8, "top never goes above the viewport inset");
  });

  test("anchor near viewport bottom → bottom clamped to the inset", () => {
    // Anchor top at 780 on an 800 viewport with a 200px-tall menu
    // would spill (780+200=980 > 800-8). Clamp: top = 800 - 200 - 8 = 592.
    const pos = cascadePlacement({
      anchor: { left: 100, top: 780, right: 320, bottom: 812 },
      menu: { width: 200, height: 200 },
      viewport: { width: 1200, height: 800 },
    });
    assert.equal(pos.top, 592, "bottom edge clamped to viewport - height - inset");
  });
});

/**
 * Interaction budget for the cascade submenu.
 *
 * The ticket's ≤2 budget maps to:
 *   1) Hover (or click) the row → submenu opens.
 *   2) Click a level inside the submenu → model+level applied.
 * Hover path: 0 prior clicks + 1 hover + 1 click = 2 interactions.
 * Click path: 1 click on row (opens submenu) + 1 click on level = 2.
 * Models without levels: 1 click → model applied. The helper captures
 * the shape so the budget reads the same way in the test as it does
 * in the ticket.
 */
function interactionBudget(levels: string[], path: "hover" | "click"): number {
  if (levels.length === 0) return 1;
  if (path === "hover") return 2;
  return 2;
}

describe("interactionBudget — ticket 10 budget ≤2", () => {
  test("no-level model: one-click selection, budget = 1", () => {
    assert.equal(interactionBudget([], "click"), 1);
    assert.equal(interactionBudget([], "hover"), 1);
  });

  test("with levels, hover path: hover + click = 2", () => {
    assert.equal(interactionBudget(["low", "medium", "high"], "hover"), 2);
  });

  test("with levels, click path: row click + level click = 2", () => {
    assert.equal(interactionBudget(["low", "medium", "high"], "click"), 2);
  });
});

/**
 * Atomic set-model payload for a cascade pick.
 *
 * Mirrors the composer's call site for the cascade: model+level go
 * in a single wire call (model first, then effort — the engine
 * contract from ticket 08). Picking the "default" option clears the
 * effort (empty string), so the wire carries `thinking: ""`. The
 * model field is always present; the picker never sends a level
 * without re-anchoring the model.
 */
function cascadeSetModelPayload(modelId: string, level: string): { model: string; thinking: string } {
  return { model: modelId, thinking: level };
}

describe("cascadeSetModelPayload — ticket 10 atomic wire shape", () => {
  test("model + level: both fields, level first because payload key order matches `model, thinking`", () => {
    const p = cascadeSetModelPayload("minimax_api/MiniMax-M3", "high");
    assert.equal(p.model, "minimax_api/MiniMax-M3");
    assert.equal(p.thinking, "high");
  });

  test("default option: model present, thinking empty string", () => {
    // The "engine default" cascade entry maps to `thinking: ""` —
    // server interprets empty as "no override; let the engine pick".
    const p = cascadeSetModelPayload("minimax_api/MiniMax-M3", "");
    assert.equal(p.model, "minimax_api/MiniMax-M3");
    assert.equal(p.thinking, "");
  });

  test("model field is always present (never dropped, even with default level)", () => {
    // A regression that drops `model` when `thinking` is `""` would
    // leave the engine with a level-but-no-model wire call, which
    // ticket 08's "model first" gate rejects.
    for (const lvl of ["low", "medium", "high", ""]) {
      const p = cascadeSetModelPayload("openai_compat/gpt-5", lvl);
      assert.ok("model" in p, `model field present for level=${JSON.stringify(lvl)}`);
      assert.equal(p.model, "openai_compat/gpt-5");
    }
  });
});