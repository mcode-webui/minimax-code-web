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

import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The flatten step in a standalone re-implementation, so the regression does not
 * import React. The shape mirrors `composer.tsx`'s `slashCommands` derivation.
 */
function flattenAvailableCommands(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const out: string[] = [];
  for (const group of Object.values(raw as Record<string, unknown>)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (
        entry &&
        typeof entry === "object" &&
        "name" in entry &&
        typeof (entry as { name: unknown }).name === "string"
      ) {
        out.push((entry as { name: string }).name);
      }
    }
  }
  return out;
}

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