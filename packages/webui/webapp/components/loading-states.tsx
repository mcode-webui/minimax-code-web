"use client";

// Unlike the other components here, this file imports React explicitly:
// webapp/test/loading-skeleton.test.ts renders it through react-dom/server
// under the tsx loader, which honours `jsx: "preserve"` by falling back to
// the classic runtime — there is no Next compiler in that process to inject
// the automatic one.
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { THINKING_PHRASES, type ThinkingPhraseSet } from "../lib/thinking-phrases";
import type { Locale } from "../lib/i18n";

/**
 * Loading states for the conversation surface (webui ticket U8 — skeleton +
 * streaming activity indicator; webui-parity 61 G5 — phrase rotation).
 *
 * Three pieces, two of them pure display: no store, no transport.
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
 *                             its way"), no lottie-web dependency. Its label
 *                             rotates through the desktop's phrase table
 *                             (webui-parity 61, G5) — see the rotation
 *                             section below.
 *   isSessionActivityActive   the gate the tail indicator reads. Exported as
 *                             a pure function so the on/off decision is
 *                             unit-testable without a DOM or a store.
 *
 * Phrase rotation (webui-parity 61, G5). The desktop does not park one static
 * label on screen for the length of a turn; it swaps the phrase every few
 * seconds. The schedule and the draw are transcribed from the reference
 * package (`src/client/components/ActivityIndicator.tsx`):
 *
 *   - 2000–3000 ms before the FIRST swap, so a fast turn keeps one calm label
 *     instead of flickering through three;
 *   - 3500 ms between swaps afterwards;
 *   - a weighted bucket draw — basic 0.75, specific 0.15, motion 0.1 — so the
 *     generic copy dominates and the flavourful copy stays rare;
 *   - no consecutive repeat: the previous phrase is filtered out of its
 *     bucket before the uniform draw.
 *
 * Reduced motion does NOT stop the rotation, and this is deliberate. A phrase
 * swap is a discrete text replacement, not motion: there is no translation, no
 * scaling and no continuous movement for a vestibular trigger to react to,
 * and the desktop makes the same trade — its `prefers-reduced-motion` branch
 * halts the lottie playback and leaves the label ticking. Stopping the
 * rotation would also re-create the defect G5 exists to fix (a frozen label
 * over a long turn). The animated half of this component — the three dots and
 * the shimmer bar — is already switched off by the explicit reduced-motion
 * rules in `app/globals.css`.
 *
 * Streaming safety: the timer state lives in `ActivityPulse` itself, the leaf
 * that renders it. A swap calls `setState` on that leaf, so React re-renders
 * one `<span>` and nothing above it — the transcript, the markdown bodies and
 * the streaming cursor are not in the update path. The effect re-arms only
 * when `active` or the locale's phrase table identity changes, and it clears
 * its timeout on cleanup, so a settling turn leaves no timer behind.
 *
 * Motion: every animated class here (`mavis-skeleton-bar`,
 * `.mavis-loading` dots) is switched off under
 * `prefers-reduced-motion: reduce` — explicit per-class rules live in
 * `app/globals.css` next to the keyframes. When motion is removed the label
 * text stays visible, which is the same trade the upstream desktop
 * indicator makes (lottie halts, the phrase keeps ticking).
 *
 * Colours: the base is the user-bubble token (`--bg_grouped_tertiary`) and
 * the sweep is the 15%-black overlay token (`--opacity_black_1_15`), so both
 * themes are covered by the token layer — no per-theme rules here.
 */

/** Engine-activity gate: true while the session is streaming a turn. */
export function isSessionActivityActive(
  state: { running?: { active?: boolean } } | null | undefined,
): boolean {
  return state?.running?.active ?? false;
}

// ---------------------------------------------------------------------------
// Streaming-indicator phrase rotation (webui-parity 61, G5).
// ---------------------------------------------------------------------------

/** Delay before the FIRST swap, lower bound — the reference constant. */
export const THINKING_PHRASE_START_DELAY_MIN_MS = 2000;
/** Delay before the FIRST swap, upper bound. */
export const THINKING_PHRASE_START_DELAY_MAX_MS = 3000;
/** Delay between every later swap. */
export const THINKING_PHRASE_ROTATION_INTERVAL_MS = 3500;

export interface WeightedPhraseBucket {
  readonly key: keyof ThinkingPhraseSet;
  readonly weight: number;
  readonly phrases: readonly string[];
}

/** Bucket draw order with the reference weights (basic 0.75 / specific 0.15 /
 *  motion 0.1). Kept as a table rather than a ratio so the numbers stay
 *  readable next to the reference they came from. */
const DEFAULT_WEIGHTS: readonly { key: keyof ThinkingPhraseSet; weight: number }[] = [
  { key: "basic", weight: 0.75 },
  { key: "specific", weight: 0.15 },
  { key: "motion", weight: 0.1 },
];

/** The drawable buckets, in weight order, with empty ones dropped so a
 *  locale missing a whole category still rotates over the rest. */
export function bucketPhrases(phrases: ThinkingPhraseSet): WeightedPhraseBucket[] {
  return DEFAULT_WEIGHTS.map((entry) => ({
    key: entry.key,
    weight: entry.weight,
    phrases: phrases[entry.key] ?? [],
  })).filter((bucket) => bucket.phrases.length > 0);
}

/**
 * One draw: pick a bucket by weight, then a phrase inside it uniformly,
 * excluding `previous` so the label never repeats back to back.
 *
 * `random` is injected rather than called directly so the schedule and the
 * distribution are testable without a seeded global.
 */
export function pickWeightedPhrase(
  buckets: readonly WeightedPhraseBucket[],
  previous: string | null,
  random: () => number = Math.random,
): string | null {
  if (buckets.length === 0) return null;
  const totalWeight = buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
  if (totalWeight <= 0) return null;
  let threshold = random() * totalWeight;
  let chosen: WeightedPhraseBucket | null = null;
  for (const bucket of buckets) {
    threshold -= bucket.weight;
    if (threshold <= 0) {
      chosen = bucket;
      break;
    }
  }
  // A draw that lands exactly on the total (random() === 1 is not reachable
  // from Math.random, but an injected source can produce it) falls through.
  if (!chosen) chosen = buckets[buckets.length - 1] ?? null;
  if (!chosen) return null;
  const pool = chosen.phrases;
  if (pool.length === 0) return null;
  let candidates = pool;
  if (previous && pool.length > 1) {
    const filtered = pool.filter((entry) => entry !== previous);
    if (filtered.length > 0) candidates = filtered;
  }
  return candidates[Math.floor(random() * candidates.length)] ?? null;
}

/** The first-swap delay, drawn uniformly from the 2–3 s window. */
export function computeThinkingPhraseStartDelay(
  startMinMs: number,
  startMaxMs: number,
  random: () => number = Math.random,
): number {
  return startMinMs + random() * Math.max(0, startMaxMs - startMinMs);
}

/**
 * Drive the phrase rotation for as long as the component is mounted.
 *
 * The gate is the mount itself: `ActivityPulse` is only rendered while the
 * session is streaming (see `isSessionActivityActive`), so mounting starts the
 * schedule and unmounting — a settling turn — ends it. That is why there is
 * no `active` parameter to keep in step with.
 *
 * A chained `setTimeout` rather than a `setInterval` because the first tick's
 * delay is drawn and a cancelled tick must not be able to leave a second one
 * queued. `previous` is a local of the effect, not state: the "no repeat"
 * rule only needs the last draw, and keeping it out of state means a
 * re-render cannot interleave with it.
 */
function useRotatedThinkingPhrase(phrases: ThinkingPhraseSet): string | null {
  const [value, setValue] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setValue(null);

    const buckets = bucketPhrases(phrases);
    let previous: string | null = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const next = pickWeightedPhrase(buckets, previous);
      previous = next;
      setValue(next);
      timerRef.current = setTimeout(tick, THINKING_PHRASE_ROTATION_INTERVAL_MS);
    };

    timerRef.current = setTimeout(
      tick,
      computeThinkingPhraseStartDelay(
        THINKING_PHRASE_START_DELAY_MIN_MS,
        THINKING_PHRASE_START_DELAY_MAX_MS,
      ),
    );

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // `phrases` is a module-level table looked up by locale, so its identity
    // changes only on a locale switch — the effect therefore re-arms on a
    // locale change, not on every render. `Math.random` is not a dependency:
    // it is read inside the tick, not captured per render.
  }, [phrases]);

  return value;
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
 *
 * The label rotates through the desktop's phrase table while the turn runs
 * (webui-parity 61, G5). `label` is the caller's static copy — the engine's
 * four-phase status — and it shows until the first swap, so the phase the
 * engine actually reported is never hidden behind a random phrase. The
 * rotation continues under `prefers-reduced-motion`; see the module docblock
 * for why.
 */
export function ActivityPulse({
  label,
  locale,
}: {
  label: string;
  /** Picks the phrase table. Only the first swap hides `label`. */
  locale?: Locale;
}): React.JSX.Element {
  const phrases = THINKING_PHRASES[locale ?? "zh"];
  const rotated = useRotatedThinkingPhrase(phrases);
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
      <span data-testid="activity-indicator-label" className="text-activity-body-small">
        {rotated ?? label}
      </span>
      <SkeletonBar className="ml-1 inline-block h-[14px] w-24 rounded-md" />
    </div>
  );
}
