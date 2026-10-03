// webapp/test/context-meter-toggle.test.ts
//
// Contract pins for SB-3 — the General page's 上下文窗口用量显示 switch
// (`webui-context-window-usage`) reaching the composer-side readout.
//
// Before this change the key was written and never read, so flipping the
// switch changed nothing on screen. What is pinned here:
//
//   1. The flag's default and its read/write contract, so a default flip
//      (which would show or hide the meter for every existing user) fails
//      here first.
//   2. The live channel in `lib/settings-local.ts`, driven for real:
//      subscribing, being notified on write, unsubscribing, surviving a
//      listener that throws, and the settings row's commit helper
//      (persist-then-notify) reaching subscribers.
//   3. The gate in `components/context-meter.tsx` and the live wiring, on
//      the source. The webapp suite has no client-render harness: the only
//      renderer is `renderToStaticMarkup`, and `useSession()` answers
//      `getServerSnapshot` with the module's INITIAL snapshot, so any
//      store-connected component renders its empty branch under SSR whether
//      or not the flag is on. A markup assertion there would pass in both
//      states and prove nothing; these are pinned on the source instead, the
//      way settings-general-sections.test.ts pins the consumers it cannot
//      drive. The pins assert ORDER as well as presence — a gate that runs
//      after the snapshot check still reads the session state while opted
//      out, and an inverted gate renders the meter for everyone.
//
// The window stub is installed through Object.defineProperty on
// `globalThis` BEFORE the imports, the pattern settings-general-sections
// and theme.test.ts established.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// --- window stub (before the module import) ---------------------------------

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  },
});

import {
  CONTEXT_WINDOW_USAGE_KEY,
  commitContextWindowUsage,
  readContextWindowUsage,
  subscribeContextWindowUsage,
  writeContextWindowUsage,
} from "../lib/settings-local";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) =>
  readFileSync(resolve(here, relative), "utf8");

beforeEach(() => {
  storage.clear();
});

describe("webui-context-window-usage: the flag", () => {
  test("the stored default is off — the reference's default, unchanged", () => {
    // Changing this default would show or hide the composer-side readout for
    // every existing user on upgrade, so it is a pinned contract.
    assert.equal(CONTEXT_WINDOW_USAGE_KEY, "webui-context-window-usage");
    assert.equal(readContextWindowUsage(), false);
  });

  test("anything but the exact string \"true\" reads as off", () => {
    for (const stored of ["false", "", "TRUE", "1", "on"]) {
      storage.set(CONTEXT_WINDOW_USAGE_KEY, stored);
      assert.equal(readContextWindowUsage(), false, `stored ${JSON.stringify(stored)}`);
    }
    storage.set(CONTEXT_WINDOW_USAGE_KEY, "true");
    assert.equal(readContextWindowUsage(), true);
  });
});

describe("webui-context-window-usage: live channel", () => {
  test("a write notifies every subscriber with the written value", () => {
    const seen: boolean[] = [];
    const off = subscribeContextWindowUsage((value) => void seen.push(value));
    commitContextWindowUsage(() => {}, true);
    commitContextWindowUsage(() => {}, false);
    off();
    writeContextWindowUsage(true);
    assert.deepEqual(seen, [true, false]);
  });

  test("unsubscribing stops the updates", () => {
    let calls = 0;
    const off = subscribeContextWindowUsage(() => void (calls += 1));
    off();
    writeContextWindowUsage(true);
    assert.equal(calls, 0);
  });

  test("a listener that throws does not cost the others their update", () => {
    const seen: boolean[] = [];
    subscribeContextWindowUsage(() => {
      throw new Error("subscriber blew up");
    });
    const off = subscribeContextWindowUsage((value) => void seen.push(value));
    writeContextWindowUsage(true);
    off();
    assert.deepEqual(seen, [true]);
  });

  test("the settings row's commit helper reaches subscribers, and persists", () => {
    let calls = 0;
    const off = subscribeContextWindowUsage(() => void (calls += 1));
    commitContextWindowUsage(() => {}, true);
    off();
    assert.equal(calls, 1);
    assert.equal(storage.get(CONTEXT_WINDOW_USAGE_KEY), "true");
  });

  test("a pass reaches a listener that unsubscribed while the pass ran", () => {
    // The pass iterates a snapshot of the subscriber set, so every listener
    // subscribed when the write happened is called exactly once — a listener
    // that tears down a LATER listener mid-pass does not silently cost it
    // this update. Iterating the live Set instead would skip it. Subscription
    // order is call order, so the unsubscriber has to be registered first.
    const order: string[] = [];
    let offSecond = (): void => {};
    const offFirst = subscribeContextWindowUsage(() => {
      order.push("first");
      offSecond();
    });
    offSecond = subscribeContextWindowUsage(() => void order.push("second"));
    writeContextWindowUsage(true);
    offFirst();
    assert.deepEqual(order, ["first", "second"]);
  });

  test("a listener that unsubscribes itself mid-pass does not disturb the pass", () => {
    const order: string[] = [];
    const off = subscribeContextWindowUsage(() => {
      off();
      order.push("first");
    });
    const offSecond = subscribeContextWindowUsage(() => void order.push("second"));
    writeContextWindowUsage(true);
    off();
    offSecond();
    assert.deepEqual(order, ["first", "second"]);
  });
});

describe("context-meter.tsx: the gate and the live wiring", () => {
  test("the meter reads the flag at mount and subscribes to later writes", () => {
    const source = read("../components/context-meter.tsx");
    assert.ok(
      source.includes("useState(readContextWindowUsage)"),
      "the meter must read the stored flag at mount",
    );
    assert.ok(
      source.includes("useEffect(() => subscribeContextWindowUsage(setVisible), [])"),
      "the meter must subscribe to the flag's live channel and unsubscribe on unmount",
    );
  });

  test("the gate runs before the snapshot check, and is not inverted", () => {
    const source = read("../components/context-meter.tsx");
    const gate = source.indexOf("if (!visible) return null;");
    const snapshot = source.indexOf("const context = state?.context;");
    assert.ok(gate !== -1, "the meter must not draw anything while the switch is off");
    assert.ok(
      gate < snapshot,
      "the switch gate must run before the session-state read: an opted-out meter never looks at the snapshot",
    );
  });

  test("no hook is declared after the early returns", () => {
    // The `expanded` disclosure state used to be declared below
    // `if (!context || !context.limit) return null;`, which made a hook
    // conditional on whether a snapshot had arrived. React's hook order is
    // fixed per component, so that is a crash waiting for the first render
    // that follows a non-render.
    const source = read("../components/context-meter.tsx");
    // Scan the component body only — the module-level helpers above it have
    // their own `if (...) return` lines that mean nothing here.
    const start = source.indexOf("export function ContextMeter(");
    assert.ok(start !== -1, "expected the ContextMeter component declaration");
    const body = source.slice(start);
    for (const hook of ["useState\\(", "useRef\\(", "useEffect\\(", "useCallback\\("]) {
      const firstReturn = body.indexOf("\n  if (");
      assert.ok(firstReturn !== -1, "expected an early return in the component body");
      const declarations = [...body.matchAll(new RegExp(hook, "g"))].map(
        (match) => match.index ?? -1,
      );
      for (const index of declarations) {
        assert.ok(
          index < firstReturn,
          `${hook} is declared after the first early return in context-meter.tsx`,
        );
      }
    }
  });

  test("the composer still mounts the meter unconditionally", () => {
    // The gate lives inside ContextMeter, not at the call site: the one
    // mount point (composer toolbar, immediately left of the model chip)
    // must not grow a second condition that could disagree with it.
    assert.ok(
      read("../components/composer.tsx").includes("<ContextMeter t={t} />"),
      "the composer's context-meter mount point must stay unconditional",
    );
  });
});
