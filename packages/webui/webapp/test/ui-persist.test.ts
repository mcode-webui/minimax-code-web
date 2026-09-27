// webapp/test/ui-persist.test.ts
//
// Pure-logic pins for the webui-parity 07 persistence module.
//
// Every helper under test lives in webapp/lib/persist.ts. The persist
// module reads / writes localStorage; the helpers we test here
// (`deserializeUiState`, `deserializeScroll`, the key builders, the
// shape of `DEFAULT_UI_STATE`) are React-free and operate on plain
// strings, so the `node:test` runner covers them directly.
//
// We DO NOT exercise the writer here — the writer uses localStorage,
// which is window-only. The composer's write path is exercised through
// the live self-check (a real browser refresh against an isolated
// instance), which is the canonical regression for "did the write
// actually fire?".

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UI_STATE,
  deserializeScroll,
  deserializeUiState,
  scrollKey,
  SCROLL_VERSION,
  UI_STATE_VERSION,
  uiStateKey,
  type UiState,
} from "../lib/persist";

describe("uiStateKey", () => {
  test("includes cid and version so two cids do not collide", () => {
    assert.equal(uiStateKey("cid-A"), `webui:ui:v${UI_STATE_VERSION}:cid-A`);
    assert.equal(uiStateKey("cid-B"), `webui:ui:v${UI_STATE_VERSION}:cid-B`);
    assert.notEqual(uiStateKey("cid-A"), uiStateKey("cid-B"));
  });

  test("substitutes a stable 'anon' when the cid is missing", () => {
    const emptyKey = uiStateKey("");
    const nullKey = uiStateKey(null);
    const undefinedKey = uiStateKey(undefined);
    assert.equal(emptyKey, `webui:ui:v${UI_STATE_VERSION}:anon`);
    assert.equal(nullKey, `webui:ui:v${UI_STATE_VERSION}:anon`);
    assert.equal(undefinedKey, `webui:ui:v${UI_STATE_VERSION}:anon`);
  });
});

describe("deserializeUiState", () => {
  const cid = "test-cid";
  const validPayload = (state: Partial<UiState>) =>
    JSON.stringify({
      version: UI_STATE_VERSION,
      cid,
      state: { ...DEFAULT_UI_STATE, ...state },
    });

  test("returns defaults on null / empty / garbage input", () => {
    for (const raw of [null, "", "{", "not json", "[]", '"plain"', JSON.stringify({})]) {
      const out = deserializeUiState(raw, cid);
      assert.deepEqual(out, DEFAULT_UI_STATE);
    }
  });

  test("rejects a version mismatch", () => {
    const wrong = JSON.stringify({ version: UI_STATE_VERSION + 99, cid, state: { panel: "files" } });
    assert.deepEqual(deserializeUiState(wrong, cid), DEFAULT_UI_STATE);
  });

  test("rejects a cid mismatch (different browser shared the storage)", () => {
    const wrong = JSON.stringify({ version: UI_STATE_VERSION, cid: "other-cid", state: { panel: "files" } });
    const out = deserializeUiState(wrong, cid);
    assert.equal(out.panel, null);
  });

  test("accepts a valid payload and round-trips the panel kind", () => {
    const raw = validPayload({ panel: "files", sidebarCollapsed: true });
    const out = deserializeUiState(raw, cid);
    assert.equal(out.panel, "files");
    assert.equal(out.sidebarCollapsed, true);
    assert.equal(out.panelTab, null);
    assert.equal(out.lastSessionId, null);
  });

  test("restores 'git' as a valid persisted panel kind (slice 03)", () => {
    // The right-panel GitPanel (webui-parity slice 03) is reachable
    // through the toolbar launcher — the launcher writes `panel: 'git'`
    // to the persisted UI state on toggle, and the next page mount
    // reads it back. If this kind falls through to DEFAULT_UI_STATE
    // (i.e. the renderer does not know about it), the user opens the
    // SPA, clicks the Git toolbar button, refreshes, and the panel
    // silently closes — the kind has to round-trip end to end.
    const raw = validPayload({ panel: "git", sidebarCollapsed: false });
    const out = deserializeUiState(raw, cid);
    assert.equal(out.panel, "git");
  });

  test("accepts every supported panel kind from a previous session", () => {
    // Belt-and-braces: enumerate the full PanelKind set so adding a
    // new kind in panels.tsx without mirroring it in persist.ts's
    // validKinds set trips this assertion.
    const kinds = [
      "workspace",
      "files",
      "git",
      "alerts",
      "search",
      "progress",
      "plugins",
    ] as const;
    for (const kind of kinds) {
      const raw = validPayload({ panel: kind });
      const out = deserializeUiState(raw, cid);
      assert.equal(out.panel, kind, `expected ${kind} to round-trip`);
    }
  });

  test("drops a panel kind that the renderer does not know", () => {
    const raw = validPayload({ panel: "made-up-panel" as unknown as UiState["panel"] });
    const out = deserializeUiState(raw, cid);
    assert.equal(out.panel, null);
  });

  test("preserves lastSessionId and panelTab fields", () => {
    const raw = validPayload({
      panel: "search",
      panelTab: "advanced",
      lastSessionId: "mvs_deadbeefdeadbeefdeadbeefdeadbeef",
    });
    const out = deserializeUiState(raw, cid);
    assert.equal(out.panel, "search");
    assert.equal(out.panelTab, "advanced");
    assert.equal(out.lastSessionId, "mvs_deadbeefdeadbeefdeadbeefdeadbeef");
  });
});

describe("scrollKey", () => {
  test("is per-(cid, sessionId) so two sessions do not share a position", () => {
    const a = scrollKey("cid-A", "session-1");
    const b = scrollKey("cid-A", "session-2");
    const c = scrollKey("cid-B", "session-1");
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });

  test("substitutes anon for missing cid or session so a wild key still resolves", () => {
    const anonCid = scrollKey("", "session-1");
    const anonSession = scrollKey("cid-A", "");
    assert.match(anonCid, new RegExp(`webui:scroll:v${SCROLL_VERSION}:anon:session-1$`));
    assert.match(anonSession, new RegExp(`webui:scroll:v${SCROLL_VERSION}:cid-A:anon$`));
  });
});

describe("deserializeScroll", () => {
  const cid = "test-cid";
  const sessionId = "session-x";
  const validPayload = (scrollTop: number) =>
    JSON.stringify({
      version: SCROLL_VERSION,
      cid,
      sessionId,
      scrollTop,
      savedAt: Date.now(),
    });

  test("returns 0 on null/garbage input", () => {
    for (const raw of [null, "", "{", "[]"]) {
      assert.equal(deserializeScroll(raw, cid, sessionId), 0);
    }
  });

  test("rejects version mismatch", () => {
    const wrong = JSON.stringify({ version: SCROLL_VERSION + 1, cid, sessionId, scrollTop: 120 });
    assert.equal(deserializeScroll(wrong, cid, sessionId), 0);
  });

  test("rejects cid mismatch", () => {
    const wrong = JSON.stringify({ version: SCROLL_VERSION, cid: "other", sessionId, scrollTop: 120 });
    assert.equal(deserializeScroll(wrong, cid, sessionId), 0);
  });

  test("rejects sessionId mismatch", () => {
    const wrong = JSON.stringify({ version: SCROLL_VERSION, cid, sessionId: "other", scrollTop: 120 });
    assert.equal(deserializeScroll(wrong, cid, sessionId), 0);
  });

  test("returns the saved scrollTop on a matching payload", () => {
    assert.equal(deserializeScroll(validPayload(123), cid, sessionId), 123);
  });

  test("clamps non-finite and negative values to 0", () => {
    for (const bad of [-1, NaN, Infinity, "abc", null]) {
      const payload = JSON.stringify({
        version: SCROLL_VERSION,
        cid,
        sessionId,
        scrollTop: bad,
        savedAt: 0,
      });
      assert.equal(deserializeScroll(payload, cid, sessionId), 0);
    }
  });
});
