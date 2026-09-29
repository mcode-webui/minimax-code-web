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
import { join } from "node:path";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

// IMPORTANT: set MCODE_WEBUI_TRANSPORT BEFORE the SUT modules load.
// config.js evaluates the env at module-init time.
process.env.MCODE_WEBUI_TRANSPORT = "runtime";

const tmpBase = mkTmpDir("mcode-webui-s3-fallback-");

let listCalls;
// Two fixtures in the two real shapes the two transports answer in:
// the ACP client returns the wire shape (`cwd`), while the catalogue
// host returns the runtime's TuiSession shape (`workspaceDir`) — the
// projection in catalogue-sessions.js maps one onto the other. A
// single shared fixture in the ACP shape happened to survive the S3
// pass-through projection; the S3-parity projection reads
// `workspaceDir`, so the shapes must be honest now.
const FAKE_ACP_SESSIONS = [
  { sessionId: "mvs_fallback_1", cwd: "/tmp/work", title: "from acp fallback" },
  { sessionId: "mvs_fallback_2", cwd: "/tmp/work2", title: "second acp entry" },
];
const FAKE_TUI_SESSIONS = [
  { sessionId: "mvs_fallback_1", workspaceDir: "/tmp/work", title: "from acp fallback" },
  { sessionId: "mvs_fallback_2", workspaceDir: "/tmp/work2", title: "second acp entry" },
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
    return { sessions: FAKE_ACP_SESSIONS };
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
                return FAKE_TUI_SESSIONS;
              },
              getSession: async (id) => {
                if (failureMode === "getSession") {
                  throw new Error("simulated runtime-side getSession failure");
                }
                // Return null for unknown ids so the test for "unknown
                // session id" exercises the null-on-miss path. Returning a
                // hard-coded session would mask that behaviour.
                const hit = FAKE_TUI_SESSIONS.find((s) => s.sessionId === id);
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
    rmTmpDir(tmpBase);
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
  assert.equal(sessions.length, FAKE_ACP_SESSIONS.length, "fallback returns the ACP page");
  assert.equal(
    listCalls,
    1,
    "fallback invokes the ACP listSessions exactly once per call",
  );
  assert.equal(sessions[0].sessionId, FAKE_ACP_SESSIONS[0].sessionId);
  assert.equal(sessions[0].cwd, FAKE_ACP_SESSIONS[0].cwd);
  assert.equal(sessions[0].title, FAKE_ACP_SESSIONS[0].title);
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
  assert.equal(title, FAKE_ACP_SESSIONS[0].title, "title comes from ACP fallback");
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
  assert.equal(sessions.length, FAKE_ACP_SESSIONS.length, "fallback returns the ACP page");
  assert.equal(
    listCalls,
    1,
    "fallback invokes the ACP listSessions exactly once per call",
  );
  assert.equal(sessions[0].title, FAKE_ACP_SESSIONS[0].title);
});

// ============================================================
// S3 happy path: when the catalogue host is healthy, the data comes
// from the catalogue side and the ACP client is never consulted.
//
// This is the success-branch twin of the fallback tests above: every
// other case in this file proves a failure falls THROUGH to ACP; this
// one proves the catalogue branch is actually taken. Without it,
// deleting the entire catalogue branch from acp-client.js leaves
// every test in this file green (the ACP mock returns the same rows
// the catalogue mock serves, modulo the shape difference), so
// `listCalls === 0` is
// the only honest discriminator. It must run after FB-04: the
// catalogue host singleton inside acp-client.js is cached across
// tests in this file, and the cached host's adapter reads
// `failureMode` at call time.
// ============================================================

test("S3-FB-05: healthy catalogue host serves list/title without touching ACP", async () => {
  failureMode = "ok";
  listCalls = 0;
  const { listAllMcodeSessions, getMcodeSessionTitle } = await import(
    "../../server/lib/acp-client.js"
  );

  const sessions = await listAllMcodeSessions();
  assert.ok(Array.isArray(sessions), "catalogue path returns an array");
  assert.equal(
    sessions.length,
    FAKE_TUI_SESSIONS.length,
    "catalogue path returns the full page",
  );
  assert.equal(
    sessions[0].sessionId,
    FAKE_TUI_SESSIONS[0].sessionId,
    "catalogue path returns the catalogue-side data",
  );

  const title = await getMcodeSessionTitle(FAKE_TUI_SESSIONS[0].sessionId);
  assert.equal(
    title,
    FAKE_TUI_SESSIONS[0].title,
    "title comes from the catalogue-side getSession, not from an ACP relist",
  );

  assert.equal(
    listCalls,
    0,
    "ACP listSessions must never be called when the catalogue host is healthy",
  );
});
