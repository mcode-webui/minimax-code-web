// webui/test/lib/engine/host-facade.test.js
//
// Regression guard for migration step M3, batch B0: the catalogue host is
// reached through the engine facade, and the facade itself stays on the
// right side of the boot-path boundary.
//
// The M1 lesson is why this file exists. Moving the plugins and turn-diff
// endpoints onto the facade looks like a rename, and the tempting way to
// write it is a static `import { getCatalogueHost } from
// "../lib/acp-client.js"` inside `engine/host.js`. That compiles and passes
// every handler test — they inject `deps.getCliService` /
// `deps.getDiffApplication`, so the default getter never runs — while
// putting the ACP client tree behind `engine/index.js`, which `app.js` loads
// at boot. M1 already paid for that mistake once (209ms → 2700ms; the
// facade's own load 4685ms → 5ms after declaration and construction were
// split into two files).
//
// So the assertions come in two kinds, and the second is the load-bearing
// one:
//
//   1. Source shape — the two route files name the facade and never
//      `lib/acp-client.js`; `engine/host.js` reaches the singleton through a
//      dynamic import; `engine/index.js` re-exports the getter.
//   2. The real module graph — a fresh child process installs a
//      `module.registerHooks` resolve hook, imports one entry, and reports
//      every specifier the loader was asked to resolve, per parent. That
//      yields the entry's direct edges and its transitive closure without
//      guessing from the source text. A timing assertion would pass on a
//      fast machine and fail on a loaded one; the module graph is a fact.
//
// Scope note, so this file is not mistaken for a global invariant:
// `routes/turn-diff.js` still pulls `lib/acp-client.js` TRANSITIVELY, through
// `lib/state-bus.js` (which app.js loads anyway). B0 removes the two direct
// edges; closing the state-bus one belongs to the batches that route the
// catalogue read/write families (M3-B1+), not here. The turn-diff assertions
// are therefore about its direct edges only, and say so.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = join(import.meta.dirname, "..", "..", "..");
const serverDir = join(packageDir, "server");
const read = (rel) => readFileSync(join(serverDir, rel), "utf8");

/** Strip comments — the prose in these files legitimately names the modules under guard. */
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

/**
 * Product files that carry the runtime / ACP tree. Loading any of them from
 * the facade, whatever the reason given, is the regression.
 */
const FORBIDDEN_ON_BOOT_PATH = new Set([
  "lib/acp-client.js",
  "lib/runtime-host.js",
  "acp.mjs",
  "providers/local-runtime-v2.js",
]);

/** Bare specifiers whose package alone is enough to blow the boot budget. */
const HEAVY_PACKAGE_PREFIXES = ["@mavis/", "@minimax/"];

// --- 1. source shape -------------------------------------------------------

describe("the host-consuming routes reach the host through the facade", () => {
  for (const route of ["routes/plugins.js", "routes/turn-diff.js"]) {
    test(`${route} imports the facade, not the host singleton module`, () => {
      const code = codeOf(read(route));
      assert.ok(
        !/from\s+"\.\.\/lib\/acp-client\.js"/.test(code),
        `${route} must not import lib/acp-client.js directly — take the host from ../engine/index.js`,
      );
      assert.ok(
        /import\s*\{[^}]*getEngineCatalogueHost[^}]*\}\s*from\s+"\.\.\/engine\/index\.js"/.test(code),
        `${route} must import getEngineCatalogueHost from ../engine/index.js`,
      );
      assert.match(code, /await getEngineCatalogueHost\(\)/);
    });

    test(`${route} never names getCatalogueHost`, () => {
      // Belt and braces: a future re-export of the raw getter from the facade
      // would satisfy the import assertion above while quietly restoring the
      // old name. The call site is what has to move.
      assert.ok(
        !/\bgetCatalogueHost\b/.test(codeOf(read(route))),
        `${route} must not mention getCatalogueHost — the facade getter is getEngineCatalogueHost`,
      );
    });
  }

  test("engine/host.js reaches the singleton through a dynamic import only", () => {
    const code = codeOf(read("engine/host.js"));
    assert.ok(
      /await\s+import\(\s*"\.\.\/lib\/acp-client\.js"\s*\)/.test(code),
      "the facade must load lib/acp-client.js with await import()",
    );
    // A static `import ... from "../lib/acp-client.js"` anywhere in this file
    // — even one used for nothing but a type — puts the module back on the
    // boot path, because app.js loads engine/index.js.
    assert.ok(
      !/^\s*import\s[^\n]*"\.\.\/lib\/acp-client\.js"/m.test(code),
      "engine/host.js must not statically import lib/acp-client.js",
    );
  });

  test("engine/index.js re-exports the facade getter", () => {
    // Unexported, both routes would import `undefined` and throw on the first
    // real request — a failure no handler test reaches, since they inject
    // their own data source.
    assert.match(
      read("engine/index.js"),
      /export\s*\{[^}]*getEngineCatalogueHost[^}]*\}\s*from\s*"\.\/host\.js"/,
      "engine/index.js must re-export getEngineCatalogueHost from ./host.js",
    );
  });
});

// --- 2. the real module graph ----------------------------------------------

/**
 * Import `entryRel` in a fresh Node process and report its module graph:
 * the specifiers resolved with the entry as their direct parent, the
 * transitive set of product files, and the bare package specifiers.
 *
 * `module.registerHooks` is in-thread and unflagged on every Node this
 * package supports (engines: >=22.19), so this needs no loader file and no
 * experimental flag. The child mirrors the server's own source-layout
 * bootstrap (`registerWorkspaceSources`, see server/lib/workspace-sources.js)
 * and installs the hook AFTER it, so the recorded set is the entry's graph
 * and not the harness's. The payload is framed by a sentinel because
 * importing the graph legitimately prints lines of its own (lib/config.js
 * logs the resolved workspace on load).
 */
function moduleGraphOf(entryRel) {
  const entryUrl = pathToFileURL(join(serverDir, entryRel)).href;
  const sentinel = "__MODULE_GRAPH__";
  const script = `
    import { registerHooks } from "node:module";
    const { registerWorkspaceSources } = await import(${JSON.stringify(
      pathToFileURL(join(serverDir, "lib/workspace-sources.js")).href,
    )});
    registerWorkspaceSources();
    const seen = [];
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        seen.push({ specifier, url: resolved.url, parent: context.parentURL });
        return resolved;
      },
    });
    const entry = await import(${JSON.stringify(entryUrl)});
    process.stdout.write("\\n${sentinel}" + JSON.stringify({ seen, exports: Object.keys(entry) }));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const framed = stdout.slice(stdout.lastIndexOf(sentinel) + sentinel.length);
  const { seen, exports: exportNames } = JSON.parse(framed);

  const isProductFile = (url) => url.startsWith(pathToFileURL(join(serverDir, "")).href);
  const asProductPath = (url) => relative(serverDir, fileURLToPath(url)).split("\\").join("/");

  return {
    exportNames,
    // Direct edges of the entry: what this file itself asks the loader for.
    directSpecifiers: seen.filter((e) => e.parent === entryUrl).map((e) => e.specifier),
    // Everything reachable, transitively. Product files only: a dependency's
    // own internals are not what this guard is about.
    productFiles: [...new Set(seen.filter((e) => isProductFile(e.url)).map((e) => asProductPath(e.url)))],
    bareSpecifiers: [
      ...new Set(
        seen
          .map((e) => e.specifier)
          .filter((s) => !s.startsWith(".") && !s.startsWith("file:") && !s.startsWith("node:")),
      ),
    ],
  };
}

describe("the two routes resolve the host module through the facade only", () => {
  for (const route of ["routes/plugins.js", "routes/turn-diff.js"]) {
    test(`${route} has no direct edge to the acp client module`, () => {
      // The resolved graph, not the source text: a barrel re-export that
      // pulls acp-client in behind the facade would still show up here.
      const graph = moduleGraphOf(route);
      assert.ok(
        graph.directSpecifiers.includes("../engine/index.js"),
        `${route} must resolve ../engine/index.js directly (got: ${graph.directSpecifiers.join(", ")})`,
      );
      for (const specifier of graph.directSpecifiers) {
        assert.ok(
          !/acp-client|runtime-host|acp\.mjs/.test(specifier),
          `${route} must not resolve ${specifier} directly`,
        );
      }
    });
  }
});

describe("the facade stays off the heavy side of the boot path", () => {
  // engine/index.js is loaded by app.js at boot (via
  // routes/engine-capabilities.js), so its closure is boot cost.
  test("importing engine/index.js loads neither a host module nor a @mavis package", () => {
    const graph = moduleGraphOf("engine/index.js");

    for (const file of graph.productFiles) {
      assert.ok(
        !FORBIDDEN_ON_BOOT_PATH.has(file),
        `engine/index.js loaded ${file} — the host modules stay behind a dynamic import`,
      );
    }
    for (const specifier of graph.bareSpecifiers) {
      for (const prefix of HEAVY_PACKAGE_PREFIXES) {
        assert.ok(
          !specifier.startsWith(prefix),
          `engine/index.js resolved ${specifier} — @mavis/* and @minimax/* are not boot-path modules`,
        );
      }
    }
  });

  test("the facade getter reaches the real module — lazily, not by copying it", () => {
    // Laziness is a property of the graph (the assertions above); this is the
    // other half: the lazy path is wired to the actual singleton rather than
    // to a local stand-in. host-facade's closure contains host.js but not
    // acp-client.js, so the edge has to be made by the dynamic import inside
    // host.js — asserted on the source in the suite above.
    const graph = moduleGraphOf("engine/index.js");
    assert.ok(
      graph.productFiles.includes("engine/host.js"),
      "engine/index.js must re-export from engine/host.js",
    );
    assert.ok(
      !graph.productFiles.includes("lib/acp-client.js"),
      "engine/host.js must not have hoisted the acp client into a static import",
    );
    assert.ok(
      graph.exportNames.includes("getEngineCatalogueHost") && graph.exportNames.includes("getEngineProvider"),
      "the facade must keep exporting getEngineCatalogueHost and getEngineProvider",
    );
  });

  test("the plugins route is fully light — the facade is its only engine import", () => {
    // plugins.js has no other lib dependency, so its whole closure is the
    // assertion: before B0 it was 13 product files plus @mavis/shared via the
    // direct acp-client import, now the facade and the body reader alone.
    const graph = moduleGraphOf("routes/plugins.js");
    for (const file of graph.productFiles) {
      assert.ok(!FORBIDDEN_ON_BOOT_PATH.has(file), `routes/plugins.js loaded ${file}`);
    }
    assert.deepEqual(graph.bareSpecifiers, [], "routes/plugins.js must not pull a bare package");
  });
});
