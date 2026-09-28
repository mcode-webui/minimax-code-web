// webapp/test/workspace-tabs-state.test.ts
//
// Pure-logic pins for the slice-17 workspace-tabs state model.
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
//
// The forward-compat test pins that an OLD-format persistence
// payload (single `activeId`, columns named `panel`/`secondary`)
// reads without crashing and falls back to sensible defaults —
// a refresh after the slice-16 rollout must not white-screen a
// user.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  activateTab,
  basename,
  clampWidth,
  closeTab,
  COLUMN_SPECS,
  columnRoleForKind,
  computeColumnLayout,
  DEFAULT_COLUMN_LAYOUT,
  DEFAULT_TAB_STRIP,
  DEFAULT_WORKSPACE_TABS_STATE,
  deserializeWorkspaceTabs,
  fileTabFromPath,
  isPreviewSurface,
  isSurfaceTabKind,
  isTreeSurface,
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
  surfaceTab,
  WORKSPACE_TABS_VERSION,
} from "../lib/workspace-tabs-state";
import type { TabStripState, WorkspaceTabsState } from "../lib/workspace-tabs-state";

const cid = "test-cid-17";

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
  test("accepts the six surface kinds", () => {
    assert.equal(isSurfaceTabKind("files"), true);
    assert.equal(isSurfaceTabKind("git"), true);
    assert.equal(isSurfaceTabKind("browser"), true);
    assert.equal(isSurfaceTabKind("tasks"), true);
    // Slice 17 additions — restore the sidebar's legacy
    // 搜索 / 插件 entries to a visible landing surface.
    assert.equal(isSurfaceTabKind("search"), true);
    assert.equal(isSurfaceTabKind("plugins"), true);
  });

  test("rejects the launcher-only kinds and arbitrary strings", () => {
    assert.equal(isSurfaceTabKind("btw"), false);
    assert.equal(isSurfaceTabKind("terminal"), false);
    assert.equal(isSurfaceTabKind("progress"), false);
    assert.equal(isSurfaceTabKind("alerts"), false);
    assert.equal(isSurfaceTabKind("made-up"), false);
    assert.equal(isSurfaceTabKind(null), false);
    assert.equal(isSurfaceTabKind(42), false);
  });
});

describe("columnRoleForKind / isPreviewSurface / isTreeSurface", () => {
  test("browser and file tabs belong to the preview column", () => {
    assert.equal(columnRoleForKind("browser"), "preview");
    assert.equal(columnRoleForKind("file"), "preview");
    assert.equal(isPreviewSurface("browser"), true);
  });

  test("files, git, tasks, search, plugins belong to the tree column", () => {
    assert.equal(columnRoleForKind("files"), "tree");
    assert.equal(columnRoleForKind("git"), "tree");
    assert.equal(columnRoleForKind("tasks"), "tree");
    // Slice 17 additions — search and plugins are tree
    // surfaces (the column hosts navigation / listing
    // surfaces).
    assert.equal(columnRoleForKind("search"), "tree");
    assert.equal(columnRoleForKind("plugins"), "tree");
    assert.equal(isTreeSurface("files"), true);
    assert.equal(isTreeSurface("git"), true);
    assert.equal(isTreeSurface("tasks"), true);
    assert.equal(isTreeSurface("search"), true);
    assert.equal(isTreeSurface("plugins"), true);
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
  test("appends a new tab and makes it active in its column", () => {
    const initial: TabStripState = { ...DEFAULT_TAB_STRIP };
    const next = openTab(initial, surfaceTab("files"));
    assert.equal(next.tabs.length, 1);
    assert.equal(next.tabs[0]!.kind, "files");
    // Tree surfaces activate treeActiveId (not previewActiveId).
    assert.equal(next.treeActiveId, "files");
    assert.equal(next.previewActiveId, null);
    assert.equal(next.launcherOpen, false);
  });

  test("opening a browser tab activates the preview column only", () => {
    const initial: TabStripState = { ...DEFAULT_TAB_STRIP };
    const next = openTab(initial, surfaceTab("browser"));
    assert.equal(next.previewActiveId, "browser");
    assert.equal(next.treeActiveId, null);
  });

  test("opening a tree tab leaves the preview column untouched", () => {
    const initial: TabStripState = {
      ...DEFAULT_TAB_STRIP,
      previewActiveId: "file:/repo/a.md",
    };
    const next = openTab(initial, surfaceTab("git"));
    assert.equal(next.previewActiveId, "file:/repo/a.md");
    assert.equal(next.treeActiveId, "git");
  });

  test("re-opening the same surface kind moves it to the end and activates it", () => {
    const first: TabStripState = openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("git")), surfaceTab("files"));
    const reordered = openTab(first, surfaceTab("git"));
    assert.equal(reordered.tabs.length, 2);
    assert.equal(reordered.tabs[0]!.kind, "files");
    assert.equal(reordered.tabs[1]!.kind, "git");
    assert.equal(reordered.treeActiveId, "git");
  });

  test("re-opening a file tab by the same path is idempotent (no duplicate)", () => {
    const first = openTab({ ...DEFAULT_TAB_STRIP }, fileTabFromPath("/repo/a.md"));
    const second = openTab(first, fileTabFromPath("/repo/b.md"));
    const third = openTab(second, fileTabFromPath("/repo/a.md"));
    assert.equal(third.tabs.length, 2);
    assert.equal(third.previewActiveId, "file:/repo/a.md");
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

  test("promotes a neighbour in the SAME column when the active tab is closed", () => {
    const state = openTab(
      openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files")), surfaceTab("git")),
      surfaceTab("tasks"),
    );
    const next = closeTab(state, "git");
    // tasks is the next tree tab at the same index.
    assert.equal(next.treeActiveId, "tasks");
    assert.equal(next.previewActiveId, null);
  });

  test("promotes the previous tab in the same column when closing the rightmost", () => {
    const state = openTab(
      openTab(openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files")), surfaceTab("git")),
      surfaceTab("tasks"),
    );
    const next = closeTab(state, "tasks");
    assert.equal(next.treeActiveId, "git");
  });

  test("leaves the OTHER column's active id untouched when closing a tab in one column", () => {
    const state: TabStripState = {
      ...DEFAULT_TAB_STRIP,
      tabs: [fileTabFromPath("/repo/a.md"), surfaceTab("files")],
      previewActiveId: "file:/repo/a.md",
      treeActiveId: "files",
    };
    const next = closeTab(state, "file:/repo/a.md");
    assert.equal(next.previewActiveId, null);
    assert.equal(next.treeActiveId, "files");
  });

  test("clears the active id when the last tab in its column closes", () => {
    const state: TabStripState = {
      ...DEFAULT_TAB_STRIP,
      tabs: [surfaceTab("files")],
      treeActiveId: "files",
    };
    const next = closeTab(state, "files");
    assert.equal(next.tabs.length, 0);
    assert.equal(next.treeActiveId, null);
    assert.equal(next.previewActiveId, null);
  });

  test("is a no-op for unknown ids", () => {
    const state = openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files"));
    const next = closeTab(state, "made-up");
    assert.deepEqual(next, state);
  });
});

describe("activateTab", () => {
  test("sets the matching column's active id and ignores unknown ids", () => {
    const onlyFiles = openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("files"));
    const next = activateTab(onlyFiles, "made-up");
    assert.equal(next.treeActiveId, "files");
    const withGit = openTab(onlyFiles, surfaceTab("git"));
    const activateGit = activateTab(withGit, "git");
    assert.equal(activateGit.treeActiveId, "git");
  });

  test("activating a preview tab does not steal the tree column", () => {
    const state: TabStripState = {
      ...DEFAULT_TAB_STRIP,
      tabs: [surfaceTab("files"), surfaceTab("browser")],
      treeActiveId: "files",
      previewActiveId: null,
    };
    const next = activateTab(state, "browser");
    assert.equal(next.previewActiveId, "browser");
    assert.equal(next.treeActiveId, "files");
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
    assert.equal(next.previewActiveId, null);
    assert.equal(next.treeActiveId, null);
  });
});

describe("clampWidth", () => {
  test("clamps below the minimum", () => {
    assert.equal(clampWidth("preview", 100), COLUMN_SPECS.preview.minWidth);
  });
  test("clamps above the maximum", () => {
    assert.equal(clampWidth("preview", 9999), COLUMN_SPECS.preview.maxWidth);
  });
  test("rounds non-integer inputs", () => {
    assert.equal(clampWidth("preview", 333.7), 334);
  });
  test("falls back to default on non-finite input", () => {
    assert.equal(clampWidth("preview", Number.NaN), COLUMN_SPECS.preview.defaultWidth);
  });
});

describe("setColumnWidth / resetColumnWidth / resetAllColumnWidths", () => {
  test("setColumnWidth clamps and records", () => {
    const state = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "preview", 9999);
    assert.equal(state.widths.preview, COLUMN_SPECS.preview.maxWidth);
  });

  test("setColumnWidth is a no-op when the new clamped value matches", () => {
    const once = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "preview", 400);
    const twice = setColumnWidth(once, "preview", 400);
    assert.equal(once, twice);
  });

  test("resetColumnWidth restores the column's default", () => {
    const once = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "preview", 999);
    const reset = resetColumnWidth(once, "preview");
    assert.equal(reset.widths.preview, COLUMN_SPECS.preview.defaultWidth);
  });

  test("resetAllColumnWidths restores every column to its default", () => {
    const tweaked = setColumnWidth(setColumnWidth(DEFAULT_COLUMN_LAYOUT, "preview", 999), "tree", 100);
    const reset = resetAllColumnWidths(tweaked);
    assert.equal(reset.widths.preview, COLUMN_SPECS.preview.defaultWidth);
    assert.equal(reset.widths.tree, COLUMN_SPECS.tree.defaultWidth);
  });
});

describe("setColumnCollapsed", () => {
  test("setColumnCollapsed toggles the matching flag", () => {
    const once = setColumnCollapsed(DEFAULT_COLUMN_LAYOUT, "preview", true);
    assert.equal(once.collapsed.preview, true);
    const twice = setColumnCollapsed(once, "preview", false);
    assert.equal(twice.collapsed.preview, false);
  });

  test("does not touch the other columns' collapsed flags", () => {
    const once = setColumnCollapsed(DEFAULT_COLUMN_LAYOUT, "preview", true);
    assert.equal(once.collapsed.tree, DEFAULT_COLUMN_LAYOUT.collapsed.tree);
    assert.equal(once.collapsed.sidebar, DEFAULT_COLUMN_LAYOUT.collapsed.sidebar);
  });
});

describe("computeColumnLayout — column model", () => {
  test("the four columns appear in DOM order", () => {
    const summary = computeColumnLayout(DEFAULT_COLUMN_LAYOUT, 1600, 1600);
    assert.deepEqual(
      summary.segments.map((s) => s.id),
      ["sidebar", "conversation", "preview", "tree"],
    );
  });

  test("clamps each column to its [min, max] bounds", () => {
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      widths: {
        sidebar: 9999,
        conversation: 9999,
        preview: 9999,
        tree: 9999,
      },
      collapsed: {
        sidebar: false,
        conversation: false,
        preview: false,
        tree: false,
      },
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
    const layout = setColumnCollapsed(DEFAULT_COLUMN_LAYOUT, "preview", true);
    const summary = computeColumnLayout(layout, 1600, 1600);
    const preview = summary.segments.find((s) => s.id === "preview");
    assert.ok(preview);
    assert.equal(preview.visible, false);
  });
});

describe("computeColumnLayout — defect A (no dead gutter)", () => {
  // The desktop reference image (`refs/ui/02-workspace-shell.jpg`,
  // 1384 viewport) shows all four columns with the chat column
  // at ~322px wide. The fix: conversation is the elastic column;
  // its rendered width tracks the leftover after the fixed
  // columns claim their widths, clamped to [min, max]. The chat
  // content's own max-w-[768px] fills the column at every
  // comfortable width — no 250-280px dead gutter.

  test("at 1280 the conversation column is elastic, not 1040 with a centred content box", () => {
    const summary = computeColumnLayout(DEFAULT_COLUMN_LAYOUT, 1280, 1280);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    const preview = summary.segments.find((s) => s.id === "preview")!;
    const tree = summary.segments.find((s) => s.id === "tree")!;
    const sidebar = summary.segments.find((s) => s.id === "sidebar")!;
    assert.ok(conversation.visible);
    assert.ok(preview.visible);
    assert.ok(tree.visible);
    // The bug: a 1040px conversation column with the chat
    // content's max-w-[768px] centred = ~136px gutter each side.
    // The fix: the column itself caps at maxWidth (768); no
    // wide-gutter state is reachable.
    assert.ok(conversation.width <= COLUMN_SPECS.conversation.maxWidth,
      `conversation ${conversation.width} > max ${COLUMN_SPECS.conversation.maxWidth}`);
    // The four visible widths sum to exactly the container (or
    // less when a column collapsed). No unexplained remainder.
    const total = sidebar.width + conversation.width + preview.width + tree.width;
    assert.equal(total, 1280, `total ${total} != 1280`);
  });

  test("at 1920 the conversation column caps at its max — no 250-280px gutter each side", () => {
    const summary = computeColumnLayout(DEFAULT_COLUMN_LAYOUT, 1920, 1920);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    assert.ok(conversation.visible);
    assert.ok(conversation.width <= COLUMN_SPECS.conversation.maxWidth,
      `conversation ${conversation.width} > max ${COLUMN_SPECS.conversation.maxWidth}`);
    // Conversation fills its max; the leftover distributes to
    // tree first, then preview, then sidebar. The row sums to
    // exactly the container.
    const total = summary.segments.reduce((sum, s) => sum + s.width, 0);
    assert.equal(total, 1920, `total ${total} != 1920`);
  });

  test("at 1384 (the reference image width) the right-side three columns are visible and the chat column lands in the user-accepted band", () => {
    // Slice 17 — the AppShell chrome owns the session sidebar
    // (it renders OUTSIDE WorkspaceColumns). The wrapper itself
    // allocates three columns: conversation, preview, tree.
    // The "all four columns" assertion is therefore dropped here
    // (it lives at the shell level, not the layout wrapper
    // level); the page-level integration test pins the four
    // columns at the AppShell + WorkspaceColumns boundary.
    const summary = computeColumnLayout(DEFAULT_COLUMN_LAYOUT, 1384, 1384);
    const visibleIds = summary.segments.filter((s) => s.visible).map((s) => s.id);
    assert.deepEqual(visibleIds, ["conversation", "preview", "tree"]);
    // Slice 17 — with the AppShell chrome owning the session
    // sidebar, the wrapper sees only preview + tree as fixed
    // siblings, so the elastic fill at 1384 lands ~600-700
    // (the user accepts the chat column being noticeably wider
    // at 1384+ once the chat column owns the empty space
    // rather than being squeezed under a 1040px dead-gutter).
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    assert.ok(conversation.width >= 280 && conversation.width <= 768,
      `conversation ${conversation.width} outside the expected band`);
  });

  test("the conversation divider drives the layout (defect A — no write-only control)", () => {
    // The conversation divider is a draggable control. A drag
    // updates `widths.conversation`; the algorithm must read
    // that stored value and re-distribute the overflow to
    // preview/tree. Previously (slice 15) the algorithm
    // computed conversation as a pure leftover of the fixed
    // columns, making the divider a write-only control that
    // stored a gesture and moved nothing — the original
    // "调整右侧边栏的宽度表现不正常" defect. Slice 17 makes
    // conversation a real stored width: the algorithm honours
    // the user's drag within the [280, 768] band, and folds
    // the fixed columns first when the row overflows.
    //
    // At 1920 (room to grow) the drag to 720 is honoured
    // exactly — preview/tree absorb the leftover up to their
    // own maxes and conversation stays at 720.
    const dragged = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "conversation", 720);
    const summary = computeColumnLayout(dragged, 1920, 1920);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    // Conversation sits at the user's stored 720 — the
    // algorithm honoured the drag instead of recomputing it
    // as a leftover.
    assert.equal(conversation.width, 720,
      `conversation ${conversation.width} should be the stored 720`);
  });

  test("dragging the conversation divider at 1280 visibly narrows conversation", () => {
    // The earlier "elastic fill" model computed conversation as
    // pure leftover of the fixed columns, so a drag produced
    // no visible change on the conv column itself — the divider
    // was a write-only control. Slice 17 honours the stored
    // drag: dragging the conv/preview divider narrower visibly
    // narrows conversation AND grows preview/tree (visible on
    // both surfaces, not a write-only gesture).
    //
    // The user's narrowing drag (conv 640 → 280): conv stored
    // hits the floor; preview/tree absorb the released 360px
    // (preview grows to its default 400, tree grows to its
    // max 600).
    const before = computeColumnLayout(DEFAULT_COLUMN_LAYOUT, 1280, 1280);
    const conversationBefore = before.segments.find((s) => s.id === "conversation")!.width;
    const previewBefore = before.segments.find((s) => s.id === "preview")!.width;
    const treeBefore = before.segments.find((s) => s.id === "tree")!.width;
    const dragged = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "conversation", 280);
    const after = computeColumnLayout(dragged, 1280, 1280);
    const conversationAfter = after.segments.find((s) => s.id === "conversation")!.width;
    const previewAfter = after.segments.find((s) => s.id === "preview")!.width;
    const treeAfter = after.segments.find((s) => s.id === "tree")!.width;
    // Conversation narrowed visibly.
    assert.ok(conversationAfter < conversationBefore,
      `conversation should narrow: ${conversationBefore} -> ${conversationAfter}`);
    assert.equal(conversationAfter, 280,
      `conversation ${conversationAfter} should clamp at the stored min`);
    // The released width went to the fixed columns — preview
    // grew, tree grew. The visible reflow on both surfaces is
    // what the user sees when they drag.
    assert.ok(previewAfter > previewBefore,
      `preview should grow as conversation releases width: ${previewBefore} -> ${previewAfter}`);
    assert.ok(treeAfter > treeBefore,
      `tree should grow as conversation releases width: ${treeBefore} -> ${treeAfter}`);
  });

  test("a stored conversation width above max clamps to maxWidth", () => {
    // Edge case: a buggy stored width of 1500 on the
    // conversation column must clamp to maxWidth (the
    // drag-resize handler clamps on every move so this is a
    // static-source tripwire for the clampWidth path).
    const layout = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "conversation", 1500);
    const summary = computeColumnLayout(layout, 1920, 1920);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    assert.equal(conversation.width, COLUMN_SPECS.conversation.maxWidth);
  });

  test("fold priority: preview folds first, then tree (conversation last)", () => {
    // Tight container forces the fix to fold feature columns.
    // Preview folds before tree (the user's priority); the
    // conversation column folds as a last resort (only when
    // preview + tree + conversation min still exceed the
    // container). Sidebar is AppShell chrome and the wrapper
    // always sees it as 0 — the fold priority applies to the
    // three wrapper-owned columns.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      widths: {
        sidebar: COLUMN_SPECS.sidebar.maxWidth,
        conversation: COLUMN_SPECS.conversation.defaultWidth,
        preview: COLUMN_SPECS.preview.maxWidth,
        tree: COLUMN_SPECS.tree.maxWidth,
      },
      collapsed: { sidebar: false, conversation: false, preview: false, tree: false },
    };
    const summary = computeColumnLayout(layout, 600, 600);
    const tree = summary.segments.find((s) => s.id === "tree")!;
    const preview = summary.segments.find((s) => s.id === "preview")!;
    // Preview folds before tree (the user's policy).
    assert.ok(preview.width <= tree.width,
      `preview ${preview.width} > tree ${tree.width} — fold priority violated`);
  });
});

describe("serializeWorkspaceTabs / deserializeWorkspaceTabs", () => {
  test("round-trip preserves tabs, per-column active ids, file scrolls, and column widths", () => {
    const state: WorkspaceTabsState = {
      tabStrip: {
        tabs: [
          fileTabFromPath("/repo/a.md", 240),
          surfaceTab("git"),
          surfaceTab("files"),
          surfaceTab("browser"),
        ],
        previewActiveId: "browser",
        treeActiveId: "files",
        launcherOpen: false,
      },
      columnLayout: {
        widths: { sidebar: 240, conversation: 720, preview: 360, tree: 280 },
        collapsed: { sidebar: false, conversation: false, preview: false, tree: false },
      },
    };
    const wire = serializeWorkspaceTabs(state, cid);
    assert.equal(wire.version, WORKSPACE_TABS_VERSION);
    assert.equal(wire.cid, cid);
    const restored = deserializeWorkspaceTabs(JSON.stringify(wire), cid);
    assert.deepEqual(restored.tabStrip.tabs, state.tabStrip.tabs);
    assert.equal(restored.tabStrip.previewActiveId, "browser");
    assert.equal(restored.tabStrip.treeActiveId, "files");
    assert.equal(restored.columnLayout.widths.preview, 360);
  });

  test("returns defaults on garbage / version-mismatch / cid-mismatch input", () => {
    for (const raw of [null, "", "{", "not json", "[]", JSON.stringify({})]) {
      const out = deserializeWorkspaceTabs(raw as string | null, cid);
      assert.deepEqual(out, DEFAULT_WORKSPACE_TABS_STATE);
    }
    const wrongVersion = JSON.stringify({
      version: WORKSPACE_TABS_VERSION + 9,
      cid,
      tabs: { tabs: [], previewActiveId: null, treeActiveId: null, activeId: null, fileScrolls: {} },
      layout: {},
    });
    assert.deepEqual(deserializeWorkspaceTabs(wrongVersion, cid), DEFAULT_WORKSPACE_TABS_STATE);
    const wrongCid = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid: "different-cid",
      tabs: { tabs: [], previewActiveId: null, treeActiveId: null, activeId: null, fileScrolls: {} },
      layout: {},
    });
    assert.deepEqual(deserializeWorkspaceTabs(wrongCid, cid), DEFAULT_WORKSPACE_TABS_STATE);
  });

  test("clamps column widths on deserialize so a corrupted payload cannot push past the max", () => {
    const corrupted = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: { tabs: [], previewActiveId: null, treeActiveId: null, activeId: null, fileScrolls: {} },
      layout: {
        widths: { sidebar: 9999, conversation: 9999, preview: 9999, tree: 9999 },
        collapsed: {},
      },
    });
    const out = deserializeWorkspaceTabs(corrupted, cid);
    assert.ok(out.columnLayout.widths.preview <= COLUMN_SPECS.preview.maxWidth);
    assert.ok(out.columnLayout.widths.preview >= COLUMN_SPECS.preview.minWidth);
  });

  test("drops unknown tab ids so a future schema bump cannot crash the renderer", () => {
    const payload = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: {
        tabs: ["files", "made-up-tab", "git"],
        previewActiveId: null,
        treeActiveId: "made-up-tab",
        activeId: null,
        fileScrolls: {},
      },
      layout: {},
    });
    const out = deserializeWorkspaceTabs(payload, cid);
    assert.equal(out.tabStrip.tabs.length, 2);
    assert.equal(out.tabStrip.treeActiveId, "git");
  });

  describe("sidebar nav landing — search & plugins", () => {
  // Regression tripwire: slice 15 collapsed the panel column and
  // orphaned the sidebar's legacy 搜索 / 插件 nav entries. The
  // columnRoleForKind classifier has to map them to the tree
  // column so the page's openSurfaceTab dispatcher lands them
  // on a visible surface (SearchSurface / PluginsSurface in
  // components/workspace-tree-column.tsx).
  test("search / plugins classify as tree surfaces so openSurfaceTab opens them", () => {
    assert.equal(columnRoleForKind("search"), "tree");
    assert.equal(columnRoleForKind("plugins"), "tree");
    // The reducer dispatches them into the tree column.
    const state = openTab({ ...DEFAULT_TAB_STRIP }, surfaceTab("search"));
    assert.equal(state.treeActiveId, "search");
    assert.equal(state.previewActiveId, null);
    const withPlugins = openTab(state, surfaceTab("plugins"));
    assert.equal(withPlugins.treeActiveId, "plugins");
  });
});

test("FORWARD-COMPAT: a slice-15 payload (single activeId + panel/secondary columns) reads without crashing", () => {
    // A user who refreshed after slice 16 but BEFORE slice 17
    // ships has a payload like this on disk. The deserializer
    // must NOT crash the page; it must fall back to defaults
    // for the new column ids AND map the legacy single active
    // id into the new per-column slots. Values that happen to
    // still be in range in slice 17 are preserved verbatim —
    // the user's saved conversation width (768) is still a
    // valid slice-17 target (it was the slice-15 default and
    // happens to be the slice-17 max).
    const oldPayload = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: {
        tabs: ["files", "git", "browser", "file:/repo/a.md"],
        activeId: "file:/repo/a.md",
        fileScrolls: { "file:/repo/a.md": 240 },
      },
      layout: {
        widths: { sidebar: 240, conversation: 768, panel: 320, secondary: 320 },
        collapsed: { sidebar: false, conversation: false, panel: false, secondary: false },
        secondaryOpen: true,
      },
    });
    const out = deserializeWorkspaceTabs(oldPayload, cid);
    // No white-screen: defaults are applied where the new ids
    // are missing.
    assert.equal(out.columnLayout.widths.sidebar, 240, "sidebar preserved");
    assert.equal(out.columnLayout.widths.conversation, 768,
      "conversation preserved (768 is still within slice-17 [280, 768])");
    assert.equal(out.columnLayout.widths.preview, COLUMN_SPECS.preview.defaultWidth,
      "preview reset to slice-17 default (panel key absent in old payload)");
    assert.equal(out.columnLayout.widths.tree, COLUMN_SPECS.tree.defaultWidth,
      "tree reset to slice-17 default (secondary key absent in old payload)");
    // All four tabs survived.
    assert.equal(out.tabStrip.tabs.length, 4);
    // The legacy active id was a file tab → preview column picks it up.
    assert.equal(out.tabStrip.previewActiveId, "file:/repo/a.md");
    // The tree column had no legacy active id; the deserializer
    // points it at the most recently opened tree tab (the last
    // tree tab in the open-order list). `git` is the most recent
    // because the user opened files → git → browser → file.md.
    assert.equal(out.tabStrip.treeActiveId, "git");
    // The scroll position survived.
    assert.equal((out.tabStrip.tabs[3] as { scrollTop: number }).scrollTop, 240);
  });

  test("FORWARD-COMPAT: a slice-15 payload forces collapsed.sidebar=true so AppShell owns the chrome cleanly", () => {
    // Slice 15 stored `collapsed.sidebar:false` (its own
    // default). Slice 17 made AppShell the owner of the
    // session sidebar — the WorkspaceColumns wrapper must NOT
    // allocate ~220-400px for a slot that renders `null`. A
    // legacy payload that says `collapsed.sidebar:false` would
    // otherwise conjure a ghost column and crush the chat
    // column below its minimum on upgrade. The deserializer
    // forces `collapsed.sidebar=true` on read regardless of what
    // the payload says.
    const legacyPayload = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: { tabs: [], previewActiveId: null, treeActiveId: null, activeId: null, fileScrolls: {} },
      layout: {
        widths: { sidebar: 240, conversation: 720, preview: 400, tree: 340 },
        // `collapsed.sidebar:false` was slice 15's own default.
        collapsed: { sidebar: false, conversation: false, preview: false, tree: false },
      },
    });
    const out = deserializeWorkspaceTabs(legacyPayload, cid);
    assert.equal(out.columnLayout.collapsed.sidebar, true,
      "collapsed.sidebar must be forced to true on read — AppShell owns the sidebar");
    // The chat column still gets its sensible width at 1280
    // (the legacy payload's conversation=720 lands at whatever
    // fits after preview/tree folded to their minimums).
    const summary = computeColumnLayout(out.columnLayout, 1040, 1280);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    assert.ok(conversation.width >= COLUMN_SPECS.conversation.minWidth,
      `conversation ${conversation.width} below min — ghost sidebar would be the cause`);
  });
});