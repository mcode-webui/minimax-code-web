export const TUI_BUNDLE_CHUNKS_DIRECTORY = "chunks";
const TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER = "__mavis_tuiPackageEntryUrl";

// S2 (R3 follow-up): every Node built-in import in these banners MUST
// use the `node:` prefix (`node:module`, `node:path`, `node:url`). The
// bare form (`"module"`, `"path"`, `"url"`) is ESM-valid but trips the
// webui-bundle check at scripts/check-webui-bundle.mjs:80 — that gate
// allows `node:`-prefixed specifiers unconditionally and rejects every
// other bare specifier not present in cliExternalModules. CLI bundles
// do not run through that gate, which is why the bare form lived in
// the CLI banner for years; the webui banner inherited the same shape
// in S2 and immediately failed at integration time. ESM treats
// `node:` and bare builtin names as equivalent — keep them aligned.
export function createTuiBundleModuleLocationConfig() {
  const banner =
    'import { createRequire as __mavis_cR } from "node:module"; ' +
    'import { basename as __mavis_basename, dirname as __mavis_dirname, join as __mavis_join } from "node:path"; ' +
    'import { fileURLToPath as __mavis_fileURLToPath, pathToFileURL as __mavis_pathToFileURL } from "node:url"; ' +
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
    'import { createRequire as __mavis_cR } from "node:module"; ' +
    'import { dirname as __mavis_dirname } from "node:path"; ' +
    'import { fileURLToPath as __mavis_fileURLToPath, pathToFileURL as __mavis_pathToFileURL } from "node:url"; ' +
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

