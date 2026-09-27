"use client";

/**
 * 4-column shell wrapper (slice 15).
 *
 * Wraps the existing shell's "conversation column + right panel"
 * flex row in a four-column layout:
 *
 *   sidebar | conversation | panel | secondary (optional)
 *
 * Each column has a draggable divider on its RIGHT edge (except
 * the last column, which has no divider on the right). Dragging a
 * divider updates the column's width through the
 * `onColumnResize` callback; double-clicking a divider resets the
 * width to the column's default. The fold rules live in
 * `lib/workspace-tabs-state.ts#computeColumnLayout` and the rules
 * are: secondaryOpen=false → 3 columns; on narrow viewports fold
 * secondary → sidebar; no horizontal overflow ever.
 *
 * The shell itself (Sidebar, ConversationToolbar, composer) stays
 * exactly where it was — slice 15 inserts this wrapper between the
 * shell's existing flex row and the content + panel pair, so the
 * only behavioural change is "the panel column is now one of up to
 * four columns".
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
   *  Reserved for the future auto-collapse ladder; slice 15 does
   *  not currently fold on viewport width (the panel column closes
   *  only when every tab is closed), but the signature carries
   *  the value so a future ticket does not have to re-thread it. */
  viewportWidth: number;
  onColumnResize: (column: ColumnId, width: number) => void;
  onColumnReset: (column: ColumnId) => void;
  /** Render slot for each column. Missing or invisible columns get
   *  `null` — the wrapper still allocates zero width for them. */
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
  const summary = computeColumnLayout(layout, effectiveWidth, viewportWidth);
  const visibleSegments = summary.segments.filter((segment) => segment.visible);

  // Per-divider drag state. Two dividers can be live at once (a
  // user can drag the conversation-divider and the panel-divider
  // independently while the strip is being moved). The ref tracks
  // each one so a pointer move updates only the matching column.
  const dragStateRef = useRef<{
    column: ColumnId;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [draggingColumn, setDraggingColumn] = useState<ColumnId | null>(null);

  // Pointer move / up handlers live at the wrapper level so they
  // do not have to be re-attached on every render. The handler
  // reads `dragStateRef.current` rather than capturing the column
  // id, so dragging the conversation-divider while the panel-
  // divider updates its layout stays coherent.
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
      data-secondary-open={layout.secondaryOpen ? "true" : "false"}
      data-narrowed={summary.narrowed ? "true" : "false"}
      data-container-width={effectiveWidth}
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
    case "conversation":
      return "workspaceTabs.column.conversationAria";
    case "panel":
      return "workspaceTabs.column.panelAria";
    case "secondary":
      return "workspaceTabs.column.secondaryAria";
    case "sidebar":
      return "workspaceTabs.column.resizeAria";
  }
}

/**
 * A single column slot. Renders the column body at its computed
 * width plus an optional divider on the right edge. The divider is
 * an 8px-wide invisible-by-default strip; the visible "pill" appears
 * only on hover or while dragging, matching the sidebar's own
 * resize affordance.
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
  const style = { width };
  return (
    <>
      <div
        className="flex h-full min-h-0 flex-shrink-0 flex-col overflow-hidden"
        style={style}
        data-testid={`workspace-column-${columnId}`}
        data-column-width={width}
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