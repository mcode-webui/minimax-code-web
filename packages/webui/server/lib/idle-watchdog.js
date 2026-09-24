// webui/server/lib/idle-watchdog.js
// A repeating watchdog that fires only after a sustained period of NO
// activity — unlike setTimeout(idleMs), which measures wall-clock time from
// a fixed point and kills long-but-healthy streams.
//
// Used by the chat paths (mcode-acp / mcode-exec): agent turns legitimately
// run for minutes while thinking and calling tools, and every stream event
// refreshes the activity timestamp, so the watchdog only fires when the
// stream has actually gone silent for `idleMs`.

/**
 * @param {object} opts
 * @param {number} opts.idleMs          fire after this many ms without activity
 * @param {() => number} opts.activityAt last-activity timestamp (ms epoch)
 * @param {(idleMs: number) => void} opts.onTimeout
 * @param {() => number} [opts.now]     injectable clock (tests)
 * @param {number} [opts.minTickMs]     lower bound for re-check interval
 * @returns {{ stop(): void }}
 */
export function createIdleWatchdog({
  idleMs,
  activityAt,
  onTimeout,
  now = () => Date.now(),
  minTickMs = 250,
}) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    throw new Error(`idle-watchdog: idleMs must be a positive number, got ${idleMs}`);
  }
  if (typeof activityAt !== "function" || typeof onTimeout !== "function") {
    throw new Error("idle-watchdog: activityAt and onTimeout must be functions");
  }
  let stopped = false;
  let timer = null;
  const tickInterval = () =>
    Math.max(minTickMs, Math.min(5000, idleMs));
  function tick() {
    if (stopped) return;
    const idle = now() - activityAt();
    if (idle >= idleMs) {
      stopped = true;
      onTimeout(idle);
      return;
    }
    // Re-check soon, but no later than the remaining idle budget.
    const next = Math.max(minTickMs, Math.min(tickInterval(), idleMs - idle));
    timer = setTimeout(tick, next);
    // unref'd like the other long-lived timers in the server: the watchdog must
    // never be the reason the process stays alive.
    if (timer.unref) timer.unref();
  }
  timer = setTimeout(tick, tickInterval());
  if (timer.unref) timer.unref();
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
