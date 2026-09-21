// webui/server/lib/trajectory.js
// Integration bridge between the webui server and the trajectory studio
// (migrated from plugins/weekbin/mcode-trajectory-studio, PR #56).
//
// The studio is a read-only session-trajectory inspector over the mcode
// runtime SQLite projection (~/.minimax/v2/sqlite/runtime-state.sqlite) with
// a messages.jsonl fallback. Here it is mounted inside the webui at
// /trajectory — behind the webui's own gates — and remains independently
// runnable in standalone modes:
//   node server/trajectory/main.mjs --serve   (loopback panel)
//   node server/trajectory/main.mjs           (MCP over stdio)
//
// All heavy imports are dynamic so a missing node:sqlite (older Node) or a
// missing data directory degrades to "panel unavailable" instead of killing
// the webui server.

let cached = null;
let handler = null;

async function load() {
  if (cached !== null) return cached;
  try {
    const [{ openStore, resolveDataDir, resolveHomeDir }, { isNodeSupported }] =
      await Promise.all([
        import("../trajectory/store.mjs"),
        import("../trajectory/node-version.mjs"),
      ]);
    if (!isNodeSupported(process.version)) {
      console.warn("[webui] trajectory studio: node version unsupported, panel disabled");
      cached = { unavailable: "node_version" };
      return cached;
    }
    const dataDir = resolveDataDir(process.env);
    const home = resolveHomeDir(process.env);
    const warnings = [];
    const store = openStore({ dataDir, warnings });
    for (const w of warnings) console.warn(`[webui trajectory] ${w}`);
    cached = { store, homeDir: home, dataDir };
  } catch (e) {
    console.warn(`[webui] trajectory studio unavailable: ${e?.message ?? e}`);
    cached = { unavailable: String(e?.message ?? e) };
  }
  return cached;
}

// Returns the mounted request handler (async, memoized) or null when the
// studio cannot run in this environment. Requests outside /trajectory are
// answered with `false` so the router can fall through.
export async function getTrajectoryPanelHandler() {
  if (handler) return handler;
  const ctx = await load();
  if (!ctx || ctx.unavailable || !ctx.store) return null;
  const { createMountedPanelHandler } = await import("../trajectory/http.mjs");
  handler = createMountedPanelHandler({
    store: ctx.store,
    homeDir: ctx.homeDir,
    basePath: "/trajectory",
  });
  return handler;
}

// Diagnostics for /api/health and startup logs.
export async function getTrajectoryStatus() {
  const ctx = await load();
  if (!ctx || ctx.unavailable) return { available: false, reason: ctx?.unavailable ?? "unknown" };
  return {
    available: true,
    dataDir: ctx.dataDir,
    sqliteAvailable: Boolean(ctx.store?.db),
    ftsAvailable: Boolean(ctx.store?.hasFts),
    readOnly: true,
  };
}
