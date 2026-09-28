// webui/server/lib/runtime-host.js
//
// In-process runtime host skeleton (S2 of the runtime-first migration).
// Today the webui server reaches the engine via `mcode acp` child
// processes (one long-lived singleton, one per turn). S2 lays the
// foundation to drop that boundary: a process-internal runtime host
// owns the same SQLite-backed CliService, callable in the same way
// as the ACP transport, but without spawn cost or per-turn IPC.
//
// Two hosts live here, matching design §4.1:
//
//   1. catalogue host — long-lived, exposes read-only operations
//      (listSessions, listModels, getSession, …). One per process;
//      replacing the `mcode acp` singleton for catalogue traffic.
//
//   2. turn host — per-turn, owns sendMessage / abortSession / steer.
//      Every turn wraps its conversation in this object. Exceptions
//      thrown by the runtime are caught at the turn boundary and
//      turned into an error-shaped stream frame, so a runtime-side
//      crash cannot take down the webui server (R1). `close()` is
//      fire-and-forget because the turn host owns no resources of its
//      own — it shares the underlying CliService with the catalogue
//      host.
//
// `MCODE_WEBUI_TRANSPORT` configures whether routes should *use* this
// host. S2 ships the host but leaves every route on its current
// transport; the switch is only wired into route handlers in S3+. The
// default is `acp` (== today). See docs/webui.md "Transport selection"
// for the full semantics.
//
// This file does NOT import server/lib/config.js on purpose: the
// runtime host is constructed with explicit options (dataDir etc.)
// rather than env reads at module-load time. That keeps the test
// suite simple — see test/server/runtime-host.test.js — and means
// multiple webui instances in one process (a long-lived concern for
// testing and embedders) do not fight over a single shared config.

import { createLocalRuntimeHostV2, getDefaultLocalRuntimeConfig } from "@mavis/local-runtime-v2";
import { readLocalRuntimeAuthContext } from "@mavis/config";
import { TuiRuntimeAdapter } from "@minimax/code/runtime-adapter";

// `createLocalRuntimeHostV2` returns `cliService` as an optional
// field — it is present after `host.ready` resolves and `ensureBuiltinAgents`
// has run. The catalogue host owns a single instance for its lifetime.

/** Maximum time `close()` will wait on apiHost.close() before giving up. */
const CATALOGUE_CLOSE_BOUND_MS = 5_000;
/** Maximum time `abortSession` will wait for the stream to terminate. */
const TURN_ABORT_BOUND_MS = 5_000;

// ---------------------------------------------------------------------------
// Auth context bridge
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Catalogue host — long-lived
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CatalogueHostOptions
 * @property {string} dataDir            Runtime data directory (the
 *                                       resolved v2 contract root, not
 *                                       the webui data dir).
 * @property {() => object} [configGetter]  Local-runtime config getter;
 *                                          defaults to the v2 default.
 * @property {string} [runtimeOwnerKind]  Defaults to "tui" — the runtime
 *                                       owner-kind taxonomy only
 *                                       recognises cli/tui for the
 *                                       embedded capability. Lease is
 *                                       keyed per-instance so this never
 *                                       collides with a concurrent
 *                                       `mcode acp` TUI.
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
 *   apiHost: { close: () => Promise<void> },
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
  // concurrent `mcode acp` TUI — see runtime.ts §2.1 of the migration
  // design.
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
    apiHost: host.apiHost,
    controller: host.controller,
    close,
  };
}

// ---------------------------------------------------------------------------
// Turn host — per-turn, share-nothing with the catalogue
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TurnHost
 * @property {(...args: any[]) => AsyncGenerator<unknown>} sendMessage
 *           Wrapped sendMessage: every thrown error becomes an
 *           `{type:'error', message}` stream frame so the consumer
 *           sees the failure as a turn-local event, not a process
 *           crash (R1).
 * @property {(req: object) => Promise<{success: boolean, elapsedMs: number}>} abortSession
 *           Calls adapter.abortSession, then waits up to
 *           TURN_ABORT_BOUND_MS for the active stream to settle.
 *           Always returns success=true (delivery semantics — see
 *           design R2); the elapsedMs field lets callers log wedge
 *           durations.
 * @property {() => void} close
 *           Fire-and-forget. The turn host owns no resources of its
 *           own; the catalogue host is responsible for the actual
 *           shutdown.
 */

/**
 * Create a per-turn wrapper around a catalogue host.
 *
 * `sendMessage` is wrapped: any throw from the underlying adapter
 * becomes an error stream frame (mutation target 1). `abortSession`
 * issues an abort, waits for the stream to settle within
 * TURN_ABORT_BOUND_MS, then resolves with delivery-confirmed
 * `{success:true, elapsedMs}` regardless of whether the stream had
 * time to drain — design R2 says we MUST NOT depend on subprocess
 * kill (there are no subprocesses anymore).
 *
 * @param {Awaited<ReturnType<typeof createCatalogueHost>>} catalogueHost
 * @returns {TurnHost}
 */
export function createTurnHost(catalogueHost) {
  if (!catalogueHost || !catalogueHost.adapter) {
    throw new Error("createTurnHost: catalogueHost.adapter is required");
  }
  const { adapter } = catalogueHost;
  const activeStreams = new Set();

  /**
   * sendMessage: every throw becomes an error stream frame.
   * The wrapper never lets an exception escape the iterator boundary
   * — that's what "可弃化" means at the turn level (R1 mitigation).
   */
  async function* safeSendMessage(req, signal) {
    let stream;
    try {
      stream = adapter.sendMessage(req, signal);
    } catch (err) {
      yield { type: "error", message: err && err.message ? err.message : String(err) };
      return;
    }
    activeStreams.add(stream);
    try {
      for await (const event of stream) {
        yield event;
      }
    } catch (err) {
      yield { type: "error", message: err && err.message ? err.message : String(err) };
    } finally {
      activeStreams.delete(stream);
    }
  }

  /**
   * abortSession: bounded termination. Returns success=true as soon
   * as the abort has been delivered (or the bound elapses). The
   * elapsedMs field captures the wait time so callers can detect
   * pathological slowness without holding the request open forever.
   */
  async function safeAbortSession(req) {
    const t0 = Date.now();
    let delivered = false;
    try {
      const r = await adapter.abortSession(req);
      delivered = r === true;
    } catch {
      delivered = false;
    }
    // Wait for the active stream to settle, bounded. We do NOT block
    // on `Promise.all([...activeStreams])` directly because that
    // promise can never resolve if the runtime wedges; we wait with a
    // race.
    if (activeStreams.size > 0) {
      const settle = Promise.all(
        Array.from(activeStreams).map(async (s) => {
          try {
            // Drain the iterator without consuming events. The
            // for-await loop throws a `done` once the iterator
            // completes; we ignore the value.
            // eslint-disable-next-line no-unused-vars
            for await (const _ of s) {
              /* drain */
            }
          } catch {
            /* iterator rejected — treat as settled */
          }
        }),
      );
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve("timeout"), TURN_ABORT_BOUND_MS),
      );
      await Promise.race([settle, timeout]);
    }
    return { success: true, delivered, elapsedMs: Date.now() - t0 };
  }

  function close() {
    // Fire-and-forget — the catalogue host owns the actual shutdown.
    // We only forget references here; nothing async, nothing blocking.
    activeStreams.clear();
  }

  return {
    sendMessage: safeSendMessage,
    abortSession: safeAbortSession,
    close,
  };
}
