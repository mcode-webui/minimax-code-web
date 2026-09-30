// webapp/test/thinking-phrase-rotation.test.ts
//
// The streaming indicator's phrase rotation (webui-parity 61, G5).
//
// The schedule and the draw are transcribed from the reference package
// (`src/client/components/ActivityIndicator.tsx`), so most of this is
// numeric: the three timing constants, the bucket weights, and the
// no-consecutive-repeat rule. The last two are the ones a "the phrase
// changes" test cannot catch — a pure random draw over a 24-phrase bucket
// repeats about 4% of the time, and a uniform draw over the whole 42-phrase
// table would make the generic copy rare. Both are measured here over
// thousands of draws with an injected source, so a regression shows up as a
// number rather than as a flake someone re-runs.
//
// The reduced-motion behaviour is asserted as a DECISION, not an accident:
// the rotation keeps running under `prefers-reduced-motion` while the dots
// and the shimmer stay switched off. See the module docblock in
// components/loading-states.tsx for the reasoning.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ActivityPulse,
  THINKING_PHRASE_ROTATION_INTERVAL_MS,
  THINKING_PHRASE_START_DELAY_MAX_MS,
  THINKING_PHRASE_START_DELAY_MIN_MS,
  bucketPhrases,
  computeThinkingPhraseStartDelay,
  pickWeightedPhrase,
} from "../components/loading-states";
import { THINKING_PHRASES, thinkingPhrases } from "../lib/thinking-phrases";
import type { Locale } from "../lib/i18n";
import { LOCALES } from "../lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const loadingSource = readFileSync(resolve(here, "../components/loading-states.tsx"), "utf8");
const globalsCss = readFileSync(resolve(here, "../app/globals.css"), "utf8");

/** A deterministic uniform source in [0, 1) — the test never touches the
 *  global `Math.random`, so a failure is reproducible from the seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** The rotation hook's own body — not the component below it, whose docblock
 *  discusses the motion preference. */
function hookSource(): string {
  const start = loadingSource.indexOf("function useRotatedThinkingPhrase");
  assert.ok(start >= 0, "the rotation hook must exist");
  const end = loadingSource.indexOf("\n}\n", start);
  assert.ok(end > start, "the rotation hook must have a closing brace");
  return loadingSource.slice(start, end);
}

const ZH_BUCKETS = bucketPhrases(thinkingPhrases("zh"));

/** Replay a rotation: `count` draws chained the way the effect chains them —
 *  the same two calls the effect makes, in the same order. */
function rotate(count: number, seed = 20260930): string[] {
  const random = lcg(seed);
  const out: string[] = [];
  let previous: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const next = pickWeightedPhrase(ZH_BUCKETS, previous, random);
    previous = next;
    if (next !== null) out.push(next);
  }
  return out;
}

describe("the rotation schedule matches the reference", () => {
  test("the three constants are the reference values", () => {
    assert.equal(THINKING_PHRASE_START_DELAY_MIN_MS, 2000);
    assert.equal(THINKING_PHRASE_START_DELAY_MAX_MS, 3000);
    assert.equal(THINKING_PHRASE_ROTATION_INTERVAL_MS, 3500);
  });

  test("the first swap lands inside the 2–3 s window", () => {
    // The point of the window: a turn that answers in under two seconds keeps
    // one calm label instead of flickering through three.
    for (const source of [lcg(1), lcg(2), lcg(3), () => 0, () => 0.999999]) {
      const delay = computeThinkingPhraseStartDelay(
        THINKING_PHRASE_START_DELAY_MIN_MS,
        THINKING_PHRASE_START_DELAY_MAX_MS,
        source,
      );
      assert.ok(
        delay >= THINKING_PHRASE_START_DELAY_MIN_MS && delay <= THINKING_PHRASE_START_DELAY_MAX_MS,
        `start delay ${delay} escaped the window`,
      );
    }
  });

  test("an inverted window degrades to the lower bound instead of going negative", () => {
    assert.equal(computeThinkingPhraseStartDelay(3000, 2000, lcg(7)), 3000);
  });

  test("the component schedules with the constants, not with literals", () => {
    assert.match(loadingSource, /setTimeout\(tick, THINKING_PHRASE_ROTATION_INTERVAL_MS\)/);
    assert.match(
      loadingSource,
      /computeThinkingPhraseStartDelay\(\s*THINKING_PHRASE_START_DELAY_MIN_MS,\s*THINKING_PHRASE_START_DELAY_MAX_MS,\s*\)/,
    );
  });
});

describe("the draw is weighted, not uniform", () => {
  test("the buckets carry the reference weights in draw order", () => {
    const buckets = bucketPhrases(thinkingPhrases("zh"));
    assert.deepEqual(
      buckets.map((b) => [b.key, b.weight]),
      [
        ["basic", 0.75],
        ["specific", 0.15],
        ["motion", 0.1],
      ],
    );
  });

  test("an empty category drops out instead of poisoning the draw", () => {
    const buckets = bucketPhrases({ basic: ["a"], specific: [], motion: [] });
    assert.deepEqual(
      buckets.map((b) => b.key),
      ["basic"],
    );
  });

  test("a measured rotation lands on the reference shares", () => {
    // 10 000 draws: the standard error on a 0.75 share is ~0.0043, so the
    // ±0.05 bands below are more than ten sigma wide. A uniform draw over the
    // whole 42-phrase table would report basic ≈ 24/42 = 0.57 and fail this,
    // which is exactly the regression the weights exist to prevent.
    const phrases = thinkingPhrases("zh");
    const buckets = bucketPhrases(phrases);
    const random = lcg(4242);
    const counts = new Map<string, number>();
    let previous: string | null = null;
    for (let i = 0; i < 10000; i += 1) {
      const next = pickWeightedPhrase(buckets, previous, random);
      previous = next;
      const key = next !== null && phrases.basic.includes(next)
        ? "basic"
        : next !== null && phrases.specific.includes(next)
          ? "specific"
          : next !== null && phrases.motion.includes(next)
            ? "motion"
            : "unknown";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const share = (key: string) => (counts.get(key) ?? 0) / 10000;
    assert.ok(share("basic") > 0.7 && share("basic") < 0.8, `basic share ${share("basic")}`);
    assert.ok(share("specific") > 0.1 && share("specific") < 0.2, `specific share ${share("specific")}`);
    assert.ok(share("motion") > 0.05 && share("motion") < 0.15, `motion share ${share("motion")}`);
    assert.equal(counts.get("unknown") ?? 0, 0, "every draw must land in a real bucket");
  });

  test("an exhausted total weight yields nothing rather than a wrong answer", () => {
    assert.equal(pickWeightedPhrase([], null), null);
    assert.equal(pickWeightedPhrase([{ key: "basic", weight: 0, phrases: ["a"] }], null), null);
  });
});

describe("the phrase never repeats back to back", () => {
  test("two thousand chained draws contain no consecutive repeat", () => {
    // Over a 24-phrase bucket a pure random draw repeats roughly every 25
    // draws, so 2 000 draws is a decisive sample: removing the previous-phrase
    // filter cannot pass this by luck.
    const drawn = rotate(2000);
    assert.equal(drawn.length, 2000);
    for (let i = 1; i < drawn.length; i += 1) {
      assert.notEqual(
        drawn[i],
        drawn[i - 1],
        `draw ${i} repeated draw ${i - 1} ("${drawn[i]}")`,
      );
    }
  });

  test("the filter applies to the drawn bucket, not the whole table", () => {
    // Only phrases inside the chosen bucket can collide; filtering the entire
    // table would distort the weights.
    const phrases = { basic: ["a", "b"], specific: ["c"], motion: ["d"] };
    const buckets = bucketPhrases(phrases);
    assert.equal(pickWeightedPhrase(buckets, "a", () => 0.01), "b");
    // A previous phrase that is not in the drawn bucket changes nothing.
    assert.equal(pickWeightedPhrase(buckets, "zzz", () => 0.01), "a");
  });

  test("a single-phrase bucket still returns that phrase", () => {
    // The filter must not empty a one-entry pool — that would return null and
    // blank the label.
    const buckets = bucketPhrases({ basic: ["only"], specific: [], motion: [] });
    assert.equal(pickWeightedPhrase(buckets, "only", lcg(3)), "only");
  });
});

describe("the phrase tables are complete in both locales", () => {
  test("every locale fills every bucket, with no duplicates inside a bucket", () => {
    for (const locale of LOCALES) {
      const set = THINKING_PHRASES[locale];
      for (const key of ["basic", "specific", "motion"] as const) {
        assert.ok(set[key].length > 0, `${locale}.${key} is empty`);
        assert.equal(
          new Set(set[key]).size,
          set[key].length,
          `${locale}.${key} repeats a phrase`,
        );
      }
    }
  });

  test("the two locales carry the same vocabulary shape", () => {
    // A locale that lost a bucket would silently rotate over fewer phrases;
    // the bucket sizes are asserted equal so that shows up as a compile- or
    // test-time failure rather than as a noticeably emptier English UI.
    for (const key of ["basic", "specific", "motion"] as const) {
      assert.equal(
        THINKING_PHRASES.zh[key].length,
        THINKING_PHRASES.en[key].length,
        `${key} differs between locales`,
      );
    }
  });

  test("the two locales never share a phrase verbatim", () => {
    // zh copy is not a transliteration of en here; an identical string in both
    // tables means one side was pasted from the other.
    const zh = new Set(Object.values(THINKING_PHRASES.zh).flat());
    for (const phrase of Object.values(THINKING_PHRASES.en).flat()) {
      assert.ok(!zh.has(phrase), `phrase "${phrase}" is identical in both locales`);
    }
  });

  test("the lookup returns a stable object per locale", () => {
    // The rotation effect depends on this value. A fresh object per call would
    // re-arm the timer on every render of the indicator — a per-token
    // re-render storm in the middle of a stream.
    assert.equal(thinkingPhrases("zh"), thinkingPhrases("zh"));
    assert.equal(thinkingPhrases("en"), thinkingPhrases("en"));
    assert.notEqual(thinkingPhrases("zh"), thinkingPhrases("en"));
  });
});

describe("the component is a leaf the stream cannot disturb", () => {
  const renderPulse = (locale?: Locale) =>
    renderToStaticMarkup(createElement(ActivityPulse, { label: "正在干活", locale }));

  test("the server render shows the caller's phase label, unrotated", () => {
    // Effects do not run on the server, so hydration starts from the same
    // markup and there is no first-paint swap.
    assert.match(renderPulse("zh"), /正在干活/);
    assert.match(renderPulse("en"), /正在干活/);
  });

  test("the label lives in its own element with its own testid", () => {
    // The swap re-renders this one span; nothing above it is in the update
    // path, which is what keeps a phrase change off the transcript's re-render
    // set during streaming.
    assert.match(renderPulse("zh"), /data-testid="activity-indicator-label"/);
    assert.match(loadingSource, /<span data-testid="activity-indicator-label"/);
  });

  test("the effect depends on the phrase table alone", () => {
    const hook = hookSource();
    assert.match(hook, /\}, \[phrases\]\);/);
    // A per-render closure or a `label` dependency would re-arm the schedule
    // on every render — and `label` changes with the engine's phase, which is
    // exactly what must not restart the clock.
    assert.doesNotMatch(hook, /\[phrases,\s*label\]/);
    assert.doesNotMatch(hook, /\[active,\s*phrases\]/);
  });

  test("the timer is cleared on cleanup and chained, never an interval", () => {
    const hook = hookSource();
    assert.match(hook, /clearTimeout\(timerRef\.current\)/);
    assert.match(hook, /cancelled = true/);
    assert.match(hook, /if \(cancelled\) return;/);
    assert.doesNotMatch(hook, /setInterval/);
  });
});

describe("reduced motion — the rotation continues, the animation does not", () => {
  test("the rotation never consults the motion preference", () => {
    // The decision, stated as an assertion: a phrase swap is a discrete text
    // replacement, not motion. The reference makes the same trade — its
    // prefers-reduced-motion branch halts the lottie and leaves the label
    // ticking — and stopping the rotation would re-create the frozen-label
    // defect G5 exists to remove.
    const hook = hookSource();
    assert.doesNotMatch(hook, /matchMedia/);
    assert.doesNotMatch(hook, /prefers-reduced-motion/);
  });

  test("the animated half of the indicator is switched off under reduce", () => {
    // What the decision leans on: the dots and the shimmer keep their
    // existing explicit rules in globals.css, so the reduced-motion user sees
    // a still indicator with a still-ticking label.
    const start = globalsCss.indexOf("@media (prefers-reduced-motion: reduce)");
    assert.ok(start >= 0, "globals.css must carry a prefers-reduced-motion block");
    const block = globalsCss.slice(start, globalsCss.indexOf("\n}", start));
    assert.match(block, /\.mavis-skeleton-bar\s*\{\s*animation:\s*none;?\s*\}/);
    assert.match(block, /\.mavis-loading \.mavis-dot\s*\{\s*animation:\s*none\s*!important;?\s*\}/);
  });

  test("the chevron's rotation is a transition, which the catch-all does cover", () => {
    // The turn-bar chevron rotates through `transition-transform`. The
    // catch-all forces `transition-duration`, which is exactly what a
    // transition needs — unlike an animation, whose `animation-name` the
    // catch-all never touches. So no extra reduced-motion rule is needed, and
    // adding one would be a duplicate of what is already in force.
    const start = globalsCss.indexOf("@media (prefers-reduced-motion: reduce)");
    const block = globalsCss.slice(start, globalsCss.indexOf("\n}", start));
    assert.match(block, /transition-duration:\s*0\.001ms\s*!important/);
  });
});
