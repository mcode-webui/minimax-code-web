// webapp/test/shortcuts.test.ts
//
// Behaviour tests for lib/shortcuts.ts — the registry that decides which
// desktop shortcut rows the browser edition can honour, what each
// dispatched row is bound to, and what a stored override is allowed to
// change.
//
// This file exists because the Shortcuts page used to contradict the app:
// `app/page.tsx` dispatched Ctrl+N and Ctrl+, while the settings page
// printed ten rows disabled behind 「浏览器环境不适用」. A rendered-markup
// assertion cannot settle that, so the registry itself is driven here:
// every dispatch, every matcher edge and every storage read is exercised
// through the exported functions, and the settings page's rendered
// values are cross-checked against the same resolver in
// settings-extra-pages.test.ts.
//
// The window stub is installed through Object.defineProperty before the
// import (settings-local and shortcuts both read lazily inside each
// function, the pattern settings-general-sections.test.ts established).

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  },
});

import {
  SHORTCUT_BINDINGS_KEY,
  SHORTCUT_SPECS,
  applyBinding,
  clearBinding,
  chordFromStroke,
  chordMatches,
  defaultBindings,
  effectiveBindings,
  findBindingConflicts,
  findConflictingId,
  formatChord,
  matchShortcut,
  parseChord,
  readCustomBindings,
  resolveBindings,
  shortcutSpec,
  writeCustomBindings,
  type KeyStroke,
  type ShortcutId,
  type ShortcutStatus,
} from "../lib/shortcuts";

/** A keydown with every modifier off unless the case sets one. */
const stroke = (key: string, modifiers: Partial<KeyStroke> = {}): KeyStroke => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

beforeEach(() => storage.clear());

describe("the registry states one verdict per row", () => {
  test("every spec is internally consistent", () => {
    const seen = new Set<string>();
    for (const spec of SHORTCUT_SPECS) {
      assert.ok(!seen.has(spec.id), `duplicate id ${spec.id}`);
      seen.add(spec.id);
      if (spec.defaultBinding !== null) {
        assert.ok(
          parseChord(spec.defaultBinding) !== null,
          `${spec.id}'s printed default (${spec.defaultBinding}) must parse back`,
        );
      }
      if (spec.status === "blocked") {
        assert.ok(spec.reason, `${spec.id} is blocked and must say why`);
        assert.equal(spec.action, undefined, `${spec.id} must carry no action while blocked`);
      } else {
        assert.ok(spec.action, `${spec.id} is dispatched and must name its action`);
        assert.equal(spec.reason, undefined, `${spec.id} must carry no reason while dispatched`);
      }
    }
  });

  test("the per-row verdicts are the ones the browser permits", () => {
    // Table-driven: one row per line, the combination beside its verdict.
    // Ctrl+T / Ctrl+W never appear — the desktop has no such rows, and a
    // page cannot intercept those combinations anyway, which is exactly
    // why search-tasks (Ctrl+G) and open-folder (Ctrl+O) are blocked.
    const expected: [ShortcutId, string | null, ShortcutStatus][] = [
      ["mini-chat", "Alt+M", "blocked"],
      ["global-search", "Ctrl+K", "live"],
      ["search-tasks", "Ctrl+G", "blocked"],
      ["new-task", "Ctrl+N", "partial"],
      ["new-task-no-project", "Ctrl+Alt+O", "live"],
      ["open-folder", "Ctrl+O", "blocked"],
      ["open-settings", "Ctrl+,", "live"],
      ["hold-dictation", null, "blocked"],
      ["toggle-dictation", null, "blocked"],
      ["invert-follow-up", "Ctrl+Enter", "blocked"],
    ];
    assert.equal(SHORTCUT_SPECS.length, expected.length, "one line per rendered row");
    for (const [id, binding, status] of expected) {
      const spec = shortcutSpec(id);
      assert.equal(spec.defaultBinding, binding, `${id}'s printed combination`);
      assert.equal(spec.status, status, `${id}'s verdict`);
    }
  });

  test("the blocked reasons distinguish the browser's from ours", () => {
    assert.equal(shortcutSpec("search-tasks").reason, "browserReserved");
    assert.equal(shortcutSpec("open-folder").reason, "browserReserved");
    assert.equal(shortcutSpec("mini-chat").reason, "noSurface");
    assert.equal(shortcutSpec("hold-dictation").reason, "noDictation");
    assert.equal(shortcutSpec("invert-follow-up").reason, "pending");
  });

  test("an unknown id is a programming error, not a silent default", () => {
    assert.throws(() => shortcutSpec("nope" as ShortcutId), /unknown shortcut id/);
  });
});

describe("chord parsing is total and lossless", () => {
  test("parses the desktop's display forms", () => {
    assert.deepEqual(parseChord("Ctrl+K"), { ctrl: true, alt: false, shift: false, key: "k" });
    assert.deepEqual(parseChord("Ctrl+Alt+O"), { ctrl: true, alt: true, shift: false, key: "o" });
    assert.deepEqual(parseChord("Ctrl+,"), { ctrl: true, alt: false, shift: false, key: "," });
    assert.deepEqual(parseChord("Enter"), null, "a bare key is not a chord");
    assert.equal(parseChord("Meta+Shift+K")?.ctrl, true, "Meta and Ctrl both mean the primary modifier");
  });

  test("rejects what must never become a matcher", () => {
    for (const bad of ["", "k", "Ctrl+", "Hyper+K", "Ctrl", "Ctrl+Alt"]) {
      assert.equal(parseChord(bad), null, `${bad || "(empty)"} must not parse`);
    }
  });

  test("format and parse are inverses for every default", () => {
    for (const spec of SHORTCUT_SPECS) {
      if (spec.defaultBinding === null) continue;
      const chord = parseChord(spec.defaultBinding);
      assert.ok(chord, `${spec.id} parses`);
      assert.equal(formatChord(chord), spec.defaultBinding, `${spec.id} round-trips`);
    }
  });

  test("a bare modifier press captures nothing", () => {
    for (const key of ["Control", "Alt", "Shift", "Meta", "OS", ""]) {
      assert.equal(chordFromStroke(stroke(key, { ctrlKey: true })), null, `${key} is not a binding`);
    }
    assert.deepEqual(chordFromStroke(stroke("K", { ctrlKey: true, shiftKey: true })), {
      ctrl: true,
      alt: false,
      shift: true,
      key: "k",
    });
  });
});

describe("the matcher dispatches only what the page registered", () => {
  test("each live or partial row's default dispatches its own action", () => {
    const bindings = defaultBindings();
    const table: [KeyStroke, string][] = [
      [stroke("k", { ctrlKey: true }), "globalSearch"],
      [stroke("O", { ctrlKey: true, altKey: true }), "newTaskNoProject"],
      [stroke("n", { ctrlKey: true }), "newTask"],
      [stroke(",", { ctrlKey: true }), "openSettings"],
    ];
    for (const [press, action] of table) {
      assert.equal(matchShortcut(press, bindings), action, `${JSON.stringify(press)} → ${action}`);
    }
  });

  test("a blocked row's printed combination dispatches nothing", () => {
    const bindings = defaultBindings();
    // Ctrl+G is the browser's find-next, Ctrl+O its Open File dialog, and
    // Ctrl+Enter an action whose semantics are undecided: none of them may
    // be swallowed by the page, and Alt+M has no surface to open.
    for (const press of [
      stroke("g", { ctrlKey: true }),
      stroke("o", { ctrlKey: true }),
      stroke("Enter", { ctrlKey: true }),
      stroke("m", { altKey: true }),
    ]) {
      assert.equal(matchShortcut(press, bindings), null, `${JSON.stringify(press)} must not dispatch`);
    }
  });

  test("combinations the browser owns never reach a row", () => {
    const bindings = defaultBindings();
    for (const press of [
      stroke("t", { ctrlKey: true }),
      stroke("w", { ctrlKey: true }),
      stroke("Tab", { ctrlKey: true }),
      stroke("f", { ctrlKey: true }),
      stroke("k"),
    ]) {
      assert.equal(matchShortcut(press, bindings), null, `${JSON.stringify(press)} must not dispatch`);
    }
  });

  test("an extra modifier is a different key, and macOS Cmd reads as Ctrl", () => {
    const bindings = defaultBindings();
    assert.equal(
      matchShortcut(stroke("k", { ctrlKey: true, shiftKey: true }), bindings),
      null,
      "Ctrl+Shift+K must not fire the Ctrl+K binding",
    );
    assert.equal(
      matchShortcut(stroke(",", { metaKey: true }), bindings),
      "openSettings",
      "Cmd+, is the macOS spelling of the Ctrl+, binding",
    );
  });

  test("chordMatches is case- and alias-insensitive", () => {
    assert.ok(chordMatches(stroke("K", { ctrlKey: true }), "Ctrl+k"));
    assert.ok(chordMatches(stroke("Enter", { ctrlKey: true }), "Ctrl+Return"));
    assert.ok(!chordMatches(stroke("k"), "nonsense"));
  });
});

describe("custom bindings are honoured only where the registry allows", () => {
  test("an override replaces the default for a live row", () => {
    const resolved = resolveBindings({ "open-settings": "Ctrl+Shift+," });
    assert.equal(resolved["open-settings"], "Ctrl+Shift+,");
    assert.equal(
      matchShortcut(stroke(",", { ctrlKey: true, shiftKey: true }), resolved),
      "openSettings",
    );
    assert.equal(matchShortcut(stroke(",", { ctrlKey: true }), resolved), null);
  });

  test("a blocked row ignores an override, and an unknown row is dropped", () => {
    const resolved = resolveBindings({
      "invert-follow-up": "Ctrl+Shift+Enter",
      "search-tasks": "Ctrl+Shift+G",
      "made-up": "Ctrl+9",
    });
    assert.equal(resolved["invert-follow-up"], "Ctrl+Enter", "a blocked row keeps its printed value");
    assert.equal(resolved["search-tasks"], "Ctrl+G", "a browser-reserved row keeps its printed value");
    assert.equal((resolved as Record<string, unknown>)["made-up"], undefined, "no phantom row appears");
    assert.equal(
      matchShortcut(stroke("Enter", { ctrlKey: true, shiftKey: true }), resolved),
      null,
      "the dropped override must not widen what the page dispatches",
    );
  });

  test("an unparseable override falls back to the default", () => {
    const resolved = resolveBindings({ "global-search": "Hyper+K" });
    assert.equal(resolved["global-search"], "Ctrl+K");
  });
});

describe("two rows on one combination are refused, and named", () => {
  test("findConflictingId reports the other live row", () => {
    const bindings = resolveBindings({});
    assert.equal(findConflictingId(bindings, "Ctrl+Alt+O", "global-search"), "new-task-no-project");
    assert.equal(findConflictingId(bindings, "Ctrl+K", "open-settings"), "global-search");
  });

  test("a row saving its own combination is not a conflict", () => {
    const bindings = resolveBindings({});
    assert.equal(findConflictingId(bindings, "Ctrl+K", "global-search"), null);
    assert.deepEqual(findBindingConflicts(bindings), [], "the shipped defaults are conflict-free");
  });

  test("a blocked row's printed combination is not a conflict", () => {
    // Ctrl+Enter prints on a blocked row; binding it live must be allowed,
    // because nothing dispatches Ctrl+Enter today.
    const bindings = resolveBindings({});
    assert.equal(findConflictingId(bindings, "Ctrl+Enter", "global-search"), null);
  });

  test("applyBinding refuses a clash and names the row that owns it", () => {
    const refused = applyBinding({}, "global-search", "Ctrl+Alt+O");
    assert.equal(refused.ok, false);
    assert.equal(
      refused.ok ? null : refused.with,
      "new-task-no-project",
      "the message must name the action already holding the combination",
    );
    // The refused candidate must leave the stored map untouched — a
    // refusal that still wrote would dispatch in registry order.
    const accepted = applyBinding({}, "global-search", "Ctrl+Shift+P");
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.ok ? accepted.custom : null, { "global-search": "Ctrl+Shift+P" });
  });

  test("applyBinding refuses a blocked row, and re-saving is never a clash", () => {
    const blocked = applyBinding({}, "invert-follow-up", "Ctrl+Shift+Enter");
    assert.equal(blocked.ok, false, "there is nothing to bind on a blocked row");
    const same = applyBinding({ "global-search": "Ctrl+Shift+P" }, "global-search", "Ctrl+Shift+P");
    assert.equal(same.ok, true, "a row may re-record the combination it already holds");
  });

  test("clearBinding drops one row and leaves the others", () => {
    const custom = { "global-search": "Ctrl+Shift+P", "open-settings": "Ctrl+Shift+," };
    assert.deepEqual(clearBinding(custom, "global-search"), { "open-settings": "Ctrl+Shift+," });
    assert.deepEqual(clearBinding({}, "global-search"), {}, "clearing a default row is a no-op");
  });

  test("findBindingConflicts names both sides of a duplicate", () => {
    const duplicated = { ...resolveBindings({}), "open-settings": "Ctrl+K" };
    assert.deepEqual(findBindingConflicts(duplicated).sort(), ["global-search", "open-settings"]);
  });

  test("an unparseable candidate is never a conflict", () => {
    assert.equal(findConflictingId(resolveBindings({}), "nonsense", "global-search"), null);
  });
});

describe("storage is best effort and revalidated on read", () => {
  test("a round trip through localStorage changes what is dispatched", () => {
    writeCustomBindings({ "global-search": "Ctrl+Shift+P" });
    assert.equal(storage.get(SHORTCUT_BINDINGS_KEY), '{"global-search":"Ctrl+Shift+P"}');
    assert.equal(effectiveBindings()["global-search"], "Ctrl+Shift+P");
    assert.equal(
      matchShortcut(stroke("p", { ctrlKey: true, shiftKey: true }), effectiveBindings()),
      "globalSearch",
    );
  });

  test("an empty map removes the key rather than storing {}", () => {
    writeCustomBindings({ "global-search": "Ctrl+Shift+P" });
    writeCustomBindings({});
    assert.equal(storage.has(SHORTCUT_BINDINGS_KEY), false);
  });

  test("corrupt storage reads as no overrides instead of throwing", () => {
    const cases = [
      "{not json",
      "[]",
      '"a string"',
      "null",
      '{"global-search":42}',
      '{"global-search":"Hyper+K"}',
      '{"invert-follow-up":"Ctrl+Shift+Enter"}',
      '{"made-up":"Ctrl+9"}',
    ];
    for (const raw of cases) {
      storage.set(SHORTCUT_BINDINGS_KEY, raw);
      assert.deepEqual(readCustomBindings(), {}, `${raw} must read as no overrides`);
    }
  });

  test("a missing key reads as no overrides", () => {
    assert.deepEqual(readCustomBindings(), {});
  });

  test("a stored override for a live row survives the read", () => {
    storage.set(SHORTCUT_BINDINGS_KEY, '{"new-task-no-project":"Ctrl+Shift+O"}');
    assert.deepEqual(readCustomBindings(), { "new-task-no-project": "Ctrl+Shift+O" });
  });
});
