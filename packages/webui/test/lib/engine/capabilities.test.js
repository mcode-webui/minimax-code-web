// webui/test/lib/engine/capabilities.test.js
//
// Snapshot tests for the engine capability declarations (batch B1) and
// the gate machinery around them. Every capability LEVEL of both
// providers is pinned here against the audited matrix in
// doc/engine-abstraction-design.md §1.2 — if a provider surface
// changes without re-auditing the declaration, this file goes red.
// (That is the "mutation check": flipping any key between full /
// partial / none must flip the matching assertion.)
//
// What is deliberately NOT tested here: runtime probing (not built in
// this batch) and HTTP wiring (test/routes/engine-capabilities.check.mjs).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ENGINE_CAPABILITY_KEYS,
  LOCAL_RUNTIME_V2_CAPABILITIES,
  TUI_RUNTIME_ADAPTER_CAPABILITIES,
  assertEngineCapability,
  summarizeUnavailableCapabilities,
  validateEngineCapabilities,
  getEngineProvider,
  listEngineProviderIds,
} from "../../../server/engine/index.js";
import {
  EngineCapabilityNotSupportedError,
  engineCapabilityHttpResponse,
  isEngineCapabilityNotSupportedError,
} from "../../../server/engine/errors.js";

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

describe("ENGINE_CAPABILITY_KEYS", () => {
  test("declares exactly the 14 matrix keys, in matrix order", () => {
    assert.deepEqual(ENGINE_CAPABILITY_KEYS, [
      "sessionCrud",
      "streamingSend",
      "interrupt",
      "toolSkillInvocation",
      "turnDiff",
      "turnRewindRedo",
      "plugins",
      "mcp",
      "subagents",
      "usageStats",
      "authCredentials",
      "updateCheck",
      "fileReadWrite",
      "gitOperations",
    ]);
  });
});

describe("validateEngineCapabilities", () => {
  const base = Object.fromEntries(
    ENGINE_CAPABILITY_KEYS.map((k) => [k, { level: "full" }]),
  );

  test("accepts an all-full declaration", () => {
    assert.deepEqual(validateEngineCapabilities(base), []);
  });

  test("partial without missing is rejected — no half-support without an enumeration", () => {
    const caps = { ...base, plugins: { level: "partial", reason: "x" } };
    assert.ok(validateEngineCapabilities(caps).some((p) => p.includes("plugins")));
  });

  test("partial with an empty missing array is rejected", () => {
    const caps = { ...base, plugins: { level: "partial", missing: [], reason: "x" } };
    assert.ok(validateEngineCapabilities(caps).some((p) => p.includes("plugins")));
  });

  test("partial without reason is rejected", () => {
    const caps = { ...base, plugins: { level: "partial", missing: ["a"] } };
    assert.ok(validateEngineCapabilities(caps).some((p) => p.includes("plugins")));
  });

  test("none without reason is rejected", () => {
    const caps = { ...base, updateCheck: { level: "none" } };
    assert.ok(validateEngineCapabilities(caps).some((p) => p.includes("updateCheck")));
  });

  test("full carrying missing is rejected", () => {
    const caps = { ...base, mcp: { level: "full", missing: ["x"] } };
    assert.ok(validateEngineCapabilities(caps).some((p) => p.includes("mcp")));
  });

  test("a missing key and an unknown key are both rejected", () => {
    const dropped = { ...base };
    delete dropped.turnDiff;
    const problems = validateEngineCapabilities(dropped);
    assert.ok(problems.some((p) => p.includes("missing key: turnDiff")));
    const extended = { ...base, teleportation: { level: "full" } };
    assert.ok(
      validateEngineCapabilities(extended).some((p) => p.includes("unknown key: teleportation")),
    );
  });
});

// ---------------------------------------------------------------------------
// local-runtime-v2 declaration — pinned to design §1.2 (v2 column)
// ---------------------------------------------------------------------------

describe("LOCAL_RUNTIME_V2_CAPABILITIES", () => {
  test("covers all 14 keys with no extras", () => {
    assert.deepEqual(Object.keys(LOCAL_RUNTIME_V2_CAPABILITIES).sort(), [...ENGINE_CAPABILITY_KEYS].sort());
    assert.deepEqual(validateEngineCapabilities(LOCAL_RUNTIME_V2_CAPABILITIES), []);
  });

  // level per key, straight off the matrix (§1.2, local-runtime-v2 column).
  const expectedLevels = {
    sessionCrud: "full",
    streamingSend: "full",
    interrupt: "full",
    toolSkillInvocation: "partial",
    turnDiff: "full",
    turnRewindRedo: "full",
    plugins: "full",
    mcp: "full",
    subagents: "partial",
    usageStats: "full",
    authCredentials: "partial",
    updateCheck: "none",
    fileReadWrite: "partial",
    gitOperations: "partial",
  };

  for (const key of ENGINE_CAPABILITY_KEYS) {
    test(`${key} is ${expectedLevels[key]} (design §1.2 v2 column)`, () => {
      assert.equal(LOCAL_RUNTIME_V2_CAPABILITIES[key].level, expectedLevels[key]);
      if (expectedLevels[key] === "partial") {
        assert.ok(LOCAL_RUNTIME_V2_CAPABILITIES[key].missing.length > 0, "partial must enumerate missing");
        assert.ok(LOCAL_RUNTIME_V2_CAPABILITIES[key].reason.length > 0, "partial must carry a reason");
      }
      if (expectedLevels[key] === "none") {
        assert.ok(LOCAL_RUNTIME_V2_CAPABILITIES[key].reason.length > 0, "none must carry a reason");
      }
    });
  }

  test("subagents partial enumerates the two adapter-context methods", () => {
    assert.deepEqual(LOCAL_RUNTIME_V2_CAPABILITIES.subagents.missing, [
      "getDelegationSnapshot",
      "stopDelegation",
    ]);
  });

  // M3-B9: the two B9 partials name exactly the sub-item each is for,
  // and the generic config-option entry must NOT grow to swallow the
  // bridged ones — `model` and `permissionMode` pass a provider that
  // denies `setConfigOption`, so listing them here would silently
  // disable the bridge this batch exists to keep working.
  test("the two B9 partials enumerate exactly their own sub-item", () => {
    assert.deepEqual(LOCAL_RUNTIME_V2_CAPABILITIES.toolSkillInvocation.missing, ["setMode"]);
    assert.deepEqual(LOCAL_RUNTIME_V2_CAPABILITIES.authCredentials.missing, ["setConfigOption"]);
  });
});

// ---------------------------------------------------------------------------
// tui-runtime-adapter declaration — pinned to design §1.2 (tui column)
// ---------------------------------------------------------------------------

describe("TUI_RUNTIME_ADAPTER_CAPABILITIES", () => {
  test("covers all 14 keys with no extras", () => {
    assert.deepEqual(Object.keys(TUI_RUNTIME_ADAPTER_CAPABILITIES).sort(), [...ENGINE_CAPABILITY_KEYS].sort());
    assert.deepEqual(validateEngineCapabilities(TUI_RUNTIME_ADAPTER_CAPABILITIES), []);
  });

  const expectedLevels = {
    sessionCrud: "full",
    streamingSend: "full",
    interrupt: "full",
    toolSkillInvocation: "partial",
    turnDiff: "none",
    turnRewindRedo: "partial",
    plugins: "partial",
    mcp: "full",
    subagents: "full",
    usageStats: "full",
    authCredentials: "partial",
    updateCheck: "none",
    fileReadWrite: "partial",
    gitOperations: "partial",
  };

  for (const key of ENGINE_CAPABILITY_KEYS) {
    test(`${key} is ${expectedLevels[key]} (design §1.2 tui column)`, () => {
      assert.equal(TUI_RUNTIME_ADAPTER_CAPABILITIES[key].level, expectedLevels[key]);
      if (expectedLevels[key] === "partial") {
        assert.ok(TUI_RUNTIME_ADAPTER_CAPABILITIES[key].missing.length > 0, "partial must enumerate missing");
        assert.ok(TUI_RUNTIME_ADAPTER_CAPABILITIES[key].reason.length > 0, "partial must carry a reason");
      }
      if (expectedLevels[key] === "none") {
        assert.ok(TUI_RUNTIME_ADAPTER_CAPABILITIES[key].reason.length > 0, "none must carry a reason");
      }
    });
  }

  test("plugins partial enumerates the three absent methods", () => {
    assert.deepEqual(TUI_RUNTIME_ADAPTER_CAPABILITIES.plugins.missing, [
      "previewGithubPlugin",
      "importGithubPlugin",
      "listEnabledPlugins",
    ]);
  });

  test("turnRewindRedo partial enumerates reapply only — rewind exists", () => {
    assert.deepEqual(TUI_RUNTIME_ADAPTER_CAPABILITIES.turnRewindRedo.missing, ["reapplyTurnDiff"]);
  });
});

// ---------------------------------------------------------------------------
// The gate: assertEngineCapability → EngineCapabilityNotSupportedError
// ---------------------------------------------------------------------------

describe("assertEngineCapability", () => {
  test("full capabilities pass through", () => {
    assert.doesNotThrow(() =>
      assertEngineCapability(LOCAL_RUNTIME_V2_CAPABILITIES, "turnDiff", "local-runtime-v2"),
    );
  });

  test("partial capability passes when no sub-item is requested", () => {
    assert.doesNotThrow(() =>
      assertEngineCapability(LOCAL_RUNTIME_V2_CAPABILITIES, "subagents", "local-runtime-v2"),
    );
  });

  test("partial capability passes for a sub-item that is NOT missing", () => {
    assert.doesNotThrow(() =>
      assertEngineCapability(
        LOCAL_RUNTIME_V2_CAPABILITIES,
        "subagents",
        "local-runtime-v2",
        "listBackgroundTasks",
      ),
    );
  });

  test("partial capability throws for a missing sub-item, naming it", () => {
    assert.throws(
      () =>
        assertEngineCapability(
          LOCAL_RUNTIME_V2_CAPABILITIES,
          "subagents",
          "local-runtime-v2",
          "getDelegationSnapshot",
        ),
      (err) =>
        err instanceof EngineCapabilityNotSupportedError &&
        err.capability === "subagents" &&
        err.provider === "local-runtime-v2" &&
        err.missing.length === 1 &&
        err.missing[0] === "getDelegationSnapshot" &&
        typeof err.reason === "string",
    );
  });

  test("none capability throws with provider, capability and reason", () => {
    assert.throws(
      () =>
        assertEngineCapability(TUI_RUNTIME_ADAPTER_CAPABILITIES, "turnDiff", "tui-runtime-adapter"),
      (err) =>
        isEngineCapabilityNotSupportedError(err) &&
        err.capability === "turnDiff" &&
        err.provider === "tui-runtime-adapter" &&
        err.reason.includes("implementation-absent"),
    );
  });

  test("undeclared capability (key absent) throws rather than passing silently", () => {
    assert.throws(
      () => assertEngineCapability({}, "sessionCrud", "some-provider"),
      EngineCapabilityNotSupportedError,
    );
  });
});

// ---------------------------------------------------------------------------
// 501 mapping — the HTTP shape routes and the frontend rely on
// ---------------------------------------------------------------------------

describe("engineCapabilityHttpResponse", () => {
  test("maps to 501 with the structured payload", () => {
    const err = new EngineCapabilityNotSupportedError({
      capability: "turnDiff",
      provider: "tui-runtime-adapter",
      reason: "implementation-absent",
    });
    const { status, payload } = engineCapabilityHttpResponse(err);
    assert.equal(status, 501);
    assert.equal(payload.code, "engine_capability_not_supported");
    assert.equal(payload.capability, "turnDiff");
    assert.equal(payload.provider, "tui-runtime-adapter");
    assert.equal(payload.reason, "implementation-absent");
    assert.ok(!("missing" in payload), "empty missing must not appear in the payload");
  });

  test("includes the missing sub-items when present", () => {
    const err = new EngineCapabilityNotSupportedError({
      capability: "plugins",
      provider: "tui-runtime-adapter",
      missing: ["previewGithubPlugin", "importGithubPlugin", "listEnabledPlugins"],
      reason: "adapter surface has only 4 coarse methods",
    });
    const { status, payload } = engineCapabilityHttpResponse(err);
    assert.equal(status, 501);
    assert.deepEqual(payload.missing, [
      "previewGithubPlugin",
      "importGithubPlugin",
      "listEnabledPlugins",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Degradation summary — the input for capability-driven UI (later batch)
// ---------------------------------------------------------------------------

describe("summarizeUnavailableCapabilities", () => {
  // M3-B9 added two more `partial` keys to this declaration — the
  // session-mode write and the generic config-option write, both absent
  // from the audited v2 surface (see the declaration's own comments and
  // `engine/mode-writes.js`). The roll-up is the frontend's input, so
  // the list is pinned as a value rather than a count.
  test("local-runtime-v2: updateCheck alone is none; five keys are partial", () => {
    const summary = summarizeUnavailableCapabilities(LOCAL_RUNTIME_V2_CAPABILITIES);
    assert.deepEqual(summary.none, ["updateCheck"]);
    assert.deepEqual(
      summary.partial.map((p) => p.key).sort(),
      ["authCredentials", "fileReadWrite", "gitOperations", "subagents", "toolSkillInvocation"],
    );
  });

  // Same M3-B9 amendment as the v2 column above, and for the same two
  // reasons: neither the adapter nor the cliService opens a session-mode
  // write or a generic config-option write.
  test("tui-runtime-adapter: turnDiff and updateCheck are none; six keys are partial", () => {
    const summary = summarizeUnavailableCapabilities(TUI_RUNTIME_ADAPTER_CAPABILITIES);
    assert.deepEqual(summary.none, ["turnDiff", "updateCheck"]);
    assert.deepEqual(
      summary.partial.map((p) => p.key).sort(),
      [
        "authCredentials",
        "fileReadWrite",
        "gitOperations",
        "plugins",
        "toolSkillInvocation",
        "turnRewindRedo",
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

describe("engine facade", () => {
  test("registers exactly the two currently-wired providers", () => {
    assert.deepEqual(listEngineProviderIds().sort(), ["local-runtime-v2", "tui-runtime-adapter"]);
  });

  test("returns declaration + transport for a known provider", () => {
    const provider = getEngineProvider("tui-runtime-adapter");
    assert.equal(provider.transport, "runtime");
    assert.equal(provider.capabilities, TUI_RUNTIME_ADAPTER_CAPABILITIES);
  });

  test("unknown provider throws a plain Error (caller confusion, not 501 material)", () => {
    assert.throws(() => getEngineProvider("carrier-pigeon"), {
      name: "Error",
      message: /unknown provider "carrier-pigeon"/,
    });
  });
});
