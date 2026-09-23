// webui/server/routes/health.js
// GET /api/health — basic service info.

import {
  getServingPort,
  MAX_CONCURRENT,
  MCODE_CMD,
  DEFAULT_MODEL,
  DEFAULT_WORKSPACE,
} from "../lib/config.js";
import { getMcodeServerInfo } from "../lib/acp-client.js";

export function handleHealth(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      port: getServingPort(),
      defaultModel: DEFAULT_MODEL,
      defaultWorkspace: DEFAULT_WORKSPACE,
      mcodeCmd: MCODE_CMD,
      // Read-only peek at the ACP initialize handshake (agentInfo.version)
      // when a singleton is already up. Health never spawns the engine, so
      // a not-yet-started session reports "unknown" instead of a stale
      // fabricated number.
      mcodeVersion: getMcodeServerInfo()?.version || "unknown",
      maxConcurrent: MAX_CONCURRENT,
    }),
  );
}
