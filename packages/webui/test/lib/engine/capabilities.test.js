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

import * as engineFacade from "../../../server/engine/index.js";
// The model / provider families are deliberately NOT re-exported by the
// facade (engine/index.js says so for model-reads.js and keeps it that
// way: those four reach js-yaml and @mavis/shared at module scope). The
// compatibility sweep below has to cover them too, so it imports them
// from where they actually live.
import { resolveModelWriteProvider } from "../../../server/engine/model-writes.js";
import { resolveModelReadProvider } from "../../../server/engine/model-reads.js";
import { resolveProviderReadProvider } from "../../../server/engine/provider-reads.js";
import { resolveProviderWriteProvider } from "../../../server/engine/provider-writes.js";
import {
  ACP_CAPABILITIES,
  ENGINE_CAPABILITY_KEYS,
  EXEC_CAPABILITIES,
  EXEC_INTERFACE,
  LOCAL_RUNTIME_V2_CAPABILITIES,
  TUI_RUNTIME_ADAPTER_CAPABILITIES,
  assertEngineCapability,
  resolveCapabilityHostProvider,
  summarizeCapabilityHosting,
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
// acp declaration — pinned to design §1.2 (acp column), M4-1
// ---------------------------------------------------------------------------

describe("ACP_CAPABILITIES", () => {
  test("covers all 14 keys with no extras", () => {
    assert.deepEqual(Object.keys(ACP_CAPABILITIES).sort(), [...ENGINE_CAPABILITY_KEYS].sort());
    assert.deepEqual(validateEngineCapabilities(ACP_CAPABILITIES), []);
  });

  // Level per key, straight off the matrix (§1.2, acp column). M4-1
  // changed two of the plan's assumptions and both are argued in the
  // declaration's header: `interrupt` is `none` even though
  // `session/cancel` exists (a notification certifies delivery, not the
  // stop), and `toolSkillInvocation` does NOT miss `setMode` (the
  // protocol registers `session/set_mode` as a real request, which
  // neither runtime surface has — so the acp column is genuinely
  // stronger here than the v2 one, and flattening it would be the
  // unearned claim the matrix forbids).
  const expectedLevels = {
    sessionCrud: "partial",
    streamingSend: "full",
    interrupt: "none",
    toolSkillInvocation: "partial",
    turnDiff: "none",
    turnRewindRedo: "none",
    plugins: "none",
    mcp: "partial",
    subagents: "partial",
    usageStats: "partial",
    authCredentials: "partial",
    updateCheck: "none",
    fileReadWrite: "none",
    gitOperations: "none",
  };

  for (const key of ENGINE_CAPABILITY_KEYS) {
    test(`${key} is ${expectedLevels[key]} (design §1.2 acp column)`, () => {
      assert.equal(ACP_CAPABILITIES[key].level, expectedLevels[key]);
      if (expectedLevels[key] === "partial") {
        assert.ok(ACP_CAPABILITIES[key].missing.length > 0, "partial must enumerate missing");
        assert.ok(ACP_CAPABILITIES[key].reason.length > 0, "partial must carry a reason");
      }
      if (expectedLevels[key] === "none") {
        assert.ok(ACP_CAPABILITIES[key].reason.length > 0, "none must carry a reason");
      }
    });
  }

  // "如实 none" is the batch's whole subject, so the six `none` keys
  // are pinned as a SET, not as a count. A new `none` that nobody
  // re-audited is the failure mode this test exists to catch; a
  // `none` quietly promoted to `partial` is the flattering one, and
  // this catches that too.
  test("exactly six keys are none, and two of them are the served-in-process pair", () => {
    const noneKeys = ENGINE_CAPABILITY_KEYS.filter((k) => ACP_CAPABILITIES[k].level === "none");
    assert.deepEqual(noneKeys, [
      "interrupt",
      "turnDiff",
      "turnRewindRedo",
      "plugins",
      "updateCheck",
      "fileReadWrite",
      "gitOperations",
    ]);
    assert.equal(noneKeys.length, 7, "the list above is the assertion — keep both in step");
  });

  // The absent session methods are named BY NAME, because
  // `session-writes.js` gates #7 and #6 on exactly `deleteSession` and
  // a kebab-case name would never match that gate's sub-item. This is
  // the naming contract M4-3 depends on, so it is a value assertion.
  //
  // M4-3a: `deleteSession` left this list, and NOT because the protocol
  // grew a handler — it still has none, and the snapshot suite asserts
  // that against the wire table independently. webui stopped deleting by
  // SQL and now asks the process-local v2 host's own `deleteSession`, so
  // the transport can serve the sub-item. The two that remain are the two
  // nothing serves from anywhere.
  test("sessionCrud partial names the two absent session methods", () => {
    assert.deepEqual(ACP_CAPABILITIES.sessionCrud.missing, [
      "renameSession",
      "archiveSession",
    ]);
  });

  test("mcp partial names its four sub-capabilities in kebab-case", () => {
    assert.deepEqual(ACP_CAPABILITIES.mcp.missing, [
      "mcp-configure",
      "mcp-inspect",
      "mcp-clear",
      "mcp-list",
    ]);
  });

  // The setMode asymmetry, pinned from both sides. v2 and the adapter
  // cannot write the session mode; the protocol can. If either side
  // moves, one of these two assertions goes red and forces the
  // re-audit the declaration's comment describes.
  test("the acp protocol HAS setMode, unlike both runtime surfaces", () => {
    assert.equal(ACP_CAPABILITIES.toolSkillInvocation.missing.includes("setMode"), false);
    assert.deepEqual(LOCAL_RUNTIME_V2_CAPABILITIES.toolSkillInvocation.missing, ["setMode"]);
    assert.deepEqual(TUI_RUNTIME_ADAPTER_CAPABILITIES.toolSkillInvocation.missing, ["setMode"]);
  });

  // B14's rule, restated for the new provider: the effort writer is
  // named by the bridge and implemented by nobody, so no declaration
  // may list it as missing — listing it would remove the control for
  // every user today. The snapshot suite proves the absence on the
  // real surfaces; this proves no provider has started claiming it.
  test("authCredentials does not list the effort writer as missing", () => {
    for (const [name, decl] of [
      ["acp", ACP_CAPABILITIES],
      ["exec", EXEC_CAPABILITIES],
      ["local-runtime-v2", LOCAL_RUNTIME_V2_CAPABILITIES],
      ["tui-runtime-adapter", TUI_RUNTIME_ADAPTER_CAPABILITIES],
    ]) {
      assert.equal(
        (decl.authCredentials.missing || []).includes("setThinkingEffort"),
        false,
        `${name}: listing the effort writer would remove the control for every user today`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// exec declaration — pinned to the CLI contract + stream-json event
// union, M4-2. The audited matrix (doc §1.2) has no exec column, so
// these levels come from the interface itself; every reason in the
// declaration names the file and line it was taken from.
// ---------------------------------------------------------------------------

describe("EXEC_CAPABILITIES", () => {
  test("covers all 14 keys with no extras", () => {
    assert.deepEqual(Object.keys(EXEC_CAPABILITIES).sort(), [...ENGINE_CAPABILITY_KEYS].sort());
    assert.deepEqual(validateEngineCapabilities(EXEC_CAPABILITIES), []);
  });

  // `mcode exec` has no request channel: argv in, stream-json out. Every
  // one of these levels follows from that, and the two entries where exec
  // is STRONGER than acp (usageStats) or equal (streamingSend) are
  // pinned as firmly as the six where it is weaker, so a future
  // "harmonise the two transports" edit cannot quietly flatten the
  // differences in either direction.
  const expectedLevels = {
    sessionCrud: "partial",
    streamingSend: "full",
    interrupt: "none",
    toolSkillInvocation: "partial",
    turnDiff: "none",
    turnRewindRedo: "none",
    plugins: "none",
    mcp: "partial",
    subagents: "none",
    usageStats: "partial",
    authCredentials: "none",
    updateCheck: "none",
    fileReadWrite: "none",
    gitOperations: "none",
  };

  for (const key of ENGINE_CAPABILITY_KEYS) {
    test(`${key} is ${expectedLevels[key]} (the exec CLI contract / event union)`, () => {
      assert.equal(EXEC_CAPABILITIES[key].level, expectedLevels[key]);
      if (expectedLevels[key] === "partial") {
        assert.ok(EXEC_CAPABILITIES[key].missing.length > 0, "partial must enumerate missing");
        assert.ok(EXEC_CAPABILITIES[key].reason.length > 0, "partial must carry a reason");
      }
      if (expectedLevels[key] === "none") {
        assert.ok(EXEC_CAPABILITIES[key].reason.length > 0, "none must carry a reason");
      }
    });
  }

  // "如实 none" is the batch's subject, so the `none` SET is pinned
  // rather than a count — the same discipline the acp block uses. exec
  // has eight of them against acp's seven, and the two differences are
  // the interesting part: exec loses `subagents` and `authCredentials`,
  // and the two tests below say exactly why.
  test("exactly eight keys are none, and two of them are the served-in-process pair", () => {
    const noneKeys = ENGINE_CAPABILITY_KEYS.filter((k) => EXEC_CAPABILITIES[k].level === "none");
    assert.deepEqual(noneKeys, [
      "interrupt",
      "turnDiff",
      "turnRewindRedo",
      "plugins",
      "subagents",
      "authCredentials",
      "updateCheck",
      "fileReadWrite",
      "gitOperations",
    ]);
    assert.equal(noneKeys.length, 9, "the list above is the assertion — keep both in step");
  });

  // exec is behind acp on exactly these two keys, and BOTH directions of
  // the mistake are pinned: promoting them to partial would claim an
  // event kind the exec stream does not have and a method it has no
  // channel to call; declaring them partial "for symmetry with acp"
  // would be the unearned claim the matrix forbids.
  test("subagents and authCredentials are none on exec where acp is partial", () => {
    assert.equal(EXEC_CAPABILITIES.subagents.level, "none");
    assert.equal(ACP_CAPABILITIES.subagents.level, "partial");
    // The reason must name the actual mechanism, not just say "absent":
    // an exec reader needs to know the event union has no delegation
    // kind at all, which is a different fact from acp's "not parsed".
    assert.match(EXEC_CAPABILITIES.subagents.reason, /events\.ts/);
    assert.match(EXEC_CAPABILITIES.subagents.reason, /runner\.ts/);

    assert.equal(EXEC_CAPABILITIES.authCredentials.level, "none");
    assert.equal(ACP_CAPABILITIES.authCredentials.level, "partial");
    assert.match(EXEC_CAPABILITIES.authCredentials.reason, /getAccountStatus/);
  });

  // The reverse one: exec genuinely beats acp here, because per-turn
  // usage is on the wire while the acp protocol carries none. Pinning
  // it keeps a "both transports are partial, merge the reasons" edit
  // from erasing the fact that only one of them has anything under it.
  test("usageStats is partial on BOTH transports, but only exec has usage underneath", () => {
    assert.equal(EXEC_CAPABILITIES.usageStats.level, "partial");
    assert.equal(ACP_CAPABILITIES.usageStats.level, "partial");
    // Same missing list on both — the three per-session projections are
    // absent from each transport for its own reason.
    assert.deepEqual(EXEC_CAPABILITIES.usageStats.missing, ACP_CAPABILITIES.usageStats.missing);
    assert.match(EXEC_CAPABILITIES.usageStats.reason, /STRONGER than acp/);
  });

  // interrupt is `none` for a DIFFERENT reason than acp's, and the
  // difference is exactly the thing a reader would get wrong. acp has a
  // cancel NOTIFICATION it must decline to count; exec has nothing at
  // all, and its process signals are webui's own kill cascade.
  test("interrupt is none because there is no request channel, not because of a notification", () => {
    assert.equal(EXEC_CAPABILITIES.interrupt.level, "none");
    assert.match(EXEC_CAPABILITIES.interrupt.reason, /interface-absent/);
    assert.match(EXEC_CAPABILITIES.interrupt.reason, /run-exec-command\.ts/);
    assert.match(EXEC_CAPABILITIES.interrupt.reason, /kill cascade/);
  });

  // The gate sub-items are the naming contract M4-3 depends on, so this
  // is a value assertion: every name here is one a family actually
  // passes as `subItem`, which is why they are the v2/adapter method
  // names rather than exec-shaped inventions.
  test("sessionCrud enumerates every session verb the gates pass as a subItem", () => {
    const missing = EXEC_CAPABILITIES.sessionCrud.missing;
    for (const subItem of [
      "listSessions",
      "getSession",
      "loadSession",
      "activateSession",
      "deleteSession",
    ]) {
      assert.ok(missing.includes(subItem), `sessionCrud must name the gated sub-item ${subItem}`);
    }
    // Not a method exec has either, so it must NOT be listed — the
    // audit would turn red on a missing item the interface exposes.
    assert.equal(missing.includes("--session"), false);
    assert.equal(missing.includes("--continue"), false);
  });

  test("mcp partial names its four sub-capabilities in kebab-case", () => {
    assert.deepEqual(EXEC_CAPABILITIES.mcp.missing, [
      "mcp-configure",
      "mcp-inspect",
      "mcp-clear",
      "mcp-list",
    ]);
  });

  // toolSkillInvocation is the one key where the transport PRODUCES the
  // events and webui cannot READ them — a fact strong enough that the
  // reason has to carry it, because a reader who only saw "partial,
  // tool_call is present" would conclude the tool surface is consumed.
  test("toolSkillInvocation admits the tool_call events are never consumed", () => {
    assert.equal(EXEC_CAPABILITIES.toolSkillInvocation.level, "partial");
    assert.match(EXEC_CAPABILITIES.toolSkillInvocation.reason, /tool_call/);
    assert.match(EXEC_CAPABILITIES.toolSkillInvocation.reason, /mcode-exec\.js/);
    assert.match(EXEC_CAPABILITIES.toolSkillInvocation.reason, /does not read them/);
    // `consumedEvents` is the machine-checkable half of the same fact,
    // and the suite below proves the two halves agree: the three names
    // webui branches on are not names the wire can emit.
    assert.deepEqual(EXEC_INTERFACE.consumedEvents, ["delta", "message", "exec.result"]);
    for (const type of EXEC_INTERFACE.consumedEvents) {
      assert.equal(
        EXEC_INTERFACE.streamEvents.includes(type),
        false,
        `${type} is consumed but is not an ExecEvent type — the KNOWN DEBT is gone, re-audit the reason`,
      );
    }
    // And the permission half: `ask` is a TUI/ACP policy, so there is no
    // request/reply pair to declare present.
    assert.equal(
      EXEC_CAPABILITIES.toolSkillInvocation.missing.includes("replyPermission"),
      true,
    );
  });

  // The full missing list, as a VALUE. `exec` has no reflectable method
  // surface, so `auditExecCapabilities` cannot police this list the way
  // the runtime audit polices `absent` — which makes pinning it here the
  // only thing standing between a dropped entry and a silently
  // over-optimistic declaration. (The cross-check that every name here is
  // a method a runtime surface really carries lives in
  // capability-snapshot.test.js, which is the only file that can see
  // REQUIRED_METHODS.)
  test("toolSkillInvocation enumerates exactly its five absent sub-items", () => {
    assert.deepEqual(EXEC_CAPABILITIES.toolSkillInvocation.missing, [
      "listSkills",
      "listRuntimeSkills",
      "listPendingPermissions",
      "replyPermission",
      "setMode",
    ]);
    // `setMode` is the one audited on the runtime surfaces, and exec
    // misses it exactly as both of them do — the mode-write gate's
    // sub-item is the same string on all three providers.
    assert.equal(LOCAL_RUNTIME_V2_CAPABILITIES.toolSkillInvocation.missing.includes("setMode"), true);
    assert.equal(ACP_CAPABILITIES.toolSkillInvocation.missing.includes("setMode"), false);
  });

  // B14's rule once more, for the new provider — asserted above in the
  // shared loop, repeated here so a reader of THIS block does not have
  // to know the other file exists.
  test("authCredentials does not list the effort writer as missing", () => {
    assert.equal((EXEC_CAPABILITIES.authCredentials.missing || []).includes("setThinkingEffort"), false);
  });
});

// ---------------------------------------------------------------------------
// THE REVERSE EXCEPTION — turnDiff / plugins are `none` on the acp
// protocol and still served, by the in-process v2 host.
// ---------------------------------------------------------------------------

describe("M4-1 dual-host exception", () => {
  test("the acp provider declares exactly two host-served keys, both `none`", () => {
    assert.deepEqual(summarizeCapabilityHosting(ACP_CAPABILITIES), [
      { key: "turnDiff", servedBy: "local-runtime-v2" },
      { key: "plugins", servedBy: "local-runtime-v2" },
    ]);
  });

  // M4-2: the exec transport carries the SAME two keys, and this is the
  // assertion that makes it a finding rather than a copy. Those two
  // endpoints project the in-process v2 host through
  // `getEngineCatalogueHost()` and gate on no transport, so the reverse
  // exception is a property of the ROUTES and every transport inherits
  // it. If someone later gates `routes/plugins.js` on the active
  // provider, this goes red and says why it must not have.
  test("the exec transport inherits the same two host-served keys", () => {
    assert.deepEqual(summarizeCapabilityHosting(EXEC_CAPABILITIES), [
      { key: "turnDiff", servedBy: "local-runtime-v2" },
      { key: "plugins", servedBy: "local-runtime-v2" },
    ]);
    for (const key of ["turnDiff", "plugins"]) {
      assert.equal(EXEC_CAPABILITIES[key].level, "none");
      assert.equal(resolveCapabilityHostProvider("exec", key), "local-runtime-v2");
    }
  });

  test("exec claims no host on any other key — inheriting the exception is not extending it", () => {
    const hosted = summarizeCapabilityHosting(EXEC_CAPABILITIES).map((h) => h.key);
    assert.deepEqual(hosted, ["turnDiff", "plugins"]);
    for (const key of ENGINE_CAPABILITY_KEYS) {
      if (key === "turnDiff" || key === "plugins") continue;
      assert.equal(
        EXEC_CAPABILITIES[key].servedBy,
        undefined,
        `${key} must not carry servedBy: the exception covers turnDiff and plugins only`,
      );
    }
  });

  // exec has three MORE `none` keys than acp, and none of them is
  // host-served — the provider is honestly absent there and nothing
  // covers for it. This is the assertion that stops "make the two
  // transports look alike" from being done by inventing hosts.
  test("exec's extra none keys are genuinely uncovered, not silently hosted", () => {
    for (const key of ["interrupt", "subagents", "authCredentials"]) {
      assert.equal(EXEC_CAPABILITIES[key].level, "none", `${key} must stay none on exec`);
      assert.equal(resolveCapabilityHostProvider("exec", key), null, `${key} has no host`);
    }
  });

  // THE REGRESSION LINE. Under `MCODE_WEBUI_TRANSPORT=acp` the three
  // /api/turn-diff and ten /api/plugins endpoints have always worked:
  // they project the in-process local-runtime-v2 host through
  // `getEngineCatalogueHost()` and are gated on no provider
  // declaration. The M3 plan records this as its one reverse exception
  // (§6). These four assertions are what "显式保留" means as code —
  // delete the `servedBy` fields, or point them at a provider that does
  // not exist, and this goes red instead of the endpoints quietly
  // 501ing at M4-3.
  test("turnDiff and plugins are honestly none AND name the v2 host that serves them", () => {
    for (const key of ["turnDiff", "plugins"]) {
      assert.equal(ACP_CAPABILITIES[key].level, "none", `${key} must stay none on the protocol`);
      assert.equal(ACP_CAPABILITIES[key].servedBy, "local-runtime-v2");
      assert.equal(resolveCapabilityHostProvider("acp", key), "local-runtime-v2");
    }
  });

  test("no other acp key claims a host — the exception is two keys, not a habit", () => {
    const hosted = summarizeCapabilityHosting(ACP_CAPABILITIES).map((h) => h.key);
    for (const key of ENGINE_CAPABILITY_KEYS) {
      if (key === "turnDiff" || key === "plugins") continue;
      assert.equal(
        ACP_CAPABILITIES[key].servedBy,
        undefined,
        `${key} must not carry servedBy: the exception covers turnDiff and plugins only`,
      );
      assert.equal(hosted.includes(key), false);
    }
  });

  // A hosted key is still `none` AS A PROVIDER, and must stay in the
  // degradation roll-up. Merging the two would have changed the
  // shipped `{none, partial}` response shape for every existing caller
  // — that is why `summarizeCapabilityHosting` is a separate function.
  test("hosted keys stay in the unavailable roll-up — the provider really has none", () => {
    const summary = summarizeUnavailableCapabilities(ACP_CAPABILITIES);
    assert.equal(summary.none.includes("turnDiff"), true);
    assert.equal(summary.none.includes("plugins"), true);
  });

  test("the runtime providers host nothing — the exception is the acp provider's", () => {
    assert.deepEqual(summarizeCapabilityHosting(LOCAL_RUNTIME_V2_CAPABILITIES), []);
    assert.deepEqual(summarizeCapabilityHosting(TUI_RUNTIME_ADAPTER_CAPABILITIES), []);
  });

  test("resolveCapabilityHostProvider returns null for a key the provider serves itself", () => {
    // `null` covers "serves it itself" and "not declared hosted" alike:
    // the question is "who else answers this", and for sessionCrud or
    // streamingSend nobody does.
    assert.equal(resolveCapabilityHostProvider("acp", "sessionCrud"), null);
    assert.equal(resolveCapabilityHostProvider("acp", "streamingSend"), null);
    assert.equal(resolveCapabilityHostProvider("local-runtime-v2", "turnDiff"), null);
  });

  // The two providers must not point at each other in a cycle. A
  // cycle would be a declaration that is self-consistent and
  // operationally meaningless, and no per-key check above would see
  // it.
  test("hosted keys resolve to a provider that itself hosts nothing back", () => {
    for (const { key, servedBy } of summarizeCapabilityHosting(ACP_CAPABILITIES)) {
      const host = getEngineProvider(servedBy);
      assert.equal(host.capabilities[key].level, "full", `${servedBy}.${key} must be able to serve it`);
      assert.equal(
        resolveCapabilityHostProvider(servedBy, key),
        null,
        `${servedBy}.${key} hosting back would be a cycle`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// servedBy — the contract rule, and the boot-time cross-check
// ---------------------------------------------------------------------------

describe("servedBy contract", () => {
  const base = () =>
    Object.fromEntries(ENGINE_CAPABILITY_KEYS.map((k) => [k, { level: "full" }]));

  test("none may carry servedBy", () => {
    const decl = base();
    decl.updateCheck = { level: "none", reason: "interface-absent", servedBy: "local-runtime-v2" };
    assert.deepEqual(validateEngineCapabilities(decl), []);
  });

  test("full carrying servedBy is rejected — it serves the capability itself", () => {
    const decl = base();
    decl.sessionCrud = { level: "full", servedBy: "local-runtime-v2" };
    assert.deepEqual(validateEngineCapabilities(decl), [
      "sessionCrud: full must not carry servedBy — the provider serves it itself",
    ]);
  });

  test("partial carrying servedBy is rejected — name the gap in `missing` instead", () => {
    const decl = base();
    decl.plugins = {
      level: "partial",
      missing: ["importGithubPlugin"],
      reason: "surface lacks the GitHub import pair",
      servedBy: "local-runtime-v2",
    };
    assert.deepEqual(validateEngineCapabilities(decl), [
      "plugins: partial must not carry servedBy — it serves the capability itself; name the absent sub-items in `missing`",
    ]);
  });

  test("an empty servedBy is rejected — the field names a provider or it is absent", () => {
    const decl = base();
    decl.updateCheck = { level: "none", reason: "interface-absent", servedBy: "" };
    assert.deepEqual(validateEngineCapabilities(decl), [
      "updateCheck: servedBy must name a provider id",
    ]);
  });

  // The shape check above cannot know the registry, so engine/index.js
  // checks at import. This proves the real declaration would survive
  // that check — and, by naming a typo, shows what the boot-time guard
  // exists for.
  test("a servedBy naming an unregistered provider fails the registry cross-check", () => {
    const decl = base();
    decl.updateCheck = { level: "none", reason: "interface-absent", servedBy: "local-runtime-v3" };
    assert.deepEqual(validateEngineCapabilities(decl), [], "the shape rule alone cannot catch this");
    // What engine/index.js does at import, reproduced over the same
    // data so the guard is pinned as a test and not only as prose.
    const known = new Set(listEngineProviderIds());
    assert.equal(known.has(decl.updateCheck.servedBy), false);
    assert.equal(known.has("local-runtime-v2"), true);
  });
});

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

describe("engine facade", () => {
  // M4-1 changed this from "the two currently-wired providers". The
  // word "wired" was doing the load-bearing work: acp is REGISTERED
  // and NOT yet wired, which is the batch's compatibility guarantee.
  // M4-2 added the exec transport to the same side of that line.
  test("registers the two runtime providers plus the two transport providers", () => {
    assert.deepEqual(listEngineProviderIds().sort(), [
      "acp",
      "exec",
      "local-runtime-v2",
      "tui-runtime-adapter",
    ]);
  });

  test("the exec entry is reachable and carries its own transport", () => {
    const provider = getEngineProvider("exec");
    assert.equal(provider.transport, "exec");
    assert.equal(provider.capabilities, EXEC_CAPABILITIES);
  });

  // The transport string is not decoration: M4-3's gates look providers
  // up BY transport, so a registered provider whose `transport` is not
  // one of the values `lib/config.js:224` accepts could never be
  // resolved by anything. The set is restated rather than imported
  // because importing lib/config.js into this file would evaluate its
  // module-scope transport resolution for a test that asserts nothing
  // about it — the two files agreeing is the thing being checked, so one
  // of them has to be a literal.
  test("every registered provider names a legal MCODE_WEBUI_TRANSPORT value", () => {
    const legal = new Set(["acp", "exec", "runtime"]);
    for (const id of listEngineProviderIds()) {
      assert.ok(legal.has(getEngineProvider(id).transport), `${id} names an illegal transport`);
    }
    // And the two transports each have exactly one provider, so M4-3 has
    // no ambiguity to resolve.
    const byTransport = {};
    for (const id of listEngineProviderIds()) {
      const { transport } = getEngineProvider(id);
      byTransport[transport] = (byTransport[transport] || 0) + 1;
    }
    assert.equal(byTransport.acp, 1);
    assert.equal(byTransport.exec, 1);
    assert.equal(byTransport.runtime, 2);
  });

  // THE COMPATIBILITY PIN, side one: the DEFAULT provider is still the
  // v2 host, so `?provider=` with no argument — every existing caller,
  // including the webapp's own degradation test — keeps seeing exactly
  // the declaration it saw before M4-1. Changing this line is the
  // regression the plan's compatibility clause forbids.
  test("the default provider is still local-runtime-v2, not the transport's", () => {
    assert.equal(getEngineProvider().id, "local-runtime-v2");
    assert.equal(getEngineProvider(undefined).transport, "runtime");
  });
  // THE COMPATIBILITY PIN, side two: registering acp must not have
  // made any existing gate fire. Every M3 family resolves its provider
  // through a transport→provider table that lists only `runtime`, so
  // `acp` — the default transport — still resolves to `null` and every
  // gate no-ops. M4-3 is what closes this gap; this test is what says
  // so out loud, and it fails the moment a table grows an `acp` entry
  // without the re-audit M4-3 owes.
  const RESOLVERS = {
    "session-reads": engineFacade.resolveSessionReadProvider,
    "session-tree-reads": engineFacade.resolveSessionTreeProvider,
    "session-export": engineFacade.resolveSessionExportProvider,
    "account-reads": engineFacade.resolveAccountReadProvider,
    "capability-reads": engineFacade.resolveCapabilityReadProvider,
    "usage-reads": engineFacade.resolveUsageReadProvider,
    "session-writes": engineFacade.resolveSessionWriteProvider,
    "session-switch": engineFacade.resolveSessionSwitchProvider,
    interrupt: engineFacade.resolveInterruptProvider,
    "session-load": engineFacade.resolveSessionLoadProvider,
    "mode-writes": engineFacade.resolveModeWriteProvider,
    "streaming-send": engineFacade.resolveStreamingSendProvider,
    "model-writes": resolveModelWriteProvider,
    "model-reads": resolveModelReadProvider,
    "provider-reads": resolveProviderReadProvider,
    "provider-writes": resolveProviderWriteProvider,
  };

  // `capability-reads.js` is the one family that wraps its answer in
  // `{provider, providerFor}` — it has to report WHICH resolution it
  // used, because its endpoint serves a different view when the
  // transport names a provider. Unwrap it rather than special-casing
  // the assertion: the question both sweeps ask is the same one.
  const unwrap = (answer) => (answer && answer.provider ? answer.provider : answer);

  // `capability-reads.js` is the one family that already reads the
  // registry rather than resolving to nothing: on a transport with no
  // registered provider it falls back to the DEFAULT one and reports
  // `providerFor: "default"` (capability-reads.js:112-116). So the
  // claim for an UNWIRED transport is not "null" but "the default v2
  // provider, and never the transport's own" — which is the shape both
  // M4-1 and M4-2 must leave exactly as they found it.
  const isCapabilityReads = (family) => family === "capability-reads";

  // One sweep, two transports. acp and exec are registered and NOT
  // wired, and they are pinned by the SAME test on purpose: the claim
  // "registering a provider changes no routing" is a property of the
  // registry, not a favour extended to one transport. A second copy of
  // this loop could drift; a parameter cannot.
  for (const transport of ["acp", "exec"]) {
    for (const [family, fn] of Object.entries(RESOLVERS)) {
      test(`${family}: the ${transport} transport does NOT resolve to the ${transport} provider`, () => {
        assert.equal(typeof fn, "function", `${family}'s resolver must exist`);
        const answer = fn(transport);
        if (isCapabilityReads(family)) {
          assert.equal(unwrap(answer).id, "local-runtime-v2");
          assert.equal(answer.providerFor, "default");
          return;
        }
        assert.equal(
          unwrap(answer),
          null,
          `${family} resolving the ${transport} provider changes every gate's verdict — that is M4-3's change, ` +
            `and it must not arrive as a side effect of a registration`,
        );
      });
    }
  }

  // The same sweep on the transport that IS wired, so the test proves
  // the null above is a property of the acp entry's absence and not of
  // a sweep that passes because every resolver returns null.
  for (const [family, fn] of Object.entries(RESOLVERS)) {
    test(`${family}: the runtime transport still resolves to the v2 provider`, () => {
      const provider = unwrap(fn("runtime"));
      assert.ok(provider, `${family} must still resolve on the runtime transport`);
      assert.equal(provider.id, "local-runtime-v2");
    });
  }

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
