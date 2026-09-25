// webui/server/lib/transcript-sync.js
//
// Keep the browser's transcript in step with the mcode runtime database.
//
// The switch path (routes/sessions.js) backfills `cs.chat` from the runtime DB,
// but only when the wrapper has no chat yet — and nothing re-reads it afterwards.
// A session driven by another client (the desktop app, the TUI, another agent)
// therefore stays frozen in the browser at whatever the DB held when the user
// switched, until they switch away and back. That is the reported "数据也不刷新":
// the page was showing the transcript as of the switch.
//
// This module closes that gap with a bounded poll. For each client that has an
// open SSE stream it re-reads the active session's transcript and pushes state
// only when the stored lines genuinely changed. It never runs while this client
// is producing a turn locally, so a local stream is never clobbered mid-answer,
// and the read reuses the switch path's own loader (same probes, same caps), so
// the two can never disagree about the transcript grammar.
//
// Cost: one indexed read of the runtime DB per watching client per tick. Tabs
// without an SSE stream are skipped, which is the common case for a closed or
// backgrounded page. MCODE_WEBUI_TRANSCRIPT_SYNC_MS=0 disables the poll.

import { MCODE_RUNTIME_DB } from "./config.js";
import { persistCurrentChat } from "./sessions.js";
import { clients, getActiveChild, getSseClient, pushStateFor } from "./state-bus.js";
import { loadTranscriptChatLines } from "./transcript.js";

/** How often the poll runs. 4s keeps a browser tab within a few seconds of the engine. */
export const DEFAULT_TRANSCRIPT_SYNC_MS = 4000;

const parsed = Number(process.env.MCODE_WEBUI_TRANSCRIPT_SYNC_MS ?? DEFAULT_TRANSCRIPT_SYNC_MS);
export const TRANSCRIPT_SYNC_MS =
  Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TRANSCRIPT_SYNC_MS;

/** Only real mcode session ids have a transcript to read. */
const MVS_SESSION_ID = /^mvs_[a-f0-9]{32}$/;

// session-isolation/06 (Item 3 — wedge healing): a tab can sit with
// `cs.running.active=true` forever if the backend received SIGTERM
// mid-stream — see the graceful-shutdown ticket for the cause. The
// transcript-sync poller must NOT skip such a tab forever, otherwise
// the polluted buffer persists across view reloads. Define a stuck-
// run threshold (5 minutes — comfortably longer than any realistic
// model latency) and let the DB-rebuild path run when the last
// delta is older than that AND there is no live ACP child to write
// the next line. The threshold is configurable for tests.
const DEFAULT_WEDGED_RUN_MS = 5 * 60 * 1000;
// Local binding first — the alias below only re-exports this same
// value. Without the local binding the wedge branch below would
// throw "TRANSCRIPT_SYNC_WEDGED_MS is not defined" on every tick
// that hits a stale tab, which (a) prevents the wedge healing from
// running AND (b) aborts the whole sync pass so even tabs that
// would normally sync cleanly stop syncing while any tab is
// mid-turn. The earlier commit shipped that bug (the unit tests
// passed because they read the exported alias; the internal
// reference was the broken one).
const TRANSCRIPT_SYNC_WEDGED_MS = (() => {
  const env = Number(process.env.MCODE_WEBUI_TRANSCRIPT_WEDGED_MS);
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_WEDGED_RUN_MS;
})();
export { TRANSCRIPT_SYNC_WEDGED_MS as wedgedRunMs };

/**
 * Did the stored transcript move?
 *
 * Line count plus the last line is the cheap, decisive check: a session that is
 * still being written to changes its tail on every event, while a finished one is
 * byte-identical between ticks. Comparing only the tail is deliberate — a rewrite
 * that touches only older lines is not something this server produces, and the
 * full compare would mean hashing 200KB every 4s.
 */
export function transcriptChanged(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return true;
  if (prev.length !== next.length) return true;
  if (next.length === 0) return false;
  return prev[prev.length - 1] !== next[next.length - 1];
}

/**
 * One pass over every watching client.
 *
 * Exported for tests and for a manual nudge; the interval below just calls it.
 * Returns the cids it refreshed, so a caller (or a test) can assert on the work
 * rather than on log output.
 */
export function syncTranscriptsOnce({ dbPath = MCODE_RUNTIME_DB } = {}) {
  const refreshed = [];

  for (const [cid, cs] of clients) {
    if (!cs) continue;
    // A tab that is not streaming state is not looking at a transcript.
    if (!getSseClient(cid)) continue;
    if (!MVS_SESSION_ID.test(cs.mcodeSessionId || "")) continue;
    // A local turn owns `cs.chat` until it finishes: streaming writes lines the
    // DB does not have yet, and a concurrent read would roll them back.
    //
    // session-isolation/06 (wedge healing): the `active` flag can stick
    // `true` forever if the backend received SIGTERM mid-stream and
    // the active-child registry was not cleared (see the
    // graceful-shutdown ticket). Without the wedge exception below,
    // a wedged tab keeps the polluted chat and transcript-sync never
    // recovers it. The exception fires when:
    //   - cs.running.active is true (looks wedged)
    //   - AND the last delta is older than TRANSCRIPT_SYNC_WEDGED_MS
    //     (no stream activity for >5 min by default)
    //   - AND there is no live ACP child to write the next line
    // An active real run (lastDeltaAt recent) still skips; a wedged
    // run (stale lastDeltaAt, no active child) heals.
    if (cs.running && cs.running.active) {
      const lastDelta =
        (cs.running && cs.running.lastDeltaAt) ||
        (cs.running && cs.running.startedAt) ||
        0;
      const stale = lastDelta
        ? Date.now() - lastDelta > TRANSCRIPT_SYNC_WEDGED_MS
        : true;
      if (stale && !getActiveChild(cid)) {
        // fall through to the heal path below
      } else {
        continue;
      }
    } else if (getActiveChild(cid)) {
      continue;
    }

    let read;
    try {
      read = loadTranscriptChatLines(cs.mcodeSessionId, { dbPath });
    } catch (error) {
      // The DB can be locked or mid-migration; a failed tick is not fatal and
      // the next one retries. Never surface this as a UI error.
      console.warn(
        `[transcript-sync] read failed for ${String(cs.mcodeSessionId).substring(0, 12)}…:`,
        error && error.message ? error.message : error,
      );
      continue;
    }
    if (!read || !read.ok || !Array.isArray(read.lines)) continue;
    if (!transcriptChanged(cs.chat, read.lines)) continue;

    const before = Array.isArray(cs.chat) ? cs.chat.length : 0;

    // Never shrink the view through the byte cap.
    //
    // The loader keeps the last 400 lines *within 200KB*, so while an engine is
    // mid-answer on a very large message that single line eats the whole budget
    // and the mapping collapses to a few dozen lines. Applying that here would
    // make the open tab watch its own history disappear and reappear as the turn
    // progresses (observed: 399 → 397 → 44). A capped read that would drop lines
    // is therefore skipped and the next tick — once the message is finalised —
    // brings the real content. Re-switching still shows the capped view, which is
    // the switch path's existing behaviour.
    if (read.truncated && read.lines.length < before) {
      console.log(
        `[transcript-sync] cid=${cid} ${String(cs.mcodeSessionId).substring(0, 12)}… skip capped read that would shrink ${before} → ${read.lines.length} lines`,
      );
      continue;
    }

    cs.chat = read.lines;
    try {
      persistCurrentChat(cs);
    } catch (error) {
      // Persisting is an optimisation for the next page load; the push below is
      // what the open tab needs, so a write failure must not abort the refresh.
      console.warn("[transcript-sync] persist failed:", error && error.message ? error.message : error);
    }
    pushStateFor(cid, { reason: "transcript-sync" });
    refreshed.push(cid);
    console.log(
      `[transcript-sync] cid=${cid} ${String(cs.mcodeSessionId).substring(0, 12)}… lines ${before} → ${read.lines.length} (msgs=${read.messageCount})`,
    );
  }

  return refreshed;
}

/**
 * Start the poll. Returns a stop function; a non-positive interval disables it,
 * which is what MCODE_WEBUI_TRANSCRIPT_SYNC_MS=0 asks for.
 */
export function startTranscriptSync({ intervalMs = TRANSCRIPT_SYNC_MS } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.log("[transcript-sync] disabled");
    return () => {};
  }
  const timer = setInterval(() => {
    try {
      syncTranscriptsOnce();
    } catch (error) {
      // A tick must never take the server down.
      console.warn("[transcript-sync] tick failed:", error && error.message ? error.message : error);
    }
  }, intervalMs);
  // Never hold the process open on the poll alone.
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[transcript-sync] polling every ${intervalMs}ms`);
  return () => clearInterval(timer);
}
