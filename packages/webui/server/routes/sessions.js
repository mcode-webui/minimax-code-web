// webui/server/routes/sessions.js
// GET/POST /api/sessions, POST /api/sessions/switch, DELETE /api/sessions/:id,
// POST /api/sessions/rename (CRUD "改" — user-set title, titleCustom),
// GET /api/acp-sessions, GET /api/acp-session-title,
// GET /api/sessions/search (Lease C05 — cross-workspace fuzzy match)
// (v0.5.bx-33: 删 POST /api/sessions/cleanup-orphans — Wzdhehe 不要这个 UI,API 一起删)
//
// What is left in this file after M3 is the HTTP surface of the session
// endpoints: parse the request, pick the status code, run the fail-closed
// audit, push the SSE frame, answer. Every endpoint that crosses the
// engine seam now asks `engine/` instead of this file's own imports —
// #9 #10 #72 #74 #75 (B1), #8 #11 (B2), #15 #16 #17 #19 (B3),
// #20 #57 #73 (B4), #7 #4 #6 (B5), #3 (B6) — and the imports that
// remain below are the ones that are genuinely webui-local: the session
// store, the workspace gate and the audit sink.

import { randomUUID } from "node:crypto";
import {
  loadSessions,
  saveSessions,
  resetContext,
} from "../lib/sessions.js";
// `pushStateFor` stays a direct import: it is a pure SSE write with no
// I/O and no engine surface, and three of this module's handlers call it
// on their way out. `clients` and `runChatViewChat` left this file in
// M3-B5 and M3-B6 respectively — the delete fan-out enumerates clients
// inside the facade, and the run-mirror projection belongs with the
// switch that produces it.
import { pushStateFor } from "../lib/state-bus.js";
// M3-B1 (engine facade): #9 and #10 read the engine through the declared
// capability rather than straight off the ACP client. Both facade
// functions forward to the same acp-client exports this module used to
// import directly, so the wire shape, the cache and the transport switch
// are unchanged — only the gate in front of them is new.
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
//   - M4-3a: the destructive step is the engine's own `deleteSession`,
//     reached through the facade's `engine/session-delete.js` data plane
//     by a dynamic import. The route still issues no SQL and names no
//     engine table; see KNOWN DEBT in `engine/session-writes.js`.
import {
  applyEngineSessionRename,
  commitEngineOrphanSessionDelete,
  commitEngineSessionDelete,
  isMcodeSessionId,
  planEngineSessionDelete,
  previewEngineSessionDelete,
  readOrphanSessionWriteIds,
} from "../engine/session-writes.js";
// M3-B6 (engine facade): #3 switch. This is the endpoint that emptied the
// most imports out of this file — the walked-session title cache
// (`lib/acp-client.js`), the transcript read (`lib/transcript.js`), the
// usage sync (`lib/mavis-usage.js` + `lib/models.js`), the switch
// workspace gate (`lib/workspace.js#assertWorkspacePath`, still imported
// for handleNewSession) and `DEFAULT_WORKSPACE` / `MCODE_RUNTIME_DB`
// (`lib/config.js`, now referenced by no route in this file at all)
// all live behind `applyEngineSessionSwitch` now. See that module's
// header for the four load-bearing facts it took over, and KNOWN DEBT 1
// for why the 3-candidate transcript probe it forwards to survives this
// batch while the route's direct reach for it does not.
import { applyEngineSessionSwitch } from "../engine/session-switch.js";
// The capability-error predicate `handleSessionTree` uses to tell the gate's
// 501 apart from a soft-fail. Taken from the facade entry, which re-exports
// the same binding `app.js#invokeHandler` matches on, so the two ends of this
// protocol cannot drift onto two different notions of "is this the gate's
// error".
import { isEngineCapabilityNotSupportedError } from "../engine/index.js";
// PB-1 (session context actions): the four right-click endpoints —
// archive / pin / fork-options / fork. Same split as every other engine
// family above: the gate, the member resolution, the three-state host
// handling and the response bodies live in the facade; what stays here
// is the request parse, the status code and the audit. The pin endpoint
// is the family's only one that reads the PB-8 `getHostServices()`
// window rather than `host.cliService`, and its three absence codes
// (503 / 501 / 501) each get their own branch below — see the facade's
// KNOWN DEBT for why a presence gate is honest here where a capability
// key would be a 15th audited matrix entry for one method.
import {
  applyEngineSessionArchive,
  applyEngineSessionFork,
  applyEngineSessionPin,
  applyPinnedSessionOverlay,
  parseArchiveRequestBody,
  parsePinRequestBody,
  readEnginePinnedSessionOrder,
  readEngineSessionForkOptions,
} from "../engine/session-context-actions.js";
import { authorize, hasDecidableRequester } from "../lib/authorize.js";
import { pushAlert } from "../lib/alerts.js";
import { append as _eventsAppend } from "../lib/events.js";
// Session-create workspace gate: body.workspace is user input and used to be
// trusted verbatim — no existence check, no containment check, no resolve —
// which made POST /api/sessions a side door around the workspace picker's
// containment gate (handleWorkspaceChange / browseWorkspace / fs routes all
// funnel through lib/workspace.js). Reuse assertWorkspacePath so every
// workspace write lands on the same boundary.
import { assertWorkspacePath } from "../lib/workspace.js";

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
//
// M3-B6 (engine facade): everything this endpoint does to the engine —
// resolve, first-touch overlay creation, the cache-first title lookup,
// the transcript backfill decision and its read, the workspace
// containment gate, the per-client state mutation and the response body
// — happens in `engine/session-switch.js#applyEngineSessionSwitch`, and
// the response shape is built there once. What stays HERE is what is
// genuinely the route's, and the split is the same one B5 drew for the
// write family:
//
//   - HTTP request parsing and the ONE validation body this endpoint
//     has. A missing id is a 400 with `{ok:false,error:"id required"}`
//     and a bare "application/json" content type, and that body has
//     nothing to do with the engine.
//   - THE STATUS CODES. The facade returns outcomes (`ok`,
//     `not_found`, `workspace_refused`) and never learns what a status
//     is; `statusHint` carries the number so the mapping is one table
//     here instead of three branches inside the engine layer.
//   - THE AUDIT, fail-closed. `_eventsAppend` THROWS on write failure
//     and a governance action must not complete with a missing audit
//     trail, so the append sits between the facade's work and the
//     response, and its failure answers 500 through `_auditFail`.
//   - The state push and the two log lines that bracket the response.
//
// The ordering constraint the facade could not own is the reason the
// audit stays put: the switch has ALREADY mutated `cs` by the time this
// append runs (that is pre-existing behaviour — a failed audit leaves
// the client switched and reports 500, which is what the operator sees
// today), and the SSE push must not fire when that append failed. Both
// properties are the route's to keep.
export async function handleSwitchSession(req, res, ctx) {
  const cid = ctx.cid;
  const payload = await readJson(req);
  const id = (payload.id || "").trim();
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  const r = await applyEngineSessionSwitch({ id, cs: ctx.cs, cid });
  if (r.outcome !== "ok") {
    const contentType =
      r.outcome === "workspace_refused"
        ? "application/json; charset=utf-8"
        : "application/json";
    res.writeHead(r.statusHint, { "Content-Type": contentType });
    return res.end(JSON.stringify(r.payload));
  }
  try {
    _eventsAppend(r.audit.event, {
      target: r.audit.target,
      cid: r.audit.cid,
      actor: r.audit.actor,
      payload: r.audit.payload,
    });
  } catch (e) {
    return _auditFail(res, e, r.audit.event);
  }
  pushStateFor(cid);
  console.log(
    `[switch] cid=${cid} OK prev.sessionId=${(r.audit.payload.from || "").substring(0, 8)}… → new.sessionId=${r.payload.session.id.substring(0, 8)}… title="${r.payload.session.title}" chatLen=${r.payload.session.chat.length} workspace=${r.payload.session.workspace}${r.payload.session.workspaceFallback ? " (DEFAULT_WORKSPACE fallback)" : ""}`,
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify(r.payload));
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
//                                the user is asked anything — and its
//                                verdict is what lets the handler skip
//                                the question entirely when the request
//                                provably deletes nothing.
//   authorize() + intent audit   unchanged, and still strictly between
//                                the plan and the commit. The write-ahead
//                                intent line has to be durably recorded
//                                before any row is removed, and it
//                                records the match kind and chat length
//                                the plan produced. P19: the gate is
//                                also the FIRST thing that touches the
//                                request's ownership — an unattributable
//                                request (no `?cid=`) and an id that
//                                resolves to nothing both end here,
//                                fast, and neither reaches the engine.
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
  // P19, first half — the OWNERSHIP gate, and the first thing this
  // handler decides.
  //
  // A request the router could not attribute to a client (`?cid=`
  // absent: a curl, a script, a caller that forgot `withClientQuery`)
  // has no owner to show a modal to. Left to `authorize` alone it falls
  // into the BROADCAST branch — an empty cid is the broadcast target,
  // so "somebody is connected" answers a question nobody asked and the
  // destructive request then waits out the full 300000ms budget against
  // a modal no human knows exists. That is the P19 hang: an open socket,
  // no status, no body.
  //
  // So the question is asked BEFORE the plan, deliberately: this gate
  // needs nothing the plan produces, and putting it first means the
  // answer costs no store read, no capability declaration and — the
  // point of the whole exercise — no engine delivery. The decline body
  // is built by `authorize` itself, so this path and the timeout path
  // downstream are byte-identical to what the client has always seen.
  //
  // `requireRequester` is what makes that call a short-circuit instead
  // of a modal. It is asked here ONLY when the requester is
  // unattributable, so the reduced `ctx` can never reach a human: the
  // attributable path below asks the full question, with the match kind
  // and chat length the plan produced, exactly as before.
  if (!dryRun && !hasDecidableRequester(cid)) {
    const owned = await authorize(
      "session.delete",
      { cid, targetSessionId: id, isMcodeSid: isMcodeSessionId(id) },
      { requireRequester: true },
    );
    console.log(
      `[delete] cid=${cid} DECLINED id=${id.substring(0, 12)}… reason=no_requester`,
    );
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: "authorize declined",
      decidedBy: owned.decidedBy,
      decidedAt: owned.decidedAt,
    }));
  }
  const plan = await planEngineSessionDelete({ id });
  // P19, second half: an id that resolves to NOTHING is not a
  // destructive request, and asking the user to authorize one is how a
  // 404 became a five-minute hold — the modal is live, the answer is
  // already "there is nothing here", and the only way out is the
  // fail-closed timeout.
  //
  // `isOrphan && !isMcodeSessionId(id)` is exactly that provable no-op:
  // the id is absent from the webui store, so there is no wrapper to
  // splice, and it is not an `mvs_` sid, so there are no engine rows to
  // delete either. The response is the 404 this branch has always
  // returned — same status, same body, see docs/API.md — reached WITHOUT
  // a governance round-trip and WITHOUT touching the engine. The
  // semantic is the engine facade's own `not_mcode_sid` /
  // `already_absent` pair (engine/session-delete.js), stated at the HTTP
  // layer instead of waited out.
  //
  // The gate below still runs for every request that CAN delete
  // something: a resolved record, or an orphan `mvs_` sid whose engine
  // rows are about to go. This branch narrows the gate, never bypasses
  // it, and runs before the write-ahead intent line — a no-op delete
  // must leave no audit trail of a destructive act.
  //
  // `?dryRun=true` stays on the old path (preview answers for any id,
  // gated by nothing, mutating nothing) so the preview contract is
  // unchanged.
  if (!dryRun && plan.isOrphan && !isMcodeSessionId(id)) {
    console.log(
      `[delete] cid=${cid} 404 id=${id.substring(0, 12)}… not found reason=not_mcode_sid`,
    );
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "session not found" }));
  }
  // B03: real-delete path must pass per-request authorize() before
  //   mutating db / saveSessions / the caches.
  //   dryRun=true bypasses (preview only — no side effects to gate).
  //
  // `requireRequester` stays on this call as the second line of the
  // same defence: the ownership gate above already returned for an
  // unattributable request, and this keeps the property attached to the
  // GATE rather than to one call site, so a future refactor that drops
  // the early check does not silently reopen the hang.
  if (!dryRun) {
    const authResult = await authorize(
      "session.delete",
      {
        cid,
        targetSessionId: id,
        matchKind: plan.matchKind || (plan.isOrphan ? "unknown" : "webuiId"),
        isMcodeSid: isMcodeSessionId(id),
        isOrphan: plan.isOrphan,
        chatLen: plan.chatLen,
      },
      { requireRequester: true },
    );
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
  // PB-1: the pin overlay. `lib/session-tree.js` reads
  // `local_runtime_sessions`, which has no pin column — the pin state
  // lives in the preference store the engine's `PinService` owns — so
  // the tree is read first and the pins are laid over it. The overlay is
  // applied ONLY to a successful tree: a soft-failed payload has no
  // `projects` to mark, and `applyPinnedSessionOverlay` returns such a
  // payload unchanged, which is one fewer branch to get wrong.
  //
  // The pin read DEGRADES by design (see
  // `readEnginePinnedSessionOrder`'s own header): a host that cannot
  // answer yields `pinnedIds: []`, and the sidebar renders the tree it
  // already has. The reason travels in `pins` so the response says
  // whether the absence is a fact ("nothing is pinned") or a failure
  // ("the engine could not tell us") — a client that cannot tell those
  // apart would show an empty pin section during an outage and read it
  // as "the user has no pins".
  if (payload && payload.ok === true) {
    const pins = await readEnginePinnedSessionOrder();
    payload = { ...applyPinnedSessionOverlay(payload, pins.pinnedIds), pins };
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
  // P19: `requireRequester` — same rule as DELETE. A search with no
  // `?cid=` has no owner to show the modal to; broadcasting it to
  // whichever tab is connected and then holding the request for the
  // full 300000ms budget is the hang P19 was filed about.
  const authResult = await authorize(
    "session.search",
    {
      cid,
      q,
      workspace: workspaceParam,
      limit,
    },
    { requireRequester: true },
  );
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
  // P19: `requireRequester` — a sweep is the most destructive gate in
  // this file, so an unattributable caller (no `?cid=`) must not be able
  // to park it on somebody else's browser tab for five minutes.
  const authResult = await authorize(
    "sessions.cleanup-orphans",
    {
      cid,
      orphanCount: targetIds.length,
      orphanIds: targetIds.slice(0, 32), // truncated for log hygiene
    },
    { requireRequester: true },
  );
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

// ---------------------------------------------------------------------------
// PB-1 — the session right-click action family
// ---------------------------------------------------------------------------
//
// Four endpoints, one per menu item, and the file's own rule applies to
// all of them: parse here, decide the status here, cross the engine seam
// through `engine/session-context-actions.js`. What the facade does NOT
// know is what an HTTP status is, so every failure it returns carries
// `code` + `status` and the mapping happens in the one helper below.
//
// The helper exists because the family's failure space is wider than the
// rest of this file's and getting it right four times is how one of them
// would drift:
//
//   400  the request itself is wrong (missing id, `pinned` not boolean)
//   501  the engine cannot do it — the capability gate's throw, a host
//        with no owner graph, or a host whose owner graph has no
//        `pinService`
//   502  the engine was asked and failed
//   503  no runtime is booted at all
//
// The distinction between 501 and 503 is the one an operator needs and
// the one a route that collapsed them would lose: 501 means "this
// transport cannot", 503 means "the process is not running its
// runtime", and they have different fixes.

/** Map a facade failure onto the wire. The `ok:true` case never arrives. */
function _contextActionFail(res, result) {
  const status = Number.isInteger(result.status) ? result.status : 500;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: false,
      code: result.code || "engine_call_failed",
      error: result.error || "the engine call failed",
    }),
  );
}

/**
 * The `:id` of a `POST|GET /api/sessions/:id/<verb>` path, sliced from
 * `ctx.pathname` the way `handleDeleteSession` does.
 *
 * Named because four handlers would otherwise each re-derive the same
 * two `indexOf` pair, and the copy that drifts is the one that starts
 * accepting `/api/sessions//archive` as a session id.
 *
 * @param {string} pathname
 * @param {string} verb The trailing path segment, e.g. `"archive"`.
 * @returns {string} The id, or `""` when the path does not end in `verb`.
 */
function _contextActionSessionId(pathname, verb) {
  const prefix = "/api/sessions/";
  const suffix = `/${verb}`;
  if (typeof pathname !== "string") return "";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return "";
  return pathname.slice(prefix.length, pathname.length - suffix.length);
}

// POST /api/sessions/:id/archive — archive (or unarchive) one session.
//
// `body.archived` selects the direction and defaults to `true`. The
// method covers both directions in the engine
// (`lifecycle-application.ts#archiveSession` reads `req.archived !==
// false`), so one endpoint serves both and PB-2's archived-tasks page
// restores a row by calling it with `archived: false`.
//
// No `authorize()` modal, and the reason is worth stating because
// `DELETE /api/sessions/:id` has one: archive is not destruction. The
// conversation is intact on the engine, the row leaves the sidebar and
// can be restored by the same call. A confirm dialog on a reversible
// action is a dialog the user learns to dismiss.
export async function handleArchiveSession(req, res, ctx) {
  const cid = ctx.cid;
  const id = _contextActionSessionId(ctx.pathname, "archive");
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  const payload = await readJson(req);
  const parsed = parseArchiveRequestBody(payload);
  if (!parsed.ok) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: parsed.error }));
  }
  const result = await applyEngineSessionArchive({ id, archived: parsed.archived });
  if (!result.ok) return _contextActionFail(res, result);
  // Write-ahead audit: a state change the user cannot see in the engine's
  // own UI is exactly the kind that needs a durable record, and it lands
  // after the engine confirmed the write rather than before — unlike
  // #7's delete, where the ordering protects an irreversible step.
  try {
    _eventsAppend(result.archived ? "session.archive" : "session.unarchive", {
      target: id,
      cid,
      actor: "user",
      payload: { archived: result.archived, mcodeSessionId: "" },
    });
  } catch (e) {
    return _auditFail(res, e, result.archived ? "session.archive" : "session.unarchive");
  }
  console.log(
    `[archive] cid=${cid} OK id=${id.substring(0, 8)}… archived=${result.archived}`,
  );
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(result.payload));
}

// POST /api/sessions/:id/pin — pin or unpin a session.
//
// The `pinned` flag is REQUIRED here, unlike `archived`. The engine's
// `pinSession(sessionId, pinned, insertIndex?)` takes it as a
// positional and branches on it, so `{}` is not a defaultable request:
// defaulting it would move the row in a direction the user did not
// choose. `parsePinRequestBody` owns that rule and is unit-tested on
// both directions.
export async function handlePinSession(req, res, ctx) {
  const cid = ctx.cid;
  const id = _contextActionSessionId(ctx.pathname, "pin");
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  const payload = await readJson(req);
  const parsed = parsePinRequestBody(payload);
  if (!parsed.ok) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: parsed.error }));
  }
  const result = await applyEngineSessionPin({ id, pinned: parsed.pinned });
  if (!result.ok) return _contextActionFail(res, result);
  try {
    _eventsAppend(result.pinned ? "session.pin" : "session.unpin", {
      target: id,
      cid,
      actor: "user",
      payload: { pinned: result.pinned, mcodeSessionId: "" },
    });
  } catch (e) {
    return _auditFail(res, e, result.pinned ? "session.pin" : "session.unpin");
  }
  console.log(`[pin] cid=${cid} OK id=${id.substring(0, 8)}… pinned=${result.pinned}`);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(result.payload));
}

// GET /api/sessions/:id/fork-options — what a fork of this session would
// be, before the user commits to one.
//
// The optional `?assistantMessageId=` narrows the preview to a fork
// POINT. Absent, the preview describes forking the whole conversation,
// which is what the menu item means when the user has not picked a
// message. The response is the facade's `projectForkOptions` narrowing
// — every field present on every answer, so the dialog never renders
// `undefined` — and the worktree triple travels through untouched for
// the batch that will consume it (see the facade's KNOWN DEBT 1).
export async function handleSessionForkOptions(req, res, ctx) {
  const id = _contextActionSessionId(ctx.pathname, "fork-options");
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  // Read the query off `req.url` rather than `ctx.pathname`, matching
  // `handleDeleteSession`'s `?dryRun` parse: the Hono context carries
  // the path, the query is still on the Node request.
  let assistantMessageId;
  try {
    const qIdx = (req.url || "").indexOf("?");
    if (qIdx >= 0) {
      assistantMessageId = new URLSearchParams(req.url.slice(qIdx + 1)).get("assistantMessageId") || undefined;
    }
  } catch {}
  const result = await readEngineSessionForkOptions({ id, assistantMessageId });
  if (!result.ok) return _contextActionFail(res, result);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, id, ...result.options }));
}

// POST /api/sessions/:id/fork — duplicate this conversation as a new
// session in the same workspace.
//
// `clientRequestId` is minted HERE rather than in the facade, so the
// per-request key is visible at the call site that owns the request. It
// is the engine's fork-deduplication key, which means a duplicate
// delivery of one POST does not create two forks while a user who
// genuinely duplicates twice gets two sessions — the distinction the
// menu item's meaning depends on.
//
// `createIsolatedWorktree` is forced `false` in the facade. The
// worktree variant of this menu has no desktop reference, so it stays
// an honest placeholder rather than becoming reachable by a flag.
export async function handleForkSession(req, res, ctx) {
  const cid = ctx.cid;
  const id = _contextActionSessionId(ctx.pathname, "fork");
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  const payload = await readJson(req);
  const assistantMessageId =
    typeof payload.assistantMessageId === "string" && payload.assistantMessageId
      ? payload.assistantMessageId
      : undefined;
  const result = await applyEngineSessionFork({
    id,
    assistantMessageId,
    clientRequestId: randomUUID(),
  });
  if (!result.ok) return _contextActionFail(res, result);
  try {
    _eventsAppend("session.fork", {
      target: id,
      cid,
      actor: "user",
      payload: {
        sourceId: id,
        newSessionId: result.sessionId,
        forkOriginMessageId: result.payload.forkOriginMessageId || "",
        createIsolatedWorktree: false,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "session.fork");
  }
  console.log(
    `[fork] cid=${cid} OK source=${id.substring(0, 8)}… new=${result.sessionId.substring(0, 8)}…`,
  );
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(result.payload));
}
