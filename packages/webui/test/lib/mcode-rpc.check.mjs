// webui/test/lib/mcode-rpc.check.mjs
// Unit tests for server/lib/mcode-rpc.js — public exports + permission mapping.
//
// Why this test exists: mcode-rpc.js is the clean wrapper around mcode 0.1.5
// acp JSON-RPC. PERMISSION_MODES + mcodePermissionToWebui are the enum used
// by routes/model.js. MCODE_ACP_CAPABILITIES drives the capability detection
// in routes/protocol.js. Bugs here = wrong permission labels shown to user
// or capability detection thinks mcode supports methods it doesn't.
//
// Test strategy: NO setupMocks. We import the REAL mcode-rpc.js so we test
// the actual exports. We only test the safe-to-call functions:
// - Pure functions: PERMISSION_MODES, MCODE_ACP_CAPABILITIES, webuiPermissionToMcode,
//   mcodePermissionToWebui
// - fail()/sanitizeError(), reached through an argument check that returns
//   before the client is touched
// We do NOT call setMode/setConfigOption/cancelSession/activateSession/
// loadSession/listSessions with a valid argument: every one of them reaches the
// mcode acp client and would spawn it. The route layer covers those mocks.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const rpc = await import(absPath("lib/mcode-rpc.js"));

describe("mcode-rpc — PERMISSION_MODES constant", () => {
  test("is an array of 6 mcode permission mode strings", () => {
    assert.ok(Array.isArray(rpc.PERMISSION_MODES));
    assert.equal(rpc.PERMISSION_MODES.length, 6);
  });

  test("includes the 6 mcode permission mode values", () => {
    assert.ok(rpc.PERMISSION_MODES.includes("default"));
    assert.ok(rpc.PERMISSION_MODES.includes("bypassPermissions"));
    assert.ok(rpc.PERMISSION_MODES.includes("auto"));
    assert.ok(rpc.PERMISSION_MODES.includes("off"));
    assert.ok(rpc.PERMISSION_MODES.includes("read"));
    assert.ok(rpc.PERMISSION_MODES.includes("full"));
  });
});

describe("mcode-rpc — MCODE_ACP_CAPABILITIES", () => {
  test("matches what the wrapper can actually reach", () => {
    assert.equal(typeof rpc.MCODE_ACP_CAPABILITIES, "object");
    // Every method the engine registers is reachable; `delete` is the one it
    // registers in its protocol but never implements.
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.set_mode, true);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.set_config_option, true);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.cancel, true);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.activate, true);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.fork, true);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.resume, true);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.delete, false);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.load, true);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.prompt, true);
  });
});

describe("mcode-rpc — mcodePermissionToWebui", () => {
  test("'default' → 'Ask'", () => {
    assert.equal(rpc.mcodePermissionToWebui("default"), "Ask");
  });

  test("'bypassPermissions' → 'Full access'", () => {
    assert.equal(rpc.mcodePermissionToWebui("bypassPermissions"), "Full access");
  });

  test("'auto' → 'Auto'", () => {
    assert.equal(rpc.mcodePermissionToWebui("auto"), "Auto");
  });

  test("'off' → 'Off'", () => {
    assert.equal(rpc.mcodePermissionToWebui("off"), "Off");
  });

  test("'read' → 'Read'", () => {
    assert.equal(rpc.mcodePermissionToWebui("read"), "Read");
  });

  test("'full' → 'Full access'", () => {
    assert.equal(rpc.mcodePermissionToWebui("full"), "Full access");
  });

  test("unknown mode returns the input itself (passthrough)", () => {
    assert.equal(rpc.mcodePermissionToWebui("gibberish"), "gibberish");
  });

  test("empty/undefined mode falls back to 'Full access'", () => {
    assert.equal(rpc.mcodePermissionToWebui(""), "Full access");
    assert.equal(rpc.mcodePermissionToWebui(undefined), "Full access");
    assert.equal(rpc.mcodePermissionToWebui(null), "Full access");
  });
});

describe("mcode-rpc — webuiPermissionToMcode (reverse mapping)", () => {
  test("'ask' → 'default'", () => {
    assert.equal(rpc.webuiPermissionToMcode("ask"), "default");
  });

  test("'full' → 'bypassPermissions'", () => {
    assert.equal(rpc.webuiPermissionToMcode("full"), "bypassPermissions");
  });

  test("'auto' → 'auto'", () => {
    assert.equal(rpc.webuiPermissionToMcode("auto"), "auto");
  });

  test("'read' → 'read'", () => {
    assert.equal(rpc.webuiPermissionToMcode("read"), "read");
  });

  test("'off' → 'off'", () => {
    assert.equal(rpc.webuiPermissionToMcode("off"), "off");
  });

  test("unknown webui mode returns null", () => {
    assert.equal(rpc.webuiPermissionToMcode("gibberish"), null);
  });
});

describe("mcode-rpc — error message sanitization (via the fail() path)", () => {
  test("a failure message is one line with no control characters", async () => {
    // loadSession refuses an empty id before it reaches the client, so this
    // exercises fail() → sanitizeError() without spawning mcode.
    const r = await rpc.loadSession("", "/ws-X");
    assert.equal(r.ok, false);
    assert.equal(r.code, "missing_session");
    assert.ok(!r.error.includes("\n"), `error should not contain \\n: ${r.error}`);
    assert.ok(!r.error.includes("\r"), `error should not contain \\r: ${r.error}`);
  });
});
