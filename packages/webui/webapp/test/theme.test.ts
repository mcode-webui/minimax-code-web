// webapp/test/theme.test.ts
//
// Pure-logic pins for the slice-18 three-state appearance control.
//
// The helpers under test live in webapp/lib/theme.ts. They touch the
// document and localStorage, so the test harness stubs both through
// Object.defineProperty on `globalThis` BEFORE the module is imported —
// lib/theme.ts has no top-level window/document access, only top-level
// function definitions, so stubbing then importing is enough.
//
// What we DO NOT exercise here:
//   - The actual <html> class flip on a real DOM (this is wired through
//     document, which the test harness approximates).
//   - The CSS token resolution; tokens.css is a runtime artefact and
//     out of scope for unit tests.
//
// The live self-check (real browser, real prefs flip) is the canonical
// end-to-end verification; this file pins the contract so a refactor of
// lib/theme.ts without touching the matching test surfaces a CI
// failure.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- DOM + storage stubs --------------------------------------------------

class StubClassList {
  private set = new Set<string>();
  add(name: string) {
    this.set.add(name);
  }
  remove(name: string) {
    this.set.delete(name);
  }
  contains(name: string) {
    return this.set.has(name);
  }
  reset() {
    this.set.clear();
  }
}

class StubStyle {
  private values = new Map<string, string>();
  setProperty(name: string, value: string) {
    this.values.set(name, value);
  }
  reset() {
    this.values.clear();
  }
  // `colorScheme` is a real CSSStyleDeclaration property in browsers — both
  // readable and writable. The test stub mirrors that with a getter + setter
  // so `root.style.colorScheme = theme` writes through.
  get colorScheme() {
    return this.values.get("color-scheme") ?? "";
  }
  set colorScheme(value: string) {
    this.values.set("color-scheme", value);
  }
}

class StubElement {
  classList = new StubClassList();
  style = new StubStyle();
}

class StubStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

interface MqlListener {
  (event: { matches: boolean; media: string }): void;
}

class StubMediaQueryList {
  listeners = new Set<MqlListener>();
  constructor(
    public readonly media: string,
    private readonly isDarkQuery: boolean,
    private readonly getPrefersDark: () => boolean,
  ) {}
  get matches() {
    if (this.isDarkQuery) return this.getPrefersDark();
    return false;
  }
  addEventListener(_type: string, cb: MqlListener) {
    if (_type === "change") this.listeners.add(cb);
  }
  removeEventListener(_type: string, cb: MqlListener) {
    if (_type === "change") this.listeners.delete(cb);
  }
  /** Test-only: fire a fake change event. */
  dispatch(matches: boolean) {
    for (const cb of this.listeners) cb({ matches, media: this.media });
  }
}

let prefsDark = false;
const storage = new StubStorage();
const documentElement = new StubElement();

/** Cache matchMedia per-query. Both `subscribeSystemTheme` and the test
 *  reach `window.matchMedia(...)` independently — they need to land on
 *  the SAME StubMediaQueryList instance for the listener registered by
 *  the former to fire when the latter calls `dispatch()`. */
const mediaQueryCache = new Map<string, StubMediaQueryList>();
const matchMedia = (query: string) => {
  let mql = mediaQueryCache.get(query);
  if (!mql) {
    mql = new StubMediaQueryList(
      query,
      query.includes("(prefers-color-scheme: dark)"),
      () => prefsDark,
    );
    mediaQueryCache.set(query, mql);
  }
  return mql;
};

Object.defineProperty(globalThis, "window", {
  configurable: true,
  writable: true,
  value: {
    localStorage: storage,
    matchMedia,
  },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  writable: true,
  value: { documentElement },
});

// IMPORTANT: import AFTER stubs are in place. lib/theme.ts checks
// `typeof window` lazily inside each function, not at the top level, so
// the stubs only need to exist at call time — but import order is
// clearest when the stubs are first.
const {
  applyAppearance,
  currentAppearance,
  resolvedTheme,
  subscribeSystemTheme,
  currentTheme,
} = await import("../lib/theme");

// --- tests -----------------------------------------------------------------

beforeEach(() => {
  storage.clear();
  prefsDark = false;
  documentElement.classList.reset();
  documentElement.style.reset();
  // Drop the cached matchMedia objects too — each test sets up its own
  // listener state, and a stale cache would re-fire old listeners.
  mediaQueryCache.clear();
});

describe("currentAppearance — reads from webui:ui:v1:<cid>", () => {
  test("returns null when nothing is stored", () => {
    assert.equal(currentAppearance(), null);
  });

  test("returns null when the payload is malformed", () => {
    storage.setItem("webui:ui:v1:anon", "not json");
    assert.equal(currentAppearance(), null);
  });

  test("returns null when the appearance value is not a valid choice", () => {
    storage.setItem(
      "webui:ui:v1:anon",
      JSON.stringify({
        version: 1,
        cid: "anon",
        state: { appearance: "rainbow" },
      }),
    );
    assert.equal(currentAppearance(), null);
  });

  test("returns the stored choice when valid", () => {
    for (const choice of ["light", "dark", "system"] as const) {
      storage.clear();
      storage.setItem(
        "webui:ui:v1:anon",
        JSON.stringify({
          version: 1,
          cid: "anon",
          state: { appearance: choice },
        }),
      );
      assert.equal(currentAppearance(), choice);
    }
  });
});

describe("applyAppearance — writes through to the UiState envelope", () => {
  test("writes the choice and updates the document class", () => {
    applyAppearance("light");
    const stored = storage.getItem("webui:ui:v1:anon");
    assert.ok(stored, "storage was not updated");
    const parsed = JSON.parse(stored) as { state?: { appearance?: string } };
    assert.equal(parsed.state?.appearance, "light");
    assert.ok(documentElement.classList.contains("light"));
    assert.equal(documentElement.style.colorScheme, "light");
  });

  test("preserves sibling fields when the user already had a sidebar state", () => {
    storage.setItem(
      "webui:ui:v1:anon",
      JSON.stringify({
        version: 1,
        cid: "anon",
        state: { sidebarCollapsed: true, lastSessionId: "mvs_deadbeef" },
      }),
    );
    applyAppearance("dark");
    const parsed = JSON.parse(
      storage.getItem("webui:ui:v1:anon") as string,
    ) as {
      state?: Record<string, unknown>;
    };
    assert.equal(parsed.state?.appearance, "dark");
    assert.equal(parsed.state?.sidebarCollapsed, true);
    assert.equal(parsed.state?.lastSessionId, "mvs_deadbeef");
  });

  test("resolves 'system' through matchMedia at write time", () => {
    prefsDark = true;
    applyAppearance("system");
    assert.ok(documentElement.classList.contains("dark"));
    documentElement.classList.reset();
    prefsDark = false;
    applyAppearance("system");
    assert.ok(documentElement.classList.contains("light"));
  });
});

describe("resolvedTheme — picks from choice + matchMedia", () => {
  test("explicit light ignores matchMedia", () => {
    storage.setItem(
      "webui:ui:v1:anon",
      JSON.stringify({
        version: 1,
        cid: "anon",
        state: { appearance: "light" },
      }),
    );
    prefsDark = true;
    assert.equal(resolvedTheme(), "light");
  });

  test("explicit dark ignores matchMedia", () => {
    storage.setItem(
      "webui:ui:v1:anon",
      JSON.stringify({
        version: 1,
        cid: "anon",
        state: { appearance: "dark" },
      }),
    );
    prefsDark = false;
    assert.equal(resolvedTheme(), "dark");
  });

  test("system follows matchMedia", () => {
    storage.setItem(
      "webui:ui:v1:anon",
      JSON.stringify({
        version: 1,
        cid: "anon",
        state: { appearance: "system" },
      }),
    );
    prefsDark = true;
    assert.equal(resolvedTheme(), "dark");
    prefsDark = false;
    assert.equal(resolvedTheme(), "light");
  });

  test("null choice falls back to matchMedia (legacy behaviour)", () => {
    prefsDark = true;
    assert.equal(resolvedTheme(), "dark");
    prefsDark = false;
    assert.equal(resolvedTheme(), "light");
  });
});

describe("subscribeSystemTheme — fires on matchMedia change", () => {
  test("explicit 'light' / 'dark' choices do NOT react to OS flips", () => {
    storage.setItem(
      "webui:ui:v1:anon",
      JSON.stringify({
        version: 1,
        cid: "anon",
        state: { appearance: "light" },
      }),
    );
    let calls = 0;
    const unsubscribe = subscribeSystemTheme(() => {
      calls += 1;
    });
    // Fire a fake change event by reaching into the matchMedia stub.
    const mql = (
      window as unknown as { matchMedia: (q: string) => StubMediaQueryList }
    ).matchMedia("(prefers-color-scheme: dark)");
    mql.dispatch(true);
    assert.equal(calls, 0, "explicit choice should not react to matchMedia");
    unsubscribe();
  });

  test("'system' choice DOES react to OS flips", () => {
    storage.setItem(
      "webui:ui:v1:anon",
      JSON.stringify({
        version: 1,
        cid: "anon",
        state: { appearance: "system" },
      }),
    );
    const seen: string[] = [];
    const unsubscribe = subscribeSystemTheme((next) => {
      seen.push(next);
    });
    const mql = (
      window as unknown as { matchMedia: (q: string) => StubMediaQueryList }
    ).matchMedia("(prefers-color-scheme: dark)");
    mql.dispatch(true);
    mql.dispatch(false);
    unsubscribe();
    assert.deepEqual(seen, ["dark", "light"]);
  });

  test("unsubscribe detaches the listener", () => {
    storage.setItem(
      "webui:ui:v1:anon",
      JSON.stringify({
        version: 1,
        cid: "anon",
        state: { appearance: "system" },
      }),
    );
    let calls = 0;
    const unsubscribe = subscribeSystemTheme(() => {
      calls += 1;
    });
    unsubscribe();
    const mql = (
      window as unknown as { matchMedia: (q: string) => StubMediaQueryList }
    ).matchMedia("(prefers-color-scheme: dark)");
    mql.dispatch(true);
    assert.equal(calls, 0);
  });
});

describe("currentTheme — reads from <html>", () => {
  test("returns 'light' when only 'light' is set", () => {
    documentElement.classList.add("light");
    assert.equal(currentTheme(), "light");
  });

  test("returns 'dark' when 'dark' is set", () => {
    documentElement.classList.add("dark");
    assert.equal(currentTheme(), "dark");
  });
});
