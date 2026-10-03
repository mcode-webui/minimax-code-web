// webapp/test/model-search.test.ts
//
// Unit tests for the model selector's search filter — roadmap module H
// (模型与用量), feature point 「模型搜索」, which the 2026-09-30 备注
// marked ❌ 「选择器无搜索」.
//
// What is pinned, and the defect each guard exists for:
//
//   - The filter is the load-bearing logic. Everything else about the
//     search box (focus-on-open, Esc, clear button) is interaction the
//     SSR-only harness cannot drive, so the ARITHMETIC has to be pinned
//     here or a search that returns the wrong rows ships with a green
//     gate. The functions under test are the PRODUCT functions, imported
//     from `webapp/lib/model-groups.ts` — the same module
//     `components/composer.tsx` imports. This file deliberately contains
//     no copy of the matching loop; the repo has already shipped one
//     regression through a mirrored test (see the header of
//     `composer-models.test.ts` for that incident) and the mirror is
//     gone for good.
//   - G1 identity: an empty query returns the SAME array reference. Not
//     an optimisation detail — a new array on every keystroke-free
//     render would re-render the whole provider list for nothing, and
//     the reference equality is what lets the caller skip the work.
//   - G2 case: matching is case-insensitive. A user typing "GLM" must
//     find "glm-4-plus"; a case-sensitive filter reports "no models"
//     while the list plainly contains what was typed.
//   - G3 provider match keeps the whole group. Typing a provider name
//     and seeing ONE of its twenty models is the surprise this guard
//     exists for: the user named the provider, so the provider's models
//     are the answer. Matching the raw provider id as well as the
//     display label keeps the power-user path working too (the row is
//     rendered from `label`, but `openai_compat` is what the catalogue
//     calls it).
//   - G4 zero-match groups are dropped, not rendered empty. An empty
//     provider header is a dead end in the list.
//   - G5 order is preserved. The catalogue order is meaningful (it is
//     the engine's own ordering); a filter that re-sorts it would
//     silently reshuffle the list the user is reading.
//   - G6 the `__other` bucket stays searchable. A model whose provider
//     prefix did not coerce lands there; filtering it out would make
//     that model unreachable from the selector entirely.
//   - G7 no input mutation. `groups` is a prop the caller still holds;
//     the filter derives new groups rather than filtering in place.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  OTHER_PROVIDER_ID,
  filterModelGroups,
  type ModelProviderGroup,
  type SelectableModel,
} from "../lib/model-groups";

interface TestModel extends SelectableModel {
  id: string;
  label: string;
}

/** Three providers, so group order and group dropping are both observable. */
const GROUPS: Array<ModelProviderGroup<TestModel>> = [
  {
    id: "minimax_api",
    label: "MiniMax",
    models: [
      { id: "minimax_api/M3", label: "MiniMax M3" },
      { id: "minimax_api/M2.1", label: "MiniMax M2.1" },
    ],
  },
  {
    id: "openai_compat",
    label: "OpenAI",
    models: [
      { id: "openai_compat/glm-4-plus", label: "GLM-4 Plus" },
      { id: "openai_compat/gpt-4o", label: "GPT-4o" },
    ],
  },
  {
    id: OTHER_PROVIDER_ID,
    label: "Other",
    models: [{ id: "engine-encoded/9", label: "Engine Encoded" }],
  },
];

/** Flatten a filtered result to `providerId/modelId` pairs, the shape the
 *  list renders, so an assertion reads like what the user sees. */
const rendered = (groups: Array<ModelProviderGroup<TestModel>>): string[] =>
  groups.flatMap((g) => g.models.map((m) => `${g.id}/${m.id}`));

describe("filterModelGroups — empty query", () => {
  // G1
  test("returns the same array reference for an empty query", () => {
    assert.equal(filterModelGroups(GROUPS, ""), GROUPS);
  });

  test("treats a whitespace-only query as empty", () => {
    assert.equal(filterModelGroups(GROUPS, "   "), GROUPS);
  });

  test("trims a padded query rather than matching the padding", () => {
    // " glm " must behave exactly like "glm" — a user pastes with a
    // trailing space and still gets results.
    const filtered = filterModelGroups(GROUPS, "  glm  ");
    assert.deepEqual(rendered(filtered), ["openai_compat/openai_compat/glm-4-plus"]);
  });
});

describe("filterModelGroups — model matching", () => {
  // G2
  test("matches a model label case-insensitively", () => {
    const filtered = filterModelGroups(GROUPS, "GLM");
    assert.deepEqual(rendered(filtered), ["openai_compat/openai_compat/glm-4-plus"]);
  });

  test("matches a lowercase query against a mixed-case label", () => {
    const filtered = filterModelGroups(GROUPS, "m2.1");
    assert.deepEqual(rendered(filtered), ["minimax_api/minimax_api/M2.1"]);
  });

  // G3 (model-id half)
  test("matches the model id when the label does not contain the query", () => {
    // "Engine Encoded" does not contain "9"; its id does. A user who
    // copied an id off a log should still find the model.
    const filtered = filterModelGroups(GROUPS, "engine-encoded");
    assert.deepEqual(rendered(filtered), [`${OTHER_PROVIDER_ID}/engine-encoded/9`]);
  });

  // G4
  test("drops a provider group with no matching model", () => {
    const filtered = filterModelGroups(GROUPS, "gpt");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.id, "openai_compat");
  });

  // G5
  test("keeps catalogue order inside a group", () => {
    // A bare "o" matches several rows; the engine's own ordering has to
    // survive the filter.
    const filtered = filterModelGroups(GROUPS, "m");
    assert.deepEqual(rendered(filtered), [
      "minimax_api/minimax_api/M3",
      "minimax_api/minimax_api/M2.1",
      "openai_compat/openai_compat/glm-4-plus",
      "openai_compat/openai_compat/gpt-4o",
    ]);
  });

  // G5 (group order half)
  test("keeps provider group order", () => {
    // "_" is in every provider id (`minimax_api`, `openai_compat`,
    // `__other`), so all three groups survive as whole groups; their
    // order has to be the catalogue's, not the filter's.
    const filtered = filterModelGroups(GROUPS, "_");
    assert.deepEqual(
      filtered.map((g) => g.id),
      ["minimax_api", "openai_compat", OTHER_PROVIDER_ID],
    );
  });

  // G6
  test("reaches a model in the provider-less bucket", () => {
    const filtered = filterModelGroups(GROUPS, "encoded");
    assert.deepEqual(rendered(filtered), [`${OTHER_PROVIDER_ID}/engine-encoded/9`]);
  });
});

describe("filterModelGroups — provider matching", () => {
  // G3 (provider half)
  test("keeps every model of a provider whose display label matches", () => {
    // Typing "openai" names the provider, so the answer is all of its
    // models — not the one whose label happens to contain the string.
    const filtered = filterModelGroups(GROUPS, "openai");
    assert.deepEqual(rendered(filtered), [
      "openai_compat/openai_compat/glm-4-plus",
      "openai_compat/openai_compat/gpt-4o",
    ]);
  });

  test("matches the raw provider id as well as the display label", () => {
    // "MiniMax" is the label; the catalogue id is "minimax_api". A
    // power user pastes either.
    const filtered = filterModelGroups(GROUPS, "minimax_api");
    assert.deepEqual(rendered(filtered), [
      "minimax_api/minimax_api/M3",
      "minimax_api/minimax_api/M2.1",
    ]);
  });

  test("carries the group's auth view through the filter", () => {
    // The list greys a no-key provider from `auth`. A filter that
    // rebuilt the group object without it would render a keyed provider
    // as if it had no key — the user would click a row that cannot work.
    const keyed: Array<ModelProviderGroup<TestModel>> = [
      {
        id: "openai_compat",
        label: "OpenAI",
        auth: { hasKey: false, type: "byok" },
        models: [{ id: "openai_compat/gpt-4o", label: "GPT-4o" }],
      },
    ];
    const filtered = filterModelGroups(keyed, "gpt");
    assert.deepEqual(filtered[0]?.auth, { hasKey: false, type: "byok" });
  });
});

describe("filterModelGroups — no match", () => {
  test("returns an empty list when nothing matches", () => {
    // The caller renders its own empty state; what the filter owes is an
    // empty array, not a fallback to the unfiltered list (which would
    // look like the search did nothing at all).
    assert.deepEqual(filterModelGroups(GROUPS, "no-such-model"), []);
  });

  // G7
  test("does not mutate the input groups", () => {
    const before = rendered(GROUPS);
    filterModelGroups(GROUPS, "gpt");
    assert.deepEqual(rendered(GROUPS), before);
    assert.equal(GROUPS.length, 3);
  });

  test("derives new group objects rather than editing the originals", () => {
    const filtered = filterModelGroups(GROUPS, "gpt");
    // New group AND new models array — the caller's `groups` must come
    // back untouched...
    assert.notEqual(filtered[0], GROUPS[1]);
    assert.notEqual(filtered[0]?.models, GROUPS[1]?.models);
    // ...while the model records themselves are shared, not cloned. The
    // list reads per-model fields (modalities, thinkingLevels,
    // contextWindowOptions) off these, so a clone would have to carry
    // every one of them or the rows would render empty.
    assert.equal(filtered[0]?.models[0], GROUPS[1]?.models[1]);
  });
});

/**
 * The wiring tripwires.
 *
 * `filterModelGroups` is a pure function in its own module, so every
 * assertion above can pass while nothing in the picker calls it — a
 * complete search that is not connected to the UI. This repository has
 * already shipped that shape once (an export-alias reference bug that
 * passed its own unit tests), so the call site is pinned here rather than
 * left to the live probe alone.
 *
 * These read composer.tsx as SOURCE. That is a deliberate trade: the
 * component's store/api graph cannot enter this test process, so a real
 * render of `ModelSelect` is not available, and the alternative is
 * asserting nothing about the wiring. The filtering ARITHMETIC above is
 * still driven through the product function — only the wiring is
 * textual.
 */
const here = dirname(fileURLToPath(import.meta.url));
const composerSource = readFileSync(resolve(here, "../components/composer.tsx"), "utf8");
const i18nSource = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");

describe("the model selector is actually wired to the filter", () => {
  // W1
  test("composer imports filterModelGroups from the product module", () => {
    assert.match(
      composerSource,
      /import\s*\{[^}]*\bfilterModelGroups\b[^}]*\}\s*from\s*"@\/lib\/model-groups"/s,
    );
  });

  // W2
  test("the rendered provider list maps the filtered groups, not the raw ones", () => {
    // The failure this pins: `{grouped.map(...)}` left in place renders
    // every provider while the search box quietly filters nothing. The
    // list must be driven by `visibleGroups`.
    assert.match(composerSource, /visibleGroups\.map\(/);
    assert.doesNotMatch(composerSource, /\{\s*grouped\.map\(/);
  });

  // W3
  test("the cascade reads the filtered groups too", () => {
    // A provider row that advertises one match and then flies out a
    // submenu of all twenty is the same defect one level down: the row
    // and the submenu would disagree about what the query selected.
    assert.match(composerSource, /visibleGroups\.find\(\(g\) => g\.id === providerId\)/);
  });

  // W4
  test("the search input is rendered with its testid and is bound to the query", () => {
    assert.match(composerSource, /data-testid="model-select-search"/);
    assert.match(composerSource, /value=\{query\}/);
    assert.match(composerSource, /onChange=\{\(event\) => setQuery\(event\.target\.value\)\}/);
  });

  // W5
  test("the zero-match state is rendered when the query matches nothing", () => {
    assert.match(
      composerSource,
      /query\s*&&\s*visibleGroups\.length === 0/,
    );
  });

  // W6
  test("the query is cleared on close and on a session switch", () => {
    // A filter that outlives the panel hides rows on the next open with
    // nothing on screen to explain them, and a half-typed query following
    // the user into another session's list is the same bug one scope up.
    const sessionReset = composerSource.match(
      /useEffect\(\(\) => \{[\s\S]{0,300}?setQuery\(""\);[\s\S]{0,80}?\}, \[sessionKey\]\);/,
    );
    assert.ok(sessionReset, "session switch must reset the query");
    const openChange = composerSource.match(
      /onOpenChange=\{\(next\) => \{[\s\S]{0,400}?setQuery\(""\);[\s\S]{0,200}?\}\}/,
    );
    assert.ok(openChange, "closing the panel must reset the query");
  });
});

describe("the search strings exist in both languages", () => {
  // W7 — `MessageKey` is `keyof typeof en` and `zh` is
  // `Record<MessageKey, string>`, so a missing zh key is a TYPE error
  // rather than a runtime `undefined`. This pins the other direction:
  // that the three keys are actually there, so a typo'd key surfaces as
  // a failed assertion instead of a blank placeholder at runtime.
  const keys = [
    "modelSelector.searchPlaceholder",
    "modelSelector.searchClear",
    "modelSelector.searchNoResults",
  ];
  for (const key of keys) {
    test(`${key} is declared twice — once per dictionary`, () => {
      const occurrences = i18nSource.split(`"${key}"`).length - 1;
      assert.equal(occurrences, 2, `${key} must appear in the en and zh tables`);
    });
  }
});
