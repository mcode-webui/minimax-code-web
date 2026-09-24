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

/**
 * The engine's own version, from the `agentInfo` in its ACP `initialize` reply.
 *
 * This used to be a pinned constant, which meant the endpoint reported whatever
 * version webui was written against rather than the one installed. Before a
 * client attaches there is no version to report, hence `unknown` — the same
 * value `/api/protocol/capabilities` uses for the same fact.
 */
function engineVersion() {
  const info = getMcodeServerInfo();
  return (info && info.version) || "unknown";
}

export function handleHealth(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      port: getServingPort(),
      defaultModel: DEFAULT_MODEL,
      defaultWorkspace: DEFAULT_WORKSPACE,
      mcodeCmd: MCODE_CMD,
      mcodeVersion: engineVersion(),
      maxConcurrent: MAX_CONCURRENT,
    }),
  );
}
