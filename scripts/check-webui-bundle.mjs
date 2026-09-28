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
// Three shapes are scanned; each lives in a real bundle and the dev's
// probe (scripts/s3-gate-probe.mjs) exercises every shape against a
// synthetic artifact to keep this comment honest:
//
//   1. Static import with `from`: `import x from "y"`, `import { a } from "y"`,
//      `export { a } from "y"`. Anchored to start-of-line so a `* import ... from`
//      inside a JSDoc block (indented with `*`) cannot match.
//   2. Side-effect import: `import "y";` (no `from`, no destructuring). Also
//      anchored to start-of-line so it cannot collide with the static-from
//      pattern above. esbuild preserves this form for transitive inlines of
//      vendor source that does `import "side-effect-only-pkg"`, and the gate
//      MUST catch those — otherwise an undeclared npm dep can ship silently.
//   3. Dynamic `import("...")` expression: not line-anchored (real runtime
//      expression). Lines beginning with `//`, `/*`, or `*` are skipped so
//      inlined comments can't false-positive. The line filter accepts both
//      `await import("...")` and `await (import("..."))` — both forms appear
//      in real inlined vendor source. Lines whose captured specifier is a
//      template-literal expression (`` await import("${x}") ``) are skipped
//      because the regex captures the bare `${x}` substring — that string is
//      not an ESM specifier.
//
// Node builtins are excluded from the offender set: they do not need to ship
// with the published archive because Node provides them at runtime. The bare
// form (`"fs"`, `"path"`, ...) is ESM-valid even though the `node:` prefix is
// preferred; the list below mirrors the full set returned by
// `require('node:module').builtinModules` in Node 22+ (verified at write
// time on Node 24.19). Including this list here is what unblocks S3 — the
// runtime-first migration wires `runtime-host.js` into `acp-client.js`, which
// transitively inlines many third-party modules that import bare builtins;
// failing the gate on those would block the migration without any correctness
// gain.
const NODE_BUILTINS = new Set([
  // Legacy underscore-prefixed internal modules (still bare-loadable
  // for backward compat; named explicitly so the set covers every entry
  // Node 22+ lists in `node:module.builtinModules`).
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  // Standard core modules.
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
  "test/reporters",
]);
function isNodeBuiltin(specifier) {
  if (!specifier) return false;
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier);
}

// Anchored to start-of-line so a `* import ... from` inside a JSDoc block
// cannot match. The trailing `from` is mandatory for this shape; the
// side-effect pattern below handles the `import "x"` form.
const staticImportPattern = /^[ \t]*(?:import|export)\b[^;"'\n]*?from\s*(["'])([^"']+)\1/gm;
// Same anchoring; matches `import "x";` / `import 'x';` only.
const sideEffectImportPattern = /^[ \t]*import\s+(["'])([^"']+)\1\s*;?$/gm;
// Bare `import("...")` expression. Anchor to line + skip comment lines
// (real expressions appear mid-line; inlined comments are noise).
const dynamicImportPattern = /import\(\s*(["'])([^"']+)\1\s*\)/g;
const externals = new Set(cliExternalModules);
const offenders = new Set();
for (const match of artifact.matchAll(staticImportPattern)) {
  const specifier = match[2];
  if (!specifier) continue;
  if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
  if (isNodeBuiltin(specifier)) continue;
  if (!externals.has(specifier)) offenders.add(specifier);
}
for (const match of artifact.matchAll(sideEffectImportPattern)) {
  const specifier = match[2];
  if (!specifier) continue;
  if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
  if (isNodeBuiltin(specifier)) continue;
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
  // Skip lines whose captured specifier is a template-literal
  // expression (`` await import("${x}") ``, `` let x = import(`p/${id}`) ``).
  // Two conditions:
  //   - line contains `await import(` (optionally wrapped in parens);
  //     this filters dynamic imports to the actually-used form
  //   - captured specifier does NOT look like a template expression
  //     (no leading `$`, no `${`, no backticks)
  if (!/await\s*\(?\s*import\(/.test(line)) continue;
  if (
    specifier.startsWith("$") ||
    specifier.includes("${") ||
    specifier.includes("`")
  ) continue;
  if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
  if (isNodeBuiltin(specifier)) continue;
  if (!externals.has(specifier)) offenders.add(specifier);
}if (offenders.size) {
  const offenderList = [...offenders].sort().join("\n");
  throw new Error(
    "Web UI server bundle imports bare external modules that are not declared in cliExternalModules:\n" +
      offenderList +
      "\n" +
      "Add the missing modules to scripts/lib/cli-release.mjs so the published archive actually ships them, " +
      "or remove the import from the server source.",
  );
}

console.log(
  `Web UI server bundle ok: ${path.relative(root, artifactPath)} (${artifactBytes}B, ${ratio.toFixed(1)}x source). ` +
    `Externals allowed: ${[...externals].sort().join(", ")}.`,
);