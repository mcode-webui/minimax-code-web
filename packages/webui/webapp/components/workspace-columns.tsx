"use client";

/**
 * Four-column shell wrapper (slice 17).
 *
 * Renders the right side of the AppShell's `children` slot as
 * three flex columns — `conversation | preview | tree` — with a
 * draggable divider between each pair. The sidebar is owned by
 * AppShell and lives outside this wrapper.
 *
 * Column model (matches the desktop reference at
 * `refs/ui/02-workspace-shell.jpg`):
 *
 *   ┌──────┬───────────────┬─────────┬───────┐
 *   │ ① 侧 │ ② 对话        │ ③ 预览   │ ④ 文件│
 *   │ 栏  │              │         │  树   │
 *   └──────┴───────────────┴─────────┴───────┘
 *
 * Column 2 (the conversation column) is the **fluid** one: its
 * stored width is a *target / preferred* value; the rendered
 * width is `min(target, leftover, maxWidth)` clamped to
 * `[minWidth, maxWidth]`. This is the fix for the dead-gutter
 * defect — at 1280px the conversation column is no longer 1040px
 * wide with a ~480px centred content box and 280px gutters on
 * each side; it sits at the user's preferred width (default 720)
 * and the fixed columns shrink to fit.
 *
 * Each divider supports:
 *
 *   - Drag-resize. The dragged column's stored width is updated
 *     (clamped to [min, max]). For the fluid conversation
 *     column the stored value is the *target* — the renderer
 *     recomputes the actual width on the next layout pass.
 *   - Double-click reset. Calls `onColumnReset(column)` which
 *     restores the column's default.
 *
 * The fold rules live in `lib/workspace-tabs-state.ts#computeColumnLayout`:
 * when the row would overflow, fixed columns shrink in
 * priority order `tree → preview → sidebar`; the fluid
 * conversation column absorbs the residual down to its
 * minimum.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  clampWidth,
  COLUMN_SPECS,
  computeColumnLayout,
  type ColumnId,
  type ColumnLayoutState,
} from "@/lib/workspace-tabs-state";

export interface WorkspaceColumnsProps {
  layout: ColumnLayoutState;
  /** Total available width for the column row. When `null` the
   *  wrapper measures its own element via ResizeObserver — this
   *  is the production path (the AppShell owns the sidebar
   *  chrome, so subtracting the sidebar from `window.innerWidth`
   *  is approximate; measuring the actual element is exact). */
  containerWidth: number | null;
  /** The current viewport width (typically `window.innerWidth`).
   *  Reserved for the future auto-collapse ladder; slice 17 does
   *  not currently fold on viewport width. */
  viewportWidth: number;
  onColumnResize: (column: ColumnId, width: number) => void;
  onColumnReset: (column: ColumnId) => void;
  /** Render slot for each column. The sidebar is owned by
   *  AppShell, so its slot here is always `null` (and the column
   *  is collapsed via `layout.collapsed.sidebar`). Missing or
   *  invisible columns get `null` — the wrapper still allocates
   *  zero width for them. */
  children: Record<ColumnId, React.ReactNode>;
}

const DRAG_HANDLE_WIDTH = 8;

export function WorkspaceColumns({
  layout,
  containerWidth,
  viewportWidth,
  onColumnResize,
  onColumnReset,
  children,
}: WorkspaceColumnsProps) {
  // Self-measure the row's actual width. When the caller passes
  // `containerWidth={null}` (the production path), the
  // ResizeObserver below gives us the exact pixel count — the
  // AppShell's sidebar + chrome are accounted for automatically,
  // so dragging can never push a column off-window. When the
  // caller passes an explicit number (the test path), we trust
  // it and skip the observer.
  const selfRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(1280);
  useEffect(() => {
    if (containerWidth !== null) return;
    if (typeof ResizeObserver === "undefined") return;
    const node = selfRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = Math.round(entry.contentRect.width);
      setMeasuredWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerWidth]);
  const effectiveWidth = containerWidth ?? measuredWidth;
  // Subtract the divider handles from the container width. The
  // flex row in JSX places a divider AFTER every visible segment
  // (except the last), so the column widths themselves must sum
  // to (container - dividers). Without this subtraction the row
  // overflows horizontally — the dividers would eat ~16-24px
  // of the container that the algorithm thinks the columns can
  // claim.
  //
  // Conversation is always visible (it's the elastic backbone),
  // so the visible-segment count starts at 1. Each non-collapsed
  // fixed column adds one more segment, and each visible segment
  // (except the last) sits next to a divider handle.
  let visibleSegmentsCount = 1; // conversation is always visible
  if (!layout.collapsed.sidebar) visibleSegmentsCount += 1;
  if (!layout.collapsed.preview) visibleSegmentsCount += 1;
  if (!layout.collapsed.tree) visibleSegmentsCount += 1;
  const dividersPx = Math.max(0, visibleSegmentsCount - 1) * DRAG_HANDLE_WIDTH;
  const layoutWidth = effectiveWidth - dividersPx;
  const summary = computeColumnLayout(layout, layoutWidth, viewportWidth);
  const visibleSegments = summary.segments.filter((segment) => segment.visible);

  // Per-divider drag state. The pointer-move handler is attached
  // at the wrapper level (not on each divider) so it survives a
  // re-render without re-binding. The ref captures the column
  // being dragged so a move event updates only the matching
  // column.
  const dragStateRef = useRef<{
    column: ColumnId;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [draggingColumn, setDraggingColumn] = useState<ColumnId | null>(null);

  useEffect(() => {
    if (!draggingColumn) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const delta = event.clientX - drag.startX;
      const next = clampWidth(drag.column, drag.startWidth + delta);
      onColumnResize(drag.column, next);
    };
    const onUp = () => {
      dragStateRef.current = null;
      setDraggingColumn(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [draggingColumn, onColumnResize]);

  const beginDrag = useCallback(
    (column: ColumnId, event: React.PointerEvent<HTMLDivElement>) => {
      const width = layout.widths[column];
      dragStateRef.current = {
        column,
        startX: event.clientX,
        startWidth: width,
      };
      setDraggingColumn(column);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [layout.widths],
  );

  return (
    <div
      ref={selfRef}
      className="flex h-full min-h-0 min-w-0 flex-1"
      data-testid="workspace-columns"
      data-narrowed={summary.narrowed ? "true" : "false"}
      data-container-width={effectiveWidth}
      data-sum-visible-width={visibleSegments.reduce((sum, segment) => sum + segment.width, 0)}
    >
      {visibleSegments.map((segment, index) => {
        const isLast = index === visibleSegments.length - 1;
        const showDivider = !isLast;
        return (
          <ColumnSlot
            key={segment.id}
            columnId={segment.id}
            width={segment.width}
            divider={showDivider ? {
              onPointerDown: (event) => beginDrag(segment.id, event),
              onDoubleClick: () => onColumnReset(segment.id),
              active: draggingColumn === segment.id,
              resizeAria: dividerAria(segment.id),
            } : null}
          >
            {children[segment.id]}
          </ColumnSlot>
        );
      })}
    </div>
  );
}

function dividerAria(column: ColumnId): string {
  switch (column) {
    case "sidebar":
      return "workspaceTabs.column.sidebarAria";
    case "conversation":
      return "workspaceTabs.column.conversationAria";
    case "preview":
      return "workspaceTabs.column.previewAria";
    case "tree":
      return "workspaceTabs.column.treeAria";
  }
}

/**
 * A single column slot. Renders the column body at its computed
 * width plus an optional divider on the right edge. The divider
 * is an 8px-wide invisible-by-default strip; the visible "pill"
 * appears only on hover or while dragging, matching the
 * sidebar's own resize affordance.
 */
function ColumnSlot({
  columnId,
  width,
  divider,
  children,
}: {
  columnId: ColumnId;
  width: number;
  divider: {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onDoubleClick: () => void;
    active: boolean;
    resizeAria: string;
  } | null;
  children: React.ReactNode;
}) {
  const style: React.CSSProperties = { width };
  return (
    <>
      <div
        className="flex h-full min-h-0 flex-shrink-0 flex-col overflow-hidden"
        style={style}
        data-testid={`workspace-column-${columnId}`}
        data-column-width={width}
        data-column-role={COLUMN_SPECS[columnId].flow}
      >
        {children}
      </div>
      {divider ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={divider.resizeAria}
          onPointerDown={divider.onPointerDown}
          onDoubleClick={divider.onDoubleClick}
          data-testid={`workspace-column-divider-${columnId}`}
          data-active={divider.active ? "true" : "false"}
          className={[
            "group relative flex h-full flex-shrink-0 cursor-col-resize items-stretch",
            divider.active ? "z-10" : "",
          ].join(" ")}
          style={{ width: DRAG_HANDLE_WIDTH }}
        >
          <div
            className={[
              "pointer-events-none absolute top-1/2 left-1/2 h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-150",
              divider.active
                ? "bg-text_default_secondary opacity-100"
                : "bg-text_default_tertiary opacity-0 group-hover:opacity-100",
            ].join(" ")}
          />
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border_light" />
        </div>
      ) : null}
    </>
  );
}

/**
 * Re-export `COLUMN_SPECS` so the page-level wiring does not need
 * to import the same constant twice. Keeps the import surface
 * tight: page imports `{ WorkspaceColumns, COLUMN_SPECS }`.
 */
export { COLUMN_SPECS };

/**
 * Track container width. The shell measures `window.innerWidth`
 * on mount and on resize; this hook returns the live value and a
 * teardown so a page-level integration does not have to own the
 * listener itself.
 */
export function useContainerWidth(): number {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}