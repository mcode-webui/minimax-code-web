import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cliExternalModules } from "./lib/cli-release.mjs";

// Validate the Web UI server bundle that ships in the published archive. The
// server used to be a verbatim copy of packages/webui/server.js with every
// dependency hand-inlined; it is now produced by scripts/build.mjs into
// dist/webui/server.js. The check guards three things:
//   1. The artifact exists and was produced by the build pipeline.
//   2. The artifact is genuinely a bundle (size vs. source + a library marker).
//   3. Every bare external import is declared in cliExternalModules, the same
//      list the release manifest pins for the published archive. A divergence
//      here is what previously let `hono` ship missing from the archive.
const root = fileURLToPath(new URL("../", import.meta.url));
const artifactPath = path.join(root, "dist/webui/server.js");
const bootstrapPath = path.join(root, "packages/webui/server/bootstrap.js");
const legacySourcePath = path.join(root, "packages/webui/server.js");
const sourcePath = existsSync(bootstrapPath) ? bootstrapPath : legacySourcePath;

if (!existsSync(artifactPath))
  throw new Error(
    `Missing Web UI server bundle: ${path.relative(root, artifactPath)} was not produced by the build. Run \`pnpm build\` first.`,
  );

const artifact = readFileSync(artifactPath, "utf8");
const artifactBytes = statSync(artifactPath).size;
const sourceBytes = statSync(sourcePath).size;
// 3x is a deliberate floor: hand-copied source stays around 1x; an esbuild
// bundle that inlines hono + @hono/node-server lands well above 5x.
const ratio = artifactBytes / sourceBytes;
if (ratio < 3)
  throw new Error(
    `Web UI server artifact looks like a verbatim copy, not a bundle: ` +
      `${path.relative(root, artifactPath)} is ${artifactBytes}B vs. ` +
      `${path.relative(root, sourcePath)} ${sourceBytes}B (ratio ${ratio.toFixed(2)}x, expected ≥ 3x).`,
  );

const HONO_MARKERS = [
  "RegExpRouter",
  "TrieRouter",
  "PatternRouter",
  "LinearRouter",
  "SmartRouter",
];
const HONO_NODE_SERVER_MARKERS = [
  "getRequestListener",
  "createAdaptorServer",
];
const markerHits = [
  ...HONO_MARKERS.filter((name) => artifact.includes(name)),
  ...HONO_NODE_SERVER_MARKERS.filter((name) => artifact.includes(name)),
];
if (markerHits.length === 0)
  throw new Error(
    `Web UI server artifact is large but does not contain an inlined Hono or @hono/node-server marker ` +
      `(none of ${[...HONO_MARKERS, ...HONO_NODE_SERVER_MARKERS].join(", ")} found). ` +
      `This means the build no longer inlines the HTTP framework; either the build regressed or the marker list is stale.`,
  );

// Bare external specifier detection. The bundle is produced without minification
// (`scripts/build.mjs` keeps comments so server stack traces stay readable), so
// JSDoc and line comments in inlined vendor source legitimately contain strings
// like `import { Router as IttyRouter } from 'itty-router'`. The regexes below
// avoid matching those by anchoring to actual statements.
//
// - Static import/export-from: anchored to start-of-line so `* import ... from`
//   inside a JSDoc block (indented with `*`) cannot match.
// - Dynamic `import("...")` expression: not line-anchored because it is a real
//   runtime expression; instead, skip matches whose line begins with `//`, `/*`,
//   or `*` (JSDoc continuation).
const staticImportPattern = /^[ \t]*(?:import|export)\b[^;"'\n]*?from\s*(["'])([^"']+)\1/gm;
const dynamicImportPattern = /import\(\s*(["'])([^"']+)\1\s*\)/g;
const externals = new Set(cliExternalModules);
const offenders = new Set();
for (const match of artifact.matchAll(staticImportPattern)) {
  const specifier = match[2];
  if (!specifier) continue;
  if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
  if (specifier.startsWith("node:")) continue;
  if (!externals.has(specifier)) offenders.add(specifier);
}
for (const match of artifact.matchAll(dynamicImportPattern)) {
  const specifier = match[2];
  if (!specifier) continue;
  // Find the line containing the match and ignore it if the line is a comment.
  const lineStart = artifact.lastIndexOf("\n", match.index) + 1;
  const lineEnd = artifact.indexOf("\n", match.index);
  const line = artifact.slice(lineStart, lineEnd === -1 ? artifact.length : lineEnd);
  const trimmed = line.replace(/^[ \t]+/u, "");
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"))
    continue;
  if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
  if (specifier.startsWith("node:")) continue;
  if (!externals.has(specifier)) offenders.add(specifier);
}
if (offenders.size)
  throw new Error(
    `Web UI server bundle imports bare external modules that are not declared in cliExternalModules:\n` +
      `${[...offenders].sort().join("\n")}\n` +
      `Add the missing modules to scripts/lib/cli-release.mjs so the published archive actually ships them, ` +
      `or remove the import from the server source.`,
  );

console.log(
  `Web UI server bundle ok: ${path.relative(root, artifactPath)} (${artifactBytes}B, ${ratio.toFixed(1)}x source). ` +
    `Externals allowed: ${[...externals].sort().join(", ")}.`,
);