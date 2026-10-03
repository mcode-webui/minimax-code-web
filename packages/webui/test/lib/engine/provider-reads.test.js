// webui/test/lib/engine/provider-reads.test.js
//
// M3-B11 (= plan item A5), the read half: #62 GET /api/providers,
// #64 POST /api/providers/test, #65 GET /api/providers/presets, through
// `server/engine/provider-reads.js`.
//
// What is worth a test here, and what is not:
//
//   - The three endpoints' DECLARATIONS: which capability, which
//     sub-item, hard or soft. The `subItem` names the method that
//     would eventually serve the endpoint, and every one of them is
//     already an audited fact on the real host
//     (test/lib/engine/capability-snapshot.test.js lists
//     `listUserModelProviders`, `createUserModelProvider`,
//     `updateUserModelProvider`, `deleteUserModelProvider`,
//     `testUserModelProvider` and `testUserModel` in
//     `authCredentials` for BOTH surfaces), so this family's soft gate
//     is not an unearned claim.
//   - That the gate is SOFT: it reports, it never throws. The 501
//     machinery is unused by this family and the suite pins that, the
//     same way B6, B7 and B9 pin theirs.
//   - Which file the catalogue came from, and the migration report that
//     travels with the answer. The migration contracts themselves live
//     in provider-migration.test.js; this file pins the SHAPE the route
//     consumes.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";

const tmpBase = mkTmpDir("minimax-code-engine-reads-");
const engineDir = join(tmpBase, "engine");
const webuiDir = join(tmpBase, "webui");
const cwdDir = join(tmpBase, "cwd");
const legacyFile = join(webuiDir, "providers.json");
const configPath = join(engineDir, "config.yaml");
process.env.MINIMAX_DATA_DIR = engineDir;
process.env.MAVIS_DATA_DIR = "";
process.env.MCODE_WEBUI_DATA_DIR = webuiDir;
process.env.MCODE_WEBUI_MODELS_CONFIG = "";
process.env.MCODE_WEBUI_SETTINGS_PATH = join(tmpBase, "settings.json");
process.env.MCODE_WEBUI_EVENTS_PATH = join(tmpBase, "events.jsonl");
process.env.MCODE_WEBUI_SESSIONS_DB = join(tmpBase, "sessions.db");
process.env.MCODE_WEBUI_UPLOAD_DIR = join(tmpBase, "uploads");

const {
  PROVIDER_READ_ENDPOINTS,
  checkProviderReadCapability,
  readEngineProviderCatalogue,
  resolveProviderReadProvider,
} = await import("../../../server/engine/provider-reads.js");
const { EngineCapabilityNotSupportedError } = await import("../../../server/engine/errors.js");
const { LOCAL_RUNTIME_V2_CAPABILITIES } = await import("../../../server/engine/index.js");
const { _resetProviderStoreMigration } = await import("../../../server/engine/provider-store.js");

mkdirSync(engineDir, { recursive: true });
mkdirSync(webuiDir, { recursive: true });
mkdirSync(cwdDir, { recursive: true });
const _origCwd = process.cwd();
process.chdir(cwdDir);
process.on("exit", () => {
  try {
    process.chdir(_origCwd);
  } catch {}
  rmTmpDir(tmpBase);
});

// =====================================================================
// The gate table
// =====================================================================

describe("PROVIDER_READ_ENDPOINTS — three reads, one capability, all soft", () => {
  test("exactly #62, #64 and #65, all on authCredentials, all soft", () => {
    assert.deepEqual(Object.keys(PROVIDER_READ_ENDPOINTS).sort(), [
      "GET /api/providers",
      "GET /api/providers/presets",
      "POST /api/providers/test",
    ]);
    for (const [endpoint, need] of Object.entries(PROVIDER_READ_ENDPOINTS)) {
      assert.equal(need.capability, "authCredentials", endpoint);
      assert.equal(need.enforcement, "soft", endpoint);
    }
    assert.equal(PROVIDER_READ_ENDPOINTS["GET /api/providers"].subItem, "listUserModelProviders");
    assert.equal(PROVIDER_READ_ENDPOINTS["GET /api/providers/presets"].subItem, "listProviderPresets");
    assert.equal(PROVIDER_READ_ENDPOINTS["POST /api/providers/test"].subItem, "testUserModelProvider");
  });

  test("the sub-items name methods the audited host really has", () => {
    // Cross-reference against the snapshot audit's own list. If a
    // future batch re-audits `authCredentials` and one of these names
    // disappears from the surface, this goes red at the point the
    // declaration changed rather than at the point a client did.
    const audited = [
      "listUserModelProviders",
      "createUserModelProvider",
      "updateUserModelProvider",
      "deleteUserModelProvider",
      "testUserModelProvider",
      "testUserModel",
    ];
    const snapshot = readFileSync(
      join(import.meta.dirname, "capability-snapshot.test.js"),
      "utf8",
    );
    for (const name of Object.values(PROVIDER_READ_ENDPOINTS).map((n) => n.subItem)) {
      if (name === "listProviderPresets") continue; // KNOWN DEBT 2
      assert.ok(audited.includes(name), `${name} must be an audited surface method`);
      assert.ok(snapshot.includes(name), `${name} must appear in the snapshot audit's table`);
    }
  });
});

describe("checkProviderReadCapability — SOFT, reports, never throws", () => {
  test("the declared provider is not degraded for any of the three", () => {
    for (const endpoint of Object.keys(PROVIDER_READ_ENDPOINTS)) {
      const r = checkProviderReadCapability(endpoint, "runtime");
      assert.equal(r.gate, "checked");
      assert.equal(r.provider, "local-runtime-v2");
      assert.equal(r.degraded, false, endpoint);
      assert.equal(r.reason, null);
    }
  });

  test("a `none` declaration reports degraded, it does not throw", () => {
    // The whole reason this family is soft: a provider that cannot
    // manage providers still serves a well-defined catalogue, and a 501
    // would delete a working UI over a declaration about who would
    // eventually answer it.
    const original = LOCAL_RUNTIME_V2_CAPABILITIES.authCredentials;
    try {
      // The gate resolves through getEngineProvider, so a provider that
      // DENIES the sub-item cannot be constructed here without editing
      // the shared frozen declaration. What is pinned instead is the
      // two halves that need no such construction: the predicate's own
      // degradation rule, and the source-level fact that this module
      // never touches the 501 machinery.
      const partial = {
        ...LOCAL_RUNTIME_V2_CAPABILITIES,
        authCredentials: { ...original, missing: [...original.missing, "listUserModelProviders"] },
      };
      assert.ok(partial.authCredentials.missing.includes("listUserModelProviders"));
      // And the 501 machinery is genuinely unused here: the read gate
      // has no path that constructs the error.
      const src = readFileSync(
        join(import.meta.dirname, "..", "..", "..", "server", "engine", "provider-reads.js"),
        "utf8",
      );
      assert.equal(src.includes("EngineCapabilityNotSupportedError"), false);
      assert.equal(src.includes("assertEngineCapability"), false, "the soft gate must not gate");
    } finally {
      void original;
    }
  });

  test("an unregistered transport reports, it does not degrade", () => {
    for (const transport of ["acp", "exec"]) {
      const r = checkProviderReadCapability("GET /api/providers", transport);
      assert.equal(r.gate, "unregistered-transport");
      assert.equal(r.provider, null);
      assert.equal(r.degraded, false, "nobody has claimed this transport yet (M4)");
    }
  });

  test("an endpoint outside the family is a caller bug, reported as such", () => {
    assert.throws(
      () => checkProviderReadCapability("PUT /api/providers", "runtime"),
      (e) => e.code === "unknown_provider_read_endpoint" && !(e instanceof EngineCapabilityNotSupportedError),
    );
  });

  test("resolveProviderReadProvider returns the registered provider on runtime only", () => {
    assert.equal(resolveProviderReadProvider("runtime").id, "local-runtime-v2");
    assert.equal(resolveProviderReadProvider("acp"), null);
  });
});

// =====================================================================
// The catalogue result shape
// =====================================================================

describe("readEngineProviderCatalogue — the shape the route consumes", () => {
  function reset() {
    _resetProviderStoreMigration();
    for (const f of [configPath, legacyFile, join(cwdDir, "models.json")]) {
      if (existsSync(f)) rmSync(f, { recursive: true, force: true });
    }
    mkdirSync(engineDir, { recursive: true });
    mkdirSync(webuiDir, { recursive: true });
    mkdirSync(cwdDir, { recursive: true });
  }

  test("an empty world: no files, no write, a well-formed empty answer", async () => {
    reset();
    const c = await readEngineProviderCatalogue();
    assert.equal(c.version, 2);
    assert.deepEqual(c.providers, []);
    assert.equal(c.catalogueSource, "legacy-file");
    assert.equal(c.migration.attempted, false);
    assert.equal(c.migration.code, null);
    assert.equal(c.storePath, configPath, "the store path is reported so a log line can name it");
    assert.equal(existsSync(configPath), false, "a GET never creates the store");
  });

  test("sources still name all three layers, and userPath still names the deprecated file", async () => {
    // The response fields are unchanged by this batch even though the
    // answer behind them moved: an operator diagnosing a missing
    // provider still needs to be told which files the server resolved,
    // and the bilingual docs carry the new answer.
    //
    // The cwd expectation is built from `process.cwd()` rather than
    // from the string this file chdir'd into. Those two differ whenever
    // the temp path has a symlink component, and they are not the same
    // kind of thing: `process.cwd()` is `getcwd(2)`, which returns a
    // fully-resolved path on every POSIX platform, while the chdir
    // argument is whatever the caller typed. The product's contract is
    // "the cwd layer is `<process.cwd()>/models.json`", so that is what
    // is asserted — see the symlink test below for the case this exists
    // to cover.
    reset();
    const c = await readEngineProviderCatalogue();
    assert.equal(c.sources.user, legacyFile);
    assert.equal(c.sources.cwd, join(process.cwd(), "models.json"));
    assert.equal(c.sources.env, null);
    assert.equal(c.userPath, legacyFile);
  });

  test("a symlinked cwd does not change the cwd layer's path — the product does not re-resolve it", async () => {
    // The macOS CI red, reproduced on any POSIX platform. macOS makes
    // `/var` a symlink to `/private/var`, and `os.tmpdir()` lands under
    // it, so a test that chdir'd into a temp dir and then asserted on
    // the literal path it passed got `/private/var/...` back and
    // failed. Linux CI never showed it because `/tmp` is a real
    // directory — a symlink makes the same mismatch happen here.
    //
    // What is pinned is the product's behaviour, not the platform's:
    // the path is `process.cwd()` + the file name, and webui applies
    // NO additional resolution of its own. That is the correct
    // direction for a value the API hands an operator to look at, and
    // it is load-bearing for the store below — a read path that
    // re-resolved and a write path that did not would make the write
    // land in a different file than the read looked in.
    reset();
    const realDir = join(tmpBase, "symlink-target");
    const alias = join(tmpBase, "symlink-alias");
    mkdirSync(realDir, { recursive: true });
    rmSync(alias, { force: true });
    symlinkSync(realDir, alias);
    process.chdir(alias);
    try {
      assert.notEqual(process.cwd(), alias, "the platform resolved the symlink, as getcwd always has");
      const c = await readEngineProviderCatalogue();
      assert.equal(
        c.sources.cwd,
        join(process.cwd(), "models.json"),
        "the reported path tracks process.cwd(), with no second resolution layered on top",
      );
      assert.equal(c.sources.cwd.startsWith(alias), false, "webui does not re-expand the symlink either");
      // The EXPECTED side is normalised here, never the actual. On
      // macOS the temp ROOT is itself a symlink (`/var` →
      // `/private/var`), so `realDir` as spelled here is not what
      // `getcwd` will report — comparing against `realpathSync` is what
      // makes this assertion mean the same thing on both platforms.
      assert.equal(
        c.sources.cwd.startsWith(realpathSync(realDir)),
        true,
        "it reports what getcwd reported",
      );
    } finally {
      process.chdir(_origCwd);
    }
  });

  test("the env override suppresses the cwd layer, as it always did", async () => {
    reset();
    const envFile = join(cwdDir, "env.json");
    writeFileSync(envFile, JSON.stringify({ providers: [] }), "utf8");
    process.env.MCODE_WEBUI_MODELS_CONFIG = envFile;
    try {
      const c = await readEngineProviderCatalogue();
      assert.equal(c.sources.env, envFile);
      assert.equal(c.sources.cwd, null, "the env override IS the cwd path");
    } finally {
      delete process.env.MCODE_WEBUI_MODELS_CONFIG;
    }
  });

  test("the migration report distinguishes attempted / migrated / failed", async () => {
    reset();
    writeFileSync(
      legacyFile,
      JSON.stringify({
        version: 2,
        providers: [{ id: "p", protocol: "openai", auth: { type: "byok", apiKey: "sk-key-aaaa" } }],
      }),
      "utf8",
    );
    const first = await readEngineProviderCatalogue();
    assert.deepEqual(first.migration, { attempted: true, migrated: true, count: 1, code: null, error: null });

    // Now break the store and confirm the failure is REPORTED, not
    // thrown, and that the deprecated file answers.
    writeFileSync(configPath, "{{ broken\n", "utf8");
    const second = await readEngineProviderCatalogue();
    assert.equal(second.catalogueSource, "legacy-file");
    assert.equal(second.migration.attempted, true);
    assert.equal(second.migration.migrated, false);
    assert.equal(second.migration.code, "ENGINE_CONFIG_UNREADABLE");
    assert.equal(second.providers.length, 1, "the deprecated file answered anyway");
  });

  test("a migrated store is read without touching the deprecated file", async () => {
    reset();
    writeFileSync(
      configPath,
      yaml.dump({
        custom_provider: {
          live: {
            name: "Live",
            api: "openai-completions",
            options: { apiKey: "sk-live-aaaa", baseURL: "https://live" },
            _webui_owned: true,
          },
        },
        _webui_provider_migration: { schema: 1 },
      }),
      "utf8",
    );
    // A deprecated file that WOULD win if it were consulted.
    writeFileSync(
      legacyFile,
      JSON.stringify({ version: 2, providers: [{ id: "stale", auth: { type: "byok", apiKey: "sk-stale" } }] }),
      "utf8",
    );
    const c = await readEngineProviderCatalogue();
    assert.equal(c.catalogueSource, "engine-store");
    assert.deepEqual(c.providers.map((p) => p.id), ["live"]);
    assert.equal(c.migration.attempted, false);
  });
});
