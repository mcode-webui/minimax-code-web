// webui/test/lib/acp-client-requests.test.js
//
// The two halves of the ACP client contract that the engine reads on the
// other side of the pipe:
//
//   1. `initialize` negotiates under `clientCapabilities`
//      (packages/tui/src/acp/agent.ts:434). The webui used to send a
//      `capabilities` key holding an `mcpCapabilities` object, which is
//      not a field of the ACP v1 `ClientCapabilities` type at all — so
//      the engine negotiated zero client capabilities and every
//      capability-gated projection stayed switched off.
//
//   2. Engine→client REQUESTS are answered. JSON-RPC is bidirectional and
//      the engine issues requests of its own (session/request_permission,
//      elicitation/create, fs/*, terminal/*). `_dispatch` used to treat
//      them as notifications: emitted, never answered. The engine then
//      holds the request forever
//      (packages/tui/src/acp/interactions.ts:562) and a full queue closes
//      the ACP connection (interactions.ts:242).
//
// These assertions run against a real child process, so they cover the
// bytes on the wire rather than a mocked transport. The engine-side half
// — that `clientCapabilities.plan` really switches the `plan_update`
// projection on — is pinned in
// `packages/tui/test/unit/acp-webui-client-capabilities.test.ts`.

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

const WEBUI_DIR = resolve(import.meta.dirname, "..", "..");
const absWebuiPath = (rel) => pathToFileURL(resolve(WEBUI_DIR, rel)).href;

const { McodeAcpClient, CLIENT_CAPABILITIES } = await import(absWebuiPath("acp.mjs"));

// The fake engine. Written to a tmpdir so the test drives a genuine
// `spawn` + stdin/stdout JSON-RPC exchange — the interesting half of this
// contract is a wire-shaped discrimination that no in-process stub can
// reproduce.
//
// Message order after `initialize` is the point of the exercise:
//   1. a REQUEST with id 1 — the same numeric id the client's own
//      initialize request is using, because JSON-RPC ids are
//      per-direction and the two spaces must not collide;
//   2. the initialize RESPONSE (id 1, carries `result`);
//   3. a `session/update` notification, to prove the request branch does
//      not swallow the rest of the chunk.
const FAKE_ENGINE = `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined && msg.id !== undefined) {
      send({ jsonrpc: "2.0", method: "probe/client_response", params: msg });
      continue;
    }
    if (msg.method !== "initialize") continue;
    send({ jsonrpc: "2.0", method: "probe/initialize_params", params: msg.params });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/request_permission",
      params: { sessionId: "s1", toolCall: { toolCallId: "t1", title: "edit" }, options: [] },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p1", content: "# Plan" } },
      },
    });
  }
});
`;

let enginePath = null;
let dir = null;

before(() => {
  dir = mkTmpDir("webui-acp-fake-engine-");
  enginePath = join(dir, "fake-engine.mjs");
  writeFileSync(enginePath, FAKE_ENGINE);
  process.env.MCODE_CMD = enginePath;
});

after(() => {
  delete process.env.MCODE_CMD;
  if (dir) rmTmpDir(dir);
});

/** Collect one event by name, or reject if it does not arrive in time. */
function once(emitter, event, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    const onEvent = (payload) => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      resolvePromise(payload);
    };
    emitter.on(event, onEvent);
  });
}

const running = [];

/** Start a client against the fake engine and return it once `initialize` settled. */
async function startClient(options = {}) {
  const client = new McodeAcpClient(options);
  running.push(client);
  const initialized = client.start();
  return { client, initialized };
}

afterEach(() => {
  while (running.length) running.pop().stop();
});

describe("acp.mjs client capability negotiation", () => {
  test("initialize negotiates under clientCapabilities, and the engine sees the plan capability", async () => {
    const { client, initialized } = await startClient();
    const echo = once(client, "probe/initialize_params");
    await initialized;

    const params = await echo;
    assert.deepEqual(params.clientCapabilities, { plan: {} });
    assert.equal(
      Object.hasOwn(params, "capabilities"),
      false,
      "the engine reads clientCapabilities; a `capabilities` key negotiates nothing",
    );
    // The engine-side consequence is pinned in
    // packages/tui/test/unit/acp-webui-client-capabilities.test.ts.
    assert.equal(params.protocolVersion, 1);
  });

  test("only capabilities the webui consumes are advertised", () => {
    // Each addition here is a promise to answer. `elicitation.form` makes
    // the engine ask questions (acp/interactions.ts:607) that fail closed
    // against a questionnaire dismissal (interactions.ts:647);
    // `auth.terminal` adds authMethods this client cannot run
    // (agent.ts:455); the extension `_meta` turns on goal / queue /
    // delegation notifications (acp/extensions.ts:277) that no webui
    // handler subscribes to.
    assert.deepEqual(CLIENT_CAPABILITIES, { plan: {} });
    assert.equal(Object.isFrozen(CLIENT_CAPABILITIES), true);
  });
});

describe("acp.mjs answers engine→client requests", () => {
  test("an unanswered-by-policy request is declined with a JSON-RPC error carrying the engine's id", async () => {
    const { client, initialized } = await startClient();
    const declined = once(client, "probe/client_response");
    await initialized;

    const response = (await declined);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1, "the response must reuse the request's own id");
    assert.equal(response.result, undefined);
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /session\/request_permission/);
  });

  test("a request in the same chunk does not disturb the client's own pending call", async () => {
    // The fake engine reuses id 1 for its request while the client's
    // `initialize` is still pending on id 1. If the request branch
    // resolved `pending` by id alone, `initialize` would settle with the
    // permission request's response — or never settle at all.
    const { initialized } = await startClient();
    const result = await initialized;
    assert.deepEqual(result, { protocolVersion: 1, agentCapabilities: {} });
  });

  test("notifications after a request in the same chunk still reach listeners", async () => {
    const { client, initialized } = await startClient();
    const planUpdate = once(client, "plan_update");
    await initialized;

    const update = await planUpdate;
    assert.equal(update.sessionUpdate, "plan_update");
    assert.equal(update.plan.planId, "p1");
  });

  test("a clientRequest handler's resolved value is returned as the result", async () => {
    const seen = [];
    const { client, initialized } = await startClient({
      clientRequest: (method, params) => {
        seen.push({ method, params });
        return { outcome: { outcome: "cancelled" } };
      },
    });
    const answered = once(client, "probe/client_response");
    await initialized;

    const response = (await answered);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "session/request_permission");
    assert.equal(seen[0].params.sessionId, "s1");
    assert.equal(response.id, 1);
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result, { outcome: { outcome: "cancelled" } });
  });

  test("an async clientRequest handler is awaited before the response is written", async () => {
    const { client, initialized } = await startClient({
      clientRequest: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { outcome: { outcome: "selected", optionId: "deny" } };
      },
    });
    const answered = once(client, "probe/client_response");
    await initialized;

    assert.deepEqual((await answered).result, {
      outcome: { outcome: "selected", optionId: "deny" },
    });
  });

  test("a throwing clientRequest handler becomes a JSON-RPC error, not a crash", async () => {
    const { client, initialized } = await startClient({
      clientRequest: () => {
        throw new Error("no such surface");
      },
    });
    const answered = once(client, "probe/client_response");
    const planUpdate = once(client, "plan_update");
    await initialized;

    const response = (await answered);
    assert.equal(response.error.code, -32603);
    assert.equal(response.error.message, "no such surface");
    // The throw happened inside _dispatch; the rest of the chunk still
    // has to be processed or the stream would desynchronise.
    assert.equal((await planUpdate).plan.planId, "p1");
  });

  test("a rejecting clientRequest handler is reported as an error response", async () => {
    const { client, initialized } = await startClient({
      clientRequest: () => Promise.reject(new Error("handler exploded")),
    });
    const answered = once(client, "probe/client_response");
    await initialized;

    const response = (await answered);
    assert.equal(response.error.code, -32603);
    assert.equal(response.error.message, "handler exploded");
  });

  test("a JSON-RPC error code on the thrown value is preserved", async () => {
    const { client, initialized } = await startClient({
      clientRequest: () => {
        throw Object.assign(new Error("nope"), { code: -32602 });
      },
    });
    const answered = once(client, "probe/client_response");
    await initialized;

    assert.equal((await answered).error.code, -32602);
  });
});
