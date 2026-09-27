// webapp/test/workspace-tabs-state.test.ts
//
// Pure-logic pins for the slice-15 workspace-tabs state model.
//
// Every reducer in `lib/workspace-tabs-state.ts` is exercised
// end-to-end here: open / close / activate / reorder / scroll /
// column-resize / column-reset / column-fold / serialize /
// deserialize. The state is plain objects, so a Node `node:test`
// runner covers everything without a render harness.
//
// The persistence round-trip test pins that the wire format
// survives a refresh: opening a few tabs + scrolling a file tab +
// resizing columns, serializing, deserializing into a fresh state
// must produce the same in-memory shape.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  activateTab,
  basename,
  clampWidth,
  closeTab,
  COLUMN_SPECS,
  computeColumnLayout,
  DEFAULT_COLUMN_LAYOUT,
  DEFAULT_TAB_STRIP,
  DEFAULT_WORKSPACE_TABS_STATE,
  deserializeWorkspaceTabs,
  fileTabFromPath,
  isSurfaceTabKind,
  moveTab,
  openTab,
  recordFileTabScroll,
  resetAllColumnWidths,
  resetColumnWidth,
  resetTabs,
  serializeWorkspaceTabs,
  setColumnCollapsed,
  setColumnWidth,
  setLauncherOpen,
  setSecondaryOpen,
  surfaceTab,
  WORKSPACE_TABS_VERSION,
} from "../lib/workspace-tabs-state";
import type { TabStripState, WorkspaceTabsState } from "../lib/workspace-tabs-state";

const cid = "test-cid-15";

describe("basename", () => {
  test("returns the trailing path segment", () => {
    assert.equal(basename("/repo/foo/bar.txt"), "bar.txt");
    assert.equal(basename("bar.txt"), "bar.txt");
    assert.equal(basename(""), "");
  });

  test("strips a single trailing slash before segmenting", () => {
    assert.equal(basename("/repo/foo/"), "foo");
  });
});

describe("isSurfaceTabKind", () => {
  test("accepts the four surface kinds", () => {
    assert.equal(isSurfaceTabKind("files"), true);
    assert.equal(isSurfaceTabKind("git"), true);
    assert.equal(isSurfaceTabKind("browser"), true);
    assert.equal(isSurfaceTabKind("tasks"), true);
  });

  test("rejects the launcher-only kinds and arbitrary strings", () => {
    assert.equal(isSurfaceTabKind("btw"), false);
    assert.equal(isSurfaceTabKind("terminal"), false);
    assert.equal(isSurfaceTabKind("made-up"), false);
    assert.equal(isSurfaceTabKind(null), false);
    assert.equal(isSurfaceTabKind(42), false);
  });
});

describe("surfaceTab / fileTabFromPath", () => {
  test("surface tabs have id == kind", () => {
    const tab = surfaceTab("files");
    assert.equal(tab.id, "files");
    assert.equal(tab.kind, "files");
  });

  test("file tabs carry the path + a default scroll position", () => {
    const tab = fileTabFromPath("/repo/foo.md");
    assert.equal(tab.id, "file:/repo/foo.md");
    assert.equal(tab.kind, "file");
    if (tab.kind !== "file") throw new Error("expected file tab");
    assert.equal(tab.path, "/repo/foo.md");
    assert.equal(tab.scrollTop, 0);
    assert.equal(tab.name, "foo.md");
  });

  test("file tabs honour an explicit scroll position", () => {
    const tab = fileTabFromPath("/repo/foo.md", 240);
    if (tab.kind !== "file") throw new Error("expected file tab");
    assert.equal(tab.scrollTop, 240);
  });
});

describe("openTab", () => {
  test("appends a new tab and makes it active", () => {
    const initial: TabStripState = { ...DEFAULT_TAB_STRIP };
    const next = openTab(initial, surfaceTab("files"));
    assert.equal(next.tabs.length, 1);
    assert.equal(next.tabs[0]!.kind, "files");
    assert.equal(next.activeId, "files");
    assert.equal(next.launcherOpen, false);
  });

  test("re-opening the same surface kind moves it to the end and activates it", () => {
    const first: TabStripState = openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("git")), surfaceTab("files"));
    const reordered = openTab(first, surfaceTab("git"));
    assert.equal(reordered.tabs.length, 2);
    assert.equal(reordered.tabs[0]!.kind, "files");
    assert.equal(reordered.tabs[1]!.kind, "git");
    assert.equal(reordered.activeId, "git");
  });

  test("re-opening a file tab by the same path is idempotent (no duplicate)", () => {
    const first = openTab({ ...DEFAULT_TAB_STRIP }, fileTabFromPath("/repo/a.md"));
    const second = openTab(first, fileTabFromPath("/repo/b.md"));
    const third = openTab(second, fileTabFromPath("/repo/a.md"));
    assert.equal(third.tabs.length, 2);
    assert.equal(third.activeId, "file:/repo/a.md");
  });

  test("closes the launcher popover when an open succeeds", () => {
    const open: TabStripState = { ...DEFAULT_TAB_STRIP, launcherOpen: true };
    const next = openTab(open, surfaceTab("files"));
    assert.equal(next.launcherOpen, false);
  });
});

describe("closeTab", () => {
  test("removes the matching tab", () => {
    const state = openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files")), surfaceTab("git"));
    const next = closeTab(state, "files");
    assert.equal(next.tabs.length, 1);
    assert.equal(next.tabs[0]!.kind, "git");
  });

  test("promotes a neighbour when the active tab is closed", () => {
    const state = openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files")), surfaceTab("git"));
    const next = closeTab(state, "files");
    assert.equal(next.activeId, "git");
  });

  test("promotes the previous tab when closing the rightmost", () => {
    const state = openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files")), surfaceTab("git"));
    const next = closeTab(state, "git");
    assert.equal(next.activeId, "files");
  });

  test("clears activeId when the last tab closes", () => {
    const state = openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files"));
    const next = closeTab(state, "files");
    assert.equal(next.tabs.length, 0);
    assert.equal(next.activeId, null);
  });

  test("is a no-op for unknown ids", () => {
    const state = openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files"));
    const next = closeTab(state, "made-up");
    assert.deepEqual(next, state);
  });
});

describe("activateTab", () => {
  test("sets the active id and ignores unknown ids", () => {
    // Start with files as the only tab (so the active id is
    // "files"); then activate git — but first git must be open
    // for the activate to be a no-op rather than a no-match.
    const onlyFiles = openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files"));
    const next = activateTab(onlyFiles, "made-up");
    assert.equal(next.activeId, "files");
    const withGit = openTab(onlyFiles, surfaceTab("git"));
    const activateGit = activateTab(withGit, "git");
    assert.equal(activateGit.activeId, "git");
  });

  test("no-op when the active id already matches", () => {
    const state = openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files"));
    const next = activateTab(state, "files");
    assert.equal(next, state);
  });
});

describe("moveTab", () => {
  test("moves a tab to a new position", () => {
    const state = openTab(
      openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files")), surfaceTab("git")),
      surfaceTab("browser"),
    );
    const next = moveTab(state, 0, 2);
    assert.equal(next.tabs[0]!.kind, "git");
    assert.equal(next.tabs[1]!.kind, "browser");
    assert.equal(next.tabs[2]!.kind, "files");
  });

  test("is a no-op when from === to or out-of-range indices", () => {
    const state = openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files")), surfaceTab("git"));
    assert.equal(moveTab(state, 0, 0), state);
    assert.equal(moveTab(state, 5, 0), state);
    assert.equal(moveTab(state, 0, 99), state);
  });
});

describe("recordFileTabScroll", () => {
  test("records the scroll position of an existing file tab", () => {
    const state = openTab({ ...DEFAULT_TAB_STRIP }, fileTabFromPath("/repo/a.md"));
    const next = recordFileTabScroll(state, "file:/repo/a.md", 240);
    const first = next.tabs[0]!;
    assert.equal(first.kind, "file");
    if (first.kind === "file") {
      assert.equal(first.scrollTop, 240);
    }
  });

  test("is a no-op for surface tabs (scroll lives on file tabs only)", () => {
    const state = openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files"));
    const next = recordFileTabScroll(state, "files", 240);
    assert.deepEqual(next, state);
  });

  test("is a no-op when the scroll position is unchanged", () => {
    const state = openTab({ ...DEFAULT_TAB_STRIP }, fileTabFromPath("/repo/a.md", 240));
    const next = recordFileTabScroll(state, "file:/repo/a.md", 240);
    assert.equal(next, state);
  });
});

describe("setLauncherOpen / resetTabs", () => {
  test("setLauncherOpen toggles the flag", () => {
    assert.equal(setLauncherOpen(DEFAULT_TAB_STRIP, true).launcherOpen, true);
    assert.equal(setLauncherOpen({ ...DEFAULT_TAB_STRIP, launcherOpen: true }, false).launcherOpen, false);
  });

  test("resetTabs drops every tab and clears activeId", () => {
    const state = openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files")), surfaceTab("git"));
    const next = resetTabs();
    assert.equal(next.tabs.length, 0);
    assert.equal(next.activeId, null);
  });
});

describe("clampWidth", () => {
  test("clamps below the minimum", () => {
    assert.equal(clampWidth("panel", 100), COLUMN_SPECS.panel.minWidth);
  });
  test("clamps above the maximum", () => {
    assert.equal(clampWidth("panel", 9999), COLUMN_SPECS.panel.maxWidth);
  });
  test("rounds non-integer inputs", () => {
    assert.equal(clampWidth("panel", 333.7), 334);
  });
  test("falls back to default on non-finite input", () => {
    assert.equal(clampWidth("panel", Number.NaN), COLUMN_SPECS.panel.defaultWidth);
  });
});

describe("setColumnWidth / resetColumnWidth / resetAllColumnWidths", () => {
  test("setColumnWidth clamps and records", () => {
    const state = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "panel", 9999);
    assert.equal(state.widths.panel, COLUMN_SPECS.panel.maxWidth);
  });

  test("setColumnWidth is a no-op when the new clamped value matches", () => {
    const once = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "panel", 400);
    const twice = setColumnWidth(once, "panel", 400);
    assert.equal(once, twice);
  });

  test("resetColumnWidth restores the column's default", () => {
    const once = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "panel", 999);
    const reset = resetColumnWidth(once, "panel");
    assert.equal(reset.widths.panel, COLUMN_SPECS.panel.defaultWidth);
  });

  test("resetAllColumnWidths restores every column to its default", () => {
    const tweaked = setColumnWidth(setColumnWidth(DEFAULT_COLUMN_LAYOUT, "panel", 999), "secondary", 100);
    const reset = resetAllColumnWidths(tweaked);
    assert.equal(reset.widths.panel, COLUMN_SPECS.panel.defaultWidth);
    assert.equal(reset.widths.secondary, COLUMN_SPECS.secondary.defaultWidth);
  });
});

describe("setColumnCollapsed / setSecondaryOpen", () => {
  test("setColumnCollapsed toggles the matching flag", () => {
    const once = setColumnCollapsed(DEFAULT_COLUMN_LAYOUT, "panel", true);
    assert.equal(once.collapsed.panel, true);
    const twice = setColumnCollapsed(once, "panel", false);
    assert.equal(twice.collapsed.panel, false);
  });

  test("setSecondaryOpen toggles the secondary flag", () => {
    const once = setSecondaryOpen(DEFAULT_COLUMN_LAYOUT, true);
    assert.equal(once.secondaryOpen, true);
    const twice = setSecondaryOpen(once, false);
    assert.equal(twice.secondaryOpen, false);
  });
});

describe("computeColumnLayout", () => {
  test("hides the secondary column when secondaryOpen=false", () => {
    const layout = setColumnCollapsed(DEFAULT_COLUMN_LAYOUT, "panel", false);
    const summary = computeColumnLayout(layout, 1600, 1600);
    const visibleIds = summary.segments.filter((s) => s.visible).map((s) => s.id);
    assert.deepEqual(visibleIds, ["sidebar", "conversation", "panel"]);
  });

  test("shows the secondary column when secondaryOpen=true", () => {
    let layout = setColumnCollapsed(DEFAULT_COLUMN_LAYOUT, "panel", false);
    layout = setSecondaryOpen(layout, true);
    const summary = computeColumnLayout(layout, 2400, 2400);
    const visibleIds = summary.segments.filter((s) => s.visible).map((s) => s.id);
    assert.deepEqual(visibleIds, ["sidebar", "conversation", "panel", "secondary"]);
  });

  test("clamps each column to its [min, max] bounds", () => {
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      widths: {
        sidebar: 9999,
        conversation: 9999,
        panel: 9999,
        secondary: 9999,
      },
      collapsed: {
        sidebar: false,
        conversation: false,
        panel: false,
        secondary: false,
      },
      secondaryOpen: true,
    };
    const summary = computeColumnLayout(layout, 4000, 4000);
    for (const segment of summary.segments) {
      if (!segment.visible) continue;
      const spec = COLUMN_SPECS[segment.id];
      assert.ok(segment.width >= spec.minWidth, `${segment.id} ${segment.width} < ${spec.minWidth}`);
      assert.ok(segment.width <= spec.maxWidth, `${segment.id} ${segment.width} > ${spec.maxWidth}`);
    }
  });

  test("zero-width segments are marked invisible", () => {
    const layout = setColumnCollapsed(DEFAULT_COLUMN_LAYOUT, "panel", true);
    const summary = computeColumnLayout(layout, 1600, 1600);
    const panel = summary.segments.find((s) => s.id === "panel");
    assert.ok(panel);
    assert.equal(panel.visible, false);
  });

  test("folds the secondary column when the row would overflow", () => {
    // Tight container + secondary open + large panel column = fold.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: {
        sidebar: false,
        conversation: false,
        panel: false,
        secondary: false,
      },
      widths: { ...DEFAULT_COLUMN_LAYOUT.widths, panel: 640, secondary: 640 },
      secondaryOpen: true,
    };
    const summary = computeColumnLayout(layout, 1100, 1100);
    assert.equal(summary.narrowed, true);
    // The fold priority for secondary-open layouts is secondary → sidebar.
    const secondary = summary.segments.find((s) => s.id === "secondary")!;
    assert.ok(secondary.width < 640);
  });

  test("never produces horizontal overflow", () => {
    // Worst case: every column at its maximum, container is small.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: {
        sidebar: false,
        conversation: false,
        panel: false,
        secondary: false,
      },
      widths: {
        sidebar: COLUMN_SPECS.sidebar.maxWidth,
        conversation: COLUMN_SPECS.conversation.maxWidth,
        panel: COLUMN_SPECS.panel.maxWidth,
        secondary: COLUMN_SPECS.secondary.maxWidth,
      },
      secondaryOpen: true,
    };
    // Provide a container big enough that the fold path actually
    // has somewhere to go. The fold priority (secondary → sidebar)
    // cannot fold the conversation + sidebar below their minimums,
    // so we test the property on a realistic container rather
    // than an impossibly small one.
    const summary = computeColumnLayout(layout, 2400, 2400);
    const totalVisibleWidth = summary.segments
      .filter((s) => s.visible)
      .reduce((sum, segment) => sum + segment.width, 0);
    assert.ok(totalVisibleWidth <= 2400, `total ${totalVisibleWidth} > 2400`);
  });

  test("drag-overshoot shrinks the conversation column (panel stays on-screen)", () => {
    // Pin the regression the acceptance run caught: a wide
    // conversation width against a tight container must not
    // push the panel column off-screen. With secondaryOpen=
    // false the fold priority is [sidebar, conversation], so
    // the conversation takes the residual fold first.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: {
        sidebar: false,
        conversation: false,
        panel: false,
        secondary: false,
      },
      widths: { ...DEFAULT_COLUMN_LAYOUT.widths, conversation: 1280 },
    };
    const summary = computeColumnLayout(layout, 1280, 1280);
    const totalVisibleWidth = summary.segments
      .filter((s) => s.visible)
      .reduce((sum, segment) => sum + segment.width, 0);
    assert.ok(totalVisibleWidth <= 1280, `total ${totalVisibleWidth} > 1280`);
    const panel = summary.segments.find((s) => s.id === "panel");
    assert.ok(panel);
    assert.ok(panel.width >= COLUMN_SPECS.panel.minWidth, `panel ${panel.width} < ${COLUMN_SPECS.panel.minWidth}`);
    // The conversation column absorbed the overflow.
    const conversation = summary.segments.find((s) => s.id === "conversation");
    assert.ok(conversation);
    assert.ok(conversation.width < 1280);
  });

  test("double-click reset brings the row back to its default within the container", () => {
    // The acceptance run reported "drag wider → reset does not
    // repair". The repair path is: the persisted widths revert
    // to the defaults, then computeColumnLayout folds any
    // residual overflow into the elastic columns. After the
    // fold the row fits inside the container.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: {
        sidebar: false,
        conversation: false,
        panel: false,
        secondary: false,
      },
      widths: {
        sidebar: COLUMN_SPECS.sidebar.defaultWidth,
        conversation: COLUMN_SPECS.conversation.defaultWidth,
        panel: COLUMN_SPECS.panel.defaultWidth,
        secondary: COLUMN_SPECS.secondary.defaultWidth,
      },
    };
    const summary = computeColumnLayout(layout, 1280, 1280);
    const totalVisibleWidth = summary.segments
      .filter((s) => s.visible)
      .reduce((sum, segment) => sum + segment.width, 0);
    assert.ok(totalVisibleWidth <= 1280, `total ${totalVisibleWidth} > 1280`);
  });
});

describe("serializeWorkspaceTabs / deserializeWorkspaceTabs", () => {
  test("round-trip preserves tabs, active id, file scrolls, and column widths", () => {
    const state: WorkspaceTabsState = {
      tabStrip: {
        tabs: [fileTabFromPath("/repo/a.md", 240), surfaceTab("git"), surfaceTab("files")],
        activeId: "git",
        launcherOpen: false,
      },
      columnLayout: {
        widths: { sidebar: 240, conversation: 720, panel: 360, secondary: 280 },
        collapsed: { sidebar: false, conversation: false, panel: false, secondary: false },
        secondaryOpen: true,
      },
    };
    const wire = serializeWorkspaceTabs(state, cid);
    assert.equal(wire.version, WORKSPACE_TABS_VERSION);
    assert.equal(wire.cid, cid);
    const restored = deserializeWorkspaceTabs(JSON.stringify(wire), cid);
    assert.deepEqual(restored.tabStrip.tabs, state.tabStrip.tabs);
    assert.equal(restored.tabStrip.activeId, "git");
    assert.equal(restored.columnLayout.widths.panel, 360);
    assert.equal(restored.columnLayout.secondaryOpen, true);
  });

  test("returns defaults on garbage / version-mismatch / cid-mismatch input", () => {
    for (const raw of [null, "", "{", "not json", "[]", JSON.stringify({})]) {
      const out = deserializeWorkspaceTabs(raw as string | null, cid);
      assert.deepEqual(out, DEFAULT_WORKSPACE_TABS_STATE);
    }
    const wrongVersion = JSON.stringify({
      version: WORKSPACE_TABS_VERSION + 9,
      cid,
      tabs: { tabs: [], activeId: null, fileScrolls: {} },
      layout: {},
    });
    assert.deepEqual(deserializeWorkspaceTabs(wrongVersion, cid), DEFAULT_WORKSPACE_TABS_STATE);
    const wrongCid = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid: "different-cid",
      tabs: { tabs: [], activeId: null, fileScrolls: {} },
      layout: {},
    });
    assert.deepEqual(deserializeWorkspaceTabs(wrongCid, cid), DEFAULT_WORKSPACE_TABS_STATE);
  });

  test("clamps column widths on deserialize so a corrupted payload cannot push past the max", () => {
    const corrupted = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: { tabs: [], activeId: null, fileScrolls: {} },
      layout: {
        widths: { sidebar: 9999, conversation: 9999, panel: 9999, secondary: 9999 },
        collapsed: {},
        secondaryOpen: true,
      },
    });
    const out = deserializeWorkspaceTabs(corrupted, cid);
    assert.ok(out.columnLayout.widths.panel <= COLUMN_SPECS.panel.maxWidth);
    assert.ok(out.columnLayout.widths.panel >= COLUMN_SPECS.panel.minWidth);
  });

  test("drops unknown tab ids so a future schema bump cannot crash the renderer", () => {
    const payload = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: {
        tabs: ["files", "made-up-tab", "git"],
        activeId: "made-up-tab",
        fileScrolls: {},
      },
      layout: {},
    });
    const out = deserializeWorkspaceTabs(payload, cid);
    assert.equal(out.tabStrip.tabs.length, 2);
    assert.equal(out.tabStrip.activeId, "git");
  });
});