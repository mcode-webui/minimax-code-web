export const TUI_BUNDLE_CHUNKS_DIRECTORY = "chunks";
const TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER = "__mavis_tuiPackageEntryUrl";

export function createTuiBundleModuleLocationConfig() {
  const banner =
    'import { createRequire as __mavis_cR } from "module"; ' +
    'import { basename as __mavis_basename, dirname as __mavis_dirname, join as __mavis_join } from "path"; ' +
    'import { fileURLToPath as __mavis_fileURLToPath, pathToFileURL as __mavis_pathToFileURL } from "url"; ' +
    "const __mavis_tuiCurrentModuleDir = __mavis_dirname(__mavis_fileURLToPath(import.meta.url)); " +
    `const __mavis_tuiPackageRoot = __mavis_basename(__mavis_tuiCurrentModuleDir) === ${JSON.stringify(TUI_BUNDLE_CHUNKS_DIRECTORY)} ? __mavis_dirname(__mavis_tuiCurrentModuleDir) : __mavis_tuiCurrentModuleDir; ` +
    `const ${TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER} = __mavis_pathToFileURL(__mavis_join(__mavis_tuiPackageRoot, "cli.js")).href; ` +
    `const require = __mavis_cR(${TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER}); ` +
    "const __dirname = __mavis_tuiPackageRoot;";
  return {
    banner,
    define: Object.freeze({
      "import.meta.url": TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER,
    }),
  };
}

// S2 (runtime-first migration). The webui server bundle currently ships
// without a createRequire banner, but its dependency tree pulls in
// proper-lockfile (CJS), which does `require("path")` at module load.
// Without a banner the synthetic `__require("path")` throws "Dynamic
// require of \"path\" is not supported" the first time the bundle is
// imported. The CLI bundle has had this banner since 0.5.4
// (createTuiBundleModuleLocationConfig above); the webui bundle
// mirrors it but with `server.js` as the entry filename (no chunks
// directory in the webui tree). The banner provides:
//   - `require()`   — resolves CJS deps via Node's createRequire,
//                     anchored at the bundle's own URL so
//                     require("better-sqlite3") finds node_modules
//                     alongside dist/webui/server.js.
//   - `__dirname`  — required by CJS deps that compute paths at
//                     load time (proper-lockfile, etc.).
// Both must be present; do not strip either.
export function createWebuiBundleModuleLocationConfig() {
  const banner =
    'import { createRequire as __mavis_cR } from "module"; ' +
    'import { dirname as __mavis_dirname } from "path"; ' +
    'import { fileURLToPath as __mavis_fileURLToPath, pathToFileURL as __mavis_pathToFileURL } from "url"; ' +
    "const __mavis_webuiCurrentModuleDir = __mavis_dirname(__mavis_fileURLToPath(import.meta.url)); " +
    "const __mavis_webuiPackageRoot = __mavis_webuiCurrentModuleDir; " +
    'const __mavis_webuiPackageEntryUrl = __mavis_pathToFileURL(__mavis_webuiPackageRoot + "/server.js").href; ' +
    "const require = __mavis_cR(__mavis_webuiPackageEntryUrl); " +
    "const __dirname = __mavis_webuiPackageRoot;";
  return {
    banner,
    define: Object.freeze({
      "import.meta.url": "__mavis_webuiPackageEntryUrl",
    }),
  };
}

