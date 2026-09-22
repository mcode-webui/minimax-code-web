// webui/server/lib/port.js
// Listen-port selection for the standalone server.
//
// The default port is a preference, not a promise. Other dev servers and a
// webui left over from a previous run may already hold it, so the default port
// walks forward to the next free port instead of dying with EADDRINUSE.
//
// An explicitly configured port (the PORT env var, or `--port` through the
// `mcode webui` / `mcode-web` launcher) stays exact. Deployments that pin it
// cannot discover a fallback: docker publishes and healthchecks the configured
// port, and the integration tests dial the port they chose.
//
// This module only owns the mechanics. The port contract — the configured
// value, whether it is pinned, and the port actually serving — lives in
// config.js (PORT / PORT_PINNED / getServingPort).

/** Ports tried in total, including the configured one. */
export const MAX_PORT_ATTEMPTS = 20;

/**
 * True when `rawPort` is an explicit, usable PORT value.
 *
 * Unset, empty, `0`, and non-numeric values all mean "not configured": they
 * fall through to the default port, which may fall back. This mirrors
 * `Number(process.env.PORT) || 18090` in config.js.
 */
export function isPortPinned(rawPort) {
  return Number(rawPort) > 0;
}

/**
 * The port to try after `port` failed with EADDRINUSE, or `undefined` when
 * there is nothing left to try.
 *
 * `attempt` counts the ports already tried, so `port` itself is attempt 1.
 */
export function fallbackPort(port, attempt, maxAttempts = MAX_PORT_ATTEMPTS) {
  const next = port + 1;
  if (attempt >= maxAttempts || next > 65535) return undefined;
  return next;
}

/**
 * Listen on `port`, walking forward while the port is taken.
 *
 * Unless `pinned` is set, at most `maxAttempts` ports are tried. When pinned,
 * or once the budget is exhausted, `onUnavailable` receives the last listen
 * error and the caller decides how to exit — this helper never exits on its
 * own.
 *
 * `onListening` receives the port actually bound, which is not necessarily the
 * requested one: a fallback moves it.
 */
export function listenWithPortFallback(server, options) {
  const {
    port,
    host,
    pinned = false,
    maxAttempts = MAX_PORT_ATTEMPTS,
    onListening,
    onUnavailable,
    log = console,
  } = options;

  let attemptPort = port;
  let attempt = 1;

  const handleListening = () => {
    const address = server.address();
    const boundPort =
      address && typeof address === "object" ? address.port : attemptPort;
    onListening(boundPort);
  };

  const handleError = (error) => {
    const next =
      error && error.code === "EADDRINUSE" && !pinned
        ? fallbackPort(attemptPort, attempt, maxAttempts)
        : undefined;
    if (next !== undefined) {
      log.warn(`[webui] port ${attemptPort} is already in use — trying ${next}`);
      attemptPort = next;
      attempt += 1;
      // The server object is reusable after a failed listen; both handlers stay
      // attached, so the retry needs no rewiring.
      listen(next);
      return;
    }
    server.removeListener("listening", handleListening);
    server.removeListener("error", handleError);
    onUnavailable(error);
  };

  // `server.listen` validates the port and throws synchronously
  // (ERR_SOCKET_BAD_PORT) rather than emitting 'error' for an out-of-range or
  // non-integer value, so a bad PORT must reach the same terminal path —
  // otherwise it escapes to the global uncaughtException handler, which only
  // logs, leaving a live process that never listens.
  const listen = (target) => {
    try {
      server.listen(target, host);
    } catch (error) {
      handleError(error);
    }
  };

  server.on("listening", handleListening);
  server.on("error", handleError);
  listen(attemptPort);
}
