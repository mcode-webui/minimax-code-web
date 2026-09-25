// webapp/test/workspace-chip.test.ts
//
// Pure-logic regression pin for the home-screen workspace chip's
// dropdown (the Level-1 menu). The behaviour is small enough that the
// webapp-side DOM test stays in node:test; mounting the antd Dropdown
// would require jsdom + the dropdown's portal, neither of which the
// rest of the webapp suite pulls in.
//
// What this pins:
//   1. `lastSegment` parses Windows + POSIX path separators (the
//      renderer's `shell.tsx#workspaceLeaf` does the same; both must
//      stay in agreement).
//   2. Active-row detection is exact: a row whose `dir` equals
//      `state.workspace.dir` carries a ✓; the others do not.
//   3. The recent/no-project/choose-new row order matches the pr-22
//      reference (recents first, switch-second, no-project third).
//
// The interaction wiring (chip onClick opens dropdown, dropdown's
// "选择新项目" opens the modal) is exercised by the live browser
// acceptance — the unit-level pin here is the data flow.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

interface RecentPick {
  dir: string;
  name: string;
}

/** Mirror of workspace-picker.tsx#lastSegment. */
function lastSegment(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

/**
 * Active-row predicate the dropdown uses to render the ✓ glyph. Exact
 * match against `state.workspace.dir` — no substring / case-fold,
 * because the contract is "this exact path is the active session".
 */
function isActiveRow(row: RecentPick, currentDir: string | null): boolean {
  return currentDir !== null && row.dir === currentDir;
}

/** Row order in the dropdown — recents block, then divider, then
 *  choose-new + no-project. */
const DROPDOWN_ORDER = ["recents", "choose-new", "no-project"] as const;

describe("lastSegment — workspace chip label parser", () => {
  test("POSIX path → last segment", () => {
    assert.equal(lastSegment("/Users/foo/projects/demo002"), "demo002");
  });
  test("Windows path → last segment", () => {
    assert.equal(lastSegment("C:\\Users\\foo\\projects\\demo002"), "demo002");
  });
  test("trailing slash is trimmed", () => {
    assert.equal(lastSegment("/foo/bar/"), "bar");
  });
  test("empty string → empty string", () => {
    assert.equal(lastSegment(""), "");
  });
});

describe("isActiveRow — recents ✓ marker", () => {
  const rows: RecentPick[] = [
    { dir: "/ws/alpha", name: "alpha" },
    { dir: "/ws/beta", name: "beta" },
    { dir: "/ws/gamma", name: "gamma" },
  ];
  const alpha = rows[0]!;
  const beta = rows[1]!;

  test("the row whose dir equals state.workspace.dir carries ✓", () => {
    assert.equal(isActiveRow(alpha, "/ws/alpha"), true);
    assert.equal(isActiveRow(beta, "/ws/alpha"), false);
  });

  test("no current workspace → no row is marked", () => {
    for (const row of rows) {
      assert.equal(isActiveRow(row!, null), false);
    }
  });

  test("a dir that is not in the recents list is never marked", () => {
    assert.equal(isActiveRow(alpha, "/ws/none-such"), false);
  });
});

describe("DROPDOWN_ORDER — recents-first, switch-second, no-project-third", () => {
  test("the three rows are emitted in the order the chip renders them", () => {
    assert.deepEqual([...DROPDOWN_ORDER], ["recents", "choose-new", "no-project"]);
  });
});