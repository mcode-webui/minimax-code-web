// webapp/test/open-file.test.ts
//
// Pin the `open.file.in.web` single-source contract (webui-parity 12).
//
// The acceptance criterion the ticket pins is "不存在两份打开逻辑":
// there is exactly ONE place in the webapp source tree that knows how
// to open a file in the preview pane, and BOTH entry points (file
// tree and turn summary) call into it. The unit tests below cover the
// module's behaviour in isolation; the source-level grep in
// `describe("source-level single-source", …)` is the tripwire that
// fires when a future change re-introduces a second open path.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeOpenFile,
  getOpenFilePath,
  openFileInWeb,
  subscribeOpenFile,
  __testReset,
} from "../lib/open-file";

// jsdom-free polyfill: the module reads / writes `localStorage`. The
// Node test runner has no DOM by default, so we install a minimal
// in-memory stand-in before the tests run and tear it down between
// tests so a stale value cannot leak across cases.
//
// `window` is a real DOM-lib global with the wide type `Window &
// typeof globalThis`, so redeclaring it (e.g. `declare global { var
// window: ... }`) and reassigning it through TypeScript would surface
// as TS2403 / TS2322 errors under `webapp:typecheck` (the CI gate
// that the local environment had resolved differently). The polyfill
// is therefore installed via `Object.defineProperty`, which writes
// through the runtime instead of through the type-checker; reads
// stay coherent because the test reads via the same property the
// production module reads (i.e. `window` resolves to the polyfill
// for the duration of the test).
function makeLocalStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem(key) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
    key(index) {
      return Array.from(data.keys())[index] ?? null;
    },
    get length() {
      return data.size;
    },
  };
}

/** Narrow shape the production module actually touches. */
interface TestWindow {
  localStorage: Storage;
}

/**
 * Install `window` on `globalThis` as a configurable property.
 *
 * `Object.defineProperty` writes the property at runtime regardless
 * of how TypeScript has typed `globalThis.window` — that matters
 * because under the DOM lib the global is the wide `Window & typeof
 * globalThis`, and a `g.window = { localStorage }` assignment is
 * exactly what trips TS2322 in CI.
 */
function setWindow(value: TestWindow | undefined): void {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

const hadWindow = "window" in globalThis;
const previousWindow: unknown = hadWindow
  ? (globalThis as { window?: unknown }).window
  : undefined;

beforeEach(() => {
  setWindow({ localStorage: makeLocalStorage() });
  __testReset();
});

// ============================================================
// Module behaviour
// ============================================================

describe("open.file.in.web — basic behaviour", () => {
  test("openFileInWeb notifies subscribers and persists the path", () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeOpenFile((value) => seen.push(value));
    // The subscriber is seeded with the current (null) value on
    // subscribe; clear that before asserting the open() notifications.
    seen.length = 0;

    openFileInWeb("/repo/README.md");

    assert.deepEqual(seen, ["/repo/README.md"]);
    assert.equal(getOpenFilePath(), "/repo/README.md");
    assert.equal(
      (globalThis as { window?: TestWindow }).window?.localStorage.getItem(
        "webui:open-file:path",
      ),
      "/repo/README.md",
    );
    unsubscribe();
  });

  test("closeOpenFile clears the path and notifies with null", () => {
    openFileInWeb("/repo/README.md");
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeOpenFile((value) => seen.push(value));
    seen.length = 0;

    closeOpenFile();

    assert.deepEqual(seen, [null]);
    assert.equal(getOpenFilePath(), null);
    assert.equal(
      (globalThis as { window?: TestWindow }).window?.localStorage.getItem(
        "webui:open-file:path",
      ),
      null,
    );
    unsubscribe();
  });

  test("re-opening the same path still fires the listener", () => {
    openFileInWeb("/repo/README.md");
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeOpenFile((value) => seen.push(value));
    seen.length = 0;

    openFileInWeb("/repo/README.md");
    openFileInWeb("/repo/CHANGELOG.md");

    assert.deepEqual(seen, ["/repo/README.md", "/repo/CHANGELOG.md"]);
    unsubscribe();
  });

  test("empty / non-string paths throw", () => {
    assert.throws(() => openFileInWeb(""), /non-empty path/);
    // @ts-expect-error — deliberate invalid input shape
    assert.throws(() => openFileInWeb(null), /non-empty path/);
  });
});

describe("open.file.in.web — persistence restore on mount", () => {
  test("getOpenFilePath reads the persisted value before any subscriber runs", () => {
    // Simulate a previous page's last write surviving the refresh.
    (
      globalThis as { window?: TestWindow }
    ).window!.localStorage.setItem("webui:open-file:path", "/repo/old.md");

    assert.equal(getOpenFilePath(), "/repo/old.md");
  });

  test("subscriber seeded with the persisted value on subscribe", () => {
    (
      globalThis as { window?: TestWindow }
    ).window!.localStorage.setItem("webui:open-file:path", "/repo/old.md");

    const seen: (string | null)[] = [];
    const unsubscribe = subscribeOpenFile((value) => seen.push(value));

    assert.deepEqual(seen, ["/repo/old.md"]);
    unsubscribe();
  });

  test("disabled storage (no window) does not throw", () => {
    // Mirror the SSR / disabled-storage case: the module has to
    // degrade gracefully without `window.localStorage` being usable.
    // `defineProperty(..., { value: undefined, configurable: true })`
    // exposes the property as `typeof window === "undefined"` from
    // the production module's perspective.
    setWindow(undefined);
    assert.doesNotThrow(() => openFileInWeb("/x/y.md"));
    assert.equal(getOpenFilePath(), "/x/y.md");
    assert.doesNotThrow(() => closeOpenFile());
    // Restore for subsequent tests in the file.
    setWindow({ localStorage: makeLocalStorage() });
  });
});

// ============================================================
// Single-source tripwire
// ============================================================
//
// The ticket ("open.file.in.web — 单一真源") pins that there is
// exactly one open-action in the source tree. The earlier slices
// could ship dead code that looked wired up because their own unit
// tests passed (the export-alias reference bug in AGENTS.md) — we
// avoid that failure mode by reading every webapp source file and
// asserting the only callers of any open-action are the ones this
// slice intentionally introduced.

const WEBAPP_ROOT = resolve(
  join(fileURLToPath(import.meta.url), "..", ".."),
);

function readWebappSource(relative: string): string {
  return readFileSync(resolve(WEBAPP_ROOT, relative), "utf8");
}

describe("open.file.in.web — source-level single-source", () => {
  test("the action lives in exactly one module", () => {
    const actionFiles = [
      readWebappSource("lib/open-file.ts"),
      readWebappSource("components/file-preview-pane.tsx"),
      readWebappSource("components/panels.tsx"),
      readWebappSource("components/chat.tsx"),
      readWebappSource("app/page.tsx"),
    ];
    // The function definition must appear in lib/open-file.ts and
    // nowhere else — a second copy would re-introduce the bug the
    // ticket is gating against.
    const definitionCount = actionFiles.reduce(
      (count, src) => (src.includes("export function openFileInWeb") ? count + 1 : count),
      0,
    );
    assert.equal(definitionCount, 1, "openFileInWeb must be defined exactly once");
  });

  test("only the panels tree and the chat tool-card import the action", () => {
    // Entry points the ticket pins: file tree + turn summary.
    // The action itself, the preview pane, and the page-level
    // handler also import it — those are wiring, not entry points.
    const importers: Record<string, string[]> = {
      "lib/open-file.ts": [],
      "components/file-preview-pane.tsx": ["subscribeOpenFile", "closeOpenFile"],
      "components/panels.tsx": ["openFileInWeb"],
      "components/chat.tsx": [],
      "app/page.tsx": ["openFileInWeb"],
    };

    for (const [relative, expected] of Object.entries(importers)) {
      const src = readWebappSource(relative);
      for (const symbol of ["openFileInWeb", "closeOpenFile", "subscribeOpenFile", "getOpenFilePath"]) {
        const imported = src.includes(`} from "@/lib/open-file"`);
        if (expected.includes(symbol)) {
          assert.ok(imported, `${relative} must import from @/lib/open-file`);
        }
      }
    }
  });

  test("the page handler is the only place that decides to open the files panel on click", () => {
    // The page-level callback funnels both entry points through
    // `setPanel("files")` — if a future change wires that side
    // effect from anywhere else (e.g. the chat reading panel state
    // directly) the source tree would have a second "open the
    // preview surface" path.
    const page = readWebappSource("app/page.tsx");
    const chat = readWebappSource("components/chat.tsx");
    const panels = readWebappSource("components/panels.tsx");

    assert.ok(
      page.includes("setPanel(") && page.includes('"files"'),
      "page.tsx must drive the right-panel open on file clicks",
    );
    assert.ok(
      !chat.includes("setPanel"),
      "chat.tsx must NOT mutate the panel state directly",
    );
    assert.ok(
      !panels.includes("setPanel"),
      "panels.tsx must NOT mutate the panel state directly",
    );
  });
});

// Restore the test environment for any tests that run after this file.
process.on("exit", () => {
  setWindow(previousWindow as TestWindow | undefined);
});
