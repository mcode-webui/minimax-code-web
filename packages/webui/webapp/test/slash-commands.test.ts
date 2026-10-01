// webapp/test/slash-commands.test.ts
// Regression tests for the slash-command palette flattening.
//
// Why this test exists: the server reports `availableCommands` as a *dict* of
// command groups (`{ <group>: [{name, description}, ...] }`), not a flat string
// array. The composer flattens it before filtering so the palette can show
// `name` strings. A previous version assumed the legacy `string[]` shape and
// crashed the page on the first `/` keystroke with `TypeError: ... .filter is
// not a function` — the unit tests never exercised the rendering path, so it
// only surfaced in the live browser. This file pins the contract at the level
// it matters: the function the composer relies on.
//
// The flatten step used to live here as a standalone re-implementation (a
// mirror of composer.tsx's inline derivation), which meant the suite could
// pass while the component drifted. It now imports the real
// `flattenAvailableCommands` from `lib/slash-routing.ts` — the exact function
// the composer calls — and pins the dedupe rule that fixes the live
// "Encountered two children with the same key: help" console error: the mcode
// group and the webui group both report a `help`, the palette keys rows by
// name, so without the dedupe the same key rendered twice.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { flattenAvailableCommands } from "../lib/slash-routing";

function filterCommands(commands: string[], word: string, limit = 8): string[] {
  const needle = word.toLowerCase();
  return commands
    .filter((command) => command.toLowerCase().includes(needle))
    .slice(0, limit);
}

describe("flattenAvailableCommands — server's dict shape", () => {
  test("flattens the mcode group into a list of names", () => {
    const raw = {
      mcode: [
        { name: "help", description: "Show available commands" },
        { name: "new", description: "Start a fresh session" },
        { name: "model", description: "Choose a model" },
      ],
    };
    assert.deepEqual(flattenAvailableCommands(raw), ["help", "new", "model"]);
  });

  test("keeps every group in document order", () => {
    const raw = {
      mcode: [{ name: "help" }, { name: "compact" }],
      extra: [{ name: "plugin-foo" }, { name: "plugin-bar" }],
    };
    assert.deepEqual(flattenAvailableCommands(raw), [
      "help",
      "compact",
      "plugin-foo",
      "plugin-bar",
    ]);
  });

  test("skips entries whose `name` is missing or not a string", () => {
    const raw = {
      mcode: [
        { name: "help" },
        { description: "no name" },
        { name: 123 },
        null,
        { name: "model" },
      ],
    };
    assert.deepEqual(flattenAvailableCommands(raw), ["help", "model"]);
  });

  test("returns [] for null / undefined / non-object input (legacy bug)", () => {
    assert.deepEqual(flattenAvailableCommands(undefined), []);
    assert.deepEqual(flattenAvailableCommands(null), []);
    assert.deepEqual(flattenAvailableCommands("commands"), []);
    assert.deepEqual(flattenAvailableCommands(42), []);
  });

  test("returns [] for an empty object", () => {
    assert.deepEqual(flattenAvailableCommands({}), []);
  });

  test("tolerates a group whose value is not an array", () => {
    const raw = { mcode: [{ name: "help" }], bad: "not-an-array" };
    assert.deepEqual(flattenAvailableCommands(raw), ["help"]);
  });
});

describe("flattenAvailableCommands — cross-group dedupe (same-key regression)", () => {
  test("keeps one `help` when mcode and webui both report it", () => {
    // The live console error: the palette renders `key={name}`, and both
    // groups carry a `help` — React saw two children with the same key.
    const raw = {
      mcode: [{ name: "help" }, { name: "new" }, { name: "model" }],
      webui: [{ name: "new" }, { name: "clear" }, { name: "help" }],
    };
    assert.deepEqual(flattenAvailableCommands(raw), ["help", "new", "model", "clear"]);
  });

  test("dedupes within a single group too", () => {
    const raw = { mcode: [{ name: "help" }, { name: "help" }] };
    assert.deepEqual(flattenAvailableCommands(raw), ["help"]);
  });

  test("a `/h` filter after dedupe can no longer yield duplicate keys", () => {
    // End-to-end shape of the composer pipeline: flatten → filter → palette
    // rows keyed by name. Duplicated keys are impossible when the flattened
    // list itself has no duplicates.
    const raw = {
      mcode: [{ name: "help" }, { name: "history" }],
      webui: [{ name: "help" }, { name: "usage" }],
    };
    const flat = flattenAvailableCommands(raw);
    const matches = flat.filter((c) => c.toLowerCase().includes("h"));
    assert.deepEqual(matches, ["help", "history"]);
    assert.equal(new Set(matches).size, matches.length);
  });
});

describe("filterCommands — slash palette filter", () => {
  const cmds = ["help", "new", "model", "compact", "status"];

  test("substring match is case-insensitive", () => {
    assert.deepEqual(filterCommands(cmds, "MO"), ["model"]);
    assert.deepEqual(filterCommands(cmds, "mo"), ["model"]);
  });

  test("returns up to 8 entries by default", () => {
    const many = Array.from({ length: 20 }, (_, i) => `cmd-${i}`);
    assert.equal(filterCommands(many, "cmd").length, 8);
  });

  test("returns [] when nothing matches", () => {
    assert.deepEqual(filterCommands(cmds, "xyz"), []);
  });
});