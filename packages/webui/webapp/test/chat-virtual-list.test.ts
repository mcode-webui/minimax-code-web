// webapp/test/chat-virtual-list.test.ts
// Unit tests for components/chat-virtual-list.tsx — pure-logic helpers for
// chat-list virtualization (Lease C04 — port to the Next.js webui).
//
// Why this test exists:
//   The Next.js webui is migrating away from the legacy vanilla-JS renderer.
//   The legacy kept the visible DOM bounded for a 10 000-message transcript
//   (~150 nodes) by computing a render window from scroll metrics. This file
//   pins the same math on the TypeScript port so the contract is preserved
//   byte-for-byte: above the threshold N, the visible window is bounded
//   around the user's scroll position, the threshold decides whether to
//   engage virtualization, and the scroll-behaviour decision distinguishes
//   "actively watching" from "scrolled up to read history".
//
//   All assertions drive pure functions — `computeVirtualWindow`,
//   `isNearBottom`, `decideScrollBehavior`, `computeTailFollowScrollTop`,
//   `estimateDomNodeCount` — plus two render-wiring tripwires that read
//   chat.tsx / chat-virtual-list.tsx as source. The hooks
//   `useChatVirtualization` and `useChatTailFollow` are integration-tested by
//   chat.tsx itself (no jsdom here).
//
// Ticket 88 (`computeTailFollowScrollTop`): the transcript has to keep its
// streaming tail inside the visible box. The pure tests pin the arithmetic; the
// tripwires pin that chat.tsx actually calls the hook, because a hook with
// passing unit tests and no call site is dead code.
//
// Performance contract: for 10 000 messages the visible DOM stays under
// ~200 nodes (visible + buffer + 2 spacers). `estimateDomNodeCount` pins
// this bound.
//
// Note on imports: the source file is a `.tsx` because it also exports the
// React hook `useChatVirtualization`. The pure functions do not touch React,
// but loading the module evaluates the React imports — which is fine under
// the `tsx` loader that this package's `test:webapp` uses.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  VIRTUAL_LIST_THRESHOLD,
  ESTIMATED_MESSAGE_HEIGHT,
  VIRTUAL_LIST_BUFFER,
  NEAR_BOTTOM_PX,
  computeVirtualWindow,
  computeTailFollowScrollTop,
  TAIL_FOLLOW_TOLERANCE_PX,
  isAwayFromPin,
  isAtTail,
  isNearBottom,
  decideScrollBehavior,
  estimateDomNodeCount,
  chatVirtualMetricsEqual,
} from "../components/chat-virtual-list";

// ============================================================
// Constants: pinned exports — anything that changes here is a
// break-glass decision (visible DOM size, scroll precision, etc.).
// ============================================================
describe("constants — pinned by performance contract", () => {
  test("VIRTUAL_LIST_THRESHOLD = 200 (below this N, full render wins)", () => {
    assert.equal(VIRTUAL_LIST_THRESHOLD, 200);
  });
  test("ESTIMATED_MESSAGE_HEIGHT = 80 px (scrollbar precision vs cost)", () => {
    assert.equal(ESTIMATED_MESSAGE_HEIGHT, 80);
  });
  test("VIRTUAL_LIST_BUFFER = 50 units (scroll headroom)", () => {
    assert.equal(VIRTUAL_LIST_BUFFER, 50);
  });
  test("NEAR_BOTTOM_PX = 50 px (auto-scroll trigger threshold)", () => {
    assert.equal(NEAR_BOTTOM_PX, 50);
  });
});

// ============================================================
// computeVirtualWindow: above threshold N, the visible window is
// bounded around scrollTop, and useVirtual=true. Below threshold N,
// full render.
// ============================================================
describe("computeVirtualWindow — virtual window math", () => {
  test("below threshold → useVirtual=false, render everything", () => {
    const out = computeVirtualWindow({
      totalCount: 199,
      scrollTop: 0,
      clientHeight: 600,
    });
    assert.equal(out.useVirtual, false);
    assert.equal(out.startIdx, 0);
    assert.equal(out.endIdx, 199);
    assert.equal(out.topSpacer, 0);
    assert.equal(out.bottomSpacer, 0);
  });

  test("at threshold (exactly 200) → useVirtual=true", () => {
    const out = computeVirtualWindow({
      totalCount: 200,
      scrollTop: 0,
      clientHeight: 600,
    });
    assert.equal(
      out.useVirtual,
      true,
      "N == threshold → virtual kicks in (>=, not >)",
    );
  });

  test("at top of scroll, buffer extends below (clamped at 0 above)", () => {
    const out = computeVirtualWindow({
      totalCount: 10_000,
      scrollTop: 0,
      clientHeight: 600,
    });
    assert.equal(out.useVirtual, true);
    assert.equal(out.startIdx, 0, "buffer above clamped at 0 — no negative index");
    // visibleEnd = ceil(600/80) = 8, plus buffer 50 = 58
    assert.equal(out.endIdx, 58);
    assert.equal(out.topSpacer, 0);
    // bottomSpacer = (10000 - 58) * 80 = 9942 * 80 = 795_360
    assert.equal(out.bottomSpacer, (10_000 - 58) * 80);
  });

  test("in middle of scroll, buffer extends both ways", () => {
    // scrollTop = 80_000 → visibleStart = 1000, visibleEnd = ceil(80600/80) = 1008
    const out = computeVirtualWindow({
      totalCount: 10_000,
      scrollTop: 80_000,
      clientHeight: 600,
    });
    assert.equal(out.visibleStart, 1000);
    assert.equal(out.visibleEnd, 1008);
    // startIdx = 1000 - 50 = 950
    assert.equal(out.startIdx, 950);
    // endIdx = 1008 + 50 = 1058
    assert.equal(out.endIdx, 1058);
    assert.equal(out.topSpacer, 950 * 80);
    assert.equal(out.bottomSpacer, (10_000 - 1058) * 80);
  });

  test("near bottom, endIdx clamps at totalCount", () => {
    // scrollTop = 799_200 → visibleStart = 9990, visibleEnd = ceil(799800/80) = 9998
    // startIdx = 9940, endIdx = min(10000, 10048) = 10000
    const out = computeVirtualWindow({
      totalCount: 10_000,
      scrollTop: 799_200,
      clientHeight: 600,
    });
    assert.equal(out.startIdx, 9940);
    assert.equal(out.endIdx, 10_000, "endIdx clamped at totalCount when buffer extends past bottom");
    assert.equal(out.bottomSpacer, 0, "no bottom spacer when endIdx == totalCount");
  });

  test("scrollTop below 0 clamps at 0 (defensive)", () => {
    const out = computeVirtualWindow({
      totalCount: 10_000,
      scrollTop: -100,
      clientHeight: 600,
    });
    assert.equal(out.startIdx, 0);
    assert.equal(out.topSpacer, 0);
  });

  test("clientHeight 0 → empty visible window", () => {
    const out = computeVirtualWindow({
      totalCount: 10_000,
      scrollTop: 0,
      clientHeight: 0,
    });
    assert.equal(out.visibleStart, 0);
    assert.equal(out.visibleEnd, 0, "ceil(0/80)=0 — no visible messages but buffer still applies");
    // startIdx = max(0, 0 - 50) = 0; endIdx = min(10000, 0 + 50) = 50
    assert.equal(out.startIdx, 0);
    assert.equal(out.endIdx, 50);
  });

  test("totalCount 0 → empty window, useVirtual depends on threshold", () => {
    const out = computeVirtualWindow({
      totalCount: 0,
      scrollTop: 0,
      clientHeight: 600,
    });
    // totalCount 0 < threshold 200 → useVirtual=false
    assert.equal(out.useVirtual, false);
    assert.equal(out.startIdx, 0);
    assert.equal(out.endIdx, 0);
  });

  test("DOM count math: 10k messages → ~150 rendered", () => {
    const out = computeVirtualWindow({
      totalCount: 10_000,
      scrollTop: 400_000, // middle of chat
      clientHeight: 600,
    });
    const rendered = out.endIdx - out.startIdx;
    assert.ok(
      rendered < 200,
      `10k messages should render ≤200 nodes; got ${rendered}`,
    );
    assert.ok(
      rendered >= VIRTUAL_LIST_BUFFER * 2,
      `rendered slice must include at least 2*buffer (top + bottom)`,
    );
  });

  test("custom rowHeight / buffer / threshold are honoured", () => {
    const out = computeVirtualWindow({
      totalCount: 1000,
      scrollTop: 0,
      clientHeight: 200,
      rowHeight: 40,
      buffer: 5,
      threshold: 50,
    });
    // totalCount 1000 > threshold 50 → virtual
    assert.equal(out.useVirtual, true);
    // visibleStart = 0; visibleEnd = ceil(200/40) = 5
    assert.equal(out.visibleStart, 0);
    assert.equal(out.visibleEnd, 5);
    // startIdx = max(0, 0-5) = 0; endIdx = min(1000, 5+5) = 10
    assert.equal(out.startIdx, 0);
    assert.equal(out.endIdx, 10);
    assert.equal(out.topSpacer, 0);
    assert.equal(out.bottomSpacer, (1000 - 10) * 40);
  });
});

// ============================================================
// isNearBottom: px threshold from the bottom; true means the user
// is "stuck" to the bottom (actively watching). Empty container
// returns true (no scroll position to preserve).
// ============================================================
describe("isNearBottom — px threshold detector", () => {
  test("exactly at bottom → true", () => {
    assert.equal(
      isNearBottom({ scrollTop: 1000, clientHeight: 200, scrollHeight: 1200 }),
      true,
    );
  });

  test("within 50 px of bottom → true (within threshold)", () => {
    // scrollTop + clientHeight = 1200 - 30 = 1170; scrollHeight - threshold = 1150
    // 1170 >= 1150 → true
    assert.equal(
      isNearBottom({ scrollTop: 970, clientHeight: 200, scrollHeight: 1200 }),
      true,
    );
  });

  test("more than 50 px from bottom → false (user scrolled up)", () => {
    // scrollTop + clientHeight = 1100; scrollHeight - threshold = 1150
    // 1100 < 1150 → false
    assert.equal(
      isNearBottom({ scrollTop: 900, clientHeight: 200, scrollHeight: 1200 }),
      false,
    );
  });

  test("empty container (scrollHeight 0) → true (no position to preserve)", () => {
    assert.equal(
      isNearBottom({ scrollTop: 0, clientHeight: 200, scrollHeight: 0 }),
      true,
    );
  });

  test("custom threshold (10 px) tightens the boundary", () => {
    // scrollTop + clientHeight = 1200 - 60 = 1140; scrollHeight - 10 = 1190
    // 1140 < 1190 → false at threshold=10
    assert.equal(
      isNearBottom({
        scrollTop: 940,
        clientHeight: 200,
        scrollHeight: 1200,
        threshold: 10,
      }),
      false,
    );
    // but at default 50 → 1140 >= 1150 → false (still false)
    // at threshold=200 → 1140 >= 1000 → true
    assert.equal(
      isNearBottom({
        scrollTop: 940,
        clientHeight: 200,
        scrollHeight: 1200,
        threshold: 200,
      }),
      true,
    );
  });
});

// ============================================================
// decideScrollBehavior: maps isNearBottom to 'auto' or 'preserve'.
// 'auto' = scroll to bottom on new message (typical case).
// 'preserve' = keep user position (they're reading history).
// ============================================================
describe("decideScrollBehavior — auto vs preserve", () => {
  test("at bottom → 'auto'", () => {
    assert.equal(
      decideScrollBehavior({
        scrollTop: 1000,
        clientHeight: 200,
        scrollHeight: 1200,
      }),
      "auto",
    );
  });

  test("scrolled up → 'preserve'", () => {
    assert.equal(
      decideScrollBehavior({
        scrollTop: 100,
        clientHeight: 200,
        scrollHeight: 1200,
      }),
      "preserve",
    );
  });

  test("empty container → 'auto' (nothing to preserve)", () => {
    assert.equal(
      decideScrollBehavior({
        scrollTop: 0,
        clientHeight: 200,
        scrollHeight: 0,
      }),
      "auto",
    );
  });
});

// ============================================================
// estimateDomNodeCount: quantifies the savings. With 10k messages
// the savings are ~98 % — the cap on the per-render DOM cost.
// This is the headline performance-contract assertion.
// ============================================================
describe("estimateDomNodeCount — perf contract pin", () => {
  test("below threshold: no savings (full render)", () => {
    const out = estimateDomNodeCount({ totalCount: 100 });
    assert.equal(out.withVirtual, out.withoutVirtual);
    assert.equal(out.savings, 0);
  });

  test("10k messages: virtual keeps DOM ≤ 200", () => {
    const out = estimateDomNodeCount({ totalCount: 10_000 });
    assert.equal(out.withoutVirtual, 10_000);
    assert.ok(
      out.withVirtual <= 200,
      `10k messages should virtualize to ≤200 nodes; got ${out.withVirtual}`,
    );
    assert.ok(
      out.savings > 9_800,
      `savings should be >98 %; got ${out.savings} nodes saved`,
    );
  });

  test("200 messages: just at threshold, savings kick in", () => {
    const out = estimateDomNodeCount({ totalCount: 200 });
    // totalCount >= threshold → useVirtual=true
    // visibleEnd = ceil(600/80) = 8, withVirtual = 8 + 100 + 2 = 110
    assert.ok(out.savings > 0, "at threshold N, virtualization saves nodes");
  });

  test("larger clientHeight = more visible rows, larger DOM", () => {
    const small = estimateDomNodeCount({ totalCount: 10_000, clientHeight: 600 });
    const large = estimateDomNodeCount({ totalCount: 10_000, clientHeight: 2000 });
    assert.ok(
      large.withVirtual > small.withVirtual,
      "taller viewport → more rows visible → more DOM nodes",
    );
  });
});

// ============================================================
// computeTailFollowScrollTop — ticket 88.
//
// The invariant: while a turn streams, the tail of the transcript is inside the
// scroller's visible box. Growing the transcript below the fold leaves
// `scrollTop` untouched, so without this pin the streaming answer renders but
// never becomes visible — the reader watches 「思考中」 for the whole turn.
//
// The measurements below are taken from the unfixed build's live trace
// (1440×900 viewport, 688 px scroller): the scroller sat at scrollTop 0 for
// the whole 15 s turn while scrollHeight went 688 → 1196. Each step replays
// that trace and asserts the tail stays pinned, and — the half that is easy to
// ship wrong — that a reader who scrolled up is left alone.
// ============================================================
describe("computeTailFollowScrollTop — streaming tail stays visible", () => {
  // One table-driven pass over the recorded turn: [scrollTop before, scrollHeight after].
  // Every row is a state the unfixed build actually sat in.
  const MEASURED_TURN: ReadonlyArray<readonly [number, number]> = [
    [0, 688], // content still fits: nothing to do
    [0, 798],
    [0, 820],
    [0, 900], // first overflow — unfixed build now strands the answer below the fold
    [0, 1010],
    [0, 1037],
    [0, 1091],
    [0, 1142],
    [0, 1196],
  ];

  test("the tail is pinned on every measured step of the unfixed turn", () => {
    const clientHeight = 688;
    for (const [scrollTopBefore, scrollHeightAfter] of MEASURED_TURN) {
      const target = computeTailFollowScrollTop({
        following: true,
        scrollHeight: scrollHeightAfter,
        clientHeight,
      });
      assert.notEqual(target, null, `following reader must get a target at ${scrollHeightAfter}px`);
      // The invariant, stated as geometry: after the pin, the bottom of the
      // content coincides with the bottom of the viewport.
      assert.ok(
        target! + clientHeight >= scrollHeightAfter,
        `at scrollHeight=${scrollHeightAfter}: tail must be inside the box, got scrollTop=${target}`,
      );
      // And the pin is monotonic — each step moves down, never back up, so the
      // reader is never yanked backwards by their own streaming answer.
      assert.ok(
        target! >= scrollTopBefore,
        `at scrollHeight=${scrollHeightAfter}: follow must not move the reader up (${scrollTopBefore} → ${target})`,
      );
    }
  });

  test("a reader who scrolled up is never dragged back to the tail", () => {
    // 200 px of scrollTop against a 1196 px transcript: mid-history.
    assert.equal(
      computeTailFollowScrollTop({ following: false, scrollHeight: 1196, clientHeight: 688 }),
      null,
    );
  });

  test("content shorter than the viewport clamps to 0, not a negative scrollTop", () => {
    assert.equal(
      computeTailFollowScrollTop({ following: true, scrollHeight: 400, clientHeight: 688 }),
      0,
    );
    // Exactly the viewport: 0, and no negative target to write.
    assert.equal(
      computeTailFollowScrollTop({ following: true, scrollHeight: 688, clientHeight: 688 }),
      0,
    );
  });

  test("empty container (scrollHeight 0) clamps to 0 rather than throwing", () => {
    assert.equal(
      computeTailFollowScrollTop({ following: true, scrollHeight: 0, clientHeight: 0 }),
      0,
    );
  });

  test("one token of growth still moves the pin by exactly that token", () => {
    // The per-token contract: 20 px of new text moves the pin 20 px, so the
    // newest line is always at the bottom edge of the box.
    const before = computeTailFollowScrollTop({
      following: true,
      scrollHeight: 1000,
      clientHeight: 688,
    });
    const after = computeTailFollowScrollTop({
      following: true,
      scrollHeight: 1020,
      clientHeight: 688,
    });
    assert.equal(after! - before!, 20);
  });

  test("isNearBottom still gates the initial follow on a session change", () => {
    // On a session change the hook has no pin to compare against yet, so the
    // wide reading is the right one: "near enough to the tail to start
    // following". Max scrollTop on this transcript is 508 px: 200 px is
    // mid-history (do not follow), 498 px is 10 px off the tail (follow).
    assert.equal(isNearBottom({ scrollTop: 200, clientHeight: 688, scrollHeight: 1196 }), false);
    assert.equal(
      isNearBottom({ scrollTop: 1196 - 688 - 10, clientHeight: 688, scrollHeight: 1196 }),
      true,
    );
  });
});

// ============================================================
// The off-switch and the re-arm.
//
// The follow survives a streaming turn only because these two read the
// CONTAINER, never a nearness test against the freshly grown DOM. Replay the
// measured failure: the unfixed-then-first-fixed build's debug trace recorded
// `sync follow=false sH=1170 sT=402` — an 80 px gap that no reader created,
// produced by a queued scroll event dispatching after the next SSE frame had
// already grown the transcript. `isAwayFromPin` at that same moment says
// "nobody moved" (the reader is still exactly where the pin left them), which
// is the only correct answer.
// ============================================================
describe("isAwayFromPin / isAtTail — the follow state machine", () => {
  test("TAIL_FOLLOW_TOLERANCE_PX = 2 (sub-pixel noise, well under one wheel tick)", () => {
    assert.equal(TAIL_FOLLOW_TOLERANCE_PX, 2);
  });

  test("growth alone never reads as the reader leaving", () => {
    // The measured failure frame: pinned at 402, transcript grew 1090 → 1170.
    // A nearness test here answers "no, 80 px from the bottom" and would kill a
    // follow the reader never asked to end.
    assert.equal(
      isAwayFromPin({ scrollTop: 402, pinnedTop: 402 }),
      false,
      "an 80 px growth below the reader must not read as the reader scrolling away",
    );
    // And the near-bottom reading of the same frame is the trap, pinned here so
    // nobody reintroduces it:
    assert.equal(
      isNearBottom({ scrollTop: 402, clientHeight: 688, scrollHeight: 1170 }),
      false,
      "this is exactly the misread the off-switch must not depend on",
    );
  });

  test("a real scroll away is detected", () => {
    assert.equal(isAwayFromPin({ scrollTop: 200, pinnedTop: 402 }), true);
    // PageUp: 600 px in one tick, far outside any plausible noise.
    assert.equal(isAwayFromPin({ scrollTop: 0, pinnedTop: 600 }), true);
  });

  test("sub-pixel drift is not a scroll away", () => {
    assert.equal(isAwayFromPin({ scrollTop: 402.5, pinnedTop: 402 }), false);
    assert.equal(isAwayFromPin({ scrollTop: 401.9, pinnedTop: 402 }), false);
    // 2.1 px is outside the tolerance — anchoring nudges are sub-pixel, a
    // deliberate move is not.
    assert.equal(isAwayFromPin({ scrollTop: 404.1, pinnedTop: 402 }), true);
  });

  test("explicit tolerance overrides the default", () => {
    assert.equal(isAwayFromPin({ scrollTop: 410, pinnedTop: 402, tolerance: 20 }), false);
    assert.equal(isAwayFromPin({ scrollTop: 410, pinnedTop: 402, tolerance: 0 }), true);
  });

  test("isAtTail is the strict re-arm reading, not the 50 px one", () => {
    // Parked exactly on the newest line → re-arm.
    assert.equal(isAtTail({ scrollTop: 482, clientHeight: 688, scrollHeight: 1170 }), true);
    // Parked 40 px above it → still reading something else. isNearBottom would
    // call this "close enough"; the re-arm must not.
    assert.equal(isAtTail({ scrollTop: 442, clientHeight: 688, scrollHeight: 1170 }), false);
    assert.equal(isNearBottom({ scrollTop: 442, clientHeight: 688, scrollHeight: 1170 }), true);
  });

  test("a transcript shorter than the viewport is at its tail", () => {
    assert.equal(isAtTail({ scrollTop: 0, clientHeight: 688, scrollHeight: 400 }), true);
  });
});

// ============================================================
// Render-wiring tripwire.
//
// The suite has no jsdom, so the pure-function tests above cannot see whether
// chat.tsx actually calls the hook. A hook that is unit-tested but never wired
// ships dead code that its own tests pass — this pins the call site.
// ============================================================
describe("chat.tsx wires the tail follow into the render path", () => {
  const chatSource = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");

  test("imports and calls useChatTailFollow with the growing units as revision", () => {
    assert.match(
      chatSource,
      /import\s*\{[^}]*\buseChatTailFollow\b[^}]*\}\s*from\s*"\.\/chat-virtual-list"/,
      "chat.tsx must import useChatTailFollow from ./chat-virtual-list",
    );
    assert.match(
      chatSource,
      /useChatTailFollow\(\s*scrollerRef\s*,\s*units\s*,\s*sessionKey\s*\)/,
      "chat.tsx must call useChatTailFollow(scrollerRef, units, sessionKey): the " +
        "revision has to be the growing unit list and the reset key the session, " +
        "or the follow never re-applies / never re-measures on a session change",
    );
  });

  test("the 'jump to latest' pill re-arms the follow", () => {
    // The pill is the one affordance that says "take me back to the tail". The
    // pin re-arms on a position reading, which the pill's own scroll is about to
    // change, so the click has to re-arm explicitly.
    assert.match(
      chatSource,
      /const\s*\{[^}]*\bfollowNow\b[^}]*\}\s*=\s*useChatTailFollow\(/,
      "chat.tsx must destructure followNow from useChatTailFollow",
    );
    assert.match(
      chatSource,
      /const scrollToBottom = useCallback\(\(\) => \{[\s\S]{0,400}?followNow\(\)/,
      "scrollToBottom (the pill handler) must call followNow()",
    );
  });

  test("the follow hook decides at a commit boundary, not on a scroll event", () => {
    const source = readFileSync(
      new URL("../components/chat-virtual-list.tsx", import.meta.url),
      "utf8",
    );
    // A scroll EVENT is dispatched asynchronously: by the time its handler runs
    // the next SSE frame may already have grown the transcript, so a nearness
    // test there latches the follow off mid-turn. The decision has to be made
    // in a layout effect, on one settled reading of the DOM.
    assert.doesNotMatch(
      source,
      /addEventListener\("scroll",[^)]*followingRef/,
      "the follow flag must not be maintained from a scroll listener",
    );
    assert.match(source, /useLayoutEffect\(/, "the follow must run in a layout effect");
    assert.match(
      source,
      /isAwayFromPin\(\{\s*scrollTop: metrics\.scrollTop,\s*pinnedTop/,
      "the off-switch must compare against the pin, not against nearness",
    );
  });
});

describe("chatVirtualMetricsEqual — the bail-out that breaks the observer loop", () => {
  // useChatVirtualization's recompute runs from scroll, ResizeObserver, and a
  // post-render rAF. Each driver used to build a fresh metrics object, and
  // React compares by reference — an unchanged layout still re-rendered, the
  // re-render could move scrollHeight, the ResizeObserver re-fired, and the
  // identity loop spun (same mechanism markdown-toc fixed for its outline
  // width). The hook must bail out when every field is unchanged; this pins
  // the comparison the bail-out rides on.

  const base = computeVirtualWindow({ totalCount: 0, scrollTop: 0, clientHeight: 0 });
  const metricsOf = (window_: typeof base, isNearBottom = true, stuck = false) => ({
    window: window_,
    isNearBottom,
    stuck,
  });

  test("equal fields with DIFFERENT object references compare equal", () => {
    // The whole point: the recompute always builds a fresh window object, so
    // reference equality would always report "changed". Field equality is what
    // lets React bail out.
    const a = metricsOf(base);
    const b = metricsOf({ ...base });
    assert.notEqual(a.window, b.window, "precondition: distinct references");
    assert.notEqual(a, b, "precondition: distinct objects");
    assert.equal(chatVirtualMetricsEqual(a, b), true);
  });

  test("any moved field breaks the equality", () => {
    const a = metricsOf(base);
    assert.equal(
      chatVirtualMetricsEqual(a, metricsOf({ ...base, startIdx: 1 })),
      false,
      "window.startIdx",
    );
    assert.equal(
      chatVirtualMetricsEqual(a, metricsOf({ ...base, topSpacer: 40 })),
      false,
      "window.topSpacer",
    );
    assert.equal(
      chatVirtualMetricsEqual(a, metricsOf({ ...base }, false)),
      false,
      "isNearBottom",
    );
    assert.equal(
      chatVirtualMetricsEqual(a, metricsOf({ ...base }, true, true)),
      false,
      "stuck",
    );
  });

  test("the hook commits through the bail-out, never a bare new-object setMetrics", () => {
    const source = readFileSync(
      new URL("../components/chat-virtual-list.tsx", import.meta.url),
      "utf8",
    );
    // The mutation that reintroduces the loop is a recompute writing
    // `setMetrics({window: computeVirtualWindow(...), ...})` directly — a new
    // reference on every call. All commit paths must go through the
    // field-comparing setter.
    assert.match(
      source,
      /const setMetricsIfChanged = useCallback\(/,
      "useChatVirtualization must define the field-comparing setter",
    );
    assert.match(
      source,
      /chatVirtualMetricsEqual\(current, next\) \? current : next/,
      "the setter must return the current reference when fields are equal",
    );
    assert.doesNotMatch(
      source,
      /setMetrics\(\{/,
      "recompute must never setMetrics a fresh object literal — that is the " +
        "identity loop (reference-inequal even when the layout is unchanged)",
    );
  });
});
