// webui/server/routes/health.js
// GET /api/health — basic service info.

import {
  getServingPort,
  MAX_CONCURRENT,
  MCODE_CMD,
  DEFAULT_MODEL,
  DEFAULT_WORKSPACE,
} from "../lib/config.js";
// M3-B1 (engine facade): `mcodeVersion` is read through the facade so
// the endpoint records WHICH source answered. See
// `readEngineVersion` for why the answer is still the ACP `initialize`
// mirror — the in-process catalogue host exposes no version accessor, and
// inventing one is exactly the "claim a capability that does not exist"
// this batch exists to prevent.
import { readEngineVersion } from "../engine/session-reads.js";

export async function handleHealth(_req, res) {
  const { version } = await readEngineVersion();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      port: getServingPort(),
      defaultModel: DEFAULT_MODEL,
      defaultWorkspace: DEFAULT_WORKSPACE,
      mcodeCmd: MCODE_CMD,
      mcodeVersion: version,
      maxConcurrent: MAX_CONCURRENT,
    }),
  );
}
