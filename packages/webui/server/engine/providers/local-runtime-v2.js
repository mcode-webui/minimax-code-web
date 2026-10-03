// webui/server/engine/providers/local-runtime-v2.js
//
// The local-runtime-v2 engine provider: the in-process runtime host
// (`@mavis/local-runtime-v2` CliService wrapped in a TuiRuntimeAdapter)
// plus its capability declaration.
//
// Provenance (engine-abstraction migration step M1, design doc §2.4):
// the host-construction code below — the two hard-wired imports and the
// `createCatalogueHost` body — moved here verbatim from
// server/lib/runtime-host.js, which now re-exports it. Every existing
// importer (acp-client.js, tests, module mocks registered against the
// runtime-host.js path) keeps working unchanged; module semantics are
// identical. The per-turn `createTurnHost` wrapper stays in
// runtime-host.js — it wraps a host rather than constructing one.
//
// The capability declaration is transcribed from the audited matrix in
// doc/engine-abstraction-design.md §1.2 (local-runtime-v2 column), with
// per-cell evidence in §1.3, re-verified against the live surfaces at the
// 26043e9b baseline (94 CliService methods + the
// applications.session.diff facade). Do not edit a level without
// re-auditing the source first; the snapshot tests in
// test/lib/engine/capabilities.test.js pin this object.

import { createLocalRuntimeHostV2, getDefaultLocalRuntimeConfig } from "@mavis/local-runtime-v2";
import { readLocalRuntimeAuthContext } from "@mavis/config";
import { TuiRuntimeAdapter } from "@minimax/code/runtime-adapter";

import { LOCAL_RUNTIME_V2_CAPABILITIES } from "./local-runtime-v2.capabilities.js";

// Re-exported so consumers of this module see the declaration next to
// the construction. The declaration itself lives in
// local-runtime-v2.capabilities.js — this module is the one that pulls
// the @mavis/* TypeScript tree, so it must stay off the boot path (see
// the capabilities file's header for the cost of getting this wrong).
export { LOCAL_RUNTIME_V2_CAPABILITIES };

// ---------------------------------------------------------------------------
// Host construction — moved verbatim from runtime-host.js (M1).
// ---------------------------------------------------------------------------

// `createLocalRuntimeHostV2` returns `cliService` as an optional
// field — it is present after `host.ready` resolves and `ensureBuiltinAgents`
// has run. The catalogue host owns a single instance for its lifetime.

/** Maximum time `close()` will wait on apiHost.close() before giving up. */
const CATALOGUE_CLOSE_BOUND_MS = 5_000;

/**
 * Build the auth-context getter the runtime calls on demand. Reads
 * the shared projection from the dataDir each invocation — equivalent
 * in freshness to the per-turn auth reload the acp subprocess used to
 * provide. When no auth exists, returns undefined (the runtime's own
 * code path then surfaces "not authenticated" to the caller, which is
 * the same behaviour as today's child-process path).
 */
function buildAuthContextGetter(dataDir) {
  return () => {
    try {
      return readLocalRuntimeAuthContext(dataDir) ?? undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * @typedef {object} CatalogueHostOptions
 * @property {string} dataDir            Runtime data directory (the
 *                                       resolved v2 contract root, not
 *                                       the webui data dir).
 * @property {() => object} [configGetter]  Local-runtime config getter;
 *                                          defaults to the v2 default.
 * @property {string} [runtimeOwnerKind]  Defaults to "tui" — the runtime
 *                                        owner-kind taxonomy only
 *                                        recognises cli/tui for the
 *                                        embedded capability. Lease is
 *                                        keyed per-instance so this never
 *                                        collides with a concurrent
 *                                        `mcode acp` TUI.
 */

/**
 * Construct the long-lived catalogue host. Boots an in-process
 * `CliService` wrapped by `TuiRuntimeAdapter` and ready for read-only
 * catalogue traffic. The returned object also exposes `close()` which
 * is bounded — see CATALOGUE_CLOSE_BOUND_MS.
 *
 * @param {CatalogueHostOptions} options
 * @returns {Promise<{
 *   adapter: TuiRuntimeAdapter,
 *   cliService: object,
 *   apiHost: { close: () => Promise<void> },
 *   controller: object,
 *   application: object|undefined,
 *   applications: { session: { diff: object }, queue: object }|undefined,
 *   services: object|undefined,
 *   close: () => Promise<void>,
 * }>}
 */
export async function createCatalogueHost(options) {
  if (!options || typeof options.dataDir !== "string" || options.dataDir.length === 0) {
    throw new Error("createCatalogueHost: options.dataDir is required");
  }
  const dataDir = options.dataDir;
  const configGetter = options.configGetter ?? getDefaultLocalRuntimeConfig;
  // The runtime owner-kind taxonomy only recognises `cli`/`tui` for the
  // embedded capability (see runtime.ts#isV2RuntimeOwner). The runtime
  // sees every embedded owner as equivalent for capability purposes;
  // the lease is keyed by instance-id so this never collides with a
  // concurrently running `mcode acp` TUI — see runtime.ts §2.1 of the
  // migration design.
  const runtimeOwnerKind = options.runtimeOwnerKind ?? "tui";

  const host = await createLocalRuntimeHostV2({
    dataDir,
    configGetter,
    runtimeOwnerKind,
    // We are not the TUI; we don't share the TUI's owner lease. The
    // lease file is keyed per-instance-id so this never collides with
    // a concurrently running `mcode acp` TUI.
    capabilities: { cliEmbedded: true },
    // Startup policy mirrors the TUI acp surface: don't auto-resume
    // persisted background work just because the webui booted.
    startupExecutionPolicy: "quarantined",
    // Auth is read on demand by the getter below. Passing undefined
    // here keeps boot unconditional; round-trip failures surface as
    // authRequired at the call site, which is the same behaviour as
    // the per-turn child process today.
    authContextGetter: buildAuthContextGetter(dataDir),
  });

  // The v2 host only attaches `cliService` once the readiness gate
  // passes; throw if the contract drifts.
  await host.ready;
  if (!host.cliService) {
    throw new Error(
      "createCatalogueHost: runtime did not expose cliService after ready",
    );
  }
  // Bring up the builtin agents the TUI acp surface brings up — the
  // catalogue host talks to the same catalog the chat path does.
  await host.apiHost.ensureBuiltinAgents();

  const adapter = new TuiRuntimeAdapter(host.cliService);

  // Bounded close: try to drain dependencies in order; if any link
  // hangs, give up at CATALOGUE_CLOSE_BOUND_MS so a wedged runtime
  // cannot wedge webui's graceful-shutdown path. R8 mitigation.
  let closing = null;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        const timeout = new Promise((resolve) =>
          setTimeout(() => resolve("timeout"), CATALOGUE_CLOSE_BOUND_MS),
        );
        const result = await Promise.race([host.apiHost.close(), timeout]);
        return result === "timeout" ? "timeout" : "ok";
      })();
    }
    return closing;
  };

  return {
    adapter,
    // Bare cliService, for callers with no adapter-level method to go
    // through. `/api/plugins/*` needs it: TuiRuntimeAdapter's plugin surface
    // (packages/tui/src/runtime/adapters/plugin-access.ts) exposes only four
    // TUI view methods and has no preview / import / listEnabled. The host
    // stays the single owner — consumers must not build a second one.
    cliService: host.cliService,
    apiHost: host.apiHost,
    controller: host.controller,
    // Process-local product facade (events / models / skills / plugins /
    // permissions / …). Same single-owner rule as cliService: consumers
    // must not build a second runtime.
    application: host.application,
    // Feature applications, including `session.diff` — the turn-diff use
    // case (getTurnDiff / revertTurnDiff / reapplyTurnDiff). It lives
    // here and NOT on `application`: the process-local facade declares
    // no diff member, so reading diff off `application` yields nothing.
    applications: host.applications,
    // The V2 owner graph, forwarded untouched. `application` /
    // `applications` are the PRODUCT use cases; several real
    // capabilities (`agent`, `managedWorktrees`, `pinService`, `mcp`,
    // `skill`, `modelSystem`) exist only on `services`, so a consumer
    // with no facade route to them has no window at all without this
    // member. `undefined` on a host that has no V2 compatibility slice
    // — never a synthesised empty object, so "no owner graph" and "owner
    // graph without member X" stay distinguishable. Same single-owner
    // rule as cliService: never build a second runtime to get one.
    services: host.services,
    close,
  };
}
