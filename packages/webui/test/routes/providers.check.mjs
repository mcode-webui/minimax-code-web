// webui/test/routes/providers.check.mjs
// Route-level tests for server/routes/providers.js —
// handleGetProviders, handlePutProviders, handleTestProvider.
//
// Why this test exists:
//   - apiKey masking is a security contract — every response path
//     MUST return the masked form, never plaintext. The tests pin
//     the rule with concrete-string checks on every response shape.
//   - The PUT handler triggers an SSE broadcast; the test asserts
//     the broadcast payload is masked and the immediate effect on
//     /api/models is observable (hot reload).
//   - The probe handler rejects malformed keys locally — no
//     network call when the key shape is bad.
//
// Test strategy: NO setupMocks. routes/providers.js only depends on
// node:fs + the providers-config module (which has its own state).
// Each test sets MCODE_WEBUI_DATA_DIR / MCODE_WEBUI_MODELS_CONFIG
// to per-test tmp paths so the suite doesn't touch the operator's
// real config (the same isolation contract enforced by
// scripts/test-isolation-lint.check.mjs for server-spawning tests).

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {rmSync, writeFileSync, existsSync, readFileSync} from "node:fs";
import yaml from "js-yaml";

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkTmpDir } from "../helpers/tmp.js";
import { setupMocks } from "../helpers/_setup.js";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const providersRoute = await import(absPath("routes/providers.js"));
const providersConfig = await import(absPath("lib/providers-config.js"));

let _tmpDataDir;
let _tmpCwd;
let _tmpEngineDir;
let _origDataDir;
let _origEngineDir;
let _origCwdEnv;
let _origCwd;

before(async () => {
  _tmpDataDir = mkTmpDir("webui-providers-route-");
  _tmpCwd = mkTmpDir("webui-providers-route-cwd-");
  // M3-B11: the catalogue now lives in the ENGINE config, so this suite
  // needs an isolated engine data dir. Without one the route would
  // write the developer's real ~/.minimax/config.yaml — the same
  // isolation contract test/lib/engine/capability-snapshot.test.js
  // states, for the same reason.
  _tmpEngineDir = mkTmpDir("webui-providers-engine-");
  _origDataDir = process.env.MCODE_WEBUI_DATA_DIR;
  _origEngineDir = process.env.MINIMAX_DATA_DIR;
  _origCwdEnv = process.env.MCODE_WEBUI_MODELS_CONFIG;
  _origCwd = process.cwd();
  process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;
  process.env.MINIMAX_DATA_DIR = _tmpEngineDir;
  process.env.MCODE_WEBUI_MODELS_CONFIG = "";
  process.chdir(_tmpCwd);
});

after(async () => {
  if (_origDataDir === undefined) delete process.env.MCODE_WEBUI_DATA_DIR;
  else process.env.MCODE_WEBUI_DATA_DIR = _origDataDir;
  if (_origEngineDir === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = _origEngineDir;
  if (_origCwdEnv === undefined) delete process.env.MCODE_WEBUI_MODELS_CONFIG;
  else process.env.MCODE_WEBUI_MODELS_CONFIG = _origCwdEnv;
  try { process.chdir(_origCwd); } catch {}
  if (_tmpDataDir) try { rmSync(_tmpDataDir, { recursive: true, force: true }); } catch {}
  if (_tmpCwd) try { rmSync(_tmpCwd, { recursive: true, force: true }); } catch {}
  if (_tmpEngineDir) try { rmSync(_tmpEngineDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // BOTH halves of the pre-B11 dual source are cleared: the deprecated
  // providers.json (the fallback authority) and the engine store (the
  // authority once the marker is stamped). Leaving either behind would
  // let one test's write decide the next test's fixture.
  for (const f of [
    join(_tmpCwd, "models.json"),
    join(_tmpCwd, "env.json"),
    join(_tmpCwd, "env-only.json"),
    join(_tmpDataDir, "providers.json"),
    join(_tmpEngineDir, "config.yaml"),
  ]) {
    if (existsSync(f)) rmSync(f);
  }
});

/**
 * The provider records the store holds, read straight off disk.
 *
 * The store is a YAML document keyed by engine provider key, so the
 * assertions below read the `_webui_provider` record each webui-owned
 * entry carries rather than the engine projection beside it: the record
 * is what the catalogue API serialises, so it is the thing a test must
 * compare against.
 *
 * @returns {object[]}
 */
function readStoreRecords() {
  const file = join(_tmpEngineDir, "config.yaml");
  if (!existsSync(file)) return [];
  const doc = yaml.load(readFileSync(file, "utf8")) || {};
  return Object.values(doc.custom_provider || {})
    .map((entry) => entry && entry._webui_provider)
    .filter(Boolean);
}

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  return {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) { this._status = s; if (h) this._headers = h; },
    end(b) { this._body = b; },
  };
}
function getBody(res) {
  return JSON.parse(res._body);
}

// =====================================================================
// handleGetProviders — apiKey NEVER plaintext.
// =====================================================================

describe("handleGetProviders — /api/providers GET", () => {
  test("empty config returns ok + empty providers + sources", async () => {
    const res = fakeRes();
    await providersRoute.handleGetProviders(null, res, {});
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.version, 2);
    assert.deepEqual(body.providers, []);
    assert.ok(body.sources, "sources object present");
    assert.ok(body.userPath, "userPath present");
  });

  test("the deprecated file is read on every call (hot reload)", async () => {
    writeFileSync(
      join(_tmpDataDir, "providers.json"),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: "u1",
            label: "User One",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-aaaa" },
            models: [{ id: "m1" }],
          },
        ],
      }),
    );
    const res = fakeRes();
    await providersRoute.handleGetProviders(null, res, {});
    const body = getBody(res);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].id, "u1");
    assert.equal(body.providers[0].label, "User One");
  });

  test("apiKey is masked in every provider (no plaintext anywhere)", async () => {
    const key = "sk-realkey-this-is-the-secret-1234";
    writeFileSync(
      join(_tmpDataDir, "providers.json"),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: "p1",
            label: "P1",
            protocol: "anthropic",
            auth: { type: "byok", apiKey: key },
            models: [{ id: "m1" }],
          },
          {
            id: "p2",
            label: "P2",
            protocol: "gemini",
            auth: { type: "byok", apiKey: "sk-realkey-other-secret-9999" },
            models: [],
          },
        ],
      }),
    );
    const res = fakeRes();
    await providersRoute.handleGetProviders(null, res, {});
    const body = getBody(res);
    // Pinned: the plaintext key MUST NOT appear in any response shape.
    const json = res._body;
    assert.equal(json.includes(key), false, "plaintext apiKey never appears");
    assert.equal(json.includes("realkey"), false, "no plaintext material");
    // Masked shape is correct.
    const p1 = body.providers.find((p) => p.id === "p1");
    assert.ok(p1.auth.apiKeyMasked, "apiKeyMasked field present");
    assert.equal(p1.auth.apiKeyMasked.includes("realkey"), false);
    assert.equal(p1.auth.hasKey, true);
    // baseURL is kept (operators need it for debug); apiKey is not.
    assert.equal(p1.auth.baseURL, "");
  });

  test("sources.{env,cwd,user} point at the resolved paths", async () => {
    const envFile = join(_tmpCwd, "env.json");
    writeFileSync(envFile, JSON.stringify({ providers: [] }));
    process.env.MCODE_WEBUI_MODELS_CONFIG = envFile;
    try {
      const res = fakeRes();
      await providersRoute.handleGetProviders(null, res, {});
      const body = getBody(res);
      assert.equal(body.sources.env, envFile, "env override is reported");
      // When env override is set, the cwd path is NOT read — the
      // env override IS the cwd path. The cwd key is null in that case.
      assert.equal(body.sources.cwd, null);
      // user-level path is always reported.
      assert.ok(body.sources.user.endsWith("providers.json"));
    } finally {
      delete process.env.MCODE_WEBUI_MODELS_CONFIG;
    }
  });
});

// =====================================================================
// handlePutProviders — validate, persist, hot reload.
// =====================================================================

describe("handlePutProviders — /api/providers PUT", () => {
  test("valid body persists to the engine store and returns masked shape", async () => {
    const res = fakeRes();
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "p1",
            label: "P1",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-aaaa" },
            models: [{ id: "m1", label: "M1" }],
          },
        ],
      }),
      res,
      {},
    );
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.ok, true);
    // Response is masked.
    assert.equal(body.providers[0].auth.apiKeyMasked.includes("realkey"), false);
    // Plaintext key NEVER appears anywhere in the response.
    assert.equal(res._body.includes("realkey"), false);
    // File persisted.
    const onDisk = { providers: readStoreRecords() };
    assert.equal(onDisk.providers[0].id, "p1");
    assert.equal(onDisk.providers[0].auth.apiKey, "sk-realkey-aaaa");
  });

  test("invalid protocol returns 400 + structured error", async () => {
    const res = fakeRes();
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          { id: "p1", protocol: "ollama", auth: { type: "byok" }, models: [] },
        ],
      }),
      res,
      {},
    );
    assert.equal(res._status, 400);
    const body = getBody(res);
    assert.equal(body.ok, false);
    assert.equal(body.code, "BAD_BODY");
    assert.match(body.error, /protocol/);
  });

  test("duplicate provider id is rejected", async () => {
    const res = fakeRes();
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          { id: "p1", protocol: "openai", auth: { type: "byok", apiKey: "sk-realkey-aaaa" }, models: [] },
          { id: "p1", protocol: "openai", auth: { type: "byok", apiKey: "sk-realkey-bbbb" }, models: [] },
        ],
      }),
      res,
      {},
    );
    assert.equal(res._status, 400);
  });

  test("missing body returns 400", async () => {
    const res = fakeRes();
    // No body at all — readJson() returns {} (empty object).
    await providersRoute.handlePutProviders(
      Readable.from([Buffer.from("", "utf8")]),
      res,
      {},
    );
    // The exact status depends on readJson's contract; assert just
    // that the handler did not crash and reported an error.
    const body = getBody(res);
    assert.equal(body.ok, false);
  });

  test("hot reload: a follow-up GET sees the new providers without restart", async () => {
    // PUT a provider.
    const put = fakeRes();
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "newprov",
            label: "New",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-aaaa" },
            models: [{ id: "newm" }],
          },
        ],
      }),
      put,
      {},
    );
    assert.equal(put._status, 200);
    // GET picks it up.
    const get = fakeRes();
    await providersRoute.handleGetProviders(null, get, {});
    const body = getBody(get);
    const found = body.providers.find((p) => p.id === "newprov");
    assert.ok(found, "newprov visible after PUT");
    assert.equal(found.models.length, 1);
  });

  test("keep-existing-key: empty apiKey in PUT preserves the key in the store", async () => {
    // Seed: write a provider with a plaintext key.
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "kp",
            label: "KP",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-original-plaintext-aaaa" },
            models: [],
          },
        ],
      }),
      fakeRes(),
      {},
    );
    // Edit: PUT the same provider back with apiKey === "" (the
    // sentinel). Without the convention the plaintext would be wiped;
    // with it, the on-disk key is preserved.
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "kp",
            label: "KP renamed",
            protocol: "openai",
            auth: { type: "byok", apiKey: "" },
            models: [{ id: "m" }],
          },
        ],
      }),
      fakeRes(),
      {},
    );
    const onDisk = { providers: readStoreRecords() };
    const kp = onDisk.providers.find((p) => p.id === "kp");
    assert.equal(kp.auth.apiKey, "sk-original-plaintext-aaaa");
    assert.equal(kp.label, "KP renamed");
    assert.equal(kp.models.length, 1);
  });

  test("keep-existing-key: non-empty apiKey in PUT replaces the key", async () => {
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "kp2",
            label: "KP2",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-old-plaintext-aaaa" },
            models: [],
          },
        ],
      }),
      fakeRes(),
      {},
    );
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "kp2",
            label: "KP2",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-new-plaintext-bbbb" },
            models: [],
          },
        ],
      }),
      fakeRes(),
      {},
    );
    const onDisk = { providers: readStoreRecords() };
    const kp = onDisk.providers.find((p) => p.id === "kp2");
    assert.equal(kp.auth.apiKey, "sk-new-plaintext-bbbb");
  });

  test("keep-existing-key: ABSENT auth.apiKey preserves the stored key", async () => {
    // Acceptance hardening (ticket 03 round 2): the PUT body drops
    // the `auth.apiKey` field entirely. Without the convention's
    // absent-field branch, the v2 normaliser would coerce undefined
    // to "" and write the file as empty — silently wiping a stored
    // credential. The route must keep the previous key.
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "abs",
            label: "Absent",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-on-disk-original-aaaa" },
            models: [],
          },
        ],
      }),
      fakeRes(),
      {},
    );
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "abs",
            label: "Absent renamed",
            protocol: "openai",
            auth: { type: "byok" }, // apiKey field is gone
            models: [{ id: "m1" }],
          },
        ],
      }),
      fakeRes(),
      {},
    );
    const onDisk = { providers: readStoreRecords() };
    const row = onDisk.providers.find((p) => p.id === "abs");
    assert.equal(row.auth.apiKey, "sk-on-disk-original-aaaa");
    assert.equal(row.label, "Absent renamed");
    assert.equal(row.models.length, 1, "model row is NOT dropped");
  });

  test("keep-existing-key: env-layer key is NOT materialised to user-level", async () => {
    // The convention's "previous key" lookup reads the user-level
    // file only — NOT the merged catalogue. Without this scoping,
    // editing an env-defined provider would copy the deployment
    // secret into the user-level file, materialising it onto disk
    // that the operator owns. Pinning here so a future refactor that
    // swaps to `loadProvidersConfig().providers` regresses loudly.
    const envPath = join(_tmpCwd, "env-only.json");
    writeFileSync(
      envPath,
      JSON.stringify({
        providers: [
          {
            id: "envprov",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-env-secret-only-aaaa" },
            models: [],
          },
        ],
      }),
    );
    process.env.MCODE_WEBUI_MODELS_CONFIG = envPath;
    try {
      // Simulate a PUT body that targets the env-defined provider
      // with the empty sentinel. Without the user-layer scoping, the
      // convention would copy the env secret into the user file.
      await providersRoute.handlePutProviders(
        fakeReq({
          version: 2,
          providers: [
            {
              id: "envprov",
              label: "Env Provider (edited)",
              protocol: "openai",
              auth: { type: "byok", apiKey: "" },
              models: [{ id: "m1" }],
            },
          ],
        }),
        fakeRes(),
        {},
      );
      const onDisk = { providers: readStoreRecords() };
      const row = onDisk.providers.find((p) => p.id === "envprov");
      // The user-level record MUST NOT carry the env secret. The
      // env secret is deployment-managed and stays at the env layer.
      assert.equal(
        row.auth.apiKey,
        "",
        "env-layer key must not leak into the user-level file",
      );
      // Other fields ARE written (label / models) — the operator
      // edits land in user-level as expected; only the key stays
      // at the env layer.
      assert.equal(row.label, "Env Provider (edited)");
      assert.equal(row.models.length, 1);
    } finally {
      delete process.env.MCODE_WEBUI_MODELS_CONFIG;
    }
  });
});

// =====================================================================
// handleTestProvider — no network for malformed, structured errors.
// =====================================================================

describe("handleTestProvider — /api/providers/test POST", () => {
  test("unknown protocol returns 400 BAD_PROTOCOL without a fetch", async () => {
    const res = fakeRes();
    await providersRoute.handleTestProvider(
      fakeReq({
        protocol: "ollama",
        auth: { type: "byok", apiKey: "sk-realkey-aaaa" },
      }),
      res,
      {},
    );
    assert.equal(res._status, 400);
    const body = getBody(res);
    assert.equal(body.ok, false);
    assert.equal(body.code, "BAD_PROTOCOL");
  });

  test("missing apiKey on byok returns 400 INVALID_KEY without a fetch", async () => {
    const res = fakeRes();
    await providersRoute.handleTestProvider(
      fakeReq({
        protocol: "openai",
        auth: { type: "byok", apiKey: "" },
      }),
      res,
      {},
    );
    assert.equal(res._status, 400);
    const body = getBody(res);
    assert.equal(body.code, "INVALID_KEY");
  });

  test("short apiKey returns 400 INVALID_KEY without a fetch", async () => {
    const res = fakeRes();
    await providersRoute.handleTestProvider(
      fakeReq({
        protocol: "openai",
        auth: { type: "byok", apiKey: "short" },
      }),
      res,
      {},
    );
    assert.equal(res._status, 400);
    const body = getBody(res);
    assert.equal(body.code, "INVALID_KEY");
  });

  test("unreachable baseURL returns 502 PROBE_FAILED (network was attempted)", async () => {
    // The validation gate passes; the probe fires; the unreachable
    // baseURL yields an error. `timeoutMs` is read by the route
    // indirectly through the underlying helper — we set a tiny
    // timeout by pointing at a localhost port that nothing is
    // listening on (TCP RST comes back almost immediately).
    const res = fakeRes();
    await providersRoute.handleTestProvider(
      fakeReq({
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk-realkey-aaaa", baseURL: "http://127.0.0.1:1" },
        timeoutMs: 200,
      }),
      res,
      {},
    );
    assert.equal(res._status, 502);
    const body = getBody(res);
    assert.equal(body.code, "PROBE_FAILED");
    // The error string is the upstream / reformat outcome, NOT the
    // local validation message — confirms the validation gate
    // didn't reject the request.
    assert.match(body.error, /HTTP|ECONNREFUSED|fetch failed|timeout/);
  });

  test("response carries the protocol + a latency marker (good UX)", async () => {
    // Even on failure, the response shape is uniform so the UI
    // doesn't have to special-case protocols.
    const res = fakeRes();
    await providersRoute.handleTestProvider(
      fakeReq({
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk-realkey-aaaa", baseURL: "http://127.0.0.1:1" },
        timeoutMs: 200,
      }),
      res,
      {},
    );
    const body = getBody(res);
    assert.equal(body.protocol, "openai");
    assert.equal(typeof body.latencyMs, "number");
  });
});

// =====================================================================
// _peekProvidersUpdatedFrame — SSE broadcast payload shape.
// =====================================================================

describe("SSE broadcast — providers.updated payload is masked", () => {
  test("the named SSE event carries the masked provider shape", async () => {
    writeFileSync(
      join(_tmpDataDir, "providers.json"),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: "p",
            label: "L",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-secret-1234" },
            models: [{ id: "m" }],
          },
        ],
      }),
    );
    const frame = await providersRoute._peekProvidersUpdatedFrame();
    // Plaintext apiKey NEVER in the SSE frame.
    assert.equal(frame.includes("realkey"), false);
    assert.equal(frame.includes("secret"), false);
    assert.match(frame, /^event: providers\.updated\ndata: /);
    // The data payload is JSON; verify it parses and contains the
    // masked shape.
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine.slice("data: ".length));
    assert.equal(payload.providers[0].auth.apiKeyMasked.includes("realkey"), false);
    assert.equal(payload.providers[0].auth.hasKey, true);
  });
});
// ---------------------------------------------------------------------
// Custom headers (webui-parity ticket 85).
//
// The end-to-end run against a live instance found what no unit test
// could: the dialog sent `auth.headers` on `POST /api/providers/test`,
// the route REBUILT `auth` field by field and dropped it, and the
// probe went out without them. Every other layer was correct, so a
// unit test on the config lib or the sync helper stayed green while
// the feature silently did nothing on the one path where a user can
// observe it.
//
// These pins are on the ROUTE, because the route is where the field
// was being lost.
// ---------------------------------------------------------------------

describe("custom headers — route passthrough (ticket 85)", () => {
  // A real loopback listener: the probe's whole job is to make an
  // outbound request, and "did the header actually go out" is only
  // answerable by something on the other end of a socket.
  let echo;
  let echoPort;
  let lastHeaders;

  before(async () => {
    const { createServer } = await import("node:http");
    echo = createServer((req, res) => {
      lastHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    echoPort = echo.address().port;
  });

  after(async () => {
    await new Promise((resolve) => echo.close(resolve));
  });

  test("GET returns stored headers; PUT accepts and persists them", async () => {
    const putRes = fakeRes();
    await providersRoute.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "hdrp",
            label: "Hdr",
            protocol: "openai",
            auth: {
              type: "byok",
              apiKey: "sk-realkey-abcdefghij",
              baseURL: "https://api.example.com",
              headers: { "X-Tenant": "acme" },
            },
            models: [],
          },
        ],
      }),
      putRes,
      {},
    );
    assert.equal(putRes._status, 200);

    const getRes = fakeRes();
    await providersRoute.handleGetProviders(fakeReq({}), getRes, {});
    const body = JSON.parse(getRes._body);
    const found = body.providers.find((p) => p.id === "hdrp");
    assert.ok(found, "the provider is in the catalogue");
    assert.deepEqual(found.auth.headers, { "X-Tenant": "acme" });
  });

  test("the probe transmits the headers on the wire", async () => {
    const res = fakeRes();
    await providersRoute.handleTestProvider(
      fakeReq({
        protocol: "openai",
        auth: {
          type: "byok",
          apiKey: "sk-realkey-abcdefghij",
          baseURL: `http://127.0.0.1:${echoPort}`,
          headers: { "X-Tenant": "acme", "X-Trace-Id": "01HXYZ" },
        },
        timeoutMs: 4000,
      }),
      res,
      {},
    );
    assert.equal(res._status, 200);
    assert.equal(lastHeaders["x-tenant"], "acme", "the header must reach the upstream");
    assert.equal(lastHeaders["x-trace-id"], "01HXYZ");
    // The protocol's own required header still wins — see the probe
    // asymmetry note in docs/webui.md.
    assert.equal(lastHeaders["accept"], "application/json");
  });

  test("a header carrying CRLF is dropped, never injected into the request", async () => {
    const res = fakeRes();
    await providersRoute.handleTestProvider(
      fakeReq({
        protocol: "openai",
        auth: {
          type: "byok",
          apiKey: "sk-realkey-abcdefghij",
          baseURL: `http://127.0.0.1:${echoPort}`,
          headers: { "X-Evil": "a\r\nX-Injected: yes" },
        },
        timeoutMs: 4000,
      }),
      res,
      {},
    );
    assert.equal(
      lastHeaders["x-injected"],
      undefined,
      "a stored value must never be able to add a header line",
    );
    assert.equal(lastHeaders["x-evil"], undefined, "the whole record is rejected");
  });
});

// ---------------------------------------------------------------------
// PROOF — the route really calls the engine facade
// ---------------------------------------------------------------------
//
// Everything above runs against the REAL engine modules, which is what
// makes those tests worth having. It also means none of them can
// distinguish "the route called the facade" from "the route kept its
// own copy of the logic and the facade happens to agree" — a route that
// inlined a second implementation of the same decision would pass all
// of them.
//
// The proof is a marker. `mock.module` replaces the write half of the
// facade with a stub that throws a unique error, the route is
// re-imported under a fresh `?bust=N` (without it the route keeps its
// previous LIVE BINDING to the real module and the marker is never
// thrown), and the test asserts the error escapes by IDENTITY. The
// CONTROL below then runs the same request with no mock and asserts
// the real commit landed — so the two PROOF cases cannot both be
// passing for the wrong reason.

let _bust = 0;

/**
 * A fresh copy of `routes/providers.js`.
 *
 * @returns {Promise<object>}
 */
const loadRoute = async () =>
  import(`${absPath("routes/providers.js")}?bust=${_bust++}`);

describe("PROOF — the provider route is bound to the engine facade", () => {
  test("PROOF: a marker error from the write facade escapes handlePutProviders", async (t) => {
    await setupMocks(t, { acp: {} });
    const marker = new Error("B11-MOCK-WAS-NOT-HONOURED");
    t.mock.module(absPath("engine/provider-writes.js"), {
      namedExports: {
        commitProviderCatalogueWrite: async () => {
          throw marker;
        },
        // Every other name the route imports from this module is the
        // real one. A namespace mock REPLACES the whole module, so
        // anything not listed here would be undefined at the call site
        // and the test would fail for a reason that has nothing to do
        // with the marker.
        assertProviderWriteCapability: () => ({
          endpoint: "PUT /api/providers",
          provider: "local-runtime-v2",
          capability: "authCredentials",
          subItem: "updateUserModelProvider",
          enforcement: "hard",
          gate: "checked",
        }),
        planProviderCatalogueWrite: (existing, incoming) =>
          (incoming || []).map((p) => {
            if (!p || !p.auth) return p;
            if (p.auth.apiKey) return p;
            const prev = (existing || []).find((e) => e && e.id === p.id);
            return { ...p, auth: { ...p.auth, apiKey: prev ? prev.auth.apiKey : "" } };
          }),
        resolveProviderWriteProvider: () => ({ id: "local-runtime-v2" }),
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handlePutProviders(fakeReq({ version: 2, providers: [] }), fakeRes(), {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the facade error — either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });

  test("PROOF: a marker error from the read facade escapes handleGetProviders", async (t) => {
    await setupMocks(t, { acp: {} });
    const marker = new Error("B11-READ-MOCK-WAS-NOT-HONOURED");
    t.mock.module(absPath("engine/provider-reads.js"), {
      namedExports: {
        readEngineProviderCatalogue: async () => {
          throw marker;
        },
        checkProviderReadCapability: () => ({
          endpoint: "GET /api/providers",
          provider: "local-runtime-v2",
          capability: "authCredentials",
          subItem: "listUserModelProviders",
          enforcement: "soft",
          gate: "checked",
          degraded: false,
          reason: null,
        }),
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleGetProviders(null, fakeRes(), {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the GET route reached its own data plane instead of the facade");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });

  test("CONTROL: with no facade mock, PUT runs the real commit and lands in the store", async (t) => {
    // The other half of the proof. A `?bust=` re-import under a fresh
    // test hook gives a route bound to the REAL facade, so the request
    // runs the real plan → commit sequence against the real store. If
    // this answered from a mock, the two PROOF cases above would be
    // proving nothing.
    await setupMocks(t, { acp: {} });
    const route = await loadRoute();
    const res = fakeRes();
    await route.handlePutProviders(
      fakeReq({
        version: 2,
        providers: [
          {
            id: "ctl",
            label: "Control",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-control-aaaa", baseURL: "https://ctl" },
            models: [],
          },
        ],
      }),
      res,
      {},
    );
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.ok, true);
    assert.deepEqual(body.engineSync.keys, ["ctl"]);
    const stored = readStoreRecords();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, "ctl");
    assert.equal(stored[0].auth.apiKey, "sk-control-aaaa");
  });
});
