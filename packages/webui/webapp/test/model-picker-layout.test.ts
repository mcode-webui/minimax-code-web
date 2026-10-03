// webapp/test/model-picker-layout.test.ts
//
// The model picker's shape, pinned against the official desktop's
// existing implementation (the two reference screenshots: provider group
// headers with model rows directly beneath them, and a settings surface
// on the right whose CONTROLS are a single-select context window, a
// default→max level list, and a thinking toggle).
//
// These are source tripwires, and that is a deliberate trade this file
// states rather than hides: `ModelSelect` lives in `components/composer.tsx`
// behind the store/api graph, which cannot enter the test process, so a
// real render is unavailable (same constraint as
// `composer-context-window.test.ts`). What IS testable as behaviour is
// already tested as behaviour elsewhere — `lib/model-groups.ts` for the
// grouping and `lib/effort-control.ts` for the adaptive level shapes, both
// driven as product functions. What is left is the WIRING, and wiring is
// exactly what a source assertion is for.
//
// Each guard names the regression it exists for:
//
//   - L1: the provider cascade is gone. A provider row that opens a
//     submenu of models is the pre-reference shape; keeping it means two
//     navigation models for one list, and the desktop has one.
//   - L2: one row per MODEL under its group header. This is the visible
//     difference from the old provider-row list: a user must be able to
//     read every model name without a second click.
//   - L3: the active model carries the ✓ on ITS row, not on a provider
//     row. With models in the list, the marker belongs on the model.
//   - L4: hover/focus still drives the settings column. Removing the
//     cascade moved this from "hover inside a submenu" to "hover the row
//     itself"; if the follow-focus wiring goes with it, the settings
//     column silently freezes on the active model.
//   - L5: no search box. The desktop has none, and a filter over a list
//     that is now one click deep instead of two deep is a second
//     navigation model for the same list.
//   - L6: exactly ONE settings surface. The old panel rendered the active
//     model's controls TWICE — once in the side column, once in a panel-
//     bottom area — which is a duplicate control set in one popup, not a
//     feature.
//   - L7: the context window is a single-select with a chevron, not a
//     wrapped radio group.
//   - L8: the effort levels render as a vertical list of pickable rows,
//     not a wrapped pill row.
//   - L9: the binary thinking form survives as a toggle. It is the same
//     adaptive rule the reference shows (`effortControlShape`), and
//     dropping it would leave a two-level model with no control at all.
//   - L10: the list container appears exactly ONCE. Rewriting the list
//     left a stale opening `<div data-testid="model-select-list">` behind,
//     so the rows rendered inside a nested second list: a balanced-JSX
//     duplicate that typechecks, keeps the whole suite green, and only
//     shows up in the DOM. A count is the only guard that sees it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(resolve(here, "../components/composer.tsx"), "utf8");

describe("L1 — the provider cascade is gone", () => {
  test("ModelSelect no longer mounts a cascade submenu", () => {
    assert.doesNotMatch(composer, /<CascadeSubmenu/);
  });

  test("the cascade component and its item type are removed, not orphaned", () => {
    // An unused 200-line fly-out is not a harmless leftover: it keeps
    // portal/positioning code that a later change will happily reuse.
    assert.doesNotMatch(composer, /const CascadeSubmenu = forwardRef/);
    assert.doesNotMatch(composer, /interface CascadeItem/);
  });

  test("the submenu-open state machine is gone", () => {
    assert.doesNotMatch(composer, /setSubmenuFor\(/);
    assert.doesNotMatch(composer, /const \[submenuFor, setSubmenuFor\]/);
  });
});

describe("L2 — the list is provider headers with model rows", () => {
  test("every model in a group renders its own row", () => {
    assert.match(composer, /group\.models\.map\(/);
  });

  test("the row testid is a model testid, not a provider one", () => {
    assert.match(composer, /model-select-model-option-/);
    assert.doesNotMatch(composer, /model-select-provider-option-/);
  });

  test("the group header survives — grouping is the reference's own shape", () => {
    assert.match(composer, /model-select-group-label-/);
  });

  test("the no-key group hint survives on the header", () => {
    // A provider without a key cannot reach its models, and the header is
    // the only place left to say so now that there is no provider row.
    assert.match(composer, /model-select-group-nokey-/);
  });
});

describe("L3 — the ✓ marks the active MODEL", () => {
  test("the model row is selected by comparing the model id, not the provider", () => {
    assert.match(composer, /selected=\{isActiveModel\}/);
  });
});

describe("L4 — the settings column still follows the focused row", () => {
  test("hovering and focusing a model row both set the focused model", () => {
    // Both, not just hover: the arrow-key engine moves focus, and a
    // column that only followed the mouse would freeze for a keyboard
    // user. The guard is on the no-key case, so the pattern tolerates it.
    assert.match(composer, /onMouseEnter=\{\(\) => \{\s*if \(!disabled\) setFocusedModelId\(/);
    assert.match(composer, /onFocus=\{\(\) => \{\s*if \(!disabled\) setFocusedModelId\(/);
  });

  test("the detail target is still focused-row-first, active-model fallback", () => {
    assert.match(composer, /detailTarget/);
  });
});

describe("L5 — no search box", () => {
  test("the search input and its empty state are gone", () => {
    assert.doesNotMatch(composer, /model-select-search/);
    assert.doesNotMatch(composer, /model-select-no-results/);
  });

  test("the query state is gone with it", () => {
    assert.doesNotMatch(composer, /const \[query, setQuery\]/);
  });
});

describe("L6 — one settings surface, not two", () => {
  test("ModelSettingsDetail mounts exactly once", () => {
    const mounts = composer.match(/<ModelSettingsDetail/g) ?? [];
    assert.equal(
      mounts.length,
      1,
      `expected one settings surface, found ${mounts.length} (a duplicate control set in one popup)`,
    );
  });

  test("the surviving mount is the side column, fed by the focused model", () => {
    assert.match(composer, /containerTestId="model-panel-detail"/);
    assert.match(composer, /target=\{detailTarget\}/);
    // The read-only badge variant left with the panel-bottom area; a
    // second, display-only rendering of the same levels would be two
    // answers to "what level is this model on".
    assert.doesNotMatch(composer, /effortControl=/);
  });
});

describe("L7 — context window is a single-select with a chevron", () => {
  test("the context control renders a select affordance", () => {
    assert.match(composer, /\$\{testIdPrefix\}-select/);
  });

  test("the chevron glyph is inside the context control", () => {
    const select = composer.match(/\$\{testIdPrefix\}-select[\s\S]{0,1200}?chevronDown/);
    assert.ok(select, "the context control must carry a chevronDown affordance");
  });

  test("the wrapped context radio group is gone", () => {
    assert.doesNotMatch(composer, /\$\{contextPrefix\}-group/);
  });

  test("the select is its own component, so its open state has a home", () => {
    // Not a style preference: hoisting that `useState` into the shared
    // detail component would make every level pick re-render it.
    assert.match(composer, /function ContextWindowSelect\(/);
  });
});

describe("L8 — effort levels are a vertical list of rows", () => {
  test("the level control renders a list container", () => {
    assert.match(composer, /\$\{detailPrefix\}-level-list/);
  });

  test("the list is a column, not a wrapped pill row", () => {
    const list = composer.match(/\$\{detailPrefix\}-level-list[\s\S]{0,200}?className="([^"]*)"/);
    assert.ok(list, "the level list must carry a className");
    assert.match(list[1]!, /flex-col/);
    assert.doesNotMatch(list[1]!, /flex-wrap/);
  });

  test("the old wrapped radiogroup is gone", () => {
    assert.doesNotMatch(composer, /\$\{detailPrefix\}-level-group/);
  });
});

describe("L9 — the binary thinking form is still a toggle", () => {
  test("the switch branch survives the layout change", () => {
    assert.match(composer, /effortShape === "switch"/);
    assert.match(composer, /\$\{detailPrefix\}-level-switch/);
  });
});

describe("L10 — the list container is not duplicated", () => {
  test("there is exactly one model-select-list element", () => {
    // A second, nested list is invisible to every other guard here: the
    // tags balance, so JSX and `tsc` are both happy, and the model rows
    // still satisfy L2/L3 because they are still in the source. Only the
    // count — or the rendered DOM — can tell.
    const containers = composer.match(/data-testid="model-select-list"/g) ?? [];
    assert.equal(
      containers.length,
      1,
      `expected one list container, found ${containers.length} (rows nested in a stale second list)`,
    );
  });

  test("the list carries the keyboard engine, and there is one of it", () => {
    // The cascade used to own the arrow keys. Moving that engine onto the
    // flat list is what kept the list keyboard-reachable, so exactly one
    // handler has to be wired to it.
    const handlers = composer.match(/onKeyDown=\{handleListKeyDown\}/g) ?? [];
    assert.equal(
      handlers.length,
      1,
      `expected one list key handler, found ${handlers.length} (the flat list is the only keyable list)`,
    );
  });
});
