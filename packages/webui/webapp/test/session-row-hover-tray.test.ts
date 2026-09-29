// webapp/test/session-row-hover-tray.test.ts
//
// Hit-area regression for the session row's hover action tray
// (webui-parity ticket 63, defect ② / D5).
//
// Why this test exists: the tray is a 90px absolutely-positioned, z-raised
// overlay sitting inside a ~197px row, so while it was shown it took every
// click in the row's right half. A click meant to open the session landed on
// the export link (an authorization modal for a download the user never
// asked for), on rename, or on delete — and delete really did delete the
// session (server audit seq 72534-72539). "F5 fixes it" was the tell: with
// the mouse off the row the tray is `display:none`, so the click landed
// back on the row itself.
//
// The fix is pure CSS hit-testing (`pointer-events-none` on the tray,
// `pointer-events-auto` on each of the three controls), so the tripwire is
// structural: this suite has no DOM render harness (no jsdom by policy) and
// the browser-level proof is an acceptance-time `elementFromPoint` check.
//
// Mutation tripwires (each of these must turn this suite red):
//   - drop `pointer-events-none` from the tray container;
//   - drop `pointer-events-auto` from the export `<a>`;
//   - drop `className="pointer-events-auto"` from either RowAction.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const treeSource = readFileSync(resolve(here, "../components/session-tree.tsx"), "utf8");

// The tray block, delimited by anchors that exist independently of the fix:
// the `renaming ? null : (` guard and the start of SubagentRow.
const trayStart = treeSource.indexOf("{renaming ? null : (");
const trayEnd = treeSource.indexOf("function SubagentRow");
assert.ok(trayStart >= 0 && trayEnd > trayStart, "session row tray block must be locatable");
const tray = treeSource.slice(trayStart, trayEnd);

/** The opening tag of the first element in `source` whose tag name is `name`. */
function openingTag(source: string, name: string, from = 0): string {
  const start = source.indexOf(`<${name}`, from);
  assert.ok(start >= 0, `<${name}> must exist in the tray`);
  const end = source.indexOf(">", start);
  assert.ok(end > start, `<${name}> opening tag must be terminated`);
  return source.slice(start, end + 1);
}

describe("session row hover tray hit area (webui-parity 63)", () => {
  test("the tray container does not take pointer events", () => {
    // The FIRST div of the block is the absolutely-positioned wrapper; the
    // one after it is the hidden/flex tray itself. The wrapper is what spans
    // the row, so it is the one that must be transparent to the pointer.
    const wrapper = openingTag(tray, "div");
    assert.match(wrapper, /absolute/);
    assert.match(
      wrapper,
      /pointer-events-none/,
      "the hover tray must be pointer-events-none or it eats the row's own clicks",
    );
  });

  test("each of the three controls switches pointer events back on", () => {
    const exportLink = openingTag(tray, "a");
    assert.match(
      exportLink,
      /pointer-events-auto/,
      "the export link must stay clickable inside a pointer-events-none tray",
    );
    // The rename and delete controls are RowAction instances, identified by
    // their labels rather than by position so the assertions survive a
    // reorder of the tray.
    for (const label of ["sidebar.rename", "sidebar.delete"] as const) {
      const tag = openingTag(tray, "RowAction", tray.indexOf(`label={t("${label}")}`) - 200);
      assert.match(
        tag,
        /label=\{t\("sidebar\.(rename|delete)"\)\}/,
        `expected the ${label} RowAction tag`,
      );
      assert.match(
        tag,
        /className="pointer-events-auto"/,
        `the ${label} control must be pointer-events-auto`,
      );
    }
  });

  test("export keeps its native download semantics", () => {
    // Guards the tempting wrong fix: replacing the anchor with a JS
    // download handler (or an onClick that preventDefaults) would silence the
    // mis-click but break save-as / copy-link and add a blob fetch.
    const exportLink = openingTag(tray, "a");
    assert.match(exportLink, /href=\{api\.sessionExportUrl\(session\.id\)\}/);
    assert.match(exportLink, /\bdownload\b/);
    assert.ok(
      !/onClick/.test(exportLink) && !/preventDefault/.test(exportLink),
      "the export link must stay a plain native download anchor",
    );
  });

  test("RowAction forwards className so a pointer-events-none tray can opt in", () => {
    // Without the opt-in the two RowAction buttons would silently inherit
    // `pointer-events: none` and stop working — the failure mode that a
    // "just add pointer-events-none" patch ships.
    const component = treeSource.slice(
      treeSource.indexOf("function RowAction"),
      treeSource.indexOf("function ProjectNode"),
    );
    assert.match(component, /className\?: string;/);
    assert.match(component, /className=\{className \? `\$\{cls\} \$\{className\}` : cls\}/);
  });
});
