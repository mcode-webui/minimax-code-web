// webui/server/routes/model-source.js
//
// The 「用量与模型」 tab's model-source family (settings batch SB-1, plan
// `doc/settings-batch-plan.md` §5 row 1):
//
//   GET  /api/model-source           — active source + masked key status
//   PUT  /api/model-source           — switch the source
//   PUT  /api/model-source/api-key   — upsert the key (empty = keep)
//   POST /api/model-source/test      — connectivity probe, stored key
//
// This file is the HTTP shape and nothing else: every gate, every engine
// call, the source whitelist, the keep-key convention and the error
// mapping live in `../engine/model-source.js`, which is where the rest of
// the families keep them. What stays here is what only an HTTP layer can
// own — the request body read, the status line, the JSON body, and the
// response's own invariant: an apiKey never appears in cleartext on any
// path, because the engine hands this route a mask and the route has no
// code path that could unmask it.
//
// REST shape, and why it is REST rather than the `/api/settings` patch
// this tab's other rows use. The source and the key are engine-owned
// state with their own engine methods and their own validation
// (`minimaxModelSource` in the engine's `config.yaml`, validated by
// `setMinimaxModelSource`), not webui settings the `POST /api/settings`
// handler mirrors to disk. A GET/PUT pair on the resource, with the key
// write on a sub-resource, keeps "the source" and "the key" as the two
// things they are — and the key's sub-path is what lets its handler
// carry the keep-key sentinel without a body flag that would read as
// "clear my key" by accident.
//
// Every handler takes an optional FOURTH argument, forwarded to the
// engine facade's option bag (`{getHost}` — nothing in production, a fake
// host in `test/routes/model-source.test.js`). `app.js#invokeHandler`
// passes three arguments, so the seam costs production nothing and keeps
// the suite hermetic: no runtime boot, no network, no tmpdir.

import { readJson } from "../lib/read-json.js";
import {
  MODEL_SOURCE_ENDPOINTS,
  MODEL_SOURCE_ROUTES,
  assertModelSourceCapability,
  applyEngineModelSource,
  readEngineModelSource,
  saveEngineModelSourceApiKey,
  testEngineModelSourceModel,
} from "../engine/model-source.js";

/**
 * The active transport, read through a function so a test can move it
 * between two calls and the module-scope import cost stays zero — the
 * same rule every other gated route follows.
 *
 * @returns {string}
 */
function activeTransport() {
  return process.env.MCODE_WEBUI_TRANSPORT || "acp";
}

/**
 * Write one answer, whether it succeeded or not. The engine facade
 * already decided the status and the code; this only serialises it, and
 * it never invents a field the facade did not produce.
 *
 * @param {object} res
 * @param {{ok: boolean, status?: number, payload?: object, code?: string, error?: string}} result
 * @returns {number} The status written.
 */
function writeResult(res, result) {
  if (result.ok) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result.payload));
    return 200;
  }
  const status = Number.isInteger(result.status) ? result.status : 500;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ok: false,
      code: result.code || "engine_call_failed",
      error: result.error || "the engine call failed",
    }),
  );
  return status;
}

/**
 * Reject an optional field that is present with the wrong type.
 *
 * Note what is NOT here: a "body must be a JSON object" guard. The
 * shared reader (`lib/read-json.js`) already normalises an empty body,
 * an array and a primitive to `{}`, so such a guard could never fire —
 * it would be a branch that reads like a contract and enforces nothing.
 * What CAN arrive is a field of the wrong type (`{"apiKey": 123}`), and
 * silently treating that as "no key given" would turn a client's bug
 * into a successful keep. So the type is what gets checked.
 *
 * @param {object} res
 * @param {unknown} value  The field as parsed.
 * @param {string} field   Field name, for the error text.
 * @param {"string"|"boolean"} expected  The type the field must have.
 * @returns {number|null} The status written, or `null` when acceptable.
 */
function rejectWrongType(res, value, field, expected) {
  if (value === undefined || value === null) return null;
  if (typeof value === expected) return null;
  res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ok: false,
      code: "BAD_FIELD_TYPE",
      error: `${field} must be ${expected === "string" ? "a string" : "a boolean"}`,
    }),
  );
  return 400;
}

/**
 * GET /api/model-source — the read the tab opens on.
 *
 * 200:
 *   {
 *     ok: true,
 *     source: "token_plan" | "minimax_api_key",
 *     apiKey: { available, hasKey, masked, testState, lastTestedAtMs }
 *   }
 *
 * `apiKey.masked` is the engine's own mask (`service/model-system/
 * secret.js`), passed through unchanged. `available: false` means the
 * host could not report the key half at all, which the UI renders as an
 * unavailable block rather than as "no key stored" — those are
 * different facts and collapsing them would show a user with a saved key
 * that it has none.
 *
 * 501 when the booted host has no `getMiniMaxModelSource`, 503 when
 * there is no host at all.
 */
export async function handleGetModelSource(_req, res, _ctx, deps = {}) {
  const endpoint = "GET /api/model-source";
  assertModelSourceCapability(endpoint, activeTransport());
  return writeResult(res, await readEngineModelSource(deps));
}

/**
 * PUT /api/model-source — switch the active source.
 *
 * Body: `{ "source": "token_plan" | "minimax_api_key" }`.
 *
 * 400 `INVALID_MODEL_SOURCE` for a missing or unknown `source` — the
 * facade checks the whitelist, so a typo costs no runtime round trip and
 * the engine re-checks the same two values before it persists them.
 * 400 `NO_API_KEY` when the engine refuses the BYOK direction because no
 * key is stored; that code is the UI's cue to send the user to the key
 * field rather than to an error toast.
 */
export async function handleSetModelSource(req, res, _ctx, deps = {}) {
  const endpoint = "PUT /api/model-source";
  const parsed = await readJson(req);
  const wrongType = rejectWrongType(res, parsed.source, "source", "string");
  if (wrongType !== null) return wrongType;
  assertModelSourceCapability(endpoint, activeTransport());
  return writeResult(res, await applyEngineModelSource({ ...deps, source: parsed.source }));
}

/**
 * PUT /api/model-source/api-key — upsert the BYOK key.
 *
 * Body: `{ "apiKey": "<raw key>", "saveAndUse": true|false }`.
 *
 * The keep-key sentinel: an absent or empty `apiKey` keeps the stored
 * key and answers 200 `{changed: false}` with the current masked status,
 * having called no engine write. It exists because the GET can only ever
 * return a MASK, and the engine rejects a mask as a key
 * (`INVALID_API_KEY`) — a UI that round-tripped its own masked state
 * would turn every save into a failure. Same convention, same reason and
 * the same empty-string spelling as `PUT /api/providers`.
 *
 * `saveAndUse` is the engine's own flag: it writes the key AND switches
 * the source to `minimax_api_key` in one transaction, so the UI never
 * has to make that a two-request dance it could get half-applied.
 *
 * 400 `BAD_FIELD_TYPE` for a non-string `apiKey` or `saveAndUse`; the
 * key's own validity (empty, masked) is the engine's call and its status
 * is forwarded.
 */
export async function handlePutModelSourceApiKey(req, res, _ctx, deps = {}) {
  const endpoint = "PUT /api/model-source/api-key";
  const parsed = await readJson(req);
  const wrongKey = rejectWrongType(res, parsed.apiKey, "apiKey", "string");
  if (wrongKey !== null) return wrongKey;
  const wrongFlag = rejectWrongType(res, parsed.saveAndUse, "saveAndUse", "boolean");
  if (wrongFlag !== null) return wrongFlag;
  assertModelSourceCapability(endpoint, activeTransport());
  return writeResult(
    res,
    await saveEngineModelSourceApiKey({
      ...deps,
      apiKey: parsed.apiKey,
      saveAndUse: parsed.saveAndUse,
    }),
  );
}

/**
 * POST /api/model-source/test — connectivity probe for the STORED key.
 *
 * Body: `{ "modelId"?: "MiniMax-M3" }` — the engine falls back to the
 * first configured MiniMax model when it is absent.
 *
 * 200 in BOTH cases, deliberately. `success: false` is a successful
 * request about a failed subject (the same split
 * `POST /api/providers/test` makes), and the UI renders the engine's
 * status rather than an error toast. What comes back as a non-200 is a
 * refusal to even try: no host (503), no such method (501), or the
 * engine's own 400 `NO_API_KEY` when nothing is stored to test.
 *
 * The probe always runs against the STORED key — v2's `testUserModel`
 * takes no key override — and the response says so
 * (`tested: "stored_key"`), so no UI can imply it probed an unsaved
 * key. See `engine/model-source.js` KNOWN DEBT 3.
 *
 * The body is optional (the probe has no required field, and refusing an
 * absent body would make a plain click need a fabricated `{}`);
 * `modelId` must be a string when it is present.
 */
export async function handleTestModelSource(req, res, _ctx, deps = {}) {
  const endpoint = "POST /api/model-source/test";
  const parsed = await readJson(req);
  const wrongType = rejectWrongType(res, parsed.modelId, "modelId", "string");
  if (wrongType !== null) return wrongType;
  assertModelSourceCapability(endpoint, activeTransport());
  return writeResult(res, await testEngineModelSourceModel({ ...deps, modelId: parsed.modelId }));
}

// Test-only helpers. The family has no tmp-dir or network footprint, so
// the surface a test needs is the body shape a synthetic request must
// carry and the table it dispatches through.

/**
 * @returns {string[]} The endpoint keys, in `OWNED_ROUTES` order.
 */
export function _modelSourceRoutes() {
  return [...MODEL_SOURCE_ROUTES];
}

/**
 * @param {string} endpoint
 * @returns {{member: string, method: string}|undefined}
 */
export function _modelSourceDeclaration(endpoint) {
  return MODEL_SOURCE_ENDPOINTS[endpoint];
}
