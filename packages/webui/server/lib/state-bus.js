// webui/server/lib/state-bus.js
// Per-cid state + event stream (WebSocket /api/stream) management.

import { DEFAULT_WORKSPACE, DEFAULT_MODEL } from "./config.js";
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
  getQuotaEnabled,
  getReadOnly,
  getTokenAcknowledged,
  getTokenEnabled,
  getTokenPlanApiKey,
  getTokenPlanApiKeyFilePath,
  getTokenPlanApiKeySource,
  getTokenRotatedAt,
  maskTokenPlanKey,
} from "./settings.js";
import { emitEvent, getSubscribedCids } from "./event-bus.js";
import { pushAlert, subscribeAlerts } from "./alerts.js";

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
      expires: null,
      credits: null,
      fiveHourPercent: null,
      fiveHourReset: null,
      weekly: null,
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
function sessionsListForSnapshot() {
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
    for (const c of getSubscribedCids()) {
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
        //   直接 loadSessions()，把每个 session 的完整 chat 数组推进事件流，
        //   是 v2.3 修掉的主负载；两处（本处 + pushOnlineCount）漏改。
        sessions: sessionsListForSnapshot(),
        mcodeSessions: cached,
        mcodeSessionsPending: false,
        availableCommands: getCachedMcodeCommands(),
        onlineCount: getSubscribedCids().length,
        lanBroadcast: getLanBroadcast(),
        readOnly: getReadOnly(),
        tokenEnabled: getTokenEnabled(),
        // currentToken is only sent while un-acknowledged (shrinks
        // the secret-exposure window).
        currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
        tokenAcknowledged: getTokenAcknowledged(),
        tokenRotatedAt: getTokenRotatedAt(),
        // Token Plan feature fields. These MUST be in the snapshot —
        // they are clobbered by the SSE replace-state pattern
        // (state = JSON.parse(ev.data)), and without including them
        // the next push after a /api/settings mutation hides the
        // usage button again. The masked key never includes the
        // full Subscription Key, only "sk-cp-...XXXX".
        quotaEnabled: getQuotaEnabled(),
        hasTokenPlanKey: getTokenPlanApiKey().length > 0,
        tokenPlanApiKeyMasked: maskTokenPlanKey(),
        // External key source surface. Webui uses this to hide the
        // "delete" button when the key is managed by env / file
        // (the operator would have to remove it there, not in the UI).
        tokenPlanApiKeySource: getTokenPlanApiKeySource(),
        tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
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
    for (const c of getSubscribedCids()) {
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
        onlineCount: getSubscribedCids().length,
        lanBroadcast,
        readOnly: getReadOnly(),
        tokenEnabled: getTokenEnabled(),
        currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
        tokenAcknowledged: getTokenAcknowledged(),
        tokenRotatedAt: getTokenRotatedAt(),
        // Token Plan feature fields — see ensureMcodeSessionsFetchedAndPush
        // above for the rationale. This broadcast path fires after
        // /api/settings mutations; any push without these clobbers
        // state.quotaEnabled and re-hides the button.
        quotaEnabled: getQuotaEnabled(),
        hasTokenPlanKey: getTokenPlanApiKey().length > 0,
        tokenPlanApiKeyMasked: maskTokenPlanKey(),
        // External key source surface — see the per-cid branch below.
        tokenPlanApiKeySource: getTokenPlanApiKeySource(),
        tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
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
    onlineCount: getSubscribedCids().length,
    lanBroadcast,
    readOnly: getReadOnly(),
    tokenEnabled: getTokenEnabled(),
    currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
    tokenAcknowledged: getTokenAcknowledged(),
    tokenRotatedAt: getTokenRotatedAt(),
    // Token Plan feature fields — see ensureMcodeSessionsFetchedAndPush
    // above for rationale. Without these the per-cid SSE push also
    // clobbers the local `state.quotaEnabled` and the usage button
    // hides itself right after the user toggles it on.
    quotaEnabled: getQuotaEnabled(),
    hasTokenPlanKey: getTokenPlanApiKey().length > 0,
    tokenPlanApiKeyMasked: maskTokenPlanKey(),
    // External key source surface — see the broadcast branch above.
    tokenPlanApiKeySource: getTokenPlanApiKeySource(),
    tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
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



// pushOnlineCount — broadcast on SSE client count changes so every tab
// sees the live onlineCount. Re-uses pushStateFor's snapshot shape so
// the diff logic in _schedulePush applies uniformly.
export function pushOnlineCount(lanBroadcast) {
  const cachedCmds = getCachedMcodeCommands();
  const subs = getSubscribedCids();
  for (const c of subs) {
    const cs = clients.get(c) || makeClientState();
    const snapshot = {
      ...cs,
      // qa (session-workspace-crud): 同上 — 复用瘦身投影，别把 chat 数组
      //   随 onlineCount 广播出去。
      sessions: sessionsListForSnapshot(),
      ...mcodeSessionsSnapshotFields((cs.workspace && cs.workspace.dir) || ""),
      availableCommands: cachedCmds,
      onlineCount: subs.length,
      lanBroadcast,
      readOnly: getReadOnly(),
      tokenEnabled: getTokenEnabled(),
      currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
      tokenAcknowledged: getTokenAcknowledged(),
      tokenRotatedAt: getTokenRotatedAt(),
      // Token Plan feature fields — see pushStateFor above for rationale.
      // pushOnlineCount fires on every SSE client connect/disconnect,
      // so without these the next push after a tab opens would also
      // clobber quotaEnabled.
      quotaEnabled: getQuotaEnabled(),
      hasTokenPlanKey: getTokenPlanApiKey().length > 0,
      tokenPlanApiKeyMasked: maskTokenPlanKey(),
      // External key source surface — see the broadcast branch above.
      tokenPlanApiKeySource: getTokenPlanApiKeySource(),
      tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
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
// IMPORTANT: the token is sent in cleartext over the event stream. The
// connection is already authenticated (caller must have presented a
// valid token to reach the rotation handler), and /api/stream is
// in-band with the state channel the client already authorized. So this
// is no worse than the periodic state push that also includes
// currentToken in the same channel.
export function broadcastTokenRotated(token) {
  if (!token) return;
  for (const c of getSubscribedCids()) {
    emitEvent(c, { type: "control", name: "auth.token_rotated", data: token });
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
  for (const c of getSubscribedCids()) {
    emitEvent(c, { type: "control", name: "token.first_run", data: payload });
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
// pushAuthRequest — fire a `needs_authorization` control frame to the
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

function _writeAuthFrame(targetCid, event) {
  if (targetCid) {
    emitEvent(targetCid, event);
    return;
  }
  // broadcast (empty / undefined targetCid)
  for (const c of getSubscribedCids()) emitEvent(c, event);
}

export function pushAuthRequest({ requestId, action, ctx, expiresAt }) {
  if (!requestId || !action) return;
  const payload = JSON.stringify({
    requestId: String(requestId).slice(0, 128),
    action: String(action).slice(0, 64),
    ctx: ctx && typeof ctx === "object" ? ctx : {},
    expiresAt: Number(expiresAt) || 0,
  });
  const targetCid = ctx && typeof ctx.cid === "string" ? ctx.cid : "";
  _writeAuthFrame(targetCid, {
    type: "control",
    name: "needs_authorization",
    data: payload,
  });
}

export function pushAuthDecision({ requestId, approved, decidedBy }) {
  if (!requestId) return;
  const payload = JSON.stringify({
    requestId: String(requestId).slice(0, 128),
    approved: !!approved,
    decidedBy: decidedBy ? String(decidedBy).slice(0, 32) : "user",
  });
  // broadcast — every connected tab should mirror modal close
  _writeAuthFrame("", {
    type: "control",
    name: "authorization_decided",
    data: payload,
  });
}
