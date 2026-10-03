// webui/server/engine/mode-writes.js
//
// Migration step M3, batch B9: the SESSION MODE WRITE family —
//
//   #67  POST /api/protocol/set-mode           — put the session in a mode
//   #68  POST /api/protocol/set-config-option  — write one config option
//
// This is the FIRST M3 batch that deliberately changes what a client
// sees. Every batch before it kept the wire byte for byte; this one
// does not, and the change is the batch's whole reason for existing.
// The boundary is drawn once, here, and it is a single sentence:
//
//   ONLY THE "THE PROVIDER HAS NO SUCH SURFACE" ANSWER CHANGES.
//
// A provider that DECLARES the capability keeps every status, every
// field and every ordering it had before this batch — including the
// pre-existing 501 for an engine that answers `code: "unsupported"`,
// including the `fallback: "send_plan_as_prompt"` hint on that 501, and
// including the two status tables' deliberate disagreement (#67 answers
// 502 for an unmapped code, #68 answers 500). A provider that
// DECLARES the capability absent used to have its request forwarded to
// the engine anyway; it now answers the engine gate's 501 with the
// shared structured body. That is the whole cut.
//
// Why a HARD gate, when B6 and B7 soft-gated their families. Both of
// those had a truthful degradation to fall back on, and hard-gating
// them would have removed a working endpoint over an enrichment. These
// two have none, and the reason is structural rather than a judgement
// call: each endpoint's ENTIRE product is the engine write. #67 has no
// webui-side meaning — a mode that webui recorded locally and the
// engine never entered is a mode the user is not in. #68 is the same
// for a config value. A provider with no write surface therefore cannot
// produce a truthful answer to any of {the write did not happen, the
// control in the panel now shows the new value, the state push told
// every other tab}. Answering 200 there is #110's fake success in its
// purest form, so the gate throws and `app.js#invokeHandler` maps it.
//
// Where each endpoint's declaration comes from, and why the two are
// not the same shape:
//
//   - #67 names `toolSkillInvocation` · `setMode`. The 14-key matrix
//     has no "mode write" row, and the plan (§3a, row 67) puts session
//     mode control under the tool/skill capability. v2 has no `setMode`
//     anywhere on the cliService surface — the snapshot audit
//     (`test/lib/engine/capability-snapshot.test.js`) is what proves
//     that, mechanically, and it keeps proving it: the moment a host
//     grows a `setMode` method the declaration's `missing` entry goes
//     red and has to be re-audited. v2 can READ plan state
//     (`getPlanModeCapabilities` / `getLatestPlanReview`) and enters
//     plan through the questionnaire mechanism; it has no write.
//
//   - #68 names `authCredentials` · `setConfigOption` — the GENERIC
//     config option, per the plan (§3a, row 68). The three config ids
//     webui's own controls depend on, `model`, `permissionMode` and
//     `thinkingEffort`, are NOT the generic write, and the plan requires
//     them to survive it ("通用 configId 真 501；常用 id 桥接"). So the
//     gate's sub-item is a function of the request: a bridged id asks
//     for its own sub-item and passes a provider that denies the
//     generic one, and every other config id asks for `setConfigOption`
//     and gets the 501. `MODE_WRITE_BRIDGED_CONFIG_IDS` is that table,
//     exported because the frontend needs the same names to decide
//     which controls to hide (see `webapp/lib/engine-capabilities.ts`,
//     and the tripwire test that pins the two tables to each other).
//
//   M3-B14 added the third id, `thinkingEffort` → `setThinkingEffort`.
//   It is the same decision the first two took, for the reason #58
//   forced: the effort write rides the GENERIC config-option channel
//   on the wire, so without a bridge a provider that denies the
//   generic write would make the thinking-effort control the one
//   endpoint in the family that 501s. The name is a forward contract
//   — NEITHER audited surface has a `setThinkingEffort` method today,
//   and the snapshot audit now says so out loud rather than leaving the
//   bridge unverified (see `test/lib/engine/capability-snapshot.test.js`
//   and `engine/model-writes.js` KNOWN DEBT 1).
//
// What the two 501s on these routes now are, and why they must not be
// confused. B7 recorded the same collision for #70 and this batch adds
// two more instances of it, so it is worth stating flatly:
//
//   - THE ENGINE-GATE 501 (new). Body:
//     `{ok:false, code:"engine_capability_not_supported", capability,
//     provider, missing?, reason?, error}` from
//     `errors.js#engineCapabilityHttpResponse`, written by the router's
//     central mapping. It has NO `fallback` field, and it is not
//     reachable from the route's own code path at all — the route never
//     catches it.
//   - THE ROUTE'S 501 (pre-existing). Body:
//     `{ok:false, error, code:"unsupported", fallback:"send_plan_as_prompt"}`
//     (plus the 501 shape #68 already had, without `fallback`). This
//     one is the ENGINE refusing a call it does accept, and it is
//     preserved byte for byte.
//
// The gate's 501 losing `fallback` is deliberate and is the one place
// where this batch's behaviour change is visible to a client that
// special-cases the field: design §4.2 says the UI hides the entry
// point rather than falling back to a degraded action, and a capability
// that is not there has no degraded action to fall back TO — offering
// `send_plan_as_prompt` from a 501 that says "there is no way to enter
// plan mode here" would be advertising a workaround for a missing
// feature. The engine's own refusal keeps its hint because there the
// feature exists and only this call did not work. KNOWN DEBT 1.
//
// What this file deliberately does NOT do:
//
//   - It does not own the client-state writes. `cs.planMode` (#67) and
//     `cs.permissions` (#68) are webui's own view of the client, and
//     the state push is a transport concern; both stay in the route,
//     which is also what keeps them running only on success.
//   - It does not own the 400s. A missing `sessionId` / `mode` / `key`
//     is caller confusion, not an engine limitation, and the matrix
//     says an unknown provider id answers 404 for the same reason.
//   - It does not build a host. There is no host on this path.
//   - It does not migrate `/api/set-model` and `/api/permissions`,
//     which are B10's two endpoints. They call the same
//     `lib/mcode-rpc.js#setConfigOption` from a different route and are
//     untouched here — see KNOWN DEBT 2, which is about exactly that.
//
// Boot-path weight. `app.js` imports the routes, the routes import this
// file, so this file is on the boot path. It statically imports
// `engine/capabilities.js` and `engine/index.js` (both pure
// declaration modules) and nothing else; `lib/mcode-rpc.js` and
// `lib/config.js` are reached through `await import()` inside the
// data-plane functions.

import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is
 * unavailable" — the two answer differently on purpose, mirroring
 * `session-reads.js`, `session-tree-reads.js`, `usage-reads.js`,
 * `account-reads.js`, `session-writes.js`, `session-switch.js`,
 * `interrupt.js` and `session-load.js` rather than merging with any of
 * them: eight families with separate contracts, and a shared table
 * would force this one to inherit another's policy.
 *
 * Built per call rather than frozen at module scope: `engine/index.js`
 * re-exports this module, so a module-level table would read
 * `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its
 * temporal dead zone on a cold `import("./engine/index.js")`. Every
 * consumer of the table is a function anyway.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

// ---------------------------------------------------------------------------
// The declaration, and the bridge table
// ---------------------------------------------------------------------------

/**
 * The declaration this family's engine-facing half needs.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "hard"}>>}
 */
export const MODE_WRITE_ENDPOINTS = Object.freeze({
  "POST /api/protocol/set-mode": Object.freeze({
    capability: "toolSkillInvocation",
    subItem: "setMode",
    enforcement: "hard",
  }),
  "POST /api/protocol/set-config-option": Object.freeze({
    capability: "authCredentials",
    subItem: "setConfigOption",
    enforcement: "hard",
  }),
});

/**
 * The three config ids that survive a provider denying the GENERIC
 * config-option write, and the sub-item each one asks for instead.
 *
 * The plan (§3a, row 68) is explicit that the generic `configId` has
 * nowhere to be delivered under a provider with no generic write, while
 * these have dedicated equivalents — "常用 id 桥接到
 * `selectModel`/`setPermissionMode`". Naming the sub-items rather than
 * quietly widening the gate is what keeps the 501 honest: a provider
 * that declares `authCredentials` partial with `missing:
 * ["setConfigOption"]` says "I have the dedicated model, permission
 * and thinking-effort writers but not a generic one", and the gate
 * reads exactly that.
 *
 * `thinkingEffort` → `setThinkingEffort` arrived in M3-B14, and it is
 * the one entry whose sub-item NO audited host carries (the other two
 * were verified present by reflection before B10 named them). The name
 * is therefore a forward contract with the engine, not a description of
 * today's host, and the snapshot audit records that gap explicitly
 * rather than letting the bridge be an exemption nothing checks. The
 * consequence for a client is stated in the KNOWN DEBT section.
 *
 * Exported because the frontend asks the same question about the same
 * three controls, and two hand-maintained copies of a set of engine
 * sub-item names is a drift waiting to happen. The tripwire test in
 * `webapp/test/engine-capabilities-degradation.test.ts` reads this
 * table out of the server source and fails if the two ever disagree.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const MODE_WRITE_BRIDGED_CONFIG_IDS = Object.freeze({
  model: "selectModel",
  permissionMode: "setPermissionMode",
  thinkingEffort: "setThinkingEffort",
});

/**
 * Which sub-item an endpoint's gate asks for, given the request.
 *
 * #67 has one answer. #68 has two, and the split is the whole of the
 * bridge: a bridged config id asks for its dedicated sub-item, and
 * everything else asks for the generic one. An `undefined` or
 * non-bridged config id is the generic case, which is the safe
 * direction — a name nobody recognised must not quietly inherit the
 * exemption reserved for the three ids this family audited.
 *
 * @param {string} endpoint  A key of MODE_WRITE_ENDPOINTS.
 * @param {string} [configId]  #68 only.
 * @returns {string}
 */
export function resolveModeWriteSubItem(endpoint, configId) {
  const need = MODE_WRITE_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `resolveModeWriteSubItem: "${endpoint}" is not part of the mode-write family ` +
        `(known: ${Object.keys(MODE_WRITE_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_mode_write_endpoint";
    throw err;
  }
  if (endpoint !== "POST /api/protocol/set-config-option") return need.subItem;
  const bridged = MODE_WRITE_BRIDGED_CONFIG_IDS[configId];
  return typeof bridged === "string" ? bridged : need.subItem;
}

/**
 * Resolve the provider that answers the mode-write family on
 * `transport`, or `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveModeWriteProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * HARD gate for both endpoints. Throws
 * `EngineCapabilityNotSupportedError` for a declared `none`, and for a
 * `partial` naming the sub-item the request actually needs, which the
 * router maps to 501 with `engineCapabilityHttpResponse`'s payload.
 *
 * Both endpoints are hard by the argument in the module header: there
 * is no webui-side meaning left to answer with once the engine write
 * is gone, so a truthful 200 does not exist.
 *
 * `configId` is #68's bridge input and is ignored for #67. Passing one
 * for #67 must not change the answer, and the suite pins that, because
 * the alternative is a gate whose verdict depends on a field the
 * endpoint does not have.
 *
 * @param {string} endpoint  A key of MODE_WRITE_ENDPOINTS.
 * @param {string} transport  The active transport.
 * @param {string} [configId]  #68 only.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string, subItem: string, enforcement: "hard"}}
 */
export function assertModeWriteCapability(endpoint, transport, configId) {
  const need = MODE_WRITE_ENDPOINTS[endpoint];
  if (need === undefined) {
    // Caller confusion, not an engine limitation. A plain Error, so a
    // typo in webui's own key can never be reported to a user as an
    // engine limitation.
    const err = new Error(
      `assertModeWriteCapability: "${endpoint}" is not part of the mode-write family ` +
        `(known: ${Object.keys(MODE_WRITE_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_mode_write_endpoint";
    throw err;
  }
  const subItem = resolveModeWriteSubItem(endpoint, configId);
  const base = {
    endpoint,
    provider: null,
    capability: need.capability,
    subItem,
    enforcement: need.enforcement,
  };
  const provider = resolveModeWriteProvider(transport);
  if (!provider) return { ...base, gate: "unregistered-transport" };
  // Throws for `none`, and for `partial` whose `missing` names THIS
  // sub-item. A bridged config id therefore passes a provider that
  // denies the generic write, and 501s under a provider that denies
  // the dedicated one — which is the same distinction in the other
  // direction and the reason the two tables are not merged.
  assertEngineCapability(provider.capabilities, need.capability, provider.id, subItem);
  return { ...base, gate: "checked", provider: provider.id };
}

// ---------------------------------------------------------------------------
// Pure derivations. Exported and tested on their INPUTS.
// ---------------------------------------------------------------------------

/**
 * #67's `code` → HTTP status, preserved byte for byte.
 *
 * The default row is 502, not the 500 every sibling family uses, and
 * that asymmetry is pre-existing: `handleSetMode` has always answered
 * 502 for a code it cannot classify while `handleSetConfigOption`
 * answers 500. Unifying them would change one endpoint's wire to match
 * the other, which is a decision about the two endpoints' contracts
 * rather than a migration step, and B7 recorded the same asymmetry
 * across #67/#70 for the same reason. Pinned as a value, including the
 * rows no fixture reaches.
 *
 * @param {string|undefined} code  The RPC wrapper's `code`.
 * @returns {number}
 */
export function setModeFailureStatus(code) {
  if (code === "unsupported") return 501;
  if (code === "no_client") return 503;
  if (code && /not.found|invalid/i.test(code)) return 404;
  if (code && /conflict|policy/i.test(code)) return 409;
  return 502;
}

/**
 * #68's `code` → HTTP status. #67's table with the last row at 500.
 *
 * @param {string|undefined} code  The RPC wrapper's `code`.
 * @returns {number}
 */
export function setConfigOptionFailureStatus(code) {
  if (code === "unsupported") return 501;
  if (code === "no_client") return 503;
  if (code && /not.found|invalid/i.test(code)) return 404;
  if (code && /conflict|policy/i.test(code)) return 409;
  return 500;
}

// ---------------------------------------------------------------------------
// Data plane
// ---------------------------------------------------------------------------

/**
 * #67 — put the session into `mode`.
 *
 * The order below IS the endpoint's contract:
 *
 *   1. HARD CAPABILITY CHECK. Throws for a provider that declares the
 *      mode write absent; the router answers 501. Under the default
 *      `acp` transport no provider is registered and the check reports
 *      `unregistered-transport`, which is the pre-B9 behaviour.
 *   2. ENGINE WRITE. A client throw is caught and folded into
 *      `client_throw` rather than escaping as a 500, so the endpoint
 *      keeps its "never throw" rule. This is pre-existing and
 *      unchanged: a transport that blows up is a 502 here, not a
 *      crash.
 *   3. STATUS + BODY. `setModeFailureStatus` on the engine's refusal;
 *      `{ok:true, mode, data}` on success, with `mode` echoed from the
 *      request exactly as the route always echoed it.
 *
 * `fallback: "send_plan_as_prompt"` rides on the engine's own
 * `unsupported` refusal and on nothing else — see the module header for
 * why the capability 501 does not carry it.
 *
 * @param {object} options
 * @param {string} options.sessionId  Already validated non-empty.
 * @param {string} options.mode  Already validated non-empty.
 * @param {string} [options.transport]
 * @returns {Promise<{payload: object, statusHint: number, gate: object, transport: string}>}
 */
export async function setEngineSessionMode(options = {}) {
  const endpoint = options.endpoint || "POST /api/protocol/set-mode";
  const [rpc, config] = await Promise.all([
    import("../lib/mcode-rpc.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const gate = assertModeWriteCapability(endpoint, transport);
  const { sessionId, mode } = options;
  let r;
  try {
    r = await rpc.setMode(sessionId, mode);
  } catch (e) {
    // mcode acp 客户端炸了 (例如 session 未知导致底层 jsonrpc 抛)
    // 避免 500 — 包成 fail 让前端能看
    console.warn(`[protocol.set-mode] caught throw: ${e.message || e}`);
    r = { ok: false, error: e.message || String(e), code: "client_throw" };
  }
  if (!r.ok) {
    return {
      payload: {
        ok: false,
        error: r.error,
        code: r.code,
        fallback: "send_plan_as_prompt",
      },
      statusHint: setModeFailureStatus(r.code),
      gate,
      transport,
    };
  }
  return {
    payload: { ok: true, mode, data: r.data },
    statusHint: 200,
    gate,
    transport,
  };
}

/**
 * #68 — write one config option.
 *
 * Same four steps as #67 with one difference that is not a
 * simplification: there is NO `try/catch` around the engine call. #67
 * has always had one and its `client_throw` code is on the wire; #68
 * has never had one, and giving it one now would turn a crash into a
 * 500 on an endpoint whose failure modes are currently only the ones
 * the wrapper returns. The two endpoints' error handling is not
 * symmetric today and this batch keeps it that way.
 *
 * @param {object} options
 * @param {string} options.sessionId  Already validated non-empty.
 * @param {string} options.key  Already validated non-empty; the
 *        config id, which also selects the gate's sub-item.
 * @param {string} options.value
 * @param {string} [options.cid]
 * @param {string} [options.transport]
 * @returns {Promise<{payload: object, statusHint: number, gate: object, transport: string}>}
 */
export async function setEngineSessionConfigOption(options = {}) {
  const endpoint = options.endpoint || "POST /api/protocol/set-config-option";
  const [rpc, config] = await Promise.all([
    import("../lib/mcode-rpc.js"),
    import("../lib/config.js"),
  ]);
  const transport = options.transport || config.MCODE_WEBUI_TRANSPORT;
  const { sessionId, key, value } = options;
  const gate = assertModeWriteCapability(endpoint, transport, key);
  const r = await rpc.setConfigOption(sessionId, key, value, options.cid);
  if (!r.ok) {
    return {
      payload: { ok: false, error: r.error, code: r.code },
      statusHint: setConfigOptionFailureStatus(r.code),
      gate,
      transport,
    };
  }
  return {
    payload: { ok: true, key, value, data: r.data },
    statusHint: 200,
    gate,
    transport,
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// Recorded here rather than fixed, because each item is a decision that
// belongs to a human or to a later batch:
//
//   1. THE CAPABILITY 501 HAS NO `fallback`, AND TWO DIFFERENT 501s NOW
//      REACH EACH OF THESE ROUTES. The engine-gate 501 carries
//      `engineCapabilityHttpResponse`'s body and no `fallback`; the
//      pre-existing route 501 for `code === "unsupported"` carries
//      `fallback: "send_plan_as_prompt"` on #67 and no `fallback` on
//      #68. A client that branches on the status alone will see both.
//      The router's central mapping is what keeps them from being
//      confused for each other, and the shape difference is the
//      intended one (see the module header). What is NOT settled is
//      whether a client should be told to prefer one: today nothing in
//      the shipped webapp calls either endpoint, so the question has
//      never had a consumer, and answering it would mean picking a
//      deprecation order for a field that predates this batch.
//
//   2. `MODEL` AND `PERMISSION_MODE` BRIDGE TO SUB-ITEMS NO AUDITED
//      HOST ACTUALLY HAS YET. `selectModel` and `setPermissionMode` are
//      what the plan (§3a, row 68) says the v2 surface offers, and
//      keeping them out of a `missing` list is what lets the two ids
//      through the gate. But the snapshot audit
//      (`capability-snapshot.test.js`) only proves that a `missing`
//      entry is ABSENT — it has no way to prove a non-missing
//      sub-item EXISTS, because `REQUIRED_METHODS` is a hand-kept
//      list, and neither name is on it. So the bridge is currently an
//      audit-free exemption: honest as a forward contract for M4,
//      unverified as a claim about today's host. B10 is where
//      `/api/set-model` and `/api/permissions` land, and it is the
//      batch that should add both names to `REQUIRED_METHODS` if and
//      only if the host really has them — at which point this debt
//      closes itself, and if it does not, the gate has been letting
//      two ids through against a declaration that cannot support them.
//      Until then the safest thing is that the exemption is narrow:
//      two named ids, never a prefix, never a default.
//
//      CLOSED BY M3-B10 for these two names: both were verified present
//      by reflection on a booted host and added to `REQUIRED_METHODS`,
//      so the audit now checks them on both surfaces. What reopened the
//      question is the third id — see item 5, which is the same debt
//      with a different answer for a different reason.
//
//   3. `/api/set-model` AND `/api/permissions` CALL THE SAME RPC
//      WRAPPER AND ARE NOT GATED. `routes/model.js` reaches
//      `lib/mcode-rpc.js#setConfigOption` directly for `model`,
//      `thinkingEffort` and `permissionMode`. Those are B10's two
//      endpoints (#58 and #59) and they are untouched here on purpose.
//      The consequence to carry forward is specific: `thinkingEffort`
//      is a GENERIC config id, so the moment B10 puts
//      `/api/set-model` behind this family's gate the thinking-effort
//      control will start answering 501 for the same reason #68 does
//      for an unrecognised config id. B10 has to decide whether to
//      bridge it as a third id or to accept the 501 with a frontend
//      degradation; this batch does not decide it for it.
//
//      CLOSED BY M3-B14: a human picked branch (a) — bridge it. #58 and
//      #59 are now gated, in `engine/model-writes.js`, and the gate is
//      deliberately not this family's `assertModeWriteCapability`: the
//      two endpoints are not mode-write endpoints, and #58's gate turns
//      on which CHANNEL its plan took, which a config id cannot say.
//
//   4. `setMode` IS THE ONLY SUB-ITEM #67 ASKS FOR, AND THE MATRIX
//      HAS NO ROW FOR IT. `toolSkillInvocation` is the plan's home for
//      session mode control (§3a, row 67) and it is a real
//      declaration with a real audit, but it is a home by
//      approximation: the capability is named for tools and skills,
//      and this batch is asking it to also carry "the session entered
//      plan mode". If M4's provider work ever grows a mode row, #67
//      moves to it and nothing else in this file changes except the
//      one string in `MODE_WRITE_ENDPOINTS`.
//
//   5. `THINKING_EFFORT` IS BRIDGED, AND #68's 501 FOR THAT CONFIG ID
//      IS GONE WITH IT. This is the one behaviour change M3-B14 makes
//      to this file, and it is a consequence of the bridge rather than a
//      separate decision: `#68 {"key":"thinkingEffort"}` used to ask for
//      the generic `setConfigOption` and answer 501 under a provider
//      that denies it. It now asks for `setThinkingEffort` and is
//      delivered, exactly like `model` and `permissionMode` have been
//      since B9.
//
//      The cost is the honesty of the name. `selectModel` and
//      `setPermissionMode` are methods the audited host HAS;
//      `setThinkingEffort` is one neither audited surface has, and the
//      snapshot audit records that as an explicit "unimplemented" fact
//      rather than leaving the third bridge unverified. So under a
//      provider that denies the generic write, #68 with
//      `key:"thinkingEffort"` now forwards a call the provider cannot
//      serve — it will answer with whatever its own dedicated-writer
//      path says, which today means the engine is asked directly.
//
//      Nothing in the shipped webapp calls #68 (item 1), so there is no
//      client to break, and the change makes the two endpoints agree:
//      a config id cannot be delivered on #58 and refused on #68 for
//      the same provider. The alternative — leaving `thinkingEffort`
//      generic on #68 while bridging it on #58 — would have kept a 501
//      that the control is now hidden from, i.e. a status no user could
//      ever reach.
