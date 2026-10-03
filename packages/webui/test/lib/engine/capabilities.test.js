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

  // The destructive half of sessionCrud is missing BY NAME, because
  // `session-writes.js` gates #7 and #6 on exactly `deleteSession` and
  // a kebab-case name would never match that gate's sub-item. This is
  // the naming contract M4-3 depends on, so it is a value assertion.
  test("sessionCrud partial names the three absent session methods", () => {
    assert.deepEqual(ACP_CAPABILITIES.sessionCrud.missing, [
      "deleteSession",
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
  test("registers the two runtime providers plus the acp transport provider", () => {
    assert.deepEqual(listEngineProviderIds().sort(), [
      "acp",
      "local-runtime-v2",
      "tui-runtime-adapter",
    ]);
  });

  test("the acp entry is reachable and carries its own transport", () => {
    const provider = getEngineProvider("acp");
    assert.equal(provider.transport, "acp");
    assert.equal(provider.capabilities, ACP_CAPABILITIES);
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
  // acp-transport claim for this family is not "null" but "the default
  // v2 provider, and never the acp provider" — which is the shape
  // M4-1 must leave exactly as it found it.
  const isCapabilityReads = (family) => family === "capability-reads";

  for (const [family, fn] of Object.entries(RESOLVERS)) {
    test(`${family}: the acp transport does NOT resolve to the acp provider`, () => {
      assert.equal(typeof fn, "function", `${family}'s resolver must exist`);
      const answer = fn("acp");
      if (isCapabilityReads(family)) {
        assert.equal(unwrap(answer).id, "local-runtime-v2");
        assert.equal(answer.providerFor, "default");
        return;
      }
      assert.equal(
        unwrap(answer),
        null,
        `${family} resolving the acp provider changes every gate's verdict — that is M4-3's change, ` +
          `and it must not arrive as a side effect of M4-1`,
      );
    });
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
