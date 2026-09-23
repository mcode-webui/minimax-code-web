// webui/server/lib/models.js
// Context-window fallback for the webui's own display.

// Used only until a session has reported its real size: the engine sends
// `usage_update` with `size` = contextWindowTokens (packages/tui/src/acp/
// control-state.ts#usageUpdate), which the running session prefers.
// Fallback only: the engine does not report a limit until a session exists, and
// these values are what mcode itself ships for the same models.
// Input 'minimax_api/MiniMax-M3' or 'MiniMax-M3'; output 512000 / 200000 / 0.
const MCODE_MODEL_LIMITS = {
  "MiniMax-M3": 512000,
  "MiniMax-M2.7": 200000,
  "MiniMax-M2.7-highspeed": 200000,
  // 兜底: 128k, 200k, 512k 几个常见值
};
export function getMcodeModelLimit(modelFullName) {
  if (!modelFullName) return 0;
  // 'minimax_api/MiniMax-M3' → 'MiniMax-M3'
  const short = modelFullName.includes("/")
    ? modelFullName.split("/").pop()
    : modelFullName;
  if (MCODE_MODEL_LIMITS[short]) return MCODE_MODEL_LIMITS[short];
  // 模糊匹配: MiniMax-M2.7-highspeed 应该匹配 M2.7 的 200k
  for (const k of Object.keys(MCODE_MODEL_LIMITS)) {
    if (short.startsWith(k) || k.startsWith(short))
      return MCODE_MODEL_LIMITS[k];
  }
  return 0;
}
