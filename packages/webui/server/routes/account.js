// webui/server/routes/account.js
// GET /api/account — the account card's data.

import { getAccountStatus } from "../lib/mcode-rpc.js";

/**
 * Fetched on demand rather than pushed in the state snapshot.
 *
 * The payload is the user's own display name, plan tier and quota. The snapshot
 * is broadcast to every SSE subscriber — including over the LAN when `lanBind`
 * is on — so account data does not belong in it. The engine's projection carries
 * no credential (see acp/extensions.ts), and nothing here logs the response.
 *
 * A failure is a soft one, like /api/session-tree: the card renders its empty
 * state rather than the route inventing a name or a plan.
 */
export async function handleGetAccount(_req, res, ctx) {
  const cs = ctx && ctx.cs;
  const r = await getAccountStatus(cs && cs.mcodeSessionId);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  if (!r.ok) {
    return res.end(JSON.stringify({ ok: false, reason: r.code || "account_unavailable" }));
  }
  return res.end(JSON.stringify({ ok: true, ...(r.data || {}) }));
}
