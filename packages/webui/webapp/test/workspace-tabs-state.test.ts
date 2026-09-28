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
  hasPreviewTabs,
  hasTreeTabs,
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
  syncColumnVisibility,
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

  test("clamps each column to its [min, max] bounds (skipping conversation — unbounded)", () => {
    // Slice 25 — the conversation column has no growth-path
    // ceiling; the algorithm lets it absorb every leftover pixel
    // regardless of `COLUMN_SPECS.conversation.maxWidth`. The
    // `maxWidth` still caps the user drag (via clampWidth), but
    // the algorithm itself ignores it. This test pins the
    // fixed-column clamps only; conversation's "any width up to
    // the container" is covered by the live self-check and by
    // the dedicated "absorbs all leftover" tests below.
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
      if (segment.id === "conversation") continue;
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
  // its rendered width absorbs whatever is left over after the
  // fixed columns claim their widths (no growth-path ceiling —
  // see slice 25; the [min, max] clamp only bounds the stored
  // user drag). The chat content's own max-w-[960px] fills the
  // column at every comfortable width — no 250-280px dead
  // gutter.

  test("at 1280 the conversation column is elastic, not 1040 with a centred content box", () => {
    // Slice 21 — DEFAULT_COLUMN_LAYOUT starts both on-demand
    // columns collapsed; this test pins the slice-17 defect-A
    // fix (no 1040-wide conversation + dead gutter) by forcing
    // both columns visible. The slice-21 idle path is covered
    // by the "at 1280 with both columns folded" test below.
    const layout = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: false, tree: false },
    };
    const summary = computeColumnLayout(layout, 1280, 1280);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    const preview = summary.segments.find((s) => s.id === "preview")!;
    const tree = summary.segments.find((s) => s.id === "tree")!;
    const sidebar = summary.segments.find((s) => s.id === "sidebar")!;
    assert.ok(conversation.visible);
    assert.ok(preview.visible);
    assert.ok(tree.visible);
    // The slice-17 bug: the column itself capped at maxWidth
    // (768) — when the stored conversation width was below the
    // cap, leftover above it piled at the row's right edge as a
    // dead band. Slice 25 removed the column ceiling; the
    // conversation column now absorbs the full leftover. The
    // readable measure cap lives on the CONTENT (chat.tsx +
    // composer.tsx both use max-w-[960px]) and is centred inside
    // the column, so any slack above the measure splits evenly
    // left/right instead of dumping on one side. The dead-gutter
    // defence is now the **fixed columns stay visible** plus the
    // total-accounting assertion below — not a column ceiling.
    //
    // (The previously-shared assertion `conversation.width <=
    // COLUMN_SPECS.conversation.maxWidth` was structurally dead:
    // the algorithm already bounds conv by the container, and
    // the test's container (1280) is below the spec maxWidth
    // (2400), so the comparison was always true.)
    // The four visible widths sum to exactly the container (or
    // less when a column collapsed). No unexplained remainder.
    const total = sidebar.width + conversation.width + preview.width + tree.width;
    assert.equal(total, 1280, `total ${total} != 1280`);
  });

  test("at 1920 the conversation column caps at its max — no 250-280px gutter each side", () => {
    // Slice 21 — DEFAULT_COLUMN_LAYOUT starts both on-demand
    // columns collapsed; this test pins the slice-17 dead-gutter
    // defence, so it forces both columns visible first.
    const layout = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: false, tree: false },
    };
    const summary = computeColumnLayout(layout, 1920, 1920);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    assert.ok(conversation.visible);
    // Slice 25 — conversation has no growth-path ceiling; the
    // column absorbs the entire residual after the fixed
    // columns claim their maxes (preview 720, tree 600). The
    // total = 1920 assertion below pins that the row sums to
    // exactly the container — the dead-gutter defence. The
    // previously-shared `conversation.width <= COLUMN_SPECS.
    // conversation.maxWidth` assertion was structurally dead:
    // the container is < container.maxWidth (2400), so the
    // comparison was always true.
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
    //
    // Slice 21 — DEFAULT_COLUMN_LAYOUT starts both on-demand
    // columns collapsed; this test pins the slice-17 visual
    // (all three wrapper columns visible at 1384), so it
    // forces both fixed columns visible before computing.
    const bothVisibleLayout = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: false, tree: false },
    };
    const summary = computeColumnLayout(bothVisibleLayout, 1384, 1384);
    const visibleIds = summary.segments.filter((s) => s.visible).map((s) => s.id);
    assert.deepEqual(visibleIds, ["conversation", "preview", "tree"]);
    // Slice 25 — with the AppShell chrome owning the session
    // sidebar, the wrapper sees only preview + tree as fixed
    // siblings. At 1384 both visible, conversation absorbs the
    // fold-released width and lands within [280, ...]. The
    // upper bound is now unbounded (the column has no
    // growth-path ceiling — the readable measure cap lives on
    // the content). With both columns absorbing their maxes
    // (preview 720 + tree 600 = 1320), the conversation column
    // fits at the residual = 1384 - 1320 = 64px which falls
    // below the conversation minimum (280) and triggers the
    // fold path; the final conversation width sits in the band.
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    assert.ok(conversation.width >= 280 && conversation.width < 1384,
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
    // the user's drag (clamped to [280, 2400] by `maxWidth`,
    // though the growth path itself is unbounded), and folds
    // the fixed columns first when the row overflows.
    //
    // At 1920 (room to grow) the drag to 720 is honoured
    // exactly — preview/tree absorb the leftover up to their
    // own maxes and conversation stays at 720. Use an
    // explicit both-columns-visible flag because the slice-21
    // default starts both columns collapsed (on-demand idle),
    // lifting conversation beyond the slice-17 768 ceiling in
    // the folded-state path.
    const base = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "conversation", 720);
    const dragged = {
      ...base,
      collapsed: { sidebar: true, conversation: false, preview: false, tree: false },
    };
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
    // Slice 21 — DEFAULT_COLUMN_LAYOUT starts with both columns
    // collapsed (on-demand idle). The drag test needs both
    // columns visible so it can verify the fold priority's
    // visible reflow.
    const bothVisibleLayout = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: false, tree: false },
    };
    const before = computeColumnLayout(bothVisibleLayout, 1280, 1280);
    const conversationBefore = before.segments.find((s) => s.id === "conversation")!.width;
    const previewBefore = before.segments.find((s) => s.id === "preview")!.width;
    const treeBefore = before.segments.find((s) => s.id === "tree")!.width;
    const dragged = setColumnWidth(bothVisibleLayout, "conversation", 280);
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

  test("a stored conversation width above max clamps to maxWidth (drag-clamp only — the growth path is unbounded)", () => {
    // Edge case: a buggy stored width of 3000 on the
    // conversation column must clamp to maxWidth (2400 — the
    // drag-resize handler clamps on every move so this is a
    // static-source tripwire for the clampWidth path). Slice 25
    // notes that the algorithm's GROWTH PATH no longer honours
    // maxWidth (the conversation column always absorbs all
    // leftover), so to observe the clamp the stored width itself
    // is the only handle: setColumnWidth("conversation", 3000)
    // lands at 2400. We verify the clamp by reading back the
    // stored value rather than the algorithm output.
    const clamped = setColumnWidth(DEFAULT_COLUMN_LAYOUT, "conversation", 3000);
    assert.equal(clamped.widths.conversation, COLUMN_SPECS.conversation.maxWidth,
      `clampWidth(3000) must equal maxWidth ${COLUMN_SPECS.conversation.maxWidth}`);
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
    // still be in range in slice 25 are preserved verbatim —
    // the user's saved conversation width (768) is still a
    // valid slice-25 target (it was the slice-15 default and
    // happened to coincide with the slice-17 768 max, and is
    // comfortably within the slice-25 [280, 2400] band).
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
      "conversation preserved (768 is still within slice-25 [280, 2400])");
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

// =====================================================================
// Slice 21 — on-demand columns
// =====================================================================
//
// The two right-hand columns (preview / tree) now open only when
// at least one tab in the matching role is present, and close
// themselves when no tab remains. The state model is a pure
// predicate (`hasPreviewTabs` / `hasTreeTabs`) plus a sync
// reducer (`syncColumnVisibility`) that derives the column
// collapsed flags from the tab strip. The deserializer applies
// the sync on read so a stale "column open but empty" payload
// never resurrects an empty column.
//
// The computeColumnLayout algorithm also lifts the conversation
// max when both fixed columns are folded so the idle state fills
// the row (1280 → conversation ≈ 1040, 1920 → conversation ≈
// 1680), while preserving slice 17's dead-gutter defence when
// at least one fixed column is visible.

describe("hasPreviewTabs / hasTreeTabs", () => {
  test("empty tab strip → both predicates false", () => {
    assert.equal(hasPreviewTabs(DEFAULT_TAB_STRIP), false);
    assert.equal(hasTreeTabs(DEFAULT_TAB_STRIP), false);
  });

  test("a preview tab (file: or browser) → hasPreviewTabs true", () => {
    const withFile = openTab(DEFAULT_TAB_STRIP, fileTabFromPath("/repo/a.md"));
    assert.equal(hasPreviewTabs(withFile), true);
    assert.equal(hasTreeTabs(withFile), false);

    const withBrowser = openTab(DEFAULT_TAB_STRIP, surfaceTab("browser"));
    assert.equal(hasPreviewTabs(withBrowser), true);
    assert.equal(hasTreeTabs(withBrowser), false);
  });

  test("a tree surface → hasTreeTabs true", () => {
    for (const kind of ["files", "git", "tasks", "search", "plugins"] as const) {
      const next = openTab(DEFAULT_TAB_STRIP, surfaceTab(kind));
      assert.equal(hasPreviewTabs(next), false);
      assert.equal(hasTreeTabs(next), true);
    }
  });

  test("closing the last tab flips both predicates back to false", () => {
    const withFile = openTab(DEFAULT_TAB_STRIP, fileTabFromPath("/repo/a.md"));
    assert.equal(hasPreviewTabs(withFile), true);
    const empty = closeTab(withFile, "file:/repo/a.md");
    assert.equal(hasPreviewTabs(empty), false);
  });
});

describe("syncColumnVisibility — slice 21 needs open ↔ tabs", () => {
  test("no tabs → both flags close", () => {
    const out = syncColumnVisibility(DEFAULT_TAB_STRIP, DEFAULT_COLUMN_LAYOUT);
    assert.equal(out.collapsed.preview, true);
    assert.equal(out.collapsed.tree, true);
  });

  test("opening a preview tab reopens the preview column", () => {
    const tab = openTab(DEFAULT_TAB_STRIP, fileTabFromPath("/repo/a.md"));
    const out = syncColumnVisibility(tab, {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: true, tree: true },
    });
    assert.equal(out.collapsed.preview, false);
    assert.equal(out.collapsed.tree, true, "tree stays closed");
  });

  test("opening a tree tab reopens the tree column", () => {
    const tab = openTab(DEFAULT_TAB_STRIP, surfaceTab("files"));
    const out = syncColumnVisibility(tab, {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: true, tree: true },
    });
    assert.equal(out.collapsed.preview, true);
    assert.equal(out.collapsed.tree, false);
  });

  test("closing the last preview tab re-closes the preview column", () => {
    let state: TabStripState = openTab(DEFAULT_TAB_STRIP, fileTabFromPath("/repo/a.md"));
    // The page's wrapper would have set preview:false after the open above;
    // the sync should keep that flag in place while the tab exists.
    let layout = syncColumnVisibility(state, DEFAULT_COLUMN_LAYOUT);
    assert.equal(layout.collapsed.preview, false);
    state = closeTab(state, "file:/repo/a.md");
    layout = syncColumnVisibility(state, layout);
    assert.equal(layout.collapsed.preview, true, "preview auto-closes when its last tab is gone");
  });

  test("closes the tree column when its last surface tab closes", () => {
    let state: TabStripState = openTab(DEFAULT_TAB_STRIP, surfaceTab("git"));
    let layout = syncColumnVisibility(state, DEFAULT_COLUMN_LAYOUT);
    assert.equal(layout.collapsed.tree, false);
    state = closeTab(state, "git");
    layout = syncColumnVisibility(state, layout);
    assert.equal(layout.collapsed.tree, true, "tree auto-closes when its last tab is gone");
  });

  test("idempotent — same layout returned when flags already match", () => {
    const tab = openTab(DEFAULT_TAB_STRIP, fileTabFromPath("/repo/a.md"));
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: false, tree: true },
    };
    const once = syncColumnVisibility(tab, layout);
    const twice = syncColumnVisibility(tab, once);
    assert.equal(once, twice, "sync must return the same reference when flags already match");
  });

  test("sidebar collapsed flag is preserved through sync", () => {
    // The sidebar is owned by AppShell; sync must never touch it.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: false, conversation: false, preview: true, tree: true },
    };
    const out = syncColumnVisibility(DEFAULT_TAB_STRIP, layout);
    assert.equal(out.collapsed.sidebar, false,
      "sidebar flag must survive sync — AppShell owns it");
  });
});

describe("computeColumnLayout — slice 21 idle state", () => {
  // The ticket's headline measurement: at 1280 with both
  // columns folded, the conversation column must take the
  // whole remainder (1040 = 1280 − 240 sidebar). Slice 25
  // removed the conversation column's growth-path ceiling in
  // EVERY state — when at least one fixed column is visible
  // conversation still absorbs any leftover that survives the
  // fixed-column maxes, capped only by the container width. (A
  // previous version of this comment claimed slice-17's "768
  // dead-gutter defence" survived when fixed columns were
  // visible; that was true under slice-17 but not slice-25 —
  // see `workspace-tabs-state.ts:805-823`.) The "no ceiling"
  // invariant is pinned at small containers by the
  // `total = container` assertions in each test, and at wide
  // containers by the dedicated 2560-replica test below.

  test("at 1280 with both columns folded, conversation takes the full remainder", () => {
    // AppShell chrome is 240, so the WorkspaceColumns container
    // is 1040 wide. With both right-hand columns closed the
    // conversation column must equal 1040.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: true, tree: true },
    };
    const summary = computeColumnLayout(layout, 1040, 1280);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    const preview = summary.segments.find((s) => s.id === "preview")!;
    const tree = summary.segments.find((s) => s.id === "tree")!;
    assert.equal(conversation.width, 1040, `conversation ${conversation.width} != 1040`);
    assert.equal(preview.width, 0);
    assert.equal(tree.width, 0);
    assert.equal(preview.visible, false);
    assert.equal(tree.visible, false);
    assert.equal(conversation.visible, true);
    const total = summary.segments.reduce((sum, s) => sum + s.width, 0);
    assert.equal(total, 1040, `total ${total} != 1040`);
  });

  test("at 1920 with both columns folded, conversation fills the row", () => {
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: true, tree: true },
    };
    // AppShell chrome is 240, so the WorkspaceColumns container
    // is 1680 wide. With both right-hand columns closed the
    // conversation column must equal 1680.
    const summary = computeColumnLayout(layout, 1680, 1920);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    assert.equal(conversation.width, 1680, `conversation ${conversation.width} != 1680`);
    const total = summary.segments.reduce((sum, s) => sum + s.width, 0);
    assert.equal(total, 1680, `total ${total} != 1680`);
  });

  test("with the tree column visible at 1920, conversation absorbs all leftover", () => {
    // Slice 25 — the conversation column has no growth-path
    // ceiling. At 1920 with sidebar=240 and tree at its max 600,
    // the fixed-column tree absorbs its max, then conversation
    // absorbs the remaining 1080px (1680 − 600). No dead band at
    // the row's right edge. The reader-readable measure cap
    // (960px) lives on the content (chat stream + composer), not
    // on the column — see `components/chat.tsx`.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: true, tree: false },
    };
    const summary = computeColumnLayout(layout, 1680, 1920);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    const tree = summary.segments.find((s) => s.id === "tree")!;
    assert.equal(conversation.width, 1080,
      `conversation ${conversation.width} must absorb all leftover (1680 - 600 = 1080)`);
    assert.ok(tree.width >= COLUMN_SPECS.tree.minWidth,
      `tree ${tree.width} below min — fold priority violated`);
  });

  test("with the preview column visible at 1920, conversation absorbs all leftover", () => {
    // Slice 25 — opening only the preview column: preview
    // grows to its 720 max, conversation absorbs the rest of
    // the 1680 container = 960. No dead band at the row's
    // right edge; the readable measure cap (960px, centred) on
    // the content does not bite here because the column itself
    // is exactly 960.
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: false, tree: true },
    };
    const summary = computeColumnLayout(layout, 1680, 1920);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    assert.equal(conversation.width, 960,
      `conversation ${conversation.width} must absorb all leftover (1680 - 720 = 960)`);
  });

  test("with both columns visible at 1280, conversation folds per the priority", () => {
    // Pre-slice-21 behaviour must survive: both columns visible
    // at 1280 (1040 container) folds preview → tree → conv.
    // This pins that the new idle-state widening does not leak
    // into the "both visible" path. The default DEFAULT_COLUMN_LAYOUT
    // starts with both columns collapsed (slice-21 idle), so this
    // test pins an explicit "both visible" layout.
    //
    // The previous shape carried two tautological guards here
    // (conv <= maxWidth 2400 and conv >= minWidth 280): the
    // algorithm already bounds conv by the container, and the
    // fold math clamps conv to [280, container] at this width,
    // so both comparisons held for every valid input. Removed
    // alongside the defect-A pair at :483-484 / :502-503 (ticket
    // 38) — the new wide-container test below pins the actual
    // no-ceiling invariant for the algorithm path.
    const layout = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: false, tree: false },
    };
    const summary = computeColumnLayout(layout, 1040, 1280);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    // Conversation must remain visible (fold priority gives it
    // at least its minimum) and must not have been squashed to 0
    // by the overflow shed — the visible-flag check below pins
    // this. The previous `width >= minWidth` line was tautological
    // (width ∈ [280, container]), so we drop it.
    assert.equal(conversation.visible, true,
      `conversation must stay visible at 1280 with both columns open`);
  });

  test("at a wide container (2560) with both columns folded, conversation absorbs every pixel — no growth-path ceiling", () => {
    // Slice 25 — the conversation column has no growth-path
    // ceiling. The only `maxWidth` clamp is on the user drag
    // (clampWidth); the algorithm lets conv absorb every leftover
    // pixel. The defect-A pair at :483-484 / :502-503 (ticket 38)
    // was always-true *only* because the test containers were
    // small (1280 / 1920 — both well below maxWidth 2400). At a
    // container above 2400 with nothing else to absorb, conv must
    // exceed the spec maxWidth. This test pins the slice-25
    // contract and would catch a regression that re-introduces
    // a column-side ceiling ("if (conv > maxWidth) conv = maxWidth").
    const layout: typeof DEFAULT_COLUMN_LAYOUT = {
      ...DEFAULT_COLUMN_LAYOUT,
      collapsed: { sidebar: true, conversation: false, preview: true, tree: true },
    };
    const summary = computeColumnLayout(layout, 2560, 2560);
    const conversation = summary.segments.find((s) => s.id === "conversation")!;
    // Both fixed columns are folded, so the entire 2560-pixel
    // container falls through to conversation. The exact value
    // pin is the assertion: if anyone re-adds a ceiling that
    // clamps conv to maxWidth (2400), this would land at 2400
    // and fail.
    assert.equal(conversation.width, 2560,
      `conversation ${conversation.width} must equal container 2560 — ` +
      `no growth-path ceiling (slice 25; the 2400 cap only bounds the user drag)`);
    // Conv also exceeds the spec maxWidth (2400), which is the
    // observable invariant the deleted tautological guards could
    // never reach.
    assert.ok(conversation.width > COLUMN_SPECS.conversation.maxWidth,
      `conversation ${conversation.width} must exceed spec maxWidth ` +
      `${COLUMN_SPECS.conversation.maxWidth} — the spec ceiling is drag-only, not a growth path`);
    const preview = summary.segments.find((s) => s.id === "preview")!;
    const tree = summary.segments.find((s) => s.id === "tree")!;
    assert.equal(preview.width, 0);
    assert.equal(tree.width, 0);
    const total = summary.segments.reduce((sum, s) => sum + s.width, 0);
    assert.equal(total, 2560, `total ${total} != 2560`);
  });
});

describe("deserializeWorkspaceTabs — slice 21 payload normalization", () => {
  // A stored payload that says "column open but empty" must
  // load as closed. Slice 17 already fixed the closely-related
  // "ghost sidebar" bug; this is the same class for the two
  // on-demand columns.

  test("normalises a 'preview open but no preview tab' payload to closed", () => {
    const payload = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: { tabs: ["git"], previewActiveId: null, treeActiveId: "git", activeId: "git", fileScrolls: {} },
      // The stale payload names preview open (slice 17 default) but
      // the tab strip has no preview tab.
      layout: {
        widths: { sidebar: 240, conversation: 720, preview: 400, tree: 340 },
        collapsed: { sidebar: false, conversation: false, preview: false, tree: false },
      },
    });
    const out = deserializeWorkspaceTabs(payload, cid);
    assert.equal(out.columnLayout.collapsed.preview, true,
      "preview must normalise to closed when no preview tab exists");
    // Tree stays open because the payload still has a `git` tab.
    assert.equal(out.columnLayout.collapsed.tree, false);
  });

  test("normalises a 'tree open but no tree tab' payload to closed", () => {
    const payload = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: { tabs: ["file:/repo/a.md"], previewActiveId: "file:/repo/a.md", treeActiveId: null, activeId: "file:/repo/a.md", fileScrolls: {} },
      layout: {
        widths: { sidebar: 240, conversation: 720, preview: 400, tree: 340 },
        collapsed: { sidebar: false, conversation: false, preview: false, tree: false },
      },
    });
    const out = deserializeWorkspaceTabs(payload, cid);
    assert.equal(out.columnLayout.collapsed.tree, true,
      "tree must normalise to closed when no tree tab exists");
    assert.equal(out.columnLayout.collapsed.preview, false,
      "preview stays open because the file tab is a preview tab");
  });

  test("normalises a 'both columns open but empty' payload to closed", () => {
    const payload = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: { tabs: [], previewActiveId: null, treeActiveId: null, activeId: null, fileScrolls: {} },
      layout: {
        widths: { sidebar: 240, conversation: 720, preview: 400, tree: 340 },
        collapsed: { sidebar: false, conversation: false, preview: false, tree: false },
      },
    });
    const out = deserializeWorkspaceTabs(payload, cid);
    assert.equal(out.columnLayout.collapsed.preview, true);
    assert.equal(out.columnLayout.collapsed.tree, true);
  });

  test("fresh install lands in the slice-21 idle state (both columns closed)", () => {
    // Empty input → cloneDefaultWorkspaceTabsState() → empty
    // tab strip → syncColumnVisibility sets both flags true.
    const out = deserializeWorkspaceTabs(null, cid);
    assert.equal(out.tabStrip.tabs.length, 0);
    assert.equal(out.columnLayout.collapsed.preview, true);
    assert.equal(out.columnLayout.collapsed.tree, true);
    assert.equal(out.columnLayout.collapsed.sidebar, true,
      "sidebar stays collapsed — AppShell owns it");
  });

  test("garbage input (non-json, wrong version, wrong cid) lands in the idle state", () => {
    for (const raw of [null, "", "{", "not json", "[]", JSON.stringify({})]) {
      const out = deserializeWorkspaceTabs(raw as string | null, cid);
      assert.equal(out.columnLayout.collapsed.preview, true,
        `preview must default to closed on garbage input: ${raw}`);
      assert.equal(out.columnLayout.collapsed.tree, true,
        `tree must default to closed on garbage input: ${raw}`);
    }
  });

  test("a preview tab in the payload keeps the preview column open after normalisation", () => {
    const payload = JSON.stringify({
      version: WORKSPACE_TABS_VERSION,
      cid,
      tabs: {
        tabs: ["file:/repo/a.md"],
        previewActiveId: "file:/repo/a.md",
        treeActiveId: null,
        activeId: "file:/repo/a.md",
        fileScrolls: { "file:/repo/a.md": 0 },
      },
      layout: {
        widths: { sidebar: 240, conversation: 720, preview: 400, tree: 340 },
        // `preview: true` AND `tree: true` — the worst-case
        // stale payload (both closed despite a preview tab).
        collapsed: { sidebar: true, conversation: false, preview: true, tree: true },
      },
    });
    const out = deserializeWorkspaceTabs(payload, cid);
    assert.equal(out.columnLayout.collapsed.preview, false,
      "sync reopens the preview column when a preview tab exists in the strip");
    assert.equal(out.columnLayout.collapsed.tree, true,
      "tree stays closed — no tree tab in the strip");
  });
});

describe("DEFAULT_COLUMN_LAYOUT — slice-21 idle flags", () => {
  // The default represents "no tabs, no columns". The deserializer
  // + the sync reducer normalise every load, so the default
  // itself should already encode the slice-21 idle state.
  test("both on-demand columns start closed in the default", () => {
    assert.equal(DEFAULT_COLUMN_LAYOUT.collapsed.preview, true);
    assert.equal(DEFAULT_COLUMN_LAYOUT.collapsed.tree, true);
    assert.equal(DEFAULT_COLUMN_LAYOUT.collapsed.sidebar, true,
      "sidebar still collapses to AppShell chrome");
    assert.equal(DEFAULT_COLUMN_LAYOUT.collapsed.conversation, false,
      "conversation never folds");
  });
});