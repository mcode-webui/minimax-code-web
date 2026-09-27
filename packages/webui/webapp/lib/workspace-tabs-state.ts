// webapp/lib/workspace-tabs-state.ts
//
// Slice 15 — pure state model for the DSH-style sidebar workspace
// (multi-tab panel column + draggable column layout).
//
// Two state slices share this module so the reducers can be
// reasoned about in one place and unit-tested without rendering:
//
//   1. **Tab strip** — the open tabs (file / git / browser / tasks /
//      file:<path>), the active tab id, per-file-tab scroll + reveal
//      markers. Reducers are `openTab`, `closeTab`, `activateTab`,
//      `moveTab` (reorder), `recordFileTabScroll`,
//      `setFileTabActiveFile` (file tab state — e.g. focus), and
//      `resetTabs`.
//
//   2. **Column layout** — three columns by default (sidebar /
//      conversation / panel) plus an optional secondary column that
//      hosts an extra surface (DSH shows a secondary panel for
//      file-tree + preview side-by-side). Reducers are
//      `setColumnWidth`, `resetColumnWidth`, `setColumnCollapsed`,
//      `setSecondaryColumn`, and the pure predicate
//      `computeColumnLayout` that folds the layout down to a list of
//      `{ column, width }` segments that drive the page-level flex.
//
// Why this lives in its own module. Every reducer here is a pure
// function on plain objects — no React, no DOM, no localStorage.
// The unit tests in `webapp/test/workspace-tabs-state.test.ts` pin
// every reducer end-to-end (open / close / activate / reorder /
// scroll / collapse / resize / reset), so a regression in this
// module surfaces before the renderer can ship dead wiring. The
// page.tsx wiring is a thin shell around these reducers and is
// covered by the live self-check; this file is the tripwire.

import type { PanelKind } from "./persist";

/**
 * The four "surface" tab kinds the renderer can spawn. The two
 * placeholder kinds (`btw` / `terminal`) are NOT in this enum — they
 * exist only as launcher entries, never as open tabs (a click on
 * them surfaces a "not implemented" hint rather than opening a
 * tab). `PanelKind` is the *historical* surface vocabulary from
 * pre-slice-15; surfaceTabKind is the slice-15 vocabulary.
 *
 * The renderer keeps the old `PanelKind` for one call site only —
 * the FilesPanel + GitPanel + BrowserPanel still exist as legacy
 * components that the right column hosts one at a time. Slice 15
 * composes them behind the tab strip; the kind vocabulary narrows
 * to what a tab actually is.
 */
export type SurfaceTabKind = Exclude<PanelKind, "workspace" | "search" | "progress" | "plugins" | "alerts"> | "tasks";

export const SURFACE_TAB_KINDS: ReadonlyArray<SurfaceTabKind> = ["files", "git", "browser", "tasks"] as const;

export function isSurfaceTabKind(value: unknown): value is SurfaceTabKind {
  return typeof value === "string" && (SURFACE_TAB_KINDS as ReadonlyArray<string>).includes(value);
}

/**
 * One tab in the strip. Surfaces carry no per-tab state (the
 * surface state lives in the surface's own component); file tabs
 * carry a scroll position so a refresh restores the user's place
 * in a long file. The id is stable across reorders / closes; a
 * surface tab's id is its kind, a file tab's id is `file:<path>`
 * (paths are unique within a workspace in practice — using the
 * raw path keeps the dedupe logic obvious).
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
 */
export interface TabStripState {
  /** Ordered list of open tabs (rendered in declaration order). */
  tabs: WorkspaceTab[];
  /** The active tab id. `null` only when the strip is empty. */
  activeId: string | null;
  /** True when the launcher popover is open. Owned here so refresh
   *  can restore "launcher was open" without losing the strip state
   *  — the popover is ephemeral UI, so this lives outside the
   *  persisted payload. */
  launcherOpen: boolean;
}

/** The default empty strip — no tabs, no active, launcher closed. */
export const DEFAULT_TAB_STRIP: TabStripState = {
  tabs: [],
  activeId: null,
  launcherOpen: false,
};

// --- tab strip reducers -----------------------------------------------------

/**
 * Open a tab. If a tab of the same kind (surfaces) or the same path
 * (file tabs) is already open, activate it instead of duplicating.
 * Returns a NEW state object — never mutates.
 */
export function openTab(state: TabStripState, tab: WorkspaceTab): TabStripState {
  const existingIndex = state.tabs.findIndex((existing) => existing.id === tab.id);
  if (existingIndex >= 0) {
    // Move-to-end semantics: re-opening the same tab promotes it to
    // the most-recent slot AND makes it active. Mirrors the way the
    // user expects a tab strip to behave — clicking the file row
    // should bring that file's tab to the front.
    const next = state.tabs.slice();
    const [moved] = next.splice(existingIndex, 1);
    next.push(moved!);
    return {
      ...state,
      tabs: next,
      activeId: moved!.id,
      launcherOpen: false,
    };
  }
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeId: tab.id,
    launcherOpen: false,
  };
}

/**
 * Close a tab by id. Closes the matching tab; if the active tab was
 * the one being closed, picks a neighbour (next, then previous) as
 * the new active. Empty strips yield `activeId: null`.
 */
export function closeTab(state: TabStripState, id: string): TabStripState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.slice();
  const [removed] = tabs.splice(index, 1);
  let activeId = state.activeId;
  if (state.activeId === id) {
    if (tabs.length === 0) {
      activeId = null;
    } else {
      // Prefer the tab at the SAME index (the next tab slides into
      // the closed one's slot), falling back to the previous one.
      const nextIndex = Math.min(index, tabs.length - 1);
      activeId = tabs[nextIndex]!.id;
    }
  }
  return {
    ...state,
    tabs,
    activeId,
  };
}

/**
 * Activate a tab by id. No-op if the id is unknown. The tabs order
 * is NOT changed — activation is independent of ordering.
 */
export function activateTab(state: TabStripState, id: string): TabStripState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  if (state.activeId === id) return state;
  return { ...state, activeId: id };
}

/**
 * Reorder the tab at `from` to a new position. The semantics
 * mirror a typical drag-reorder: the moved tab lands at the
 * requested target index in the post-move list (so dragging
 * the first tab to position 2 lands it at index 2, not before
 * whatever was at index 2). The active id is preserved.
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
 * trigger through the panel's collapse, or by a future "close all"
 * affordance. Active id collapses to null.
 */
export function resetTabs(): TabStripState {
  return { tabs: [], activeId: null, launcherOpen: false };
}

// --- column layout reducers -------------------------------------------------

/**
 * The four columns the desktop shell can show. Each column has its
 * own width slot; the secondary column is OFF by default (matches
 * the slice-15 acceptance criterion "最多四栏"). Conversational /
 * panel / secondary are user-resizable; the sidebar is owned by
 * shell.tsx (the slice-15 wiring does not change its draggable
 * behaviour — slice 07 owns the sidebar width and slice 15 keeps
 * its responsibility narrow to the panel column + the optional
 * fourth column).
 */
export type ColumnId = "sidebar" | "conversation" | "panel" | "secondary";

/** Per-column defaults and constraints. */
export interface ColumnSpec {
  id: ColumnId;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

export const COLUMN_SPECS: Record<ColumnId, ColumnSpec> = {
  sidebar: { id: "sidebar", defaultWidth: 240, minWidth: 240, maxWidth: 400 },
  // The conversation column is *content-bearing* (max-w-[768px] per
  // chat.tsx), so its effective range is wide enough to host the
  // 768px content column even on a narrow viewport. The conversation
  // column is owned by shell.tsx / slice 07 — slice 15 only persists
  // the value the user dragged to, not the sidebar's own semantics.
  conversation: { id: "conversation", defaultWidth: 768, minWidth: 480, maxWidth: 1280 },
  panel: { id: "panel", defaultWidth: 320, minWidth: 240, maxWidth: 640 },
  // Secondary column hosts an extra panel-tab-pair surface; same
  // bounds as the primary panel column.
  secondary: { id: "secondary", defaultWidth: 320, minWidth: 240, maxWidth: 640 },
};

/** Visibility / collapsed flags for every column. */
export interface ColumnLayoutState {
  /** User-resized widths. Slice-15 owns the panel + secondary; the
   *  conversation column is co-owned with shell.tsx (which already
   *  persists it). The sidebar is owned entirely by shell.tsx and is
   *  included in the same payload for symmetry but slice 15 does
   *  not write to it. */
  widths: Record<ColumnId, number>;
  /** Collapsed flags. `true` means the column is hidden from the
   *  flex row (the column's space collapses to 0). */
  collapsed: Record<ColumnId, boolean>;
  /** True when the optional secondary column is open. */
  secondaryOpen: boolean;
}

export const DEFAULT_COLUMN_LAYOUT: ColumnLayoutState = {
  widths: {
    sidebar: COLUMN_SPECS.sidebar.defaultWidth,
    conversation: COLUMN_SPECS.conversation.defaultWidth,
    panel: COLUMN_SPECS.panel.defaultWidth,
    secondary: COLUMN_SPECS.secondary.defaultWidth,
  },
  collapsed: {
    sidebar: false,
    conversation: false,
    panel: true, // closed until at least one tab exists
    secondary: false,
  },
  secondaryOpen: false,
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
      panel: COLUMN_SPECS.panel.defaultWidth,
      secondary: COLUMN_SPECS.secondary.defaultWidth,
    },
  };
}

/**
 * Set the collapsed flag for a column. The sidebar's collapsed
 * state is mirrored from shell.tsx (slice 07 owns the persisted
 * source of truth); slice 15 only writes it through to keep the
 * layout payload self-consistent.
 */
export function setColumnCollapsed(state: ColumnLayoutState, column: ColumnId, collapsed: boolean): ColumnLayoutState {
  if (state.collapsed[column] === collapsed) return state;
  return {
    ...state,
    collapsed: { ...state.collapsed, [column]: collapsed },
  };
}

/** Open or close the secondary column. */
export function setSecondaryOpen(state: ColumnLayoutState, open: boolean): ColumnLayoutState {
  if (state.secondaryOpen === open) return state;
  // Closing the secondary column resets its width slot to default so
  // a future open lands on the default (rather than on the width the
  // user dragged to last time they closed it).
  return { ...state, secondaryOpen: open };
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

/**
 * Pure layout fold.
 *
 * Inputs:
 *   - `layout`    — user widths + collapsed flags + secondary flag
 *   - `containerWidth` — total px available for the column row
 *   - `viewportWidth`  — the browser's window.innerWidth equivalent
 *
 * Rules (slice 15 acceptance criteria):
 *
 *   - secondaryOpen=false  → secondary column is hidden
 *   - secondaryOpen=true   → secondary column is visible at its
 *                            clamped width; if the row would
 *                            overflow, fold by priority order:
 *                            secondary → sidebar.
 *   - A column's width is clamped to its [min, max] bounds.
 *   - No horizontal overflow: when the four visible widths exceed
 *     containerWidth, narrow in the priority order above. A
 *     "narrowed" flag is set so the renderer can surface a hint
 *     (and so a unit test can pin the fold path).
 *   - Sidebar collapsed / panel collapsed / conversation collapsed
 *     are honoured as zero-width segments.
 *
 * The fold is a single pass — if the row is still too wide after
 * folding both secondary + sidebar, the conversation column is
 * reduced to its minimum (the conversation column is the only one
 * with elastic content, so this is the right-most squeeze).
 */
export function computeColumnLayout(
  layout: ColumnLayoutState,
  containerWidth: number,
  viewportWidth: number,
): ColumnLayoutSummary {
  const spec = (id: ColumnId) => COLUMN_SPECS[id];
  const visibleColumns: ColumnId[] = layout.secondaryOpen
    ? ["sidebar", "conversation", "panel", "secondary"]
    : ["sidebar", "conversation", "panel"];

  const widthFor = (id: ColumnId): number => {
    if (!visibleColumns.includes(id)) return 0;
    if (layout.collapsed[id]) return 0;
    return clampWidth(id, layout.widths[id]);
  };

  const initial: Record<ColumnId, number> = {
    sidebar: widthFor("sidebar"),
    conversation: widthFor("conversation"),
    panel: widthFor("panel"),
    secondary: widthFor("secondary"),
  };

  let total = initial.sidebar + initial.conversation + initial.panel + initial.secondary;
  let narrowed = false;
  const foldPriority: ColumnId[] = layout.secondaryOpen
    ? ["secondary", "sidebar"]
    : [];

  for (const column of foldPriority) {
    if (total <= containerWidth) break;
    const minWidth = spec(column).minWidth;
    const folded = Math.max(0, total - containerWidth);
    const current = initial[column];
    const next = Math.max(minWidth, current - folded);
    total = total - current + next;
    initial[column] = next;
    narrowed = true;
  }

  // Hard overflow: even after the priority fold the row is too wide
  // (e.g. a 360px viewport forcing the conversation column to its
  // minimum while every other column is at its minimum too). Fold
  // the conversation column down to its minimum and then to zero;
  // the renderer treats zero-width conversation as "hide the chat
  // column" — it should never reach here in practice because the
  // auto-collapse ladder in shell.tsx collapses the sidebar below
  // 980px, but the hard fallback keeps the layout finite.
  if (total > containerWidth) {
    const overflow = total - containerWidth;
    const convMin = spec("conversation").minWidth;
    const newConv = Math.max(0, initial.conversation - overflow);
    total = total - initial.conversation + Math.max(convMin, newConv);
    initial.conversation = Math.max(convMin, newConv);
    narrowed = true;
  }

  // Sort segment order to match DOM order regardless of which
  // columns are visible. The renderer walks this array top-down.
  const segmentIds: ColumnId[] = ["sidebar", "conversation", "panel", "secondary"];
  const segments: ColumnSegment[] = segmentIds.map((id) => ({
    id,
    width: initial[id],
    visible: initial[id] > 0 && visibleColumns.includes(id) && !layout.collapsed[id],
  }));

  // viewportWidth carries the auto-collapse hint that shell.tsx
  // already implements. We do not mutate widths based on it here —
  // shell.tsx owns the sidebar's auto-collapse, and the panel /
  // conversation columns do not have an auto-collapse rule today.
  // Passing it through so the signature is stable for a future
  // ticket that adds one.
  void viewportWidth;

  return { segments, narrowed };
}

// --- combined state ---------------------------------------------------------

/**
 * Slice-15 combined state — tabs + column layout. The page-level
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
 * fields.
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
  activeId: string | null;
  /** Per-file-tab scroll positions. Only present when at least one
   *  file tab existed at save time. */
  fileScrolls: Record<string, number>;
}

export interface SerializedColumnLayout {
  widths: Record<ColumnId, number>;
  collapsed: Record<ColumnId, boolean>;
  secondaryOpen: boolean;
}

export const WORKSPACE_TABS_VERSION = 1;

/**
 * Serialize the state to the wire shape. Pure function; no
 * localStorage. The page-level writer in `lib/persist.ts` adds the
 * debounce + best-effort storage.
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
      activeId: state.tabStrip.activeId,
      fileScrolls,
    },
    layout: {
      widths: { ...state.columnLayout.widths },
      collapsed: { ...state.columnLayout.collapsed },
      secondaryOpen: state.columnLayout.secondaryOpen,
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
 */
export function deserializeWorkspaceTabs(
  raw: string | null | undefined,
  cid: string | null | undefined,
): WorkspaceTabsState {
  if (!raw) return { ...DEFAULT_WORKSPACE_TABS_STATE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_WORKSPACE_TABS_STATE };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_WORKSPACE_TABS_STATE };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== WORKSPACE_TABS_VERSION) return { ...DEFAULT_WORKSPACE_TABS_STATE };
  if (typeof cid === "string" && cid.length > 0 && typeof obj.cid === "string" && obj.cid !== cid) {
    return { ...DEFAULT_WORKSPACE_TABS_STATE };
  }
  const tabStrip = deserializeTabStrip(obj.tabs);
  const columnLayout = deserializeColumnLayout(obj.layout);
  return { tabStrip, columnLayout };
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
  const activeId = typeof obj.activeId === "string" && tabs.some((tab) => tab.id === obj.activeId)
    ? (obj.activeId as string)
    : (tabs[tabs.length - 1]?.id ?? null);
  return { tabs, activeId, launcherOpen: false };
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
  if (!raw || typeof raw !== "object") return cloneDefaultColumnLayout();
  const obj = raw as Record<string, unknown>;
  const widths = rawWidths(obj.widths);
  const collapsed = rawCollapsed(obj.collapsed);
  const secondaryOpen = obj.secondaryOpen === true;
  return { widths, collapsed, secondaryOpen };
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
    secondaryOpen: DEFAULT_COLUMN_LAYOUT.secondaryOpen,
  };
}