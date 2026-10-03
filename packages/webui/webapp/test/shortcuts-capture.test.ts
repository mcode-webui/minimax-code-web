// webapp/test/shortcuts-capture.test.ts
//
// The rebind path of the Shortcuts page, driven by real keydowns.
//
// Why this file exists
// --------------------
//
// SB-2 built `shortcuts.ts` and asserted it end to end, and the Shortcuts
// page's markup was asserted with `renderToStaticMarkup`. Neither could
// reach the part that matters most: a string of markup has no focus and
// no listeners, so "press Ctrl+Alt+O in the Global search box" was never
// executed by anything. The capture → verdict → conflict-report path —
// the only place a user learns their new combination was refused — had no
// test at all, and the mutation that proved it: swallow the conflict
// report, so a refused rebind silently leaves the box showing the old
// combination and nothing else. That mutant stayed green (SB-2's M9)
// because the suite had no way to type into a page.
//
// With the DOM harness the path is drivable: dispatch a keydown on the
// real input, let React's handler run, read the resulting DOM. The
// markup assertions in `settings-extra-pages.test.ts` stay where they
// are — "what does the page print" and "what happens when the user
// presses a key" are different questions, and this file answers only
// the second.
//
// What is pinned
// --------------
//
//   1. A live row records the combination actually pressed and persists
//      it. This is the whole point of the page; a capture that renders
//      but never writes is the mirror-image silent failure.
//   2. A combination another dispatched row already owns is REFUSED,
//      the refusal is reported on the row that was edited, and it names
//      the action that holds it. This is SB-2's M9, the mutation that
//      used to survive.
//   3. A refused capture writes nothing: the box, the status badge and
//      `localStorage` all keep their previous values.
//   4. Escape abandons a capture in progress — including a refusal that
//      is on screen — without touching storage.
//   5. A captured combination does not also run its own action:
//      recording `Ctrl+,` must not open the settings page.
//   6. A blocked row and a `partial` row are not editable, and a
//      keydown on them changes nothing at all.
//   7. The ✕ restores the printed default and drops the stored override.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

// The harness must be imported before the component: it publishes the
// window that react-dom captures `canUseDOM` from. See its header.
import { withDom, resetStorage, type KeyPress, type Mounted } from "./helpers/dom";

import { ShortcutsSection } from "../components/settings-extra-pages";
import { translate, type MessageKey } from "../lib/i18n";
import { SHORTCUT_BINDINGS_KEY } from "../lib/shortcuts";

const t = (key: MessageKey) => translate("zh", key);

const box = (id: string) => `settings-shortcuts-binding-${id}`;
const conflict = (id: string) => `settings-shortcuts-conflict-${id}`;
const status = (id: string) => `settings-shortcuts-status-${id}`;

const GLOBAL_SEARCH = box("global-search");
const NEW_TASK_NO_PROJECT = box("new-task-no-project");
const OPEN_SETTINGS = box("open-settings");
const SEARCH_TASKS = box("search-tasks");
const NEW_TASK = box("new-task");

/** The persisted override map, or `null` when the key is absent. */
function stored(): Record<string, string> | null {
  const raw = window.localStorage.getItem(SHORTCUT_BINDINGS_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, string>);
}

/** Mount the page and hand the view to `fn`, unmounting afterwards. */
function onPage(fn: (view: Mounted) => Promise<void> | void): Promise<void> {
  return withDom(createElement(ShortcutsSection, { t }), fn);
}

beforeEach(() => resetStorage());

describe("a live row records the combination the user presses", () => {
  test("the pressed combination lands in the box, the badge and storage", async () => {
    await onPage(async (view) => {
      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("value"), "Ctrl+K");
      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("data-customized"), null);
      assert.equal(view.text(status("global-search")), t("settings.shortcuts.status.live"));

      await view.pressKey(GLOBAL_SEARCH, { key: "P", ctrlKey: true, shiftKey: true });

      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("value"), "Ctrl+Shift+P");
      assert.equal(view.text(status("global-search")), t("settings.shortcuts.status.customized"));
      assert.deepEqual(stored(), { "global-search": "Ctrl+Shift+P" });
      assert.equal(view.has(conflict("global-search")), false, "an accepted capture reports nothing");
    });
  });

  test("each modifier is read from the event, not from a fixed chord", async () => {
    // Table-driven: the press on the left, the chord it must produce.
    // Every candidate is one no other live row owns, so a refusal cannot
    // be mistaken for a parse failure here.
    const table: [Parameters<Mounted["pressKey"]>[1], string][] = [
      [{ key: "K", ctrlKey: true, shiftKey: true }, "Ctrl+Shift+K"],
      [{ key: ",", ctrlKey: true }, "Ctrl+,"],
      [{ key: "O", ctrlKey: true, altKey: true, shiftKey: true }, "Ctrl+Alt+Shift+O"],
      // Meta and Ctrl are the same modifier to the registry — the macOS
      // spelling of the same chord — so Cmd+P records as Ctrl+P.
      [{ key: "p", ctrlKey: true, metaKey: true }, "Ctrl+P"],
      [{ key: "J", ctrlKey: true, altKey: true, shiftKey: true }, "Ctrl+Alt+Shift+J"],
    ];
    for (const [press, chord] of table) {
      resetStorage();
      await onPage(async (view) => {
        await view.pressKey(OPEN_SETTINGS, press);
        assert.equal(view.find(OPEN_SETTINGS).getAttribute("value"), chord, `${JSON.stringify(press)}`);
        assert.deepEqual(stored(), { "open-settings": chord });
      });
    }
  });

  test("a second capture replaces the first", async () => {
    await onPage(async (view) => {
      await view.pressKey(GLOBAL_SEARCH, { key: "P", ctrlKey: true, shiftKey: true });
      await view.pressKey(GLOBAL_SEARCH, { key: "F", ctrlKey: true, altKey: true });
      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("value"), "Ctrl+Alt+F");
      assert.deepEqual(stored(), { "global-search": "Ctrl+Alt+F" });
    });
  });
});

describe("a combination another row owns is refused, and the refusal is on screen", () => {
  // SB-2's M9. The mutant that survived the static-markup suite dropped
  // this report: `commit` returned early on a refusal without telling the
  // page, so the user pressed Ctrl+Alt+O, the binding did not change, and
  // the page said nothing. There is no assertion that can see that from
  // a string of markup.
  test("the edited row names the action that already holds it", async () => {
    await onPage(async (view) => {
      assert.equal(view.has(conflict("global-search")), false, "nothing is reported before the press");

      await view.pressKey(GLOBAL_SEARCH, { key: "O", ctrlKey: true, altKey: true });

      assert.equal(
        view.text(conflict("global-search")),
        `${t("settings.shortcuts.conflict")} ${t("settings.shortcuts.item.newTaskNoProject")}`,
      );
    });
  });

  test("a refusal writes nothing and changes nothing on screen", async () => {
    await onPage(async (view) => {
      await view.pressKey(GLOBAL_SEARCH, { key: "O", ctrlKey: true, altKey: true });

      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("value"), "Ctrl+K", "the old binding stays");
      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("data-customized"), null);
      assert.equal(view.text(status("global-search")), t("settings.shortcuts.status.live"));
      assert.equal(stored(), null, "a refused capture must not touch localStorage");
      assert.equal(view.has(conflict("new-task-no-project")), false, "the owning row is not the one reporting");
    });
  });

  test("the owning row is named for every combination it holds", async () => {
    // Table-driven: which box is pressed, and whose name must appear.
    const table: [string, KeyPress, string][] = [
      [GLOBAL_SEARCH, { key: "O", ctrlKey: true, altKey: true }, "settings.shortcuts.item.newTaskNoProject"],
      [OPEN_SETTINGS, { key: "k", ctrlKey: true }, "settings.shortcuts.item.globalSearch"],
    ];
    for (const [target, press, ownerKey] of table) {
      await onPage(async (view) => {
        const id = target === GLOBAL_SEARCH ? "global-search" : "open-settings";
        await view.pressKey(target, press);
        assert.equal(
          view.text(conflict(id)),
          `${t("settings.shortcuts.conflict")} ${t(ownerKey as MessageKey)}`,
        );
      });
    }
  });

  test("a refusal is superseded by the next accepted capture", async () => {
    await onPage(async (view) => {
      await view.pressKey(GLOBAL_SEARCH, { key: "O", ctrlKey: true, altKey: true });
      assert.equal(view.has(conflict("global-search")), true);

      await view.pressKey(GLOBAL_SEARCH, { key: "P", ctrlKey: true, shiftKey: true });
      assert.equal(view.has(conflict("global-search")), false, "the stale refusal must not linger");
      assert.deepEqual(stored(), { "global-search": "Ctrl+Shift+P" });
    });
  });
});

describe("Escape abandons a capture without touching storage", () => {
  test("Escape clears a refusal that is on screen", async () => {
    await onPage(async (view) => {
      await view.pressKey(GLOBAL_SEARCH, { key: "O", ctrlKey: true, altKey: true });
      assert.equal(view.has(conflict("global-search")), true);

      await view.pressKey(GLOBAL_SEARCH, { key: "Escape" });

      assert.equal(view.has(conflict("global-search")), false);
      assert.equal(stored(), null);
    });
  });

  test("Escape is prevented so it cannot also close the settings modal", async () => {
    await onPage(async (view) => {
      const input = view.find(GLOBAL_SEARCH);
      const event = view.keyEvent({ key: "Escape" });
      await view.run(() => input.dispatchEvent(event));
      assert.equal(event.defaultPrevented, true, "the modal's own Esc handler must not also run");
    });
  });
});

describe("a captured combination does not also run its own action", () => {
  // Recording `Ctrl+,` in the Open settings box must not be swallowed by
  // the page-level handler that dispatches `Ctrl+,` to open this very
  // page. The evidence is `defaultPrevented` on the dispatched event,
  // which a render assertion cannot produce.
  test("the keydown the capture consumed is cancelled", async () => {
    await onPage(async (view) => {
      const input = view.find(OPEN_SETTINGS);
      const event = view.keyEvent({ key: ",", ctrlKey: true });
      await view.run(() => input.dispatchEvent(event));
      assert.equal(event.defaultPrevented, true);
    });
  });

  test("a bare modifier press is not cancelled and captures nothing", async () => {
    // A user holding Ctrl on the way to a chord passes through this box
    // first; cancelling it would be a defect of its own.
    await onPage(async (view) => {
      for (const key of ["Control", "Shift", "Alt", "Meta"]) {
        const input = view.find(GLOBAL_SEARCH);
        const event = view.keyEvent({ key, ctrlKey: true });
        await view.run(() => input.dispatchEvent(event));
        assert.equal(event.defaultPrevented, false, `${key} alone must pass through`);
      }
      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("value"), "Ctrl+K");
      assert.equal(stored(), null);
    });
  });
});

describe("a row the registry does not allow rebinding takes no input", () => {
  test("a blocked row and a platform-limited row ignore every keydown", async () => {
    await onPage(async (view) => {
      // search-tasks prints Ctrl+G, which the browser owns; new-task is
      // `partial` — dispatched, but taken by the browser on Windows and
      // Linux, so rebinding it would buy nothing.
      for (const target of [SEARCH_TASKS, NEW_TASK]) {
        assert.equal(view.find(target).hasAttribute("disabled"), true, `${target} renders disabled`);
        await view.pressKey(target, { key: "9", ctrlKey: true, altKey: true });
      }
      assert.equal(view.find(SEARCH_TASKS).getAttribute("value"), "Ctrl+G");
      assert.equal(view.find(NEW_TASK).getAttribute("value"), "Ctrl+N");
      assert.equal(stored(), null);
      assert.equal(view.find(SEARCH_TASKS).hasAttribute("data-customized"), false);
    });
  });

  test("a blocked row's ✕ is present but dead, and it reports nothing", async () => {
    await onPage(async (view) => {
      // The disabled box keeps the desktop's ✕ for shape parity; what
      // matters is that it cannot be operated, not that it is absent.
      const clear = view.find(`${SEARCH_TASKS}-clear`);
      assert.equal(clear.hasAttribute("disabled"), true, "a blocked row's ✕ is dead");
      await view.click(`${SEARCH_TASKS}-clear`);
      assert.equal(view.find(SEARCH_TASKS).getAttribute("value"), "Ctrl+G");
      assert.equal(stored(), null);
      assert.equal(view.has(conflict("search-tasks")), false);
      assert.equal(view.has(status("search-tasks")), false, "a blocked row prints its reason instead of a badge");
    });
  });
});

describe("the ✕ restores the default and drops the override", () => {
  test("clearing a customised row rewrites storage to the empty map", async () => {
    await onPage(async (view) => {
      await view.pressKey(GLOBAL_SEARCH, { key: "P", ctrlKey: true, shiftKey: true });
      assert.deepEqual(stored(), { "global-search": "Ctrl+Shift+P" });

      await view.click(`${GLOBAL_SEARCH}-clear`);

      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("value"), "Ctrl+K");
      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("data-customized"), null);
      assert.equal(stored(), null, "an empty override map removes the key rather than writing {}");
    });
  });

  test("clearing also takes a refusal off the screen", async () => {
    await onPage(async (view) => {
      await view.pressKey(GLOBAL_SEARCH, { key: "O", ctrlKey: true, altKey: true });
      await view.pressKey(GLOBAL_SEARCH, { key: "P", ctrlKey: true, shiftKey: true });
      await view.click(`${GLOBAL_SEARCH}-clear`);
      assert.equal(view.has(conflict("global-search")), false);
    });
  });
});

describe("a stored override hydrates into the box before the first press", () => {
  test("the page opens on the saved combination, not the default", async () => {
    window.localStorage.setItem(SHORTCUT_BINDINGS_KEY, '{"global-search":"Ctrl+Shift+P"}');
    await onPage(async (view) => {
      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("value"), "Ctrl+Shift+P");
      assert.equal(view.find(GLOBAL_SEARCH).getAttribute("data-customized"), "true");
      assert.equal(view.text(status("global-search")), t("settings.shortcuts.status.customized"));
      // A stored override cannot smuggle in a broken chord, so the box a
      // user re-records from is one the registry accepts.
      assert.equal(view.find(NEW_TASK_NO_PROJECT).getAttribute("value"), "Ctrl+Alt+O");
    });
  });

  test("a stored override the registry rejects is dropped, not rendered", async () => {
    // A blocked row is not rebindable, so a hand-edited entry for it is
    // discarded on read and the row prints its desktop value.
    window.localStorage.setItem(SHORTCUT_BINDINGS_KEY, '{"search-tasks":"Ctrl+Shift+G"}');
    await onPage(async (view) => {
      assert.equal(view.find(SEARCH_TASKS).getAttribute("value"), "Ctrl+G");
    });
  });
});
