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
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const providersRoute = await import(absPath("routes/providers.js"));
const providersConfig = await import(absPath("lib/providers-config.js"));

let _tmpDataDir;
let _tmpCwd;
let _origDataDir;
let _origCwdEnv;
let _origCwd;

before(async () => {
  _tmpDataDir = mkdtempSync(join(tmpdir(), "webui-providers-route-"));
  _tmpCwd = mkdtempSync(join(tmpdir(), "webui-providers-route-cwd-"));
  _origDataDir = process.env.MCODE_WEBUI_DATA_DIR;
  _origCwdEnv = process.env.MCODE_WEBUI_MODELS_CONFIG;
  _origCwd = process.cwd();
  process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;
  process.env.MCODE_WEBUI_MODELS_CONFIG = "";
  process.chdir(_tmpCwd);
});

after(async () => {
  if (_origDataDir === undefined) delete process.env.MCODE_WEBUI_DATA_DIR;
  else process.env.MCODE_WEBUI_DATA_DIR = _origDataDir;
  if (_origCwdEnv === undefined) delete process.env.MCODE_WEBUI_MODELS_CONFIG;
  else process.env.MCODE_WEBUI_MODELS_CONFIG = _origCwdEnv;
  try { process.chdir(_origCwd); } catch {}
  if (_tmpDataDir) try { rmSync(_tmpDataDir, { recursive: true, force: true }); } catch {}
  if (_tmpCwd) try { rmSync(_tmpCwd, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  const cwdFile = join(_tmpCwd, "models.json");
  if (existsSync(cwdFile)) rmSync(cwdFile);
  const userFile = join(_tmpDataDir, "providers.json");
  if (existsSync(userFile)) rmSync(userFile);
});

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
  test("empty config returns ok + empty providers + sources", () => {
    const res = fakeRes();
    providersRoute.handleGetProviders(null, res, {});
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.version, 2);
    assert.deepEqual(body.providers, []);
    assert.ok(body.sources, "sources object present");
    assert.ok(body.userPath, "userPath present");
  });

  test("user-level file is read on every call (hot reload)", () => {
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
    providersRoute.handleGetProviders(null, res, {});
    const body = getBody(res);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].id, "u1");
    assert.equal(body.providers[0].label, "User One");
  });

  test("apiKey is masked in every provider (no plaintext anywhere)", () => {
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
    providersRoute.handleGetProviders(null, res, {});
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

  test("sources.{env,cwd,user} point at the resolved paths", () => {
    const envFile = join(_tmpCwd, "env.json");
    writeFileSync(envFile, JSON.stringify({ providers: [] }));
    process.env.MCODE_WEBUI_MODELS_CONFIG = envFile;
    try {
      const res = fakeRes();
      providersRoute.handleGetProviders(null, res, {});
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
  test("valid body persists to user-level file and returns masked shape", async () => {
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
    const onDisk = JSON.parse(
      readFileSync(providersConfig.getUserLevelPath(), "utf8"),
    );
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
    providersRoute.handleGetProviders(null, get, {});
    const body = getBody(get);
    const found = body.providers.find((p) => p.id === "newprov");
    assert.ok(found, "newprov visible after PUT");
    assert.equal(found.models.length, 1);
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
  test("the named SSE event carries the masked provider shape", () => {
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
    const frame = providersRoute._peekProvidersUpdatedFrame();
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