import { build } from "esbuild";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from "node:url";
import path from "node:path";
import { copyLocalRuntimeAssets } from "./lib/local-runtime-assets.mjs";
import { createTuiBundleModuleLocationConfig } from "./lib/tui-npm-bundle-profile.mjs";
import { shouldCopyTuiRuntimeResource } from "./lib/tui-package-privacy.mjs";
import { TUI_DISABLED_BUILTIN_SKILL_NAMES } from "./lib/builtin-skills.mjs";
import { copyMcodeToolsArtifact } from './lib/mcode-tools-artifact.mjs';
import { readExtraction } from "./lib/release-metadata.mjs";
import { cliBuildVersion, cliExternalModules } from './lib/cli-release.mjs';
import { createWorkspaceSourcePlugin } from "./lib/workspace-source-plugin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = readExtraction(root);
const packages = new Map(
  metadata.packageRoots.map((directory) => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, directory, "package.json"), "utf8"),
    );
    return [manifest.name, { directory, manifest }];
  }),
);
const location = createTuiBundleModuleLocationConfig();
const outdir = path.join(root, "dist");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Bundle checked-in workspace sources and resolve npm dependencies from each importer.
// Native and optional platform integrations keep their installed module locations.
// The resolver itself lives in scripts/lib/workspace-source-plugin.mjs so the CLI
// bundle and the webui server bundle can share the same workspace-specifier rules.
const sourcePlugin = createWorkspaceSourcePlugin({ root, packages });
const version = cliBuildVersion(root);
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    cli: "packages/tui/src/index.ts",
    "image-preview-worker": "packages/tui/src/host/image-preview-worker.ts",
    'mcode-tools': 'packages/tui/src/cli/mcode-tools-entry.ts',
    'mcode-web': 'packages/tui/src/cli/mcode-web-entry.ts',
    'matrix-mcp-stdio': 'packages/agent-tools/src/desktop/matrix-mcp-stdio.ts',
  },
  external: cliExternalModules,
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  minifyIdentifiers: true,
  minifyWhitespace: true,
  target: "node22",
  chunkNames: "chunks/[name]-[hash]",
  banner: { js: location.banner },
  plugins: [sourcePlugin],
  metafile: true,
  define: {
    ...location.define,
    __CLI_VERSION__: JSON.stringify(version),
    __CLI_CHANNEL__: '"source"',
    __IS_NPM_BUILD__: "true",
    __BUILD_PROFILE__: '"tui"',
    __TUI_BUILD_ENV__: '"prod"',
    __TUI_BUILD_VARIANT__: '"standard"',
    __TUI_NPM_DIST_TAG__: '"latest"',
  },
  logLevel: "info",
});
// Web UI server (packages/webui/server/bootstrap.js → dist/webui/server.js):
// bundled so `hono` and any future `@mavis/*` imports travel with the runtime
// instead of needing a parallel install. splitting is disabled because the CLI
// bundle owns the `dist/chunks/` namespace and the webui tree's dynamic imports
// are either inlined or non-literal. The `server/` subtree (e.g. trajectory
// pollers) stays as a verbatim copy below — those are intentionally not bundled
// and are loaded at runtime via dynamic import.
await build({
  absWorkingDir: root,
  entryPoints: ["packages/webui/server/bootstrap.js"],
  outfile: path.join(outdir, "webui", "server.js"),
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "node22",
  external: cliExternalModules,
  plugins: [createWorkspaceSourcePlugin({ root, packages })],
  metafile: true,
  logLevel: "info",
});
copyLocalRuntimeAssets({
  repositoryRoot: root,
  outputDir: outdir,
  filter: shouldCopyTuiRuntimeResource,
  excludedBuiltinSkillNames: TUI_DISABLED_BUILTIN_SKILL_NAMES,
});
for (const name of ["configs", "native"])
  cpSync(path.join(root, "packages/tui", name), path.join(outdir, name), {
    recursive: true,
  });
// Web UI runtime (packages/webui → dist/webui): the server entry is bundled
// above; everything else (acp.mjs, the `server/` subtree with its runtime
// dynamic imports, and public/) is copied verbatim. Tests, checks, docs, and
// package tooling stay out of the runtime layout.
//
// `public/` is copied verbatim because it carries the trajectory studio's
// unbundled assets (public/trajectory/, served at runtime by
// server/trajectory/http.mjs via `new URL('../../public/trajectory/', ...)`).
// The Next export's bundled HTML shell lives at webapp/out (copied below)
// and is the ONLY root server/lib/static.js serves from.
for (const name of ["acp.mjs", "server", "public"])
  cpSync(path.join(root, "packages/webui", name), path.join(outdir, "webui", name), {
    recursive: true,
  });
// Web UI frontend (packages/webui/webapp): a Next.js static export that
// server/lib/static.js serves ahead of public/. It is built here so a shipped tree
// contains the frontend, and copied to the path it already occupies in the source
// tree (webapp/out) so the server resolves it identically from a checkout and from
// dist/webui — no layout branch in the server.
const webappDir = path.join(root, "packages/webui", "webapp");
if (existsSync(path.join(webappDir, "next.config.mjs"))) {
  const requireWebapp = createRequire(import.meta.url);
  // Resolve the package root rather than a deep subpath: `next/dist/bin/next` is
  // not an exported subpath, and this also keeps the invocation portable (a .bin
  // shim would be next.cmd on Windows).
  const nextBin = path.join(
    path.dirname(requireWebapp.resolve("next/package.json")),
    "dist",
    "bin",
    "next",
  );
  execFileSync(process.execPath, [nextBin, "build", "webapp"], {
    cwd: path.join(root, "packages/webui"),
    stdio: "inherit",
  });
  const exportDir = path.join(webappDir, "out");
  if (!existsSync(path.join(exportDir, "index.html")))
    throw new Error("webapp build produced no static export at packages/webui/webapp/out");
  cpSync(exportDir, path.join(outdir, "webui", "webapp", "out"), { recursive: true });
}
for (const name of ["seccomp", "srt-win", "java-proxy-agent"]) {
  cpSync(
    path.join(root, "third_party/sandbox-runtime/vendor", name),
    path.join(outdir, "vendor", name),
    { recursive: true },
  );
}
chmodSync(path.join(outdir, "cli.js"), 0o755);
await copyMcodeToolsArtifact(root, outdir);
cpSync(path.join(root, 'packages/tui/src/cli/mcode-tools-launchers'), path.join(outdir, 'internal-bin'), { recursive: true });
for (const name of ['internal-bin/mcode-tools', 'mcode-tools.js', 'matrix-mcp-stdio.js'])
  chmodSync(path.join(outdir, name), 0o755);
writeFileSync(
  path.join(outdir, "metafile.json"),
  JSON.stringify(result.metafile, null, 2) + "\n",
);
console.log(
  `Built MiniMax Code ${version} from ${Object.keys(result.metafile.inputs).length} source files.`,
);

writeFileSync(
  path.join(outdir, "package.json"),
  JSON.stringify(
    {
      name: "@minimax-ai/code", version, type: "module", private: true,
      ...(process.env.MCODE_RELEASE_TAG ? {
        gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      } : {}),
    },
    null,
    2,
  ) + "\n",
);

const piRequire = createRequire(
  path.join(root, "third_party/pi-mono/packages/coding-agent/package.json"),
);
cpSync(
  piRequire.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
  path.join(outdir, "photon_rs_bg.wasm"),
);
