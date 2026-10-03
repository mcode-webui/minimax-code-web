// webui/test/routes/model-source.test.js
// The `/api/model-source*` family (settings batch SB-1).
//
// Hermetic by construction: every handler takes an optional fourth
// argument that reaches the engine facade's `getHost` seam, so these
// tests drive a fake `host.cliService` — no runtime boot, no network, no
// temporary directory, no spawned server.
//
// The suite is organised around FOUR invariants, because everything else
// is bookkeeping next to them:
//
//   1. The KEEP-KEY sentinel. An absent or empty `apiKey` must keep the
//      stored key and must NOT call the engine's write. The GET can only
//      return a MASK (the engine masks through `secret.js`) and the
//      engine REJECTS a mask submitted as a key
//      (`assertValidRawApiKey` → `INVALID_API_KEY`), so a UI that
//      round-tripped its own masked state would turn every save into a
//      failure. A keep is the only way out, and it has to be free.
//   2. The badge is engine truth, never the request. Every write's
//      response is assembled from a READ BACK through the engine, so a
//      response can never report a source or a key status the engine
//      does not hold.
//   3. The three engine failures stay three failures. No host → 503, a
//      host without the method → 501, an engine refusal (`LocalModelProviderError`)
//      → ITS status and code. Collapsing any two of them is the
//      fake-success shape #110 fixed.
//   4. No secret on any path. The route has no code path that could
//      unmask a key, and the fake asserts the raw key it was handed is
//      never echoed in a response body.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const absFile = (rel) => join(import.meta.dirname, "..", "..", rel);
const modelSourceRoute = await import(absPath("routes/model-source.js"));
const { ownsRequest } = await import(absPath("app.js"));

const RAW_KEY = "sk-ant-secret-value-0123456789";
const MASKED_KEY = "sk-a*******6789";

/** A stand-in for the Node ServerResponse, mirroring turn-diff.test.js. */
function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  return {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    done,
  };
}

function bodyReq(payload) {
  const stream = Readable.from([
    Buffer.from(payload === undefined ? "" : JSON.stringify(payload), "utf8"),
  ]);
  stream.url = "/api/model-source";
  return stream;
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body || "{}");
}

/**
 * A fake catalogue host whose `cliService` carries the four methods this
 * family calls, plus the call log. `store` is the engine's own state, so
 * a write in one request is visible to the read-back of the next — which
 * is what makes invariant 2 testable rather than tautological.
 */
function fakeHost(overrides = {}) {
  const store = {
    source: "token_plan",
    apiKey: null,
    ...(overrides.store || {}),
  };
  const calls = [];
  const cliService = {
    async getMiniMaxModelSource() {
      calls.push(["getMiniMaxModelSource"]);
      return store.source;
    },
    async getMiniMaxApiKeyStatus() {
      calls.push(["getMiniMaxApiKeyStatus"]);
      return store.apiKey === null
        ? { hasApiKey: false }
        : { hasApiKey: true, maskedApiKey: MASKED_KEY, cachedStatus: { state: "available" } };
    },
    async setMiniMaxModelSource(input) {
      calls.push(["setMiniMaxModelSource", input]);
      if (input.source === "minimax_api_key" && store.apiKey === null) {
        // The engine's own refusal (LocalModelProviderError 400 NO_API_KEY).
        const err = new Error("MiniMax API key is not configured");
        err.name = "LocalModelProviderError";
        err.status = 400;
        err.code = "NO_API_KEY";
        throw err;
      }
      store.source = input.source;
      return store.source;
    },
    async upsertMiniMaxApiKey(input) {
      calls.push(["upsertMiniMaxApiKey", input]);
      store.apiKey = input.apiKey;
      if (input.saveAndUse) store.source = "minimax_api_key";
      return { id: "minimax_api" };
    },
    async testUserModel(input) {
      calls.push(["testUserModel", input]);
      return { success: true, status: { state: "available", lastTestedAt: 1_700_000_000_000 } };
    },
  };
  for (const [name, value] of Object.entries(overrides.methods || {})) {
    if (value === null) delete cliService[name];
    else cliService[name] = value;
  }
  return { host: { cliService }, calls, store, getHost: async () => ({ cliService }) };
}

// --- 1. the read -----------------------------------------------------------

describe("GET /api/model-source reports engine truth", () => {
  test("answers the source and the masked key status", async () => {
    const fake = fakeHost();
    const res = fakeRes();
    await modelSourceRoute.handleGetModelSource({}, res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.source, "token_plan");
    assert.deepEqual(body.apiKey, {
      available: true,
      hasKey: false,
      masked: null,
      testState: null,
      lastTestedAtMs: null,
    });
  });

  test("passes the engine's mask through and never invents one", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY, source: "minimax_api_key" } });
    const res = fakeRes();
    await modelSourceRoute.handleGetModelSource({}, res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(body.source, "minimax_api_key");
    assert.equal(body.apiKey.masked, MASKED_KEY);
    assert.equal(body.apiKey.hasKey, true);
    assert.equal(body.apiKey.testState, "available");
    assert.ok(!res.body.includes(RAW_KEY), "the raw key must never reach a response");
  });

  test("a host without the OPTIONAL key method still answers the source", async () => {
    // Degradation, not failure: the switcher can be truthful about the
    // source even when it cannot report the key half, and
    // `available: false` is what keeps that from reading as "no key".
    const fake = fakeHost({ methods: { getMiniMaxApiKeyStatus: null } });
    const res = fakeRes();
    await modelSourceRoute.handleGetModelSource({}, res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.source, "token_plan");
    assert.equal(body.apiKey.available, false);
    assert.equal(body.apiKey.hasKey, false);
  });

  test("a key-status read that THROWS degrades, and never claims 'no key'", async () => {
    // The difference matters to a user with a stored key: `hasKey:false`
    // would tell them they have none.
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    fake.host.cliService.getMiniMaxApiKeyStatus = async () => {
      throw new Error("status cache unreadable");
    };
    const res = fakeRes();
    await modelSourceRoute.handleGetModelSource({}, res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.apiKey.available, false);
    assert.equal(body.apiKey.hasKey, false);
  });

  test("a source the engine's own type does not allow is refused, not rendered", async () => {
    const fake = fakeHost({ methods: { getMiniMaxModelSource: async () => "somewhere_else" } });
    const res = fakeRes();
    await modelSourceRoute.handleGetModelSource({}, res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(res.status, 502);
    assert.equal(body.code, "UNKNOWN_MODEL_SOURCE");
  });
});

// --- 2. the switch ---------------------------------------------------------

describe("PUT /api/model-source switches and reports the persisted value", () => {
  test("writes the source and answers what the engine persisted", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    const res = fakeRes();
    await modelSourceRoute.handleSetModelSource(
      bodyReq({ source: "minimax_api_key" }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.source, "minimax_api_key");
    assert.equal(fake.store.source, "minimax_api_key", "the engine's own state must have moved");
  });

  test("survives a reopen: the switch is read back, not cached", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    await modelSourceRoute.handleSetModelSource(
      bodyReq({ source: "minimax_api_key" }),
      fakeRes(),
      {},
      { getHost: fake.getHost },
    );
    // A FRESH request against the same engine state — this is the
    // persistence proof: the badge after a reopen comes from the engine,
    // not from the state the first response left in the browser.
    const res = fakeRes();
    await modelSourceRoute.handleGetModelSource({}, res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(body.source, "minimax_api_key");
  });

  test("the response reports what the engine PERSISTED, not what was requested", async () => {
    // The engine echoes the value today, so a route that simply echoed
    // the REQUEST would pass every other test here. This is the pin that
    // makes the difference observable: a fake that answers with a
    // different value (a future engine that normalises, or one whose
    // write was coerced) must move the badge to what the engine said, or
    // the UI would claim a source the config does not carry.
    const fake = fakeHost({
      methods: {
        setMiniMaxModelSource: async () => "token_plan",
      },
    });
    const res = fakeRes();
    await modelSourceRoute.handleSetModelSource(
      bodyReq({ source: "minimax_api_key" }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(body.source, "token_plan", "the engine's persisted value wins over the request");
  });

  test("an unknown source is a 400 and the engine is never asked", async () => {
    const fake = fakeHost();
    const res = fakeRes();
    await modelSourceRoute.handleSetModelSource(
      bodyReq({ source: "openai" }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "INVALID_MODEL_SOURCE");
    assert.equal(fake.calls.length, 0, "a typo must not cost a runtime round trip");
  });

  test("a missing source is the same 400", async () => {
    const fake = fakeHost();
    const res = fakeRes();
    await modelSourceRoute.handleSetModelSource(bodyReq({}), res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "INVALID_MODEL_SOURCE");
  });

  test("the engine's refusal is forwarded with its own status and code", async () => {
    // NO_API_KEY is the UI's cue to send the user to the key field, not a
    // generic failure — so the code has to survive the trip.
    const fake = fakeHost();
    const res = fakeRes();
    await modelSourceRoute.handleSetModelSource(
      bodyReq({ source: "minimax_api_key" }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "NO_API_KEY");
    assert.equal(fake.store.source, "token_plan", "a refused switch must not move the source");
  });

  test("a non-string source is a 400 before the engine is reached", async () => {
    const fake = fakeHost();
    const res = fakeRes();
    await modelSourceRoute.handleSetModelSource(
      bodyReq({ source: 1 }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "BAD_FIELD_TYPE");
    assert.equal(fake.calls.length, 0);
  });
});

// --- 3. the key write + the keep sentinel -----------------------------------

describe("PUT /api/model-source/api-key upserts, and an empty key keeps", () => {
  test("a raw key is written and read back as a mask", async () => {
    const fake = fakeHost();
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: RAW_KEY, saveAndUse: true }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.changed, true);
    assert.equal(body.source, "minimax_api_key", "saveAndUse must switch in the same call");
    assert.equal(body.apiKey.masked, MASKED_KEY);
    assert.ok(!res.body.includes(RAW_KEY), "the raw key must never reach a response");
  });

  test("saveAndUse omitted stores the key WITHOUT switching the source", async () => {
    const fake = fakeHost();
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: RAW_KEY }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(body.changed, true);
    assert.equal(body.saveAndUse, false);
    assert.equal(body.source, "token_plan");
    assert.equal(fake.store.apiKey, RAW_KEY);
  });

  test("an empty apiKey KEEPS the stored key and calls no write", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: "" }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.changed, false);
    assert.equal(body.apiKey.masked, MASKED_KEY, "a keep must still report what is stored");
    assert.equal(
      fake.calls.filter(([name]) => name === "upsertMiniMaxApiKey").length,
      0,
      "a keep must not ask the engine to re-assert a value it already holds",
    );
  });

  test("an absent apiKey is the same keep", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(bodyReq({}), res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(body.changed, false);
    assert.equal(fake.store.apiKey, RAW_KEY);
  });

  test("a whitespace-only key is a keep, not a write of blanks", async () => {
    // The engine trims, so "   " would reach it as empty and be refused
    // as INVALID_API_KEY; treating it as the keep sentinel here is what
    // the sentinel is FOR.
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: "   " }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(body.changed, false);
    assert.equal(fake.calls.filter(([name]) => name === "upsertMiniMaxApiKey").length, 0);
  });

  test("a non-string apiKey is a 400, never a silent keep", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: 42 }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "BAD_FIELD_TYPE");
    assert.equal(fake.calls.length, 0);
  });

  test("a non-boolean saveAndUse is a 400", async () => {
    const fake = fakeHost();
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: RAW_KEY, saveAndUse: "yes" }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "BAD_FIELD_TYPE");
    assert.equal(fake.calls.filter(([name]) => name === "upsertMiniMaxApiKey").length, 0);
  });

  test("the engine's own key refusal keeps its status and code", async () => {
    const fake = fakeHost({
      methods: {
        upsertMiniMaxApiKey: async () => {
          const err = new Error("API key looks masked; provide the raw key");
          err.name = "LocalModelProviderError";
          err.status = 400;
          err.code = "INVALID_API_KEY";
          throw err;
        },
      },
    });
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: MASKED_KEY }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "INVALID_API_KEY");
  });

  test("an unknown thrower becomes a 500 that carries no engine text", async () => {
    // The one place a credential could still be echoed is an exception
    // message from something we do not recognise, so that path is
    // replaced wholesale rather than forwarded.
    const fake = fakeHost({
      methods: {
        upsertMiniMaxApiKey: async () => {
          throw new Error(`upstream rejected ${RAW_KEY}`);
        },
      },
    });
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: RAW_KEY }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 500);
    assert.equal(body.code, "engine_error");
    assert.ok(!res.body.includes(RAW_KEY), "an unknown thrower must not print its message");
  });
});

// --- 4. the probe ----------------------------------------------------------

describe("POST /api/model-source/test probes the stored key", () => {
  test("always probes the BYOK provider, and says which credential it used", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    const res = fakeRes();
    await modelSourceRoute.handleTestModelSource(bodyReq({}), res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.tested, "stored_key");
    assert.equal(body.providerId, "minimax_api");
    const call = fake.calls.find(([name]) => name === "testUserModel");
    assert.deepEqual(call[1], { providerId: "minimax_api" });
  });

  test("a named model is forwarded", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    const res = fakeRes();
    await modelSourceRoute.handleTestModelSource(
      bodyReq({ modelId: "MiniMax-M3" }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(body.modelId, "MiniMax-M3");
    const call = fake.calls.find(([name]) => name === "testUserModel");
    assert.equal(call[1].modelId, "MiniMax-M3");
  });

  test("a failed probe is a COMPLETED probe: 200 with success false", async () => {
    const fake = fakeHost({
      methods: {
        testUserModel: async () => ({
          success: false,
          status: { state: "failed", lastErrorCode: "unauthorized", lastErrorMessage: "401" },
        }),
      },
    });
    const res = fakeRes();
    await modelSourceRoute.handleTestModelSource(bodyReq({}), res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(res.status, 200);
    assert.equal(body.success, false);
    assert.equal(body.status.state, "failed");
    assert.equal(body.status.lastErrorCode, "unauthorized");
  });

  test("no stored key is the engine's 400 NO_API_KEY, forwarded", async () => {
    const fake = fakeHost({
      methods: {
        testUserModel: async () => {
          const err = new Error("MiniMax API key is not configured");
          err.name = "LocalModelProviderError";
          err.status = 400;
          err.code = "NO_API_KEY";
          throw err;
        },
      },
    });
    const res = fakeRes();
    await modelSourceRoute.handleTestModelSource(bodyReq({}), res, {}, { getHost: fake.getHost });
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "NO_API_KEY");
  });

  test("a non-string modelId is a 400 before the engine is reached", async () => {
    const fake = fakeHost({ store: { apiKey: RAW_KEY } });
    const res = fakeRes();
    await modelSourceRoute.handleTestModelSource(
      bodyReq({ modelId: 7 }),
      res,
      {},
      { getHost: fake.getHost },
    );
    const body = await readBody(res);
    assert.equal(res.status, 400);
    assert.equal(body.code, "BAD_FIELD_TYPE");
    assert.equal(fake.calls.length, 0);
  });
});

// --- 5. the three engine failures stay three -------------------------------

describe("engine availability is reported, never faked", () => {
  const cases = [
    ["no host at all", async () => null, 503, "engine_host_unavailable"],
    [
      "a host without the method",
      async () => ({ cliService: {} }),
      501,
      "engine_member_unavailable",
    ],
    [
      "a host getter that throws",
      async () => {
        throw new Error("runtime boot failed");
      },
      503,
      "engine_host_unavailable",
    ],
  ];

  for (const [name, getHost, status, code] of cases) {
    test(`GET with ${name} answers ${status} ${code}`, async () => {
      const res = fakeRes();
      await modelSourceRoute.handleGetModelSource({}, res, {}, { getHost });
      const body = await readBody(res);
      assert.equal(res.status, status);
      assert.equal(body.code, code);
    });

    test(`PUT with ${name} answers ${status} ${code}`, async () => {
      const res = fakeRes();
      await modelSourceRoute.handleSetModelSource(
        bodyReq({ source: "token_plan" }),
        res,
        {},
        { getHost },
      );
      const body = await readBody(res);
      assert.equal(res.status, status);
      assert.equal(body.code, code);
    });
  }

  test("a failed key write does not fake a saved key", async () => {
    const res = fakeRes();
    await modelSourceRoute.handlePutModelSourceApiKey(
      bodyReq({ apiKey: RAW_KEY }),
      res,
      {},
      { getHost: async () => null },
    );
    const body = await readBody(res);
    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.ok(!("apiKey" in body), "a failed write must not carry a key block");
  });
});

// --- 6. the wiring ---------------------------------------------------------

describe("the family is registered end to end", () => {
  test("all four endpoints are in OWNED_ROUTES", () => {
    for (const [method, path] of [
      ["GET", "/api/model-source"],
      ["PUT", "/api/model-source"],
      ["PUT", "/api/model-source/api-key"],
      ["POST", "/api/model-source/test"],
    ]) {
      assert.equal(ownsRequest(method, path), true, `${method} ${path} must be owned by Hono`);
    }
  });

  test("the route table and OWNED_ROUTES cover the same four endpoints", () => {
    assert.deepEqual(
      [...modelSourceRoute._modelSourceRoutes()].sort(),
      [
        "GET /api/model-source",
        "POST /api/model-source/test",
        "PUT /api/model-source",
        "PUT /api/model-source/api-key",
      ],
    );
    for (const endpoint of modelSourceRoute._modelSourceRoutes()) {
      const declaration = modelSourceRoute._modelSourceDeclaration(endpoint);
      assert.equal(declaration.member, "cliService", `${endpoint} must resolve on cliService`);
      assert.match(declaration.method, /^(get|set|upsert|test)MiniMax|^testUserModel/);
    }
  });

  test("app.js mounts the four handlers, in the OWNED_ROUTES order", () => {
    const app = readFileSync(absFile("server/app.js"), "utf8");
    for (const handler of [
      "handleGetModelSource",
      "handleSetModelSource",
      "handlePutModelSourceApiKey",
      "handleTestModelSource",
    ]) {
      assert.ok(app.includes(handler), `app.js must mount ${handler}`);
    }
    // A route mounted in a different order than the ledger reads is a
    // ledger that no longer describes the app; the pin is cheap and the
    // drift is invisible otherwise.
    const order = [
      '"GET /api/model-source"',
      '"PUT /api/model-source"',
      '"PUT /api/model-source/api-key"',
      '"POST /api/model-source/test"',
    ].map((needle) => app.indexOf(needle));
    for (const index of order) assert.notEqual(index, -1);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "OWNED_ROUTES order must be stable");
  });

  test("the settings tab reads the badge from the ENGINE value, not the view", () => {
    // A source-level tripwire, and the reason is structural: the tab
    // component imports `panels.tsx`, which pulls the session store and
    // the api graph, so there is no render harness for it (the same
    // constraint `usage-models-cards.test.ts` documents for the cards).
    // What must not regress is the fake-success shape: a badge fed by
    // the local `sourceTab` would claim 使用中 for a source the engine
    // never accepted.
    const port = readFileSync(absFile("webapp/components/settings-modal-port.tsx"), "utf8");
    assert.ok(
      port.includes("setActiveSource(written.source)"),
      "the switch must take the badge from what the engine persisted",
    );
    assert.ok(
      port.includes("=== activeSource ?"),
      "the in-use badge must be gated on the engine value read back from the server",
    );
    assert.ok(
      !/settings-usage-source-in-use[\s\S]{0,400}sourceTab ===/.test(port),
      "the in-use badge must not be derived from the local view tab",
    );
  });

  test("the two key controls are gated on real state, not permanently disabled", () => {
    const port = readFileSync(absFile("webapp/components/settings-modal-port.tsx"), "utf8");
    // The probe reads the STORED key (no engine override exists), so an
    // unsaved value must disable it rather than probe the wrong thing.
    assert.ok(
      port.includes("disabled={!hasStoredKey || hasUnsavedKey || busy !== null}"),
      "the connectivity probe must be disabled while the field holds an unsaved value",
    );
    assert.ok(
      port.includes("disabled={!hasUnsavedKey || busy !== null}"),
      "save-and-use must be disabled on an empty field (an empty submit is the keep sentinel)",
    );
    assert.ok(
      !/usageModels\.minimax\.unavailable"\s*\n\s*disabled/.test(port),
      "neither control may be hard-disabled with the degraded-state title any more",
    );
  });

  test("the frontend client calls the four paths this route serves", () => {
    const api = readFileSync(absFile("webapp/lib/api.ts"), "utf8");
    for (const call of [
      'getModelSource = () => request<ModelSourceSnapshot>("/api/model-source")',
      'setModelSource = (source: ModelSource) =>\n  request<{ ok: true; source: ModelSource }>("/api/model-source"',
      'putModelSourceApiKey = (payload: { apiKey: string; saveAndUse?: boolean }) =>\n  request<ModelSourcePutResult>("/api/model-source/api-key"',
      'testModelSourceModel = (payload: { modelId?: string } = {}) =>\n  request<ModelSourceTestResult>("/api/model-source/test"',
    ]) {
      assert.ok(api.includes(call), `api.ts must declare: ${call.split("\n")[0]}`);
    }
  });
});
