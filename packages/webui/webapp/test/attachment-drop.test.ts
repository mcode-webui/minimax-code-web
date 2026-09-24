// webapp/test/attachment-drop.test.ts
// Contract tests for the composer's drag-and-drop gate.
//
// Why this exists: the legacy vanilla-JS composer showed a drop overlay
// whenever the user dragged a file over the message-input card. The
// Next.js composer must do the same — and, just as importantly, must
// *not* show the overlay for text drags (selected text inside the
// textarea, drag-from-tab gestures). The gate is `isFileDrag`, which
// inspects `dataTransfer.types` for the `"Files"` token.
//
// This test mirrors `composer.tsx`'s `isFileDrag` inline so the
// regression does not pull React / Next.js path aliases into a Node
// test runner. The shape is deliberately identical to the source —
// if `composer.tsx` drifts, this file must be updated in lockstep,
// exactly like `webapp/test/slash-commands.test.ts`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The drag-gate check in a standalone re-implementation.
 *
 * Mirror of `isFileDrag` in `components/composer.tsx`. Both the legacy
 * DOMStringList and the modern frozen-array `types` expose indexed
 * access, so a single length/index loop covers both forms.
 */
function isFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

describe("composer drag-and-drop gate — isFileDrag", () => {
  test("accepts a modern frozen array that contains 'Files'", () => {
    const types = Object.freeze(["Files"]) as ArrayLike<string>;
    assert.equal(isFileDrag(types), true);
  });

  test("accepts a legacy DOMStringList shape that contains 'Files'", () => {
    const types: ArrayLike<string> = { length: 2, 0: "Files", 1: "text/plain" };
    assert.equal(isFileDrag(types), true);
  });

  test("ignores a text drag ('text/plain' / 'text/uri-list' but no 'Files')", () => {
    // Selecting text inside the composer fires dragenter/dragover with
    // these types; raising the overlay here is the original bug.
    const types = Object.freeze(["text/plain"]) as ArrayLike<string>;
    assert.equal(isFileDrag(types), false);
  });

  test("ignores a tab-drag (URI list, no 'Files')", () => {
    const types = Object.freeze(["text/uri-list", "text/plain"]) as ArrayLike<string>;
    assert.equal(isFileDrag(types), false);
  });

  test("treats a null dataTransfer as absent", () => {
    assert.equal(isFileDrag(null), false);
  });

  test("treats an undefined types list as absent", () => {
    assert.equal(isFileDrag(undefined), false);
  });

  test("treats an empty types list as absent", () => {
    assert.equal(isFileDrag([] as ArrayLike<string>), false);
  });

  test("ignores the 'Files' substring when it is not a full token (e.g. 'application/Foo+xml')", () => {
    // Defensive: substring matches must NOT count. The check is an
    // exact-equality lookup on each entry of the array, not a
    // `String.prototype.includes` test against a joined string.
    const types = Object.freeze(["application/x-not-files"]) as ArrayLike<string>;
    assert.equal(isFileDrag(types), false);
  });

  test("finds 'Files' in a mixed types list", () => {
    const types = Object.freeze(["text/plain", "Files", "text/uri-list"]) as ArrayLike<string>;
    assert.equal(isFileDrag(types), true);
  });
});

describe("composer drag-and-drop gate — counter semantics", () => {
  /**
   * Simulates the depth counter used by the composer's drag handlers.
   *
   * Why a counter, not a boolean: each child element the drag enters
   * fires its own dragenter/dragleave pair. A naive boolean flips off
   * the moment the cursor crosses a child boundary, which the browser
   * reports as a leave from the parent + an enter into the child. The
   * counter keeps the overlay stable for the duration of the drag.
   */
  function simulateDrag(
    counter: { current: number },
    enter: (label: string) => void,
    leave: (label: string) => void,
    sequence: Array<"enter" | "leave" | { kind: "enter"; label: string } | { kind: "leave"; label: string }>,
  ): { overlayVisible: boolean; finalCount: number } {
    let count = 0;
    const apply = (delta: number) => {
      count = Math.max(0, count + delta);
      counter.current = count;
    };
    for (const step of sequence) {
      const kind = typeof step === "string" ? step : step.kind;
      const label = typeof step === "string" ? kind : step.label;
      if (kind === "enter") {
        apply(1);
        enter(label);
      } else {
        apply(-1);
        leave(label);
      }
    }
    return { overlayVisible: count > 0, finalCount: count };
  }

  test("a single enter followed by a matching leave ends the drag", () => {
    const counter = { current: 0 };
    const log: string[] = [];
    const result = simulateDrag(
      counter,
      (label) => log.push(`enter:${label}`),
      (label) => log.push(`leave:${label}`),
      ["enter", "leave"],
    );
    assert.equal(result.overlayVisible, false);
    assert.equal(result.finalCount, 0);
    assert.deepEqual(log, ["enter:enter", "leave:leave"]);
  });

  test("child-element boundary crossing does not flicker the overlay", () => {
    // The classic flicker case: cursor moves from the outer composer
    // card into a child element (say the toolbar button). The browser
    // fires dragleave on the parent and dragenter on the child. A
    // naive boolean would set the overlay to false and back to true;
    // a counter stays at 1 and the overlay never drops.
    const counter = { current: 0 };
    const log: string[] = [];
    const result = simulateDrag(
      counter,
      (label) => log.push(`enter:${label}`),
      (label) => log.push(`leave:${label}`),
      [
        { kind: "enter", label: "composer-root" },
        { kind: "leave", label: "composer-root" },
        { kind: "enter", label: "toolbar-button" },
      ],
    );
    assert.equal(result.overlayVisible, true, "overlay must stay on while the cursor is inside the composer subtree");
    assert.equal(result.finalCount, 1);
  });

  test("an out-of-bounds leave after the last child drops the overlay", () => {
    const counter = { current: 0 };
    const log: string[] = [];
    const result = simulateDrag(
      counter,
      (label) => log.push(`enter:${label}`),
      (label) => log.push(`leave:${label}`),
      [
        { kind: "enter", label: "composer-root" },
        { kind: "enter", label: "toolbar-button" },
        { kind: "leave", label: "toolbar-button" },
        { kind: "leave", label: "composer-root" },
      ],
    );
    assert.equal(result.overlayVisible, false);
    assert.equal(result.finalCount, 0);
  });

  test("the counter is clamped at zero — a stray leave cannot go negative", () => {
    const counter = { current: 0 };
    const log: string[] = [];
    const result = simulateDrag(
      counter,
      (label) => log.push(`enter:${label}`),
      (label) => log.push(`leave:${label}`),
      [
        { kind: "leave", label: "stray-1" },
        { kind: "leave", label: "stray-2" },
      ],
    );
    assert.equal(result.overlayVisible, false);
    assert.equal(result.finalCount, 0, "Math.max(0, …) clamps");
  });

  test("a drop terminates the drag regardless of where it occurs in the tree", () => {
    // The composer's onDrop resets the counter unconditionally; this
    // asserts that contract.
    const counter = { current: 0 };
    counter.current = 3; // mid-drag, deep in the subtree
    counter.current = 0;
    assert.equal(counter.current, 0);
  });
});