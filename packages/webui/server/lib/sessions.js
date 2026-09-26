// webui/server/lib/sessions.js
// Sessions JSON persistence + chat helpers.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { SESSIONS_DB } from "./config.js";

// -----------------------------------------------------------------------
// Persistence boundaries.
//
// Three guarantees:
//   1. Atomic write: saveSessions writes SESSIONS_DB+".tmp" then
//      renameSync()s it over the real path. Same directory → same
//      filesystem → rename is atomic, so the on-disk file is always
//      either the previous complete content or the new complete
//      content (never a truncated partial). The .tmp is cleaned up on
//      any failure path; the next save overwrites it.
//
//   2. Concurrent-write serialization: this module uses ONLY synchronous
//      fs calls, and Node's single-threaded event loop runs them to
//      completion. Two saveSessions calls cannot interleave at the
//      syscall layer — stronger than a process-internal lock (no wait,
//      no re-entry). Cross-process writers don't exist for this store.
//      If two instances did race, rename atomicity still prevents
//      torn writes; only the last writer wins.
//
//   3. Corruption explicit: parse failures (and non-array roots) are
//      quarantined to SESSIONS_DB+".corrupted-<timestamp>" before the
//      empty-array fallback is returned. The original file is left
//      untouched; the recoverable copy is named in a console.error.
//      Quarantine+log is deduped by (mtime, size) so repeated loads of
//      the same broken file don't spam. A fixed file (even with the
//      same mtime/size by coincidence) re-parses normally.
// -----------------------------------------------------------------------

let _corruptionMemo = null; // { mtimeMs, size } | null

function reportCorruptedSessionsDb(st, err) {
  const alreadyReported =
    _corruptionMemo !== null &&
    _corruptionMemo.mtimeMs === st.mtimeMs &&
    _corruptionMemo.size === st.size;
  if (alreadyReported) return;
  const quarantine = `${SESSIONS_DB}.corrupted-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  let quarantined = false;
  try {
    copyFileSync(SESSIONS_DB, quarantine);
    quarantined = true;
  } catch {}
  _corruptionMemo = { mtimeMs: st.mtimeMs, size: st.size };
  console.error(
    `[webui] sessions DB 损坏: ${err.message}。原文件已保留未动` +
      (quarantined
        ? `，隔离副本: ${quarantine}`
        : "（隔离副本创建失败 — 请立即手动备份原文件）") +
      `。恢复: 修复 ${SESSIONS_DB} 的 JSON，或用隔离副本回填；` +
      `在此之前会话列表按空库处理。`,
  );
}

// Sessions store (file-backed JSON; minimal)

/** 会话的权威键：有 mcode 绑定用 mcodeSessionId，草稿退回自身 id。 */
export function sessionKeyOf(s) {
  return (s && (s.mcodeSessionId || s.id)) || null;
}

/** 按 mcode 会话 id 找叠加记录（兼容旧 uuid 壳记录）。 */
export function findOverlayForMcodeSid(all, sid) {
  if (!Array.isArray(all) || !sid) return null;
  return all.find((s) => s && s.mcodeSessionId === sid) || null;
}

/**
 * 幂等获取/创建某 mcode 会话的叠加记录。新记录 id === mcodeSessionId
 * （单一身份），重复调用永远返回同一条——切换不再产生重复壳。
 */
export function ensureOverlayForMcodeSid(all, sid, { title, workspace } = {}) {
  let rec = findOverlayForMcodeSid(all, sid);
  if (rec) {
    // 标题仍是占位符时用新解析到的真标题修补（cache-only，无 ACP 代价）
    if (title && rec.title === "Mcode session") rec.title = title;
    return rec;
  }
  rec = {
    id: sid,
    mcodeSessionId: sid,
    title: title || "Mcode session",
    workspace: workspace || "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chat: [],
  };
  all.unshift(rec);
  return rec;
}

/**
 * 首轮 acp 回合绑定 mcode 会话后，把草稿记录（uuid id、无绑定）晋升为
 * 引擎身份：id 改写为 mcodeSessionId。若该 mcode 会话已有叠加记录
 * （例如用户此前切换过它），则把草稿的 chat 合并进既有记录并删除草稿，
 * 保证一个 mcode 会话最多一条记录。cs.sessionId 同步为最终记录 id。
 */
export function promoteDraftToMcodeSid(cs) {
  if (!cs || !cs.mcodeSessionId || !cs.sessionId) return false;
  if (cs.sessionId === cs.mcodeSessionId) return false;
  const all = loadSessions();
  const draft = all.find((s) => s && s.id === cs.sessionId && !s.mcodeSessionId);
  const existing = findOverlayForMcodeSid(all, cs.mcodeSessionId);
  if (existing) {
    const draftChat = Array.isArray(draft && draft.chat) ? draft.chat : [];
    if (draftChat.length > 0) {
      existing.chat = [...(existing.chat || []), ...draftChat];
    }
    existing.updatedAt = Date.now();
    if (draft) {
      const idx = all.indexOf(draft);
      if (idx >= 0) all.splice(idx, 1);
    }
    saveSessions(all);
    cs.sessionId = existing.id;
    return true;
  }
  if (!draft) return false;
  draft.id = cs.mcodeSessionId;
  draft.mcodeSessionId = cs.mcodeSessionId;
  draft.updatedAt = Date.now();
  saveSessions(all);
  cs.sessionId = draft.id;
  return true;
}

/**
 * Bind the engine identity at session/new, not at finalize: sets
 * cs.mcodeSessionId = sid and immediately promotes the draft. Idempotent, so
 * finalize may call it again. Leaving the draft unbound for the whole turn
 * makes the sidebar show two records for one conversation (uuid draft + the
 * mvs_ engine entry), and clicking the latter forks it into two.
 *
 * session-isolation/02 (run-mirror): callers capture the turn's owning
 * webui session id at send time. When the user has already switched to
 * another session by the time the engine session id is known, `cs` no
 * longer points at the owning record — promoting through `cs` would
 * rename/merge whichever record the user switched TO. Use
 * `bindRecordToMcodeSid` for that case; this one stays the cs-driven
 * path for the still-viewing case.
 */
export function bindDraftToMcodeSid(cs, sid) {
  if (!cs || !sid) return false;
  cs.mcodeSessionId = sid;
  return promoteDraftToMcodeSid(cs);
}

/**
 * session-isolation/02 (run-mirror): `promoteDraftToMcodeSid` for a
 * record addressed BY ID, without touching `cs`.
 *
 * Mid-run the live `cs` can belong to a different session (the user
 * switched away while the engine session id was still unknown). The
 * turn's draft record must still be promoted — engine identity bound,
 * id rewritten to the mvs id (or merged into an existing overlay) —
 * exactly what `promoteDraftToMcodeSid` does, but targeted at the
 * owning record so the switched-to session's record is never renamed
 * or merged by someone else's turn.
 *
 * Idempotent: a record already carrying `sid` (or an already-promoted
 * record that no longer matches `webuiId`) is left alone.
 *
 * @returns {string|null} the owning record's id after promotion
 *   (null when there was nothing to bind — record gone, or already
 *   bound to another engine session).
 */
export function bindRecordToMcodeSid(webuiId, sid) {
  if (!webuiId || !sid) return null;
  const all = loadSessions();
  // Already promoted for this turn? (webuiId may BE the mvs id after a
  // previous promotion, or the record may carry the binding already.)
  const bound = findOverlayForMcodeSid(all, sid);
  if (bound) return bound.id;
  const draft = all.find((s) => s && s.id === webuiId && !s.mcodeSessionId);
  if (!draft) return null;
  const existing = findOverlayForMcodeSid(all, sid);
  if (existing) {
    const draftChat = Array.isArray(draft.chat) ? draft.chat : [];
    if (draftChat.length > 0) {
      existing.chat = [...(existing.chat || []), ...draftChat];
    }
    existing.updatedAt = Date.now();
    const idx = all.indexOf(draft);
    if (idx >= 0) all.splice(idx, 1);
    saveSessions(all);
    return existing.id;
  }
  draft.id = sid;
  draft.mcodeSessionId = sid;
  draft.updatedAt = Date.now();
  saveSessions(all);
  return draft.id;
}

// Memoize parsed content by (mtimeMs, size). pushStateFor calls
// loadSessions on EVERY snapshot (per SSE push, up to 60Hz), and the
// switch/persist paths read too — re-reading + JSON.parsing a
// multi-MB store on every push made long-turn streaming and session
// switching visibly janky. Corrupt files are never cached (every
// attempt re-parses so recovery is immediate); external writers
// invalidate via mtime/size; saveSessions primes the cache.
let _sessionsCache = null; // { mtimeMs, size, data }
export function _resetSessionsCacheForTests() { _sessionsCache = null; }

export function loadSessions() {
  if (!existsSync(SESSIONS_DB)) return [];
  let st;
  try {
    st = statSync(SESSIONS_DB);
  } catch {
    return [];
  }
  if (_sessionsCache && _sessionsCache.mtimeMs === st.mtimeMs && _sessionsCache.size === st.size) {
    return _sessionsCache.data;
  }
  let raw;
  try {
    raw = readFileSync(SESSIONS_DB, "utf8");
  } catch {
    return [];
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    reportCorruptedSessionsDb(st, e);
    return [];
  }
  if (!Array.isArray(parsed)) {
    // Root-not-array is treated identically to corrupt JSON —
    // handing a non-array up makes callers' .find/.push throw.
    reportCorruptedSessionsDb(st, new Error("root value is not a JSON array"));
    return [];
  }
  _sessionsCache = { mtimeMs: st.mtimeMs, size: st.size, data: parsed };
  return parsed;
}

export function saveSessions(s) {
  const payload = JSON.stringify(s, null, 2);
  // If JSON.stringify throws (e.g. circular ref), .tmp was never created
  // and the main file is untouched.
  const tmp = `${SESSIONS_DB}.tmp`;
  try {
    writeFileSync(tmp, payload, "utf8"); // same dir tmp → same filesystem
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  try {
    renameSync(tmp, SESSIONS_DB); // atomic replace
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  // Main file replaced — the corruption memo no longer applies (a new
  // corruption is a new state, will re-quarantine).
  _corruptionMemo = null;
  try {
    const st2 = statSync(SESSIONS_DB);
    _sessionsCache = { mtimeMs: st2.mtimeMs, size: st2.size, data: s };
  } catch {}
}

// resetContext clears every counter AND the two "a run is in progress"
// claim fields (cs.running + cs.context.thinkingStatus). A mid-run
// switch/create/new that cleared only the counters would leave
// running.active=true + thinkingStatus="Running" parked in the client
// state, so the footer/context panel showed 思考中 forever and the send
// button stayed a stop button for a run the user had navigated away
// from. The claim only healed if the in-flight run's finalize() later
// fired — runs that die in their start phase never heal. The idle shape
// is byte-mirrored from the runners' finalize() (mcode-acp.js /
// mcode-exec.js) and chat.js's resetThinkingClaim(), so switch and
// normal end-of-turn converge on the same at-rest state. Callers
// (sessions.js switch/create/delete, protocol.js activate-session,
// commands.js /clear + /new) all treat cs as "no longer the session
// that run belongs to" — none needs the claim preserved.
//
// Two deliberate boundaries:
//   (1) NO ▍ cursor stripping here — unlike chat.js's
//       resetThinkingClaim (same session, terminal failure), every
//       resetContext caller has either already replaced cs.chat with
//       the TARGET session's chat (switch: stripping would corrupt
//       lines that belong to a different, possibly live, run) or is
//       about to clear it (new/clear/delete). Chat ownership stays
//       with the caller.
//   (2) lastUsageAt still goes null — this is a session-CHANGE path:
//       the target session has no observed usage yet, and carrying
//       the old session's freshness datum over zeroed counters would
//       lie. (resetThinkingClaim keeps it because THERE the session
//       is the same one; finalize() keeps it for the same reason.)
//
// computeContextPercent lives in ./context-percent.js (pure helper,
// unrelated consumers like mavis-usage.js don't have to depend on
// the stateful session store). The re-export keeps the public surface
// stable — any caller importing it from "./sessions.js" still
// resolves the same function.

export { computeContextPercent } from "./context-percent.js";
// streamUpdateLine lives in ./chat-line.js (pure helper, reusable
// outside the session store — e.g. transcript backfill paths that
// don't carry sessions.json state). mcode-acp.js / mcode-exec.js are
// repointed there directly; this re-export is the legacy escape
// hatch for any test/route still importing from "./sessions.js".
export { streamUpdateLine } from "./chat-line.js";

export function resetContext(cs) {
  cs.running = {
    active: false,
    prompt: null,
    pid: null,
    startedAt: null,
    model: null,
    sessionId: null,
    lastDeltaAt: null,
    tps: 0,
  };
  cs.context.thinkingStatus = "Idle";
  cs.context.tokens = 0;
  cs.context.used = 0;
  cs.context.percent = 0;
  cs.context.spent = 0;
  cs.context.tps = 0;
  cs.context.thinkingDuration = null;
  cs.context.assistantLast = null;
  cs.context.assistantAt = null;
  cs.context.lastUsageAt = null;
}

// Persist the current state.chat onto the matching session record so
// switching to another session and back shows history.
export function persistCurrentChat(cs) {
  if (!cs.sessionId) return;
  const all = loadSessions();
  const item = all.find((s) => s.id === cs.sessionId);
  if (!item) return;
  item.chat = cs.chat || [];
  item.updatedAt = Date.now();
  saveSessions(all);
}

/**
 * session-isolation/02 (run-mirror): append finished-turn lines to a
 * session's PERSISTED record, addressed by id or engine session id.
 *
 * Used by the finalize drain when the user switched away mid-run: the
 * live `cs` belongs to whichever session the user is looking at now,
 * so `persistCurrentChat(cs)` would persist the wrong view. The turn's
 * lines belong to the session that RAN, so they are written to that
 * session's record directly — found by webui id, or by mcodeSessionId
 * when the record was promoted mid-run (its id is then the mvs id).
 *
 * No-op when there is nothing to append or no record matches (the
 * record was deleted mid-run — nothing sensible to resurrect).
 */
export function appendChatToSession(sessionId, lines) {
  if (!sessionId || !Array.isArray(lines) || lines.length === 0) return false;
  const all = loadSessions();
  const item =
    all.find((s) => s && s.id === sessionId) ||
    findOverlayForMcodeSid(all, sessionId);
  if (!item) return false;
  item.chat = [...(item.chat || []), ...lines];
  item.updatedAt = Date.now();
  saveSessions(all);
  return true;
}

// Boot-time cleanup of empty / default-titled session entries (the
// residue of "+ New session" presses that never sent a message).
// Keep entries that have chat OR a real (non-default) title; for
// default-titled entries keep those newer than 24h (don't sweep a
// freshly-pressed "+" session).
//
// Routed through loadSessions() so a quarantined corrupt DB returns
// all=[] here and we early-return instead of overwriting the
// quarantine with an empty array.
export function cleanupEmptyDefaultSessions() {
  const all = loadSessions();
  if (!Array.isArray(all) || all.length === 0) return;
  const before = all.length;
  const now = Date.now();
  const STALE_MS = 24 * 60 * 60 * 1000;
  const kept = all.filter((s) => {
    if (!s || !s.id) return false;
    const hasChat = Array.isArray(s.chat) && s.chat.length > 0;
    if (hasChat) return true;
    const t = (s.title || "").trim();
    const isDefault =
      t === "New session" || t === "Untitled" || /^对话 \d+$/.test(t);
    if (!isDefault) return true;
    if (s.updatedAt && now - s.updatedAt < STALE_MS) return true;
    return false;
  });
  if (kept.length !== before) {
    saveSessions(kept);
    console.log(
      `[webui] cleanup: removed ${before - kept.length} empty/default sessions, ${kept.length} kept`,
    );
  }
}
