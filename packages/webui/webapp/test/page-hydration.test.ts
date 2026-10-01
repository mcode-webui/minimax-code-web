// webapp/test/page-hydration.test.ts
//
// Static-source tripwires for the page root's storage-access timing
// (webui-parity 106, smoke-report P7-b) and for the scroll-restore
// contract that must survive it (red line: 刷新后滚动位置还在).
//
// Why a tripwire and not a unit test: this suite has no React render
// harness (plain `node --test` over the lib modules), and the defect is
// not a function's output but WHERE a function is called from — the
// render phase of the prerendered root component. `app/page.tsx` is
// pre-rendered by the Next.js static export, so the server HTML and the
// client's first (hydration) render must be byte-identical. Any
// `localStorage` read that runs during render returns defaults on the
// server and stored values on the client — a hydration mismatch that
// today is masked by the `state === null` skeleton and detonates the
// moment that skeleton changes. The reads therefore live in exactly one
// place: the post-mount restore effect.
//
// The load-bearing survivor of that move is the transcript scroll
// restore: the page dropped its render-phase `readScrollPosition` call
// because `Chat` already re-reads the SAME per-session key inside its own
// post-mount effect (and falls back to it whenever `initialScrollTop` is
// absent). That fallback IS the restore behaviour now, so it is pinned
// here too.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(here, "../app/page.tsx"), "utf8");
const chatSource = readFileSync(resolve(here, "../components/chat.tsx"), "utf8");

describe("page.tsx never reads storage during render (webui-parity 106)", () => {
  test("no useState initializer calls a persist reader", () => {
    // The pre-106 shape — `useState<UiState>(() => readUiState())` — ran
    // localStorage reads on every (re)render entry, server included.
    assert.ok(
      !/useState[^;]*\(\)\s*=>\s*read(?:UiState|WorkspaceTabs|ScrollPosition)\(/.test(pageSource),
      "page.tsx must not seed state from a storage read — the initializer " +
        "runs during render, and render runs on the static-export server " +
        "too (the hydration bomb P7-b)",
    );
  });

  test("readScrollPosition is gone from the page entirely", () => {
    // The scroll wrapper's render-phase read was the third instance. Chat
    // re-reads the same key post-mount, so the page must not re-grow it.
    assert.ok(
      !pageSource.includes("readScrollPosition"),
      "the page must not read scroll positions at all — the restore lives " +
        "in Chat's sessionKey effect (same key, client-only timing)",
    );
  });

  test("the one storage read lives in the post-mount restore effect", () => {
    const effectIdx = pageSource.indexOf("const restoredUi = readUiState();");
    assert.ok(effectIdx >= 0, "the mount restore must call readUiState()");
    const effect = pageSource.slice(
      pageSource.lastIndexOf("useEffect(", effectIdx),
      effectIdx + 400,
    );
    assert.match(effect, /readWorkspaceTabs\(\)/, "tabs restore rides the same effect");
    assert.match(effect, /setPersisted\(restoredUi\)/);
    assert.match(effect, /setTabState\(restoredTabs\.tabStrip\)/);
    assert.match(effect, /setColumnState\(restoredTabs\.columnLayout\)/);
    assert.match(effect, /setPanel\(restoredUi\.panel\)/);
    assert.match(effect, /setUiRestored\(true\)/, "the write-back gate must open in the same batch");
  });

  test("every storage write-back is gated on uiRestored", () => {
    // Without the gate, the defaults-seeded first effects would overwrite
    // the stored payload BEFORE the restore ran — the red-line-3 data
    // loss (panel / tabs / appearance gone after a refresh).
    const gateCount = (
      pageSource.match(/if \(!uiRestored\) return;/g) ?? []
    ).length;
    assert.ok(
      gateCount >= 3,
      `expected the write-gate in the panel, tabs and lastSessionId mirrors, found ${gateCount}`,
    );
    assert.match(
      pageSource,
      /useEffect\(\(\) => \{\s*if \(!uiRestored\) return;\s*writeUiState\(/,
      "the panel mirror must be gated",
    );
    assert.match(
      pageSource,
      /useEffect\(\(\) => \{\s*if \(!uiRestored\) return;\s*writeWorkspaceTabs\(/,
      "the workspace-tabs mirror must be gated",
    );
    const lastSessionIdx = pageSource.indexOf("lastSessionId: active,");
    assert.ok(lastSessionIdx >= 0);
    const lastSessionEffect = pageSource.slice(
      pageSource.lastIndexOf("useEffect(", lastSessionIdx),
      lastSessionIdx,
    );
    assert.match(
      lastSessionEffect,
      /if \(!uiRestored\) return;/,
      "the lastSessionId mirror must be gated — it can fire before the " +
        "restore batch and would drop the stored appearance fields",
    );
  });

  test("the first frame still renders the state=null skeleton uniformly", () => {
    // The skeleton is what makes server and client renders identical on
    // the first frame; the restore must not have traded it for a
    // different first-paint path.
    assert.match(pageSource, /if \(!state\) \{/);
    assert.match(pageSource, /<TranscriptSkeleton \/>/);
  });

  test("the default-seeded state declarations still exist", () => {
    // Belt and braces: the two boxes must start from the shared DEFAULT
    // constants (identical on server and client), not from undefined.
    assert.match(pageSource, /useState<UiState>\(DEFAULT_UI_STATE\)/);
    assert.match(
      pageSource,
      /useState<WorkspaceTabsState>\(\s*DEFAULT_WORKSPACE_TABS_STATE,?\s*\)/,
    );
  });
});

describe("Chat owns the scroll restore (red line: 刷新后滚动位置还在)", () => {
  test("the restore reads the persisted key inside the sessionKey effect", () => {
    // Chat's effect re-reads `webui:scroll:v1:<cid>:<sessionId>` whenever
    // the session changes and whenever `initialScrollTop` is absent —
    // which is now ALWAYS, since the page passes no such prop. Break this
    // line and a refresh lands every conversation back at the top.
    assert.match(
      chatSource,
      /const saved = readPersistedScroll\(sessionKey\);/,
      "Chat must re-read the persisted scroll position per session key",
    );
    assert.match(
      chatSource,
      /const best = explicit !== null && explicit > 0 \? explicit : saved;/,
      "the saved value must be the fallback when no explicit prop arrives",
    );
  });

  test("the page still persists scroll positions through onScrollPersist", () => {
    assert.match(
      pageSource,
      /onScrollPersist=\{\(top\) => \{/,
      "the write half of the scroll contract stays on the page",
    );
    assert.match(pageSource, /writeScrollPosition\(sessionId, top\)/);
  });
});
