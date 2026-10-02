// webui/test/routes/health.check.mjs
// Unit tests for server/routes/health.js — handleHealth.
//
// Why this test exists: /api/health is the first thing every external monitor
// and the agent-browser probe hits. If it returns wrong shape, monitoring
// breaks and we don't notice the server is broken.
//
// M3-B1: handleHealth became `async` when `mcodeVersion` moved behind the
// engine facade (server/engine/session-reads.js#readEngineVersion, which
// resolves its acp-client dependency with a dynamic import to stay off the
// boot path). The response shape is unchanged; the tests below pin the
// field list so the await-vs-sync change cannot smuggle a field edit in.
//
// Test strategy: NO setupMocks. handleHealth is a pure function over config
// constants plus the ACP `initialize` mirror, which is null with no client
// attached. No webui deps, no fs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const health = await import(absPath("routes/health.js"));

function fakeRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
  return res;
}

async function callHealth() {
  const res = fakeRes();
  await health.handleHealth(null, res);
  return res;
}

describe("handleHealth — /api/health", () => {
  test("returns 200 + ok:true", async () => {
    const res = await callHealth();
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
  });

  test("response includes all expected fields", async () => {
    const body = JSON.parse((await callHealth())._body);
    // Check all documented fields exist with correct types
    assert.equal(typeof body.port, "number");
    assert.equal(typeof body.defaultModel, "string");
    assert.equal(typeof body.defaultWorkspace, "string");
    assert.equal(typeof body.mcodeCmd, "string");
    assert.equal(typeof body.mcodeVersion, "string");
    assert.equal(typeof body.maxConcurrent, "number");
  });

  // M3-B1 shape snapshot: the field list IS the contract for every monitor
  // and probe. This catches both a removed field and a "just one more" field.
  test("field list is exactly the seven documented keys, in order", async () => {
    const body = JSON.parse((await callHealth())._body);
    assert.deepEqual(Object.keys(body), [
      "ok",
      "port",
      "defaultModel",
      "defaultWorkspace",
      "mcodeCmd",
      "mcodeVersion",
      "maxConcurrent",
    ]);
  });

  test("Content-Type is application/json", async () => {
    const res = await callHealth();
    assert.match(res._headers["Content-Type"], /application\/json/);
  });

  test("port is a valid port number (1-65535)", async () => {
    const body = JSON.parse((await callHealth())._body);
    assert.ok(body.port > 0 && body.port < 65536);
  });

  test("maxConcurrent is a positive integer", async () => {
    const body = JSON.parse((await callHealth())._body);
    assert.ok(Number.isInteger(body.maxConcurrent));
    assert.ok(body.maxConcurrent > 0);
  });

  // M3-B1: no ACP client is attached in this suite, so the engine facade
  // must still answer with the documented `"unknown"` sentinel rather than
  // `null`/`undefined` — the field is typed `string` in the contract and a
  // monitor doing `semver` parsing on it would throw on null.
  test('mcodeVersion is the string "unknown" when no client has attached', async () => {
    const body = JSON.parse((await callHealth())._body);
    assert.equal(body.mcodeVersion, "unknown");
  });
});
