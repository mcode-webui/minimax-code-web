// webapp/test/model-picker-layout.test.ts
//
// The model picker is a CASCADE, pinned against the official desktop's
// existing implementation (the two reference screenshots: hover a model
// and a settings surface flies out one tier deeper than that row —
// 展示右侧一 — with the context window's sizes listed in it).
//
// 展示右侧二 is not a second floating tier. Reading it that way put a
// panel back on top of the model list it was describing; the caption
// says the sizes are shown to the right of the row, which an in-place
// list inside the fly-out already does. An earlier version of this file
// pinned the OPPOSITE shape — a permanent two-column panel with the
// settings rendered in a fixed right column. Both readings were
// misreadings of the reference, in opposite directions. These guards
// exist to keep the fly-out from being flattened or deepened again.
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
//   - C1: no permanent settings column. The reference reserves no width
//     for settings; a fixed right column is the flattened shape, and it
//     is what put a second model's controls on screen next to a row the
//     user could have simply picked.
//   - C2: hover (and keyboard focus) on a model row opens its fly-out, and
//     the close grace belongs to the row that OWNS one. Hover-driven is the
//     whole interaction — a fly-out that only answered clicks would need a
//     click before anything appeared. The grace exists to bridge the gap
//     between a row and its fly-out; a row with nothing to configure is not
//     crossing that gap, it is leaving the surface behind, and a grace it
//     cancels but never re-arms strands the previous fly-out open.
//   - C3: the first tier is anchored to the row that owns it. A fly-out
//     without an anchor is a panel in a corner.
//   - C4: the context window is in place inside the fly-out, not behind a
//     third tier. It was 展示右侧二 taken one step too literally: a third
//     floating panel is what landed on top of the model list.
//   - C5: both tiers share ONE positioning engine. Two copies of the
//     flip/clamp math is how two tiers of one cascade end up disagreeing
//     about which way to open.
//   - C6: a model with nothing to configure gets no fly-out, and its
//     click completes the selection — the reference's 「没有二次菜单的，
//     则直接点击后就完成」. Gating on settings is what makes that
//     distinction possible at all.
//   - C7: the context list is the completing control. Clicking a size
//     closes the picker; a thinking toggle does not. That asymmetry IS
//     the reference's 「点击二级菜单后才是整个选择逻辑完成」, and
//     flattening it back to "picks never close" is the easy regression.
//   - C8: the list container appears exactly ONCE. Rewriting the list left
//     a stale opening `<div data-testid="model-select-list">` behind, so
//     the rows rendered inside a nested second list: a balanced-JSX
//     duplicate that typechecks, keeps the whole suite green, and only
//     shows up in the DOM. A count is the only guard that sees it.
//   - C9: the model list is still provider headers with model rows
//     directly beneath them. Grouping is the reference's own shape.
//   - C10: no search box. The desktop has none, and a filter is a second
//     navigation model for the same list.
//   - C11: the cascade is keyboard-reachable — focus opens the fly-out
//     (not just hover), and Escape backs out one tier before the whole
//     dropdown closes.
//   - C12: picking a model does not retract its own fly-out. It is the
//     step that makes the fly-out live instead of a preview, so clearing
//     it on the model change would close the surface between the pick and
//     the second-tier pick that completes the selection.
//   - C13: the thinking switch is the app's own `webui-toggle-switch`.
//     The reference draws it blue when on, and a pill assembled from
//     border/background tokens can only ever reach the greys in the
//     palette — which read as "off" at a glance.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(resolve(here, "../components/composer.tsx"), "utf8");

/** The model row's own event handlers, sliced out of the JSX so a
 *  guard can assert on one row's wiring without matching the whole
 *  3000-line file (and without its indentation deciding the regex). */
const rowHandlers = composer.match(
  /onMouseEnter=\{\(\) => \{[\s\S]*?onBlur=\{scheduleFlyoutClose\}\n\s+onClick=\{\(\) => \{[\s\S]*?\n\s+\}\}/,
);

/** One handler body, sliced out of the row's JSX by its own opening tag. */
const handlerBody = (prop: "onMouseEnter" | "onMouseLeave" | "onFocus" | "onClick"): string => {
  assert.ok(rowHandlers, "the model row's handlers must exist");
  const found = rowHandlers[0]!.match(
    new RegExp(`${prop}=\\{\\(\\) => \\{([\\s\\S]*?)\\n\\s+\\}\\}`),
  );
  assert.ok(found, `the model row's ${prop} must exist`);
  return found[1]!;
};

/** The invariant every row entry path owes: a row with nothing to configure
 *  must return BEFORE it can claim the fly-out as its own, and before it can
 *  cancel a close grace it will never re-arm. Asserting only that the calls
 *  APPEAR is what let this defect through — `cancelFlyoutClose()` sat at the
 *  top of `onMouseEnter`, unguarded, while the `setFlyoutFor` beneath it was
 *  gated. Sliding onto a model with no controls then fired the previous
 *  row's `onMouseLeave` (arming the close), cancelled that timer, and had
 *  nothing to re-arm, so the previous model's panel stayed exactly where it
 *  was for as long as the cursor rested there — and indefinitely if no other
 *  row was entered.
 *
 *  The guard's spelling varies (`if (!hasSettings) return;` versus
 *  `if (disabled || !hasSettings) return;`), so this reads the statement
 *  BETWEEN the gate and the calls rather than one literal. A handler with no
 *  cancel is exempt on that count: a path that never touches the timer cannot
 *  pin anything. */
const assertGraceBelongsToTheOwningRow = (handler: string, label: string) => {
  const gateAt = handler.indexOf("!hasSettings");
  assert.notEqual(gateAt, -1, `${label} must gate on hasSettings`);
  const cancelAt = handler.indexOf("cancelFlyoutClose()");
  if (cancelAt !== -1) {
    assert.ok(
      handler.slice(gateAt, cancelAt).includes("return"),
      `${label}: the hasSettings gate must RETURN before cancelFlyoutClose(). A row ` +
        `with no fly-out of its own cancels the previous model's close and never ` +
        `re-arms it, leaving that fly-out pinned open until some other row is entered.`,
    );
  }
  const claimAt = handler.indexOf("setFlyoutFor(model.id)");
  if (claimAt !== -1) {
    assert.ok(
      handler.slice(gateAt, claimAt).includes("return"),
      `${label}: the hasSettings gate must RETURN before setFlyoutFor(model.id), or a ` +
        `model with nothing to configure claims the fly-out it has no controls to fill.`,
    );
  }
};

describe("C1 — the settings surface is a fly-out, not a column", () => {
  test("the permanent right column is gone", () => {
    assert.doesNotMatch(composer, /model-select-panel-detail-column/);
  });

  test("the panel no longer reserves width for a second column", () => {
    // The two-column flex wrapper is what made the flat shape read as the
    // reference. With one child it is dead styling that still suggests a
    // layout the component no longer has.
    assert.doesNotMatch(composer, /flex items-stretch/);
  });
  test("settings mount once, inside the fly-out", () => {
    const mounts = composer.match(/<ModelSettingsDetail/g) ?? [];
    assert.equal(
      mounts.length,
      1,
      `expected one settings surface, found ${mounts.length} (a duplicate control set in one popup)`,
    );
    // And it is wrapped by the fly-out rather than sitting in the panel.
    assert.match(composer, /<SettingsFlyout[\s\S]{0,700}?<ModelSettingsDetail/);
  });
});

describe("C2 — a model row's hover opens its fly-out", () => {
  test("hovering a row sets the fly-out's owner", () => {
    // The claim is unconditional in the handler; what makes it safe is the
    // early return ahead of it, which the next two tests pin separately.
    assert.match(handlerBody("onMouseEnter"), /setFlyoutFor\(model\.id\)/);
  });

  test("keyboard focus opens it too, not just the mouse", () => {
    // The arrow-key engine moves focus, so a fly-out that only answered
    // hover would leave a keyboard user unable to configure anything.
    assert.match(handlerBody("onFocus"), /setFlyoutFor\(model\.id\)/);
  });

  test("leaving the row starts the close grace, and entering cancels it", () => {
    // The cursor has to cross the gap between a row and its fly-out
    // without the surface vanishing in the gap.
    assert.ok(rowHandlers);
    assert.match(rowHandlers[0]!, /onMouseLeave=\{\(\) => \{[\s\S]*?scheduleFlyoutClose\(\)/);
    assert.match(rowHandlers[0]!, /cancelFlyoutClose\(\)/);
    assert.match(rowHandlers[0]!, /onBlur=\{scheduleFlyoutClose\}/);
  });

  test("hovering a row with no settings does not hold the previous fly-out", () => {
    assertGraceBelongsToTheOwningRow(handlerBody("onMouseEnter"), "onMouseEnter");
  });

  test("the same holds for keyboard focus, or tabbing pins it just the same", () => {
    // `onBlur` on the owning row arms the close, so the focus path carries
    // the identical trap: a bare `cancelFlyoutClose()` there strands the
    // fly-out for a keyboard user exactly as the mouse did.
    assertGraceBelongsToTheOwningRow(handlerBody("onFocus"), "onFocus");
  });

  test("focus entering the fly-out cancels the grace too, not just the mouse", () => {
    // The owning row's `onBlur` starts the close grace, so a fly-out that
    // only answers the mouse retracts 120ms after a keyboard user tabs
    // into it — reachable by pointer, unreachable by keyboard, with
    // nothing in the code to say so.
    const shell = composer.match(/function SettingsFlyout\([\s\S]*?\n}\n/);
    assert.ok(shell, "SettingsFlyout must exist");
    assert.match(shell[0]!, /onFocus=\{onFocusEnter\}/);
    // And the one fly-out wires it to the grace's cancel.
    const cancels = composer.match(/onFocusEnter=\{cancel\w+\}/g) ?? [];
    assert.equal(
      cancels.length,
      1,
      `expected the fly-out to cancel the grace on focus entry, found ${cancels.length}`,
    );
  });
});

describe("C3/C4 — one fly-out, anchored to the row that owns it", () => {
  test("the first tier is anchored to the row that owns it", () => {
    assert.match(composer, /anchorRef=\{flyoutAnchor\}/);
    assert.match(
      composer,
      /flyoutAnchorsRef\.current\.set\(model\.id, node\)/,
      "each row registers its own node as an anchor",
    );
  });

  test("the anchor is a map, not a ref read during render", () => {
    // A ref is assigned during commit, AFTER the render that reads it, and
    // assigning one triggers no re-render. Gating the fly-out on
    // `anchorRef.current` therefore read null on the first hover and the
    // surface never appeared at all — a wired-up cascade that renders
    // nothing. The map is written on every commit, so the node is always
    // there by the time a row can be hovered.
    assert.doesNotMatch(
      composer,
      /\{detailTarget && flyoutAnchor\.current \?/,
      "the fly-out must not be gated on a ref read during render",
    );
    assert.match(
      composer,
      /const flyoutAnchorsRef = useRef\(new Map<string, HTMLDivElement>\(\)\)/,
      "anchors are registered in a map, not through a single current-anchor ref",
    );
  });

  test("the context window is in place, not a third tier", () => {
    // Every step of the third tier was one affordance too many: the
    // fly-out already says which model it describes, so a row restating
    // the current value, a chevron over it, and then a separate panel
    // carrying the same values were three ways to answer one question —
    // and the third of them was a floating panel landing back over the
    // model list it was describing.
    const selectBody = composer.match(
      /function ContextWindowSelect\([\s\S]*?\n}\n/,
    );
    assert.ok(selectBody, "ContextWindowSelect must exist");
    assert.doesNotMatch(
      selectBody[0]!,
      /SettingsFlyout/,
      "the options must not open a fly-out of their own",
    );
    assert.doesNotMatch(
      selectBody[0]!,
      /-select-trigger/,
      "there is no collapsed row left to click open",
    );
  });

  test("the options need no click to appear", () => {
    // The reference shows the sizes as soon as the fly-out does. A
    // disclosure row on top of an already-short list only added a
    // second interaction between arriving and choosing.
    const selectBody = composer.match(
      /function ContextWindowSelect\([\s\S]*?\n}\n/,
    );
    assert.ok(selectBody, "ContextWindowSelect must exist");
    assert.doesNotMatch(
      selectBody[0]!,
      /useState/,
      "there is no local open state left to own",
    );
  });

  test("the in-place list keeps the listbox semantics it always had", () => {
    const selectBody = composer.match(
      /function ContextWindowSelect\([\s\S]*?\n}\n/,
    );
    assert.ok(selectBody);
    // The cascade got shallower; the contract a screen reader is told
    // about did not change.
    assert.match(selectBody[0]!, /role="listbox"/);
    assert.match(selectBody[0]!, /role="option"/);
    assert.match(selectBody[0]!, /aria-selected=\{active\}/);
  });
});

describe("C13 — the thinking switch is the app's own toggle", () => {
  test("the switch uses the shared webui-toggle-switch class", () => {
    // The reference draws this switch BLUE when on. A hand-rolled pill
    // built from border/background tokens can only reach the greys in the
    // palette, which is exactly how it read as "off" at a glance. The
    // shared class is also what the settings modal renders, so the two
    // switches in the product cannot drift apart.
    assert.match(
      composer,
      /className=\{`webui-toggle-switch\$\{effortCurrent === "on" \? " is-checked" : ""\}`\}/,
    );
    assert.doesNotMatch(
      composer,
      /border-border_heavy bg-bg_interaction_tertiary_hover/,
      "the hand-rolled grey pill is gone",
    );
  });

  test("the switch keeps its role and testid", () => {
    assert.match(composer, /role="switch"/);
    assert.match(composer, /\$\{detailPrefix\}-level-switch/);
  });
});

describe("C5 — one positioning engine", () => {
  test("the fly-out shell is the only consumer of the placement hook", () => {
    const consumers = composer.match(/useFlyoutPosition\(/g) ?? [];
    // One declaration + one call site. Two call sites would be two copies
    // of the flip/clamp math disagreeing about which way to open.
    assert.equal(
      consumers.length,
      2,
      `expected the hook declared once and called once, found ${consumers.length} references`,
    );
  });

  test("there is one fly-out shell, and it is the cascade's only tier", () => {
    // A second `<SettingsFlyout` is a second copy of the flip/clamp math
    // — or a third tier creeping back in.
    const shells = composer.match(/<SettingsFlyout/g) ?? [];
    assert.equal(
      shells.length,
      1,
      `expected one fly-out, found ${shells.length}`,
    );
  });
});

describe("C6 — a model with no settings completes on its own click", () => {
  test("the settings gate decides who gets a fly-out", () => {
    assert.match(composer, /const modelHasSettings = useCallback/);
    // Two spellings of one gate: the hover and focus paths return early,
    // the click path branches. Both mean the same thing — no settings, no
    // fly-out — and the early return has to come first, or a row with
    // nothing to configure still cancels the previous model's close.
    assert.match(handlerBody("onMouseEnter"), /if \(!hasSettings\) return;/);
    assert.match(handlerBody("onFocus"), /!hasSettings/);
    assert.match(handlerBody("onClick"), /if \(hasSettings\) \{/);
  });

  test("the click path gates BOTH of its calls, not just the fly-out claim", () => {
    // `onClick` cancels the grace as well as claiming the fly-out. A gate
    // that wrapped only the claim would let a no-settings model's pick hold
    // the previous model's panel open for the same reason hover did.
    const click = handlerBody("onClick");
    const gateAt = click.indexOf("if (hasSettings) {");
    assert.notEqual(gateAt, -1, "onClick must branch on hasSettings");
    const before = click.slice(0, gateAt);
    assert.doesNotMatch(
      before,
      /cancelFlyoutClose\(\)/,
      "the grace is cancelled before the hasSettings gate",
    );
    assert.doesNotMatch(
      before,
      /setFlyoutFor\(/,
      "the fly-out is claimed before the hasSettings gate",
    );
    const after = click.slice(gateAt);
    assert.match(after, /cancelFlyoutClose\(\)/);
    assert.match(after, /setFlyoutFor\(model\.id\)/);
    // And the branch returns, so a no-settings model falls through to
    // 「直接点击后就完成」 instead of continuing into a fly-out it has none of.
    assert.match(after, /return;/);
  });

  test("the gate is the same >= 2 threshold the control's own mount gate uses", () => {
    // A single-option "choice" is a no-op, not a menu. If these two
    // thresholds ever disagree, a model gets a fly-out whose only control
    // has nothing to choose from.
    assert.match(
      composer,
      /normalizeContextWindowOptions\(model\.contextWindowOptions\)\.length >= 2/,
    );
    assert.match(composer, /const contextReady = contextOptions\.length >= 2/);
  });

  test("the row carries its gate verdict for the DOM to be checked against", () => {
    assert.match(composer, /data-has-settings=\{hasSettings \? "true" : "false"\}/);
  });
});

describe("C7 — the context list is the completing control", () => {
  test("a context pick closes the picker", () => {
    const handler = composer.match(
      /const handleDetailContextPick = useCallback\([\s\S]*?\n  \);/,
    );
    assert.ok(handler, "handleDetailContextPick must exist");
    assert.match(handler[0]!, /onContextPick\?\.\(windowValue\)/);
    assert.match(handler[0]!, /setOpen\(false\)/);
  });

  test("a thinking pick does not close it", () => {
    // The switch sits in the same fly-out as the window list, so a
    // toggle is a mid-visit edit, not the visit's end. Closing here
    // would make a level and a window impossible to set in one visit.
    const handler = composer.match(
      /const handleDetailThinkingPick = useCallback\([\s\S]*?\n  \);/,
    );
    assert.ok(handler, "handleDetailThinkingPick must exist");
    assert.match(handler[0]!, /onThinkingPick\?\.\(level\)/);
    assert.doesNotMatch(handler[0]!, /setOpen\(false\)/);
  });

  test("a no-settings model pick closes the picker", () => {
    // The other half of the reference's rule: nothing left to configure
    // means the click itself is the whole selection.
    const row = composer.match(
      /onClick=\{\(\) => \{[\s\S]*?onPick\(model\.id\);[\s\S]*?\n\s+\}\}/,
    );
    assert.ok(row, "the model row click handler must exist");
    assert.match(row[0]!, /setOpen\(false\)/);
  });
});

describe("C8 — the list container is not duplicated", () => {
  test("there is exactly one model-select-list element", () => {
    // A second, nested list is invisible to every other guard here: the
    // tags balance, so JSX and `tsc` are both happy, and the model rows
    // still satisfy C9 because they are still in the source. Only the
    // count — or the rendered DOM — can tell.
    const containers = composer.match(/data-testid="model-select-list"/g) ?? [];
    assert.equal(
      containers.length,
      1,
      `expected one list container, found ${containers.length} (rows nested in a stale second list)`,
    );
  });

  test("the list carries the keyboard engine, and there is one of it", () => {
    const handlers = composer.match(/onKeyDown=\{handleListKeyDown\}/g) ?? [];
    assert.equal(
      handlers.length,
      1,
      `expected one list key handler, found ${handlers.length}`,
    );
  });
});

describe("C9/C10 — the list itself", () => {
  test("every model in a group renders its own row", () => {
    assert.match(composer, /group\.models\.map\(/);
  });

  test("the row testid is a model testid, and the ✓ compares the model id", () => {
    assert.match(composer, /model-select-model-option-/);
    assert.match(composer, /selected=\{isActiveModel\}/);
  });

  test("the group header and its no-key hint survive", () => {
    // The header is the only place left to say "no key" now that no
    // provider row exists.
    assert.match(composer, /model-select-group-label-/);
    assert.match(composer, /model-select-group-nokey-/);
  });

  test("there is no search box", () => {
    assert.doesNotMatch(composer, /model-select-search/);
    assert.doesNotMatch(composer, /const \[query, setQuery\]/);
  });
});

describe("C11/C12 — the cascade survives keyboard and its own pick", () => {
  test("Escape on the list retracts the fly-out before the dropdown", () => {
    // Inside a cascade the first Escape backs out of the current tier and
    // the second closes the picker.
    assert.match(
      composer,
      /event\.key === "Escape"[\s\S]{0,320}?setFlyoutFor\(null\)/,
    );
  });

  test("the fly-out's own Escape / ArrowLeft hands focus back to the row", () => {
    assert.match(
      composer,
      /event\.key === "Escape" \|\| event\.key === "ArrowLeft"[\s\S]{0,200}?onBack\(\)/,
    );
  });

  test("picking the model does not clear the fly-out", () => {
    // The old code cleared the focused model whenever the active model
    // changed, which under this cascade would close the surface between
    // the pick and the second-tier pick that completes the selection.
    assert.doesNotMatch(composer, /setFlyoutFor\(null\);\s*\}, \[value\]\)/);
  });
});
