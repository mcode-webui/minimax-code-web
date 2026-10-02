// webui/server/routes/usage.js
// POST /api/usage, POST /api/usage-trigger, GET /api/usage-real,
// POST /api/refresh, GET /api/usage/forecast
//
// Two different questions live here:
//   - plan quota (5h / weekly) — the engine owns the credential, so webui asks
//     it over ACP via lib/usage.js;
//   - per-turn context — the mavis runtime db, via lib/mavis-usage.js.
//
// C07 patch: each /api/usage call can append one NDJSON line to
// ~/.mcode-webui/usage-history.ndjson for the quota forecast. That is
// now decided by lib/usage.js#runUsageQuery's `record` option, so a
// caller that is only rendering the number does not add a sample. Also
// added handleForecast which exposes the prediction to the UI.
//
// M3-B3: all four usage endpoints now reach the engine through
// `engine/usage-reads.js` instead of naming lib/usage.js, lib/mavis-usage.js,
// lib/quota-forecast.js and lib/config.js themselves. Nothing about the
// wire changed — the facade forwards the payloads and owns the two
// DERIVED figures (`contextUsed`, the forecast) so the formulas have one
// home. See engine/usage-reads.js for why #19 declares no capability and
// why #17 does not yet call the provider's `getSessionUsage` method.

import {
  readEngineAccountQuota,
  readEngineQuotaForecast,
  readEngineSessionUsage,
} from "../engine/usage-reads.js";
import { pushStateFor } from "../lib/state-bus.js";
import { getMcodeModelLimit } from "../lib/models.js";
import { readJson } from "../lib/read-json.js";


// POST /api/usage & /api/usage-trigger
//
// The answer is the quota figures the read just fetched. It used to be a
// bare {ok:true} written before the fetch — the popover reads this response
// body, so it never saw a `remaining` even when the fetch succeeded.
export async function handleUsage(req, res, ctx) {
  // `record: false` reads the quota without adding a sample to the forecast
  // history; the client's poll uses it. Absent or true means the historical
  // behaviour, where a read is also a measurement.
  const body = await readJson(req);
  const { payload } = await readEngineAccountQuota({
    cs: ctx.cs,
    cid: ctx.cid,
    record: body.record !== false,
  });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// POST /api/refresh — noop (we already push state on demand)
export function handleRefresh(_req, res, ctx) {
  pushStateFor(ctx.cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true }));
}

// GET /api/usage-real — 手动从 mavis db 拉真实 token usage
export async function handleUsageReal(req, res, ctx) {
  const cs = ctx.cs;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const sid = cs.mcodeSessionId || url.searchParams.get("sid") || null;
  if (!sid) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: true,
        found: false,
        reason: "no mcode session id yet",
      }),
    );
  }
  const read = await readEngineSessionUsage({ mcodeSessionId: sid });
  if (!read.found) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: true,
        found: false,
        sid,
        dbPath: read.dbPath,
        dbExists: read.dbExists,
      }),
    );
  }
  const usage = read.usage;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      found: true,
      sid,
      // `rows` is a COUNT, not a list — the engine's provider method
      // answers a row ARRAY under the same name, which is one of the
      // reasons #17 does not call it yet (engine/usage-reads.js header).
      rows: usage.rows,
      totalInput: usage.totalInput,
      totalOutput: usage.totalOutput,
      totalCacheRead: usage.totalCacheRead,
      totalCacheWrite: usage.totalCacheWrite,
      totalReasoning: usage.totalReasoning,
      // v0.5.bx-10 fix: context 实际是 input + output + reasoning (cache 是 input 子集)
      // CUMULATIVE, deliberately not the chat flow's per-turn
      // `lastTurnContextTokens`. The formula now lives in the engine layer
      // as `contextUsedTokens` and is pinned on its inputs there.
      contextUsed: read.contextUsed,
      model: read.model,
      modelLimit: getMcodeModelLimit(cs.model && cs.model.name),
      firstTs: usage.firstTs,
      lastTs: usage.lastTs,
      dbPath: read.dbPath,
    }),
  );
}

// C07: GET /api/usage/forecast — predict quota exhaustion time.
//   Reads ~/.mcode-webui/usage-history.ndjson, runs forecastExhaustion,
//   and returns the JSON payload documented in CAPABILITIES.md §8.
//   Best-effort: if the file is missing or empty, the read answers
//   { … reason: "no_history" } so the UI can render a "collecting data…"
//   placeholder instead of erroring.
export async function handleForecast(_req, res, _ctx) {
  const { forecast } = await readEngineQuotaForecast();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      forecast,
    }),
  );
}
