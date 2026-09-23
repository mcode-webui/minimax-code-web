// webui/server/lib/workspace-source-hooks.mjs
// Node module-resolve hook for source mode (and unit tests).
//
// Why this exists:
//   The webui server is being converted from "copied verbatim" to
//   "esbuild-bundled". In the BUILT layout every `@mavis/*` workspace
//   package is inlined by the build plugin
//   (scripts/build.mjs `standalone-workspace-sources`) and never needs
//   to resolve at runtime.
//
//   In the SOURCE layout (running `node packages/webui/server.js`
//   directly) and in unit tests (`node --import tsx --test ...`) there
//   is no built `@mavis/*` dist — every workspace package is
//   `"private": true` with `exports` pointing at `./dist/*.js` that
//   doesn't exist. `exports` encapsulation also blocks reaching
//   `./src/*` directly.
//
//   This hook mirrors the build plugin's algorithm: match
//   `@mavis/<pkg>` or `@mavis/<pkg>/<sub>`, read the package's
//   `exports` map, apply the same `./dist/*.js` -> `./src/*.ts` rewrite,
//   and short-circuit when the resolved file exists. Falling through to
//   `next(specifier, context)` for everything else keeps the rest of
//   Node's resolver (node builtins, relative specifiers, real npm deps)
//   working unchanged.
//
// Repo root discovery:
//   We walk up from `import.meta.url` until we find a directory that
//   contains `release/extraction.json` (the repo root sentinel used
//   by every script in scripts/). One pass: webui is at
//   <root>/packages/webui and the hooks file is at
//   packages/webui/server/lib/workspace-source-hooks.mjs, so four `..`
//   jumps always land on the root. Walking is belt-and-braces against
//   any future re-location of the webui package.
//
// tsx handles transpilation of the resolved .ts source. This hook ONLY
// resolves; it does not transform. Register tsx separately via
// registerWorkspaceSources() in workspace-sources.js.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Walk up from this file until we find a directory containing
// release/extraction.json — that directory is the repo root.
function findRepoRoot(here) {
  let dir = dirname(here);
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, "release", "extraction.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const REPO_ROOT = findRepoRoot(fileURLToPath(import.meta.url));

// Read a workspace package's exports map once per package, lazily.
// Cached because the resolver can fire thousands of times for the same
// `@mavis/shared/local-runtime-paths` specifier during a route load.
const _exportsCache = new Map();

function loadPackageManifest(repoRoot, pkgDir) {
  const key = `${repoRoot}::${pkgDir}`;
  if (_exportsCache.has(key)) return _exportsCache.get(key);
  const manifestPath = join(repoRoot, pkgDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    _exportsCache.set(key, null);
    return null;
  }
  const entry = { name: manifest.name, manifest, directory: pkgDir };
  _exportsCache.set(key, entry);
  return entry;
}

// Find a workspace package by its bare name. Returns the package
// directory (relative to the repo root) or null. Uses the manifest
// `name` field rather than the specifier prefix so renamed packages
// resolve correctly.
function findWorkspacePackage(repoRoot, specName) {
  // Index every declared workspace package once, keyed by its manifest
  // `name`. The cache below makes subsequent lookups O(1).
  const cacheKey = `${repoRoot}::name-index`;
  if (!_exportsCache.has(cacheKey)) {
    const idx = new Map();
    for (const dir of WORKSPACE_PACKAGE_DIRS) {
      const e = loadPackageManifest(repoRoot, dir);
      if (e && e.name) idx.set(e.name, dir);
    }
    _exportsCache.set(cacheKey, idx);
  }
  return _exportsCache.get(cacheKey).get(specName) || null;
}

// The workspace package directories come from `release/extraction.json`'s
// `packageRoots` — the declared single source of truth for package scope, and
// the same file this module already uses as its repo-root sentinel. Reading it
// instead of repeating the list keeps the resolver in step when a package is
// added, renamed, or moved; a hand-copied list would silently stop resolving
// one. The build-side plugin (`scripts/lib/workspace-source-plugin.mjs`) is
// driven by the same inventory, so both resolvers agree by construction.
//
// Order doesn't matter — the lookup below is by exact package name.
function loadWorkspacePackageDirs(repoRoot) {
  try {
    const inventory = JSON.parse(
      readFileSync(join(repoRoot, "release", "extraction.json"), "utf8"),
    );
    const roots = inventory?.packageRoots;
    if (Array.isArray(roots)) {
      return roots.filter((entry) => typeof entry === "string" && entry.length > 0);
    }
  } catch {
    // An unreadable inventory degrades to Node's own resolution rather than
    // crashing the server; every `@mavis/*` specifier then falls through to
    // `next()` and fails loudly at the import site instead.
  }
  return [];
}

const WORKSPACE_PACKAGE_DIRS = REPO_ROOT ? loadWorkspacePackageDirs(REPO_ROOT) : [];

// Resolve the `exports` target for a subpath. Mirrors the relevant
// part of Node's conditional exports resolution (just the `import`
// condition for ESM sources). Returns the raw `./dist/foo.js` string
// or null.
function resolveExportsTarget(exports, subpath) {
  if (!exports || typeof exports !== "object") return null;
  // Bare "." or "./" key (the package root).
  const exact = subpath === "." ? exports["."] : exports[subpath];
  if (exact) return pickImportTarget(exact);
  // Pattern forms ("./*", "./x/*") — subpath matching not currently
  // needed by any @mavis/* subpath in this repo, so skip.
  return null;
}

function pickImportTarget(node) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return null;
  return (
    node.import ||
    node.default ||
    (typeof node.types === "string" && node.types) ||
    null
  );
}

// Apply the build plugin's `./dist/*.js` -> `./src/*.ts` rewrite to a
// resolved exports target. Mirrors scripts/build.mjs exactly so a
// specifier that resolves under esbuild also resolves under this hook.
function rewriteDistToSrc(target) {
  if (!target || typeof target !== "string") return target;
  return target
    .replace(/^\.\/dist\//, "./src/")
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.js$/, ".ts");
}

function packageDirectoryExists(repoRoot, pkgDir) {
  return existsSync(join(repoRoot, pkgDir, "package.json"));
}

// True when `child` is inside `parent` (or equal). Prevents a crafted
// exports target like `{".": "./../../etc/passwd"}` from escaping the
// package directory.
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function resolve(specifier, context, next) {
  // Only act on `@<scope>/...` style specifiers. Bare scopes and
  // non-scoped names fall through to Node's default resolution.
  if (typeof specifier !== "string" || !specifier.startsWith("@")) {
    return next(specifier, context);
  }
  // Extract the scope+name and the remainder.
  const slash = specifier.indexOf("/");
  if (slash < 0) return next(specifier, context);
  const scope = specifier.slice(0, slash);
  const rest = specifier.slice(slash + 1);
  const nameEnd = rest.indexOf("/");
  const specName = nameEnd < 0 ? specifier : specifier.slice(0, slash + 1 + nameEnd);
  const subpath = nameEnd < 0
    ? "."
    : "." + specifier.slice(slash + 1 + nameEnd);

  if (!REPO_ROOT) return next(specifier, context);

  const pkgDir = findWorkspacePackage(REPO_ROOT, specName);
  if (!pkgDir) return next(specifier, context);
  if (!packageDirectoryExists(REPO_ROOT, pkgDir)) {
    return next(specifier, context);
  }

  const pkg = loadPackageManifest(REPO_ROOT, pkgDir);
  if (!pkg || !pkg.manifest) return next(specifier, context);

  // Try the exports map first (matches the build plugin's algorithm).
  const target = resolveExportsTarget(pkg.manifest.exports, subpath);
  let resolved;
  if (target) {
    const rewritten = rewriteDistToSrc(target);
    const candidate = pathResolve(join(REPO_ROOT, pkgDir), rewritten);
    if (existsSync(candidate) && isInside(join(REPO_ROOT, pkgDir), candidate)) {
      resolved = candidate;
    }
  }

  // Fallback: direct `src/<sub>.ts` mapping for packages that have no
  // exports map (e.g. the webui package itself, which deliberately has
  // no exports to keep its server entry unbundled).
  if (!resolved) {
    const tail = subpath === "." ? "index" : subpath.slice(2);
    const direct = pathResolve(
      join(REPO_ROOT, pkgDir, "src"),
      subpath === "." ? "index.ts" : `${tail}.ts`,
    );
    if (existsSync(direct) && isInside(join(REPO_ROOT, pkgDir), direct)) {
      resolved = direct;
    }
  }

  if (resolved) {
    return {
      url: pathToFileURL(resolved).href,
      shortCircuit: true,
      format: "module",
    };
  }

  return next(specifier, context);
}
