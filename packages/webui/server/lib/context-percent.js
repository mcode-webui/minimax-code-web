// webui/server/lib/context-percent.js
// Pure helper: token usage + limit → percent rendered in the context meter.
//
// Lives outside lib/sessions.js so unrelated consumers
// (mavis-usage reads runtime sqlite usage, with nothing to do with the
// on-disk session store) don't have to depend on the stateful session
// module for a pure calculation. Keeping it here also removes the
// test-harness trap where every consumer of computeContextPercent has
// to be mirrored into the sessions.js mock, otherwise its dynamic
// import cancels the entire suite (--experimental-test-module-mocks
// fails closed on a missing named export at module-instantiation time).
//
// Rounding contract (pinned by test/lib/context-percent.test.js):
//   - `limit <= 0` returns 0 (defensive — webui's context-meter gates on a
//     valid limit before render, but SSE / JSON consumers can call this
//     during reset windows where limit is still 0).
//   - values clamp to [0, 100]; ratios above 100% collapse to 100.
//   - `used < 0` collapses to 0 (component gates on Math.max(0, used) but
//     a misuse path or future refactor could still pass negative input).
//   - Otherwise: round((used/limit)*100*10)/10 → 1-decimal percent, so
//     1521/512000 (≈0.297%) reads as 0.3 instead of "0% / no usage".
//
// Denominator contract — IMPORTANT:
//   `limit` MUST be the model's effective context-window size in tokens, as
//   published by the runtime's model catalogue. The webui resolves the limit
//   through `getMcodeModelLimit(modelName)` (see server/lib/mavis-usage.js
//   applyMavisUsageToCs and the mcode cli.js hardcoded table:
//   MiniMax-M3 = 512k, M2.7* = 200k). If this contract drifts — e.g. someone
//   passes `maxOutputTokens` or a `cacheRead+input+output` denominator —
//   the displayed percent will silently lie. Keep the model catalogue and
//   this helper's denominator convention in sync.

export function computeContextPercent(used, limit) {
  if (!limit || limit <= 0) return 0;
  const pct = (used / limit) * 100;
  if (pct <= 0) return 0;
  if (pct >= 100) return 100;
  return Math.round(pct * 10) / 10;
}