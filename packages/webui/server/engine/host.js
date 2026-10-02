// webui/server/engine/host.js
//
// The lazy half of the engine facade: the one place route code asks for
// the live catalogue host (migration step M3, batch B0).
//
// Why the getter cannot simply live in `lib/acp-client.js` and be
// imported from `engine/index.js`: `getCatalogueHost()` is already lazy
// *inside* — it `await import("./runtime-host.js")` on first call — but
// the MODULE is not. `lib/acp-client.js` statically imports
// `../../acp.mjs`, the command registry, the settings/config chain and the
// session-delete module. `engine/index.js` is loaded by `app.js` at boot,
// so a static import of `acp-client.js` there would put the ACP client and
// everything behind it on every server start. That is the exact regression
// M1 already paid for once (209ms → 2700ms; index load 4685ms → 5ms after
// the declaration/construction split). This file exists to keep that
// boundary: the only thing `engine/index.js` gains is a function, and the
// function does not touch the module graph until it is called.
//
// Discipline, unchanged by the indirection: one host per process. This
// function FORWARDS to `acp-client.js#getCatalogueHost`, it does not
// construct anything. Two callers must never end up with two CliService
// instances over one dataDir — that is both wasteful and a split brain
// against the plugin / local-disable tables.
//
// The return value is passed through untouched, `null` included: a host
// that failed to boot is an answer (routes answer `RUNTIME_UNAVAILABLE`),
// never a licence to build a second one or to fall back to another path.

/**
 * The process-lifetime catalogue host, booted on first call.
 *
 * @returns {Promise<object|null>} The host (the same object
 *   `lib/acp-client.js#getCatalogueHost` returns), or `null` when the
 *   runtime failed to boot. Errors thrown by the getter propagate
 *   unchanged — callers own the failure mapping.
 */
export async function getEngineCatalogueHost() {
  const { getCatalogueHost } = await import("../lib/acp-client.js");
  return getCatalogueHost();
}
