// webui/server/routes/state.js
// GET /api/state — full state snapshot (first-connect baseline for the
// /api/stream client; live frames then arrive over the stream).

import { getClient } from "../lib/state-bus.js";
import { loadSessions } from "../lib/sessions.js";
import {
  getMcodeSessionsForWorkspace,
  getCachedMcodeCommands,
} from "../lib/acp-client.js";
import { getLanBroadcast } from "../lib/settings.js";
import { applyMavisUsageToCs } from "../lib/mavis-usage.js";
import { getMcodeModelLimit } from "../lib/models.js";
import {
  getCurrentToken,
  getQuotaEnabled,
  getReadOnly,
  getTokenAcknowledged,
  getTokenEnabled,
  getTokenPlanApiKey,
  getTokenPlanApiKeyFilePath,
  getTokenPlanApiKeySource,
  getTokenRotatedAt,
  maskTokenPlanKey,
} from "../lib/settings.js";

export async function handleState(req, res, ctx) {
  const cs = getClient(ctx.cid);
  const mcodeSessions = await getMcodeSessionsForWorkspace(
    cs.workspace && cs.workspace.dir,
  );
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  // v0.5.bx-29: /api/state 也尝试 hydrate mavis db 真值 (best-effort)
  //   事件流客户端 (WebSocket /api/stream) 也会调这个端点, 所以 hydrate 也能发生在重连时
  if (cs.mcodeSessionId) {
    try {
      await applyMavisUsageToCs(cs, cs.mcodeSessionId, { getMcodeModelLimit });
    } catch {
      /* keep estimate */
    }
  }
  return res.end(
    JSON.stringify({
      ...cs,
      sessions: loadSessions(),
      mcodeSessions,
      availableCommands: getCachedMcodeCommands(),
      lanBroadcast: getLanBroadcast(),
      // v1.0.1: include the full settings surface so the sub-card
      // renders correctly on first /api/state fetch (before the event
      // stream delivers its first state push).
      readOnly: getReadOnly(),
      tokenEnabled: getTokenEnabled(),
      // Only send currentToken when not acknowledged — same policy as
      // the event-stream push (see state-bus.js).
      currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
      tokenAcknowledged: getTokenAcknowledged(),
      tokenRotatedAt: getTokenRotatedAt(),
      // v2026-08-28 modacker: Token Plan (套餐用量) feature fields —
      //   see state-bus.js for the rationale. /api/state is the path
      //   the client uses as a fallback when the event stream isn't
      //   connected yet (e.g., before the WebSocket attaches); it must
      //   carry the same fields as the event-stream snapshot.
      quotaEnabled: getQuotaEnabled(),
      hasTokenPlanKey: getTokenPlanApiKey().length > 0,
      tokenPlanApiKeyMasked: maskTokenPlanKey(),
      // v2026-08-28 modacker (A+C): external key source surface.
      tokenPlanApiKeySource: getTokenPlanApiKeySource(),
      tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
    }),
  );
}
