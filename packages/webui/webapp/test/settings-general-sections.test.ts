// webapp/test/settings-general-sections.test.ts
//
// Contract pins for the ticket-48 General-page additions: the four
// browser-local preference keys (lib/settings-local.ts) and the two
// consumer wirings that make those switches real (code-view.tsx's soft
// wrap, page.tsx's tab reuse).
//
// The settings-local module reads `window.localStorage`; the harness
// stubs `window` through Object.defineProperty on `globalThis` BEFORE
// importing the module — the same pattern theme.test.ts established
// (the module has no top-level window access, only lazy reads inside
// each function). What the static-source pins cover, and why:
//
//   - The default asymmetry: `file_open_in_new_tab` defaults to TRUE
//     here (the webui's one-tab-per-file behaviour) while the other
//     three keys take the reference's defaults. That decision is a
//     documented contract, not an accident — a revert that flips the
//     default changes every existing user's tab behaviour and must
//     fail here first.
//   - The key NAMES are the reference's bare strings, so a browser
//     profile carries the same preferences in both clients. Renaming
//     one (e.g. namespacing it under `webui:`) breaks that sharing and
//     must fail here.
//   - The consumers: the wrap class in code-view.tsx and the reuse
//     branch in page.tsx are render-critical wiring no unit test can
//     drive (no render harness), so they are pinned as static sources
//     like settings-parity-nav.test.ts does.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// --- window stub (before the module import) ---------------------------------

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
  CONTEXT_WINDOW_USAGE_KEY,
  FILE_LINE_WRAP_KEY,
  FILE_OPEN_IN_NEW_TAB_KEY,
  FOLLOW_UP_BEHAVIOR_KEY,
  readContextWindowUsage,
  readFileLineWrap,
  readFileOpenInNewTab,
  readFollowUpBehavior,
  writeContextWindowUsage,
  writeFileLineWrap,
  writeFileOpenInNewTab,
  writeFollowUpBehavior,
} from "../lib/settings-local";

const here = dirname(fileURLToPath(import.meta.url));
const panelsSource = readFileSync(resolve(here, "../components/panels.tsx"), "utf8");
const codeViewSource = readFileSync(resolve(here, "../components/code-view.tsx"), "utf8");
const pageSource = readFileSync(resolve(here, "../app/page.tsx"), "utf8");

describe("settings-local keys (ticket 48)", () => {
  beforeEach(() => {
    storage.clear();
  });

  test("the four keys are the desktop reference's bare strings", () => {
    assert.equal(FILE_OPEN_IN_NEW_TAB_KEY, "file_open_in_new_tab");
    assert.equal(FILE_LINE_WRAP_KEY, "file_line_wrap");
    assert.equal(CONTEXT_WINDOW_USAGE_KEY, "webui-context-window-usage");
    assert.equal(FOLLOW_UP_BEHAVIOR_KEY, "webui-follow-up-behavior");
  });

  test("defaults: new-tab ON (webui's standing behaviour), the rest per reference", () => {
    // The reference defaults `file_open_in_new_tab` to "false"; this
    // client defaults it to "true" because its tab strip has always
    // been one-tab-per-file and has no pinned-tab concept to reuse.
    // Flipping this default changes existing users' behaviour — the
    // pin is deliberate.
    assert.equal(readFileOpenInNewTab(), true);
    assert.equal(readFileLineWrap(), true);
    assert.equal(readContextWindowUsage(), false);
    assert.equal(readFollowUpBehavior(), "queue");
  });

  test("writes round-trip through localStorage and reads mirror them", () => {
    writeFileOpenInNewTab(false);
    writeFileLineWrap(false);
    writeContextWindowUsage(true);
    writeFollowUpBehavior("steer");
    assert.equal(storage.get(FILE_OPEN_IN_NEW_TAB_KEY), "false");
    assert.equal(storage.get(FILE_LINE_WRAP_KEY), "false");
    assert.equal(storage.get(CONTEXT_WINDOW_USAGE_KEY), "true");
    assert.equal(storage.get(FOLLOW_UP_BEHAVIOR_KEY), "steer");
    assert.equal(readFileOpenInNewTab(), false);
    assert.equal(readFileLineWrap(), false);
    assert.equal(readContextWindowUsage(), true);
    assert.equal(readFollowUpBehavior(), "steer");
  });

  test("corrupted values fall back to the defaults, never throw", () => {
    storage.set(FILE_OPEN_IN_NEW_TAB_KEY, "yes please");
    storage.set(FILE_LINE_WRAP_KEY, "");
    storage.set(CONTEXT_WINDOW_USAGE_KEY, "1");
    storage.set(FOLLOW_UP_BEHAVIOR_KEY, "turbo");
    assert.equal(readFileOpenInNewTab(), false, "non-'true' string reads as false");
    assert.equal(readFileLineWrap(), false);
    assert.equal(readContextWindowUsage(), false);
    assert.equal(readFollowUpBehavior(), "queue", "unknown behaviour reads as queue");
  });
});

describe("consumer wiring (static-source pins)", () => {
  test("code-view applies the wrap class from readFileLineWrap()", () => {
    assert.ok(
      codeViewSource.includes('file-preview-codeblock-pre m-0${lineWrap ? " file-preview-codeblock-wrap" : ""}'),
      "the <pre> must conditionally carry the wrap modifier",
    );
    assert.ok(
      codeViewSource.includes("useState(() => readFileLineWrap())"),
      "the preference is read once per mount",
    );
  });

  test("page.tsx openFileTab replaces the active file tab when the switch is off", () => {
    assert.ok(
      pageSource.includes("!readFileOpenInNewTab()"),
      "the reuse branch reads the file_open_in_new_tab switch",
    );
    assert.ok(
      pageSource.includes("tab.id === active.id ? replacement : tab"),
      "the active file tab is replaced in place rather than appended",
    );
  });

  test("the General page writes every switch through settings-local", () => {
    for (const fn of [
      "writeFileOpenInNewTab",
      "writeFileLineWrap",
      "writeContextWindowUsage",
      "writeFollowUpBehavior",
    ]) {
      assert.ok(panelsSource.includes(`${fn}(`), `${fn} must be called from the settings rows`);
    }
  });
});
