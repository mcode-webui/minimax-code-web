"use client";

// Unlike the other components here, this file imports React explicitly:
// webapp/test/loading-skeleton.test.ts renders it through react-dom/server
// under the tsx loader, which honours `jsx: "preserve"` by falling back to
// the classic runtime — there is no Next compiler in that process to inject
// the automatic one.
import * as React from "react";

/**
 * Loading states for the conversation surface (webui ticket U8 — skeleton +
 * streaming activity indicator).
 *
 * Three pieces, all pure display: no hooks, no store, no transport.
 *
 *   TranscriptSkeleton        shimmer placeholder shown while the session
 *                             snapshot has not arrived (the page-level
 *                             `!state` branch). Mirrors the real message-row
 *                             layout — right-aligned user bubble, full-width
 *                             assistant text lines, a tool-card bar with
 *                             indented child rows — so the first content
 *                             paint does not reflow sideways or vertically
 *                             jump the way a bare spinner or a blank column
 *                             does.
 *   ActivityPulse             the "still streaming" indicator rendered at the
 *                             transcript tail while the engine is running.
 *                             The shimmer bar stands in for the desktop's
 *                             lottie loader: same read ("more output is on
 *                             its way"), no lottie-web dependency.
 *   isSessionActivityActive   the gate the tail indicator reads. Exported as
 *                             a pure function so the on/off decision is
 *                             unit-testable without a DOM or a store.
 *
 * Motion: every animated class here (`mavis-skeleton-bar`,
 * `.mavis-loading` dots) is switched off under
 * `prefers-reduced-motion: reduce` — explicit per-class rules live in
 * `app/globals.css` next to the keyframes. When motion is removed the label
 * text stays visible, which is the same trade the upstream desktop
 * indicator makes (lottie halts, the phrase keeps ticking).
 *
 * Colours come from the semantic token pair the desktop skeleton loader uses
 * (`--bg_default_tertiary` base, `--bg_default_secondary` highlight sweep),
 * so both themes are covered by the token layer — no per-theme rules here.
 */

/** Engine-activity gate: true while the session is streaming a turn. */
export function isSessionActivityActive(
  state: { running?: { active?: boolean } } | null | undefined,
): boolean {
  return state?.running?.active ?? false;
}

/** One shimmering placeholder bar. Width/height come from the caller. */
function SkeletonBar({ className }: { className: string }) {
  return <div aria-hidden="true" className={`mavis-skeleton-bar ${className}`} />;
}

/**
 * Transcript-shaped loading skeleton.
 *
 * Row shapes track the real transcript rows in `components/chat.tsx`:
 *
 *   user row      `mb-4` + `justify-end` + a rounded-[16px] bubble whose
 *                 inner line is one text line tall (`px-3 py-2` + a 20px
 *                 line ≈ 38px) — so the real bubble lands on the same box.
 *   assistant row full-width multi-line text lines at reading widths
 *                 (76% / 53% / 63%), tail group dissolved with the same
 *                 vertical gradient mask the desktop skeleton uses.
 *   tool row      an icon-sized dash plus an indented text line, standing in
 *                 for the ActivityGroup summary line and its collapsed body.
 *
 * `aria-hidden` keeps the placeholder out of the accessibility tree; the
 * wrapping branch announces loading through the page copy, not the skeleton.
 */
export function TranscriptSkeleton(): React.JSX.Element {
  const gradientMask: React.CSSProperties = {
    maskImage: "linear-gradient(180deg, black 0%, transparent 100%)",
    WebkitMaskImage: "linear-gradient(180deg, black 0%, transparent 100%)",
  };
  return (
    <div
      data-testid="transcript-skeleton"
      aria-hidden="true"
      className="w-full select-none"
    >
      {/* user turn */}
      <div className="mb-4 flex w-full justify-end">
        <SkeletonBar className="h-[38px] w-[42%] rounded-[16px]" />
      </div>
      {/* assistant turn: paragraph lines + a dissolving tail */}
      <div className="mb-4 w-full">
        <div className="flex flex-col gap-[10px]">
          <SkeletonBar className="h-[14px] w-[76%] rounded-md" />
          <SkeletonBar className="h-[14px] w-[53%] rounded-md" />
          <SkeletonBar className="h-[14px] w-[63%] rounded-md" />
        </div>
        <div className="mt-2 flex flex-col gap-2" style={gradientMask}>
          <SkeletonBar className="h-[14px] w-[35%] rounded-md" />
        </div>
      </div>
      {/* tool activity: summary line + indented output rows */}
      <div className="mb-4 w-full">
        <div className="flex items-center gap-2">
          <SkeletonBar className="h-4 w-4 shrink-0 rounded" />
          <SkeletonBar className="h-[14px] w-[45%] rounded-md" />
        </div>
        <div className="mt-2 flex flex-col gap-2 pl-6" style={gradientMask}>
          <SkeletonBar className="h-[12px] w-[58%] rounded-md" />
          <SkeletonBar className="h-[12px] w-[31%] rounded-md" />
        </div>
      </div>
      {/* second user turn, so a tall viewport reads as a conversation */}
      <div className="mb-4 flex w-full justify-end">
        <SkeletonBar className="h-[38px] w-[28%] rounded-[16px]" />
      </div>
    </div>
  );
}

/**
 * Streaming activity indicator: the desktop's three-dot loader, plus a
 * shimmer bar in the assistant column position — the spot where the next
 * line of output will land, which is what makes "still streaming" readable
 * at a glance. `role="status"` lets assistive tech announce the state
 * change without the decorative bars (all `aria-hidden`) being read aloud.
 */
export function ActivityPulse({ label }: { label: string }): React.JSX.Element {
  return (
    <div
      data-testid="activity-indicator"
      role="status"
      className="flex items-center gap-2 py-2 text-text_default_tertiary"
    >
      <span className="mavis-loading" aria-hidden="true">
        <span className="mavis-dot mavis-dot-a" />
        <span className="mavis-dot mavis-dot-b" />
        <span className="mavis-dot mavis-dot-c" />
      </span>
      <span className="text-activity-body-small">{label}</span>
      <SkeletonBar className="ml-1 inline-block h-[14px] w-24 rounded-md" />
    </div>
  );
}
