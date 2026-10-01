// webui/server/lib/runtime-host.js
//
// In-process runtime host skeleton (S2 of the runtime-first migration).
//
// MIGRATION NOTE (engine-abstraction M1): the catalogue-host
// construction — the two hard-wired imports (`@mavis/local-runtime-v2`,
// `@minimax/code/runtime-adapter`) and the `createCatalogueHost` body —
// moved verbatim to server/engine/providers/local-runtime-v2.js,
// which also carries that surface's capability declaration. This file
// re-exports it so every existing importer (acp-client.js, the test
// suites, and module mocks registered against this path) is untouched.
// The per-turn host below stays here: it wraps a catalogue host rather
// than constructing one.
//
// Two hosts, matching design §4.1:
//
//   1. catalogue host — long-lived, exposes read-only operations
//      (listSessions, listModels, getSession, …). One per process;
//      replacing the `mcode acp` singleton for catalogue traffic.
//      Now constructed in engine/providers/local-runtime-v2.js.
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

// M1 verbatim-move re-export: same binding, new home. Importers of
// "./runtime-host.js" see no difference.
export { createCatalogueHost } from "../engine/providers/local-runtime-v2.js";

/** Maximum time `abortSession` will wait for the stream to terminate. */
const TURN_ABORT_BOUND_MS = 5_000;

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
 * @param {Awaited<ReturnType<typeof import("../engine/providers/local-runtime-v2.js").createCatalogueHost>>} catalogueHost
 * @returns {TurnHost}
 */
export function createTurnHost(catalogueHost) {
  if (!catalogueHost || !catalogueHost.adapter) {
    throw new Error("createTurnHost: catalogueHost.adapter is required");
  }
  const { adapter } = catalogueHost;
  const activeStreams = new Set();
  // Per-turn AbortController. Routes don't have to construct one per
  // call — the turn host owns the abort lifecycle for its turn, so a
  // call to abortSession always has a signal to trip. Callers that
  // bring their own signal (e.g. a request-scoped AbortController)
  // pass it to sendMessage and it replaces this one for that stream
  // only; the controller is still used for stream-iteration faults
  // that need a clean break.
  const turnController = new AbortController();

  /**
   * sendMessage: every throw becomes an error stream frame.
   * The wrapper never lets an exception escape the iterator boundary
   * — that's what "可弃化" means at the turn level (R1 mitigation).
   *
   * `signal` is the caller's optional signal. When present, it is
   * forwarded to the adapter; when absent, the turn host's own
   * controller provides one (so abortSession always has a signal to
   * trip and the adapter can still react to cancellation).
   */
  async function* safeSendMessage(req, signal) {
    const effectiveSignal = signal || turnController.signal;
    let stream;
    try {
      stream = adapter.sendMessage(req, effectiveSignal);
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
   * abortSession: bounded termination. Two complementary mechanisms:
   *   1. adapter.abortSession(req) — the runtime-side protocol abort;
   *      best-effort, may throw.
   *   2. turnController.abort() — fires the per-turn signal that
   *      sendMessage forwarded to the adapter. This is what trips
   *      any AbortSignal listener the adapter registered.
   * After both deliveries we wait for the active stream(s) to settle,
   * bounded at TURN_ABORT_BOUND_MS. The wait is a race — a wedged
   * runtime never settles the stream, so we MUST time out rather
   * than block the request indefinitely (R2 / R8 mitigation).
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
    // Fire the per-turn signal so listeners in the adapter wake up.
    if (!turnController.signal.aborted) {
      turnController.abort();
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
