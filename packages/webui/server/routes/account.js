// webui/server/routes/account.js
// GET /api/account — the account card's data.
//
// M3-B4: the read now goes through the engine facade
// (`server/engine/account-reads.js`) instead of naming
// `lib/mcode-rpc.js` directly, so the endpoint is gated on the same
// declared `authCredentials.getAccountStatus` the usage popover
// (#15 / #16) is gated on — the two read the SAME engine projection
// through the SAME `mcode/account/status` method, and a provider that
// drops it must take both down together.
//
// Nothing about the wire changed. The facade builds the response body
// (success spreads the engine's projection verbatim; failure keeps the
// `{ok:false, reason}` soft-fail shape), and the HTTP status stays 200
// in both cases: the REQUEST succeeded, and the card renders its empty
// state from `ok:false`.

import { readEngineAccount } from "../engine/account-reads.js";

/**
 * Fetched on demand rather than pushed in the state snapshot.
 *
 * The payload is the user's own display name, plan tier and quota. The snapshot
 * is broadcast to every SSE subscriber — including over the LAN when `lanBind`
 * is on — so account data does not belong in it. The engine's projection carries
 * no credential (see acp/extensions.ts), and nothing here logs the response.
 *
 * A failure is a soft one, like /api/session-tree: the card renders its empty
 * state rather than the route inventing a name or a plan. The capability gate is
 * a different question from that one — "may this provider report an account at
 * all" versus "could we read the account this time" — and only the first one
 * produces a 501, through `app.js#invokeHandler`.
 */
export async function handleGetAccount(_req, res, ctx) {
  const { payload } = await readEngineAccount({ cs: ctx && ctx.cs });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(payload));
}
