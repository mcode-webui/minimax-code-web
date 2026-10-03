// webui/test/lib/engine/host-services.test.js
//
// The host-services window (placeholder batch PB-8) — shape and contract.
//
// The real-host evidence lives next door, in
// `test/server/host-services-window.test.js`, because booting a runtime
// costs seconds and belongs with the other real-host suites. What this
// file owns is everything that can be decided without one, and one of
// those is load-bearing:
//
//   1. Source shape — the window reaches the host through the facade's
//      `getEngineCatalogueHost` and through NOTHING else. The tempting
//      short-cut is to import `engine/providers/local-runtime-v2.js`
//      directly (it is right there, and it is where `services` is
//      forwarded). That would put the whole `@mavis/*` TypeScript tree
//      on the boot path, because `app.js` loads `engine/index.js` at
//      start — the exact regression M1 paid for once (209ms → 2700ms)
//      and the one `host-facade.test.js` exists to guard. A second
//      short-cut is to construct a host here, which is worse: two
//      runtimes over one dataDir is a split brain against the plugin
//      and local-disable tables.
//
//   2. Return contract — three distinct answers (`null` for no host,
//      `undefined` for a host without services, the object for a host
//      with them). The middle answer is the one a `??` away from
//      silently collapsing into the first, and it is the answer a
//      consumer gating on presence needs.
//
//   3. Scope — the window ships WITHOUT a route. The only thing this
//      batch adds to the HTTP surface is nothing, and that is asserted
//      rather than asserted-in-a-comment: the module exports one
//      function and no handler.
//
// Anti-mirroring note, since "改坏必红" is the discipline here: every
// assertion below is about what the module does or names, not about a
// restatement of its own implementation. The three ways to break this
// window — return a hardcoded empty object, bypass the facade singleton,
// drop the `await` — each turn at least one of these red.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const packageDir = join(import.meta.dirname, "..", "..", "..");
const serverDir = join(packageDir, "server");
const read = (rel) => readFileSync(join(serverDir, rel), "utf8");

/** Strip comments — this file's prose legitimately names the guarded modules. */
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

const WINDOW = "engine/host-services.js";

// --- 1. source shape -------------------------------------------------------

describe("the window reaches the host through the facade singleton only", () => {
  test(`${WINDOW} takes the host from the engine facade getter`, () => {
    const code = codeOf(read(WINDOW));
    assert.match(
      code,
      /import\s*\{[^}]*getEngineCatalogueHost[^}]*\}\s*from\s*"\.\/host\.js"/,
      "the window must import getEngineCatalogueHost from ./host.js — the one process-wide host",
    );
    assert.match(code, /await\s+getHost\(\)/, "the window must await the host getter");
  });

  test(`${WINDOW} never names a host-construction module`, () => {
    const code = codeOf(read(WINDOW));
    for (const forbidden of [
      "acp-client",
      "runtime-host",
      "providers/local-runtime-v2",
      "@mavis/",
      "@minimax/",
      "createCatalogueHost",
      "createLocalRuntimeHostV2",
    ]) {
      assert.ok(
        !code.includes(forbidden),
        `${WINDOW} must not mention ${forbidden} — that is the boot path / second-host rule the facade exists to hold`,
      );
    }
  });

  test("engine/index.js re-exports the window beside the host getter", () => {
    assert.match(
      read("engine/index.js"),
      /export\s*\{[^}]*getHostServices[^}]*\}\s*from\s*"\.\/host-services\.js"/,
      "engine/index.js must re-export getHostServices, or every consumer would import undefined",
    );
  });
});

// --- 2. return contract ----------------------------------------------------

describe("the window reports what the host actually carries", () => {
  test("returns the host's services object by reference, not a copy", async () => {
    const { getHostServices } = await import("../../../server/engine/host-services.js");
    const services = { managedWorktrees: { list() {} }, cron: undefined };
    const host = { services };
    assert.equal(
      await getHostServices({ getHost: async () => host }),
      services,
      "the window must forward the runtime's own object — a clone would freeze the truth at open time",
    );
  });

  test("answers null — not undefined — when there is no host", async () => {
    const { getHostServices } = await import("../../../server/engine/host-services.js");
    const answer = await getHostServices({ getHost: async () => null });
    assert.equal(
      answer,
      null,
      "no runtime is `null`, matching getEngineCatalogueHost — a caller mapping null to RUNTIME_UNAVAILABLE must not fire for a host that merely lacks services",
    );
  });

  test("answers undefined — not null — when a host carries no services", async () => {
    const { getHostServices } = await import("../../../server/engine/host-services.js");
    const answer = await getHostServices({ getHost: async () => ({ cliService: {} }) });
    assert.equal(
      answer,
      undefined,
      "a host without the member is a distinct state; `?? null` here would erase the difference a consumer gating on presence depends on",
    );
  });

  test("propagates a throwing host getter unchanged", async () => {
    const { getHostServices } = await import("../../../server/engine/host-services.js");
    const boom = new Error("runtime boot failed");
    await assert.rejects(
      getHostServices({
        getHost: async () => {
          throw boom;
        },
      }),
      (error) => error === boom,
      "the window owns no failure mapping — the caller does, exactly as through getEngineCatalogueHost",
    );
  });

  test("defaults to the facade getter when no seam is injected", () => {
    // Not a behaviour test: the default is what every real consumer uses,
    // and a window that only worked with an injected getter would be dead
    // code that its own unit tests pass.
    const code = codeOf(read(WINDOW));
    assert.match(
      code,
      /const\s+getHost\s*=\s*deps\.getHost\s*\?\?\s*getEngineCatalogueHost/,
      "the default must be the real facade getter",
    );
  });
});

// --- 3. scope --------------------------------------------------------------

describe("the batch ships a window and no endpoint", () => {
  test(`${WINDOW} exports the window and nothing else`, async () => {
    const module = await import("../../../server/engine/host-services.js");
    assert.deepEqual(
      Object.keys(module),
      ["getHostServices"],
      "a handler exported from this module would mean the batch attached a route; PB-3 / PB-7 own those",
    );
  });

  test("no HTTP route file consumes the window yet", () => {
    const routeDir = join(serverDir, "routes");
    const routes = readdirSync(routeDir).filter((name) => name.endsWith(".js"));
    const consumers = routes.filter((name) => codeOf(read(join("routes", name))).includes("getHostServices"));
    assert.deepEqual(
      consumers,
      [],
      "PB-8 is the prerequisite, not the delivery — a route here belongs to the batch that owns that capability",
    );
  });
});
