// webapp/test/workspace-picker-paths.test.ts
//
// Pure-logic regression pin for the workspace picker's surface after
// basic-features/03 (cross-platform path expansion + remove native
// picker). The webapp test suite has no jsdom / RTL so a real render
// smoke test is out of scope; what we can do is scan the source for
// the surface contracts the ticket pins.
//
// What this file asserts:
//   1. The native picker button is gone from the WorkspaceBrowseTab
//      (data-testid="workspace-picker-native" must not exist).
//   2. The api.ts `pickWorkspaceNative` wrapper is gone (the user
//      has no entry point that could call it).
//   3. The browse error UI gains an `errorRoots` slot to surface the
//      allowed roots on containment rejection.
//   4. The wire-shape BrowseResult interface stays aligned with the
//      server's expanded error payload (already true on main; pinned
//      so a future rename is caught here).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

describe("native picker removal", () => {
  test("WorkspaceBrowseTab does not render data-testid=workspace-picker-native", () => {
    const panels = readFileSync(join(ROOT, "components/panels.tsx"), "utf8");
    // Pin on the WorkspaceBrowseTab function body so the assertion
    // does not pass merely because the same testid lives in another
    // (now-removed) surface.
    const start = panels.indexOf("function WorkspaceBrowseTab");
    assert.ok(start > -1, "WorkspaceBrowseTab located");
    const body = panels.slice(start);
    assert.doesNotMatch(
      body,
      /data-testid="workspace-picker-native"/,
      "WorkspaceBrowseTab must not render the native picker button",
    );
  });

  test("lib/api.ts no longer exports pickWorkspaceNative", () => {
    const api = readFileSync(join(ROOT, "lib/api.ts"), "utf8");
    assert.doesNotMatch(
      api,
      /pickWorkspaceNative/,
      "pickWorkspaceNative wrapper is gone — the route is removed and the UI no longer calls it",
    );
  });

  test("i18n drops the native picker keys (en + zh)", () => {
    const i18n = readFileSync(join(ROOT, "lib/i18n.ts"), "utf8");
    assert.doesNotMatch(
      i18n,
      /workspace\.picker\.native/,
      "i18n must not carry 'workspace.picker.native' (UI gone, key would be dead)",
    );
  });
});

describe("error payload — mustBeUnder UI", () => {
  test("BrowseTab renders `workspace-picker-error-roots` when the error carries roots", () => {
    const panels = readFileSync(join(ROOT, "components/panels.tsx"), "utf8");
    assert.match(
      panels,
      /data-testid="workspace-picker-error-roots"/,
      "WorkspaceBrowseTab surfaces the server's allowed-roots payload under a stable testid",
    );
  });

  test("i18n adds the 'mustBeUnder' key in both locales", () => {
    const i18n = readFileSync(join(ROOT, "lib/i18n.ts"), "utf8");
    assert.match(
      i18n,
      /"workspace\.picker\.mustBeUnder": "Path must be under:"/,
      "English 'mustBeUnder' present",
    );
    assert.match(
      i18n,
      /"workspace\.picker\.mustBeUnder": "路径必须在以下位置之一："/,
      "Chinese 'mustBeUnder' present",
    );
  });
});

describe("BrowseResult wire — server emits roots on containment error", () => {
  test("BrowseResult declares roots (success view) and the picker reads it from api.ts", () => {
    const api = readFileSync(join(ROOT, "lib/api.ts"), "utf8");
    const shape = api.match(/export interface BrowseResult\s*\{([\s\S]*?)\n\}/);
    assert.ok(shape, "BrowseResult interface present");
    const body = shape![1] as string;
    assert.match(
      body,
      /\broots\?:\s*string\[\]/,
      "BrowseResult declares roots? (server side carries the same field on both success and error)",
    );
  });
});