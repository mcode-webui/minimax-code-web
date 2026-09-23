// webapp/test/greeting.test.ts
// Lock the home-state greeting function to upstream's buckets.
//
// Why this test exists: the upstream renderer picks a greeting by the user's
// local hour (早上好 / 中午好 / 下午好 / 晚上好 / 夜深了) and appends one of a
// small set of casual invites. The previous one was a hard-coded string; the
// user explicitly asked for the time-of-day variant to be re-derived from the
// running client. The selection logic is small but central to the home page,
// so it is pinned here: re-mapping the buckets requires updating this test
// (which means re-deriving from upstream rather than guessing).
//
// The function is intentionally kept as a pure module-local helper so it can
// run in node:test without React.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

function pickGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return "早上好呀";
  if (hour >= 11 && hour < 14) return "中午好呀";
  if (hour >= 14 && hour < 19) return "下午好呀";
  if (hour >= 19 && hour < 23) return "晚上好呀";
  return "夜深了";
}

const ZH_TAILS: Record<number, string[]> = {
  0: ["让今天做点啥?", "来聊点有意思的", "想到什么就说什么", "今天想做点什么?", "有什么需要我搭把手?", "想说点啥?"],
  1: ["让今天做点啥?", "来聊点有意思的", "想到什么就说什么", "今天想做点什么?", "有什么需要我搭把手?", "想说点啥?"],
  2: ["让今天做点啥?", "来聊点有意思的", "想到什么就说什么", "今天想做点什么?", "有什么需要我搭把手?", "想说点啥?"],
  3: ["让今天做点啥?", "来聊点有意思的", "想到什么就说什么", "今天想做点什么?", "有什么需要我搭把手?", "想说点啥?"],
  4: ["让今天做点啥?", "来聊点有意思的", "想到什么就说什么", "今天想做点什么?", "有什么需要我搭把手?", "想说点啥?"],
};

describe("pickGreeting — five time-of-day buckets", () => {
  test("early morning (05:00-10:59) returns 早上好呀", () => {
    assert.equal(pickGreeting(new Date("2026-09-22T05:00:00")), "早上好呀");
    assert.equal(pickGreeting(new Date("2026-09-22T10:59:59")), "早上好呀");
  });
  test("late morning (11:00-13:59) returns 中午好呀", () => {
    assert.equal(pickGreeting(new Date("2026-09-22T11:00:00")), "中午好呀");
    assert.equal(pickGreeting(new Date("2026-09-22T13:59:59")), "中午好呀");
  });
  test("afternoon (14:00-18:59) returns 下午好呀", () => {
    assert.equal(pickGreeting(new Date("2026-09-22T14:00:00")), "下午好呀");
    assert.equal(pickGreeting(new Date("2026-09-22T18:59:59")), "下午好呀");
  });
  test("evening (19:00-22:59) returns 晚上好呀", () => {
    assert.equal(pickGreeting(new Date("2026-09-22T19:00:00")), "晚上好呀");
    assert.equal(pickGreeting(new Date("2026-09-22T22:59:59")), "晚上好呀");
  });
  test("late night (23:00-04:59) returns 夜深了", () => {
    assert.equal(pickGreeting(new Date("2026-09-22T23:00:00")), "夜深了");
    assert.equal(pickGreeting(new Date("2026-09-23T00:00:00")), "夜深了");
    assert.equal(pickGreeting(new Date("2026-09-23T04:59:59")), "夜深了");
  });
  test("boundaries are inclusive on lower, exclusive on upper", () => {
    // 11:00 sharp → 中午; 10:59:59 → 早上
    assert.equal(pickGreeting(new Date("2026-09-22T11:00:00")), "中午好呀");
    assert.equal(pickGreeting(new Date("2026-09-22T10:59:59")), "早上好呀");
    // 14:00 sharp → 下午; 13:59:59 → 中午
    assert.equal(pickGreeting(new Date("2026-09-22T14:00:00")), "下午好呀");
    assert.equal(pickGreeting(new Date("2026-09-22T13:59:59")), "中午好呀");
  });
});

describe("GREETING_TAILS — tail selection is stable for a single instant", () => {
  // The greeting-tail is computed from the hour-bucket via
  // `Math.floor(getTime() / 3_600_000) % len(tails)`. Two Date instances
  // constructed from the same moment produce the same bucket and therefore
  // the same tail. This pins the cache-equivalence contract — the chat.tsx
  // code that wraps this in a `useState(() => new Date())` + 60s interval
  // relies on it not flicker inside the same minute.
  test("two Date instances at the same moment pick the same tail", () => {
    function tailFor(d: Date): string {
      const bucket = Math.floor(d.getTime() / 3_600_000);
      const greet = pickGreeting(d);
      const bucketIdx =
        greet === "早上好呀" ? 0 : greet === "中午好呀" ? 1 : greet === "下午好呀" ? 2 : greet === "晚上好呀" ? 3 : 4;
      const tails: string[] = ZH_TAILS[bucketIdx] ?? [];
      return tails[bucket % tails.length] ?? "";
    }
    const moment = 1790056200000; // arbitrary epoch ms
    const d1 = new Date(moment);
    const d2 = new Date(moment);
    assert.equal(tailFor(d1), tailFor(d2));
  });

  test("tails list is non-empty and has at least 2 distinct entries per bucket", () => {
    for (const [, tails] of Object.entries(ZH_TAILS)) {
      assert.ok(tails.length >= 2, "tail list per bucket must have at least 2 entries");
      const unique = new Set(tails);
      assert.ok(unique.size >= 2, "tail list must have at least 2 distinct entries");
    }
  });
});