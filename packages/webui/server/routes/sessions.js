// webui/server/routes/sessions.js
// GET/POST /api/sessions, POST /api/sessions/switch, DELETE /api/sessions/:id,
// POST /api/sessions/rename (CRUD "改" — user-set title, titleCustom),
// GET /api/acp-sessions, GET /api/acp-session-title,
// GET /api/sessions/search (Lease C05 — cross-workspace fuzzy match)
// (v0.5.bx-33: 删 POST /api/sessions/cleanup-orphans — Wzdhehe 不要这个 UI,API 一起删)

import { randomUUID } from "node:crypto";
import {
  loadSessions,
  saveSessions,
  resetContext,
  // Still a direct import: `handleSwitchSession` creates the first-touch
  // overlay itself. Rename used to call it too and no longer does — that
  // write moved to `engine/session-writes.js` — but the switch path is a
  // read-with-a-side-effect and stayed put, so this symbol has not
  // finished migrating.
  ensureOverlayForMcodeSid,
  findOverlayForMcodeSid,
} from "../lib/sessions.js";
import {
  getMcodeSessionTitle,
  getMcodeSessionsCacheSync,
  getMcodeSessionsStaleSync,
} from "../lib/acp-client.js";
// Switch-path transcript backfill — load mcode session history from
// the runtime DB so switching to an mvs_ session with no webui wrapper
// shows real chat instead of "No messages yet".
import { loadTranscriptChatLines } from "../lib/transcript.js";
import { applyMavisUsageToCs } from "../lib/mavis-usage.js";
import { getMcodeModelLimit } from "../lib/models.js";
import {
  pushStateFor,
  clients,
  runChatViewChat,
} from "../lib/state-bus.js";
import { MCODE_RUNTIME_DB, DEFAULT_WORKSPACE } from "../lib/config.js";
// M3-B1 (engine facade): #9 and #10 read the engine through the declared
// capability rather than straight off the ACP client. Both facade
// functions forward to the same acp-client exports this module already
// imported, so the wire shape, the cache and the transport switch are
// unchanged — only the gate in front of them is new.
import {
  readEngineSessionListForWorkspace,
  readEngineSessionTitle,
} from "../engine/session-reads.js";
// M3-B2 (engine facade): #8 asks the facade, which checks the provider's
// declaration (sessionCrud.listSessions → 501 when absent) and then
// forwards to the same `getSessionTree` this module used to call
// directly. `invalidateSessionTree` was a direct import here from B2
// through B4 on the grounds that it is a synchronous cache drop with no
// I/O and routing a one-line invalidation through an async facade would
// make the caller wait on a module load to do nothing. M3-B5 retired
// that exception: the only three call sites were the rename and delete
// paths, and those moved into `engine/session-writes.js` as part of the
// ordered write sequences they belong to. A cache drop is not a
// standalone concern here — it is step two of a three-step resurrection
// guard, and keeping it addressable from the route was what made it
// possible to call it out of order.
import { readEngineSessionTree } from "../engine/session-tree-reads.js";
// M3-B5 (engine facade): #7 delete, #4 rename and #6 cleanup-orphans are
// the three WRITES of this module, and they ask the engine facade rather
// than driving the store, the caches and the engine's own `local_runtime_*`
// tables from the route. The split is deliberate and is the reason the
// handlers below shrank rather than grew:
//
//   - The gate in front of each write is the facade's, not this file's.
//     #7 and #6 gate hard on `sessionCrud` · `deleteSession` (the rows
//     they destroy are the engine's own); #4 declares no capability at
//     all, because a rename writes webui's store and nothing else.
//   - The load→resolve→authorize→intent-audit→mutate ORDER is still
//     this file's, and had to stay: the write-ahead audit has to land
//     between "know what the user asked to delete" and "delete it". So
//     the facade exposes a plan/commit pair rather than one
//     `deleteSession(options)` that would have swallowed the ordering.
//   - The response BODIES are built in the facade, once. #6's dryRun
//     shape is a byte-for-byte red line for this batch, so it is pinned
//     there by test instead of re-assembled in two places here.
//   - `deleteMcodeSessionFromDb` and the 32-table SQL stay in
//     `lib/mcode-session-delete.js` and are reached by the facade through
//     a dynamic import; see KNOWN DEBT in `engine/session-writes.js`.
import {
  applyEngineSessionRename,
  commitEngineOrphanSessionDelete,
  commitEngineSessionDelete,
  isMcodeSessionId,
  planEngineSessionDelete,
  previewEngineSessionDelete,
  readOrphanSessionWriteIds,
} from "../engine/session-writes.js";
// The capability-error predicate `handleSessionTree` uses to tell the gate's
// 501 apart from a soft-fail. Taken from the facade entry, which re-exports
// the same binding `app.js#invokeHandler` matches on, so the two ends of this
// protocol cannot drift onto two different notions of "is this the gate's
// error".
import { isEngineCapabilityNotSupportedError } from "../engine/index.js";
import { authorize } from "../lib/authorize.js";
import { pushAlert } from "../lib/alerts.js";
import { append as _eventsAppend } from "../lib/events.js";
// Session-create workspace gate: body.workspace is user input and used to be
// trusted verbatim — no existence check, no containment check, no resolve —
// which made POST /api/sessions a side door around the workspace picker's
// containment gate (handleWorkspaceChange / browseWorkspace / fs routes all
// funnel through lib/workspace.js). Reuse assertWorkspacePath so every
// workspace write lands on the same boundary.
import { assertWorkspacePath } from "../lib/workspace.js";

// _resolveSwitchWorkspace — pick the workspace the switched-into session
// "belongs to" and run it through the same containment gate that the
// workspace picker / handleNewSession / browseWorkspace all funnel through.
//
// Source priority (s39 — webui-parity ticket 39: file tree must follow the
// switched session):
//
//   1. The target session's stored `workspace` field — that IS the
//      workspace the user was in when they last had it open, modulo any
//      pollution the old code introduced. Real existence + containment
//      are checked; an out-of-bounds or stale value surfaces as a 400
//      so the user can either widen the allowed roots or pick a fresh
//      workspace, instead of silently landing on the previous project.
//
//   2. DEFAULT_WORKSPACE (env MCODE_WORKSPACE > mcode TUI cwd.json > homedir)
//      when the stored value is empty. Empty is also the value seen for
//      (a) records created by the old code that polled freshly-typed mvs
//      sessions with the current cs.workspace (the data-corruption bug
//      this ticket fixes), and (b) older sessions that pre-date the
//      workspace field. DEFAULT_WORKSPACE is already in the default
//      allowed-roots surface (see getAllowedWorkspaceRoots), so the
//      containment check accepts it without env setup.
//
// Critical invariants:
//   - The switch NEVER keeps cs.workspace on the prior project. The
//     user-reported symptom was exactly that: "the file tree still
//     shows the previous project's files". Falling back to current ws
//     when target.workspace is empty is the bug we are removing.
//   - The switch NEVER writes cs.workspace.dir to a path the
//     containment gate rejected. A 400 with the gate's actionable
//     error is the only acceptable outcome.
//   - The switch NEVER overwrites a target session's stored workspace
//     with the current cs.workspace. That was the ② pollution path —
//     re-introducing it would re-break the regression we just fixed.
//     New overlay records (mvs_ first-touch) get workspace:"" here; the
//     target-first read picks DEFAULT_WORKSPACE for them.
function _resolveSwitchWorkspace(target, currentWs) {
  const raw = target && typeof target.workspace === "string" ? target.workspace.trim() : "";
  // Empty / non-string / null → DEFAULT_WORKSPACE. Never the current cs
  // workspace — that's the user-reported "stays on the old project"
  // failure mode this fix removes.
  const candidate = raw || DEFAULT_WORKSPACE;
  const gate = assertWorkspacePath(candidate);
  if (!gate.ok) {
    return { ok: false, error: gate.error, attempted: candidate };
  }
  return { ok: true, dir: gate.path, real: gate.real, fallback: !raw };
}

/**
 * Detect the cumulative-render pollution pattern in a stored chat
 * buffer (session-isolation/06). When the engine emits each segment
 * of an `agent_message`, streamUpdateLine writes a new `●` line; a
 * non-cumulative buffer has each line containing only its own
 * segment's text. A cumulative buffer — the bug — has at least one
 * later `●` line whose text is a strict superset of an earlier
 * `●` line (because the accumulator never reset between segments and
 * every later line re-wrote every prior segment's text). This
 * predicate is O(n^2) in the number of `●` lines but a single
 * session's `chat` is bounded (~400 lines by the transcript cap) so
 * the worst case is a few thousand substring checks per switch —
 * cheap enough.
 *
 * Returns true when the buffer is clearly cumulative (an earlier
 * `●` line is a strict substring of a later one AND the longer line
 * strictly extends the shorter). Conservative on both sides:
 *   - a single-`●`-line buffer is never cumulative;
 *   - non-`●` lines (system, tool, ▲ thought) are ignored — only
 *     `●` rows matter, since the cumulative bug only affects message
 *     segments;
 *   - ties (equal-length `●` lines) are NOT cumulative — same
 *     length, no superset relation.
 */
function chatLooksCumulative(chat) {
  if (!Array.isArray(chat) || chat.length === 0) return false;
  const dots = [];
  for (const line of chat) {
    if (typeof line !== "string") continue;
    // Match the same prefix the streamer writes: `● ` then text.
    // Also accept bare `●` at end-of-line (transcript-sync appends
    // stripped-down `●` markers in some paths).
    if (line.startsWith("● ")) dots.push(line.slice(2));
    else if (line === "●") continue;
    else continue;
  }
  for (let i = 0; i < dots.length; i += 1) {
    for (let j = i + 1; j < dots.length; j += 1) {
      const a = dots[i];
      const b = dots[j];
      if (b.length <= a.length) continue; // strict superset ⇒ longer
      if (b.includes(a)) return true;
    }
  }
  return false;
}

// _auditFail — shared failure sink for audit writes. events.js#append
// THROWS on write failure; a governance action must not complete with
// a missing audit trail, so every route-level append is wrapped and
// lands here: HTTP 5xx + one alert on the anomaly channel. `what`
// names the flow for the operator.
function _auditFail(res, e, what) {
  try {
    pushAlert({
      level: "error",
      msg: `audit write failed (${what}): ${e && e.message ? e.message : String(e)}`,
      src: "sessions",
    });
  } catch {}
  console.error(`[webui] audit write failed (${what}):`, e);
  if (res && !res.headersSent) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: "audit write failed",
      detail: what,
    }));
  }
  return undefined;
}

// Prevent "deleted session reappears" — moved to the engine facade in
// M3-B5. The long-lived mcode acp child still holds the session in
// memory and will rewrite the registry row on its next request, so the
// delete has to (1) kill the child, (2) SQL-delete the rows, (3) drop
// ONLY the deleted sid from the in-memory cache (not the whole cache —
// invalidating the whole cache sends an empty placeholder to the sidebar
// which flashes from 42 → 16 → 42 entries, looking like the delete
// failed). That sequence is now
// `engine/session-writes.js`, where it is named and tested step by step
// instead of being a two-line helper a route could call in the wrong
// order.

// Title fast path — resolve an mvs_ session's title from the
// in-memory walked-session cache (the same cache behind
// GET /api/acp-sessions via getMcodeSessionsForWorkspace) BEFORE
// awaiting getMcodeSessionTitle. The fallback boots the ACP child; with
// a missing/broken mcode binary that path measured ~2.17s end-to-end
// AND degraded the title to the "Mcode session" placeholder even
// though the cache already held the real title. Cache getters are sync
// and spawn nothing, so a hit keeps the switch hot path at zero ACP
// cost.
//
// Cross-workspace matching within what the module exposes: the cache
// holds ONE workspace's list, keyed by ws. We probe the client's
// current ws with both the fresh (30s TTL) and stale (same-ws,
// TTL-expired) readers, plus the "" key — getMcodeSessionsForWorkspace("")
// caches the UNFILTERED list, so a cache walked without a workspace
// still answers. A miss returns null and the caller falls back to
// getMcodeSessionTitle.
function _lookupCachedMcodeTitle(mcodeSessionId, ws) {
  if (!mcodeSessionId) return null;
  const keys = [ws || "", ""];
  for (const wsKey of keys) {
    for (const getter of [getMcodeSessionsCacheSync, getMcodeSessionsStaleSync]) {
      let sessions = null;
      try {
        sessions = getter(wsKey);
      } catch {
        sessions = null;
      }
      if (!Array.isArray(sessions)) continue;
      const hit = sessions.find(
        (s) => s && s.sessionId === mcodeSessionId && s.title,
      );
      if (hit && hit.title) return hit.title;
    }
  }
  return null;
}

// GET /api/sessions — list
// qa (session-workspace-crud): 响应瘦身为 sidebar 元数据 — 与 docs/API.md
//   声明的形状（id/title/workspace/mcodeSessionId/updatedAt）对齐。之前把
//   每个 session 的完整 chat 数组一并回给 GET，与 v2.3 快照瘦身的结论相悖；
//   前端唯一消费点（refreshSessions → renderSessions）只读元数据，会话内
//   容走 switch 响应 / export 端点。titleCustom 供前端 merge 判定改名优先。
export function handleListSessions(_req, res) {
  const all = loadSessions();
  const sessions = all.map((s) => ({
    id: s.id,
    title: s.title,
    mcodeSessionId: s.mcodeSessionId,
    workspace: s.workspace,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    titleCustom: s.titleCustom === true ? true : undefined,
  }));
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, sessions }));
}

// POST /api/sessions — create a new webui session (accepts body.workspace).
export async function handleNewSession(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const all = loadSessions();
  const id = randomUUID();
  // body.workspace is user input. When it is provided explicitly it must clear
  // the SAME containment gate as POST /api/workspace before it is stored or
  // copied into cs.workspace, or it is a side door around the workspace
  // picker's boundary. The cs fallback path is untouched: cs.workspace.dir was
  // gated when it was set.
  const rawWs =
    payload.workspace || (cs && cs.workspace && cs.workspace.dir) || "";
  let sessionWs = (rawWs || "").trim();
  if (payload.workspace && sessionWs) {
    const gate = assertWorkspacePath(sessionWs);
    if (!gate.ok) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: gate.error }));
    }
    sessionWs = gate.path; // stored resolved, same as handleWorkspaceChange
  }
  const item = {
    id,
    title: "New session",
    workspace: sessionWs,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chat: [],
  };
  all.unshift(item);
  saveSessions(all);
  if (cs.workspace.dir !== sessionWs) {
    cs.workspace = { dir: sessionWs, branch: null, tree: null };
  }
  cs.sessionId = id;
  cs.mcodeSessionId = null;
  cs.sessionTitle = item.title;
  cs.chat = [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  resetContext(cs);
  // session creation is a state-changing action; record it. Fail-closed
  // on audit write failure: 5xx instead of claiming success with an
  // unaudited mutation (no rollback — the JSON store write already
  // happened; the alert carries the mismatch).
  try {
    _eventsAppend("session.create", {
      target: id,
      cid,
      actor: "user",
      payload: {
        title: item.title,
        workspace: sessionWs,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "session.create");
  }
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, session: item }));
}

// POST /api/sessions/switch — switch to session by webui id or mvs_xxx
export async function handleSwitchSession(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const id = (payload.id || "").trim();
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  const all = loadSessions();
  console.log(
    `[switch] cid=${cid} incoming id=${id.substring(0, 12)}… isMcodeSid=${/^mvs_[a-f0-9]{32}$/.test(id)} allTotal=${all.length}`,
  );
  // 优先按 mcode session id 找（v0.5.bv: 1:1 关联）
  let target = all.find((s) => s.mcodeSessionId === id);
  let matchKind = target ? "mcodeSessionId" : null;
  if (!target) {
    target = all.find((s) => s.id === id);
    if (target) matchKind = "webuiId";
  }
  console.log(
    `[switch] cid=${cid} match=${matchKind || "NONE"} target.id=${target ? target.id.substring(0, 8) : "null"}… target.mcodeSid=${target && target.mcodeSessionId ? target.mcodeSessionId.substring(0, 12) : "null"}… target.chatLen=${target ? (target.chat ? target.chat.length : 0) : 0} target.title="${target ? (target.title || "").substring(0, 30) : ""}"`,
  );
  if (!target) {
    const isMcodeSid = /^mvs_[a-f0-9]{32}$/.test(id);
    if (isMcodeSid) {
      // Cache-first title — the walked session cache usually already
      // holds the real title (the sidebar just rendered it). Only a
      // total cache miss pays the getMcodeSessionTitle cost, which
      // boots the ACP child (~2.17s measured with a broken mcode
      // binary) and used to degrade every first switch to the
      // "Mcode session" placeholder.
      const ws = (cs.workspace && cs.workspace.dir) || "";
      let title = _lookupCachedMcodeTitle(id, ws);
      let titleSource = title ? "cache" : "acp";
      if (!title) {
        title = (await getMcodeSessionTitle(id)) || "Mcode session";
      }
      // Single base session — overlay record id === mcode session id,
      // idempotent create. Old model gave each mvs_ switch a fresh
      // uuid wrapper → the same conversation had two identities, the
      // direct cause of the "extra untitled entry" sidebar confusion.
      // Repeated switches now hit the same record.
      //
      // s39 (webui-parity ticket 39): the workspace argument is GONE.
      // The old `workspace: ws` here stamped the freshly-created overlay
      // with the CURRENT cs.workspace, so every first-touch of an mvs_
      // session from project A inherited project A's path. Switching
      // back to that mvs_ session from project B then either (a) was
      // ignored by the read-only switch path, leaving the file tree
      // stuck on B, or (b) — under the prior mutation — overwrote the
      // overlay's workspace with B's path, polluting every per-project
      // grouping. New overlays start with workspace:"" (set inside
      // ensureOverlayForMcodeSid when no value is passed); the
      // target-first read below then lands on DEFAULT_WORKSPACE for
      // first-touch mvs_ switches, with no per-session pollution.
      const existed = findOverlayForMcodeSid(all, id);
      target = ensureOverlayForMcodeSid(all, id, { title });
      target.updatedAt = Date.now();
      saveSessions(all);
      console.log(
        `[switch] cid=${cid} ${existed ? "reused" : "created"} overlay ${target.id.substring(0, 12)}… (id=mcode sid) title="${title}" titleSource=${titleSource}`,
      );
    } else {
      console.log(
        `[switch] cid=${cid} 404 id=${id} not found and not mcode sid`,
      );
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "session not found" }));
    }
  } else if (
    // Placeholder refresh — wrappers created during a broken-title
    // window carry "Mcode session" forever. If the walked cache now
    // has the real title, repair the stored wrapper. Cache-only (sync,
    // no ACP boot): an existing wrapper must never make the hot path
    // slower.
    target.title === "Mcode session" &&
    target.mcodeSessionId &&
    /^mvs_[a-f0-9]{32}$/.test(target.mcodeSessionId)
  ) {
    const cachedTitle = _lookupCachedMcodeTitle(
      target.mcodeSessionId,
      (cs.workspace && cs.workspace.dir) || "",
    );
    if (cachedTitle) {
      target.title = cachedTitle;
      target.updatedAt = Date.now();
      saveSessions(all);
      console.log(
        `[switch] cid=${cid} refreshed placeholder title for ${target.id.substring(0, 8)}… → "${cachedTitle}"`,
      );
    }
  }
  // Transcript backfill — when the resolved target has NO webui chat
  // yet but IS a real mvs_ session, load the mcode transcript from
  // the runtime DB (read-only) and map it into the webui chat-line
  // grammar BEFORE responding, so response session.chat and cs.chat
  // carry history. Caps inside (last 400 lines / 200KB) keep the SSE
  // state push bounded; a 1000+-message session must not balloon it.
  //
  // session-isolation/06 (persist hygiene): the original rule only
  // backfilled when target.chat was empty, so a polluted buffer
  // (the cumulative-render bug from Item 1, before its fix) would
  // persist via saveSessions and win forever. The new rule is:
  //   - if stored chat is empty → backfill (unchanged).
  //   - if stored chat looks cumulative → prefer DB read and re-persist.
  //     "cumulative" = at least two `●` lines whose text is a strict
  //     superset of an earlier `●` line (the engine emits each
  //     segment's full text per line, so a non-cumulative buffer has
  //     no such inclusion pair).
  //   - otherwise → keep stored chat. DB-authoritative: transcript-sync
  //     overwrites the stored chat from the engine DB on the next tick
  //     (~4s later), so any stored-only lines a user typed into the
  //     composer but never sent will be lost. The rule above does not
  //     promise draft preservation; it promises to NOT clobber a
  //     clean stored buffer with the DB read on every switch. Draft
  //     preservation is a separate concern (the composer keeps its
  //     own draft in its own state, see composer-draft.test.ts).
  // FAILURE MUST NOT BREAK SWITCHING: any error logs and continues
  // with the original chat — the switch itself always succeeds.
  if (
    target.mcodeSessionId &&
    /^mvs_[a-f0-9]{32}$/.test(target.mcodeSessionId)
  ) {
    const storedHasChat = Array.isArray(target.chat) && target.chat.length > 0;
    const storedCumulative = storedHasChat && chatLooksCumulative(target.chat);
    const shouldBackfill =
      !storedHasChat || storedCumulative;
    if (shouldBackfill) {
      try {
        const r = loadTranscriptChatLines(target.mcodeSessionId, {
          dbPath: MCODE_RUNTIME_DB,
        });
        if (r.ok && r.lines.length > 0) {
          const dbEmpty = target.chat.length === 0;
          const dbShrinks = r.lines.length < target.chat.length;
          const reason = dbEmpty
            ? "empty"
            : storedCumulative
              ? "stored_cumulative"
              : "stored_shrinks";
          target.chat = r.lines;
          target.updatedAt = Date.now();
          saveSessions(all); // persist the populated wrapper (updatedAt bumped)
          console.log(
            `[switch] cid=${cid} transcript backfill ${target.id.substring(0, 8)}… mcode=${target.mcodeSessionId.substring(0, 12)}… reason=${reason} lines=${r.lines.length} msgs=${r.messageCount} probe=${r.probe}${r.truncated ? " (capped)" : ""}`,
          );
        } else if (!r.ok) {
          console.log(
            `[switch] cid=${cid} transcript unavailable for ${target.mcodeSessionId.substring(0, 12)}… reason=${r.reason || "unknown"}`,
          );
        } else if (storedCumulative) {
          // Cumulative buffer + DB read came back empty — preserve
          // the stored chat (which is at least the user's last view)
          // and log the discrepancy so a post-mortem can see what
          // happened.
          console.log(
            `[switch] cid=${cid} stored chat looked cumulative but DB read returned no lines; preserving stored chat for ${target.mcodeSessionId.substring(0, 12)}…`,
          );
        }
      } catch (e) {
        console.warn(
          `[switch] cid=${cid} transcript backfill failed for ${target.mcodeSessionId.substring(0, 12)}… (continuing with stored chat):`,
          e && e.message ? e.message : e,
        );
      }
    }
  }
  const prevSid = cs.sessionId;
  // s39 (webui-parity ticket 39): resolve the target session's workspace
  // and re-point cs.workspace.dir to it BEFORE any other cs mutation,
  // so the SSE state push (pushStateFor at the end) and the response
  // session payload both carry the new workspace in lockstep with the
  // session-id switch. The pre-fix behaviour read cs.workspace without
  // writing it, which left the file tree bound to the previous project;
  // this is the user-reported defect the ticket fixes.
  //
  // Containment gate is mandatory (s39 boundary): session-stored
  // workspace is historical input — it may point to a directory the
  // user removed from the allowed roots since the session was last
  // opened, or to a path that was legal at the time but no longer is.
  // assertWorkspacePath runs the same boundary the workspace picker,
  // browseWorkspace, and the new-session POST funnel through; refusing
  // here keeps that boundary singular.
  const currentWs = (cs && cs.workspace && cs.workspace.dir) || "";
  const switchWs = _resolveSwitchWorkspace(target, currentWs);
  if (!switchWs.ok) {
    console.log(
      `[switch] cid=${cid} REFUSED id=${id.substring(0, 12)}… reason=workspace_containment attempted="${switchWs.attempted}"`,
    );
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: switchWs.error,
      attempted: switchWs.attempted,
    }));
  }
  // cs.sessionId / mcodeSessionId / title / chat come first; the
  // workspace write is paired with the session-id swap. Last-used-ws
  // is intentionally untouched (a switch is browsing, not a workspace
  // change — see the comment on handleWorkspaceChange for the same
  // reasoning that protects lastUsedWorkspace from the switch path).
  cs.sessionId = target.id;
  cs.mcodeSessionId = target.mcodeSessionId || null;
  cs.sessionTitle = target.title || "Untitled";
  cs.chat = Array.isArray(target.chat) ? target.chat : [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  cs.workspace = {
    dir: switchWs.dir,
    branch: null,
    tree: null,
  };
  if (switchWs.fallback) {
    console.log(
      `[switch] cid=${cid} target ${target.id.substring(0, 8)}… had no workspace — fell back to DEFAULT_WORKSPACE=${switchWs.dir}`,
    );
  }
  // Switching session must NOT mutate cs.lastUsedWorkspace — last-used
  // is written only by handleSend (workspace change / send prompt);
  // switching is browsing; pinning the browsed workspace to the top of
  // the sidebar was the user-reported "click any session in C and C
  // auto-sorts first" behavior.
  resetContext(cs);
  // Sync real token usage from mavis db on switch to a historical session
  if (cs.mcodeSessionId) {
    const switchedSid = cs.mcodeSessionId;
    applyMavisUsageToCs(cs, switchedSid, { getMcodeModelLimit })
      .then(() => pushStateFor(cid))
      .catch((e) => {
        if (process.env.MCODE_USAGE_DEBUG)
          console.warn(`[switch.mavis] cid=${cid} error: ${e.message}`);
      });
  }
  // B01: session switch — record which session was activated and from
  // which prior session. matchKind tells us whether we matched by
  // mcodeSessionId or webuiId (useful when debugging "why did this
  // resolve to session X"). prevSid is the prior session id (or "" if
  // this was the first switch). Fail-closed → 5xx + alert.
  try {
    _eventsAppend("session.switch", {
      target: cs.sessionId,
      cid,
      actor: "user",
      payload: {
        from: prevSid || "",
        matchKind: matchKind || "new_from_mcode",
        mcodeSessionId: cs.mcodeSessionId || "",
        title: cs.sessionTitle,
        // s39 (webui-parity ticket 39): record which workspace the
        // switch landed on, plus whether it was a fallback to
        // DEFAULT_WORKSPACE. Both pieces are useful when auditing
        // "why did the file tree change" or "why is the sidebar
        // sorting by a directory I never opened".
        workspace: switchWs.dir,
        workspaceFallback: !!switchWs.fallback,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "session.switch");
  }
  pushStateFor(cid);
  console.log(
    `[switch] cid=${cid} OK prev.sessionId=${prevSid ? prevSid.substring(0, 8) : "null"}… → new.sessionId=${cs.sessionId.substring(0, 8)}… title="${cs.sessionTitle}" chatLen=${cs.chat.length} workspace=${switchWs.dir}${switchWs.fallback ? " (DEFAULT_WORKSPACE fallback)" : ""}`,
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(
    JSON.stringify({
      ok: true,
      session: {
        id: target.id,
        mcodeSessionId: cs.mcodeSessionId,
        title: cs.sessionTitle,
        // s39 (webui-parity ticket 39): surface the new workspace in
        // the response so the client (url-restore + session-tree) can
        // update its in-memory state without waiting for the SSE
        // state-bus push to land — important for the file-tree panel
        // that re-roots under the new workspaceDir on first render.
        workspace: switchWs.dir,
        workspaceFallback: !!switchWs.fallback,
        // session-isolation/02 (run-mirror): switching back to the
        // session that is mid-run must show what it produced so far.
        // cs.chat holds the record's lines; the live turn's output is
        // still in the runChat buffer — re-attach it for the owning
        // view (same contract as every state snapshot).
        chat: runChatViewChat(cid, cs),
      },
    }),
  );
}

// POST /api/sessions/rename — rename a session (CRUD "update").
// body: { id, title }
//   id    — webui uuid or mvs_xxx (same resolution as DELETE /api/sessions/:id)
//   title — new title, non-empty after trim, at most 200 chars
//
// Flags the record titleCustom: true, which the automatic title write-back
// treats as user-authoritative. A bare mvs_ id with no webui record gets an
// overlay record to carry the title (single-identity rule, same as the switch
// path). Audit: session.rename records from → to, fail-closed. Not behind the
// authorize() modal — renaming is reversible; only destructive actions prompt.
//
// M3-B5: the write itself — resolve, overlay, title write, store save, tree
// cache drop, cross-tab title fan-out — happens in
// `engine/session-writes.js#applyEngineSessionRename`, and the response body
// is built there. What stays HERE is what is genuinely the route's: the three
// 400 bodies (request validation the facade has no business reproducing), the
// 404 status for the facade's `not_found` outcome, the fail-closed audit, and
// the log line. The facade's gate for this endpoint declares NO capability —
// a rename writes webui's own store and touches no engine surface; see the
// `SESSION_WRITE_ENDPOINTS` row for the full argument.
export async function handleRenameSession(req, res, ctx) {
  const cid = ctx.cid;
  const payload = await readJson(req);
  const id = (payload.id || "").trim();
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  if (!title) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "title required" }));
  }
  if (title.length > 200) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: false, error: "title too long (max 200)" }),
    );
  }
  const w = await applyEngineSessionRename({ id, title, cid });
  if (w.outcome === "not_found") {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(w.payload));
  }
  try {
    _eventsAppend("session.rename", {
      target: w.item.id,
      cid,
      actor: "user",
      payload: {
        matchKind: w.matchKind,
        from: w.from,
        to: w.to,
        mcodeSessionId: w.item.mcodeSessionId || "",
      },
    });
  } catch (e) {
    return _auditFail(res, e, "session.rename");
  }
  console.log(
    `[rename] cid=${cid} OK match=${w.matchKind} id=${w.item.id.substring(0, 8)}… "${w.from}" → "${w.to}"`,
  );
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(w.payload));
}

// DELETE /api/sessions/:id — delete a session.
//
// ?dryRun=true takes the readonly SQL path (counts rows per table,
// mutates nothing). Real delete passes authorize() and only then
// touches db / saveSessions / the caches (the gate is the only async hop
// on the real path).
//
// M3-B5: this handler is now a PLAN → GOVERN → COMMIT sequence, and that
// shape is the point rather than an accident of the refactor.
//
//   planEngineSessionDelete      resolves the id and runs the gate. No
//                                mutation, so it is safe to run BEFORE
//                                the user is asked anything.
//   authorize() + intent audit   unchanged, and still strictly between
//                                the plan and the commit. The write-ahead
//                                intent line has to be durably recorded
//                                before any row is removed, and it
//                                records the match kind and chat length
//                                the plan produced.
//   commit*EngineSessionDelete   splices the store, drops the tree cache,
//                                mirrors the delete into the engine's
//                                `local_runtime_*` tables and fans the
//                                cleared state out to every tab. The
//                                ORDER of those steps inside the facade
//                                is the resurrection guard; see the
//                                facade's module header.
//
// Every status code and every response body below is unchanged. The
// bodies are now BUILT in the facade rather than here, which is what lets
// the dryRun shape be pinned byte-for-byte by a unit test instead of by a
// route test that has to stand up the whole request.
export async function handleDeleteSession(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const id = ctx.pathname.slice("/api/sessions/".length);
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  // Parse ?dryRun=true|false from req.url
  let dryRun = false;
  try {
    const qIdx = (req.url || "").indexOf("?");
    if (qIdx >= 0) {
      const params = new URLSearchParams(req.url.slice(qIdx + 1));
      dryRun = params.get("dryRun") === "true";
    }
  } catch {}
  console.log(
    `[delete] cid=${cid} incoming id=${id.substring(0, 12)}… isMcodeSid=${isMcodeSessionId(id)} dryRun=${dryRun}`,
  );
  const plan = await planEngineSessionDelete({ id });
  // B03: real-delete path must pass per-request authorize() before
  //   mutating db / saveSessions / the caches.
  //   dryRun=true bypasses (preview only — no side effects to gate).
  if (!dryRun) {
    const authResult = await authorize("session.delete", {
      cid,
      targetSessionId: id,
      matchKind: plan.matchKind || (plan.isOrphan ? "unknown" : "webuiId"),
      isMcodeSid: isMcodeSessionId(id),
      isOrphan: plan.isOrphan,
      chatLen: plan.chatLen,
    });
    if (!authResult.approved) {
      console.log(
        `[delete] cid=${cid} DECLINED id=${id.substring(0, 12)}… reason=${authResult.decidedBy}`,
      );
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        ok: false,
        error: "authorize declined",
        decidedBy: authResult.decidedBy,
        decidedAt: authResult.decidedAt,
      }));
    }
    // Write-ahead audit (2026-09-20 rigor fix): the destructive intent
    // MUST be durably recorded BEFORE any persistent mutation (db rows,
    // sessions store, subprocess kill). If this append fails we abort
    // the delete entirely — an unaudited destructive action is the one
    // failure mode this gate exists to prevent. The matching outcome
    // event (kind "session.delete") is written after the mutation.
    try {
      _eventsAppend("session.delete.intent", {
        target: id,
        cid,
        actor: "user",
        payload: {
          matchKind: plan.matchKind || "unknown",
          isOrphan: plan.isOrphan,
          chatLen: plan.chatLen,
          decidedBy: authResult.decidedBy,
        },
      });
    } catch (e) {
      return _auditFail(res, e, "session.delete.intent");
    }
  }
  // Fallback: id is mvs_xxx but absent from webui session db —
  // treat it as an orphan mcode session and delete the SQL rows
  // directly (the webui side has no wrapper to remove).
  if (plan.isOrphan) {
    if (isMcodeSessionId(id)) {
      const w = await commitEngineOrphanSessionDelete({ plan, cs, cid, dryRun });
      console.log(
        `[delete] cid=${cid} ORPHAN mcode session sid=${id.substring(0, 12)}… ok=${w.mcodeDbDel.ok}` +
          (w.mcodeDbDel.ok
            ? ` log=[${(w.mcodeDbDel.log || []).join(",")}]`
            : ` reason=${w.mcodeDbDel.reason || "-"} error=${w.mcodeDbDel.error || "-"}`),
      );
      if (w.failed) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(w.payload));
      }
      // B01: orphan mcode session deletion (no webui session row).
      // Outcome event; the intent line was written before the gate
      // fan-out above. Failure → 5xx + alert (rows are already gone;
      // the operator must see the audit gap, not a silent success).
      try {
        _eventsAppend("session.delete", {
          target: id,
          cid,
          actor: "user",
          payload: {
            matchKind: "orphan_mcode",
            dryRun,
            rowsAffected: (w.mcodeDbDel.log || []).length,
          },
        });
      } catch (e) {
        return _auditFail(res, e, "session.delete(orphan_mcode)");
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      return res.end(JSON.stringify(w.payload));
    }
    console.log(`[delete] cid=${cid} 404 id=${id.substring(0, 12)}… not found`);
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "session not found" }));
  }
  // dryRun: 不真删 webui session entry,只预览 mcode db 影响
  if (dryRun) {
    const w = await previewEngineSessionDelete({ plan });
    console.log(
      `[delete] cid=${cid} DRYRUN id=${id.substring(0, 12)}… mcodeDbDel=${JSON.stringify(w.mcodeDbDel)}`,
    );
    // B01: dryRun is itself a state-touching action — the operator
    // is previewing a delete, so record the preview but never the
    // actual session content. dryRun:true marker lets verify / audit
    // distinguish "actually deleted" from "previewed delete".
    // Fail-closed → 5xx + alert (preview didn't mutate, but an
    // unaudited preview still misleads the operator's audit view).
    try {
      _eventsAppend("session.delete", {
        target: id,
        cid,
        actor: "user",
        payload: {
          matchKind: plan.matchKind,
          dryRun: true,
          previewedRows: w.mcodeDbDel.totalRows || 0,
        },
      });
    } catch (e) {
      return _auditFail(res, e, "session.delete(dryRun)");
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    return res.end(JSON.stringify(w.payload));
  }
  const w = await commitEngineSessionDelete({ plan, cid });
  // B01: real session delete (the dangerous one). Record which webui
  // session was deleted, what the match kind was, how many cids had
  // their active session cleared (this is the "fan-out" effect that
  // surprised users historically), and the mcode db deltas. Title
  // is logged (not sensitive — it was user-visible in the sidebar).
  // Outcome event; failure → 5xx + alert. The deletion itself already
  // happened — we do NOT paper over it with a 200, the operator must
  // see both the response failure and the alert.
  try {
    _eventsAppend("session.delete", {
      target: id,
      cid,
      actor: "user",
      payload: {
        matchKind: plan.matchKind,
        dryRun: false,
        remaining: w.records.length,
        touchedCids: w.touchedCids.length,
        mcodeRowsAffected: w.mcodeDbDel && w.mcodeDbDel.log ? w.mcodeDbDel.log.length : 0,
        title: w.deletedItem.title,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "session.delete");
  }
  console.log(
    `[delete] cid=${cid} OK match=${plan.matchKind} deleted.webuiId=${w.deletedItem.id.substring(0, 8)}… remaining=${w.records.length}`,
  );
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(w.payload));
}

// GET /api/session-tree — the sidebar's Project → directory → session → subagent
// tree, read from mcode's runtime db (see lib/session-tree.js for the level
// mapping and for why git, not the db's own per-directory project_id, decides
// what a project is).
//
// `?refresh=1` bypasses the 15s cache. A db that cannot be read is not a client
// error: `ok:false` + `reason` lets the sidebar fall back to the wrapper list
// instead of rendering an empty tree.
//
// M3-B2: the read goes through the engine facade, which gates it on the
// provider's declared `sessionCrud.listSessions` and then forwards to the very
// same `getSessionTree`. The payload below is `tree` verbatim — same keys, same
// node shape, same `ok:false` soft-fail. The subtree hierarchy is built by
// `buildTree` from `parent_session_id` and is NOT re-derived here; a child that
// fails to attach to its parent is a subagent the user cannot see, so the tree
// has exactly one assembler and it is not this route.
export async function handleSessionTree(req, res, _ctx) {
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  let payload;
  try {
    ({ tree: payload } = await readEngineSessionTree({ force }));
  } catch (cause) {
    // Re-throw the capability gate, and only it. `invokeHandler` maps
    // `EngineCapabilityNotSupportedError` to 501 — the deliberate "this
    // provider cannot list sessions" answer — whereas this catch exists
    // for the OTHER failures (a db that cannot be read, an assembler bug),
    // which the sidebar is built to degrade on. Folding the capability
    // error in here would answer `200 {ok:false}` to a request the server
    // is refusing on purpose: the fake success the gate exists to prevent.
    //
    // The test is the class's own `instanceof` helper, not a `.name`
    // compare. `name` is a writable instance property, so one stray
    // `err.name = "…"` upstream would silently turn that 501 back into the
    // soft failure — a failure mode that reads as a passing test.
    if (isEngineCapabilityNotSupportedError(cause)) throw cause;
    payload = {
      ok: false,
      reason: "session_tree_failed",
      detail: String(cause && cause.message ? cause.message : cause),
    };
  }
  // Always 200: a soft failure (`ok:false` + `reason`, e.g. the runtime db is
  // missing) is a normal state the sidebar handles, not a transport error. The
  // client's `request()` helper turns any non-2xx into a thrown `HTTP <status>`,
  // which would hide the reason.
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  return res.end(JSON.stringify(payload));
}

// GET /api/acp-sessions?cwd=... — mcode acp session/list
//
// M3-B1: the read goes through the engine facade
// (engine/session-reads.js) so the sidebar's data source is a DECLARED
// capability rather than "whatever the transport happens to be". A
// provider that does not declare `sessionCrud.listSessions` answers 501
// through app.js#invokeHandler instead of an empty list. The response
// shape is byte-for-byte what it was: the facade forwards to the same
// `getMcodeSessionsForWorkspace` (same 30s cache, same cwd
// normalisation, same `catalogue-sessions.js` projection on the runtime
// path).
export async function handleAcpSessions(req, res, ctx) {
  const cs = ctx.cs;
  const url = new URL(req.url, "http://localhost");
  const cwd =
    url.searchParams.get("cwd") || (cs.workspace && cs.workspace.dir) || "";
  const { sessions } = await readEngineSessionListForWorkspace({ cwd });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, cwd, sessions }));
}

// GET /api/acp-session-title?sessionId=...
//
// M3-B1: gated on `sessionCrud.getSession` — the engine method the ACP
// `session/list` title lookup corresponds to. `title` stays `null` for
// both "no such session" and "engine has no title": the endpoint has
// always collapsed those two and callers depend on it.
export async function handleAcpSessionTitle(req, res, _ctx) {
  const url = new URL(req.url, "http://localhost");
  const sid = url.searchParams.get("sessionId") || "";
  if (!sid) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "sessionId required" }));
  }
  const { title } = await readEngineSessionTitle({ sessionId: sid });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({ ok: true, sessionId: sid, title: title || null }),
  );
}

// Lease C05: GET /api/sessions/search?q=<text>&workspace=<path>&limit=<n>
//   Cross-workspace session search. The sidebar's client-side search
//   only filtered the already-loaded list — it could not surface sessions stored under
//   a different `workspace` field. This endpoint walks the persisted
//   sessions JSON so typing into the sidebar box can show matches
//   across all workspaces the user has touched.
//
//   Query params:
//     q          fuzzy substring match on session.title (case-insensitive).
//                Required for the search to return anything; empty q
//                returns [] (use GET /api/sessions for "list all").
//     workspace  optional exact workspace path filter. Empty = all
//                workspaces. When set, the dedup-by-workspace rule
//                below is a no-op (every result already shares the
//                same workspace).
//     limit      default 20, max 100, min 1. Out-of-range is clamped.
//
//   Response: [Array<{id, title, workspace, updatedAt, matchScore}>]
//     matchScore is a deterministic 0-100 integer that the client can
//     use to sort results. Higher = better match:
//       100  exact title == q
//        50  title startsWith q
//        10  title contains q (case-insensitive)
//         1  chat-tail fallback (rare; old sessions without titles)
//         0  no title but id contains q
//
//   Dedup rule: "同名 workspace 的 session 只保留最近一条". For each
//   unique workspace path that produced a match, we keep only the
//   session with the highest matchScore; on tie, the most recent
//   updatedAt wins. This collapses repeated search hits in one
//   workspace to a single representative row.
//
//   Gate (B03 / integration touchpoint): cross-workspace search
//   exposes titles from workspaces the user may have left open. We
//   gate with authorize("session.search", ctx). The new action name
//   is appended to AUTHORIZE_ACTIONS in server/lib/authorize.js so
//   the whitelist check accepts it. In production this pops the same
//   needs_authorization SSE modal as session.delete / session.export;
//   tests drive the decision via test/_setup.js#withDecisions (the
//   execArgv auto-approve was removed in the 2026-09-20 rigor fix).
//
//   Audit (B01): the search itself is non-destructive so we do NOT
//   append a session.search event by default. The authorize call
//   already writes auth.pending / auth.approve / auth.reject events
//   to the same chain, which is enough for audit purposes.
export async function handleSearchSessions(req, res, ctx) {
  const cid = (ctx && ctx.cid) || "";
  const url = new URL(req.url, "http://localhost");
  const q = (url.searchParams.get("q") || "").trim();
  const workspaceParam = (url.searchParams.get("workspace") || "").trim();
  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (!Number.isFinite(limit)) limit = 20;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  // B03 gate: cross-workspace reads surface titles from workspaces
  //   the user is not currently in. Gate the same way session.delete
  //   / session.export are gated. Tests drive the real decision path
  //   via test/_setup.js#withDecisions.
  const authResult = await authorize("session.search", {
    cid,
    q,
    workspace: workspaceParam,
    limit,
  });
  if (!authResult.approved) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: "authorize declined",
      decidedBy: authResult.decidedBy,
      decidedAt: authResult.decidedAt,
    }));
  }
  // q empty: by spec, search is a no-op (not a list-all endpoint).
  //   Returning [] keeps the client UX simple — empty box == empty
  //   result, and the existing renderSessions path handles "no
  //   search" with the full list.
  if (!q) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, results: [] }));
  }
  const all = loadSessions();
  const qLower = q.toLowerCase();
  // Per-session score: deterministic 0-100 integer.
  //   We score on title first (it's the user-visible label); id is
  //   a secondary fallback so typing part of a session id still
  //   finds it.
  function scoreSession(s) {
    const title = (s && s.title ? String(s.title) : "").trim();
    const titleLower = title.toLowerCase();
    if (titleLower && titleLower === qLower) return 100;
    if (titleLower && titleLower.startsWith(qLower)) return 50;
    if (titleLower && titleLower.includes(qLower)) return 10;
    const id = (s && s.id ? String(s.id) : "").toLowerCase();
    if (id && id.includes(qLower)) return 1;
    return 0;
  }
  // Filter by workspace if requested, then by score > 0.
  const scored = [];
  for (const s of all) {
    if (!s || typeof s !== "object") continue;
    if (workspaceParam) {
      const ws = (s.workspace || "").trim();
      if (ws !== workspaceParam) continue;
    }
    const score = scoreSession(s);
    if (score <= 0) continue;
    scored.push({
      id: s.id || "",
      title: (s.title || "").toString(),
      workspace: (s.workspace || "").toString(),
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
      matchScore: score,
    });
  }
  // Dedup by workspace: keep the best match per workspace path.
  //   Empty-string workspace (legacy / unset) is its own bucket — it
  //   still gets one representative row.
  const bestByWs = new Map();
  for (const item of scored) {
    const wsKey = item.workspace || "";
    const prev = bestByWs.get(wsKey);
    if (!prev) {
      bestByWs.set(wsKey, item);
      continue;
    }
    if (item.matchScore > prev.matchScore) {
      bestByWs.set(wsKey, item);
    } else if (
      item.matchScore === prev.matchScore &&
      item.updatedAt > prev.updatedAt
    ) {
      bestByWs.set(wsKey, item);
    }
  }
  // Sort: score desc, then updatedAt desc, then workspace asc (stable).
  const results = [...bestByWs.values()];
  results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return (a.workspace || "").localeCompare(b.workspace || "");
  });
  const limited = results.slice(0, limit);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, results: limited }));
}

// B03 + AP11 fix: POST /api/sessions/cleanup-orphans
//   Wires the missing endpoint that ANTI-PATTERNS-FIX-PLAN §AP11 noted
//   as documented-but-unimplemented. The endpoint:
//     1) dryRun=true  → preview only (count + would-be-deleted ids).
//                       Skips authorize() because no side effects occur.
//     2) dryRun=false (or absent) → real delete path. Must pass
//                       authorize('sessions.cleanup-orphans', ctx) first.
//                       Each session is fed through handleDeleteSession's
//                       real-delete branch so the audit trail / mcode
//                       db cleanup / cross-tab fan-out stay consistent.
//   The cleanup targets: default-named webui sessions (New session /
//   Untitled / 对话 N) whose chat is empty AND whose updatedAt is older
//   than 24h — same rule as cleanupEmptyDefaultSessions() in lib/sessions.js.
//
// M3-B5: the SELECTION moved into the facade
// (`engine/session-writes.js#readOrphanSessionWriteIds`), together with
// the store read it applies the rule to and with the two response bodies
// the batch's red line pins byte-for-byte. The rule and the file it reads
// are one decision; splitting them across two modules is how a sweep ends
// up pruning a different store than the one it was written for.
//
// The DELEGATION stays here and is not an oversight. Each selected id is
// routed back through `handleDeleteSession` precisely so that every
// orphan costs the same `session.delete.intent` / `session.delete` audit
// pair, the same authorize() decision and the same cross-tab fan-out that
// a hand-deleted session costs. Re-implementing the delete inside the
// sweep would produce a cheaper path that is not the same path, and the
// audit chain is the thing this endpoint exists to preserve.
import { readJson } from "../lib/read-json.js";

export async function handleCleanupOrphans(req, res, ctx) {
  const cid = (ctx && ctx.cid) || "";
  let dryRun = false;
  try {
    const qIdx = (req.url || "").indexOf("?");
    if (qIdx >= 0) {
      const params = new URLSearchParams(req.url.slice(qIdx + 1));
      dryRun = params.get("dryRun") === "true";
    }
  } catch {}
  const sweep = await readOrphanSessionWriteIds();
  const targetIds = sweep.ids;
  // Preview path: no authorize gate (no side effects). The body is
  // `{ok, dryRun, count, ids}` — four keys, in that order — and it is
  // built in the facade so that shape has exactly one home.
  if (dryRun) {
    console.log(
      `[cleanup-orphans] cid=${cid} DRYRUN would-delete=${targetIds.length}`,
    );
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(sweep.payload));
  }
  // Real path: gate with authorize() before touching any session.
  if (targetIds.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, dryRun: false, deleted: 0, ids: [] }));
  }
  const authResult = await authorize("sessions.cleanup-orphans", {
    cid,
    orphanCount: targetIds.length,
    orphanIds: targetIds.slice(0, 32), // truncated for log hygiene
  });
  if (!authResult.approved) {
    console.log(
      `[cleanup-orphans] cid=${cid} DECLINED count=${targetIds.length} reason=${authResult.decidedBy}`,
    );
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: "authorize declined",
      decidedBy: authResult.decidedBy,
      decidedAt: authResult.decidedAt,
    }));
  }
  // Write-ahead audit: record the sweep intent BEFORE any per-session
  // delete runs (each delegated delete writes its own
  // session.delete.intent / session.delete pair). Failure aborts the
  // whole sweep — orphan deletion is destructive and must not proceed
  // unaudited.
  try {
    _eventsAppend("sessions.cleanup-orphans.intent", {
      target: "sessions.cleanup-orphans",
      cid,
      actor: "user",
      payload: {
        orphanCount: targetIds.length,
        orphanIds: targetIds.slice(0, 32),
        decidedBy: authResult.decidedBy,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "sessions.cleanup-orphans.intent");
  }
  // Approved: delegate each delete to handleDeleteSession so the
  //   existing fan-out / mcode db cleanup / cross-tab reset logic
  //   stays in one place. We synthesize a minimal `req` with the
  //   target id so the handler can route as if it came from HTTP.
  const deleted = [];
  const failed = [];
  for (const id of targetIds) {
    try {
      const fakeReq = {
        url: `/api/sessions/${encodeURIComponent(id)}`,
      };
      const fakeRes = {
        _status: 200,
        _body: "{}",
        writeHead(s, _h) { this._status = s; },
        end(b) { this._body = b ? String(b) : "{}"; },
      };
      await handleDeleteSession(fakeReq, fakeRes, ctx);
      // handleDeleteSession already wrote authorize-gated session.delete
      // events. Parse its result for our summary.
      let summary = {};
      try { summary = JSON.parse(fakeRes._body || "{}"); } catch {}
      if (fakeRes._status === 200 && summary.ok) deleted.push(id);
      else failed.push({ id, status: fakeRes._status, reason: summary.error || "unknown" });
    } catch (e) {
      failed.push({ id, error: e && e.message ? e.message : String(e) });
    }
  }
  console.log(
    `[cleanup-orphans] cid=${cid} OK deleted=${deleted.length} failed=${failed.length}`,
  );
  // Outcome event for the sweep as a whole. Failure → 5xx + alert:
  // some or all deletes already ran, so the operator must see the
  // audit gap rather than a silent 200.
  try {
    _eventsAppend("sessions.cleanup-orphans.done", {
      target: "sessions.cleanup-orphans",
      cid,
      actor: "user",
      payload: {
        deleted: deleted.length,
        failed: failed.length,
        decidedBy: authResult.decidedBy,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "sessions.cleanup-orphans.done");
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({
    ok: true,
    dryRun: false,
    deleted: deleted.length,
    failed: failed.length,
    deletedIds: deleted,
    failedItems: failed,
    decidedBy: authResult.decidedBy,
    decidedAt: authResult.decidedAt,
  }));
}
