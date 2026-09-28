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

// S2 (runtime-first migration). The webui server bundle ships a
// createRequire banner because its dependency tree pulls in
// proper-lockfile (CJS), which does `require("path")` at module load.
// Without a banner the synthetic `__require("path")` throws "Dynamic
// require of \"path\" is not supported" the first time the bundle is
// imported. The CLI bundle has had an equivalent banner since 0.5.4
// (createTuiBundleModuleLocationConfig above); the webui bundle
// mirrors it but with `server.js` as the entry filename (no chunks
// directory in the webui tree).
//
// S3 (banner anchor split): the two anchors that this banner provides
// MUST NOT share a directory. They serve different purposes:
//
//   * `require` / `__dirname` anchor — the real bundle location
//     `dist/webui/server.js`. Required so `require("better-sqlite3")`
//     finds the native binding alongside the bundle in the published
//     archive, and CJS deps like proper-lockfile compute their load-
//     time paths from `__dirname`.
//
//   * `import.meta.url` anchor — `dist/` (one level up, matching the
//     CLI bundle's `dist/cli.js`). The asset-resolution code
//     (catalog.ts, browser-skill-asset.ts, provider-presets, etc.)
//     calls `resolve(import.meta.dirname, "assets/...")` and
//     expects the parent directory to BE the dist root. Anchoring
//     `import.meta.url` at `dist/webui/server.js` made every asset
//     candidate miss by one level (S2-R382-accept evidence: assets
//     in `dist/assets/agents` still threw
//     `Local Runtime V2 built-in Agent assets are missing`; only
//     `dist/webui/assets/agents` worked, by accident).
//
// The `import.meta.url` target need NOT be a real file path — esbuild's
// `define` simply rewrites the literal string at build time; the file
// at that path does not have to exist. The bundle itself is still
// emitted at `dist/webui/server.js` (the launcher and the
// `check-webui-bundle.mjs` gate depend on that path).
//
// `assetsRoot` (a brand-new identifier in this banner) deliberately
// matches the CLI's `dist/cli.js` parent, not the bundle's own
// directory. Do NOT collapse the two anchors back into one — every
// other consumer in the tree (resolveAgentAssetsDir's candidate
// chain, static-prompt-reader's probe, etc.) was written assuming the
// CLI layout, and the webui bundle was the only one off-by-one.
export function createWebuiBundleModuleLocationConfig() {
  const banner =
    'import { createRequire as __mavis_cR } from "node:module"; ' +
    'import { dirname as __mavis_dirname } from "node:path"; ' +
    'import { fileURLToPath as __mavis_fileURLToPath, pathToFileURL as __mavis_pathToFileURL } from "node:url"; ' +
    "const __mavis_webuiCurrentModuleDir = __mavis_dirname(__mavis_fileURLToPath(import.meta.url)); " +
    // require / __dirname anchor: real bundle location.
    "const __mavis_webuiPackageRoot = __mavis_webuiCurrentModuleDir; " +
    // import.meta.url anchor: the dist root, matching CLI's dist/cli.js
    // parent. One level above the bundle itself so asset-resolution
    // `resolve(import.meta.dirname, ...)` hits dist/assets/* as designed.
    "const __mavis_webuiAssetsRoot = __mavis_dirname(__mavis_webuiPackageRoot); " +
    'const __mavis_webuiPackageEntryUrl = __mavis_pathToFileURL(__mavis_webuiPackageRoot + "/server.js").href; ' +
    'const __mavis_webuiAssetsEntryUrl = __mavis_pathToFileURL(__mavis_webuiAssetsRoot + "/server.js").href; ' +
    "const require = __mavis_cR(__mavis_webuiPackageEntryUrl); " +
    "const __dirname = __mavis_webuiPackageRoot;";
  return {
    banner,
    define: Object.freeze({
      // Anchor import.meta.url at dist/, not dist/webui/. The path
      // need not exist on disk — esbuild rewrites the literal only.
      "import.meta.url": "__mavis_webuiAssetsEntryUrl",
    }),
  };
}

