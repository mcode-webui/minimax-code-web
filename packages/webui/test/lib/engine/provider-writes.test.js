// webui/test/lib/engine/provider-writes.test.js
//
// M3-B11 (= plan item A5), the write half: #63 PUT /api/providers and
// #66 POST /api/providers/preset/:id/enable, through
// `server/engine/provider-writes.js`.
//
// Two things are pinned here and neither has a pre-B11 equivalent:
//
//   1. PUT ATOMICITY. The old arrangement wrote `providers.json` and
//      then `config.yaml`, with nothing between them. A failure in the
//      second left the first committed, answered 200 with a warning,
//      and left the operator's next edit computed from a file the
//      engine had never seen. There is one file and one rename now, so
//      the interesting assertions are the negative ones: a refused
//      write changes NOTHING, and two concurrent writes leave one whole
//      state rather than a mixture.
//   2. THE HARD GATE. Both endpoints gate on `authCredentials` before
//      any write, and a provider that denies the sub-item gets the
//      shared 501 — because the catalogue the operator is about to see
//      is read by the engine, and a 200 that did not land would be the
//      fake success the gate exists to prevent.
//
// Isolation: both data dirs are per-run tmp, pinned before any import.

import { test, describe, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

import { mkTmpDir } from "../../helpers/tmp.js";

const tmpBase = mkTmpDir("minimax-code-engine-writes-");
const engineDir = join(tmpBase, "engine");
const webuiDir = join(tmpBase, "webui");
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
  PROVIDER_WRITE_ENDPOINTS,
  assertProviderWriteCapability,
  commitProviderCatalogueWrite,
  planProviderCatalogueWrite,
  resolveProviderWriteProvider,
} = await import("../../../server/engine/provider-writes.js");
const { getEngineProvider, LOCAL_RUNTIME_V2_CAPABILITIES } = await import(
  "../../../server/engine/index.js"
);
const { EngineCapabilityNotSupportedError } = await import("../../../server/engine/errors.js");
const { assertEngineCapability } = await import("../../../server/engine/capabilities.js");
const { normaliseProvider } = await import("../../../server/lib/providers-config.js");

function rec(raw) {
  const n = normaliseProvider(raw);
  assert.equal(n.ok, true, `fixture must normalise: ${n.error}`);
  return n.value;
}

const A = { id: "a", label: "A", protocol: "openai", auth: { type: "byok", apiKey: "sk-key-aaaa", baseURL: "https://a" }, models: [] };
const B = { id: "b", label: "B", protocol: "openai", auth: { type: "byok", apiKey: "sk-key-bbbb", baseURL: "https://b" }, models: [] };

/**
 * The parsed store document, or null when the file is absent.
 *
 * @param {string} [at]  Defaults to the file-level store path. A test
 *        that points `MINIMAX_DATA_DIR` somewhere else passes the
 *        resolved path explicitly, so the assertion reads the file the
 *        write actually produced rather than the default one.
 * @returns {object|null}
 */
function storeDoc(at = configPath) {
  if (!existsSync(at)) return null;
  return yaml.load(readFileSync(at, "utf8"));
}

/**
 * The webui records the store holds, in key order.
 *
 * @param {string} [at]
 * @returns {object[]}
 */
function storeRecords(at = configPath) {
  const doc = storeDoc(at);
  if (!doc) return [];
  return Object.values(doc.custom_provider || {})
    .map((e) => e && e._webui_provider)
    .filter(Boolean);
}

before(() => {
  mkdirSync(engineDir, { recursive: true });
  mkdirSync(webuiDir, { recursive: true });
});

after(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  if (existsSync(configPath)) rmSync(configPath, { recursive: true, force: true });
});

// =====================================================================
// The gate table
// =====================================================================

describe("PROVIDER_WRITE_ENDPOINTS — the family is the five-endpoint one", () => {
  test("exactly #63 and #66, both hard, both on authCredentials", () => {
    assert.deepEqual(Object.keys(PROVIDER_WRITE_ENDPOINTS).sort(), [
      "POST /api/providers/preset/:id/enable",
      "PUT /api/providers",
    ]);
    for (const [endpoint, need] of Object.entries(PROVIDER_WRITE_ENDPOINTS)) {
      assert.equal(need.capability, "authCredentials", endpoint);
      assert.equal(need.enforcement, "hard", endpoint);
    }
    assert.equal(PROVIDER_WRITE_ENDPOINTS["PUT /api/providers"].subItem, "updateUserModelProvider");
    assert.equal(PROVIDER_WRITE_ENDPOINTS["POST /api/providers/preset/:id/enable"].subItem, "createUserModelProvider");
  });

  test("an endpoint outside the family is a caller bug, not an engine limitation", () => {
    // A plain Error, so a typo in webui's own key can never reach an
    // operator as "the engine cannot do this".
    assert.throws(
      () => assertProviderWriteCapability("GET /api/providers", "runtime"),
      (e) => e.code === "unknown_provider_write_endpoint" && !(e instanceof EngineCapabilityNotSupportedError),
    );
  });
});

describe("assertProviderWriteCapability — HARD", () => {
  test("the declared provider passes and reports which provider answered", () => {
    const r = assertProviderWriteCapability("PUT /api/providers", "runtime");
    assert.equal(r.gate, "checked");
    assert.equal(r.provider, "local-runtime-v2");
    assert.equal(r.enforcement, "hard");
  });

  test("an unregistered transport is NOT a 501 — it lets the write proceed", () => {
    // The transport table is empty until M4. A 501 that meant "nobody
    // has written M4 yet" would be a lie about the engine, and every
    // other family in this migration draws the same line.
    for (const transport of ["acp", "exec", "anything-else"]) {
      const r = assertProviderWriteCapability("PUT /api/providers", transport);
      assert.equal(r.gate, "unregistered-transport");
      assert.equal(r.provider, null);
    }
  });

  test("a provider denying the sub-item gets the shared 501 error", () => {
    // `authCredentials` is partial today (missing setConfigOption), so
    // a gate on any OTHER sub-item passes. Making the write's own
    // sub-item the missing one must throw the shared error the router
    // maps — same shape B9 established.
    const original = LOCAL_RUNTIME_V2_CAPABILITIES.authCredentials;
    try {
      const denied = {
        ...LOCAL_RUNTIME_V2_CAPABILITIES,
        authCredentials: {
          ...original,
          missing: [...original.missing, "updateUserModelProvider"],
        },
      };
      // The negative is driven through the same `assertEngineCapability`
      // the real gate calls, rather than by re-implementing the check
      // here — a hand-rolled copy is exactly what would let the two
      // drift.
      assert.throws(
        () => assertEngineCapability(denied, "authCredentials", "fake-provider", "updateUserModelProvider"),
        (e) => {
          assert.equal(e.name, "EngineCapabilityNotSupportedError");
          assert.equal(e.capability, "authCredentials");
          assert.deepEqual(e.missing, ["updateUserModelProvider"]);
          return true;
        },
      );
    } finally {
      void original;
    }
  });

  test("a `none` declaration denies every sub-item of the key", () => {
    const none = {
      ...LOCAL_RUNTIME_V2_CAPABILITIES,
      authCredentials: { level: "none", reason: "no credential surface" },
    };
    assert.throws(
      () => assertEngineCapability(none, "authCredentials", "p", "updateUserModelProvider"),
      (e) => e.name === "EngineCapabilityNotSupportedError",
    );
  });
});


// =====================================================================
// The keep-key convention, scoped to the store
// =====================================================================

describe("planProviderCatalogueWrite — pure, and scoped to the store", () => {
  test("an empty or absent apiKey takes the stored one", () => {
    const existing = [rec({ ...A, auth: { ...A.auth, apiKey: "sk-stored-aaaa" } })];
    for (const auth of [{ type: "byok", apiKey: "" }, { type: "byok" }]) {
      const out = planProviderCatalogueWrite([{ id: "a", auth }], existing);
      assert.equal(out[0].auth.apiKey, "sk-stored-aaaa");
    }
  });

  test("a non-empty apiKey replaces it", () => {
    const existing = [rec({ ...A, auth: { ...A.auth, apiKey: "sk-stored-aaaa" } })];
    const out = planProviderCatalogueWrite([{ id: "a", auth: { type: "byok", apiKey: "sk-new-bbbb" } }], existing);
    assert.equal(out[0].auth.apiKey, "sk-new-bbbb");
  });

  test("a NEW provider with a sentinel key stays empty", () => {
    const out = planProviderCatalogueWrite([{ id: "brand-new", auth: { type: "byok", apiKey: "" } }], []);
    assert.equal(out[0].auth.apiKey, "");
  });

  test("the input is not mutated", () => {
    const incoming = [{ id: "a", auth: { type: "byok", apiKey: "" } }];
    planProviderCatalogueWrite(incoming, [rec(A)]);
    assert.equal(incoming[0].auth.apiKey, "", "the caller's body is untouched");
  });
});

// =====================================================================
// The commit
// =====================================================================

describe("commitProviderCatalogueWrite — one document, one rename", () => {
  test("a successful commit persists the records in order and stamps the marker", async () => {
    const r = await commitProviderCatalogueWrite({ records: [rec(A), rec(B)] });
    assert.equal(r.ok, true);
    assert.equal(r.written, true);
    assert.deepEqual(r.keys, ["a", "b"]);
    assert.deepEqual(r.records.map((x) => x.id), ["a", "b"]);
    assert.deepEqual(storeRecords().map((x) => x.id), ["a", "b"]);
    assert.ok(storeDoc()._webui_provider_migration, "the marker rides the same write");
  });

  test("a second commit REPLACES the catalogue — there is no patch semantics", async () => {
    await commitProviderCatalogueWrite({ records: [rec(A), rec(B)] });
    const r = await commitProviderCatalogueWrite({ records: [rec(B)] });
    assert.equal(r.ok, true);
    assert.deepEqual(storeRecords().map((x) => x.id), ["b"], "a is gone: the body is the whole catalogue");
  });

  test("an unreadable store is refused and the document is left byte-identical", async () => {
    const broken = "custom_provider:\\n  - [unbalanced\\n";
    writeFileSync(configPath, broken, "utf8");
    const r = await commitProviderCatalogueWrite({ records: [rec(A)] });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ENGINE_STORE_UNREADABLE");
    assert.equal(readFileSync(configPath, "utf8"), broken);
  });

  test("a foreign engine entry survives a commit", async () => {
    writeFileSync(
      configPath,
      yaml.dump({ custom_provider: { manual: { name: "Mine", options: { apiKey: "sk-op" } } } }),
      "utf8",
    );
    const r = await commitProviderCatalogueWrite({ records: [rec(A)] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.preserved, ["manual"]);
    assert.deepEqual(storeDoc().custom_provider.manual, { name: "Mine", options: { apiKey: "sk-op" } });
  });

  test("an operator's other engine sections survive a commit", async () => {
    const seed = { provider: { minimax: { models: { "MiniMax-M3": {} } } }, defaultModel: "m:minimax:MiniMax-M3:u" };
    writeFileSync(configPath, yaml.dump(seed), "utf8");
    const r = await commitProviderCatalogueWrite({ records: [rec(A)] });
    assert.equal(r.ok, true);
    const doc = storeDoc();
    assert.deepEqual(doc.provider, seed.provider);
    assert.equal(doc.defaultModel, seed.defaultModel);
  });
});

// =====================================================================
// The path the write lands on — the security surface
// =====================================================================

describe("the write path is the same path the read resolves", () => {
  // The store is written with mode 0600 through a tmp file and a
  // rename, and it carries every plaintext apiKey in the catalogue. So
  // "which file did that land in" is a security question, not a
  // cosmetic one: a write that resolved its path differently from the
  // read would put the keys in a file the catalogue never looks at —
  // invisible, not deletable by the next PUT, and still on disk.
  //
  // The two sides must agree by CONSTRUCTION: there is one resolver,
  // `getEngineConfigPath()`, and both call it. These tests pin that
  // agreement rather than the implementation, and the symlink is the
  // case where a future "helpful" normalisation could split them.

  test("read and write name the same file, through a symlinked data dir", async () => {
    // `resolveEngineDataDir` returns the env value verbatim and no
    // getcwd/realpath is involved, so both sides must use the literal
    // and the bytes must land in the REAL file. The assertion is on the
    // result, not on the string.
    const realDir = join(tmpBase, "engine-symlink-target");
    const alias = join(tmpBase, "engine-symlink-alias");
    mkdirSync(realDir, { recursive: true });
    rmSync(alias, { force: true, recursive: true });
    symlinkSync(realDir, alias);

    const before = process.env.MINIMAX_DATA_DIR;
    process.env.MINIMAX_DATA_DIR = alias;
    try {
      const w = await commitProviderCatalogueWrite({ records: [rec(A)] });
      assert.equal(w.ok, true);
      assert.equal(existsSync(join(realDir, "config.yaml")), true, "the write landed in the real file");
      assert.deepEqual(
        storeRecords(join(realDir, "config.yaml")).map((r) => r.id),
        ["a"],
        "and the read finds them there",
      );
      // No stray document or leftover tmp file beside the symlink: a
      // key must not be able to end up in a file the store never reads.
      const stray = readdirSync(tmpBase).filter(
        (f) => f === "config.yaml" || f.startsWith(".config-tmp-"),
      );
      assert.deepEqual(stray, [], "no document written beside the symlink");
    } finally {
      if (before === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = before;
      rmSync(alias, { force: true });
    }
  });

  test("the file the write creates is 0600 even when reached through a symlink", async () => {
    // The permission must not depend on how the operator spelled the
    // path. POSIX mode bits travel with the file across a rename, and
    // the tmp file is created 0600 before it is renamed, so the
    // symlinked route lands in exactly the same mode.
    const realDir = join(tmpBase, "engine-mode-target");
    const alias = join(tmpBase, "engine-mode-alias");
    mkdirSync(realDir, { recursive: true });
    rmSync(alias, { force: true, recursive: true });
    symlinkSync(realDir, alias);

    const before = process.env.MINIMAX_DATA_DIR;
    process.env.MINIMAX_DATA_DIR = alias;
    try {
      const r = await commitProviderCatalogueWrite({ records: [rec(A)] });
      assert.equal(r.ok, true);
      const mode = statSync(join(realDir, "config.yaml")).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600 through the symlinked dir, got ${mode.toString(8)}`);
    } finally {
      if (before === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = before;
      rmSync(alias, { force: true });
    }
  });
});

// =====================================================================
// DEATH LINE — PUT atomicity
// =====================================================================

describe("PUT atomicity — no state in which the store is half a catalogue", () => {
  test("a REFUSED write leaves the previous catalogue exactly as it was", async () => {
    await commitProviderCatalogueWrite({ records: [rec(A), rec(B)] });
    const before = readFileSync(configPath, "utf8");

    // The write that cannot land: the store became unparseable between
    // two reads. The refusal is the point — the previous document is
    // still the whole truth, so a client's next GET returns the
    // catalogue it already had.
    writeFileSync(configPath, "{{{ broken\n", "utf8");
    const broken = readFileSync(configPath, "utf8");
    const refused = await commitProviderCatalogueWrite({ records: [rec({ ...A, label: "CHANGED" })] });
    assert.equal(refused.ok, false);
    assert.equal(readFileSync(configPath, "utf8"), broken, "not one byte of the refusal touched the file");

    // And the store still answers with the pre-write catalogue once
    // the document is readable again.
    writeFileSync(configPath, before, "utf8");
    const { readProviderStore } = await import("../../../server/engine/provider-store.js");
    const s = readProviderStore({ configPath });
    assert.deepEqual(s.records.map((x) => x.label), ["A", "B"], "no field of the refused write survived");
  });

  test("a FAILED write leaves the previous catalogue exactly as it was", async () => {
    await commitProviderCatalogueWrite({ records: [rec(A), rec(B)] });
    const before = readFileSync(configPath, "utf8");
    // A post-read I/O failure: the target's parent is a regular file,
    // so the tmp write fails with ENOTDIR after the plan was built.
    const blocked = join(engineDir, "sub", "config.yaml");
    writeFileSync(join(engineDir, "sub"), "x", "utf8");
    const failed = await commitProviderCatalogueWrite({ configPath: blocked, records: [rec({ ...A, label: "CHANGED" })] });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "ENGINE_STORE_WRITE_FAILED");
    assert.equal(readFileSync(configPath, "utf8"), before, "the real store is untouched");
    rmSync(join(engineDir, "sub"), { force: true });
  });

  test("concurrent commits leave ONE WHOLE state, never a mixture", async () => {
    // The classic torn-write shape: provider a from one body and
    // provider b from the other. With a single rename per write that
    // cannot be constructed — a reader sees one document or the other.
    const bodyA = [rec(A), rec(B)];
    const bodyB = [rec(B), rec({ ...A, label: "A2" })];
    const results = await Promise.all([
      commitProviderCatalogueWrite({ records: bodyA }),
      commitProviderCatalogueWrite({ records: bodyB }),
    ]);
    assert.ok(results.every((r) => r.ok));
    const after = storeRecords();
    // Whichever landed, the result is one of the two BODIES — never a
    // per-provider mix.
    const matchesA =
      after.length === 2 && after[0].id === "a" && after[0].label === "A" && after[1].id === "b";
    const matchesB =
      after.length === 2 && after[0].id === "b" && after[1].id === "a" && after[1].label === "A2";
    assert.ok(matchesA || matchesB, `store is a mixture: ${JSON.stringify(after.map((x) => [x.id, x.label]))}`);
    // And it parses: a torn YAML document could not be read at all.
    assert.ok(storeDoc()._webui_provider_migration, "the winner is a complete document");
  });

  test("an interleaved read never sees a partial document", async () => {
    await commitProviderCatalogueWrite({ records: [rec(A)] });
    const { readProviderStore } = await import("../../../server/engine/provider-store.js");
    const writes = [];
    for (let i = 0; i < 5; i++) {
      writes.push(commitProviderCatalogueWrite({ records: [rec({ ...A, label: `A${i}` })] }));
    }
    writes.push(Promise.resolve().then(() => readProviderStore({ configPath })));
    const [, , , , , read] = await Promise.all(writes);
    assert.equal(read.ok, true, "a concurrent reader always gets a parseable document");
  });
});
