"use client";

/**
 * Pure-logic helpers for the chat-list virtualization (Lease C04 — port).
 *
 * The renderer holds the visible DOM bounded regardless of message count; this
 * file owns the math that lets it do that.
 *
 * Why this file is structured as pure functions + a tiny hook:
 *   - The pure functions (`computeVirtualWindow`, `isNearBottom`,
 *     `decideScrollBehavior`, `estimateDomNodeCount`) carry the math. They have
 *     no DOM dependency, no app-state, no module-level globals — every
 *     function is a pure transform. The companion test file drives them from
 *     Node without jsdom.
 *   - The React hook (`useChatVirtualization`) wires the math to the live
 *     scroll container: it subscribes to scroll/resize, recomputes the window
 *     and the near-bottom state, and exposes them to the renderer. Keeping
 *     the math pure means the test pins the contract, and the hook never has
 *     to be unit-tested in isolation.
 *
 * Why fixed-height estimation instead of measured heights:
 *   Measuring real heights would require rendering the entire list off-screen
 *   first, then querying offsetTop. For 10 000 messages that defeats the
 *   speedup. We accept ~20 % scrollbar imprecision in exchange for a fixed-
 *   O(1) compute cost per scroll tick.
 */

import { useEffect, useState } from "react";
import type { RefObject } from "react";

// ============================================================
// Constants — pinned by the legacy performance contract.
// Anything that changes here is a break-glass decision (visible DOM size,
// scroll precision, etc.). The companion test pins these values.
// ============================================================

/**
 * Below this N, skip virtualization entirely — render all units.
 * The threshold is the "knee" where full-render starts hurting the main
 * thread. Empirically a chat under 200 messages renders in < 16 ms; over
 * 200 the cost climbs fast.
 */
export const VIRTUAL_LIST_THRESHOLD = 200;

/**
 * Average row height for scrollbar / spacer math. Real rows vary 40–300 px
 * depending on content. 80 covers most short messages; long messages
 * overflow their slot and the scrollbar shifts a bit when the user scrolls
 * over them, but the user can still navigate the full chat.
 */
export const ESTIMATED_MESSAGE_HEIGHT = 80;

/**
 * Units rendered above + below the viewport. 50 ≈ 5 s of scroll headroom at
 * 200 px/s mouse-wheel speed before the visible window has to be recomputed.
 * Bigger buffer = smoother scrolling, more DOM.
 */
export const VIRTUAL_LIST_BUFFER = 50;

/**
 * Px threshold for "near bottom" detection. If the user is within this many
 * px of the bottom, treat as "stuck to the bottom" — auto-scroll on new
 * messages. Above it, preserve the user's position.
 *
 * Note: this is *separate* from the pill-visibility threshold in chat.tsx
 * (16 px). The legacy kept both: 50 px for autoscroll decisions, 16 px so
 * the pill does not flicker on a single wheel tick.
 */
export const NEAR_BOTTOM_PX = 50;

// ============================================================
// Public types
// ============================================================

export interface ComputeVirtualWindowArgs {
  /** Total units (post-`groupActivity`) in the transcript. */
  totalCount: number;
  /** chat-scroll.scrollTop (px from top of the scroll container). */
  scrollTop: number;
  /** chat-scroll.clientHeight (viewport px). */
  clientHeight: number;
  /** Estimated row height (default `ESTIMATED_MESSAGE_HEIGHT`). */
  rowHeight?: number;
  /** Units above + below the viewport (default `VIRTUAL_LIST_BUFFER`). */
  buffer?: number;
  /** N above which virtualization kicks in (default `VIRTUAL_LIST_THRESHOLD`). */
  threshold?: number;
}

export interface VirtualWindow {
  /** Inclusive start index of the slice to render. */
  startIdx: number;
  /** Exclusive end index of the slice to render (slice renders `[startIdx, endIdx)`). */
  endIdx: number;
  /** Px of empty space to put above the slice (matches `startIdx * rowHeight`). */
  topSpacer: number;
  /** Px of empty space to put below the slice (matches `(totalCount - endIdx) * rowHeight`). */
  bottomSpacer: number;
  /**
   * `false` when `totalCount < threshold` — render the whole array with no
   * spacers. `true` when virtualization is active.
   */
  useVirtual: boolean;
  /** Visible (no buffer) start index — what the user is actually looking at. */
  visibleStart: number;
  /** Visible (no buffer) end index. */
  visibleEnd: number;
}

export interface NearBottomArgs {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** Px threshold (default `NEAR_BOTTOM_PX`). */
  threshold?: number;
}

export type ScrollBehavior = "auto" | "preserve";

export interface EstimateDomNodeCountArgs {
  totalCount: number;
  rowHeight?: number;
  clientHeight?: number;
  buffer?: number;
  threshold?: number;
}

export interface DomNodeCountEstimate {
  /** DOM nodes without virtualization — one per unit. */
  withoutVirtual: number;
  /** DOM nodes with virtualization — slice + 2 spacers. */
  withVirtual: number;
  /** `withoutVirtual - withVirtual` (≥ 0). */
  savings: number;
}

export interface ChatVirtualMetrics {
  /** Current visible window, ready for `units.slice(startIdx, endIdx)`. */
  window: VirtualWindow;
  /** True when the user is within `NEAR_BOTTOM_PX` of the bottom. */
  isNearBottom: boolean;
  /**
   * True when the user is more than `stuckThreshold` px from the bottom.
   * Drives the "jump to latest" pill (chat.tsx preserves the legacy 16 px
   * threshold).
   */
  stuck: boolean;
}

export interface UseChatVirtualizationOptions {
  /** Px threshold for the `stuck` state (default 16 — matches chat.tsx). */
  stuckThreshold?: number;
}

// ============================================================
// Pure functions
// ============================================================

/**
 * Compute the visible unit window given scroll metrics.
 *
 * Below the threshold we return `useVirtual: false` and the slice covers the
 * whole array; the renderer skips the spacers and renders everything. Above
 * the threshold we slice `[startIdx, endIdx)` and emit two spacer divs whose
 * heights push the rendered slice into the right scrollbar position.
 */
export function computeVirtualWindow(args: ComputeVirtualWindowArgs): VirtualWindow {
  const { totalCount, scrollTop, clientHeight } = args;
  const rowHeight = args.rowHeight ?? ESTIMATED_MESSAGE_HEIGHT;
  const buffer = args.buffer ?? VIRTUAL_LIST_BUFFER;
  const threshold = args.threshold ?? VIRTUAL_LIST_THRESHOLD;

  if (totalCount < threshold) {
    return {
      startIdx: 0,
      endIdx: totalCount,
      topSpacer: 0,
      bottomSpacer: 0,
      useVirtual: false,
      visibleStart: 0,
      visibleEnd: totalCount,
    };
  }
  // Visible range (exclusive of buffer).
  const visibleStart = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visibleEnd = Math.min(
    totalCount,
    Math.ceil((scrollTop + clientHeight) / rowHeight),
  );
  // Render range (inclusive of buffer).
  const startIdx = Math.max(0, visibleStart - buffer);
  const endIdx = Math.min(totalCount, visibleEnd + buffer);
  // Spacers push the rendered slice into the right scrollbar position.
  const topSpacer = startIdx * rowHeight;
  const bottomSpacer = (totalCount - endIdx) * rowHeight;
  return {
    startIdx,
    endIdx,
    topSpacer,
    bottomSpacer,
    useVirtual: true,
    visibleStart,
    visibleEnd,
  };
}

/**
 * Is the user near the bottom of the chat scroll container?
 *
 * Empty container returns `true` (no scroll position to preserve). When the
 * container has zero height but positive scrollHeight we still trust the
 * formula — the threshold check is what saves us from a divide-by-zero in
 * the renderer.
 */
export function isNearBottom(args: NearBottomArgs): boolean {
  const { scrollTop, clientHeight, scrollHeight } = args;
  const threshold = args.threshold ?? NEAR_BOTTOM_PX;
  if (scrollHeight <= 0) return true; // empty container → "at bottom"
  return scrollTop + clientHeight >= scrollHeight - threshold;
}

/**
 * Decide whether to auto-scroll on a new message or preserve the user's
 * position. Returns `'auto'` when the user is near the bottom (typical case
 * for an actively-watching user), `'preserve'` when they have scrolled up
 * to read history (auto-scroll would be jarring).
 */
export function decideScrollBehavior(args: NearBottomArgs): ScrollBehavior {
  return isNearBottom(args) ? "auto" : "preserve";
}

/**
 * DOM node count estimator. The current implementation always renders N
 * nodes (one per unit). With virtualization, the DOM contains approximately
 * `(endIdx - startIdx)` unit nodes + 2 spacer divs. This helper lets the
 * caller decide whether virtualization is worth the setup cost for a given
 * N — the test pins the 10 000-message bound here.
 */
export function estimateDomNodeCount(args: EstimateDomNodeCountArgs): DomNodeCountEstimate {
  const { totalCount } = args;
  const rowHeight = args.rowHeight ?? ESTIMATED_MESSAGE_HEIGHT;
  const clientHeight = args.clientHeight ?? 600;
  const buffer = args.buffer ?? VIRTUAL_LIST_BUFFER;
  const threshold = args.threshold ?? VIRTUAL_LIST_THRESHOLD;

  const withoutVirtual = totalCount;
  if (totalCount < threshold) {
    return { withoutVirtual, withVirtual: withoutVirtual, savings: 0 };
  }
  const visibleEnd = Math.min(totalCount, Math.ceil(clientHeight / rowHeight));
  // +2 spacer divs (top + bottom).
  const withVirtual = Math.min(totalCount, visibleEnd + buffer * 2) + 2;
  return { withoutVirtual, withVirtual, savings: withoutVirtual - withVirtual };
}

// ============================================================
// React hook — wires the pure functions to the live scroller.
// ============================================================

/**
 * Subscribe the chat scroller to scroll/resize/totalCount events and
 * re-emit the current `ChatVirtualMetrics`. The renderer reads `metrics.window`
 * to slice the transcript and `metrics.stuck` to gate the "jump to latest"
 * pill.
 *
 * Why this lives here and not in `chat.tsx`:
 *   - The math (`computeVirtualWindow`, `isNearBottom`, `stuck`) is unit-tested
 *     here in pure form, with no jsdom, so the renderer stays a small switch on
 *     `metrics.window.useVirtual` plus a spacer + slice + tail-anchor.
 */
export function useChatVirtualization(
  scrollerRef: RefObject<HTMLElement>,
  totalCount: number,
  options: UseChatVirtualizationOptions = {},
): ChatVirtualMetrics {
  const stuckThreshold = options.stuckThreshold ?? 16;

  const [metrics, setMetrics] = useState<ChatVirtualMetrics>(() => ({
    window: computeVirtualWindow({ totalCount, scrollTop: 0, clientHeight: 0 }),
    isNearBottom: true,
    stuck: false,
  }));

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const recompute = () => {
      const scrollTop = el.scrollTop;
      const clientHeight = el.clientHeight;
      const scrollHeight = el.scrollHeight;
      setMetrics({
        window: computeVirtualWindow({ totalCount, scrollTop, clientHeight }),
        isNearBottom: isNearBottom({ scrollTop, clientHeight, scrollHeight }),
        stuck: scrollHeight - scrollTop - clientHeight > stuckThreshold,
      });
    };

    el.addEventListener("scroll", recompute, { passive: true });
    // Recompute when the scroller's box size changes (window resize, sidebar
    // toggle, devtools open/close). This is the only signal we have for
    // viewport height changes that the scroll event does not emit.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(recompute);
      ro.observe(el);
    }
    recompute();
    return () => {
      el.removeEventListener("scroll", recompute);
      if (ro) ro.disconnect();
    };
  }, [scrollerRef, totalCount, stuckThreshold]);

  // After `totalCount` shifts (new blocks appended at the tail) the scroll
  // event does not always fire — the user's scrollTop has not changed. Run a
  // recompute on the next frame so `scrollHeight` reflects the just-rendered
  // DOM and the window picks up the new tail.
  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    const raf = requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (!el) return;
      const scrollTop = el.scrollTop;
      const clientHeight = el.clientHeight;
      const scrollHeight = el.scrollHeight;
      setMetrics({
        window: computeVirtualWindow({ totalCount, scrollTop, clientHeight }),
        isNearBottom: isNearBottom({ scrollTop, clientHeight, scrollHeight }),
        stuck: scrollHeight - scrollTop - clientHeight > stuckThreshold,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [totalCount, scrollerRef, stuckThreshold]);

  return metrics;
}