"use client";

/**
 * Pure-logic helpers for the chat-list virtualization (Lease C04 — port) and
 * for the tail follow that keeps a streaming turn inside the visible box.
 *
 * The renderer holds the visible DOM bounded regardless of message count; this
 * file owns the math that lets it do that, plus the one scroll write that makes
 * the growing tail visible.
 *
 * Why this file is structured as pure functions + tiny hooks:
 *   - The pure functions (`computeVirtualWindow`, `isNearBottom`,
 *     `decideScrollBehavior`, `computeTailFollowScrollTop`, `isAwayFromPin`,
 *     `isAtTail`, `estimateDomNodeCount`) carry the math. They have no DOM
 *     dependency, no app-state, no module-level globals — every function is a
 *     pure transform. The companion test file drives them from Node without
 *     jsdom.
 *   - The React hooks (`useChatVirtualization`, `useChatTailFollow`) wire the
 *     math to the live scroll container: they subscribe to scroll/resize,
 *     recompute the window, the near-bottom state and the tail-follow decision,
 *     and expose them to the renderer. Keeping the math pure means the test pins
 *     the contract, and the hooks never have to be unit-tested in isolation.
 *
 * Why fixed-height estimation instead of measured heights:
 *   Measuring real heights would require rendering the entire list off-screen
 *   first, then querying offsetTop. For 10 000 messages that defeats the
 *   speedup. We accept ~20 % scrollbar imprecision in exchange for a fixed-
 *   O(1) compute cost per scroll tick.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

export interface TailFollowScrollArgs {
  /**
   * True when the reader's last expressed scroll intent was "stay on the live
   * tail". Maintained by the per-commit decision in `useChatTailFollow` — see
   * that hook's docblock for why the intent cannot be re-derived from the
   * post-growth scroll metrics.
   */
  following: boolean;
  /** `el.scrollHeight` AFTER the new content is laid out. */
  scrollHeight: number;
  /** `el.clientHeight` of the scroll container. */
  clientHeight: number;
}

/**
 * Px of slack around a pinned position that still counts as "nobody moved the
 * container".
 *
 * Two things live inside this slack and neither is a reader action: fractional
 * `scrollTop` on a HiDPI viewport, and the browser's own scroll anchoring
 * nudging the offset by a sub-pixel amount when content above changes. A wheel
 * tick is ~20 px and PageUp/PageDown ~600 px, so 2 px separates the two
 * cleanly. Widen it and a real scroll away stops registering; narrow it and
 * the follow chatters itself off.
 */
export const TAIL_FOLLOW_TOLERANCE_PX = 2;

/**
 * The `scrollTop` that pins the freshly grown transcript to its tail, or `null`
 * for "leave the reader where they are".
 *
 * `null` is the load-bearing half of this contract. A turn appends a new block
 * and grows the last one token by token, so the DOM below the reader grows
 * while their `scrollTop` does not move: without this pin the streaming answer
 * lands outside the visible box and the reader watches 「思考中」 for the whole
 * turn. `null` is what keeps a reader who scrolled up to read history from
 * being dragged back down mid-turn.
 *
 * The clamp at 0 matters for the short-transcript case: when the content fits,
 * `scrollHeight - clientHeight` is negative and writing it would be a no-op at
 * best (browsers clamp silently) and a spurious scroll event at worst, which
 * would feed straight back into the follow decision.
 */
export function computeTailFollowScrollTop(args: TailFollowScrollArgs): number | null {
  if (!args.following) return null;
  const target = args.scrollHeight - args.clientHeight;
  return target > 0 ? target : 0;
}

export interface AwayFromPinArgs {
  /** `el.scrollTop` as read at a commit boundary. */
  scrollTop: number;
  /** The `scrollTop` this hook last left the container at. */
  pinnedTop: number;
  /** Px slack (default `TAIL_FOLLOW_TOLERANCE_PX`). */
  tolerance?: number;
}

/**
 * Did somebody move the container away from where the follow left it?
 *
 * Comparing against the pin rather than re-testing "am I near the bottom" is
 * what makes the follow survive a streaming turn. Content is appended BELOW the
 * reader, so growth alone never changes `scrollTop`; only a reader action (or
 * the browser's own anchoring nudge) does. A nearness test cannot make that
 * distinction, because by the time it runs the new content is already laid out
 * and the reader who never left looks exactly like one who scrolled away.
 */
export function isAwayFromPin(args: AwayFromPinArgs): boolean {
  const tolerance = args.tolerance ?? TAIL_FOLLOW_TOLERANCE_PX;
  return Math.abs(args.scrollTop - args.pinnedTop) > tolerance;
}

export interface AtTailArgs {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Px slack (default `TAIL_FOLLOW_TOLERANCE_PX`). */
  tolerance?: number;
}

/**
 * Is the container parked exactly at its tail right now?
 *
 * Distinct from `isNearBottom`, which answers "close enough to start following"
 * with a 50 px tolerance. Re-arming needs the strict reading: a reader who has
 * deliberately scrolled back down to the newest line is at the tail, and a
 * reader parked 40 px above it is still reading something else.
 */
export function isAtTail(args: AtTailArgs): boolean {
  const tolerance = args.tolerance ?? TAIL_FOLLOW_TOLERANCE_PX;
  return args.scrollHeight - args.scrollTop - args.clientHeight <= tolerance;
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

// ============================================================
// Tail follow — keep the streaming answer inside the visible box
// ============================================================

export interface ChatTailFollow {
  /**
   * Re-arm the follow explicitly. `chat.tsx` calls this from the "jump to
   * latest" pill so a reader who scrolled up can return to the tail by click
   * even when the re-arm-by-position reading below is ambiguous.
   */
  followNow: () => void;
}

/**
 * Pin the transcript to its tail while the reader is watching it live.
 *
 * The defect this closes: the scroller had exactly one auto-scroll path in the
 * whole webapp — `scrollToBottom` in `chat.tsx`, wired to the "jump to latest"
 * pill. Nothing moved the container while a turn streamed, so the growing
 * answer was laid out below the fold and stayed invisible. Measured on the
 * unfixed build (see `.tickets/webui-parity/88-streaming-bubble-visibility.md`):
 * over a 15 s turn `scrollTop` never left 0 while `scrollHeight` went
 * 688 → 1196.
 *
 * Why every decision happens at a commit boundary, with no scroll listener:
 * appending content BELOW the reader leaves `scrollTop` untouched, so the only
 * thing that moves the container is a reader action. But a scroll EVENT is not
 * a safe place to read that, because the browser dispatches scroll events
 * asynchronously — by the time the handler runs, the next SSE frame may already
 * have grown the transcript, and "am I near the bottom?" then answers no for a
 * reader who never left. A first cut of this hook did exactly that and the
 * follow latched off ~20 s into every turn, with the debug trace reading
 * `sync follow=false sH=1170 sT=402` (an 80 px gap that no reader created).
 * Comparing the container against the pin the hook itself last wrote is immune
 * to that, because growth cannot change `scrollTop` at all.
 *
 * So the layout effect below owns the whole state machine: it turns the follow
 * off when something moved the container off our pin, re-arms it when the
 * reader is parked at the tail, and pins otherwise. It runs in a layout effect
 * so the write lands before paint — a passive effect would show one frame of
 * the answer below the fold on every token.
 *
 * `resetKey` re-measures once per session. That is the seam with the
 * persisted-position restore in `chat.tsx`: on a session change the reader has
 * no tail-follow history, and the restore decides where they land. A restore
 * that arrives a frame later (it runs in a rAF) is picked up by the very next
 * commit — either as an off-pin move, or as a re-arm if the restored position
 * is the tail.
 *
 * `revision` is any value that changes when the transcript grows — `chat.tsx`
 * passes the `units` array, whose identity changes on every SSE frame.
 *
 * Deliberately NOT smooth: smooth scrolling chases a target that moves with
 * every token, so it lags behind the stream and overshoots when the turn ends.
 */
export function useChatTailFollow(
  scrollerRef: RefObject<HTMLElement>,
  revision: unknown,
  resetKey?: string | null,
): ChatTailFollow {
  const followingRef = useRef(false);
  const pinnedTopRef = useRef<number | null>(null);
  const lastResetKeyRef = useRef<string | null | undefined>(undefined);

  const followNow = useCallback(() => {
    followingRef.current = true;
    pinnedTopRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      followingRef.current = isNearBottom({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      });
      // Seed the pin with where the container is RIGHT NOW, not `null`. The
      // persisted-position restore in `chat.tsx` runs in a rAF, so it lands
      // after this commit; seeding the baseline is what makes that move visible
      // to the next commit as "somebody moved the container", which is what
      // keeps a reader who reopened a session mid-history off the follow. With
      // a `null` baseline the first post-restore commit would see no movement,
      // keep following, and drag them to the tail a frame after restore.
      pinnedTopRef.current = el.scrollTop;
      return;
    }

    const metrics = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };

    // Off-switch, then re-arm, then pin — in that order, all on one reading of
    // the DOM taken after the new content is laid out.
    if (followingRef.current) {
      const pinnedTop = pinnedTopRef.current;
      if (pinnedTop !== null && isAwayFromPin({ scrollTop: metrics.scrollTop, pinnedTop })) {
        followingRef.current = false;
        pinnedTopRef.current = null;
      }
    } else if (isAtTail(metrics)) {
      // The reader scrolled back down to the newest line on their own.
      followingRef.current = true;
    }

    const target = computeTailFollowScrollTop({ following: followingRef.current, ...metrics });
    if (target === null) return;
    if (el.scrollTop !== target) el.scrollTop = target;
    // Record where the container actually ended up, not where we aimed: a
    // browser that clamps the write would otherwise read as "the reader moved"
    // on the next commit and switch the follow off.
    pinnedTopRef.current = el.scrollTop;
  }, [revision, resetKey, scrollerRef]);

  return { followNow };
}
