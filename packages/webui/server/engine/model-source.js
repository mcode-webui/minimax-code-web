// webui/server/engine/model-source.js
//
// Settings batch SB-1 (plan `doc/settings-batch-plan.md` §5 row 1, the
// PB-4 item): the MiniMax model SOURCE family —
//
//   GET  /api/model-source           → cliService.getMiniMaxModelSource
//   PUT  /api/model-source           → cliService.setMiniMaxModelSource
//   PUT  /api/model-source/api-key   → cliService.upsertMiniMaxApiKey
//   POST /api/model-source/test      → cliService.testUserModel
//
// What this batch unlocks, and what it deliberately does not.
//
//   UNLOCKED (3 of 4 tabs' worth): the 「用量与模型」 tab's source
//   switcher, its 「使用中」 badge and the MiniMax API key row. All four
//   engine methods existed the whole time
//   (`packages/local-runtime-v2/src/local/cli-service.ts` —
//   `getMiniMaxApiKeyStatus`, `getMiniMaxModelSource`,
//   `setMiniMaxModelSource`, `upsertMiniMaxApiKey`, `testUserModel`)
//   and had NO HTTP window: `settings-modal-port.tsx` carried
//   `useState` for the switcher and two permanently `disabled` buttons,
//   under a comment that said this repo has no
//   `setMiniMaxModelSource` backend. That comment was true about the
//   ROUTE and false about the CAPABILITY, which is the same distinction
//   PB-1 drew for the session right-click actions.
//
//   STILL A PLACEHOLDER (1), recorded at its own site rather than
//   re-derived: the 「自动获取」 live per-key model catalogue in the
//   add-model dialog. v2 exposes no per-provider catalogue query over an
//   arbitrary key — `cli-service.ts#listModels` lists the models the
//   application is ALREADY configured with, which is a different
//   question — so the built-in preset directory stays the only honest
//   implementation. See KNOWN DEBT 1.
//
// The gate, and why it is a PRESENCE gate rather than a declaration one.
//
// `requireCapability("modelProviders", …)` in the v2 cli-service names a
// capability that is NOT one of the 14 keys in `capabilities.js`
// (`ENGINE_CAPABILITY_KEYS` is a fixed audited matrix). Adding a 15th
// key for one batch would restate every provider declaration and the
// capability snapshot audit, and would claim a level nobody has
// re-audited. PB-1 met the identical situation for `pinSession` and
// resolved it the same way: gate on the LIVE member. So
// `MODEL_SOURCE_ENDPOINTS` is a table of `cliService` method names, and
// `resolveModelSourceMember` answers 501 when the booted host does not
// carry one. The three outcomes stay distinct:
//
//   null host                 → 503 engine_host_unavailable
//   host without the method   → 501 engine_member_unavailable
//   method that throws        → mapped from the engine's own status/code
//
// Engine error mapping. The v2 model service throws
// `LocalModelProviderError(status, message, code)` (see
// `service/model-system/contracts.ts:396`). That status is the honest
// HTTP status for the refusal it describes — a 400 for an empty or
// masked key, a 404 for a model that is not configured — so it is
// forwarded, together with the machine-readable `code` the frontend
// branches on. Anything without a numeric engine status is OUR failure
// and becomes a 500 whose body carries no engine text: an exception
// message from an unknown thrower is the one place a credential could
// still be echoed, and the route has no reason to print it.
//
// Read-vs-write boot. All four rows go through `getEngineCatalogueHost()`,
// which BOOTS the runtime on first call. That is correct for a user
// action (the user opened the settings tab and pressed a button) and
// wrong for a first-paint read: `host.js` documents the asymmetry —
// "a write may boot what it needs; a read may only use what is already
// there" — and the settings tab is not on the boot path of `/api/state`
// or `/api/session-tree`, so this family is read on demand by the tab
// itself and never by a page-level fetch. KNOWN DEBT 2 records the
// residual risk if that ever changes.

import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * The engine method each endpoint of this family needs. `member` is the
 * host path every row shares, so a fifth row is a table edit and not a
 * new branch in the resolver.
 *
 * `getMiniMaxApiKeyStatus` is deliberately NOT a row: it is a SECOND,
 * OPTIONAL member read behind the GET (the source plus the key's masked
 * projection). `readEngineModelSource` degrades that half instead of
 * failing the whole read, because a host that can report which source
 * is in use but not the key's masked form still answers the question
 * the source switcher asks. See `readEngineModelSource`.
 *
 * @type {Readonly<Record<string, Readonly<{member: "cliService", method: string}>>>}
 */
export const MODEL_SOURCE_ENDPOINTS = Object.freeze({
  "GET /api/model-source": Object.freeze({ member: "cliService", method: "getMiniMaxModelSource" }),
  "PUT /api/model-source": Object.freeze({ member: "cliService", method: "setMiniMaxModelSource" }),
  "PUT /api/model-source/api-key": Object.freeze({
    member: "cliService",
    method: "upsertMiniMaxApiKey",
  }),
  "POST /api/model-source/test": Object.freeze({ member: "cliService", method: "testUserModel" }),
});

/** The endpoint keys of this family, in `OWNED_ROUTES` order. */
export const MODEL_SOURCE_ROUTES = Object.freeze(Object.keys(MODEL_SOURCE_ENDPOINTS));

/** The capability label the v2 cli-service declares these under. */
export const MODEL_SOURCE_CAPABILITY = "modelProviders";

/**
 * The two model sources the engine accepts. Mirrors
 * `minimaxModelSource` in the v2 config (`packages/config`): `token_plan`
 * is the managed Token Plan credential, `minimax_api_key` is the user's
 * own BYOK key. The value is what the engine persists and what this
 * family validates against, so an unknown value is a 400 here rather
 * than a 400 three layers down.
 *
 * @type {Readonly<Record<string, true>>}
 */
export const MODEL_SOURCE_VALUES = Object.freeze({ token_plan: true, minimax_api_key: true });

/** The default the engine itself applies when nothing is persisted. */
export const DEFAULT_MODEL_SOURCE = "token_plan";

/**
 * The provider id the connectivity test runs against. The BYOK MiniMax
 * provider is the only one of the two sources with a testable credential
 * in the model service: `resolveTestTarget` routes `minimax_api` to
 * `resolveMinimaxTestTarget` (needs `minimax_api.apiKey`), while the
 * managed `minimax` id falls through to the CUSTOM-provider branch and
 * 404s, because the Token Plan credential is not a model-service key at
 * all. So the test endpoint tests the stored API key, whatever the
 * active source is, and says so in its response — see KNOWN DEBT 3.
 *
 * @type {string}
 */
export const MINIMAX_API_PROVIDER_ID = "minimax_api";

function providerByTransport() {
  // Built per call, never frozen at module scope: `engine/index.js`
  // re-exports this module, so a module-level table would read
  // `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its
  // temporal dead zone on a cold `import("./engine/index.js")`. Same
  // reason, same wording as `session-context-actions.js`.
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * Resolve the provider that answers the model-source family on
 * `transport`, or `null` when none is registered yet.
 *
 * `null` means "no provider claims this transport", which is NOT a
 * capability refusal: under the default `acp` transport the work still
 * runs on the process-local `local-runtime-v2` host reached through
 * `getEngineCatalogueHost()`. The refusal is the live member read.
 *
 * @param {string} transport
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveModelSourceProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Report the gate for one endpoint of this family. It never throws for
 * an engine limitation — the enforcement is the member read, which
 * happens at dispatch time against the live host, so this function only
 * records which declared provider (if any) would be behind it.
 *
 * A caller passing an endpoint key outside the table gets a plain
 * Error: that is webui's own bug, and the HTTP layer must never turn it
 * into a 501 that reads like an engine limitation.
 *
 * @param {string} endpoint A key of `MODEL_SOURCE_ENDPOINTS`.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string, subItem: string}}
 */
export function assertModelSourceCapability(endpoint, transport) {
  const need = MODEL_SOURCE_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `assertModelSourceCapability: "${endpoint}" is not part of the model source family ` +
        `(known: ${MODEL_SOURCE_ROUTES.join(", ")})`,
    );
    err.code = "unknown_model_source_endpoint";
    throw err;
  }
  const provider = resolveModelSourceProvider(transport);
  return {
    endpoint,
    // `member-presence`, never `capability`: the four methods hang off
    // the v2 cli-service's own `modelProviders` requirement, which is
    // not one of the 14 declared keys. See the module header.
    gate: "member-presence",
    provider: provider ? provider.id : null,
    capability: MODEL_SOURCE_CAPABILITY,
    subItem: need.method,
  };
}

/**
 * @typedef {{ok: true, member: Function, host: object}} ResolvedModelSourceMember
 * @typedef {{ok: false, code: "engine_host_unavailable"|"engine_member_unavailable", status: 503|501, error: string}} ResolvedModelSourceFailure
 */

/**
 * Read one `cliService` method off the booted catalogue host.
 *
 * `getHost` is an injection seam carried on the option bag ITSELF, not
 * nested under a `deps` key: the tests hand in a fake host, and
 * production falls through to the process-wide getter. `peek` picks the
 * non-booting getter for callers that must not start a runtime — this
 * family does not use it today (see the read-vs-write note in the module
 * header) and the seam exists so a future caller does not have to
 * re-open the resolver to reach it. Keeping the seam flat is what lets a
 * route forward its own optional fourth argument with a single spread.
 *
 * @param {object} options
 * @param {string} options.endpoint Endpoint key, for the failure text.
 * @param {string} [options.method] Method name; defaults to the endpoint's own.
 * @param {Function} [options.getHost] Host getter override.
 * @param {boolean} [options.peek] Use the non-booting getter.
 * @returns {Promise<ResolvedModelSourceMember|ResolvedModelSourceFailure>}
 */
export async function resolveModelSourceMember(options) {
  const { endpoint } = options;
  const declared = MODEL_SOURCE_ENDPOINTS[endpoint];
  const method = options.method || (declared ? declared.method : options.method);
  let getHost;
  if (options.getHost) {
    getHost = options.getHost;
  } else if (options.peek) {
    getHost = (await import("./host.js")).peekEngineCatalogueHost;
  } else {
    getHost = (await import("./host.js")).getEngineCatalogueHost;
  }
  let host;
  try {
    host = await getHost();
  } catch (e) {
    // A throwing host getter is caught here (and nowhere else in the
    // facade) so the route can answer 503 with a body instead of an
    // unhandled rejection.
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: e && e.message ? e.message : String(e),
    };
  }
  if (!host) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: `${endpoint}: the engine catalogue host is not available`,
    };
  }
  if (typeof host.cliService?.[method] !== "function") {
    return {
      ok: false,
      code: "engine_member_unavailable",
      status: 501,
      error: `${endpoint}: host.cliService.${method} is not a function`,
    };
  }
  return { ok: true, member: host.cliService[method].bind(host.cliService), host };
}

/**
 * Map a thrown engine error onto the HTTP surface.
 *
 * The v2 model service throws `LocalModelProviderError(status, message,
 * code)`, and that status is the honest answer for the refusal it
 * describes. Only errors that carry a numeric status in the 4xx/5xx
 * range are forwarded; everything else becomes a 500 with a fixed
 * message, because an exception string from an unknown thrower is the
 * one place a credential could still be echoed onto the wire.
 *
 * @param {unknown} error
 * @param {string} endpoint
 * @returns {{ok: false, code: string, error: string, status: number}}
 */
export function mapModelSourceError(error, endpoint) {
  const status = error && typeof error.status === "number" ? error.status : 0;
  if (status >= 400 && status <= 599) {
    return {
      ok: false,
      code: typeof error.code === "string" ? error.code : "ENGINE_REFUSED",
      error: typeof error.message === "string" ? error.message : `${endpoint} failed`,
      status,
    };
  }
  return {
    ok: false,
    code: "engine_error",
    error: `${endpoint}: the engine call failed`,
    status: 500,
  };
}

/**
 * The masked projection of the stored key, normalised to the shape the
 * frontend branches on. `maskedApiKey` is what the engine returns (a
 * mask, never plaintext — `getMinimaxApiKeyStatus` masks through
 * `service/model-system/secret.js`); it is passed through untouched so
 * webui invents no second masking rule that could drift from the
 * engine's.
 *
 * @param {object} status The engine's `getMiniMaxApiKeyStatus` answer.
 * @returns {{available: true, hasKey: boolean, masked: string|null, testState: string|null, lastTestedAtMs: number|null}}
 */
export function publicApiKeyStatus(status) {
  const record = status && typeof status === "object" ? status : {};
  const cached = record.cachedStatus && typeof record.cachedStatus === "object" ? record.cachedStatus : {};
  const lastTested = typeof cached.lastTestedAt === "number" ? cached.lastTestedAt : null;
  return {
    available: true,
    hasKey: record.hasApiKey === true,
    masked: typeof record.maskedApiKey === "string" ? record.maskedApiKey : null,
    testState: typeof cached.state === "string" ? cached.state : null,
    lastTestedAtMs: lastTested,
  };
}

/** The shape returned when the optional key-status member is absent. */
export function unavailableApiKeyStatus() {
  return { available: false, hasKey: false, masked: null, testState: null, lastTestedAtMs: null };
}

/**
 * GET /api/model-source — the active source plus the key's masked status.
 *
 * The two halves have different failure semantics, which is why they are
 * two reads: the SOURCE is required (a caller that cannot learn which
 * source is in use cannot render the switcher at all, so it 501s), and
 * the KEY STATUS is optional (a host that can answer the source but not
 * the masked form still renders a truthful switcher with a key block
 * that says it is unavailable, rather than failing the whole read).
 *
 * @param {object} [options]
 * @param {Function} [options.getHost] Passed to `resolveModelSourceMember`.
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, error: string, status: number}>}
 */
export async function readEngineModelSource(options = {}) {
  const source = await resolveModelSourceMember({
    endpoint: "GET /api/model-source",
    ...options,
  });
  if (!source.ok) return source;
  const keyStatus = await resolveModelSourceMember({
    endpoint: "GET /api/model-source",
    method: "getMiniMaxApiKeyStatus",
    ...options,
  });
  let sourceValue;
  try {
    sourceValue = await source.member();
  } catch (error) {
    return mapModelSourceError(error, "GET /api/model-source");
  }
  if (typeof sourceValue !== "string" || !MODEL_SOURCE_VALUES[sourceValue]) {
    // The engine's own type says two values. A third one is a contract
    // drift, and rendering it as a selected source would put the UI in
    // a state it has no way back out of.
    return {
      ok: false,
      code: "UNKNOWN_MODEL_SOURCE",
      error: `GET /api/model-source: the engine reported an unknown model source`,
      status: 502,
    };
  }
  // A key-status read that THROWS lands in the same degraded block as a
  // missing one, and the two are resolved BEFORE normalisation —
  // `publicApiKeyStatus(null)` is a valid record that says `hasKey:
  // false`, which is exactly the claim this branch must not make: it
  // would tell a user with a stored key that they have none.
  const keyRecord = keyStatus.ok ? await callKeyStatus(keyStatus.member) : null;
  return {
    ok: true,
    payload: {
      ok: true,
      source: sourceValue,
      apiKey: keyRecord === null ? unavailableApiKeyStatus() : publicApiKeyStatus(keyRecord),
    },
  };
}

/**
 * Read the optional key status, mapping ITS throw into the degraded
 * block rather than into the response. A key-status read that throws is
 * a partial answer, not a failed read — hence `null` ("could not tell
 * you") rather than an empty record ("there is no key").
 *
 * @param {Function} member
 * @returns {Promise<object|null>}
 */
async function callKeyStatus(member) {
  try {
    return await member();
  } catch {
    return null;
  }
}

/**
 * PUT /api/model-source — switch the active source.
 *
 * The engine refuses the `minimax_api_key` direction when no key is
 * configured (`resolveMinimaxTestTarget` throws `NO_API_KEY`), and that
 * refusal is forwarded with its own status and code so the UI can say
 * "save a key first" instead of a generic failure.
 *
 * @param {object} options
 * @param {unknown} options.source The requested source, validated here.
 * @param {Function} [options.getHost] Host getter override.
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, error: string, status: number}>}
 */
export async function applyEngineModelSource(options = {}) {
  const endpoint = "PUT /api/model-source";
  const source = typeof options.source === "string" ? options.source.trim() : "";
  if (!MODEL_SOURCE_VALUES[source]) {
    return {
      ok: false,
      code: "INVALID_MODEL_SOURCE",
      error: `PUT /api/model-source: source must be one of ${Object.keys(MODEL_SOURCE_VALUES).join(", ")}`,
      status: 400,
    };
  }
  const resolved = await resolveModelSourceMember({ endpoint, ...options });
  if (!resolved.ok) return resolved;
  let written;
  try {
    written = await resolved.member({ source });
  } catch (error) {
    return mapModelSourceError(error, endpoint);
  }
  // The engine echoes what it persisted. The response reports the
  // engine's answer, not the request, so a future engine that
  // normalises the value cannot leave this route claiming a source the
  // config does not carry.
  return {
    ok: true,
    payload: {
      ok: true,
      source: typeof written === "string" && MODEL_SOURCE_VALUES[written] ? written : source,
    },
  };
}

/**
 * PUT /api/model-source/api-key — upsert the BYOK key, optionally
 * switching to it in the same call (`saveAndUse`, the engine's own
 * flag).
 *
 * The KEEP-KEY sentinel, and why this family needs one at all. The
 * masked projection is the only key shape the GET can return, so a UI
 * that round-trips its own state would post the mask back and the
 * engine would refuse it (`assertValidRawApiKey` rejects anything
 * carrying the mask marker — `INVALID_API_KEY`). The provider family
 * solved the same problem with an empty-string sentinel
 * (`lib/providers-config.js#applyKeepKeyConvention`, ticket 03) and this
 * endpoint adopts that convention rather than inventing a second one: an
 * absent or empty `apiKey` means "do not change the stored key".
 *
 * A keep is answered 200 with `changed: false` and the CURRENT masked
 * status, having called no engine write. The engine is never asked to
 * re-assert a value it already holds, so a keep is free and cannot
 * fail — and the response still tells the UI what is stored, so the
 * badge does not have to be guessed from local state.
 *
 * @param {object} options
 * @param {unknown} options.apiKey    Raw key, or absent/empty for keep.
 * @param {unknown} [options.saveAndUse]
 * @param {Function} [options.getHost] Host getter override.
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, error: string, status: number}>}
 */
export async function saveEngineModelSourceApiKey(options = {}) {
  const endpoint = "PUT /api/model-source/api-key";
  const rawKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  if (!rawKey) {
    const current = await readEngineModelSource(options);
    if (!current.ok) return current;
    return {
      ok: true,
      payload: { ...current.payload, changed: false, saveAndUse: false },
    };
  }
  const resolved = await resolveModelSourceMember({ endpoint, ...options });
  if (!resolved.ok) return resolved;
  try {
    await resolved.member({
      apiKey: rawKey,
      ...(options.saveAndUse === true ? { saveAndUse: true } : {}),
    });
  } catch (error) {
    return mapModelSourceError(error, endpoint);
  }
  // Re-read through the engine rather than echoing the write. The write
  // returns a full provider view, but the switcher's contract is the
  // source plus the key's masked projection, and reading it back is
  // what proves the two agree — a response assembled from the request
  // would say "saved" even if the engine had stored something else.
  const after = await readEngineModelSource(options);
  if (!after.ok) return after;
  return { ok: true, payload: { ...after.payload, changed: true, saveAndUse: options.saveAndUse === true } };
}

/**
 * POST /api/model-source/test — connectivity probe for the STORED key.
 *
 * Two things this endpoint deliberately cannot do, both recorded as
 * KNOWN DEBT 3 rather than papered over:
 *
 *   1. It tests the stored key, not the one in the input. The v2
 *      `testUserModel` takes no key override (only
 *      `discoverCandidate` / `saveCandidate` carry one), so a probe of
 *      an unsaved key has no contract. The UI disables the button
 *      while the input holds an unsaved value.
 *   2. It always probes the `minimax_api` provider. The managed
 *      Token Plan source is not a model-service credential, so there is
 *      nothing on this surface to probe it with.
 *
 * `modelId` is optional and the engine falls back to the first
 * configured MiniMax model when it is absent; passing an unknown id is
 * the engine's 404 and is forwarded as one.
 *
 * @param {object} options
 * @param {unknown} [options.modelId]
 * @param {Function} [options.getHost] Host getter override.
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, error: string, status: number}>}
 */
export async function testEngineModelSourceModel(options = {}) {
  const endpoint = "POST /api/model-source/test";
  const modelId = typeof options.modelId === "string" ? options.modelId.trim() : "";
  const resolved = await resolveModelSourceMember({ endpoint, ...options });
  if (!resolved.ok) return resolved;
  let outcome;
  try {
    outcome = await resolved.member({
      providerId: MINIMAX_API_PROVIDER_ID,
      ...(modelId ? { modelId } : {}),
    });
  } catch (error) {
    return mapModelSourceError(error, endpoint);
  }
  // The engine answers `{success, status}` (the application layer's
  // framing of `ModelProviderTestOutcome`). A probe that came back
  // `success: false` is a successful REQUEST whose subject failed, so
  // it stays 200 and the UI renders the status — the same split
  // `POST /api/providers/test` makes between a 400 body and a 502 one.
  const record = outcome && typeof outcome === "object" ? outcome : {};
  const status = record.status && typeof record.status === "object" ? record.status : {};
  return {
    ok: true,
    payload: {
      ok: true,
      success: record.success === true,
      providerId: MINIMAX_API_PROVIDER_ID,
      modelId: modelId || null,
      tested: "stored_key",
      status: {
        state: typeof status.state === "string" ? status.state : null,
        lastTestedAt: typeof status.lastTestedAt === "number" ? status.lastTestedAt : null,
        lastErrorCode: typeof status.lastErrorCode === "string" ? status.lastErrorCode : null,
        lastErrorMessage: typeof status.lastErrorMessage === "string" ? status.lastErrorMessage : null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// 1. Live per-key model catalogue. The add-model dialog's 「自动获取」
//    still resolves against the built-in preset directory because v2 has
//    no per-provider catalogue query for an arbitrary key
//    (`cli-service.ts#listModels` answers a different question — the
//    models this application is already configured with). This batch did
//    not invent a route for it, and the dialog's preset answer is the
//    honest one until an engine method exists.
//
// 2. Boot-on-read. All four rows reach the engine through
//    `getEngineCatalogueHost()`, which boots the runtime on first call.
//    The settings tab fetches on demand (the user opened the tab), which
//    is the write-side contract `host.js` documents. If a future change
//    moves this fetch onto a page-level or boot-time path, it must move
//    to `peekEngineCatalogueHost()` — the `peek` seam on
//    `resolveModelSourceMember` is already there for that.
//
// 3. Test scope. `POST /api/model-source/test` probes the STORED key on
//    the `minimax_api` provider. It cannot probe an unsaved key (no
//    engine override) and cannot probe the Token Plan source (not a
//    model-service credential). Both are engine-contract limits, not
//    route choices, and the response says which credential it used
//    (`tested: "stored_key"`) so the UI never implies otherwise.
