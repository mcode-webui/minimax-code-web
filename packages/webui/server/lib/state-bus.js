// webui/server/lib/state-bus.js
// Per-cid state + SSE channel management.

import { DEFAULT_WORKSPACE, DEFAULT_MODEL, MAX_CONCURRENT } from "./config.js";
import { isFirstRun } from "./auth.js";
import { loadSessions } from "./sessions.js";
import {
  getCachedMcodeCommands,
  getMcodeSessionsForWorkspace,
  getMcodeSessionsCacheSync,
  getMcodeSessionsStaleSync,
} from "./acp-client.js";
import {
  getCurrentToken,
  getLanBroadcast,
  getReadOnly,
  getTokenAcknowledged,
  getTokenEnabled,
  getTokenRotatedAt,
} from "./settings.js";

// Each webui tab is a separate client (cid from localStorage
// `webui_cid`); each client owns its own state (chat / mcodeSessionId /
// context / usage / running), active child, and SSE connection. Requests
// without a cid fall back to a 'default' client.

// pushAlert re-export — chokepoint-friendly alias. Routes that need
// to surface a system signal (chat errors, subprocess crash, token
// expiry, etc.) call this rather than importing alerts.js directly.
// The chokepoint pattern (only state-bus touches per-cid state)
// extends naturally: only state-bus touches the alert bus too.
// alerts.js remains the pure module; state-bus is the wire.
export { pushAlert } from "./alerts.js";

export function makeClientState() {
  return {
    version: "1.0", // 顶栏显示 "v" + version
    workspace: { dir: DEFAULT_WORKSPACE, branch: null, tree: null },
    model: { name: DEFAULT_MODEL, thinking: "On", ctx: "512k" },
    sessionId: null, // webui 侧边栏 session id (randomUUID)
    mcodeSessionId: null, // mcode acp/exec 自己的 session id (mvs_xxx)
    sessionTitle: "Untitled",
    // "最近 active session 所属工作区" — independent of state.workspace.dir.
    // Switching session no longer mutates workspace.dir (which used to
    // pin that workspace's group at the top of the sidebar forever);
    // it updates lastUsedWorkspace instead.
    lastUsedWorkspace: null,
    context: {
      tokens: 0,
      used: 0,
      percent: 0,
      limit: 512000,
      tps: 0,
      thinkingStatus: "Idle",
      thinkingDuration: null,
      lastUsageAt: null,
      // Per-section breakdown (SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS
      // / MESSAGES / OTHER). The upstream engine does not currently
      // emit this, so default null; the UI only renders the segmented
      // progress + breakdown rows when it is non-empty.
      breakdown: null,
      // Plan-usage row. Populated when engine/server emits it; null
      // until then.
      plan: null,
    },
    usage: {
      plan: null,
      planExpiresAtMs: null,
      creditBalance: null,
      fiveHourPercent: null,
      fiveHourReset: null,
      weekly: null,
      weeklyReset: null,
      sessionInput: 0,
      sessionOutput: 0,
      sessionTotal: 0,
      raw: null,
      fetchedAt: null,
      error: null,
    },
    permissions: "Full access",
    chat: [],
    sessions: [],
    goal: { active: false, text: null, status: null, duration: null },
    todo: [],
    ask: {
      active: false,
      total: 0,
      answered: 0,
      currentIdx: 0,
      question: "",
      options: [],
      // multiSelect defaults to false on the inactive state so the
      // AskModal's defensive `ask.multiSelect === true` check falls
      // through to single-select when no ask is active. Populated
      // with the real value (normalised to boolean) by
      // tool-ask-user.js#setAskPending and #hydrateAskFromQuestions
      // when an ask lands.
      multiSelect: false,
    },
    plan: { active: false, title: null, summary: "", options: [] },
    running: {
      active: false,
      prompt: null,
      pid: null,
      startedAt: null,
      model: null,
      sessionId: null,
      lastDeltaAt: null,
      tps: 0,
    },
  };
}

export const clients = new Map(); // cid -> clientState
export const sseByCid = new Map(); // cid -> SSE response
export const activeChildByCid = new Map(); // cid -> child process

// A fresh client (page reload, new tab) must resume the conversation it
// was in. Binds the fresh client to the most recent session in its
// workspace (sessions.json is the persisted store); the "+" new-session
// flow still wins because it creates the newest record.
function restoreLatestSession(cs) {
  try {
    const all = loadSessions();
    if (!Array.isArray(all) || all.length === 0) return;
    const ws = (cs.workspace && cs.workspace.dir) || "";
    const candidates = all
      .filter((s) => {
        if (!s) return false;
        // Legacy records have no workspace field — they belong to the
        // default workspace by construction (single-workspace era).
        const sw = s.workspace || "";
        return sw === ws || (!sw && ws === DEFAULT_WORKSPACE);
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const latest = candidates[0];
    if (!latest || !latest.id) return;
    cs.sessionId = latest.id;
    cs.mcodeSessionId = latest.mcodeSessionId || null;
    cs.sessionTitle = latest.title || "Untitled";
    cs.chat = Array.isArray(latest.chat) ? [...latest.chat] : [];
  } catch (e) {
    // Never let a corrupted store block client creation — fresh empty state.
    console.warn(`[state-bus] restoreLatestSession failed: ${e.message}`);
  }
}

export function getClient(cid) {
  if (!cid) cid = "default";
  if (!clients.has(cid)) {
    const cs = makeClientState();
    restoreLatestSession(cs);
    clients.set(cid, cs);
  }
  return clients.get(cid);
}

export function getCidFromReq(req) {
  try {
    const u = new URL(req.url, "http://x");
    return u.searchParams.get("cid") || "";
  } catch {
    return "";
  }
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

// The sessions list in a snapshot is sidebar metadata only — the
// frontend never reads session.chat from state.sessions (the chat area
// hydrates from state.chat / the switch response). Strip the chat arrays
// so long thinking turns don't ship the entire history on every push.
// The chat-stripped projection of the session store, for anything that puts
// `sessions` into a client-facing payload.
//
// This is exported because it is not only for the push path: `routes/state.js`
// builds the `/api/state` body and the SSE connection's first frame, and both
// used to call `loadSessions()` directly, which put every session's full `chat`
// array on the wire. The helper had been added here and applied to the two
// state-bus push sites; those two call sites in `routes/state.js` were missed,
// so the leak survived the fix. `routes/state.js` is a *different file* from
// this one, which is exactly why a helper beats remembering to filter.
export function sessionsListForSnapshot() {
  return loadSessions().map((s) => ({
    id: s.id,
    title: s.title,
    mcodeSessionId: s.mcodeSessionId,
    workspace: s.workspace,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    // qa (session-workspace-crud): titleCustom 随快照下发 — 前端 sidebar 对
    //   mcode 条目 merge 时靠它判定"用户改名优先于 mcode 自动标题"。
    titleCustom: s.titleCustom === true ? true : undefined,
  }));
}

// pushStateFor: push state for the given cid (or '__broadcast__' for all).
//   opts.lanBroadcast: current LAN broadcast state (injected from settings.js)
//   opts.mcodeSessions: pre-filtered mcode sessions (injected from acp-client.js)
// On cache miss, fire-and-forget a fetch and auto-push the authoritative
// result to every SSE client.
// Pushes carry an `mcodeSessionsPending` marker — placeholder pushes
// (cache-miss empty array) are true, authoritative pushes are false.
// A failed fetch still pushes a terminal state (otherwise the client's
// sidebar-ready gate waits forever for the authoritative value and
// loading stalls).
const _mcodeSessionsFetchPending = new Set(); // workspace keys currently being fetched
function ensureMcodeSessionsFetchedAndPush(workspace) {
  if (_mcodeSessionsFetchPending.has(workspace)) return;
  _mcodeSessionsFetchPending.add(workspace);
  const pushAuthoritative = () => {
    for (const [c, res] of sseByCid) {
        const ccs = clients.get(c) || makeClientState();
        const cws = (ccs.workspace && ccs.workspace.dir) || "";
        // Authoritative push prefers fresh cache, falls back to stale
        // (same-ws, TTL-expired) — avoids flashing an empty list.
        const cached =
          getMcodeSessionsCacheSync(cws) ??
          getMcodeSessionsStaleSync(cws) ??
          [];
      const snapshot = {
        ...ccs,
        // qa (session-workspace-crud): 复用瘦身投影 — 这条权威推送路径原来
        //   直接 loadSessions()，把每个 session 的完整 chat 数组推进 SSE，
        //   是 v2.3 修掉的主负载；两处（本处 + pushOnlineCount）漏改。
        sessions: sessionsListForSnapshot(),
        mcodeSessions: cached,
        mcodeSessionsPending: false,
        availableCommands: getCachedMcodeCommands(),
        onlineCount: sseByCid.size,
        lanBroadcast: getLanBroadcast(),
        readOnly: getReadOnly(),
        tokenEnabled: getTokenEnabled(),
        // currentToken is only sent while un-acknowledged (shrinks
        // the secret-exposure window).
        currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
        tokenAcknowledged: getTokenAcknowledged(),
        tokenRotatedAt: getTokenRotatedAt(),
      };
      // Routed through the 60Hz coalescer — multiple authoritative
      // pushes within STATE_PUSH_THROTTLE_MS collapse to one write
      // per cid.
      _schedulePush(c, JSON.stringify(snapshot), res);
    }
  };
  getMcodeSessionsForWorkspace(workspace)
    .then(() => {
      _mcodeSessionsFetchPending.delete(workspace);
      pushAuthoritative();
    })
    .catch((e) => {
      _mcodeSessionsFetchPending.delete(workspace);
      console.warn(
        `[webui] ensureMcodeSessionsFetchedAndPush failed: ${e.message}`,
      );
      pushAuthoritative(); // still push terminal state (current cache; empty array is legal)
    });
}

export function pushStateFor(cid, opts = {}) {
  const lanBroadcast =
    opts.lanBroadcast !== undefined ? opts.lanBroadcast : getLanBroadcast();
  const cachedCmds = getCachedMcodeCommands();

  if (cid === "__broadcast__") {
    for (const [c, res] of sseByCid) {
      const ccs = clients.get(c) || makeClientState();
      const cws = (ccs.workspace && ccs.workspace.dir) || "";
      const fields =
        opts.mcodeSessions !== undefined
          ? { mcodeSessions: opts.mcodeSessions, mcodeSessionsPending: false }
          : mcodeSessionsSnapshotFields(cws);
      const snapshot = {
        ...ccs,
        sessions: sessionsListForSnapshot(),
        ...fields,
        availableCommands: cachedCmds,
        onlineCount: sseByCid.size,
        lanBroadcast,
        readOnly: getReadOnly(),
        tokenEnabled: getTokenEnabled(),
        currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
        tokenAcknowledged: getTokenAcknowledged(),
        tokenRotatedAt: getTokenRotatedAt(),
      };
      // Coalesced write — N broadcasts within the throttle window
      // collapse to ONE write per cid (last call's snapshot wins).
      _schedulePush(c, JSON.stringify(snapshot), res);
    }
    return;
  }
  const cs = getClient(cid);
  // Push stale cache (pending=true) when fresh is unavailable; never
  // push an empty placeholder (a stale list is better than a flash
  // to nothing while the authoritative fetch is in flight).
  const fields =
    opts.mcodeSessions !== undefined
      ? { mcodeSessions: opts.mcodeSessions, mcodeSessionsPending: false }
      : mcodeSessionsSnapshotFields((cs.workspace && cs.workspace.dir) || "");
  // Inject sessions list from disk db so the sidebar "recent sessions"
  // is never clobbered by an SSE push that happens to have an empty
  // mcodeSessions fetch in flight.
  const snapshot = {
    ...cs,
    sessions: sessionsListForSnapshot(),
    ...fields,
    availableCommands: cachedCmds,
    onlineCount: sseByCid.size,
    lanBroadcast,
    readOnly: getReadOnly(),
    tokenEnabled: getTokenEnabled(),
    currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
    tokenAcknowledged: getTokenAcknowledged(),
    tokenRotatedAt: getTokenRotatedAt(),
  };
  const payload = JSON.stringify(snapshot);
  const res = sseByCid.get(cid);
  // 60Hz coalescing — multiple pushStateFor() calls for the same cid
  // within STATE_PUSH_THROTTLE_MS collapse to ONE SSE write.
  // Diff mode: if the payload is byte-identical to the last write,
  // the client receives nothing (no full-state replace, no DOM thrash).
  _schedulePush(cid, payload, res);
}

// Unified mcodeSessions snapshot field construction — every SSE push
// point must include both fields. Push stale (pending=true) when fresh
// is unavailable; never push an empty placeholder. (Stale values are
// better than nothing while the authoritative fetch is in flight.)
export function mcodeSessionsSnapshotFields(workspace) {
  const ws = workspace || "";
  const cached = getMcodeSessionsCacheSync(ws);
  if (cached !== null) {
    return { mcodeSessions: cached, mcodeSessionsPending: false };
  }
  ensureMcodeSessionsFetchedAndPush(ws);
  const stale = getMcodeSessionsStaleSync(ws);
  if (stale !== null) {
    return { mcodeSessions: stale, mcodeSessionsPending: true };
  }
  return { mcodeSessions: [], mcodeSessionsPending: true };
}

// 60Hz SSE coalescing + diff mode.
//
// _schedulePush(cid, payloadStr, res) routes an SSE write through a
// per-cid diff gate. The diff gate compares the incoming payload
// against the last written payload for this cid (byte-identical JSON).
// If identical, the write is suppressed — no full-state JSON goes out,
// the client doesn't render() against identical bytes, no DOM thrash.
//
// When STATE_PUSH_THROTTLE_MS > 0, the diff gate is gated by a time
// window as well. Subsequent pushes within the window are stored as
// "pending" — when the window expires, the LAST pending payload is
// written (last-call-wins). The first push in any window writes
// synchronously (preserves the existing sync-write contract that
// callers like runUsageQuery rely on). The 16ms default targets 60Hz,
// matching common display refresh rates so the client render loop
// never starves.
//
// STATE_PUSH_THROTTLE_MS env var: configurable throttle window.
// Default 16ms. Set to 0 to disable the time-based throttle (every
// push writes synchronously — useful for tests that depend on the
// pre-coalescer contract, and for low-latency debugging). The diff
// gate is always active regardless.
//
// Named SSE events (auth.token_rotated / token.first_run /
// needs_authorization / authorization_decided) keep their
// immediate-write path — low-frequency, latency-sensitive, never go
// through the coalescer. Wire format is unchanged: the client still
// receives full state, not diffs. The diff check is purely a
// "should I emit this byte?" decision; payload structure is
// identical to pre-coalescer.

export const STATE_PUSH_THROTTLE_MS = Math.max(
    0,
    Number(process.env.STATE_PUSH_THROTTLE_MS) || 0,
);

// cid -> { payloadStr, res } — pending payload (last-call-wins within window)
const _pendingByCid = new Map();
const _flushTimers = new Map();
const _lastWriteTsByCid = new Map();
// JSON string of the last payload that was successfully written
const _lastPushedByCid = new Map();
// res reference of the last successful write. When it differs from the
// res we're about to write to, treat as a fresh SSE connection (the
// new client hasn't seen the prior writes), discard the diff cache
// and write unconditionally. Tests that do `sseByCid.set(cid, fakeSse())`
// directly create a new fakeSse each time, so this naturally resets.
const _lastPushedResByCid = new Map();

function _writeNow(cid, payloadStr, res) {
    // qa (OOM hardening): 写入前做背压/死套接字判断。状态推送是全量快照，
    //   被丢弃的一帧会被下一帧取代 —— 积压时丢弃是安全的；之前无背压
    //   res.write 在慢客户端上让 Node socket 写缓冲无界增长（长任务的
    //   高频全量快照可堆到 GB 级）。注意：跳过时不写 diff 缓存，同一
    //   payload 在套接字排空后重推仍会真正落线。
    if (!res || res.writableEnded || res.destroyed) return;
    if (res.writableNeedDrain) return;
    _lastWriteTsByCid.set(cid, Date.now());
    _lastPushedByCid.set(cid, payloadStr);
    _lastPushedResByCid.set(cid, res);
    try {
        res.write(`data: ${payloadStr}\n\n`);
    } catch {}
}

// Test-only: inspect the res reference retained for fresh-client
// detection. Used by checks/lib-state-bus.check.mjs to verify
// endSseClient drops dead response objects (OOM hardening).
export function peekLastPushedRes(cid) {
    return _lastPushedResByCid.get(cid);
}

function _schedulePush(cid, payloadStr, res) {
    if (!res) return; // no client to write to (cid without SSE)

    // Fresh-client detection: if the stored res differs from the
    // current res, treat as a brand-new SSE connection. The previous
    // writes went to a different res (or no res at all if this is the
    // first connection), so the diff cache must be discarded —
    // otherwise the new client would silently miss its very first
    // state. Tests that re-bind a cid's res between cases hit this
    // branch automatically.
    const cachedRes = _lastPushedResByCid.get(cid);
    if (cachedRes !== res) {
        // Drop any pending push + timer for this cid — they're stale
        // (would go to the wrong res or never get scheduled right).
        const oldTimer = _flushTimers.get(cid);
        if (oldTimer) {
            try {
                clearTimeout(oldTimer);
            } catch {}
            _flushTimers.delete(cid);
        }
        _pendingByCid.delete(cid);
        _lastWriteTsByCid.delete(cid);
        _lastPushedByCid.delete(cid);
        // Write immediately, unconditionally. This restores the
        // pre-coalescer sync-write contract: after pushStateFor(cid)
        // returns, the data is on the wire to the (new) client.
        _writeNow(cid, payloadStr, res);
        return;
    }

    // Diff: skip the write if the payload is byte-identical to the
    // last successful write for this cid. This is the "不复位整个 state"
    // half of the lease spec — the client doesn't receive a redundant
    // full-state replace that would force a render() + DOM rebuild.
    if (_lastPushedByCid.get(cid) === payloadStr) return;

    // Throttle disabled (env = 0) — write synchronously every push.
    if (STATE_PUSH_THROTTLE_MS <= 0) {
        _writeNow(cid, payloadStr, res);
        return;
    }

    const now = Date.now();
    const lastTs = _lastWriteTsByCid.get(cid) || 0;
    const elapsed = now - lastTs;
    if (elapsed >= STATE_PUSH_THROTTLE_MS) {
        // Outside throttle window — write immediately (preserves
        // the original sync-write contract for the first push in any
        // new window). Calls like runUsageQuery depend on the write
        // being observable to the client by the time the call returns.
        _writeNow(cid, payloadStr, res);
        return;
    }
    // Inside throttle window — store as pending. Last call within
    // the window wins; the timer's flush emits the freshest payload.
    _pendingByCid.set(cid, { payloadStr, res });
    if (!_flushTimers.has(cid)) {
        const delay = STATE_PUSH_THROTTLE_MS - elapsed;
        const timer = setTimeout(() => _flushPending(cid), delay);
        if (typeof timer.unref === "function") timer.unref();
        _flushTimers.set(cid, timer);
    }
}

function _flushPending(cid) {
    _flushTimers.delete(cid);
    const pending = _pendingByCid.get(cid);
    if (!pending) return;
    _pendingByCid.delete(cid);
    // Re-check diff in case the timer fired late (another write
    // happened in the meantime and already wrote this payload).
    if (_lastPushedByCid.get(cid) === pending.payloadStr) return;
    // Re-check res in case the client disconnected/reconnected.
    if (_lastPushedResByCid.get(cid) !== pending.res) return;
    _writeNow(cid, pending.payloadStr, pending.res);
}

// Test-only: clear pending timers + diff cache + last-write timestamps.
// Production code never calls this — production throttles stay "live"
// for the process lifetime. Exported so test/lib/state-bus.check.mjs can
// deterministically reset between cases.
export function resetCoalesceState() {
    for (const [, timer] of _flushTimers) {
        try {
            clearTimeout(timer);
        } catch {}
    }
    _flushTimers.clear();
    _pendingByCid.clear();
    _lastWriteTsByCid.clear();
    _lastPushedByCid.clear();
    _lastPushedResByCid.clear();
}

// Test-only: force-flush all pending pushes immediately (without
// waiting for the throttle window to expire). Returns the number of
// cids flushed. Used in test/lib/state-bus.check.mjs to assert "within
// a coalesce window, exactly N writes went out" without dealing with
// real timer timing.
export function flushPendingPushes() {
    const cids = Array.from(_pendingByCid.keys());
    for (const cid of cids) _flushPending(cid);
    return cids.length;
}

// Test-only: peek at the last-written payload for cid. Used to assert
// "after coalescing, this cid's wire frame contains this data".
export function peekLastPushed(cid) {
    return _lastPushedByCid.get(cid);
}

// Test-only: peek at the last-write timestamp for cid. Used to assert
// throttle-window arithmetic.
export function peekLastWriteTs(cid) {
    return _lastWriteTsByCid.get(cid);
}

// pushOnlineCount — broadcast on SSE client count changes so every tab
// sees the live onlineCount. Re-uses pushStateFor's snapshot shape so
// the diff logic in _schedulePush applies uniformly.
export function pushOnlineCount(lanBroadcast) {
  const cachedCmds = getCachedMcodeCommands();
  for (const [c, res] of sseByCid) {
    const cs = clients.get(c) || makeClientState();
    const snapshot = {
      ...cs,
      // qa (session-workspace-crud): 同上 — 复用瘦身投影，别把 chat 数组
      //   随 onlineCount 广播出去。
      sessions: sessionsListForSnapshot(),
      ...mcodeSessionsSnapshotFields((cs.workspace && cs.workspace.dir) || ""),
      availableCommands: cachedCmds,
      onlineCount: sseByCid.size,
      lanBroadcast,
      readOnly: getReadOnly(),
      tokenEnabled: getTokenEnabled(),
      currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
      tokenAcknowledged: getTokenAcknowledged(),
      tokenRotatedAt: getTokenRotatedAt(),
    };
    // Coalesced write — multiple pushOnlineCount() calls within the
    // throttle window collapse to ONE write per cid.
    _schedulePush(c, JSON.stringify(snapshot), res);
  }
}

export function setActiveChild(cid, child) {
  if (cid) activeChildByCid.set(cid, child);
}

export function getActiveChild(cid) {
  return activeChildByCid.get(cid) || null;
}

export function clearActiveChild(cid) {
  if (cid) activeChildByCid.delete(cid);
}

// ============================================================
// Run registry — one live turn per cid, one per engine session, and
// a global ceiling.
//
// Why this exists. Every prompt spawns its own engine subprocess
// (`runMcodeAcp` builds a `new McodeAcpClient`, `runMcodeExec` a raw
// `spawn`), and there was nothing stopping a second prompt for the same
// client from starting while the first was still in flight. Measured on a
// running server with a stub engine: two concurrent `POST /api/send` on one
// cid produced two engine processes, each holding its own engine session;
// ten produced ten. `MAX_CONCURRENT` was defined in config.js and advertised
// by `GET /api/health` as `maxConcurrent`, but nothing read it.
//
// The per-cid check alone is not enough, because a second browser tab is a
// second cid: `restoreLatestSession` binds a fresh client to the most recent
// session's `mcodeSessionId` with `running.active` false, so both tabs look
// idle and both may send. Two engine processes then hold the same engine
// session, and `persistCurrentChat` is a read-modify-write of the whole
// sessions store — so the slower writer's view of the chat overwrites the
// faster one's, which can silently discard a live streamed turn. Hence the
// second index, keyed by engine session.
//
// Callers: `beginRun` / `endRun` from `routes/chat.js#handleSend`. The check
// runs BEFORE the fire-and-forget 200 ack so a rejected double-send is a real
// 409 the client surfaces, rather than a silent second run.
const runsByCid = new Map(); // cid -> { sid, startedAt }
const runsBySid = new Map(); // mcodeSessionId -> cid

/**
 * Claim the right to run a turn.
 *
 * @param {string} cid
 * @param {string|null} sid engine session this turn will continue, if known
 * @returns {{ok:true}|{ok:false, reason:'cid-busy'|'session-busy'|'at-capacity', detail?:string, running?:number, limit?:number}}
 */
export function beginRun(cid, sid) {
  const key = cid || "default";
  if (runsByCid.has(key)) {
    return { ok: false, reason: "cid-busy", detail: "a turn is already running for this client" };
  }
  // A second tab on the same conversation: both cids are idle, the engine
  // session is not. Refuse rather than let two processes fight over it.
  if (sid && runsBySid.has(sid)) {
    return {
      ok: false,
      reason: "session-busy",
      detail: "this conversation is already running in another window",
    };
  }
  if (runsByCid.size >= MAX_CONCURRENT) {
    return {
      ok: false,
      reason: "at-capacity",
      detail: `server is already running ${MAX_CONCURRENT} turns`,
      running: runsByCid.size,
      limit: MAX_CONCURRENT,
    };
  }
  runsByCid.set(key, { sid: sid || null, startedAt: Date.now() });
  if (sid) runsBySid.set(sid, key);
  return { ok: true };
}

/** Release a turn claimed by `beginRun`. Safe to call when nothing is held. */
export function endRun(cid) {
  const key = cid || "default";
  const entry = runsByCid.get(key);
  if (!entry) return;
  runsByCid.delete(key);
  // Only drop the sid claim if this cid still owns it — a later run on the
  // same session may have re-registered it.
  if (entry.sid && runsBySid.get(entry.sid) === key) runsBySid.delete(entry.sid);
}

/**
 * Backfill (or re-point) the engine-session claim of a live run.
 *
 * Why this exists: during a session's FIRST turn `handleSend` calls
 * `beginRun(cid, cs.mcodeSessionId)` while `cs.mcodeSessionId` is still
 * null — the engine session id only comes into existence inside
 * `runMcodeAcp`'s `session/new`. The run was therefore registered with
 * `sid: null`, `runsBySid` never guarded that session, and a second
 * window (a different cid that had already learned the new session id)
 * could send to it and get a 200 instead of a 409 session-busy — the
 * engine then rejected the duplicate prompt and the message vanished.
 *
 * `runMcodeAcp` calls this the moment the turn's engine session id is
 * determined (right next to `bindDraftToMcodeSid`, which sets
 * `cs.mcodeSessionId`), so the registry claim lands mid-turn, not at
 * finalize. It is also the re-point path: when a stale `session/load`
 * fails and the turn falls back to a fresh engine session, the entry's
 * old sid claim is released (only if this cid still owns it — the same
 * ownership rule `endRun` applies) and the new sid is claimed.
 *
 * All checks and mutations are synchronous, so within Node's single
 * thread a `beginRun` that raced here sees either the pre-backfill or
 * the post-backfill map — never a half-updated one. A late `beginRun`
 * carrying this sid from another cid cannot double-register: the
 * `runsBySid.has(sid)` check inside `beginRun` runs against the same
 * map this function just filled.
 *
 * @param {string} cid client whose live run should claim `sid`
 * @param {string|null|undefined} sid the engine session id now in use
 * @returns {boolean} true when the run's sid claim is (already) `sid`
 */
export function updateRunSid(cid, sid) {
  if (!sid) return false;
  const key = cid || "default";
  const entry = runsByCid.get(key);
  // No live run for this cid (endRun already released it, or beginRun
  // was never this cid's) — nothing to backfill, and no claim may be
  // created out of thin air.
  if (!entry) return false;
  // Idempotent: the run already carries this exact sid (e.g. a turn
  // that loaded an existing session — beginRun registered it).
  if (entry.sid === sid) return true;
  // Never steal another cid's claim. If a different cid is registered
  // for this sid, the guard missed it earlier; overwriting here would
  // let `endRun` on this cid drop the OTHER cid's protection.
  const owner = runsBySid.get(sid);
  if (owner && owner !== key) return false;
  // Release the stale claim this run held (load-failure fallback
  // re-pointed the turn onto a fresh engine session).
  if (entry.sid && runsBySid.get(entry.sid) === key) {
    runsBySid.delete(entry.sid);
  }
  entry.sid = sid;
  runsBySid.set(sid, key);
  return true;
}

/** Live turn count, for diagnostics and tests. */
export function activeRunCount() {
  return runsByCid.size;
}

/** The run currently held by a cid, or null. */
export function getRunForCid(cid) {
  return runsByCid.get(cid || "default") || null;
}

// Find every cid bound to the same mcodeSessionId — used to notify
// other clients of the same session (e.g. mobile + desktop open the
// same session) after a runtime-side truth update.
export function getCidsByMcodeSession(mvsSessionId) {
  if (!mvsSessionId) return [];
  const out = [];
  for (const [cid, cs] of clients) {
    if (cs && cs.mcodeSessionId === mvsSessionId) {
      out.push({ cid, cs });
    }
  }
  return out;
}

// SSE channel helpers — only state-bus.js should touch sseByCid directly.
export function getSseClient(cid) {
  return sseByCid.get(cid) || null;
}

export function setSseClient(cid, res) {
  sseByCid.set(cid, res);
  // When an SSE client (re)connects, the previous diff cache +
  // throttle timestamps are stale — the new client hasn't seen the
  // prior writes, so "diff against last push" is wrong (would skip
  // the very first push this client should receive). Reset coalesce
  // state for this cid so the next pushStateFor emits the full
  // snapshot unconditionally.
  const timer = _flushTimers.get(cid);
  if (timer) {
    try {
      clearTimeout(timer);
    } catch {}
    _flushTimers.delete(cid);
  }
  _pendingByCid.delete(cid);
  _lastWriteTsByCid.delete(cid);
  _lastPushedByCid.delete(cid);
}

export function endSseClient(cid, res) {
  // Only clear the map entry if it still points at the same res (avoid races)
  if (sseByCid.get(cid) === res) sseByCid.delete(cid);
  // Drop the coalesce state for this cid too — the client
  // disconnected, no point in keeping pending pushes around (they'd
  // flush to a dead res anyway and the `try/catch` would silently
  // swallow it). Cleanup keeps the map bounded for long-lived
  // processes that see many transient clients.
  const timer = _flushTimers.get(cid);
  if (timer) {
    try {
      clearTimeout(timer);
    } catch {}
    _flushTimers.delete(cid);
  }
  _pendingByCid.delete(cid);
  _lastWriteTsByCid.delete(cid);
  _lastPushedByCid.delete(cid);
  // qa (OOM hardening): 释放死 res 引用 —— 之前 _lastPushedResByCid 永不
  // 清理，每个断开的 SSE 响应（连同其 socket 写缓冲）被进程终身持有。
  _lastPushedResByCid.delete(cid);
}

// broadcastTokenRotated — push a named SSE event so all
// already-authenticated clients can update their HEADERS + localStorage
// without waiting for the periodic state push. Body is the new token
// (raw string, not JSON, to make it obvious in logs / devtools that
// this is sensitive — never log it).
//
// IMPORTANT: the token is sent in cleartext over the SSE channel. The
// connection is already authenticated (caller must have presented a
// valid token to reach the rotation handler), and SSE is in-band
// with the existing /api/events stream which the client already
// authorized. So this is no worse than the periodic state push that
// also includes currentToken in the same channel.
export function broadcastTokenRotated(token) {
  if (!token) return;
  // SSE custom event format:
  //   event: <name>\n
  //   data: <payload>\n
  //   \n
  const frame = `event: auth.token_rotated\ndata: ${token}\n\n`;
  for (const [, res] of sseByCid) {
    try {
      res.write(frame);
    } catch {}
  }
}

// pushTokenFirstRun — fires the `token.first_run` SSE event exactly
// once per process lifetime. server.js calls this from inside
// `initSettings({printToken})` when settings.js has just generated a
// fresh token (no settings.json on disk + no TOKEN env). The UI
// listens for this event and pops the onboarding modal — keeping the
// raw token off stdout (shell history, Docker logs, systemd journal,
// screen shares).
//
// Rotation uses the existing `auth.token_rotated` event above — we
// don't re-fire `token.first_run` after the first boot, even if the
// token is rotated before the operator clicked acknowledge.
//
// `isFirstRun()` (auth.js) is the re-send guard. Once the client
// closes the modal and POSTs `/api/settings {acknowledgeToken: true}`,
// auth.js#markFirstRunNotified flips the guard so a second boot that
// loads the same persisted token will NOT re-fire.
export function pushTokenFirstRun({ token, persistPath }) {
  if (!isFirstRun()) return; // one-shot: never re-fire after first push
  if (typeof token !== "string" || !token) return;
  const payload = JSON.stringify({
    token,
    persistPath: typeof persistPath === "string" ? persistPath : "",
    ts: Date.now(),
  });
  const frame = `event: token.first_run\ndata: ${payload}\n\n`;
  for (const [, res] of sseByCid) {
    try {
      res.write(frame);
    } catch {}
  }
}

// Per-request authorization SSE channel.
//
// authorize.js gates destructive actions behind a user-confirmation
// modal. The frontend listens for `needs_authorization` events on its
// /api/events stream and pops a confirmation; the user accepts or
// declines and the server resolves the pending request via POST
// /api/auth/decision.
//
// pushAuthRequest — fire a `needs_authorization` SSE frame to the
// target cid (or every connected client if cid is empty). Body is the
// pending request payload {requestId, action, ctx, expiresAt}.
//
// pushAuthDecision — broadcast the resolution so other tabs /
// listeners (e.g. devtools, audit dashboards) can mirror the modal
// state. Body is {requestId, approved, decidedBy}.
//
// The SSE channel is the SAME /api/events stream the client already
// opened — no new connection needed. The frame is a named SSE event
// so it won't be confused with `state`/`chat`/`delta` payloads.

function _writeAuthFrame(targetCid, frame) {
  if (targetCid) {
    const res = sseByCid.get(targetCid);
    if (res) {
      try {
        res.write(frame);
      } catch {}
    }
    return;
  }
  // broadcast (empty / undefined targetCid)
  for (const [, res] of sseByCid) {
    try {
      res.write(frame);
    } catch {}
  }
}

export function pushAuthRequest({ requestId, action, ctx, expiresAt }) {
  if (!requestId || !action) return;
  const payload = JSON.stringify({
    requestId: String(requestId).slice(0, 128),
    action: String(action).slice(0, 64),
    ctx: ctx && typeof ctx === "object" ? ctx : {},
    expiresAt: Number(expiresAt) || 0,
  });
  const frame = `event: needs_authorization\ndata: ${payload}\n\n`;
  const targetCid = ctx && typeof ctx.cid === "string" ? ctx.cid : "";
  _writeAuthFrame(targetCid, frame);
}

export function pushAuthDecision({ requestId, approved, decidedBy }) {
  if (!requestId) return;
  const payload = JSON.stringify({
    requestId: String(requestId).slice(0, 128),
    approved: !!approved,
    decidedBy: decidedBy ? String(decidedBy).slice(0, 32) : "user",
  });
  const frame = `event: authorization_decided\ndata: ${payload}\n\n`;
  // broadcast — every connected tab should mirror modal close
  _writeAuthFrame("", frame);
}
