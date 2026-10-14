// webui/server/engine/goal-events.js
//
// The engine → SSE goal bridge (PB-14 batch B).
//
// The engine already publishes three global events for a thread goal
// (`thread_goal.updated` / `.cleared` / `.objective_updated_steering`,
// defined in `packages/shared/src/global-events.ts:344-350` and emitted
// from `packages/local-runtime/src/thread-goal/wiring.ts:28-56`), and it
// already hands them to any caller through `cliService.watchEvents(signal)`
// as an AsyncGenerator. webui subscribed to nothing: `watchEvents` had
// zero call sites in the server, so a goal created in the engine was
// invisible in every browser tab. This module is the missing subscription.
//
// WHAT THIS FILE IS NOT. It is not a goal client. It never creates,
// patches or clears a goal; those are batch A's five endpoints. It reads
// the event stream and writes the answer into per-tab client state, and
// `pushStateFor` puts it on the SSE channel webui already has — no second
// connection, no new endpoint.
//
// WHY THE SNAPSHOT IS THE ENGINE'S, VERBATIM. The desktop client consumes
// the same three events and hands the whole snapshot to its banner
// (`other-minimax-code/.../effect-reducer.ts:255-284` → `set-goal`). A
// narrowing projection here would be a second place to keep in step with
// `GlobalThreadGoal` and would silently drop a field the banner later
// needs; the wire field is therefore the engine's snapshot as it arrives,
// after validation, and the only thing invented is the `null` that means
// "no goal" (the engine's own spelling for the absence of a goal).
//
// WHY STEERING RE-READS. The engine's `thread_goal.objective_updated_steering`
// payload is `{sessionId, goalId}` — identifiers only
// (`global-events.ts:348-350`); unlike the desktop `objective_steering`
// variant it carries no snapshot. Writing `{sessionId, goalId}` into the
// frame would show the user a goal with no objective and no usage. The
// bridge therefore reads the authoritative snapshot back through
// `cliService.getGoal` — one read per steering event, and an event whose
// re-read finds nothing is treated as a clear, because that is what the
// store just said.

import { applyThreadGoalToClients } from "../lib/state-bus.js";
import { peekEngineCatalogueHost } from "./host.js";

/**
 * The three engine event names that carry goal state, and nothing else.
 * A bridge that forwarded unknown names would let any future global event
 * with a coincidentally shaped payload rewrite the goal frame.
 */
export const THREAD_GOAL_EVENT_TYPES = Object.freeze([
  "thread_goal.updated",
  "thread_goal.cleared",
  "thread_goal.objective_updated_steering",
]);

const THREAD_GOAL_EVENT_TYPE_SET = new Set(THREAD_GOAL_EVENT_TYPES);

/** A usable engine session id: a non-empty string. Anything else is an
 *  event the frame cannot be attributed to, and an unattributable write
 *  is a write to the wrong tab. */
function isSessionId(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * The minimum a `thread_goal.updated` payload must carry to be a goal.
 *
 * This is a shape gate, not a validation of the goal's semantics: the
 * engine owns the six-status state machine and the 26 status reasons, and
 * a webui-side status whitelist would be a second copy of it that goes
 * stale silently. What IS checked is the identity the frame is keyed by
 * plus the two fields every consumer reads first.
 */
export function isGoalSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    isSessionId(value.goalId) &&
    isSessionId(value.sessionId) &&
    typeof value.objective === "string" &&
    typeof value.status === "string"
  );
}

/**
 * Translate one engine global event into the write it implies.
 *
 * @param {unknown} event                      A `GlobalEventPayloadMap` member as the bus yields it
 * @param {(sessionId: string) => (object|null)} [readGoal]
 *   Authoritative snapshot read, used only for the steering event, whose
 *   payload carries identifiers and no goal.
 * @returns {{sessionId: string, goal: object|null}|null}
 *   The write to apply, or `null` when the event carries nothing this
 *   bridge forwards — an unknown type, a payload of the wrong shape, or a
 *   snapshot missing its identity. Dropping is the correct answer in all
 *   three cases: there is no partial frame that would be less wrong.
 */
export function goalEventToWrite(event, readGoal) {
  if (!event || typeof event !== "object") return null;
  const type = event.type;
  if (typeof type !== "string" || !THREAD_GOAL_EVENT_TYPE_SET.has(type)) return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  if (type === "thread_goal.updated") {
    const goal = payload.goal;
    if (!isGoalSnapshot(goal)) return null;
    // The session id is read from the snapshot, not from the envelope:
    // routing on the wrong one writes another conversation's goal into
    // this tab, which is the failure a goal frame must never have.
    return { sessionId: goal.sessionId, goal };
  }

  if (type === "thread_goal.cleared") {
    if (!isSessionId(payload.sessionId)) return null;
    return { sessionId: payload.sessionId, goal: null };
  }

  // thread_goal.objective_updated_steering — identifiers only, by design
  // of the engine (see the file header). Read the snapshot back.
  if (!isSessionId(payload.sessionId)) return null;
  const goal = typeof readGoal === "function" ? readGoal(payload.sessionId) : null;
  if (!isGoalSnapshot(goal)) return null;
  // The snapshot's own session id is authoritative; the envelope's only
  // had to be good enough to ask with.
  return { sessionId: goal.sessionId, goal };
}

/**
 * Read one goal snapshot without letting a missing goal capability turn
 * an event into an unhandled rejection. `getGoal` goes through the
 * engine's `requireCapability("goals", "Goal")` gate, which throws on a
 * host without the peripheral — a host that never enables goals must not
 * take the event pump down with it.
 */
function safeReadGoal(cliService, sessionId) {
  try {
    return cliService.getGoal(sessionId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Drain the engine event stream into the goal frame until `signal` aborts
 * or the generator ends.
 *
 * Deps are injected so this is testable without a runtime: production
 * passes the booted host's `cliService`.
 *
 * @param {object} options
 * @param {(signal: AbortSignal) => AsyncIterable<object>} options.watchEvents
 * @param {(sessionId: string) => (object|null)} options.readGoal
 * @param {(sessionId: string, goal: object|null) => string[]} [options.write]
 *   Per-tab write; defaults to the state-bus chokepoint.
 * @returns {Promise<void>} Resolves when the stream ends (abort or error).
 */
export async function pumpGoalEvents({ watchEvents, readGoal, write }) {
  const apply = write || applyThreadGoalToClients;
  try {
    for await (const event of watchEvents()) {
      const write0 = goalEventToWrite(event, readGoal);
      if (!write0) continue;
      apply(write0.sessionId, write0.goal);
    }
  } catch (e) {
    // An aborted subscription throws AbortError by contract; anything else
    // is logged once and ends this pump. `ensureGoalEventBridge` retries on
    // the next SSE connect, so a transient engine failure costs one
    // reconnect, not the process.
    if (e && e.name !== "AbortError") {
      console.warn(`[webui] goal event bridge stopped: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Production wiring — one subscription per process.
// ---------------------------------------------------------------------------

let _bridge = null; // { controller, promise } while a pump is running
let _starting = false;

/**
 * Start the bridge if it is not already running, WITHOUT booting a runtime.
 *
 * `peekEngineCatalogueHost` is the deliberate choice and the reason this
 * can be called from the SSE connect path: `engine/host.js` records that a
 * read may only use what is already up, because a read that boots a
 * runtime turns a page's first paint into a multi-second stall (PB-1 paid
 * for the other half of that decision with a 10 s `/api/state` timeout).
 * With no host up — the default `acp` transport, where the turn and its
 * goal live in an `mcode acp` subprocess — this is a no-op that returns
 * false, and the tab sees an unchanged `threadGoal: null` rather than an
 * error.
 *
 * Idempotent and cheap: repeated SSE connects while a pump is running
 * return true without touching the runtime. A failed previous attempt
 * leaves the bridge free to try again on the next connect.
 *
 * @param {object} [options]
 * @param {() => Promise<object|null>} [options.getHost] Host seam; defaults
 *   to `peekEngineCatalogueHost`. Tests inject a fake host so the no-host
 *   branch is exercised without booting anything.
 * @returns {Promise<boolean>} true when a subscription is running.
 */
export async function ensureGoalEventBridge(options = {}) {
  if (_bridge) return true;
  if (_starting) return false;
  const getHost = options.getHost || peekEngineCatalogueHost;
  _starting = true;
  try {
    const host = await getHost();
    if (!host) return false;
    const cliService = host && host.cliService;
    if (!cliService || typeof cliService.watchEvents !== "function") return false;
    const controller = new AbortController();
    const bridge = { controller, promise: null };
    bridge.promise = pumpGoalEvents({
      watchEvents: () => cliService.watchEvents(controller.signal),
      readGoal: (sessionId) => safeReadGoal(cliService, sessionId),
    }).finally(() => {
      if (_bridge === bridge) _bridge = null;
    });
    _bridge = bridge;
    return true;
  } catch (e) {
    console.warn(`[webui] goal event bridge could not start: ${e.message}`);
    return false;
  } finally {
    _starting = false;
  }
}

/** Stop the bridge. Used by shutdown and by tests; a no-op when idle. */
export function stopGoalEventBridge() {
  const bridge = _bridge;
  if (!bridge) return false;
  _bridge = null;
  try {
    bridge.controller.abort();
  } catch {
    /* an aborted controller cannot abort again */
  }
  return true;
}

/** True when a subscription is live. Test seam. */
export function isGoalEventBridgeRunning() {
  return _bridge !== null;
}