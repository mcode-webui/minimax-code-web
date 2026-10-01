// webui/server/lib/engine/errors.js
//
// Structured error for "this engine provider does not offer capability X".
// The engine abstraction's hard rule (design doc §2.2, option C rejected):
// a missing capability must surface as an ERROR, never as a silent empty
// implementation — an empty array or `{ok:true}` would tell the user
// "succeeded with nothing", which is the fake-success failure mode this
// repository fixed in #110 and refuses to reintroduce.
//
// Consumers:
//   - engine layer: assertEngineCapability() throws it before dispatching
//     to a provider method (capabilities.js).
//   - HTTP layer: server/app.js#invokeHandler and server/router.js map it
//     to 501 with the payload from engineCapabilityHttpResponse() — the
//     same centralised mapping BodyTooLargeError gets, so no route has to
//     remember to catch it.

/**
 * Error thrown when a caller invokes an engine capability the active
 * provider did not declare (level `none`), or invokes the missing half
 * of a `partial` capability.
 *
 * Fields are part of the HTTP contract (501 payload) — treat renames as
 * breaking changes for the frontend.
 */
export class EngineCapabilityNotSupportedError extends Error {
  /**
   * @param {object} details
   * @param {string} details.capability  Capability key (one of the 14 keys
   *                                     in capabilities.js#ENGINE_CAPABILITY_KEYS).
   * @param {string} details.provider    Provider id ("local-runtime-v2", …).
   * @param {string[]} [details.missing] For `partial` capabilities: the
   *                                     sub-items that are absent.
   * @param {string} [details.reason]    Why the capability is unavailable.
   */
  constructor({ capability, provider, missing, reason }) {
    super(
      `engine provider "${provider}" does not support capability "${capability}"` +
        (missing && missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""),
    );
    this.name = "EngineCapabilityNotSupportedError";
    this.capability = capability;
    this.provider = provider;
    this.missing = missing ?? [];
    this.reason = reason ?? null;
  }
}

/** True when `err` is an EngineCapabilityNotSupportedError instance. */
export function isEngineCapabilityNotSupportedError(err) {
  return err instanceof EngineCapabilityNotSupportedError;
}

/**
 * The HTTP shape for this error: 501 Not Implemented, with a stable code
 * the frontend can treat as "expected degradation" (design doc §4.2: the
 * UI hides the entry point instead of surfacing an error toast).
 *
 * 501 (not 400/404) because the *server-side engine provider* lacks the
 * feature — the request itself was well-formed. This mirrors the existing
 * `code === "unsupported"` → 501 mapping in routes/protocol.js.
 */
export function engineCapabilityHttpResponse(err) {
  return {
    status: 501,
    payload: {
      ok: false,
      code: "engine_capability_not_supported",
      capability: err.capability,
      provider: err.provider,
      ...(err.missing && err.missing.length > 0 ? { missing: err.missing } : {}),
      ...(err.reason ? { reason: err.reason } : {}),
      error: err.message,
    },
  };
}
