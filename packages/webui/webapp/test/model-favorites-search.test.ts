// webapp/test/model-favorites-search.test.ts
//
// Roadmap module H 「模型偏好排序」+「模型搜索」, the two things the model
// selector now does that it did not do when the roadmap marked 模型搜索 ❌
// 「选择器无搜索」.
//
// The split this file keeps:
//
//   the ARITHMETIC  — `orderModelGroups`, `filterModelGroups`,
//     `fuzzyMatches`, `toggleFavoriteId` — is imported and driven, never
//     re-implemented. A test that copies the code it claims to pin cannot
//     fail when the product code breaks, and that is the mistake red line
//     ⑤ exists to prevent (`lib/model-groups.ts` carries the same note).
//
//   the WIRING      — the star's position relative to the row, the search
//     box's position relative to the list, the `f` key, the row-level
//     no-key override — is asserted against the source, because
//     `ModelSelect` lives in `components/composer.tsx` behind the
//     store/api graph and cannot enter this process. That is an explicit
//     trade this file states rather than hides, and it is the same
//     constraint `model-picker-layout.test.ts` works under.
//
// Each guard names the regression it exists for; see the section banners.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FAVORITES_SECTION_ID,
  filterModelGroups,
  fuzzyMatches,
  groupModelsByProvider,
  isBuiltinMiniMaxModel,
  orderModelGroups,
  type ModelProviderGroup,
} from "../lib/model-groups";
import {
  MODEL_FAVORITES_KEY,
  readFavoriteModels,
  toggleFavoriteId,
  writeFavoriteModels,
} from "../lib/model-favorites";

const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(resolve(here, "../components/composer.tsx"), "utf8");
const icons = readFileSync(resolve(here, "../components/icons.tsx"), "utf8");
const i18n = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");

interface Model {
  id: string;
  label: string;
  provider?: string;
}

const M3: Model = { id: "minimax_api/MiniMax-M3", label: "MiniMax-M3", provider: "minimax_api" };
const M27: Model = { id: "minimax_api/MiniMax-M2.7", label: "MiniMax-M2.7", provider: "minimax_api" };
const GLM: Model = {
  id: "zhipu-ai-coding-plan/glm-5.3",
  label: "glm-5.3",
  provider: "zhipu-ai-coding-plan",
};
const KIMI: Model = { id: "moonshot/kimi-k2", label: "kimi-k2", provider: "moonshot" };

const IDS = (groups: ReadonlyArray<ModelProviderGroup<Model>>): string[] =>
  groups.flatMap((g) => g.models.map((m) => m.id));

/**
 * Indexed read with a named assertion.
 *
 * Strict mode types `list[i]` as possibly-undefined, and a bare `!` would
 * turn a genuine shape change into a TypeError with no clue which
 * expectation broke. This names what was being looked at instead.
 */
function at<T>(list: readonly T[], index: number, what: string): T {
  const value = list[index];
  assert.ok(
    value !== undefined,
    `${what}: expected an entry at index ${index}, list has ${list.length}`,
  );
  return value;
}

// ---------------------------------------------------------------------------
// 「模型偏好排序」— which model a star is, and where the starred list leads
// ---------------------------------------------------------------------------

test("a built-in MiniMax id is identified by its provider prefix", () => {
  assert.equal(isBuiltinMiniMaxModel("minimax_api/MiniMax-M3"), true);
  assert.equal(isBuiltinMiniMaxModel("minimax_api/MiniMax-M3.1-Flash-Preview"), true);
});

test("an unreadable id is not MiniMax, because guessing is the expensive direction", () => {
  // No separator: the id names no provider.
  assert.equal(isBuiltinMiniMaxModel("glm-5.3"), false);
  // Trailing separator: the id names no model.
  assert.equal(isBuiltinMiniMaxModel("minimax_api/"), false);
  // The engine's own encoded id is not the built-in catalogue.
  assert.equal(isBuiltinMiniMaxModel("__engine/m:minimax_api:minimax_api/MiniMax-M3"), false);
  assert.equal(isBuiltinMiniMaxModel(""), false);
  assert.equal(isBuiltinMiniMaxModel(null), false);
  assert.equal(isBuiltinMiniMaxModel(undefined), false);
  assert.equal(isBuiltinMiniMaxModel("zhipu-ai-coding-plan/glm-5.3"), false);
});

test("nothing starred leaves the groups untouched, by reference", () => {
  const groups = groupModelsByProvider([M3, GLM], [], "Other", (id) => id);
  const out = orderModelGroups(groups, new Set(), "Favorites");
  // Identity, not just equality: a fresh array would re-render the whole
  // list on every open of a menu where the user has starred nothing.
  assert.equal(out, groups);
});

test("a starred model is hoisted, and appears exactly once", () => {
  const groups = groupModelsByProvider([M3, M27, GLM], [], "Other", (id) => id);
  const out = orderModelGroups(groups, new Set([GLM.id]), "Favorites");

  assert.equal(at(out, 0, "hoisted section").id, FAVORITES_SECTION_ID);
  assert.equal(at(out, 0, "hoisted section").label, "Favorites");
  assert.deepEqual(IDS(out), [GLM.id, M3.id, M27.id]);
  // The duplication assertion: a model listed in the favourites section AND
  // under its own provider is what makes "starred" mean nothing.
  const occurrences = IDS(out).filter((id) => id === GLM.id).length;
  assert.equal(occurrences, 1);
});

test("among starred models, built-in MiniMax leads and the rest sort by name", () => {
  const groups = groupModelsByProvider([KIMI, GLM, M27, M3], [], "Other", (id) => id);
  const out = orderModelGroups(
    groups,
    new Set([KIMI.id, GLM.id, M27.id, M3.id]),
    "Favorites",
  );

  // All four starred, so the favourites section holds the whole catalogue
  // and its order IS the answer: MiniMax first (M2.7 before M3 by name),
  // then the custom models alphabetically — glm-5.3, kimi-k2.
  assert.deepEqual(IDS(out), [M27.id, M3.id, GLM.id, KIMI.id]);
});

test("a provider group emptied by starring is dropped, not rendered as an empty header", () => {
  // The only two models `moonshot` has are both starred.
  const groups = groupModelsByProvider([KIMI, M3], [], "Other", (id) => id);
  const out = orderModelGroups(groups, new Set([KIMI.id]), "Favorites");
  assert.equal(out.filter((g) => g.id === "moonshot").length, 0);
  assert.deepEqual(out.map((g) => g.id), [FAVORITES_SECTION_ID, "minimax_api"]);
});

test("a starred model from a keyless provider is greyed per row, not per section", () => {
  // The favourites section spans providers, so one `auth` verdict cannot
  // describe it — and a starred model whose key is gone still 401s on pick.
  // Only the keyless model is starred, so a provider section survives and
  // can be checked for NOT carrying a per-row override.
  const groups = groupModelsByProvider([GLM, M3], [], "Other", (id) => id);
  const withAuth: Array<ModelProviderGroup<Model>> = groups.map((g) =>
    g.id === "zhipu-ai-coding-plan"
      ? { ...g, auth: { hasKey: false, type: "byok" as const } }
      : g,
  );
  const out = orderModelGroups(withAuth, new Set([GLM.id]), "Favorites");

  assert.equal(at(out, 0, "favourites section").id, FAVORITES_SECTION_ID);
  assert.equal(at(out, 0, "favourites section").disabledModelIds?.has(GLM.id), true);
  // A provider section keeps answering for all of its own rows, and does so
  // through `auth` rather than a second mechanism.
  assert.equal(at(out, 1, "the surviving provider section").id, "minimax_api");
  assert.equal(at(out, 1, "the surviving provider section").disabledModelIds, undefined);
});

test("re-ordering an already-hoisted list does not stack favourites sections", () => {
  const groups = groupModelsByProvider([M3, GLM], [], "Other", (id) => id);
  const once = orderModelGroups(groups, new Set([GLM.id]), "Favorites");
  const twice = orderModelGroups(once, new Set([GLM.id]), "Favorites");
  assert.equal(twice.filter((g) => g.id === FAVORITES_SECTION_ID).length, 1);
});

test("a starred id that is not in the catalogue is ignored, not rendered", () => {
  const groups = groupModelsByProvider([M3], [], "Other", (id) => id);
  const out = orderModelGroups(groups, new Set([M3.id, "vendor/model-that-left"]), "Favorites");
  // The vanished one leaves no empty section behind.
  assert.deepEqual(IDS(out), [M3.id]);
});

// ---------------------------------------------------------------------------
// 「模型搜索」— the box, and what counts as a match
// ---------------------------------------------------------------------------

test("a query matches by subsequence, which is what a user actually types", () => {
  // None of these is a substring of anything real. A plain `includes` would
  // report no matches for all three, which is the bug the fuzzy matcher
  // exists to fix.
  assert.equal(fuzzyMatches("minimax_api/MiniMax-M3", "mm3"), true);
  assert.equal(fuzzyMatches("zhipu-ai-coding-plan/glm-5.3", "glm53"), true);
  assert.equal(fuzzyMatches("moonshot/kimi-k2", "kk2"), true);
});

test("separators and case are not what a model is found by", () => {
  // The catalogue writes `glm-5.3`; the user writes `glm5.3` or `GLM 5.3`.
  assert.equal(fuzzyMatches("zhipu-ai-coding-plan/glm-5.3", "glm5.3"), true);
  assert.equal(fuzzyMatches("zhipu-ai-coding-plan/glm-5.3", "GLM 5.3"), true);
});

test("a one-character query means containment, exactly as it does everywhere else", () => {
  // There is no separate rule for one character, and the test says so
  // rather than pretending one exists: for a single character "in order"
  // and "anywhere" are the same predicate. A guard that looked stricter was
  // a no-op, and the test that appeared to pin it passed only because its
  // fixture contained no such character at all.
  assert.equal(fuzzyMatches("minimax_api/MiniMax-M3", "a"), true);
  assert.equal(fuzzyMatches("moonshot/kimi-k2", "a"), false);
  assert.equal(fuzzyMatches("moonshot/kimi-k2", "k"), true);
  // Case and separators are still irrelevant, so this is containment of the
  // NORMALISED string.
  assert.equal(fuzzyMatches("zhipu-ai-coding-plan/glm-5.3", "G"), true);
});

test("an empty query matches everything, and whitespace is not a query", () => {
  assert.equal(fuzzyMatches("anything", ""), true);
  assert.equal(fuzzyMatches("anything", "   "), true);
});

test("a query that cannot be satisfied matches nothing", () => {
  assert.equal(fuzzyMatches("minimax_api/MiniMax-M3", "zzz"), false);
  // Right characters, wrong order.
  assert.equal(fuzzyMatches("minimax_api/MiniMax-M3", "3mm"), false);
});

test("filtering narrows the models and keeps catalogue order", () => {
  const groups = groupModelsByProvider([M3, M27, GLM, KIMI], [], "Other", (id) => id);
  const out = filterModelGroups(groups, "minimax");
  assert.deepEqual(IDS(out), [M3.id, M27.id]);
});

test("naming a provider returns its models, not one of them", () => {
  // Getting one of a provider's twenty rows is the surprise that makes a
  // search feel broken: the user named the provider, so the provider's
  // models are the answer.
  const groups = groupModelsByProvider([M3, M27, GLM], [], "Other", (id) => id);
  const out = filterModelGroups(groups, "zhipu");
  assert.deepEqual(IDS(out), [GLM.id]);
});

test("a provider whose name appears in no model id still returns all of them", () => {
  // The fixture that makes the previous test's claim load-bearing. `GLM`'s
  // own id happens to contain "zhipu", so a filter with no provider branch
  // would still return it — and the branch would look covered while being
  // dead. This provider's models are named by neither their id nor their
  // label, so only the provider branch can find them.
  const opaqueA: Model = { id: "vendor-a/alpha", label: "alpha", provider: "moonshot" };
  const opaqueB: Model = { id: "vendor-b/beta", label: "beta", provider: "moonshot" };
  const groups = groupModelsByProvider([opaqueA, opaqueB, M3], [], "Other", (id) => id);

  const byProvider = filterModelGroups(groups, "moonshot");
  assert.deepEqual(IDS(byProvider), [opaqueA.id, opaqueB.id]);
  // And a query for one of the models still narrows to that model alone, so
  // the branch is an addition and not a replacement.
  assert.deepEqual(IDS(filterModelGroups(groups, "beta")), [opaqueB.id]);
});

test("an empty query returns the input by reference, and a miss returns nothing", () => {
  const groups = groupModelsByProvider([M3, GLM], [], "Other", (id) => id);
  assert.equal(filterModelGroups(groups, ""), groups);
  assert.equal(filterModelGroups(groups, "   "), groups);
  assert.deepEqual(filterModelGroups(groups, "nothing-matches-this"), []);
});

test("auth rides along through a filter, or a keyed provider paints as keyless", () => {
  const groups: Array<ModelProviderGroup<Model>> = [
    { id: "p", label: "Provider", models: [GLM], auth: { hasKey: false, type: "byok" } },
  ];
  const out = filterModelGroups(groups, "glm");
  assert.deepEqual(at(out, 0, "the filtered group").auth, { hasKey: false, type: "byok" });
});

test("a group with no match is dropped rather than left as an empty header", () => {
  const groups = groupModelsByProvider([M3, GLM], [], "Other", (id) => id);
  const out = filterModelGroups(groups, "kimi");
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// the store — most-recent-last, and unreadable data cannot take the menu down
// ---------------------------------------------------------------------------

test("starring appends and unstarring removes every copy", () => {
  assert.deepEqual(toggleFavoriteId([], "a"), ["a"]);
  assert.deepEqual(toggleFavoriteId(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleFavoriteId(["a", "b"], "a"), ["b"]);
  // A hand-edited store can carry a duplicate; leaving one behind would
  // render a model the user believes they removed.
  assert.deepEqual(toggleFavoriteId(["a", "a"], "a"), []);
  // A blank id is not a model.
  assert.deepEqual(toggleFavoriteId(["a"], "  "), ["a"]);
});

// jsdom-free localStorage stand-in, the same shape `open-file.test.ts`
// installs: this runner has no DOM, and the store is the only thing under
// test that needs one.
function makeLocalStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  };
}

function withWindow<T>(storage: Storage | undefined, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (storage) {
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
      writable: true,
    });
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as { window?: unknown }).window;
  }
}

test("a star survives a reload, under a versioned key", () => {
  const storage = makeLocalStorage();
  withWindow(storage, () => {
    assert.deepEqual(readFavoriteModels(), []);
    writeFavoriteModels(["minimax_api/MiniMax-M3"]);
    assert.deepEqual(readFavoriteModels(), ["minimax_api/MiniMax-M3"]);
  });
  // The key carries its version, so a stored shape that has to change can
  // move the version rather than be guessed at on read.
  assert.match(MODEL_FAVORITES_KEY, /webui:model-favorites:v\d+$/);
});

test("an unreadable or foreign store reads as no stars, not as a crash", () => {
  const storage = makeLocalStorage();
  withWindow(storage, () => {
    storage.setItem(MODEL_FAVORITES_KEY, "{not json");
    assert.deepEqual(readFavoriteModels(), []);
    storage.setItem(MODEL_FAVORITES_KEY, JSON.stringify({ nope: true }));
    assert.deepEqual(readFavoriteModels(), []);
    storage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(["a", 7, " a ", ""]));
    // Non-strings dropped, blank dropped, the duplicate collapsed.
    assert.deepEqual(readFavoriteModels(), ["a"]);
  });
});

test("no window at all (SSR) reads as no stars and writes nothing", () => {
  withWindow(undefined, () => {
    assert.deepEqual(readFavoriteModels(), []);
    // Must not throw: the picker renders on the server too.
    writeFavoriteModels(["a"]);
  });
});

// ---------------------------------------------------------------------------
// the wiring — source tripwires, for the reasons in the file header
// ---------------------------------------------------------------------------

test("W1: the star is a SIBLING of the row, so starring never picks the model", () => {
  // Nested inside the row's own button, "star it" and "pick it" would be
  // the same click, and a user saving a model for later would switch to it.
  const starIndex = composer.indexOf("model-select-star-");
  assert.ok(starIndex > 0, "the star must be rendered at all");
  const starBlock = composer.slice(starIndex - 2000, starIndex + 2000);
  assert.match(starBlock, /event\.stopPropagation\(\)/);
  assert.match(starBlock, /toggleFavorite\(model\.id\)/);
  // The star opens BEFORE the SelectRow call in the same wrapper: the row
  // button comes after it, so they cannot be nested.
  assert.ok(
    starIndex < composer.indexOf("<SelectRow", starIndex),
    "the star must precede the row button it sits beside",
  );
});

test("W2: the star is off the tab sequence and the list owns the keyboard", () => {
  // One tab stop per model: a star per row as a tab stop would make the
  // list unusable with Tab, which is why the `f` key exists instead.
  //
  // The assertion is an ADJACENCY, not a containment. A containment check
  // over the star's neighbourhood is satisfied by the comment two lines
  // above the button, which restates the same attribute — so the guard was
  // green with the attribute deleted. That is the same class of failure
  // `model-picker-layout.test.ts` records for its own guards, and the fix
  // is the same: require the literal adjacency so prose cannot answer for
  // markup.
  assert.match(
    composer,
    /tabIndex=\{-1\}\s*\n\s*data-testid=\{`model-select-star-/,
  );
  assert.match(composer, /aria-pressed=\{starred\}/);
  assert.match(composer, /event\.key === "f" \|\| event\.key === "F"/);
  assert.match(composer, /closest<HTMLElement>\("\[data-model-id\]"\)/);
  assert.match(composer, /data-model-id=\{model\.id\}/);
});

test("W3: the search box is inside the popup and above the list", () => {
  const box = composer.indexOf('data-testid="model-select-search"');
  const list = composer.indexOf('data-testid="model-select-list"');
  assert.ok(box > 0 && list > 0);
  assert.ok(box < list, "the box filters the list, so it renders above it");
});

test("W4: the list renders what filter+order produced, never the raw grouping", () => {
  // `visibleGroups` is filter(query) THEN order(stars). Rendering `grouped`
  // would leave both features wired to nothing and every assertion above
  // still green.
  assert.match(composer, /orderModelGroups\(\s*filterModelGroups\(grouped, query\)/);
  assert.match(composer, /visibleGroups\.map\(/);
  assert.doesNotMatch(composer, /\{grouped\.map\(/);
});

test("W5: a search that matches nothing says so instead of rendering a void", () => {
  assert.match(composer, /data-testid="model-select-search-empty"/);
  assert.match(composer, /visibleGroups\.length === 0/);
});

test("W6: the row's no-key verdict can be overridden per row", () => {
  // The favourites section is the one section with no single verdict.
  assert.match(composer, /group\.disabledModelIds\?\.has\(model\.id\) === true/);
});

test("W7: the query clears with the panel", () => {
  // A half-typed filter that survives a reopen reads as a broken menu.
  assert.match(composer, /if \(!next\) \{[\s\S]{0,400}setQuery\(""\)/);
});

test("W8: the star glyph exists and can render both ways", () => {
  // One path, two states: outline = not starred, filled = starred. The
  // escape hatch lives in `Icon` because STROKE_ICONS decides per NAME, and
  // a name cannot carry both renderings of itself.
  assert.match(composer, /outlined=\{!starred\}/);
  assert.match(icons, /outlined\?: boolean/);
  assert.match(icons, /const stroke = outlined \?\? STROKE_ICONS\.has\(name\)/);
});

test("W9: both dictionaries carry all five new strings", () => {
  for (const key of [
    "modelSelector.favorites",
    "modelSelector.favorite",
    "modelSelector.unfavorite",
    "modelSelector.searchPlaceholder",
    "modelSelector.searchEmpty",
  ]) {
    const occurrences = i18n.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) ?? [];
    assert.equal(occurrences.length, 2, `${key} must exist in both dictionaries`);
  }
});
