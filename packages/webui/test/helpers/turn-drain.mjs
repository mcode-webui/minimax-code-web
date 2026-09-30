// webui/test/helpers/turn-drain.mjs
//
// Shared `afterEach` turn drain for the route checks that drive the REAL
// `routes/chat.js#handleSend` against a fake ACP transport.
//
// Why it exists
// -------------
// `beginRun` / `endRun` (server/lib/state-bus.js) keep a PROCESS-WIDE
// registry: `runsByCid` for the cid claim, `runsBySid` for the engine
// session claim. `activeRunCount()` reads `runsByCid.size` globally, and
// there is deliberately no reset hook — the registry is product code, and
// this helper must stay on the test side of that line.
//
// A check that aborts between `handleSend` and the turn's finalize leaves
// its turn parked on the fake transport. The route never reaches
// `finally { endRun(cid) }`, so the cid claim and the `mvs_fake_N` session
// claim stay registered, and the run's chat buffer stays seeded. Two
// things then go wrong for the following cases:
//
//   1. Their global `activeRunCount()` judgement reads a number that
//      includes a turn they never started, so ONE real failure cascades
//      into every following case — each blamed on a contract it did not
//      break.
//   2. The finalize that never ran persists the chat record LATE, after
//      the next case's `beforeEach` already deleted the sessions store, so
//      the abandoned case's turn lands in the next case's storage.
//
// `chat-run-mirror.check.mjs` and `chat-first-turn-session-guard.check.mjs`
// both drive that chain and both carried the full defect. The drain lives
// here so the next sibling file inherits the fix instead of rediscovering
// the evidence chain from scratch.
//
// The drain is a SAFETY NET, not the assertion. A case that abandons a
// turn still fails on its own assertions; what the net buys is that the
// damage stops at one red test instead of poisoning the rest of the file.
//
// Why nothing is reached for implicitly
// -------------------------------------
// The helper has no import of the transport, the registry, or the server:
// it is handed `activeRunCount` plus the two release actions, and does
// nothing else. The construction site therefore reads as the literal list
// of what that file can leave behind, and a file with no `session/new`
// gate simply omits `unblock`. Releasing in the wrong order is visible at
// the call site instead of being buried in a black box.

/**
 * Upper bound on how long `cleanup()` waits for an already-unblocked turn
 * to finish. Generous next to the 2s `waitFor` budgets these files poll
 * with, so a slow machine never trips it, and finite so a turn that
 * cannot be unblocked reports its own failure instead of hanging the file.
 */
export const DRAIN_TIMEOUT_MS = 5000;

/**
 * Build a per-file turn drain.
 *
 * @param {object} options
 * @param {() => number} options.activeRunCount
 *   Reads the process-wide run registry. Used as the post-condition only:
 *   after the drain, it must read 0.
 * @param {() => void} [options.unblock]
 *   Release every gate this file can park a turn behind — e.g. a parked
 *   `session/new`, which is upstream of any prompt, so it must be released
 *   FIRST. Idempotent. Omit when the file has no such gate.
 * @param {() => void} [options.releaseParkedPrompts]
 *   Release every prompt still parked on the file's fake transport. Must
 *   drain the queue, not release one entry.
 * @param {number} [options.timeoutMs] Bound on the await; see
 *   {@link DRAIN_TIMEOUT_MS}.
 * @param {string} [options.label] Names the file in a leak report.
 * @returns {{
 *   track: <T>(turn: Promise<T>) => Promise<T>,
 *   cleanup: () => Promise<void>,
 *   pending: () => number,
 * }}
 */
export function createTurnDrain({
  activeRunCount,
  unblock = () => {},
  releaseParkedPrompts = () => {},
  timeoutMs = DRAIN_TIMEOUT_MS,
  label = "turn-drain",
}) {
  if (typeof activeRunCount !== "function") {
    throw new TypeError("createTurnDrain: activeRunCount must be a function");
  }

  /** Turns started through `track()` that have not settled yet. */
  const live = new Set();

  /**
   * Register a promise `handleSend` returned so `cleanup()` can await it.
   * Returns the promise unchanged, so a call site reads as one expression:
   * `const turn = drain.track(handleSend(...))`.
   */
  function track(turn) {
    live.add(turn);
    // `.then` with BOTH arms rather than `.finally`: a `.finally` returns a
    // new promise that rejects when the turn does, and nothing would be
    // observing it by the time `cleanup()` stops tracking — an unhandled
    // rejection would take the whole run down.
    turn.then(
      () => live.delete(turn),
      () => live.delete(turn),
    );
    return turn;
  }

  /**
   * Unblock, release and await whatever this file left running, then assert
   * the registry is empty. Wire it as the suite's `afterEach`, so it also
   * runs after a case that threw — which is exactly the case that leaks.
   */
  async function cleanup() {
    // Order is load-bearing: a turn parked inside `session/new` has no
    // prompt to release yet, so the gate comes first; releasing the prompts
    // only unblocks turns that are already past the transport.
    unblock();
    releaseParkedPrompts();

    const turns = [...live];
    if (turns.length) {
      let timer;
      await Promise.race([
        Promise.allSettled(turns),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      live.clear();
    }

    // Post-condition, not a wait. Every tracked turn has settled, so a
    // non-zero count here can only mean a turn that was never tracked (or a
    // fake transport whose release did not reach finalize). Reporting it
    // beats a cascade of unexplained reds in the cases that follow.
    const remaining = activeRunCount();
    if (remaining !== 0) {
      throw new Error(
        `${label}: ${remaining} run(s) still registered after the turn drain — ` +
          "a case abandoned a turn without passing it to track()",
      );
    }
  }

  /** How many tracked turns have not settled. Diagnostics for a test body. */
  const pending = () => live.size;

  return { track, cleanup, pending };
}
