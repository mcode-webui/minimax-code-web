// webui/server/lib/layout.js
// Single source of truth for the webui's own filesystem locations.
//
// The webui server is esbuild-bundled: every module shares the entry's
// URL, so deriving paths from `import.meta.url` (in config.js, static.js,
// sqlite-resolver.js, alerts.js, trajectory.js, acp.mjs, server.js) would
// point at the wrong directory after bundling. This module pins the
// layout to the webui's package root, not to the calling module.
//
// How WEBUI_ROOT is resolved (priority order):
//   1. process.env.MCODE_WEBUI_DIR — explicit override the launcher
//      (packages/tui/src/cli/run-webui-command.ts) honors as a lookup
//      hint; the webui can also be pointed at any directory for tests
//      or unusual installs.
//   2. process.argv[1] — the launcher spawns
//      `node <webuiDir>/server.js`, so argv[1] is exactly the webui
//      package root in both the source layout (packages/webui/server.js)
//      and the bundled layout (dist/webui/server.js). This also holds
//      for direct `node packages/webui/server.js` invocations.
//   3. import.meta.url — fallback for unit tests that import
//      server/lib/*.js directly (e.g. `node --import tsx --test ...`),
//      where argv[1] is the test runner, not the webui. layout.js itself
//      lives at server/lib/layout.js inside the webui root, so two `..`
//      jumps land on it.

import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveWebuiRoot() {
  const override = process.env.MCODE_WEBUI_DIR?.trim();
  if (override) return resolve(override);
  const argvEntry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (argvEntry && /[\\/]server\.js$/.test(argvEntry)) return dirname(argvEntry);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const WEBUI_ROOT = resolveWebuiRoot();
export const WEBUI_ROOT_URL = pathToFileURL(WEBUI_ROOT + sep);
// webui/webapp/out — Next.js static export, the current UI.
// `auth-gate.html` lives in this tree too: it ships via webapp/public/ so
// `output: 'export'` copies it to the export root alongside the rest of
// the Next shell (see webui/server/lib/static.js for how it is served).
export const NEXT_EXPORT_DIR = resolve(WEBUI_ROOT, "webapp", "out");
// webui/server/trajectory — unbundled subtree copied verbatim into the
// dist/webui layout; imported via dynamic non-literal specifiers so
// esbuild leaves the relative paths alone (see server/lib/trajectory.js).
// The trajectory studio's own static assets live one level up at
// webui/public/trajectory/ and are read by http.mjs via
// `new URL('../../public/trajectory/', import.meta.url)`.
export const TRAJECTORY_DIR = resolve(WEBUI_ROOT, "server", "trajectory");
