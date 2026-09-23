// webapp/test/cid.test.ts
// Unit tests for lib/cid.ts — the client identity and query string.
//
// Why this test exists: the server keys its per-client session and its `mcode acp`
// subprocess on a `cid` query parameter (getCidFromReq in server/lib/state-bus.js
// reads `?cid=`). If the frontend omits it, every browser shares the empty cid:
// sessions leak between tabs and the engine is multiplexed onto one client. The
// previous frontend persisted the id in `localStorage['webui_cid']`, and this module
// has to keep that contract — a reload must reuse the id, or the conversation is
// orphaned on every refresh.
//
// Test strategy: the module reads `window` lazily, so the tests install a minimal
// stand-in for `window` (location + localStorage + crypto) and assert the produced
// query. No DOM is required.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

type Storage = {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function installWindow(options: { search?: string; seed?: Record<string, string> } = {}): Storage {
  const store = new Map(Object.entries(options.seed ?? {}));
  const storage: Storage = {
    store,
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => void store.set(key, value),
  };
  (globalThis as Record<string, unknown>)["window"] = {
    location: { search: options.search ?? "" },
    localStorage: storage,
  };
  return storage;
}

/** A fresh module each time: cid.ts caches the id in module scope. */
async function freshModule() {
  return import(`../lib/cid?test=${Math.random()}`);
}

const originalWindow = (globalThis as Record<string, unknown>)["window"];

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)["window"];
});

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as Record<string, unknown>)["window"];
  else (globalThis as Record<string, unknown>)["window"] = originalWindow;
});

describe("clientId", () => {
  test("generates an id and persists it under the previous frontend's key", async () => {
    const storage = installWindow();
    const { clientId } = await freshModule();
    const id = clientId();
    assert.ok(id.length > 0);
    assert.equal(storage.getItem("webui_cid"), id);
  });

  test("reuses a stored id instead of generating a new one", async () => {
    installWindow({ seed: { webui_cid: "stored-id" } });
    const { clientId } = await freshModule();
    assert.equal(clientId(), "stored-id");
  });

  test("an unreadable store yields an id rather than throwing", async () => {
    (globalThis as Record<string, unknown>)["window"] = {
      location: { search: "" },
      localStorage: {
        getItem() {
          throw new Error("denied");
        },
        setItem() {
          throw new Error("denied");
        },
      },
    };
    const { clientId } = await freshModule();
    assert.ok(clientId().length > 0, "private modes must still produce an id");
  });

  test("with no window there is no id to send", async () => {
    const { clientId } = await freshModule();
    assert.equal(clientId(), "");
  });
});

describe("requestQuery", () => {
  test("carries the cid", async () => {
    installWindow({ seed: { webui_cid: "c1" } });
    const { requestQuery } = await freshModule();
    assert.equal(requestQuery(), "cid=c1");
  });

  test("carries the auth token when the page was opened with one", async () => {
    installWindow({ search: "?token=abc123", seed: { webui_cid: "c1" } });
    const { requestQuery } = await freshModule();
    const query = new URLSearchParams(requestQuery());
    assert.equal(query.get("cid"), "c1");
    assert.equal(query.get("token"), "abc123");
  });

  test("omits the token when the page has none", async () => {
    installWindow({ seed: { webui_cid: "c1" } });
    const { requestQuery } = await freshModule();
    assert.equal(new URLSearchParams(requestQuery()).has("token"), false);
  });

  test("extra parameters are carried through", async () => {
    installWindow({ seed: { webui_cid: "c1" } });
    const { requestQuery } = await freshModule();
    assert.equal(new URLSearchParams(requestQuery({ path: "/tmp" })).get("path"), "/tmp");
  });

  test("with no window there is no query string", async () => {
    const { requestQuery } = await freshModule();
    assert.equal(requestQuery(), "");
  });
});

describe("withClientQuery", () => {
  test("appends with `?` when the path has no query", async () => {
    installWindow({ seed: { webui_cid: "c1" } });
    const { withClientQuery } = await freshModule();
    assert.equal(withClientQuery("/api/state"), "/api/state?cid=c1");
  });

  test("appends with `&` when the path already has a query", async () => {
    installWindow({ seed: { webui_cid: "c1" } });
    const { withClientQuery } = await freshModule();
    assert.equal(withClientQuery("/api/workspace/browse?path=%2Ftmp"), "/api/workspace/browse?path=%2Ftmp&cid=c1");
  });

  test("leaves the path untouched with no window", async () => {
    const { withClientQuery } = await freshModule();
    assert.equal(withClientQuery("/api/state"), "/api/state");
  });
});
