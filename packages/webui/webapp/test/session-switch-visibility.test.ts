// webapp/test/session-switch-visibility.test.ts
//
// A session switch that lands somewhere else must be visible
// (webui-parity ticket 63, defect E).
//
// Why this test exists: `runAction` only reports a request that came back
// rejected. The failure the smoke run recorded (ticket 62, D5) produced no
// rejected request at all — the row the user clicked, the URL and the engine's
// active session disagreed, and the UI showed nothing, so a click that did
// nothing looked exactly like a click that worked. The switch response names
// the session the engine activated; comparing it is the only evidence
// available, and it has to be checked without becoming noise on every normal
// switch.
//
// The decision is a pure function, so it is tested directly; the two call
// sites are a static tripwire (this suite has no DOM render harness).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { classifySwitchLanding } from "../lib/session-switch";
import { translate, type MessageKey } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const treeSource = readFileSync(resolve(here, "../components/session-tree.tsx"), "utf8");
const apiSource = readFileSync(resolve(here, "../lib/api.ts"), "utf8");

const UUID_ROW = "0f0a1b2c-3d4e-4f50-8a9b-0c1d2e3f4a5b";
const MVS = "mvs_139af0c1d2e3f4a5b6c7d8e9f0a1b2c3";

describe("classifySwitchLanding", () => {
  const cases: Array<{
    label: string;
    landed: Parameters<typeof classifySwitchLanding>[0];
    requested: string;
    expected: ReturnType<typeof classifySwitchLanding>;
  }> = [
    // The ordinary switch: the engine activated the row that was clicked.
    { label: "webui id matches the row", landed: { id: UUID_ROW, mcodeSessionId: MVS }, requested: UUID_ROW, expected: "landed" },
    // First-touch overlay: the tree addresses it by the engine id while the
    // landed record keeps its own identity. Reporting this would be a lie.
    { label: "engine id matches the row", landed: { id: MVS, mcodeSessionId: MVS }, requested: MVS, expected: "landed" },
    { label: "legacy uuid record addressed by its engine id", landed: { id: UUID_ROW, mcodeSessionId: MVS }, requested: MVS, expected: "landed" },
    { label: "record without an engine binding", landed: { id: UUID_ROW, mcodeSessionId: null }, requested: UUID_ROW, expected: "landed" },
    // The defect: the engine is somewhere else entirely.
    { label: "another session entirely", landed: { id: "other", mcodeSessionId: "mvs_other" }, requested: UUID_ROW, expected: "mismatch" },
    { label: "unbound record on another id", landed: { id: "other", mcodeSessionId: null }, requested: UUID_ROW, expected: "mismatch" },
    // No evidence either way — must stay silent, not cry wolf.
    { label: "no session payload", landed: undefined, requested: UUID_ROW, expected: "unknown" },
    { label: "null session payload", landed: null, requested: UUID_ROW, expected: "unknown" },
    { label: "empty identities only", landed: { id: "", mcodeSessionId: null }, requested: UUID_ROW, expected: "unknown" },
  ];

  for (const item of cases) {
    test(item.label, () => {
      assert.equal(classifySwitchLanding(item.landed, item.requested), item.expected);
    });
  }

  test("an empty requested id never matches a landed session", () => {
    // Defensive: a blank row id would otherwise report "landed" against any
    // response that happened to carry an empty field.
    assert.equal(classifySwitchLanding({ id: "s1" }, ""), "mismatch");
    assert.equal(classifySwitchLanding({ id: "", mcodeSessionId: "" }, ""), "unknown");
  });
});

describe("session switch wiring (webui-parity 63)", () => {
  test("both session rows go through the landing check", () => {
    const calls = treeSource.match(/openSessionAndReportLanding\(session\.id, onChanged, t\);/g) ?? [];
    assert.equal(calls.length, 2, "main session row and subagent row");
    // The pre-fix shape reported only on rejection — that promise is gone.
    assert.ok(
      !/runAction\(t\("sidebar\.openSession"\)/.test(treeSource),
      "no row may keep the reject-only switch",
    );
  });

  test("only a proven mismatch raises the notice", () => {
    const helper = treeSource.slice(
      treeSource.indexOf("function openSessionAndReportLanding"),
      treeSource.indexOf("function SectionHeader"),
    );
    assert.match(helper, /classifySwitchLanding\(res\.session, sessionId\) === "mismatch"/);
    assert.match(helper, /reportActionError\(label, t\("sidebar\.switchMismatch"\)\)/);
    // A rejected request still reports, through the same label.
    assert.match(helper, /\.catch\(\(cause\) => reportActionError\(label, cause\)\)/);
    // The tree still refreshes afterwards, as before the fix.
    assert.match(helper, /\.then\(onChanged\)/);
  });

  test("the switch response carries the landed session", () => {
    const decl = apiSource.slice(
      apiSource.indexOf("export const switchSession"),
      apiSource.indexOf("export const deleteSession"),
    );
    assert.match(decl, /session\?: \{ id: string; mcodeSessionId: string \| null; title: string \}/);
  });

  test("both locales carry the mismatch reason", () => {
    const key: MessageKey = "sidebar.switchMismatch";
    for (const locale of ["zh", "en"] as const) {
      const text = translate(locale, key);
      assert.ok(text.length > 0, `sidebar.switchMismatch must exist in ${locale}`);
      assert.notEqual(text, key, `${locale} must not fall back to the raw key`);
    }
    assert.notEqual(translate("zh", key), translate("en", key));
  });
});
