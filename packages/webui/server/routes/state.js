// webui/server/routes/state.js
// GET /api/events (SSE) + GET /api/state

import {
  getClient,
  getCidFromReq,
  pushStateFor,
  pushOnlineCount,
  mcodeSessionsSnapshotFields,
  snapshotViewFields,
  getSseClient,
  setSseClient,
  endSseClient,
  sessionsListForSnapshot,
  nextRevisionFor,
} from "../lib/state-bus.js";
import { getCachedMcodeCommands } from "../lib/acp-client.js";
// M3-B1 (engine facade): the declared-capability gate in front of the
// mcodeSessions mirror. The SSE first frame below keeps calling
// `mcodeSessionsSnapshotFields` directly — the SSE channel is a P2
// migration, out of scope for this batch, and it must keep its exact
// pending/stale semantics.
import { readEngineSessionListForWorkspace } from "../engine/session-reads.js";
import { getLanBroadcast } from "../lib/settings.js";
import { applyMavisUsageToCs } from "../lib/mavis-usage.js";
import { getMcodeModelLimit } from "../lib/models.js";
import {
  getCurrentToken,
  getReadOnly,
  getTokenAcknowledged,
  getTokenEnabled,
  getTokenRotatedAt,
} from "../lib/settings.js";

export async function handleEvents(req, res, ctx) {
  const cid = getCidFromReq(req);
  const cs = getClient(cid);
  // 关掉旧 SSE（避免同一个 cid 有多个挂起连接）
  const old = getSseClient(cid);
  if (old) {
    try {
      old.end();
    } catch {}
  }
  res.writeHead(200, SSE_HEADERS);
  // v1.0: 首推也必须带 mcodeSessions 字段 (之前缺, 侧栏先渲染 webui 本地条目再闪回全量)
  // v1.0.1: 首推也必须带 settings fields (readOnly / tokenEnabled / currentToken
  //   conditional on acknowledged, etc) — 否则 sub-card 第一次 render 时是空的
  // ticket 08 (set-model SSE race): bump the per-cid revision so the first
  //   frame carries the same monotonic-counter the push path stamps. The
  //   counter starts fresh on a new connection — the previous connection's
  //   endSseClient deleted its entry, or this is the very first push for
  //   the cid.
  const firstFrameRevision = nextRevisionFor(cid);
  const snapshot = {
    ...cs,
    sessions: sessionsListForSnapshot(),
    // session-isolation/02 (run-mirror): the first frame follows the same
    // view contract as the push path — a client connecting mid-run sees
    // the owning session's buffered lines (or a clean idle view of the
    // session it opened instead).
    ...snapshotViewFields(cid, cs),
    ...mcodeSessionsSnapshotFields((cs.workspace && cs.workspace.dir) || ""),
    lanBroadcast: getLanBroadcast(),
    readOnly: getReadOnly(),
    tokenEnabled: getTokenEnabled(),
    currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
    tokenAcknowledged: getTokenAcknowledged(),
    tokenRotatedAt: getTokenRotatedAt(),
    revision: firstFrameRevision,
  };
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  setSseClient(cid, res);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 20000);
  req.on("close", () => {
    clearInterval(ping);
    endSseClient(cid, res);
    pushOnlineCount(getLanBroadcast()); // v0.5.ak: 客户端断开时广播在线数
  });
  pushOnlineCount(getLanBroadcast()); // v0.5.ak: 客户端新连接时广播在线数

  // v0.5.bx-29: SSE 连接时主动 hydrate mavis db 真值
  //   修: 之前只在 finalize() 里查 mavis db, 只更新发起 prompt 的那个 cid
  //        其它 CID (比如手机开了同一 session 但没发消息) 永远只看估算
  //   现在: 新 SSE 连接建立时, 如果该 cid 已经绑定了 mcodeSessionId, 立刻查 mavis db
  //         有真值就 pushStateFor 让该 cid 看到真值, 没有就保留估算
  //   fire-and-forget, 不阻塞 SSE 响应
  if (cs.mcodeSessionId) {
    const sid = cs.mcodeSessionId;
    Promise.resolve().then(() => {
      applyMavisUsageToCs(cs, sid, { getMcodeModelLimit })
        .then((applied) => {
          if (applied) pushStateFor(cid);
        })
        .catch(() => {
          /* swallow — keep estimate */
        });
    });
  }
  return true;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function handleState(req, res, ctx) {
  const cs = getClient(ctx.cid);
  // M3-B1: the mcodeSessions mirror now comes from the engine facade,
  // which gates it on the declared `sessionCrud.listSessions` and reports
  // (in the return value, not on the wire) whether the in-process host or
  // the ACP mirror answered. The VALUE is the same array the endpoint
  // built before — `readEngineSessionListForWorkspace` forwards to the
  // same `getMcodeSessionsForWorkspace`, cache and cwd normalisation
  // included. The snapshot body below is unchanged field for field:
  // `snapshotViewFields` / `mcodeSessionsSnapshotFields` are the
  // frontend's first-frame contract and this batch adds and removes
  // nothing.
  const { sessions: mcodeSessions } = await readEngineSessionListForWorkspace({
    cwd: (cs.workspace && cs.workspace.dir) || "",
    endpoint: "GET /api/state",
  });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  // v0.5.bx-29: /api/state 也尝试 hydrate mavis db 真值 (best-effort)
  //   SSE 客户端 (EventSource) 也会调这个端点, 所以 hydrate 也能发生在 reconnect 时
  if (cs.mcodeSessionId) {
    try {
      await applyMavisUsageToCs(cs, cs.mcodeSessionId, { getMcodeModelLimit });
    } catch {
      /* keep estimate */
    }
  }
  // ticket 08 (set-model SSE race): /api/state body also carries the
  //   per-cid revision so a caller that polls this endpoint sees the
  //   same monotonic sequence the SSE push emits.
  const stateRevision = nextRevisionFor(ctx.cid);
  return res.end(
    JSON.stringify({
      ...cs,
      sessions: sessionsListForSnapshot(),
      // session-isolation/02 (run-mirror): same view contract as the SSE
      // push path (see handleEvents).
      ...snapshotViewFields(ctx.cid, cs),
      mcodeSessions,
      availableCommands: getCachedMcodeCommands(),
      lanBroadcast: getLanBroadcast(),
      // v1.0.1: include the full settings surface so the sub-card
      // renders correctly on first /api/state fetch (before the SSE
      // connection delivers its first state push).
      readOnly: getReadOnly(),
      tokenEnabled: getTokenEnabled(),
      // Only send currentToken when not acknowledged — same policy as
      // the SSE push (see state-bus.js).
      currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
      tokenAcknowledged: getTokenAcknowledged(),
      tokenRotatedAt: getTokenRotatedAt(),
      revision: stateRevision,
    }),
  );
}
