// webui/test/routes/plugins.test.js
// The `/api/plugins/*` surface (ticket 60 phase 1, slice A).
//
// The route handlers take their data source as an injected `deps.getCliService`,
// so these tests drive a fake cliService instead of booting the runtime. That
// keeps the suite hermetic — no `MCODE_WEBUI_*` environment, no spawned
// server, no temporary directories — while still exercising the real handler
// bodies, the real query/body parsing and the real status mapping.
//
// What is pinned here, per endpoint, in four states:
//
//   empty    — the runtime answers with an empty collection, and the route
//              still answers `ok: true` with the empty array (an empty plugin
//              list is data, not a failure).
//   loading  — the cliService promise is still pending; the route must not
//              have written a response yet. This is the server-side half of
//              the loading state: a fire-and-forget handler would answer
//              before the runtime replied, which is exactly the bug this
//              assertion exists to catch.
//   error    — the runtime throws; the route answers HTTP 200 with
//              `{ ok: false, error, code }` so the client can branch on
//              `code`.
//   success  — the route's projection of the runtime result, including the
//              `sourceKind` string that keeps the webapp free of any
//              `@mavis/protocol` import.
//
// Plus the cross-cutting invariants that are easier to get wrong than any one
// endpoint: the mandatory marketplace `source`, the 400 mapping for facade
// validation codes, `RUNTIME_UNAVAILABLE` when the runtime never boots, and
// the `limit` ceiling.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const pluginsRoute = await import(absPath("routes/plugins.js"));
const { ownsRequest } = await import(absPath("app.js"));

/** The ten routes this slice owns, in the shape the ledger stores them. */
const OWNED_PLUGINS_ROUTES = [
  ["GET", "/api/plugins/installed"],
  ["GET", "/api/plugins/marketplace"],
  ["GET", "/api/plugins/enabled"],
  ["POST", "/api/plugins/refresh"],
  ["POST", "/api/plugins/enable"],
  ["POST", "/api/plugins/disable"],
  ["POST", "/api/plugins/install"],
  ["POST", "/api/plugins/uninstall"],
  ["POST", "/api/plugins/import/preview"],
  ["POST", "/api/plugins/import"],
];

/** A stand-in for the Node ServerResponse, mirroring test/routes/git.test.js. */
function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  return {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
    done,
  };
}

function getReq(query = "") {
  return { url: `/api/plugins${query}` };
}

function postReq(path, payload) {
  const stream = Readable.from([Buffer.from(JSON.stringify(payload ?? {}), "utf8")]);
  stream.url = `/api/plugins${path}`;
  return stream;
}

async function readBody(res) {
  await res.done;
  return JSON.parse(res.body || "{}");
}

/** A promise plus its resolvers, for the loading-state assertions. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function facadeError(code) {
  const error = new Error(code);
  error.name = "PluginDesktopFacadeError";
  error.code = code;
  return error;
}

const INSTALLED_PLUGIN = {
  name: "demo-plugin",
  version: "1.2.0",
  displayName: "Demo Plugin",
  description: "a demo",
  capabilities: { apps: 0, mcpServers: 1, skills: 2 },
  source: 2,
  enabled: true,
};

const MUTATE_RESULT = { source: 2, installExists: true, enabled: true };

/**
 * Run a handler against `cliService` and return `{ status, payload }`.
 *
 * A supplied `payload` means a POST (the body is streamed, which is what
 * `readJson` consumes); otherwise a GET with `query` on the URL.
 */
async function run(handler, { cliService = {}, query = "", payload } = {}) {
  const res = fakeRes();
  const req = payload !== undefined ? postReq("", payload) : getReq(query);
  await handler(req, res, {}, { getCliService: async () => cliService });
  return { status: res.status, payload: await readBody(res) };
}

// ---------------------------------------------------------------------------
// #1  GET /api/plugins/installed
// ---------------------------------------------------------------------------

describe("GET /api/plugins/installed", () => {
  test("success projects the merged page and adds a protocol-free sourceKind", async () => {
    const seen = [];
    const { status, payload } = await run(pluginsRoute.handlePluginsInstalled, {
      query: "?keyword=demo&limit=10&cursor=abc",
      cliService: {
        listInstalledPlugins: async (req) => {
          seen.push(req);
          return {
            plugins: [INSTALLED_PLUGIN],
            hasMore: true,
            nextCursor: "next",
          };
        },
      },
    });

    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.hasMore, true);
    assert.equal(payload.nextCursor, "next");
    assert.deepEqual(payload.plugins, [
      { ...INSTALLED_PLUGIN, sourceKind: "local" },
    ]);
    // The keyword travels through untouched — the facade binds a cursor to a
    // filter and rejects a mismatched pair, so dropping it would silently
    // change which page comes back.
    assert.deepEqual(seen, [{ keyword: "demo", limit: 10, cursor: "abc" }]);
  });

  test("empty is ok:true with an empty array, not an error", async () => {
    const seen = [];
    const { status, payload } = await run(pluginsRoute.handlePluginsInstalled, {
      cliService: {
        listInstalledPlugins: async (req) => {
          seen.push(req);
          return { plugins: [], hasMore: false };
        },
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(payload, { ok: true, plugins: [], hasMore: false });
    // A parameterless request must forward an *empty* request object. Sending
    // `limit: null` instead of omitting it is a real production bug: the
    // facade's pageLimit only treats `undefined` as "use the default" and
    // rejects every non-integer, so the panel's first load came back as
    // PLUGIN_LIMIT_INVALID.
    assert.deepEqual(seen, [{}]);
  });

  test("loading: no response is written before the runtime replies", async () => {
    const gate = deferred();
    const res = fakeRes();
    const handled = pluginsRoute.handlePluginsInstalled(
      getReq(""),
      res,
      {},
      { getCliService: async () => ({ listInstalledPlugins: () => gate.promise }) },
    );
    let settled = false;
    handled.then(() => {
      settled = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "handler resolved before the runtime replied");
    assert.equal(res.body, "", "response was written while the runtime was pending");

    gate.resolve({ plugins: [], hasMore: false });
    await handled;
    const payload = await readBody(res);
    assert.equal(payload.ok, true);
  });

  test("error: runtime failure is HTTP 200 with the code preserved", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsInstalled, {
      cliService: {
        listInstalledPlugins: async () => {
          throw new Error("sqlite is locked");
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "sqlite is locked");
    assert.equal(payload.code, "sqlite is locked");
  });

  test("a facade validation code answers 400 so the client can react", async () => {
    // Reusing a cursor across keywords is the everyday way to hit this; the
    // status has to differ from a data-plane failure or the client retries.
    const { status, payload } = await run(pluginsRoute.handlePluginsInstalled, {
      query: "?cursor=stale",
      cliService: {
        listInstalledPlugins: async () => {
          throw facadeError("PLUGIN_CURSOR_INVALID");
        },
      },
    });
    assert.equal(status, 400);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "PLUGIN_CURSOR_INVALID");
  });

  test("limit is clamped to the facade ceiling, not rejected", async () => {
    const seen = [];
    await run(pluginsRoute.handlePluginsInstalled, {
      query: "?limit=1000",
      cliService: {
        listInstalledPlugins: async (req) => {
          seen.push(req);
          return { plugins: [], hasMore: false };
        },
      },
    });
    assert.deepEqual(seen, [{ limit: 200 }]);
  });

  test("a non-integer limit is a 400 before the runtime is touched", async () => {
    let called = false;
    const { status, payload } = await run(pluginsRoute.handlePluginsInstalled, {
      query: "?limit=all",
      cliService: {
        listInstalledPlugins: async () => {
          called = true;
          return { plugins: [], hasMore: false };
        },
      },
    });
    assert.equal(status, 400);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "invalidBody");
    assert.equal(called, false, "the runtime was called for an invalid limit");
  });
});

// ---------------------------------------------------------------------------
// #2  GET /api/plugins/marketplace
// ---------------------------------------------------------------------------

describe("GET /api/plugins/marketplace", () => {
  const summary = {
    name: "local-skill-pack",
    capabilities: { apps: 0, mcpServers: 0, skills: 3 },
    installExists: false,
    enabled: false,
  };

  test("success: source=2 is the local branch and never needs the network", async () => {
    const seen = [];
    const { status, payload } = await run(pluginsRoute.handlePluginsMarketplace, {
      query: "?source=2&keyword=x&limit=20&category=3&skillLimit=5&skillCursor=s1",
      cliService: {
        listMarketplacePlugins: async (req) => {
          seen.push(req);
          return {
            plugins: [summary],
            hasMore: false,
            marketplaceSkills: [{ name: "s" }],
            skillHasMore: true,
          };
        },
      },
    });

    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.source, 2);
    assert.equal(payload.sourceKind, "local");
    // A marketplace summary has no per-element `source`, so the kind comes
    // from the requested source — this is the field the webapp reads.
    assert.deepEqual(payload.plugins, [{ ...summary, sourceKind: "local" }]);
    assert.deepEqual(payload.marketplaceSkills, [{ name: "s" }]);
    assert.deepEqual(seen, [
      {
        source: 2,
        keyword: "x",
        limit: 20,
        category: 3,
        skillLimit: 5,
        skillCursor: "s1",
      },
    ]);
  });

  test("empty is ok:true with an empty array", async () => {
    const seen = [];
    const { status, payload } = await run(pluginsRoute.handlePluginsMarketplace, {
      query: "?source=2",
      cliService: {
        listMarketplacePlugins: async (req) => {
          seen.push(req);
          return { plugins: [] };
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.plugins, []);
    assert.equal(payload.hasMore, false);
    // Only `source` crosses the wire; every other absent parameter is
    // dropped rather than sent as null (same reason as #1).
    assert.deepEqual(seen, [{ source: 2 }]);
  });

  test("loading: no response before the runtime replies", async () => {
    const gate = deferred();
    const res = fakeRes();
    const handled = pluginsRoute.handlePluginsMarketplace(
      getReq("?source=2"),
      res,
      {},
      { getCliService: async () => ({ listMarketplacePlugins: () => gate.promise }) },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(res.body, "");
    gate.resolve({ plugins: [] });
    await handled;
    assert.equal((await readBody(res)).ok, true);
  });

  test("error: the official branch's cloud failure is passed through, not swallowed", async () => {
    // The placeholder cloud domain does not resolve in the local edition, so
    // this failure is the expected shape for source=1 — the frontend, not the
    // route, decides it means "not available in the local edition".
    const { status, payload } = await run(pluginsRoute.handlePluginsMarketplace, {
      query: "?source=1",
      cliService: {
        listMarketplacePlugins: async () => {
          throw facadeError("PLUGIN_AUTH_REQUIRED");
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "PLUGIN_AUTH_REQUIRED");
  });

  test("a missing source is a 400 and never reaches the runtime", async () => {
    // The facade maps an absent source to OFFICIAL, so forwarding it would
    // dial an unresolvable cloud host. The route has to stop it here.
    let called = false;
    const { status, payload } = await run(pluginsRoute.handlePluginsMarketplace, {
      query: "",
      cliService: {
        listMarketplacePlugins: async () => {
          called = true;
          return { plugins: [] };
        },
      },
    });
    assert.equal(status, 400);
    assert.equal(payload.code, "invalidBody");
    assert.match(payload.error, /source is required/);
    assert.equal(called, false, "a sourceless request reached the official registry");
  });

  test("an out-of-range source is a 400", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsMarketplace, {
      query: "?source=3",
      cliService: { listMarketplacePlugins: async () => ({ plugins: [] }) },
    });
    assert.equal(status, 400);
    assert.equal(payload.code, "invalidBody");
  });

  test("a non-integer category is a 400", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsMarketplace, {
      query: "?source=2&category=design",
      cliService: { listMarketplacePlugins: async () => ({ plugins: [] }) },
    });
    assert.equal(status, 400);
    assert.equal(payload.code, "invalidBody");
  });
});

// ---------------------------------------------------------------------------
// #3  GET /api/plugins/enabled
// ---------------------------------------------------------------------------

describe("GET /api/plugins/enabled", () => {
  test("success returns the enabled subset", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsEnabled, {
      cliService: {
        listEnabledPlugins: async () => ({
          plugins: [{ name: "demo-plugin", displayName: "Demo Plugin" }],
        }),
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(payload, {
      ok: true,
      plugins: [{ name: "demo-plugin", displayName: "Demo Plugin" }],
    });
  });

  test("empty is ok:true with an empty array", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsEnabled, {
      cliService: { listEnabledPlugins: async () => ({ plugins: [] }) },
    });
    assert.equal(status, 200);
    assert.deepEqual(payload, { ok: true, plugins: [] });
  });

  test("loading: no response before the runtime replies", async () => {
    const gate = deferred();
    const res = fakeRes();
    const handled = pluginsRoute.handlePluginsEnabled(
      getReq(""),
      res,
      {},
      { getCliService: async () => ({ listEnabledPlugins: () => gate.promise }) },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(res.body, "");
    gate.resolve({ plugins: [] });
    await handled;
    assert.equal((await readBody(res)).ok, true);
  });

  test("error: a runtime failure is 200 with ok:false", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsEnabled, {
      cliService: {
        listEnabledPlugins: async () => {
          throw new Error("snapshot unavailable");
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "snapshot unavailable");
  });
});

// ---------------------------------------------------------------------------
// #4  POST /api/plugins/refresh
// ---------------------------------------------------------------------------

describe("POST /api/plugins/refresh", () => {
  test("success is a bare ok:true — the caller re-lists", async () => {
    let called = 0;
    const { status, payload } = await run(pluginsRoute.handlePluginsRefresh, {
      payload: {},
      cliService: {
        refreshPlugins: async () => {
          called += 1;
        },
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(payload, { ok: true });
    assert.equal(called, 1);
  });

  test("empty: a no-op reconcile still succeeds", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsRefresh, {
      payload: {},
      cliService: { refreshPlugins: async () => undefined },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
  });

  test("loading: no response before the runtime reconciles", async () => {
    const gate = deferred();
    const res = fakeRes();
    const handled = pluginsRoute.handlePluginsRefresh(
      postReq("/refresh", {}),
      res,
      {},
      { getCliService: async () => ({ refreshPlugins: () => gate.promise }) },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(res.body, "");
    gate.resolve();
    await handled;
    assert.deepEqual(await readBody(res), { ok: true });
  });

  test("error: a reconcile failure is passed through with its code", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsRefresh, {
      payload: {},
      cliService: {
        refreshPlugins: async () => {
          throw facadeError("PLUGIN_REGISTRY_UNREACHABLE");
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "PLUGIN_REGISTRY_UNREACHABLE");
  });
});

// ---------------------------------------------------------------------------
// #5-#8  POST /api/plugins/{enable,disable,install,uninstall}
// ---------------------------------------------------------------------------

const MUTATIONS = [
  ["POST /api/plugins/enable", pluginsRoute.handlePluginsEnable, "enablePlugin", true],
  ["POST /api/plugins/disable", pluginsRoute.handlePluginsDisable, "disablePlugin", false],
  ["POST /api/plugins/install", pluginsRoute.handlePluginsInstall, "installPlugin", true],
  ["POST /api/plugins/uninstall", pluginsRoute.handlePluginsUninstall, "uninstallPlugin", false],
];

for (const [name, handler, method, expectedEnabled] of MUTATIONS) {
  describe(name, () => {
    test("success forwards the name and source and reports the resulting state", async () => {
      const seen = [];
      const { status, payload } = await run(handler, {
        payload: { pluginName: " demo-plugin ", source: 2 },
        cliService: {
          [method]: async (req) => {
            seen.push(req);
            return { ...MUTATE_RESULT, enabled: expectedEnabled };
          },
        },
      });
      assert.equal(status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.installExists, true);
      assert.equal(payload.enabled, expectedEnabled);
      assert.equal(payload.sourceKind, "local");
      // The name is trimmed but not otherwise rewritten: the facade matches
      // on the canonical name, and a silently altered one would 404 later.
      assert.deepEqual(seen, [{ pluginName: "demo-plugin", source: 2 }]);
    });

    test("empty: an absent target is idempotent ok:true, not an error", async () => {
      const { status, payload } = await run(handler, {
        payload: { pluginName: "ghost" },
        cliService: { [method]: async () => ({ source: 2, installExists: false, enabled: false }) },
      });
      assert.equal(status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.installExists, false);
      assert.equal(payload.enabled, false);
    });

    test("loading: no response before the runtime mutates", async () => {
      const gate = deferred();
      const res = fakeRes();
      const handled = handler(
        postReq("", { pluginName: "demo-plugin", source: 2 }),
        res,
        {},
        { getCliService: async () => ({ [method]: () => gate.promise }) },
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(res.body, "");
      gate.resolve(MUTATE_RESULT);
      await handled;
      assert.equal((await readBody(res)).ok, true);
    });

    test("error: PLUGIN_NOT_FOUND is passed through", async () => {
      const { status, payload } = await run(handler, {
        payload: { pluginName: "ghost", source: 2 },
        cliService: {
          [method]: async () => {
            throw facadeError("PLUGIN_NOT_FOUND");
          },
        },
      });
      assert.equal(status, 200);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, "PLUGIN_NOT_FOUND");
    });

    test("a missing pluginName is a 400 and never reaches the runtime", async () => {
      let called = false;
      const { status, payload } = await run(handler, {
        payload: { source: 2 },
        cliService: {
          [method]: async () => {
            called = true;
            return MUTATE_RESULT;
          },
        },
      });
      assert.equal(status, 400);
      assert.equal(payload.code, "invalidBody");
      assert.equal(called, false);
    });

    test("an out-of-range source is a 400", async () => {
      const { status, payload } = await run(handler, {
        payload: { pluginName: "demo-plugin", source: 7 },
        cliService: { [method]: async () => MUTATE_RESULT },
      });
      assert.equal(status, 400);
      assert.equal(payload.code, "invalidBody");
    });
  });
}

describe("POST /api/plugins/install on a local source", () => {
  test("LOCAL_PLUGIN_INSTALL_UNSUPPORTED is passed through, not hidden", async () => {
    // Local packages are already on disk; "install" has no meaning for them.
    // The UI is expected to hide the button, and the route must not pretend
    // the call succeeded if a client sends it anyway.
    const { status, payload } = await run(pluginsRoute.handlePluginsInstall, {
      payload: { pluginName: "local-plugin", source: 2 },
      cliService: {
        installPlugin: async () => {
          throw facadeError("LOCAL_PLUGIN_INSTALL_UNSUPPORTED");
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "LOCAL_PLUGIN_INSTALL_UNSUPPORTED");
  });
});

// ---------------------------------------------------------------------------
// #9  POST /api/plugins/import/preview
// ---------------------------------------------------------------------------

describe("POST /api/plugins/import/preview", () => {
  const previewResult = {
    source: { repositoryUrl: "https://github.com/acme/plugin", commitSha: "abc123" },
    plugin: { summary: { name: "plugin" }, skillCount: 2, mcpServerCount: 1, hasStdioMcp: true },
    diagnostics: [{ code: "ok" }],
    packageSizeBytes: 4096,
    canImport: true,
  };

  test("success returns the full preview payload", async () => {
    const seen = [];
    const { status, payload } = await run(pluginsRoute.handlePluginsImportPreview, {
      payload: { url: " https://github.com/acme/plugin " },
      cliService: {
        previewGithubPlugin: async (req) => {
          seen.push(req);
          return previewResult;
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.source, previewResult.source);
    assert.deepEqual(payload.plugin, previewResult.plugin);
    assert.deepEqual(payload.diagnostics, previewResult.diagnostics);
    assert.equal(payload.packageSizeBytes, 4096);
    assert.equal(payload.canImport, true);
    assert.deepEqual(seen, [{ url: "https://github.com/acme/plugin" }]);
  });

  test("empty: a package with nothing importable still lists an array for diagnostics", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsImportPreview, {
      payload: { url: "https://github.com/acme/empty" },
      cliService: {
        previewGithubPlugin: async () => ({
          ...previewResult,
          diagnostics: undefined,
          canImport: false,
        }),
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(payload.diagnostics, []);
    assert.equal(payload.canImport, false);
  });

  test("loading: no response before the GitHub fetch settles", async () => {
    const gate = deferred();
    const res = fakeRes();
    const handled = pluginsRoute.handlePluginsImportPreview(
      postReq("/import/preview", { url: "https://github.com/acme/plugin" }),
      res,
      {},
      { getCliService: async () => ({ previewGithubPlugin: () => gate.promise }) },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(res.body, "");
    gate.resolve(previewResult);
    await handled;
    assert.equal((await readBody(res)).ok, true);
  });

  test("error: PLUGIN_NO_SUPPORTED_CAPABILITY is passed through", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsImportPreview, {
      payload: { url: "https://github.com/acme/empty-repo" },
      cliService: {
        previewGithubPlugin: async () => {
          throw facadeError("PLUGIN_NO_SUPPORTED_CAPABILITY");
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "PLUGIN_NO_SUPPORTED_CAPABILITY");
  });

  test("a missing url is a 400 and never reaches the network", async () => {
    let called = false;
    const { status, payload } = await run(pluginsRoute.handlePluginsImportPreview, {
      payload: {},
      cliService: {
        previewGithubPlugin: async () => {
          called = true;
          return previewResult;
        },
      },
    });
    assert.equal(status, 400);
    assert.equal(payload.code, "invalidBody");
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// #10  POST /api/plugins/import
// ---------------------------------------------------------------------------

describe("POST /api/plugins/import", () => {
  test("success forwards the trimmed source and returns the imported summary", async () => {
    const seen = [];
    const { status, payload } = await run(pluginsRoute.handlePluginsImport, {
      payload: {
        source: {
          repositoryUrl: " https://github.com/acme/plugin ",
          commitSha: " abc123 ",
          subPath: "packages/p",
        },
      },
      cliService: {
        importGithubPlugin: async (req) => {
          seen.push(req);
          return { plugin: { name: "plugin", enabled: true } };
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.plugin, { name: "plugin", enabled: true });
    assert.deepEqual(seen, [
      {
        source: {
          repositoryUrl: "https://github.com/acme/plugin",
          commitSha: "abc123",
          subPath: "packages/p",
        },
      },
    ]);
  });

  test("empty: an omitted subPath is left out rather than sent as undefined", async () => {
    const seen = [];
    await run(pluginsRoute.handlePluginsImport, {
      payload: { source: { repositoryUrl: "u", commitSha: "s" } },
      cliService: {
        importGithubPlugin: async (req) => {
          seen.push(req);
          return { plugin: {} };
        },
      },
    });
    // A literal `subPath: undefined` would serialise away anyway, but an
    // absent key is what the runtime's own type describes.
    assert.deepEqual(Object.keys(seen[0].source), ["repositoryUrl", "commitSha"]);
  });

  test("loading: no response before the import settles", async () => {
    const gate = deferred();
    const res = fakeRes();
    const handled = pluginsRoute.handlePluginsImport(
      postReq("/import", { source: { repositoryUrl: "u", commitSha: "s" } }),
      res,
      {},
      { getCliService: async () => ({ importGithubPlugin: () => gate.promise }) },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(res.body, "");
    gate.resolve({ plugin: {} });
    await handled;
    assert.equal((await readBody(res)).ok, true);
  });

  test("error: PLUGIN_ALREADY_EXISTS is passed through", async () => {
    const { status, payload } = await run(pluginsRoute.handlePluginsImport, {
      payload: { source: { repositoryUrl: "u", commitSha: "s" } },
      cliService: {
        importGithubPlugin: async () => {
          throw facadeError("PLUGIN_ALREADY_EXISTS");
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "PLUGIN_ALREADY_EXISTS");
  });

  test("a malformed source object is a 400", async () => {
    for (const body of [
      {},
      { source: "https://github.com/acme/plugin" },
      { source: { repositoryUrl: "u" } },
      { source: { repositoryUrl: "u", commitSha: "s", subPath: 7 } },
    ]) {
      const { status, payload } = await run(pluginsRoute.handlePluginsImport, {
        payload: body,
        cliService: { importGithubPlugin: async () => ({ plugin: {} }) },
      });
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(payload.code, "invalidBody");
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: what happens when the runtime never boots
// ---------------------------------------------------------------------------

describe("runtime unavailable", () => {
  const GET_HANDLERS = [
    ["installed", pluginsRoute.handlePluginsInstalled, { query: "" }],
    ["marketplace", pluginsRoute.handlePluginsMarketplace, { query: "?source=2" }],
    ["enabled", pluginsRoute.handlePluginsEnabled, { query: "" }],
  ];
  const POST_HANDLERS = [
    ["refresh", pluginsRoute.handlePluginsRefresh, { payload: {} }],
    ["enable", pluginsRoute.handlePluginsEnable, { payload: { pluginName: "p", source: 2 } }],
    ["disable", pluginsRoute.handlePluginsDisable, { payload: { pluginName: "p", source: 2 } }],
    ["install", pluginsRoute.handlePluginsInstall, { payload: { pluginName: "p", source: 2 } }],
    ["uninstall", pluginsRoute.handlePluginsUninstall, { payload: { pluginName: "p", source: 2 } }],
    [
      "import/preview",
      pluginsRoute.handlePluginsImportPreview,
      { payload: { url: "https://github.com/acme/plugin" } },
    ],
    [
      "import",
      pluginsRoute.handlePluginsImport,
      { payload: { source: { repositoryUrl: "u", commitSha: "s" } } },
    ],
  ];

  for (const [name, handler, opts] of [...GET_HANDLERS, ...POST_HANDLERS]) {
    test(`${name} answers RUNTIME_UNAVAILABLE when the catalogue host is null`, async () => {
      const res = fakeRes();
      const req =
        opts.payload !== undefined ? postReq("", opts.payload) : getReq(opts.query);
      await handler(req, res, {}, { getCliService: async () => null });
      const payload = await readBody(res);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, "RUNTIME_UNAVAILABLE");
      assert.equal(payload.error, "runtime unavailable");
    });
  }

  test("a getter that throws is reported rather than crashing the handler", async () => {
    const res = fakeRes();
    await pluginsRoute.handlePluginsEnabled(getReq(""), res, {}, {
      getCliService: async () => {
        throw new Error("host init failed");
      },
    });
    const payload = await readBody(res);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "host init failed");
  });
});

// ---------------------------------------------------------------------------
// The two links above the handler that a unit test cannot reach
// ---------------------------------------------------------------------------

// The default data source is the catalogue host singleton, and the route's
// whole premise — "plugins work under the default acp transport" — rests on
// two lines that no handler-level test can execute: booting the host means
// constructing an entire runtime. A static tripwire is the honest floor here;
// without it, deleting either line would leave every test above green and the
// panel dead in production.
describe("catalogue host wiring", () => {
  const read = (rel) =>
    readFileSync(join(import.meta.dirname, "..", "..", "server", rel), "utf8");

  test("acp-client.js exports the catalogue host getter", () => {
    // Unexported, this import would be undefined at runtime — the route would
    // throw on every call. The keyword form keeps a re-export from passing.
    assert.match(
      read("lib/acp-client.js"),
      /export\s+async\s+function\s+getCatalogueHost\s*\(/,
      "getCatalogueHost must be exported from lib/acp-client.js",
    );
  });

  test("createCatalogueHost returns the bare cliService", () => {
    // The TUI adapter's plugin surface has no preview / import / listEnabled,
    // so without this field two of the ten endpoints have no data source.
    // Engine-abstraction M1 moved createCatalogueHost verbatim into
    // engine/providers/local-runtime-v2.js (runtime-host.js re-exports
    // it); the tripwire follows the code to its new home.
    assert.match(
      read("engine/providers/local-runtime-v2.js"),
      /cliService:\s*host\.cliService/,
      "createCatalogueHost must return the bare cliService",
    );
  });

  test("every owned plugins route is registered in the Hono app", () => {
    // `OWNED_ROUTES` is a three-way link — ledger, Hono registration, handler
    // export. The ledger is a literal list and proves nothing about the
    // router: mutation verification showed that deleting an `app.get(...)`
    // line leaves the ledger assertion green while `ownsRequest` starts
    // answering false and the request silently falls through to the legacy
    // dispatcher as a 404. So the registration is asserted against the router
    // table `ownsRequest` actually walks.
    const app = read("app.js");
    for (const [method, path] of OWNED_PLUGINS_ROUTES) {
      assert.ok(
        app.includes(`"${method} ${path}"`),
        `${method} ${path} must be listed in OWNED_ROUTES`,
      );
      assert.equal(
        ownsRequest(method, path),
        true,
        `${method} ${path} is in the ledger but the Hono app does not serve it`,
      );
    }
  });
});
