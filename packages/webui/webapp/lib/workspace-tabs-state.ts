// webapp/lib/workspace-tabs-state.ts
//
// Slice 17 — four-column shell model. Slice 21 — on-demand columns.
//
// Two state slices share this module so the reducers can be
// reasoned about in one place and unit-tested without rendering:
//
//   1. **Tab strip** — the open tabs (file / git / browser / tasks /
//      file:<path>). Each tab belongs to ONE of the two right-hand
//      columns:
//        - **preview column** (column 3): file:<path>, browser
//        - **tree column** (column 4): files, git, tasks
//      Each column tracks its own active id so opening a tree
//      surface does not steal focus from the preview column (and
//      vice-versa). Reducers are `openTab`, `closeTab`,
//      `activateTab`, `moveTab`, `recordFileTabScroll`,
//      `setLauncherOpen`, `resetTabs`.
//
//   2. **Column layout** — four columns in DOM order:
//        sidebar | conversation | preview | tree
//      `conversation` is the user-draggable column whose stored
//      width (clamped to [minWidth, maxWidth]) the
//      `computeColumnLayout` algorithm honours — it re-distributes
//      overflow among the fixed columns (preview, tree) and only
//      folds conversation as a last resort. The other three are
//      fixed-pixel columns whose stored widths also feed the
//      algorithm. Reducers are `setColumnWidth`, `resetColumnWidth`,
//      `setColumnCollapsed`, and the pure predicate
//      `computeColumnLayout` that folds the layout down to a list
//      of `{ column, width }` segments that drive the page-level
//      flex row.
//
// Slice 21 changes the visibility model:
//   - The preview column is **on demand** — it appears when at
//     least one preview-role tab (file:<path> / browser) is open,
//     and **auto-closes** when no preview tab remains.
//   - The tree column is **on demand** — it appears when at least
//     one tree-role surface (files / git / tasks / search /
//     plugins) is open, and auto-closes when none remain.
//   - "Idle costs no width": when both columns are closed the
//     conversation column takes the whole remainder. The
//     `computeColumnLayout` algorithm honours this by lifting
//     the conversation max only when both fixed columns are
//     folded (otherwise slice 17's dead-gutter defence applies).
//   - The persistence layer normalises a stored "column open but
//     empty" payload to closed (slice 17's closely-related
//     ghost-column bug, re-fixed here) so a stale disk write can
//     never conjure an empty column on hydration.
//
// Why this lives in its own module. Every reducer here is a pure
// function on plain objects — no React, no DOM, no localStorage.
// The unit tests in `webapp/test/workspace-tabs-state.test.ts`
// pin every reducer end-to-end (open / close / activate / reorder
// / scroll / collapse / resize / reset / fluid / persistence
// forward-compat), so a regression in this module surfaces before
// the renderer can ship dead wiring.

import type { PanelKind } from "./persist";

/**
 * The surface tab kinds. Each kind belongs to exactly one column —
 * see `columnRoleForKind` below.
 *
 * Slice 17 expanded the surface vocabulary beyond slice 15's four:
 * `search` and `plugins` joined the tree column so the sidebar's
 * top-level nav entries ("搜索", "插件") actually render somewhere.
 * Both classify as tree-column surfaces (the column is the
 * "navigation / listing surface") — `search` shows the in-product
 * search pane and `plugins` shows the marketplace placeholder the
 * engine will fill in once the plugin-install contract lands.
 *
 *   files, git, tasks, search, plugins → tree column (column 4)
 *   browser, file:<path>               → preview column (column 3)
 *
 * The mental model: column 3 is "what I'm looking at", column 4
 * is "what I'm navigating through".
 */
export type SurfaceTabKind =
  | "files"
  | "git"
  | "browser"
  | "tasks"
  | "search"
  | "plugins";

export const SURFACE_TAB_KINDS: ReadonlyArray<SurfaceTabKind> = [
  "files",
  "git",
  "browser",
  "tasks",
  "search",
  "plugins",
] as const;

export function isSurfaceTabKind(value: unknown): value is SurfaceTabKind {
  return typeof value === "string" && (SURFACE_TAB_KINDS as ReadonlyArray<string>).includes(value);
}

/**
 * Which column a surface or file tab belongs to.
 *
 *   preview column → file:<path> | browser
 *   tree column    → files | git | tasks | search | plugins
 *
 * Mental model from the ticket:
 *   - Column 3 = **viewing surface** (file preview / browser)
 *   - Column 4 = **navigation / listing surface** (tree / git /
 *     tasks / search / plugins)
 */
export type ColumnRole = "preview" | "tree";

export function columnRoleForKind(kind: SurfaceTabKind | "file"): ColumnRole {
  // Single source of truth: the surface kinds that belong to
  // the preview column. File tabs are always preview. Any new
  // surface kind added to SURFACE_TAB_KINDS is presumed to be a
  // tree surface unless added to this allow-list.
  if (kind === "browser" || kind === "file") return "preview";
  return "tree";
}

export function isPreviewSurface(kind: SurfaceTabKind): boolean {
  return columnRoleForKind(kind) === "preview";
}

export function isTreeSurface(kind: SurfaceTabKind): boolean {
  return columnRoleForKind(kind) === "tree";
}

/**
 * One tab in the strip. File tabs carry a scroll position so a
 * refresh restores the user's place in a long file. The id is
 * stable across reorders / closes; a surface tab's id is its
 * kind, a file tab's id is `file:<path>`.
 */
export type WorkspaceTab =
  | {
      id: SurfaceTabKind;
      kind: SurfaceTabKind;
    }
  | {
      id: `file:${string}`;
      kind: "file";
      path: string;
      /** Last persisted scroll position for this file tab. */
      scrollTop: number;
      /** File name for the tab label / breadcrumb. */
      name: string;
    };

/** Build a surface tab descriptor. The kind and id are deliberately the same. */
export function surfaceTab(kind: SurfaceTabKind): WorkspaceTab {
  return { id: kind, kind };
}

/** Build a file-tab descriptor from a path. The id is `file:<path>`. */
export function fileTabFromPath(path: string, scrollTop = 0): WorkspaceTab {
  return {
    id: `file:${path}`,
    kind: "file",
    path,
    scrollTop,
    name: basename(path),
  };
}

export function basename(path: string): string {
  if (!path) return "";
  const stripped = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const i = stripped.lastIndexOf("/");
  return i === -1 ? stripped : stripped.slice(i + 1);
}

/**
 * The tab-strip state.
 *
 * Two active ids: one per right-hand column. The single
 * `activeId` from slice 15 split into `previewActiveId` and
 * `treeActiveId` so each column has its own focus — opening a
 * tree surface does not yank the preview column away from the
 * file the user is reading. File scroll positions persist per
 * file tab id (unchanged from slice 15).
 */
export interface TabStripState {
  /** Ordered list of open tabs (rendered in declaration order;
   *  re-opening a tab moves it to the end via the openTab reducer). */
  tabs: WorkspaceTab[];
  /** Preview column's active tab id. `null` when no preview tab exists. */
  previewActiveId: string | null;
  /** Tree column's active tab id. `null` when no tree tab exists. */
  treeActiveId: string | null;
  /** True when the launcher popover is open. Owned here so refresh
   *  can restore "launcher was open" without losing the strip
   *  state — the popover is ephemeral UI, so this lives outside
   *  the persisted payload. */
  launcherOpen: boolean;
}

/** The default empty strip — no tabs, no active, launcher closed. */
export const DEFAULT_TAB_STRIP: TabStripState = {
  tabs: [],
  previewActiveId: null,
  treeActiveId: null,
  launcherOpen: false,
};

// --- tab strip reducers -----------------------------------------------------

/**
 * Open a tab. If a tab of the same kind (surfaces) or the same path
 * (file tabs) is already open, activate it instead of duplicating.
 *
 * The matching active id (`previewActiveId` or `treeActiveId`)
 * moves to the new tab so the user sees the change immediately.
 *
 * Returns a NEW state object — never mutates.
 */
export function openTab(state: TabStripState, tab: WorkspaceTab): TabStripState {
  const existingIndex = state.tabs.findIndex((existing) => existing.id === tab.id);
  const role = columnRoleForKind(tab.kind);
  if (existingIndex >= 0) {
    // Move-to-end semantics: re-opening the same tab promotes it
    // to the most-recent slot AND makes the matching column's
    // active id point at it. Mirrors the way the user expects a
    // tab strip to behave — clicking the file row should bring
    // that file's tab to the front in the preview column.
    const next = state.tabs.slice();
    const [moved] = next.splice(existingIndex, 1);
    next.push(moved!);
    return {
      ...state,
      tabs: next,
      previewActiveId: role === "preview" ? moved!.id : state.previewActiveId,
      treeActiveId: role === "tree" ? moved!.id : state.treeActiveId,
      launcherOpen: false,
    };
  }
  return {
    ...state,
    tabs: [...state.tabs, tab],
    previewActiveId: role === "preview" ? tab.id : state.previewActiveId,
    treeActiveId: role === "tree" ? tab.id : state.treeActiveId,
    launcherOpen: false,
  };
}

/**
 * Close a tab by id. Closes the matching tab; if it was the
 * active tab for its column, picks a neighbour in the SAME column
 * as the new active (next, then previous). Empty strips yield
 * `previewActiveId: null` and `treeActiveId: null` as
 * appropriate.
 */
export function closeTab(state: TabStripState, id: string): TabStripState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.slice();
  const [removed] = tabs.splice(index, 1);
  const removedRole = columnRoleForKind(removed!.kind);
  let previewActiveId = state.previewActiveId;
  let treeActiveId = state.treeActiveId;
  if (removedRole === "preview" && state.previewActiveId === id) {
    previewActiveId = pickNeighbour(tabs, "preview", index);
  } else if (removedRole === "tree" && state.treeActiveId === id) {
    treeActiveId = pickNeighbour(tabs, "tree", index);
  }
  return {
    ...state,
    tabs,
    previewActiveId,
    treeActiveId,
  };
}

/**
 * Pick the new active id for a column after a tab close. Prefers
 * the tab at the SAME index (the next tab slides into the closed
 * one's slot), falling back to the previous tab. Falls through to
 * `null` when no tab in the column remains.
 */
function pickNeighbour(tabs: WorkspaceTab[], role: ColumnRole, closedIndex: number): string | null {
  let chosen: WorkspaceTab | undefined;
  for (let i = closedIndex; i < tabs.length; i += 1) {
    const candidate = tabs[i]!;
    if (columnRoleForKind(candidate.kind) === role) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen) {
    for (let i = closedIndex - 1; i >= 0; i -= 1) {
      const candidate = tabs[i]!;
      if (columnRoleForKind(candidate.kind) === role) {
        chosen = candidate;
        break;
      }
    }
  }
  return chosen ? chosen.id : null;
}

/**
 * Activate a tab by id. Sets the matching column's active id; the
 * other column's active id is untouched. No-op if the id is
 * unknown.
 */
export function activateTab(state: TabStripState, id: string): TabStripState {
  const target = state.tabs.find((tab) => tab.id === id);
  if (!target) return state;
  const role = columnRoleForKind(target.kind);
  if (role === "preview" && state.previewActiveId === id) return state;
  if (role === "tree" && state.treeActiveId === id) return state;
  if (role === "preview") {
    return { ...state, previewActiveId: id };
  }
  return { ...state, treeActiveId: id };
}

/**
 * Reorder the tab at `from` to a new position. The semantics
 * mirror a typical drag-reorder: the moved tab lands at the
 * requested target index in the post-move list (so dragging
 * the first tab to position 2 lands it at index 2, not before
 * whatever was at index 2). Active ids are preserved.
 *
 *   tabs = [A, B, C]; moveTab(0, 2) → [B, C, A]
 */
export function moveTab(state: TabStripState, from: number, to: number): TabStripState {
  if (from === to) return state;
  if (from < 0 || from >= state.tabs.length) return state;
  if (to < 0 || to > state.tabs.length) return state;
  const tabs = state.tabs.slice();
  const [moved] = tabs.splice(from, 1);
  // After the splice the array is shorter by one, so the target
  // index needs to be clamped to the new length to avoid an
  // "insert past the end" splice.
  const insertIndex = Math.min(to, tabs.length);
  tabs.splice(insertIndex, 0, moved!);
  return { ...state, tabs };
}

/**
 * Record the scroll position of a file tab. No-op for unknown tab
 * ids or for non-file tabs.
 */
export function recordFileTabScroll(state: TabStripState, id: string, scrollTop: number): TabStripState {
  if (id.startsWith("file:") !== true) return state;
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const existing = state.tabs[index];
  if (!existing || existing.kind !== "file") return state;
  if (existing.scrollTop === scrollTop) return state;
  const tabs = state.tabs.slice();
  tabs[index] = { ...existing, scrollTop };
  return { ...state, tabs };
}

/**
 * Set the launcher open / closed flag. Pure flag toggle.
 */
export function setLauncherOpen(state: TabStripState, open: boolean): TabStripState {
  if (state.launcherOpen === open) return state;
  return { ...state, launcherOpen: open };
}

/**
 * Drop every tab. Used by the "all tabs closed" path the user can
 * trigger, or by a future "close all" affordance. Active ids
 * collapse to null in both columns.
 */
export function resetTabs(): TabStripState {
  return { tabs: [], previewActiveId: null, treeActiveId: null, launcherOpen: false };
}

// --- column layout reducers -------------------------------------------------

/**
 * The four columns the desktop shell can show.
 *
 *   sidebar      — left rail (owned by AppShell / slice 07)
 *   conversation — chat area; the FLEXIBLE column (absorbs leftover)
 *   preview      — file preview / browser (the "viewing surface")
 *   tree         — file tree / git / tasks (the "navigation surface")
 *
 * Each column has its own width slot. Conversation carries a
 * user-draggable stored width (the divider that the user can
 * resize); the algorithm honours it within the [minWidth,
 * maxWidth] band and re-distributes overflow to the fixed
 * columns (preview, tree) before folding conversation as a
 * last resort.
 */
export type ColumnId = "sidebar" | "conversation" | "preview" | "tree";

/**
 * Whether a column is fluid. Fluid columns absorb the leftover
 * width after the fixed-pixel columns have claimed their
 * stored widths. Today only `conversation` is fluid; the others
 * are fixed-pixel. The column layout algorithm in
 * `computeColumnLayout` reads each column's stored width,
 * clamps to its [min, max] band, then re-distributes overflow
 * / leftover across the row.
 */
export type ColumnFlow = "fixed" | "fluid";

export interface ColumnSpec {
  id: ColumnId;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  flow: ColumnFlow;
}

export const COLUMN_SPECS: Record<ColumnId, ColumnSpec> = {
  // Session sidebar — owned by AppShell. minWidth 220 keeps the
  // session rows legible at the smallest size; maxWidth 400 caps
  // a user that drags it very wide.
  sidebar: { id: "sidebar", defaultWidth: 240, minWidth: 220, maxWidth: 400, flow: "fixed" },
  // Conversation is the **elastic** column — it absorbs whatever
  // slack is left after the fixed columns have claimed their
  // preferred widths. Per the user's priority, the chat column
  // compresses as far as 280 at 1280 to keep both feature
  // columns (preview + tree) fully visible. The reference image
  // (`refs/ui/02-workspace-shell.jpg` at 1384 viewport) shows
  // the chat column at ~322 — narrow but the user is reading a
  // file, not chatting.
  //
  // Slice 25 — the slice-17 cap of 768 produced a 250–280px
  // dead band on every viewport above ~1500px because the chat
  // content carried the same 768 cap. The reporter judged this
  // unacceptable; the column now absorbs ALL leftover up to a
  // high absolute ceiling (1400px) so typical viewports
  // (1280–1920) leave no dead band. 1400 is the chosen ceiling
  // because it sits well above the 768 default — every common
  // desktop viewport fills the row — while still bounding line
  // length at the edge of readability; the user accepted long
  // lines (~1000px+) as a consequence. Above ~1640 container
  // width the ceiling bites and a residual dead band remains;
  // that is the cost of the bound.
  conversation: { id: "conversation", defaultWidth: 720, minWidth: 280, maxWidth: 1400, flow: "fluid" },
  // Preview column — file preview + browser. Per user direction
  // (preview ≪ tree ≪ chat in importance, but preview > chat
  // when the row truly has no room), the preview column folds
  // FIRST when the row would overflow; the tree stays on screen
  // until preview has reached its minimum.
  preview: { id: "preview", defaultWidth: 400, minWidth: 320, maxWidth: 720, flow: "fixed" },
  // Tree column — file tree + git + tasks. Per user direction,
  // the tree column folds SECOND (after preview) when the row
  // would overflow; the chat column folds last, never the sidebar
  // (chrome).
  tree: { id: "tree", defaultWidth: 340, minWidth: 320, maxWidth: 600, flow: "fixed" },
};

/** Visibility / collapsed flags for every column. */
export interface ColumnLayoutState {
  /** User-resized widths. For fixed columns this is the rendered
   *  width (modulo clamping). For the fluid column it is the
   *  **target / preferred** width — the rendered width is
   *  computed from the leftover after the fixed columns have
   *  claimed theirs. */
  widths: Record<ColumnId, number>;
  /** Collapsed flags. `true` means the column is hidden from the
   *  flex row (the column's space collapses to 0).
   *
   *  Slice 21 — on-demand columns. The `preview` and `tree`
   *  flags are derived from the tab strip state at runtime (a
   *  column is open iff at least one tab in the matching role
   *  exists). The page wraps every tab reducer so a column
   *  auto-closes when its last tab closes and reopens when a
   *  tab is opened in it. The deserializer normalises a stale
   *  "column open but empty" payload to closed. */
  collapsed: Record<ColumnId, boolean>;
}

export const DEFAULT_COLUMN_LAYOUT: ColumnLayoutState = {
  widths: {
    sidebar: COLUMN_SPECS.sidebar.defaultWidth,
    conversation: COLUMN_SPECS.conversation.defaultWidth,
    preview: COLUMN_SPECS.preview.defaultWidth,
    tree: COLUMN_SPECS.tree.defaultWidth,
  },
  collapsed: {
    // Sidebar is OWNED by AppShell (slice 07), not by
    // WorkspaceColumns. Marking it collapsed makes the
    // WorkspaceColumns wrapper allocate zero width for it
    // instead of reserving 220-400px for a slot that always
    // renders `null`. AppShell's own sidebar still appears on
    // screen because it is rendered outside this wrapper.
    sidebar: true,
    conversation: false,
    // Slice 21 — preview and tree start **closed**. The
    // on-demand model says a column appears only when it has
    // content; on first paint (no tabs) both are empty, so
    // both are hidden. `syncColumnVisibility` is the source
    // of truth: the deserializer + the page reducer wrappers
    // re-derive these flags from the tab strip on every
    // change, so a stale payload cannot resurrect an empty
    // column.
    preview: true,
    tree: true,
  },
};

/**
 * Clamp a width to its column's [min, max] bounds.
 */
export function clampWidth(column: ColumnId, width: number): number {
  const spec = COLUMN_SPECS[column];
  if (!Number.isFinite(width)) return spec.defaultWidth;
  return Math.min(spec.maxWidth, Math.max(spec.minWidth, Math.round(width)));
}

/**
 * Set a column width (clamped). No-op when the new clamped value
 * matches the existing one.
 */
export function setColumnWidth(state: ColumnLayoutState, column: ColumnId, width: number): ColumnLayoutState {
  const next = clampWidth(column, width);
  if (state.widths[column] === next) return state;
  return {
    ...state,
    widths: { ...state.widths, [column]: next },
  };
}

/**
 * Reset a single column width to its default.
 */
export function resetColumnWidth(state: ColumnLayoutState, column: ColumnId): ColumnLayoutState {
  const spec = COLUMN_SPECS[column];
  return setColumnWidth(state, column, spec.defaultWidth);
}

/** Reset every column to its default width. Collapsed flags are
 *  preserved so a "reset widths" gesture does not blow away the
 *  user's collapsed choices. */
export function resetAllColumnWidths(state: ColumnLayoutState): ColumnLayoutState {
  return {
    ...state,
    widths: {
      sidebar: COLUMN_SPECS.sidebar.defaultWidth,
      conversation: COLUMN_SPECS.conversation.defaultWidth,
      preview: COLUMN_SPECS.preview.defaultWidth,
      tree: COLUMN_SPECS.tree.defaultWidth,
    },
  };
}

/**
 * Set the collapsed flag for a column. The sidebar's collapsed
 * state is mirrored from shell.tsx (slice 07 owns the persisted
 * source of truth); slice 17 only writes it through to keep the
 * layout payload self-consistent.
 *
 * Slice 21 — the `preview` and `tree` flags are normally driven
 * by `syncColumnVisibility` from the tab strip. This setter is
 * kept exported so a test can pin the flag directly, but the
 * page-level reducer wrappers do not call it.
 */
export function setColumnCollapsed(state: ColumnLayoutState, column: ColumnId, collapsed: boolean): ColumnLayoutState {
  if (state.collapsed[column] === collapsed) return state;
  return {
    ...state,
    collapsed: { ...state.collapsed, [column]: collapsed },
  };
}

/**
 * Slice 21 — does the given tab strip have at least one tab that
 * belongs to the preview column? (file:<path> + browser)
 *
 * Pure predicate; the page-level reducer wrappers read this to
 * decide whether the preview column should be visible.
 */
export function hasPreviewTabs(state: TabStripState): boolean {
  for (const tab of state.tabs) {
    if (columnRoleForKind(tab.kind) === "preview") return true;
  }
  return false;
}

/**
 * Slice 21 — does the given tab strip have at least one tab that
 * belongs to the tree column? (files / git / tasks / search /
 * plugins)
 *
 * Pure predicate; the page-level reducer wrappers read this to
 * decide whether the tree column should be visible.
 */
export function hasTreeTabs(state: TabStripState): boolean {
  for (const tab of state.tabs) {
    if (columnRoleForKind(tab.kind) === "tree") return true;
  }
  return false;
}

/**
 * Slice 21 — sync a column layout to match the tab strip.
 *
 * Rules:
 *   - The preview column is visible iff the tab strip has at
 *     least one preview-role tab (file:<path> / browser).
 *   - The tree column is visible iff the tab strip has at least
 *     one tree-role tab (files / git / tasks / search / plugins).
 *   - The sidebar's collapsed flag is owned by AppShell — we
 *     never touch it.
 *   - The conversation column never folds.
 *   - The stored widths stay as the user set them so a column
 *     that was closed and then reopens restores the prior drag.
 *
 * Pure reducer: returns the input unchanged if the flags already
 * match, otherwise a new layout object with the matching flags.
 */
export function syncColumnVisibility(
  tabStrip: TabStripState,
  layout: ColumnLayoutState,
): ColumnLayoutState {
  const previewOpen = hasPreviewTabs(tabStrip);
  const treeOpen = hasTreeTabs(tabStrip);
  const nextPreviewCollapsed = !previewOpen;
  const nextTreeCollapsed = !treeOpen;
  if (
    layout.collapsed.preview === nextPreviewCollapsed &&
    layout.collapsed.tree === nextTreeCollapsed
  ) {
    return layout;
  }
  return {
    ...layout,
    collapsed: {
      ...layout.collapsed,
      preview: nextPreviewCollapsed,
      tree: nextTreeCollapsed,
    },
  };
}

// --- layout compute ---------------------------------------------------------

/**
 * One segment of the rendered column row. The page-level renderer
 * maps each segment to a `<aside>` / `<main>` / `<section>` with the
 * given width. Hidden segments carry `visible: false` and a `width`
 * of 0 so the flex layout never reserves space for a collapsed
 * column.
 */
export interface ColumnSegment {
  id: ColumnId;
  width: number;
  visible: boolean;
}

export interface ColumnLayoutSummary {
  /** All four columns in DOM order — the renderer hides collapsed
   *  ones via `visible: false`, never by removing them, so the
   *  keyboard order stays stable. */
  segments: ColumnSegment[];
  /** True when the layout had to fold a column to fit. */
  narrowed: boolean;
}

// --- layout compute ---------------------------------------------------------

/**
 * Pure layout fold.
 *
 * Inputs:
 *   - `layout`         — user widths + collapsed flags
 *   - `containerWidth` — total px available for the column row
 *   - `viewportWidth`  — browser's window.innerWidth equivalent
 *
 * Policy (slice 17, per user direction — preview and tree stay
 * on screen even at 1280):
 *
 *   1. Each column starts at its stored width (clamped to its
 *      [min, max] band). The conversation column is *not* a
 *      pure leftover of the fixed columns; it carries a stored
 *      width the user can drag (this is what slice 15's
 *      "write-only divider" bug was about). The drag now
 *      genuinely drives the layout: dragging the conversation
 *      divider changes `widths.conversation`, and the algorithm
 *      below re-distributes the slack among all four columns.
 *   2. If the row would overflow after honouring every stored
 *      width, fixed columns shrink toward their minimums in the
 *      order **preview → tree**. The tree is the user's pinned
 *      feature column and folds LAST (after preview). Sidebar is
 *      AppShell chrome and never folds inside the wrapper.
 *   3. If still overflow after fixed folds, the conversation
 *      column shrinks toward its minimum (280). The chat content
 *      is the most elastic — it can read at 280px and gracefully
 *      degrades below that.
 *   4. If the row has leftover after every column hits its
 *      stored width, fixed columns grow toward their maximums
 *      in the priority **tree → preview** (the fold priority
 *      reversed). A *collapsed* fixed column does NOT absorb
 *      leftover — it stays at 0 and the leftover flows past it
 *      so the conversation column can grow instead.
 *   5. After the fixed columns have absorbed what they can, the
 *      conversation column absorbs whatever leftover remains.
 *      Slice 25 — the column always absorbs all leftover; the
 *      effective max is `COLUMN_SPECS.conversation.maxWidth`
 *      (1400px) when at least one fixed column is visible, and
 *      is lifted to `conversation + leftover` (unbounded in this
 *      branch) when **both** fixed columns are folded so the
 *      idle row fills the container even on extreme viewports.
 *      1400 is the absolute ceiling chosen to bound line length
 *      at the edge of readability; above ~1640 container width
 *      a residual dead band remains at the row's right edge —
 *      the cost of the bound. Slice 17's 768 cap was the
 *      original dead-gutter defence; slice 25 raises the bound
 *      so typical desktop viewports (1280–1920) leave no dead
 *      band.
 *   6. Last resort: when the sum of every column's minimum is
 *      still bigger than the container (e.g. 360px viewport),
 *      conversation shrinks toward 0. The renderer hides
 *      zero-width conversation so the chat content disappears
 *      rather than overflowing.
 */
export function computeColumnLayout(
  layout: ColumnLayoutState,
  containerWidth: number,
  viewportWidth: number,
): ColumnLayoutSummary {
  void viewportWidth; // reserved for future auto-collapse ladder

  // 1. Each column starts at its stored width. Conversation's
  //    stored width is the user's drag target; the algorithm
  //    honours it within the [280, 1400] band and re-distributes
  //    any overflow / leftover to / from the fixed columns.
  let conversation = clampToConversation(layout.widths.conversation);
  let preview = layout.collapsed.preview ? 0 : clampWidth("preview", layout.widths.preview);
  let tree = layout.collapsed.tree ? 0 : clampWidth("tree", layout.widths.tree);
  // The sidebar lives in AppShell, not WorkspaceColumns. The
  // wrapper always sees 0 here so its algorithm does not
  // re-allocate chrome width that the shell owns. (The
  // `collapsed.sidebar` flag is forced to true on deserialize
  // — see `deserializeColumnLayout` — and AppShell reads its own
  // width from its own state.)
  const sidebar = 0;
  let narrowed = false;

  // 2. Fold fixed columns preview → tree if the row overflows.
  //    The user's drag on the conversation divider may have
  //    pushed conv wide; we honour that target by squeezing
  //    preview/tree first.
  let total = sidebar + conversation + preview + tree;
  if (total > containerWidth) {
    let remaining = total - containerWidth;
    const fromPreview = shrinkTowardMinimum("preview", preview, remaining);
    preview -= fromPreview;
    remaining -= fromPreview;
    if (remaining > 0) {
      const fromTree = shrinkTowardMinimum("tree", tree, remaining);
      tree -= fromTree;
      remaining -= fromTree;
    }
    if (remaining > 0) {
      // Last resort for the fixed columns: shrink conversation
      // toward its minimum. Honour the user's conv target if
      // there's room; only fold conv below min as a final
      // overflow shed.
      const fromConv = Math.min(
        conversation - COLUMN_SPECS.conversation.minWidth,
        remaining,
      );
      conversation -= Math.max(0, fromConv);
      remaining -= Math.max(0, fromConv);
    }
    if (remaining > 0) {
      // Last resort: conversation shrinks below its minimum.
      // The renderer hides zero-width conversation so the chat
      // content disappears rather than overflowing.
      conversation = Math.max(0, conversation - remaining);
      remaining = 0;
    }
    narrowed = true;
    total = sidebar + conversation + preview + tree;
  }

  // 3. Has leftover. Fixed columns grow toward their maxes in
  //    the priority **tree → preview** (the fold priority
  //    reversed). A collapsed fixed column is a no-op here —
  //    its width stays at 0 and the leftover flows past it so
  //    the conversation column can absorb it instead. This is
  //    the slice-21 idle path: at 1280 with both columns
  //    folded, the conversation column takes the whole
  //    remainder (1040 = 1280 − 240).
  if (total < containerWidth) {
    let leftover = containerWidth - total;
    if (!layout.collapsed.tree) {
      const treeGrow = growTowardMaximum("tree", tree, leftover);
      tree += treeGrow;
      leftover -= treeGrow;
    }
    if (!layout.collapsed.preview) {
      const previewGrow = growTowardMaximum("preview", preview, leftover);
      preview += previewGrow;
      leftover -= previewGrow;
    }
    if (leftover > 0) {
      // Slice 25 — conversation absorbs ALL leftover. When at
      // least one fixed column is visible, the absorption is
      // capped at `COLUMN_SPECS.conversation.maxWidth` (1400),
      // the absolute ceiling chosen for this slice. When both
      // fixed columns are folded, conversation's effective max
      // is lifted to `conversation + leftover` so the idle row
      // always fills the container — even at extreme viewports
      // where the bounded branch would leave a residual dead
      // band. Long line length is an accepted consequence at
      // wide viewports.
      const convMax =
        layout.collapsed.preview && layout.collapsed.tree
          ? conversation + leftover
          : COLUMN_SPECS.conversation.maxWidth;
      const convGrow = Math.max(0, Math.min(convMax - conversation, leftover));
      conversation += convGrow;
      leftover -= convGrow;
    }
    // Any remaining leftover is shed (the row centres rather
    // than overflows). At very large viewports with at least
    // one fixed column visible this happens when conversation
    // hits its 1400 ceiling — a residual dead band, the cost
    // of bounding line length.
  }

  // 4. Sort segment order to match DOM order regardless of which
  //    columns are visible. The renderer walks this array
  //    top-down.
  const segmentIds: ColumnId[] = ["sidebar", "conversation", "preview", "tree"];
  const visibleMap: Record<ColumnId, boolean> = {
    sidebar: !layout.collapsed.sidebar,
    conversation: true,
    preview: !layout.collapsed.preview,
    tree: !layout.collapsed.tree,
  };
  const segments: ColumnSegment[] = segmentIds.map((id) => ({
    id,
    width:
      id === "sidebar"
        ? sidebar
        : id === "preview"
          ? preview
          : id === "tree"
            ? tree
            : conversation,
    visible: visibleMap[id] && widthOf(id, preview, tree, conversation) > 0,
  }));

  return { segments, narrowed };
}

function clampToConversation(width: number): number {
  return Math.min(
    COLUMN_SPECS.conversation.maxWidth,
    Math.max(0, Math.max(COLUMN_SPECS.conversation.minWidth, width)),
  );
}

function shrinkTowardMinimum(column: ColumnId, current: number, requested: number): number {
  const spec = COLUMN_SPECS[column];
  return Math.max(0, Math.min(current - spec.minWidth, requested));
}

function growTowardMaximum(column: ColumnId, current: number, requested: number): number {
  const spec = COLUMN_SPECS[column];
  return Math.max(0, Math.min(spec.maxWidth - current, requested));
}

function widthOf(id: ColumnId, preview: number, tree: number, conversation: number): number {
  if (id === "sidebar") return 0;
  if (id === "preview") return preview;
  if (id === "tree") return tree;
  return conversation;
}

// --- combined state ---------------------------------------------------------

/**
 * Slice-17 combined state — tabs + column layout. The page-level
 * reducer combines the two halves through `applyTabAction` and
 * `applyColumnAction`. The two are independent (you can resize a
 * column without touching the tab strip) so the page wires them
 * through separate code paths.
 */
export interface WorkspaceTabsState {
  tabStrip: TabStripState;
  columnLayout: ColumnLayoutState;
}

export const DEFAULT_WORKSPACE_TABS_STATE: WorkspaceTabsState = {
  tabStrip: DEFAULT_TAB_STRIP,
  columnLayout: DEFAULT_COLUMN_LAYOUT,
};

// --- serialization ----------------------------------------------------------

/**
 * Wire shape persisted under `webui:workspace-tabs:v1:<cid>`.
 *
 * Two top-level keys: `tabs` (the tab strip state) and `layout`
 * (the column layout state). Each is its own payload so a future
 * bump to either shape only invalidates the matching sub-payload.
 *
 * Versioning: bump WORKSPACE_TABS_VERSION when adding an
 * incompatible field. Adding a new optional field is OK without a
 * bump; the deserializer falls back to defaults for unknown
 * fields. Slice 17 keeps `WORKSPACE_TABS_VERSION = 1` and adds
 * `previewActiveId` / `treeActiveId` alongside the existing
 * `activeId` (the old single active id is read on the legacy path
 * and ignored once both new fields are present — the persistence
 * payload stays forward-compatible).
 */
export interface SerializedWorkspaceTabs {
  version: 1;
  cid: string;
  tabs: SerializedTabStrip;
  layout: SerializedColumnLayout;
}

export interface SerializedTabStrip {
  /** Tab ids in declaration order. Each id is enough to rebuild a
   *  descriptor (surface tabs are `kind`s, file tabs are
   *  `file:<path>`). */
  tabs: string[];
  /** Preview column's active tab id. Slice 17 introduced this
   *  field; older payloads only carry the legacy `activeId`
   *  which the deserializer maps into both column active ids. */
  previewActiveId: string | null;
  /** Tree column's active tab id. Slice 17 introduced this
   *  field; older payloads only carry the legacy `activeId`. */
  treeActiveId: string | null;
  /** Legacy single-active id from slice 15. Kept in the wire
   *  shape for forward-compat readers that still expect it; the
   *  slice-17 writer always writes the two new fields and clears
   *  this one. */
  activeId: string | null;
  /** Per-file-tab scroll positions. Only present when at least one
   *  file tab existed at save time. */
  fileScrolls: Record<string, number>;
}

export interface SerializedColumnLayout {
  widths: Record<ColumnId, number>;
  collapsed: Record<ColumnId, boolean>;
}

export const WORKSPACE_TABS_VERSION = 1;

/**
 * Serialize the state to the wire shape. Pure function; no
 * localStorage. The page-level writer in `lib/persist.ts` adds
 * the debounce + best-effort storage.
 */
export function serializeWorkspaceTabs(
  state: WorkspaceTabsState,
  cid: string,
): SerializedWorkspaceTabs {
  const tabs: string[] = state.tabStrip.tabs.map((tab) => tab.id);
  const fileScrolls: Record<string, number> = {};
  for (const tab of state.tabStrip.tabs) {
    if (tab.kind === "file" && tab.scrollTop > 0) {
      fileScrolls[tab.id] = tab.scrollTop;
    }
  }
  return {
    version: WORKSPACE_TABS_VERSION,
    cid,
    tabs: {
      tabs,
      previewActiveId: state.tabStrip.previewActiveId,
      treeActiveId: state.tabStrip.treeActiveId,
      activeId: state.tabStrip.previewActiveId ?? state.tabStrip.treeActiveId ?? null,
      fileScrolls,
    },
    layout: {
      widths: { ...state.columnLayout.widths },
      collapsed: { ...state.columnLayout.collapsed },
    },
  };
}

interface RawTab {
  id: string;
  kind: SurfaceTabKind | "file";
  path?: string;
  scrollTop?: number;
  name?: string;
}

/**
 * Deserialize a raw payload back to the in-memory state. Returns
 * the default state on every error path (garbage input, version
 * mismatch, cid mismatch, unknown tab id) — the page-level
 * `readUiState`-equivalent in persist.ts is the single point that
 * decides whether to use the deserialized or default value.
 *
 * Forward-compat: a payload written by slice 15 (single
 * `activeId`, columns named `panel`/`secondary`) must NOT crash
 * the page. The reader:
 *
 *   - Drops unknown column ids silently and falls back to the
 *     column's default width.
 *   - Maps the legacy single `activeId` into the slice-17 two
 *     active ids by role.
 *   - Coerces garbage values to defaults.
 */
export function deserializeWorkspaceTabs(
  raw: string | null | undefined,
  cid: string | null | undefined,
): WorkspaceTabsState {
  if (!raw) return cloneDefaultWorkspaceTabsState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cloneDefaultWorkspaceTabsState();
  }
  if (!parsed || typeof parsed !== "object") return cloneDefaultWorkspaceTabsState();
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== WORKSPACE_TABS_VERSION) return cloneDefaultWorkspaceTabsState();
  if (typeof cid === "string" && cid.length > 0 && typeof obj.cid === "string" && obj.cid !== cid) {
    return cloneDefaultWorkspaceTabsState();
  }
  const tabStrip = deserializeTabStrip(obj.tabs);
  const columnLayout = syncColumnVisibility(tabStrip, deserializeColumnLayout(obj.layout));
  return { tabStrip, columnLayout };
}

function cloneDefaultWorkspaceTabsState(): WorkspaceTabsState {
  // Slice 21 — sync the default layout against the empty tab
  // strip so a fresh install lands in the slice-21 idle state
  // (both on-demand columns hidden). Without this, the
  // defaults would carry the stale slice-17 `preview:false,
  // tree:false` flags until the next tab reducer re-synced them
  // — and on first paint the page would briefly show two
  // empty columns before the sync kicked in.
  const tabStrip: TabStripState = {
    tabs: [...DEFAULT_TAB_STRIP.tabs],
    previewActiveId: DEFAULT_TAB_STRIP.previewActiveId,
    treeActiveId: DEFAULT_TAB_STRIP.treeActiveId,
    launcherOpen: DEFAULT_TAB_STRIP.launcherOpen,
  };
  return {
    tabStrip,
    columnLayout: syncColumnVisibility(tabStrip, cloneDefaultColumnLayout()),
  };
}

function deserializeTabStrip(raw: unknown): TabStripState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TAB_STRIP };
  const obj = raw as Record<string, unknown>;
  const ids = Array.isArray(obj.tabs) ? obj.tabs.filter((t): t is string => typeof t === "string") : [];
  const fileScrolls = obj.fileScrolls && typeof obj.fileScrolls === "object"
    ? (obj.fileScrolls as Record<string, unknown>)
    : {};
  const tabs: WorkspaceTab[] = [];
  for (const id of ids) {
    const tab = deserializeTabId(id, fileScrolls);
    if (tab) tabs.push(tab);
  }
  // Forward-compat: read the new two active ids if present, else
  // fall back to the legacy single `activeId` and map by role.
  let previewActiveId = typeof obj.previewActiveId === "string" ? obj.previewActiveId : null;
  let treeActiveId = typeof obj.treeActiveId === "string" ? obj.treeActiveId : null;
  if (previewActiveId && !tabs.some((tab) => tab.id === previewActiveId)) previewActiveId = null;
  if (treeActiveId && !tabs.some((tab) => tab.id === treeActiveId)) treeActiveId = null;
  if (!previewActiveId && !treeActiveId && typeof obj.activeId === "string") {
    // Legacy payload — single `activeId` covers both columns.
    // Map by role so the preview column shows a preview tab and
    // the tree column shows a tree tab (each falls back to the
    // other's last tab when no compatible tab exists).
    const legacy = obj.activeId;
    const tab = tabs.find((entry) => entry.id === legacy);
    if (tab) {
      if (columnRoleForKind(tab.kind) === "preview") previewActiveId = legacy;
      else treeActiveId = legacy;
    }
  }
  // Final fall-back: if either active id is still null but the
  // column has at least one tab, point it at the most recent tab
  // in that column. The renderer uses `find(...)` to skip the id
  // when it doesn't match, but pointing at a known id avoids the
  // "no tab in the list" / "tab list has tabs but no active id"
  // drift that confused the slice-15 user.
  if (!previewActiveId) previewActiveId = lastTabOfRole(tabs, "preview");
  if (!treeActiveId) treeActiveId = lastTabOfRole(tabs, "tree");
  return {
    tabs,
    previewActiveId,
    treeActiveId,
    launcherOpen: false,
  };
}

function lastTabOfRole(tabs: WorkspaceTab[], role: ColumnRole): string | null {
  for (let i = tabs.length - 1; i >= 0; i -= 1) {
    const tab = tabs[i]!;
    if (columnRoleForKind(tab.kind) === role) return tab.id;
  }
  return null;
}

function deserializeTabId(id: string, fileScrolls: Record<string, unknown>): WorkspaceTab | null {
  if (id.startsWith("file:")) {
    const path = id.slice("file:".length);
    if (!path) return null;
    const scrollTop = typeof fileScrolls[id] === "number" && Number.isFinite(fileScrolls[id])
      ? Math.max(0, fileScrolls[id] as number)
      : 0;
    return fileTabFromPath(path, scrollTop);
  }
  if (isSurfaceTabKind(id)) {
    return surfaceTab(id);
  }
  return null;
}

function deserializeColumnLayout(raw: unknown): ColumnLayoutState {
  // Forward-compat: when the payload is missing the new column
  // ids (e.g. a slice-15 payload has `panel`/`secondary` instead
  // of `preview`/`tree`), every column falls back to its default.
  if (!raw || typeof raw !== "object") return cloneDefaultColumnLayout();
  const obj = raw as Record<string, unknown>;
  const widths = rawWidths(obj.widths);
  const collapsed = rawCollapsed(obj.collapsed);
  // Force `collapsed.sidebar = true` regardless of what the
  // payload says. Slice 17 made AppShell the owner of the
  // session sidebar (it renders outside WorkspaceColumns); a
  // stale payload that names `sidebar` with `collapsed:false`
  // — which was slice 15's own default — would otherwise reserve
  // ~220px in the wrapper for a column that renders `null`,
  // crushing the chat column below its minimum and producing a
  // broken-looking window on upgrade. The persisted flag is
  // meaningless while AppShell owns the sidebar; clamp it on
  // read so legacy payloads cannot conjure a ghost column.
  collapsed.sidebar = true;
  return { widths, collapsed };
}

function rawWidths(raw: unknown): Record<ColumnId, number> {
  const defaults = DEFAULT_COLUMN_LAYOUT.widths;
  if (!raw || typeof raw !== "object") return { ...defaults };
  const obj = raw as Record<string, unknown>;
  const out: Record<ColumnId, number> = { ...defaults };
  for (const id of Object.keys(defaults) as ColumnId[]) {
    const value = obj[id];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[id] = clampWidth(id, value);
    }
  }
  return out;
}

function rawCollapsed(raw: unknown): Record<ColumnId, boolean> {
  const defaults = DEFAULT_COLUMN_LAYOUT.collapsed;
  if (!raw || typeof raw !== "object") return { ...defaults };
  const obj = raw as Record<string, unknown>;
  const out: Record<ColumnId, boolean> = { ...defaults };
  for (const id of Object.keys(defaults) as ColumnId[]) {
    const value = obj[id];
    if (typeof value === "boolean") out[id] = value;
  }
  return out;
}

function cloneDefaultColumnLayout(): ColumnLayoutState {
  return {
    widths: { ...DEFAULT_COLUMN_LAYOUT.widths },
    collapsed: { ...DEFAULT_COLUMN_LAYOUT.collapsed },
  };
}