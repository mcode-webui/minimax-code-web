// webui/server/lib/models.js
// Builtin-model extraction from mcode's cli.js bundle, plus a context-window
// fallback used by the webui's own display until the engine reports a real
// limit on `usage_update`.

import { dirname, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { MCODE_CMD, PACKAGE_ROOT } from "./config.js";

// v0.5.bj: extract the hardcoded MiniMax-M* list from mcode's cli.js bundle
// at startup. The TUI surfaces the same list as its `/models` candidates, so
// the webui catalogue should follow mcode itself rather than carry its own
// hardcoded copy — a future mcode release that adds or renames a model would
// otherwise leave the webui out of sync until the next webui release.
let CACHED_BUILTIN_MODELS = null;

function findCliEntry() {
  // v2.1: MCODE_CMD resolves to the repo-built CLI entry (dist/cli.js) —
  // read that bundle directly. Legacy plugin layouts shipped a mcode.ps1
  // shim whose cliEntry line pointed at the sibling cli.js.
  if (/\.(js|mjs)$/i.test(MCODE_CMD) && existsSync(MCODE_CMD)) return MCODE_CMD;
  const ps1Dir = /[\\/]/.test(MCODE_CMD) ? dirname(MCODE_CMD) : PACKAGE_ROOT;
  const mcodePs1 = join(ps1Dir, "mcode.ps1");
  if (!existsSync(mcodePs1)) return null;
  try {
    const ps1 = readFileSync(mcodePs1, "utf-8");
    const m = ps1.match(/cliEntry\s*=\s*Join-Path\s+\$basedir\s+"([^"]+)"/);
    if (m) return join(ps1Dir, m[1]);
  } catch {}
  return null;
}

/**
 * Read the hardcoded MiniMax-M* list from mcode's own cli.js bundle.
 *
 * mcode's TUI /models surfaces this list verbatim; the webui catalogue
 * merges it with the engine session's `model` config option (when one
 * exists) and an optional `models.json` providers config. Extracting
 * rather than hardcoding means a future mcode release lands its new
 * model ids in the webui catalogue without a coordinated webui bump.
 *
 * Scans the entry plus every sibling chunk (bounded) so the build's
 * code-split layout — `dist/cli.js` is now a thin loader — does not
 * hide the model list in `dist/chunks/*.js`.
 *
 * Returns `[]` when the bundle is missing or unreadable: this is a
 * convenience fallback, not a hard requirement.
 */
export function getBuiltinModelsFromMcode() {
  if (CACHED_BUILTIN_MODELS !== null) return CACHED_BUILTIN_MODELS;
  try {
    let cliEntry = findCliEntry();
    if (!cliEntry || !existsSync(cliEntry)) {
      CACHED_BUILTIN_MODELS = [];
      return [];
    }
    const re = /MiniMax-M[0-9][a-z0-9.-]*/g;
    const found = new Set();
    const collect = (content) => {
      let m;
      while ((m = re.exec(content)) !== null) found.add(m[0]);
    };
    collect(readFileSync(cliEntry, "utf-8"));
    const chunksDir = join(dirname(cliEntry), "chunks");
    let budget = 48 * 1024 * 1024; // scan cap; one chunk at >48MB is suspicious
    if (existsSync(chunksDir)) {
      for (const name of readdirSync(chunksDir)) {
        if (!name.endsWith(".js")) continue;
        const p = join(chunksDir, name);
        let stat;
        try {
          stat = statSync(p);
        } catch {
          continue;
        }
        if (stat.size > budget) continue;
        budget -= stat.size;
        try {
          collect(readFileSync(p, "utf-8"));
        } catch {}
      }
    }
    // M3 first so the most capable model lands at the top of any UI list
    // built from this catalogue.
    CACHED_BUILTIN_MODELS = [...found].sort().reverse();
    return CACHED_BUILTIN_MODELS;
  } catch {
    CACHED_BUILTIN_MODELS = [];
    return [];
  }
}

// v0.5.bx-10: real context limits — extracted from mcode's cli.js bundle.
//   Source: cli.js `h7i={"MiniMax-M3":{limit:{context:512e3,...}}, ...}`
//   Input: 'minimax_api/MiniMax-M3' or 'MiniMax-M3'. Output: 512000 /
//   200000 / 0 (unknown). Used as a fallback only: the engine reports a
//   real `usage_update.size` once a session exists, which the running
//   session prefers over this table.
const MCODE_MODEL_LIMITS = {
  "MiniMax-M3": 512000,
  "MiniMax-M2.7": 200000,
  "MiniMax-M2.7-highspeed": 200000,
};
export function getMcodeModelLimit(modelFullName) {
  if (!modelFullName) return 0;
  const short = modelFullName.includes("/")
    ? modelFullName.split("/").pop()
    : modelFullName;
  if (MCODE_MODEL_LIMITS[short]) return MCODE_MODEL_LIMITS[short];
  for (const k of Object.keys(MCODE_MODEL_LIMITS)) {
    if (short.startsWith(k) || k.startsWith(short)) return MCODE_MODEL_LIMITS[k];
  }
  return 0;
}
