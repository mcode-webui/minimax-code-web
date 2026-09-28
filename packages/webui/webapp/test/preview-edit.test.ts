// webapp/test/preview-edit.test.ts
//
// Unit tests for the preview-edit decision helpers (slice 27).
// The toolbar's edit affordance is a pure predicate over (kind, path):
//
//   - WHICH previews may flip into an editor: text kinds only — the
//     markdown and code renderers. Images / unsupported / error states
//     never offer editing (there is no honest text round-trip).
//   - WHICH paths need the credential confirmation step before the
//     editor opens: exactly the slice-16 credential shapes, so a
//     LAN-reachable webui cannot quietly turn a random peer into the
//     author of `.env`. The SERVER re-checks on save; this predicate
//     only decides whether the UI asks first.
//
// Plus the save-clock formatter for the "已保存 HH:MM" affordance.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { canEditPreview, editRequiresCredentialConfirm, formatSaveClock } from "../lib/preview-edit";
import type { PreviewKind } from "../lib/file-preview";

describe("canEditPreview — which preview kinds offer the editor", () => {
  test("text kinds (markdown, code) are editable", () => {
    assert.equal(canEditPreview("markdown"), true);
    assert.equal(canEditPreview("code"), true);
  });

  test("image and unsupported are not editable", () => {
    assert.equal(canEditPreview("image"), false);
    assert.equal(canEditPreview("unsupported"), false);
  });

  test("no payload yet (null) is not editable", () => {
    assert.equal(canEditPreview(null), false);
  });

  test("the mapping is total over PreviewKind (a new kind must decide)", () => {
    const kinds: Array<PreviewKind | null> = ["markdown", "image", "code", "unsupported", null];
    for (const kind of kinds) {
      assert.equal(typeof canEditPreview(kind), "boolean");
    }
  });
});

describe("editRequiresCredentialConfirm — the write-side credential gate", () => {
  test("credential shapes require the explicit confirm step", () => {
    for (const p of ["/w/.env", "/w/.env.local", "/w/id_rsa", "/w/server.pem", "/w/credentials.json"]) {
      assert.equal(editRequiresCredentialConfirm(p), true, p);
    }
  });

  test("ordinary files do not", () => {
    for (const p of ["/w/README.md", "/w/src/index.ts", "/w/notes.txt.bak", "/w/environment.ts"]) {
      assert.equal(editRequiresCredentialConfirm(p), false, p);
    }
  });
});

describe("formatSaveClock — the 已保存 HH:MM stamp", () => {
  test("zero-pads hours and minutes", () => {
    assert.equal(formatSaveClock(new Date(2026, 8, 28, 7, 5)), "07:05");
  });

  test("two-digit hours pass through", () => {
    assert.equal(formatSaveClock(new Date(2026, 8, 28, 14, 59)), "14:59");
  });
});
