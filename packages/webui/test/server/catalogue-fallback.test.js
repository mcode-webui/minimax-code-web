// webui/test/server/catalogue-fallback.test.js
//
// S3 — regression pin for the catalogue-host fallback path. When
// `MCODE_WEBUI_TRANSPORT=runtime`, `listAllMcodeSessions` and
// `getMcodeSessionTitle` consult the in-process catalogue host first.
// If the catalogue host throws (boot failure) or its adapter throws
// on the actual list call, the helpers must fall back to the legacy
// ACP path and return the same shape — otherwise a single runtime
// regression would break the sidebar.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IMPORTANT: set MCODE_WEBUI_TRANSPORT BEFORE the SUT modules load.
// config.js evaluates the env at module-init time.
process.env.MCODE_WEBUI_TRANSPORT = "runtime";

const tmpBase = mkdtempSync(join(tmpdir(), "mcode-webui-s3-fallback-"));

let listCalls;
const FAKE_SESSIONS = [
  { sessionId: "mvs_fallback_1", cwd: "/tmp/work", title: "from acp fallback" },
  { sessionId: "mvs_fallback_2", cwd: "/tmp/work2", title: "second acp entry" },
];

// The mock below can be configured per-test via the `failureMode`
// global. The `before()` block reads it once but tests set it before
// importing the SUT — see the harness pattern in each test.
let failureMode = "list"; // "boot" | "list" | "getSession"

class FakeAcpClient {
  constructor() {
    this.alive = true;
  }
  async start() {
    return { protocolVersion: 1 };
  }
  async listSessions() {
    listCalls++;
    return { sessions: FAKE_SESSIONS };
  }
  stop() {}
}

before(async (t) => {
  // Re-set the env inside `before()` in case node:test reset it.
  process.env.MCODE_WEBUI_TRANSPORT = "runtime";

  // Mock acp.mjs so no real mcode subprocess is spawned.
  t.mock.module(join(import.meta.dirname, "../../acp.mjs"), {
    namedExports: { McodeAcpClient: FakeAcpClient },
  });
  // Mock runtime-host.js. The mock reads the module-scoped
  // `failureMode` variable at call time, so tests can flip its mode
  // before triggering the host. (Node:test does not allow re-registering
  // mocks across tests, so we co-locate scenarios in this file and
  // gate behaviour on the flag.)
  t.mock.module(
    join(import.meta.dirname, "../../server/lib/runtime-host.js"),
    {
      namedExports: {
        createCatalogueHost: async () => {
          if (failureMode === "boot") {
            throw new Error("simulated catalogue boot failure");
          }
          return {
            adapter: {
              listSessions: async () => {
                if (failureMode === "list") {
                  throw new Error("simulated runtime-side listSessions failure");
                }
                return FAKE_SESSIONS;
              },
              getSession: async (id) => {
                if (failureMode === "getSession") {
                  throw new Error("simulated runtime-side getSession failure");
                }
                // Return null for unknown ids so the test for "unknown
                // session id" exercises the null-on-miss path. Returning a
                // hard-coded session would mask that behaviour.
                const hit = FAKE_SESSIONS.find((s) => s.sessionId === id);
                return hit ?? null;
              },
            },
            close: async () => {},
          };
        },
        createTurnHost: () => ({}),
      },
    },
  );
});

after(() => {
  delete process.env.MCODE_WEBUI_TRANSPORT;
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

// ============================================================
// S3 fallback: listAllMcodeSessions falls back to ACP when the
// catalogue host boot throws.
// ============================================================

test("S3-FB-01: listAllMcodeSessions falls back to ACP when catalogue host boot throws", async () => {
  failureMode = "boot";
  listCalls = 0;
  const [{ listAllMcodeSessions }, { MCODE_WEBUI_TRANSPORT: envTransport }] =
    await Promise.all([
      import("../../server/lib/acp-client.js"),
      import("../../server/lib/config.js"),
    ]);
  assert.equal(
    envTransport,
    "runtime",
    "test setup must have MCODE_WEBUI_TRANSPORT=runtime",
  );

  const sessions = await listAllMcodeSessions();
  assert.ok(Array.isArray(sessions), "fallback returns an array");
  assert.equal(sessions.length, FAKE_SESSIONS.length, "fallback returns the ACP page");
  assert.equal(
    listCalls,
    1,
    "fallback invokes the ACP listSessions exactly once per call",
  );
  assert.equal(sessions[0].sessionId, FAKE_SESSIONS[0].sessionId);
  assert.equal(sessions[0].cwd, FAKE_SESSIONS[0].cwd);
  assert.equal(sessions[0].title, FAKE_SESSIONS[0].title);
});

// ============================================================
// S3 fallback: getMcodeSessionTitle falls back to ACP when the
// catalogue host boot throws.
// ============================================================

test("S3-FB-02: getMcodeSessionTitle falls back to ACP when catalogue host boot throws", async () => {
  failureMode = "boot";
  listCalls = 0;
  const { getMcodeSessionTitle } = await import(
    "../../server/lib/acp-client.js"
  );

  const title = await getMcodeSessionTitle("mvs_fallback_1");
  assert.equal(title, FAKE_SESSIONS[0].title, "title comes from ACP fallback");
  assert.equal(listCalls, 1, "fallback invoked the ACP listSessions");
});

// ============================================================
// S3 fallback: getMcodeSessionTitle returns null for unknown
// session id on either path (catalogue OR ACP).
// ============================================================

test("S3-FB-03: getMcodeSessionTitle returns null for unknown session id on fallback path", async () => {
  failureMode = "boot";
  listCalls = 0;
  const { getMcodeSessionTitle } = await import(
    "../../server/lib/acp-client.js"
  );

  const title = await getMcodeSessionTitle("mvs_does_not_exist");
  assert.equal(title, null, "unknown session id returns null on the fallback path");
  assert.equal(listCalls, 1, "fallback invoked the ACP listSessions");
});

// ============================================================
// S3 fallback: listAllMcodeSessions falls back to ACP when the
// catalogue host's listSessions call throws (inner catch path).
//
// This test MUST run last — the catalogue host singleton inside
// acp-client.js caches across tests in the same file, so once a
// "boot failure" test has flipped the host boot to throw, a later
// "list failure" test can swap modes and the singleton refresh will
// pick up the new mock behaviour. We reverse the failureMode at the
// end of this test so subsequent tests (none, but defensive) start
// from a clean state.
// ============================================================

test("S3-FB-04: listAllMcodeSessions falls back to ACP when catalogue listSessions throws", async () => {
  failureMode = "list";
  listCalls = 0;
  const { listAllMcodeSessions } = await import(
    "../../server/lib/acp-client.js"
  );

  const sessions = await listAllMcodeSessions();
  assert.ok(Array.isArray(sessions), "fallback returns an array");
  assert.equal(sessions.length, FAKE_SESSIONS.length, "fallback returns the ACP page");
  assert.equal(
    listCalls,
    1,
    "fallback invokes the ACP listSessions exactly once per call",
  );
  assert.equal(sessions[0].title, FAKE_SESSIONS[0].title);
});
