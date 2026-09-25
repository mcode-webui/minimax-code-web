// webui/server/lib/graceful-shutdown.js
//
// Bounded graceful shutdown for the dev / production backend.
//
// The default `server.close(cb)` waits for *every* active connection
// to close before invoking the callback. SSE / long-poll clients
// keep their connections open, and the dev watcher's SIGTERM landed
// on a server mid-cleanup would otherwise hang indefinitely — the
// process stayed alive but stopped accepting new connections, so the
// watcher saw it unresponsive and refused to spawn a replacement.
//
// This module installs:
//   - per-socket tracking so we know how many are still alive;
//   - a short grace window (GRACE_MS) during which in-flight handlers
//     may flush their SSE response, after which any remaining
//     sockets are forcibly destroyed so server.close()'s callback
//     can fire;
//   - a hard bound (HARD_EXIT_MS) that calls `process.exit(0)`
//     regardless, so a hang in any other cleanup path (transcript
//     poller, acp-client, an open handle we don't track) cannot
//     wedge the watcher.
//
// Idempotent: SIGINT + SIGTERM both fire on Ctrl+C under the
// watcher's process group, and the caller can pass either signal.
// `unref()` is called on the timers so a normal graceful shutdown
// (close callback fires within the grace window) does not leave a
// dangling ref keeping the process alive beyond `process.exit(0)`.

import { Socket } from "node:net";

const DEFAULT_GRACE_MS = 1500;
const DEFAULT_HARD_EXIT_MS = 4000;

/**
 * Install the bounded graceful-shutdown handler on `server`.
 *
 * Returns a function the caller can invoke to undo the wiring
 * (mostly useful for tests; production code never tears it down).
 *
 * @param {import("node:http").Server} server
 * @param {object} options
 * @param {(reason: string) => void} [options.onSignal]       — optional
 *   callback fired once with the signal name; used by tests to
 *   observe the shutdown sequence without intercepting logs.
 * @param {() => void} [options.stopTranscriptSync]           — no-op
 *   default; the backend's transcript poller calls this.
 * @param {() => void} [options.shutdownMcodeAcpSingleton]    — no-op
 *   default; the acp singleton kills its child subprocess here.
 * @param {number} [options.graceMs]                          — see
 *   DEFAULT_GRACE_MS.
 * @param {number} [options.hardExitMs]                       — see
 *   DEFAULT_HARD_EXIT_MS.
 * @param {(code: number) => void} [options.exit]              — default
 *   `process.exit`. Tests inject a recording function to avoid
 *   killing the test runner.
 */
export function installGracefulShutdown(server, options = {}) {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const hardExitMs = options.hardExitMs ?? DEFAULT_HARD_EXIT_MS;
  const stopTranscriptSync = options.stopTranscriptSync ?? (() => {});
  const shutdownMcodeAcpSingleton = options.shutdownMcodeAcpSingleton ?? (() => {});
  const onSignal = options.onSignal ?? (() => {});
  const exit = options.exit ?? ((code) => process.exit(code));

  const liveSockets = new Set();
  let shutdownStarted = false;

  const onConnection = (socket) => {
    liveSockets.add(socket);
    socket.on("close", () => {
      liveSockets.delete(socket);
    });
    // SSE / long-poll sockets must NOT keep the event loop alive
    // past server.close(). The dev watcher relies on this so a
    // SIGTERM doesn't hold the process open on a half-closed socket.
    if (typeof socket.unref === "function") socket.unref();
  };
  server.on("connection", onConnection);

  function shutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    onSignal(signal);
    // Cleanup callbacks must not throw past us — a thrown error in
    // either helper would skip the rest of the shutdown (close,
    // timer) and wedge the process. Swallow + carry on.
    try {
      stopTranscriptSync();
    } catch (error) {
      // The transcript poller is unref'd; an unhandled throw is
      // fatal but cannot kill a process that is already on the way
      // out. Log + carry on so the rest of the shutdown runs.
      // The bootstrap.js caller can install onSignal for
      // richer logging.
      try {
        console.warn(
          `[graceful-shutdown] stopTranscriptSync threw: ${error && error.message ? error.message : error}`,
        );
      } catch {
        // nothing to do
      }
    }
    try {
      shutdownMcodeAcpSingleton();
    } catch (error) {
      try {
        console.warn(
          `[graceful-shutdown] shutdownMcodeAcpSingleton threw: ${error && error.message ? error.message : error}`,
        );
      } catch {
        // nothing to do
      }
    }

    let exited = false;
    const doExit = () => {
      if (exited) return;
      exited = true;
      exit(0);
    };

    server.close(() => doExit());

    const graceTimer = setTimeout(() => {
      const remaining = liveSockets.size;
      for (const socket of liveSockets) {
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      }
      if (remaining > 0) {
        // No-op when there is nothing to destroy; the comment
        // exists so future readers know the destroy loop is the
        // cleanup step, not a counter increment.
        void remaining;
      }
    }, graceMs);
    if (typeof graceTimer.unref === "function") graceTimer.unref();

    const hardTimer = setTimeout(() => doExit(), hardExitMs);
    if (typeof hardTimer.unref === "function") hardTimer.unref();
  }

  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return function uninstall() {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    server.off("connection", onConnection);
  };
}

// Test sentinel — the test harness imports this to skip the actual
// process.exit call in unit tests.
export const __testOnly__ = {
  DEFAULT_GRACE_MS,
  DEFAULT_HARD_EXIT_MS,
  // A trivial export so the file is a module even when nothing
  // else is imported; helps bundlers / tree-shakers.
  Socket,
};