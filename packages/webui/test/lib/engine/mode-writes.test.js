// webui/test/lib/engine/mode-writes.test.js
//
// M3-B9 — the SESSION MODE WRITE family (#67 set-mode, #68
// set-config-option).
//
// This is the first M3 family whose gate changes what a client sees, so
// this file is organised around the batch's own boundary rather than
// around the code: every case names which side of it it is on.
//
//   THE OLD STATE — a provider that DECLARES the capability. Status,
//   body and ordering are asserted as values, including the rows no
//   fixture reaches (the 502/500 asymmetry, the `fallback` hint, the
//   `client_throw` fold). If any of these move, this batch broke its
//   promise.
//
//   THE NEW STATE — a provider that DOES NOT. The gate throws
//   EngineCapabilityNotSupportedError, `app.js` maps it to 501, and
//   the body is the shared one from `errors.js`. The bridge is the
//   other half of the new state: `model` and `permissionMode` must
//   still pass a provider that denies the generic write, or "the two
//   common ids bridge" would be a claim with nothing behind it.
//
// The provider fixtures are SYNTHETIC on purpose. Both registered
// providers declare `toolSkillInvocation` and `authCredentials` as
// `partial` with exactly the sub-items B9 needs (the real declarations,
// audited by capability-snapshot.test.js), so a real-registry test can
// reach the refusals — but not the "capability exists" half of #68, and
// not a `none`. Mocking `engine/index.js` for the whole namespace is
// what makes the `none` case reachable at all.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { setupMocks, absPath, registerRpcMock } from "../../helpers/_setup.js";
// Type discrimination goes through the exported predicate, never
// `err.name`: `name` is a writable instance property, so one stray
// upstream assignment would turn a 501 back into a soft failure — a
// failure mode that reads as a passing test.
const { isEngineCapabilityNotSupportedError, engineCapabilityHttpResponse } = await import(
  "../../../server/engine/errors.js"
);

const RUNTIME = "runtime";
const ACP = "acp";

const SET_MODE = "POST /api/protocol/set-mode";
const SET_CONFIG_OPTION = "POST /api/protocol/set-config-option";

/** Every name `engine/mode-writes.js` exports. The namespace, not a subset. */
const FACADE_EXPORTS = [
  "MODE_WRITE_BRIDGED_CONFIG_IDS",
  "MODE_WRITE_ENDPOINTS",
  "assertModeWriteCapability",
  "resolveModeWriteProvider",
  "resolveModeWriteSubItem",
  "setConfigOptionFailureStatus",
  "setEngineSessionConfigOption",
  "setEngineSessionMode",
  "setModeFailureStatus",
];

let bust = 0;

/** The real declaration, read from the source so the sweep cannot drift. */
function exportedNamesOf(relative) {
  const fileUrl = absPath(relative);
  const src = readFileSync(fileURLToPath(fileUrl), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return { fileUrl, names: [...names].sort() };
}

// ---------------------------------------------------------------------------
// Provider fixtures. Each is a PARTIAL declaration: the audit in
// `test/lib/engine/capability-snapshot.test.js` is what keeps the real
// ones honest, and a fixture only has to be good enough to reach a
// branch.
// ---------------------------------------------------------------------------

/** Declares both B9 capabilities in full — the "old state" provider. */
const FULL_BOTH = {
  toolSkillInvocation: { level: "full" },
  authCredentials: { level: "full" },
};

/**
 * The real v2 shape, and the one the bridge exists for: the generic
 * config-option write is denied, the two dedicated ones are not listed
 * so they pass.
 */
const NO_GENERIC_CONFIG_WRITE = {
  toolSkillInvocation: { level: "partial", missing: ["setMode"], reason: "test: no mode write" },
  authCredentials: { level: "partial", missing: ["setConfigOption"], reason: "test: no generic config write" },
};

/** Neither capability at all. */
const NEITHER = {
  toolSkillInvocation: { level: "none", reason: "test: interface-absent" },
  authCredentials: { level: "none", reason: "test: interface-absent" },
};

/**
 * Boot the facade against a synthetic provider.
 *
 * `engine/index.js` is mocked for its WHOLE namespace (every name not
 * explicitly provided throws), because a whole-namespace mock is what
 * catches a new top-level read of this module in mode-writes.js — the
 * temporal-dead-zone rule its header states. `mode-writes.js` is then
 * imported FRESH so it picks the mock up as its live binding.
 */
async function bootFacadeWithProvider(t, capabilities) {
  await setupMocks(t, {});
  const { names } = exportedNamesOf("engine/index.js");
  const namedExports = {};
  for (const name of names) {
    namedExports[name] = () => {
      throw new Error(`B9 test called engine/index.js#${name}, which this case did not stub`);
    };
  }
  Object.assign(namedExports, {
    DEFAULT_ENGINE_PROVIDER_ID: "local-runtime-v2",
    getEngineProvider: (id = "local-runtime-v2") => ({
      id,
      transport: "runtime",
      capabilities,
    }),
  });
  t.mock.module(absPath("engine/index.js"), { namedExports });
  return import(`${absPath("engine/mode-writes.js")}?provider=${bust++}`);
}

/** Boot against the REAL registry — no mock of engine/index.js at all. */
async function bootFacade(t) {
  await setupMocks(t, {});
  return import(`${absPath("engine/mode-writes.js")}?provider=${bust++}`);
}

/** Run `fn`, returning the thrown value or `null`. */
async function caughtBy(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

beforeEach(() => {
  registerRpcMock({
    setMode: async () => ({ ok: true, data: { modeId: "plan" } }),
    setConfigOption: async () => ({ ok: true, data: {} }),
  });
});

// ---------------------------------------------------------------------------
// The export surface
// ---------------------------------------------------------------------------

describe("mode-writes facade — export surface", () => {
  test("exports exactly the names the facade re-exports, no more and no fewer", async () => {
    const module = await import(absPath("engine/mode-writes.js"));
    const actual = Object.keys(module)
      .filter((k) => k !== "default")
      .sort();
    assert.deepEqual(actual, FACADE_EXPORTS);
  });

  test("the name list is derived from the SOURCE, so a new export cannot slip past the sweep", async () => {
    const { names } = exportedNamesOf("engine/mode-writes.js");
    assert.deepEqual(names, FACADE_EXPORTS);
  });

  test("engine/index.js re-exports every one of them", async () => {
    const src = readFileSync(fileURLToPath(absPath("engine/index.js")), "utf8");
    const from = 'from "./mode-writes.js";';
    assert.equal(src.split(from).length - 1, 1, "mode-writes.js must be re-exported exactly once");
    // The `export {` that belongs to THIS from-clause is the last one
    // before it; an earlier match would be a different family's block.
    const start = src.lastIndexOf("export {", src.indexOf(from));
    assert.ok(start > 0, "the re-export block was not found");
    const exported = src
      .slice(src.indexOf("{", start) + 1, src.indexOf("}", start))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(exported, FACADE_EXPORTS);
  });
});

// ---------------------------------------------------------------------------
// The declarations
// ---------------------------------------------------------------------------

describe("MODE_WRITE_ENDPOINTS", () => {
  test("both endpoints gate HARD, on the two capabilities the plan names", async () => {
    const { MODE_WRITE_ENDPOINTS } = await bootFacade(t0());
    assert.deepEqual(MODE_WRITE_ENDPOINTS, {
      [SET_MODE]: { capability: "toolSkillInvocation", subItem: "setMode", enforcement: "hard" },
      [SET_CONFIG_OPTION]: { capability: "authCredentials", subItem: "setConfigOption", enforcement: "hard" },
    });
    for (const entry of Object.values(MODE_WRITE_ENDPOINTS)) {
      assert.equal(Object.isFrozen(entry), true, "each entry must be frozen");
    }
  });

  test("the real registry declares BOTH capabilities as partial, naming exactly the B9 sub-items", async () => {
    // This is the case the whole batch rests on: the refusals are
    // reachable through the real registry, not only through a mock. The
    // `missing` lists are pinned as values because a second entry in
    // either one would silently widen or narrow the bridge.
    const { getEngineProvider } = await import(absPath("engine/index.js"));
    for (const id of ["local-runtime-v2", "tui-runtime-adapter"]) {
      const { capabilities } = getEngineProvider(id);
      assert.deepEqual(capabilities.toolSkillInvocation.missing, ["setMode"], id);
      assert.deepEqual(capabilities.authCredentials.missing, ["setConfigOption"], id);
    }
  });
});

describe("resolveModeWriteSubItem — the bridge", () => {
  test("#67 asks for `setMode` whatever else it is told", async () => {
    const facade = await bootFacade(t0());
    for (const configId of [undefined, "model", "permissionMode", "anything"]) {
      assert.equal(facade.resolveModeWriteSubItem(SET_MODE, configId), "setMode", String(configId));
    }
  });

  test("#68 asks for the dedicated sub-item for the three bridged ids", async () => {
    const facade = await bootFacade(t0());
    assert.equal(facade.resolveModeWriteSubItem(SET_CONFIG_OPTION, "model"), "selectModel");
    assert.equal(facade.resolveModeWriteSubItem(SET_CONFIG_OPTION, "permissionMode"), "setPermissionMode");
    // M3-B14. Before this, `thinkingEffort` was the FIRST entry in the
    // list below — it was the worked example of a generic id, because at
    // that time there was no dedicated effort writer to bridge to.
    assert.equal(facade.resolveModeWriteSubItem(SET_CONFIG_OPTION, "thinkingEffort"), "setThinkingEffort");
  });

  test("#68 asks for the GENERIC sub-item for every other id, including nonsense", async () => {
    // The safe direction: a config id nobody audited must NOT inherit
    // the exemption reserved for the three that were.
    const facade = await bootFacade(t0());
    for (const key of ["contextWindow", "model_", "Model", "", undefined, null, 0, "constructor", "__proto__"]) {
      assert.equal(
        facade.resolveModeWriteSubItem(SET_CONFIG_OPTION, key),
        "setConfigOption",
        `configId ${JSON.stringify(key)}`,
      );
    }
  });

  test("an inherited property is not a bridge — `toString` and `__proto__` are not config ids", async () => {
    const facade = await bootFacade(t0());
    // A plain object literal inherits `Object.prototype`, so
    // `MODE_WRITE_BRIDGED_CONFIG_IDS["toString"]` IS a function. The
    // `typeof === "string"` guard in `resolveModeWriteSubItem` is the
    // only thing standing between that and a sub-item name of
    // "[Function: toString]", so the guard is pinned from both sides.
    assert.equal(typeof facade.MODE_WRITE_BRIDGED_CONFIG_IDS.toString, "function");
    for (const key of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      assert.equal(
        facade.resolveModeWriteSubItem(SET_CONFIG_OPTION, key),
        "setConfigOption",
        key,
      );
    }
  });

  test("an unknown endpoint key is a plain Error, never a capability error", async () => {
    const facade = await bootFacade(t0());
    const caught = await caughtBy(() => facade.resolveModeWriteSubItem("POST /api/nope"));
    assert.ok(caught);
    assert.equal(isEngineCapabilityNotSupportedError(caught), false);
    assert.equal(caught.code, "unknown_mode_write_endpoint");
  });
});

// ---------------------------------------------------------------------------
// The hard gate
// ---------------------------------------------------------------------------

describe("assertModeWriteCapability — HARD", () => {
  test("reports `unregistered-transport` on acp and never throws: the pre-B9 behaviour", async (t) => {
    const facade = await bootFacade(t);
    // THE MOST IMPORTANT SINGLE CASE IN THIS FILE. `acp` is the default
    // transport and no provider claims it until M4, so every shipped
    // user is on this branch and every response they can receive is the
    // one they received before this batch.
    for (const endpoint of [SET_MODE, SET_CONFIG_OPTION]) {
      const d = facade.assertModeWriteCapability(endpoint, ACP);
      assert.equal(d.gate, "unregistered-transport", endpoint);
      assert.equal(d.provider, null, endpoint);
      assert.equal(d.enforcement, "hard", endpoint);
    }
  });

  test("a full declaration passes and reports `checked`", async (t) => {
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    const d = facade.assertModeWriteCapability(SET_MODE, RUNTIME);
    assert.equal(d.gate, "checked");
    assert.equal(d.provider, "local-runtime-v2");
    assert.equal(d.subItem, "setMode");
  });

  test("a `none` declaration throws the STRUCTURED error for both endpoints", async (t) => {
    const facade = await bootFacadeWithProvider(t, NEITHER);
    for (const [endpoint, capability] of [
      [SET_MODE, "toolSkillInvocation"],
      [SET_CONFIG_OPTION, "authCredentials"],
    ]) {
      const caught = await caughtBy(() => facade.assertModeWriteCapability(endpoint, RUNTIME));
      assert.ok(isEngineCapabilityNotSupportedError(caught), endpoint);
      assert.equal(caught.capability, capability, endpoint);
      assert.equal(caught.provider, "local-runtime-v2", endpoint);
    }
  });

  test("a `partial` throws ONLY for the sub-item it actually denies", async (t) => {
    const facade = await bootFacadeWithProvider(t, NO_GENERIC_CONFIG_WRITE);
    // #67's sub-item is denied.
    const denied = await caughtBy(() => facade.assertModeWriteCapability(SET_MODE, RUNTIME));
    assert.ok(isEngineCapabilityNotSupportedError(denied));
    assert.equal(denied.capability, "toolSkillInvocation");
    // The two bridged ids are not, so they pass.
    for (const configId of ["model", "permissionMode"]) {
      const d = facade.assertModeWriteCapability(SET_CONFIG_OPTION, RUNTIME, configId);
      assert.equal(d.gate, "checked", configId);
    }
    // A generic id is. `contextWindow` is the honest example now that
    // `thinkingEffort` is bridged: the engine has no channel for it
    // either, and no bridge claims one.
    const generic = await caughtBy(() =>
      facade.assertModeWriteCapability(SET_CONFIG_OPTION, RUNTIME, "contextWindow"),
    );
    assert.ok(isEngineCapabilityNotSupportedError(generic));
    assert.equal(generic.capability, "authCredentials");
    assert.deepEqual(generic.missing, ["setConfigOption"]);
  });

  test("#68's verdict depends on the config id, and on nothing else", async (t) => {
    // The gate is the one place where a request field decides a status.
    // Pinning both directions on the SAME provider is what stops a
    // future refactor from making the bridge depend on the session, the
    // transport, the value, or the order of two calls.
    const facade = await bootFacadeWithProvider(t, NO_GENERIC_CONFIG_WRITE);
    assert.equal(facade.assertModeWriteCapability(SET_CONFIG_OPTION, RUNTIME, "model").gate, "checked");
    assert.equal(
      facade.assertModeWriteCapability(SET_CONFIG_OPTION, RUNTIME, "permissionMode").gate,
      "checked",
    );
    const caught = await caughtBy(() => facade.assertModeWriteCapability(SET_CONFIG_OPTION, RUNTIME, "other"));
    assert.ok(isEngineCapabilityNotSupportedError(caught));
    // A second call with the same bridged id still passes: no caching,
    // no order dependence, no state.
    assert.equal(facade.assertModeWriteCapability(SET_CONFIG_OPTION, RUNTIME, "model").gate, "checked");
  });

  test("an unknown endpoint key is a plain Error with a machine-readable code", async (t) => {
    const facade = await bootFacadeWithProvider(t, NEITHER);
    const caught = await caughtBy(() => facade.assertModeWriteCapability("POST /api/nope", RUNTIME));
    assert.ok(caught);
    assert.equal(isEngineCapabilityNotSupportedError(caught), false);
    assert.equal(caught.code, "unknown_mode_write_endpoint");
  });
});

describe("resolveModeWriteProvider", () => {
  test("null on a transport no provider claims, an object on one that does", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.resolveModeWriteProvider(ACP), null);
    const p = facade.resolveModeWriteProvider(RUNTIME);
    assert.equal(p.id, "local-runtime-v2");
    assert.equal(p.transport, "runtime");
  });

  test("null for a transport that does not exist at all", async (t) => {
    const facade = await bootFacade(t);
    assert.equal(facade.resolveModeWriteProvider("exec"), null);
    assert.equal(facade.resolveModeWriteProvider(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// The status tables — THE OLD STATE, pinned as values
// ---------------------------------------------------------------------------

describe("the two failure-status tables keep their pre-B9 rows", () => {
  // Every row, including the ones no fixture reaches. The last row is
  // the asymmetry this file exists partly to protect: #67 has always
  // answered 502 for a code it cannot classify and #68 has always
  // answered 500. Unifying them would change one endpoint's wire to
  // match the other's, which is not a migration step.
  const CASES = [
    ["unsupported", 501, 501],
    ["no_client", 503, 503],
    ["resource_not_found", 404, 404],
    ["session not found", 404, 404],
    ["invalidParams", 404, 404],
    ["policy_violation", 409, 409],
    ["conflict", 409, 409],
    ["client_throw", 502, 500],
    ["some_unmapped_code", 502, 500],
    [undefined, 502, 500],
    ["", 502, 500],
  ];

  test("setModeFailureStatus / setConfigOptionFailureStatus over every row", async (t) => {
    const facade = await bootFacade(t);
    for (const [code, modeStatus, configStatus] of CASES) {
      assert.equal(facade.setModeFailureStatus(code), modeStatus, `set-mode ${code}`);
      assert.equal(
        facade.setConfigOptionFailureStatus(code),
        configStatus,
        `set-config-option ${code}`,
      );
    }
  });

  test("the two tables differ ONLY on the default row", async (t) => {
    const facade = await bootFacade(t);
    for (const [code] of CASES) {
      const same = facade.setModeFailureStatus(code) === facade.setConfigOptionFailureStatus(code);
      const isDefaultRow = code !== "unsupported" && code !== "no_client" && !(code && /not.found|invalid/i.test(code)) && !(code && /conflict|policy/i.test(code));
      assert.equal(same, !isDefaultRow, `code ${code}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Data plane — the old state
// ---------------------------------------------------------------------------

describe("setEngineSessionMode — capability PRESENT, byte-for-byte unchanged", () => {
  test("a success echoes the request's mode and the engine's data", async (t) => {
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    const r = await facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan", transport: RUNTIME });
    assert.equal(r.statusHint, 200);
    assert.deepEqual(r.payload, { ok: true, mode: "plan", data: { modeId: "plan" } });
    assert.equal(r.gate.gate, "checked");
  });

  test("the success body is the same whatever mode was asked for", async (t) => {
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    for (const mode of ["plan", "plan_mode", "default", "normal", "goal_mode"]) {
      const r = await facade.setEngineSessionMode({ sessionId: "mvs_a", mode, transport: RUNTIME });
      assert.deepEqual(r.payload, { ok: true, mode, data: { modeId: "plan" } }, mode);
    }
  });

  test("an engine refusal keeps `fallback: send_plan_as_prompt` on the 501", async (t) => {
    registerRpcMock({ setMode: async () => ({ ok: false, code: "unsupported", error: "no" }) });
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    const r = await facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan", transport: RUNTIME });
    assert.equal(r.statusHint, 501);
    assert.deepEqual(r.payload, {
      ok: false,
      error: "no",
      code: "unsupported",
      fallback: "send_plan_as_prompt",
    });
  });

  test("a client throw is folded into `client_throw`, not escaped", async (t) => {
    registerRpcMock({
      setMode: async () => {
        throw new Error("socket gone");
      },
    });
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    const r = await facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan", transport: RUNTIME });
    assert.equal(r.statusHint, 502);
    assert.equal(r.payload.code, "client_throw");
    assert.equal(r.payload.error, "socket gone");
    assert.equal(r.payload.fallback, "send_plan_as_prompt");
  });

  test("a non-Error throw still produces a string `error`", async (t) => {
    registerRpcMock({
      setMode: async () => {
        throw "plain string";
      },
    });
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    const r = await facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan", transport: RUNTIME });
    assert.equal(r.payload.error, "plain string");
    assert.equal(r.payload.code, "client_throw");
  });
});

describe("setEngineSessionConfigOption — capability PRESENT, byte-for-byte unchanged", () => {
  test("a success echoes key and value and the engine's data", async (t) => {
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    const r = await facade.setEngineSessionConfigOption({
      sessionId: "mvs_a",
      key: "permissionMode",
      value: "auto",
      cid: "cid-1",
      transport: RUNTIME,
    });
    assert.equal(r.statusHint, 200);
    assert.deepEqual(r.payload, { ok: true, key: "permissionMode", value: "auto", data: {} });
  });

  test("an engine refusal carries NO `fallback` — #68 never had one", async (t) => {
    registerRpcMock({ setConfigOption: async () => ({ ok: false, code: "unsupported", error: "no" }) });
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    const r = await facade.setEngineSessionConfigOption({
      sessionId: "mvs_a",
      key: "permissionMode",
      value: "auto",
      transport: RUNTIME,
    });
    assert.equal(r.statusHint, 501);
    assert.deepEqual(r.payload, { ok: false, error: "no", code: "unsupported" });
    assert.equal("fallback" in r.payload, false);
  });

  test("a client throw is NOT caught: #68 never had a try/catch and still has none", async (t) => {
    // Deliberate asymmetry with #67, pinned so a future "let's make them
    // consistent" change has to be a decision rather than a tidy-up.
    registerRpcMock({
      setConfigOption: async () => {
        throw new Error("socket gone");
      },
    });
    const facade = await bootFacadeWithProvider(t, FULL_BOTH);
    const caught = await caughtBy(() =>
      facade.setEngineSessionConfigOption({ sessionId: "mvs_a", key: "x", value: "y", transport: RUNTIME }),
    );
    assert.ok(caught, "a throwing transport must propagate out of #68");
    assert.equal(caught.message, "socket gone");
  });
});

// ---------------------------------------------------------------------------
// Data plane — the NEW state
// ---------------------------------------------------------------------------

describe("setEngineSessionMode — capability ABSENT", () => {
  test("the gate throws; the router's shared mapping is what answers 501", async (t) => {
    const facade = await bootFacadeWithProvider(t, NO_GENERIC_CONFIG_WRITE);
    const caught = await caughtBy(() =>
      facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan", transport: RUNTIME }),
    );
    assert.ok(isEngineCapabilityNotSupportedError(caught));
    // The body the client will see, computed from the very function
    // app.js calls. Asserting it here means the route never has to know
    // the shape — and if the shape moves, this moves with it.
    const { status, payload } = engineCapabilityHttpResponse(caught);
    assert.equal(status, 501);
    assert.equal(payload.code, "engine_capability_not_supported");
    assert.equal(payload.capability, "toolSkillInvocation");
    assert.equal(payload.provider, "local-runtime-v2");
    assert.deepEqual(payload.missing, ["setMode"]);
    assert.equal("fallback" in payload, false, "the capability 501 must not advertise a degraded action");
  });

  test("the engine is never called when the gate refuses", async (t) => {
    let called = 0;
    registerRpcMock({
      setMode: async () => {
        called += 1;
        return { ok: true, data: {} };
      },
    });
    const facade = await bootFacadeWithProvider(t, NO_GENERIC_CONFIG_WRITE);
    await caughtBy(() => facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan", transport: RUNTIME }));
    assert.equal(called, 0, "a refused write must not reach the engine — a late success would be the fake-success failure");
  });

  test("the real registry refuses #67 on the runtime transport today", async (t) => {
    // No mock: this is the behaviour change this batch actually ships,
    // reachable through the real provider declarations.
    const facade = await bootFacade(t);
    const caught = await caughtBy(() =>
      facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan", transport: RUNTIME }),
    );
    assert.ok(isEngineCapabilityNotSupportedError(caught), "v2 declares no session-mode write");
    assert.equal(caught.provider, "local-runtime-v2");
  });

  test("and does NOT refuse it on the default acp transport", async (t) => {
    const facade = await bootFacade(t);
    const r = await facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan", transport: ACP });
    assert.equal(r.statusHint, 200, "no provider claims acp, so acp keeps the pre-B9 behaviour");
    assert.equal(r.gate.gate, "unregistered-transport");
  });
});

describe("setEngineSessionConfigOption — capability ABSENT, and the bridge", () => {
  test("a generic config id is refused, structured, with no `fallback`", async (t) => {
    // `contextWindow` since M3-B14: `thinkingEffort` used to be this
    // test's worked example of a generic id, and it is now a bridged one.
    const facade = await bootFacadeWithProvider(t, NO_GENERIC_CONFIG_WRITE);
    const caught = await caughtBy(() =>
      facade.setEngineSessionConfigOption({
        sessionId: "mvs_a",
        key: "contextWindow",
        value: "128000",
        transport: RUNTIME,
      }),
    );
    assert.ok(isEngineCapabilityNotSupportedError(caught));
    const { status, payload } = engineCapabilityHttpResponse(caught);
    assert.equal(status, 501);
    assert.equal(payload.capability, "authCredentials");
    assert.deepEqual(payload.missing, ["setConfigOption"]);
  });

  test("ALL THREE bridged ids still reach the engine", async (t) => {
    const seen = [];
    registerRpcMock({
      setConfigOption: async (sessionId, key, value, cid) => {
        seen.push({ sessionId, key, value, cid });
        return { ok: true, data: { applied: true } };
      },
    });
    const facade = await bootFacadeWithProvider(t, NO_GENERIC_CONFIG_WRITE);
    const BRIDGED = [
      ["model", "gpt-x", "selectModel"],
      ["permissionMode", "auto", "setPermissionMode"],
      ["thinkingEffort", "high", "setThinkingEffort"],
    ];
    for (const [key, value, subItem] of BRIDGED) {
      const r = await facade.setEngineSessionConfigOption({
        sessionId: "mvs_a",
        key,
        value,
        cid: "cid-1",
        transport: RUNTIME,
      });
      assert.equal(r.statusHint, 200, key);
      assert.equal(r.gate.subItem, subItem, key);
    }
    assert.deepEqual(seen, [
      { sessionId: "mvs_a", key: "model", value: "gpt-x", cid: "cid-1" },
      { sessionId: "mvs_a", key: "permissionMode", value: "auto", cid: "cid-1" },
      { sessionId: "mvs_a", key: "thinkingEffort", value: "high", cid: "cid-1" },
    ]);
  });

  test("M3-B14 BEHAVIOUR CHANGE — #68 with `thinkingEffort` is DELIVERED, not 501", async (t) => {
    // The one thing this batch changes for #68, stated as a test rather
    // than left to a KNOWN DEBT paragraph. Under B9 the same call
    // answered 501 with `missing: ["setConfigOption"]`; it now asks for
    // the dedicated effort writer and goes through. The gate's own report
    // is asserted too, so the change is visible as a fact about WHICH
    // sub-item was asked for and not only as a status.
    const seen = [];
    registerRpcMock({
      setConfigOption: async (sessionId, key, value) => {
        seen.push({ key, value });
        return { ok: true, data: {} };
      },
    });
    const facade = await bootFacadeWithProvider(t, NO_GENERIC_CONFIG_WRITE);
    const before = await caughtBy(() =>
      facade.setEngineSessionConfigOption({
        sessionId: "mvs_a",
        key: "contextWindow",
        value: "128000",
        cid: "cid-1",
        transport: RUNTIME,
      }),
    );
    assert.ok(isEngineCapabilityNotSupportedError(before), "a truly generic id is still 501");
    const after = await facade.setEngineSessionConfigOption({
      sessionId: "mvs_a",
      key: "thinkingEffort",
      value: "high",
      cid: "cid-1",
      transport: RUNTIME,
    });
    assert.equal(after.statusHint, 200);
    assert.equal(after.gate.gate, "checked");
    assert.equal(after.gate.subItem, "setThinkingEffort");
    assert.deepEqual(
      seen,
      [{ key: "thinkingEffort", value: "high" }],
      "exactly one push, and it is the effort",
    );
  });

  test("the cid still reaches the RPC wrapper for a bridged id", async (t) => {
    // A regression here would be silent: the write would land on the
    // singleton's subprocess instead of the one holding the session, and
    // the engine would answer "session not found" for a session that
    // exists.
    let seenCid;
    registerRpcMock({
      setConfigOption: async (_sid, _key, _value, cid) => {
        seenCid = cid;
        return { ok: true, data: {} };
      },
    });
    const facade = await bootFacadeWithProvider(t, NO_GENERIC_CONFIG_WRITE);
    await facade.setEngineSessionConfigOption({
      sessionId: "mvs_a",
      key: "permissionMode",
      value: "auto",
      cid: "cid-xyz",
      transport: RUNTIME,
    });
    assert.equal(seenCid, "cid-xyz");
  });

  test("a `none` capability refuses the bridged ids too — the bridge is not a way around `none`", async (t) => {
    // The bridge is an exemption from the GENERIC sub-item only. A
    // provider with no `authCredentials` at all has no dedicated writer
    // either, and a bridge that survived `none` would be a hole in the
    // hard gate.
    const facade = await bootFacadeWithProvider(t, NEITHER);
    for (const key of ["model", "permissionMode", "anything"]) {
      const caught = await caughtBy(() =>
        facade.setEngineSessionConfigOption({ sessionId: "mvs_a", key, value: "v", transport: RUNTIME }),
      );
      assert.ok(isEngineCapabilityNotSupportedError(caught), key);
    }
  });

  test("the real registry refuses a generic id and keeps all three bridged ids on the runtime transport", async (t) => {
    // The shipped behaviour change, stated as the two halves of it.
    const facade = await bootFacade(t);
    const generic = await caughtBy(() =>
      facade.setEngineSessionConfigOption({
        sessionId: "mvs_a",
        key: "contextWindow",
        value: "128000",
        transport: RUNTIME,
      }),
    );
    assert.ok(isEngineCapabilityNotSupportedError(generic));
    for (const key of ["model", "permissionMode", "thinkingEffort"]) {
      const r = await facade.setEngineSessionConfigOption({
        sessionId: "mvs_a",
        key,
        value: "v",
        transport: RUNTIME,
      });
      assert.equal(r.statusHint, 200, key);
    }
  });

  test("and refuses NOTHING on the default acp transport", async (t) => {
    const facade = await bootFacade(t);
    for (const key of ["model", "permissionMode", "thinkingEffort"]) {
      const r = await facade.setEngineSessionConfigOption({
        sessionId: "mvs_a",
        key,
        value: "v",
        transport: ACP,
      });
      assert.equal(r.statusHint, 200, key);
      assert.equal(r.gate.gate, "unregistered-transport", key);
    }
  });
});

// ---------------------------------------------------------------------------
// Transport resolution comes from the config, not from a parameter that
// a caller can forget.
// ---------------------------------------------------------------------------

describe("the transport defaults to MCODE_WEBUI_TRANSPORT", () => {
  // This suite runs under BOTH gate invocations
  // (`pnpm test:webui` and `MCODE_WEBUI_TRANSPORT=acp pnpm test:webui`),
  // and `lib/config.js` reads the env at module-init time. So the
  // assertion is "whatever the env says, that is what the call used" —
  // reading the env and comparing to a hard-coded "acp" would make this
  // test red under the runtime gate for a reason that has nothing to do
  // with the code.
  const ENV_TRANSPORT = process.env.MCODE_WEBUI_TRANSPORT || "acp";

  test("no `transport` option means the config's value, not a hard-coded one", async (t) => {
    const facade = await bootFacade(t);
    // The two transports diverge in SHAPE, not just in status: `acp` has
    // no registered provider and the call returns a result, while `runtime`
    // registers a provider that denies the mode write and the gate throws.
    // Asserting one shape for both would be the test lying about half the
    // matrix, so each is asserted on its own side.
    const result = { transport: null, gate: null, statusHint: null };
    const thrown = await caughtBy(async () => {
      const r = await facade.setEngineSessionMode({ sessionId: "mvs_a", mode: "plan" });
      result.transport = r.transport;
      result.gate = r.gate.gate;
      result.statusHint = r.statusHint;
    });
    if (ENV_TRANSPORT === "runtime") {
      assert.ok(isEngineCapabilityNotSupportedError(thrown), "runtime denies the mode write");
      assert.equal(thrown.provider, "local-runtime-v2");
      return;
    }
    assert.equal(thrown, null);
    assert.equal(result.transport, ENV_TRANSPORT);
    assert.equal(result.gate, "unregistered-transport");
    assert.equal(result.statusHint, 200);
  });
});

// A no-op test context for the pure derivations, which need no mocks.
function t0() {
  return {
    mock: { module: () => {} },
    afterEach: () => {},
  };
}
