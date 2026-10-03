// webui/server/engine/provider-store.js
//
// Migration step M3, batch B11 (= plan item A5): the SINGLE provider
// store. This module replaces `lib/engine-provider-sync.js` and deletes
// the dual-source arrangement it used to paper over.
//
// ---------------------------------------------------------------------
// What A5 actually was, and what this file is
// ---------------------------------------------------------------------
//
//   Before this batch webui kept TWO files describing the same thing:
//
//     1. `<webuiDataDir>/providers.json`   — the webui v2 catalogue.
//        Ordered, list-shaped, lossless (it holds `preset`, `enabled`,
//        the gemini/openai protocol distinction and `coding-plan`
//        auth, none of which the engine shape can express).
//     2. `<engineDataDir>/config.yaml`     — the engine's own
//        `custom_provider` tree. A DERIVED projection, written by
//        `lib/engine-provider-sync.js` on every PUT, carrying
//        `_webui_owned` markers so the merge could tell "webui wrote
//        this" from "an operator typed this in by hand".
//
//   The projection was lossy in both directions, and the loss was
//   invisible precisely because nothing read the lossy side back:
//   `enabled: false`, `auth.type: "coding-plan"`, `preset` and the
//   gemini-vs-openai protocol distinction were dropped on the way to
//   the engine and never came back; the ordering of the catalogue came
//   from the file that was about to stop being authoritative.
//
//   After this batch there is ONE authority for webui-managed
//   providers — the engine's `custom_provider` tree — and each
//   webui-managed entry carries the webui v2 record alongside its
//   engine fields, so the consolidation costs the schema nothing:
//
//     custom_provider:
//       my-gateway:
//         name: My Gateway
//         kind: custom
//         enabled: true
//         api: openai-completions
//         options: { apiKey, baseURL, authMode, headers? }
//         models: { glm-5.3: { limit, thinking, modalities } }
//         _webui_owned: true          ← ownership marker (unchanged)
//         _webui_provider: { … }      ← the lossless v2 record (new)
//
//   The engine ignores both marker fields: it parses `config.yaml`
//   through js-yaml with no schema rejection and its consumers read
//   named fields (`packages/config/src/byok-config.ts`). That is the
//   same argument `_webui_owned` already made, and it is why the
//   engine's own writer (`updateLocalByokConfig`) can be pointed at
//   this file later without a migration of its own.
//
// ---------------------------------------------------------------------
// The migration, and why it can never lose data
// ---------------------------------------------------------------------
//
//   `<webuiDataDir>/providers.json` is DEPRECATED, not deleted. It is
//   read exactly once per process — by the one-shot migration — and
//   only while the store carries no migration marker. The marker
//   (`_webui_provider_migration` at the top level of `config.yaml`) is
//   what closes the file for good, and it is a top-level marker rather
//   than an inference ("the tree has webui entries") for one concrete
//   reason: a user who DELETES every provider through the UI leaves a
//   tree with no webui entries, and an inferred marker would make the
//   stale legacy file authoritative again — resurrecting providers the
//   operator had just removed.
//
//   The failure path is the other half of the contract. Every step of
//   the migration is a pure plan followed by ONE atomic `tmp + rename`
//   of the whole `config.yaml`; if any of them fails the file is not
//   touched and the marker is not written, so the next read falls back
//   to the legacy file in its original format. There is no state in
//   which the legacy file has been half-consumed.
//
// ---------------------------------------------------------------------
// What the route must still own
// ---------------------------------------------------------------------
//
//   Body parsing, HTTP statuses, masking, the `providers.updated` SSE
//   broadcast and the response shapes all stay in
//   `routes/providers.js`. This module answers three questions only:
//   what the catalogue is (`readProviderStore`), what the next write
//   should look like (`buildProviderStoreWrite`, pure), and how the
//   write lands (`commitProviderStoreWrite`, one atomic rename).

import { writeFile, rename, mkdir, chmod, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { randomBytes } from "node:crypto";

import { getUserLevelPath, normaliseProvider } from "../lib/providers-config.js";

// =====================================================================
// Markers
// =====================================================================

/**
 * Ownership marker. Every entry the webui writes carries
 * `_webui_owned: true`; an operator who adds a provider through the
 * engine CLI (`mcode provider add`) does not, and the two ownerships
 * are told apart by this field alone. Unchanged from the module this
 * file replaces — renaming it would orphan every operator-managed
 * entry on the next write.
 *
 * @type {string}
 */
export const WEBUI_OWNED_MARKER = "_webui_owned";

/**
 * The webui v2 record, embedded on every webui-owned entry. THIS is
 * what makes the storage consolidation lossless: the engine fields
 * beside it are the projection the runtime consumes, and this one is
 * the record the catalogue API serialises. A provider the projection
 * cannot express (disabled, coding-plan, a gemini endpoint) is still
 * fully present here, so merging the two sources into one file drops
 * nothing that either source used to hold.
 *
 * @type {string}
 */
export const WEBUI_PROVIDER_MARKER = "_webui_provider";

/**
 * Top-level marker meaning "the legacy `providers.json` has been
 * folded in; do not read it again". Absent means the opposite. See
 * the module header for why this cannot be inferred from the tree.
 *
 * @type {string}
 */
export const PROVIDER_STORE_MIGRATION_MARKER = "_webui_provider_migration";

/** Schema version of the migration marker itself. */
export const PROVIDER_STORE_MIGRATION_SCHEMA = 1;

// =====================================================================
// Engine location
// =====================================================================

/**
 * Resolve the engine's data directory.
 *
 * The engine resolves its own data dir via `packages/config/src/config.ts`:
 *   MINIMAX_DATA_DIR || MAVIS_DATA_DIR || ~/.minimax
 * Mirrored verbatim so a webui-managed write lands in the directory
 * the engine subprocess reads on next spawn. Read at CALL time, never
 * at module scope, so a test (or a deployment) can point it elsewhere
 * between two operations.
 *
 * @returns {string}
 */
export function resolveEngineDataDir() {
  const env = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim() || "";
  if (env) return env;
  return join(homedir(), ".minimax");
}

/**
 * The engine config file this store lives in. The single source for
 * the path — `lib/engine-catalogue.js` reads the engine's BUILTIN
 * provider tree from the same file and used to import it from
 * `lib/engine-provider-sync.js`.
 *
 * @returns {string}
 */
export function getEngineConfigPath() {
  return join(resolveEngineDataDir(), "config.yaml");
}

// =====================================================================
// Pure projection: webui v2 record → engine custom_provider entry
// =====================================================================

// engine provider api formats — must match `MODEL_PROVIDER_APIS` in
// packages/local-runtime-v2/src/service/model-system/identity.ts (the
// engine rejects anything outside this set at `normalizeApiFormat`).
const WEBUI_PROTOCOL_TO_ENGINE_API = {
  openai: "openai-completions",
  anthropic: "anthropic-messages",
  // gemini has no engine-native api; the OpenAI-compat endpoint is the
  // usual `byok` target. Engine does not have a Gemini-specific format.
  gemini: "openai-completions",
};

// Reserved engine keys — must NOT collide with the existing engine's
// internal provider ids (which would either shadow `minimax` or land in
// `RESERVED_CUSTOM_PROVIDER_KEYS` and be dropped). Mirrored from
// packages/config/src/byok-config.ts.
const RESERVED_ENGINE_KEYS = new Set(["minimax", "minimax_api", "provider", "custom_provider"]);

const PROVIDER_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Pure: a webui v2 id → an engine-safe provider key. "" when the id
 * cannot be expressed as one.
 *
 * @param {string} id
 * @returns {string}
 */
export function providerKeyFromId(id) {
  const trimmed = (id || "").trim();
  if (!trimmed) return "";
  if (!PROVIDER_KEY_REGEX.test(trimmed)) return "";
  if (RESERVED_ENGINE_KEYS.has(trimmed)) {
    return `${trimmed}-byok`;
  }
  return trimmed;
}

/**
 * Pure: webui model id → engine-safe model key.
 *
 * The engine accepts `/` inside model keys: the wire form
 * `formatModelKey(<providerId>, <modelId>)` uses `/` only as the
 * *structural* separator, and `parseSourceQualifiedModelKey` splits on
 * the FIRST one, so `deepseek/x` survives as a single string. Upstream
 * catalogues carry namespace-style ids like `z-ai/glm-5.3`, and
 * rejecting them here dropped those models from the engine sync.
 *
 * Everything else the engine's YAML parser or custom_provider lookup
 * would choke on (whitespace, control codes, YAML structural tokens) is
 * still rejected, so the store never lands an unparseable entry.
 *
 * @param {string} id
 * @returns {string}
 */
export function modelKeyFromId(id) {
  const trimmed = (id || "").trim();
  if (!trimmed) return "";
  if (/[\s:#{}\[\]@&*!|>'"%`,]/.test(trimmed)) return "";
  // Must not start with `-` (YAML list) or `&` / `*` (anchors).
  if (/^[-&*]/.test(trimmed)) return "";
  return trimmed;
}

/**
 * Pure: a normalised v2 record → the engine's own field set, or `{}` when the
 * record is ineligible for the engine projection.
 *
 * Ineligible, and each for a reason the engine states itself:
 *   - `auth.type === "coding-plan"` — the engine runs coding plans
 *     through its own OAuth / Codex / Claude Code flows, which are
 *     outside the byok projection;
 *   - `enabled: false` — an operator who switched a provider off must
 *     not see it advertised by `listByokRuntimeModels`;
 *   - an empty apiKey or an empty baseURL — the engine's
 *     `createUserProvider` rejects a key-less entry, and with no
 *     baseURL there is nothing to call;
 *   - a protocol outside the map, or an id that is not a legal engine
 *     key even after the reserved-key rewrite.
 *
 * Ineligibility is a statement about the ENGINE view only. The record
 * itself is preserved in full on the entry (see WEBUI_PROVIDER_MARKER),
 * which is why one of these costs the catalogue nothing.
 *
 * Emptiness, not truthiness, on the headers: `normaliseProvider` always
 * materialises `auth.headers` (absent → {}), and `{}` is TRUTHY, so a
 * truthiness test emits `headers: {}` for every provider that never
 * configured one. The runtime merges `options.headers` into every
 * upstream request (`local-runtime-v2/.../catalog/provider-views.ts` →
 * `mergeProviderHeaders`), so an empty map is noise, not signal.
 *
 * @param {object} record  A normalised webui v2 provider record.
 * @returns {object} Engine fields, or `{}` when ineligible.
 */
export function projectRecordToEngine(record) {
  if (!record || typeof record !== "object") return {};
  if (record.auth && record.auth.type === "coding-plan") return {};
  if (record.enabled === false) return {};
  const apiKey = typeof record.auth?.apiKey === "string" ? record.auth.apiKey.trim() : "";
  const baseURL = typeof record.auth?.baseURL === "string" ? record.auth.baseURL.trim() : "";
  if (!apiKey || !baseURL) return {};
  const api = WEBUI_PROTOCOL_TO_ENGINE_API[(record.protocol || "openai").trim()];
  if (!api) return {};
  const key = providerKeyFromId(record.id);
  if (!key) return {};
  const customHeaders =
    record.auth?.headers && typeof record.auth.headers === "object" && Object.keys(record.auth.headers).length > 0
      ? { ...record.auth.headers }
      : null;
  const name =
    typeof record.label === "string" && record.label.trim() ? record.label.trim() : key;
  const models = {};
  for (const m of record.models || []) {
    const modelKey = modelKeyFromId(m.id);
    if (!modelKey) continue;
    const engineModel = {};
    if (typeof m.label === "string" && m.label.trim() && m.label.trim() !== modelKey) {
      engineModel.name = m.label.trim();
    }
    if (typeof m.contextLimit === "number" && m.contextLimit > 0) {
      engineModel.limit = { context: m.contextLimit };
    }
    if (Array.isArray(m.thinkingLevels) && m.thinkingLevels.length > 0) {
      engineModel.thinking = { effortOptions: [...m.thinkingLevels] };
    }
    if (Array.isArray(m.modalities) && m.modalities.length > 0) {
      engineModel.modalities = { input: [...m.modalities] };
    }
    models[modelKey] = engineModel;
  }
  return {
    name,
    kind: "custom",
    enabled: true,
    api,
    options: {
      apiKey,
      baseURL,
      authMode: "api-key",
      ...(customHeaders ? { headers: customHeaders } : {}),
    },
    ...(Object.keys(models).length > 0 ? { models } : {}),
  };
}

// =====================================================================
// Pure projection (reverse): engine entry → webui v2 record
// =====================================================================

/**
 * Pure: engine api format → the webui protocol that maps onto it.
 * The map is many-to-one in the forward direction (gemini and openai
 * both project to `openai-completions`), so a record reconstructed
 * from engine fields ALONE can only be as precise as that map allows:
 * `openai-completions` reads back as `openai`. The forward record on
 * the entry is what preserves the distinction; this reverse map is the
 * fallback for entries written before the record marker existed, and
 * the module header's "lossless" claim is scoped to records this
 * batch writes, not to engine files authored by hand.
 *
 * @param {string} api
 * @returns {string}
 */
export function protocolFromEngineApi(api) {
  if (api === "anthropic-messages") return "anthropic";
  return "openai";
}

/**
 * Pure: one engine `custom_provider` entry → a normalised webui v2
 * record, or `null` when the entry is not webui-managed.
 *
 * Two paths, in order:
 *   1. `_webui_provider` — the record written alongside the entry.
 *      Exact, and the only path that can express a disabled provider,
 *      a coding-plan auth, a `preset`, or the gemini protocol.
 *   2. Reconstruction from the engine fields, for entries the
 *      pre-B11 double-write left behind. Lossy by the map above; it
 *      exists so an operator who has been running the webui since
 *      ticket 05 does not come back to an empty catalogue.
 *
 * The returned record is re-normalised on the way out, so a
 * hand-edited or stale `_webui_provider` cannot put a malformed
 * record on the wire.
 *
 * @param {string} key
 * @param {object} entry
 * @returns {object|null} A normalised v2 provider record.
 */
export function recordFromEngineEntry(key, entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry[WEBUI_OWNED_MARKER] !== true) return null;
  const embedded = entry[WEBUI_PROVIDER_MARKER];
  if (embedded && typeof embedded === "object") {
    const norm = normaliseProvider(embedded);
    if (norm.ok) return norm.value;
  }
  const reconstructed = reconstructRecord(key, entry);
  if (!reconstructed) return null;
  const norm = normaliseProvider(reconstructed);
  return norm.ok ? norm.value : null;
}

/**
 * Pure: reconstruct a v2 record from an entry's engine fields.
 *
 * The three things a reconstruction cannot know are read off the
 * entry in the only honest way available: a `name` equal to the key
 * is the projection's own fallback for an empty label, so the
 * reconstructed label is the key; models that carried no
 * `thinking.effortOptions` / `modalities.input` had none; and the
 * protocol is whatever the api format maps back to.
 *
 * @param {string} key
 * @param {object} entry
 * @returns {object|null}
 */
function reconstructRecord(key, entry) {
  const options = entry.options && typeof entry.options === "object" ? entry.options : {};
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : "";
  if (!apiKey) return null;
  const models = [];
  for (const [modelKey, model] of Object.entries(entry.models || {})) {
    if (!model || typeof model !== "object") continue;
    models.push({
      id: modelKey,
      label: typeof model.name === "string" && model.name ? model.name : modelKey,
      ...(model.limit && typeof model.limit.context === "number" && model.limit.context > 0
        ? { contextLimit: model.limit.context }
        : {}),
      ...(model.thinking && Array.isArray(model.thinking.effortOptions) &&
      model.thinking.effortOptions.length > 0
        ? { thinkingLevels: [...model.thinking.effortOptions] }
        : {}),
      ...(model.modalities && Array.isArray(model.modalities.input) &&
      model.modalities.input.length > 0
        ? { modalities: [...model.modalities.input] }
        : {}),
    });
  }
  return {
    id: key,
    label: typeof entry.name === "string" && entry.name ? entry.name : key,
    enabled: entry.enabled !== false,
    protocol: protocolFromEngineApi(entry.api),
    auth: {
      type: "byok",
      apiKey,
      baseURL: typeof options.baseURL === "string" ? options.baseURL : "",
      headers: { ...(options.headers || {}) },
    },
    models,
  };
}

// =====================================================================
// Store read
// =====================================================================

/**
 * Read the engine config file. Returns the raw document, or `null`
 * when the file does not exist, or `null` with `unreadable: true`
 * when it exists but does not parse.
 *
 * A missing file is not an error — the writer creates it. An
 * unparseable one IS, and the caller must not overwrite it: the
 * operator's own section would be lost to a `{}` rewrite.
 *
 * @param {string} configPath
 * @returns {{ok: true, raw: object, exists: boolean}|{ok: false, code: string, error: string}}
 */
export function readEngineConfigRaw(configPath) {
  if (!existsSync(configPath)) return { ok: true, raw: {}, exists: false };
  let parsed;
  try {
    parsed = yaml.load(readFileSync(configPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      code: "ENGINE_CONFIG_UNREADABLE",
      error: e && e.message ? e.message : String(e),
    };
  }
  if (parsed === null || parsed === undefined) return { ok: true, raw: {}, exists: true };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "ENGINE_CONFIG_UNREADABLE",
      error: "engine config is not a YAML mapping",
    };
  }
  return { ok: true, raw: parsed, exists: true };
}

/**
 * Read the provider store.
 *
 * Returns the webui-managed records in store order (the order they
 * were written, which is the order the catalogue API has always
 * returned them in), whether the legacy file is still open, and — when
 * it is — the legacy records, so the caller can fall back without a
 * second read.
 *
 * The two authorities, and which one wins:
 *
 *   migration marker PRESENT  → the store is authoritative. The
 *     legacy file is not touched, not even stat()ed.
 *   migration marker ABSENT   → the legacy file is authoritative and
 *     the store contributes nothing. This is the pre-B11 state (a
 *     `config.yaml` written by the old double-write carries
 *     `_webui_owned` markers but no migration marker, and its
 *     projection is lossy) and the required fallback when a
 *     migration attempt failed.
 *
 * @param {{configPath?: string, legacyProviders?: object[]|null}} [opts]
 *        `legacyProviders` is injected rather than read here so this
 *        module stays free of the webui data dir; the caller reads
 *        the deprecated file (see `lib/providers-config.js`).
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   error?: string,
 *   raw: object,
 *   tree: object,
 *   records: object[],
 *   migrationDone: boolean,
 *   legacyProviders: object[]|null,
 *   configPath: string,
 * }}
 */
export function readProviderStore(opts = {}) {
  const configPath = opts.configPath || getEngineConfigPath();
  const read = readEngineConfigRaw(configPath);
  if (!read.ok) {
    return {
      ok: false,
      code: read.code,
      error: read.error,
      raw: null,
      tree: null,
      records: [],
      migrationDone: true,
      legacyProviders: opts.legacyProviders || null,
      configPath,
    };
  }
  const raw = read.raw;
  const tree =
    raw.custom_provider && typeof raw.custom_provider === "object" && !Array.isArray(raw.custom_provider)
      ? raw.custom_provider
      : {};
  const migrationDone = Boolean(raw[PROVIDER_STORE_MIGRATION_MARKER]);
  const records = migrationDone ? providerRecordsFromTree(tree) : [];
  return {
    ok: true,
    raw,
    tree,
    records,
    migrationDone,
    legacyProviders: opts.legacyProviders || null,
    configPath,
  };
}

/**
 * Pure: the webui-managed records of a `custom_provider` tree, in
 * key order. Entries the webui does not own are skipped (they are
 * never in the catalogue) and entries whose record cannot be
 * normalised are skipped rather than surfaced half-formed.
 *
 * @param {object} tree
 * @returns {object[]}
 */
export function providerRecordsFromTree(tree) {
  const out = [];
  for (const [key, entry] of Object.entries(tree || {})) {
    const record = recordFromEngineEntry(key, entry);
    if (record) out.push(record);
  }
  return out;
}

// =====================================================================
// Store write — plan (pure) then commit (one atomic rename)
// =====================================================================

/**
 * Pure: the next `custom_provider` map for a provider list.
 *
 * The ownership rule, unchanged from the double-write it replaces and
 * the reason foreign entries are safe:
 *
 *   eligible webui keys ∩ existing keys → UPDATE in place
 *   existing keys ∖ webui keys, `_webui_owned: true`   → DELETE
 *   existing keys ∖ webui keys, marker absent or false   → PRESERVE
 *   webui keys ∖ existing keys                          → ADD
 *
 * "webui keys" is every record the caller passes, NOT only the
 * projectable ones. A provider the engine cannot express still
 * occupies its key with a marker and its record and no engine fields,
 * so switching a provider off no longer removes it from the store the
 * way the old sync did.
 *
 * Order is load-bearing and deliberate: webui records come FIRST, in
 * the caller's list order, and preserved foreign entries follow. The
 * catalogue API returns that order verbatim, and the order an operator
 * sees in the dialog has always been the order they PUT.
 *
 * @param {object} existingTree  The store's current `custom_provider`.
 * @param {object[]} records     Normalised v2 records to persist.
 * @returns {{tree: object, keys: string[], preserved: string[], records: string[]}}
 */
export function buildProviderStoreWrite(existingTree, records) {
  const tree = {};
  const keys = [];
  const persisted = [];
  for (const record of records || []) {
    if (!record || typeof record !== "object") continue;
    const projected = projectRecordToEngine(record);
    // Every record gets a home. `normaliseProvider` enforces a
    // stricter id grammar than a store key needs, so an id that cannot
    // be an engine key can only arrive from a direct engine-module
    // caller — but dropping it would be the one loss this batch cannot
    // have, and the record is the whole point of the store. The
    // fallback key is derived from the index, which is stable for a
    // given list order, and an id that DOES map gets its real key.
    const storeKey = providerKeyFromId(record.id) || `p${keys.length}`;
    delete tree[storeKey];
    tree[storeKey] = {
      ...projected,
      [WEBUI_OWNED_MARKER]: true,
      [WEBUI_PROVIDER_MARKER]: normaliseRecordForStore(record),
    };
    keys.push(storeKey);
    persisted.push(record.id);
  }
  for (const [key, entry] of Object.entries(existingTree || {})) {
    if (!entry || typeof entry !== "object") continue;
    if (entry[WEBUI_OWNED_MARKER] === true) continue; // owned and no longer listed → deleted
    if (Object.prototype.hasOwnProperty.call(tree, key)) continue; // already re-added as a record
    tree[key] = entry;
  }
  const preserved = Object.keys(tree).filter(
    (k) => tree[k][WEBUI_OWNED_MARKER] !== true,
  );
  return { tree, keys, preserved, records: persisted };
}

/**
 * Pure: normalise a record for embedding. Returns `null` rather than
 * throwing for a record the schema rejects — the caller is mid-write
 * and the alternative to a null record is a lost provider.
 *
 * @param {object} record
 * @returns {object|null}
 */
function normaliseRecordForStore(record) {
  const norm = normaliseProvider(record);
  return norm.ok ? norm.value : null;
}

/**
 * Commit a store write: ONE atomic `tmp + rename` of the whole
 * `config.yaml`, mode 0600.
 *
 * Atomicity is the whole point of this function, and it is
 * structural rather than best-effort: the previous arrangement wrote
 * `providers.json` first and `config.yaml` second, so a failure in
 * between left the two files disagreeing and a retry could not tell
 * which one the operator was looking at. Here there is one file and
 * one rename, so a failed write leaves the previous document exactly
 * as it was — a reader either sees the old catalogue or the new one,
 * never a mixture, and never a truncated YAML document.
 *
 * Mode 0600 because the document carries plaintext apiKeys; the
 * engine's own `updateLocalByokConfig` does the same
 * (`packages/config/src/local-model-provider-write.ts`).
 *
 * @param {object} options
 * @param {string} options.configPath
 * @param {object} options.raw  The document read before planning.
 * @param {object[]} options.records  Normalised v2 records to persist.
 * @param {boolean} [options.migrated]  Stamp the migration marker
 *        (i.e. this write also closes the legacy `providers.json`).
 * @returns {Promise<{ok: boolean, written: boolean, keys: string[],
 *   preserved: string[], code?: string, error?: string}>}
 */
export async function commitProviderStoreWrite(options = {}) {
  const configPath = options.configPath || getEngineConfigPath();
  try {
    // Re-read rather than trust the caller's `raw`. The plan is
    // built on what the caller saw, but the DECISION to write at all
    // must be made from what is on disk right now: a config.yaml that
    // became unparseable between the caller's read and this call
    // would otherwise be overwritten, and overwriting it destroys every
    // section the store does not own. One extra small read per write is
    // the cheapest insurance in this module.
    const disk = readEngineConfigRaw(configPath);
    if (!disk.ok) {
      return {
        ok: false,
        written: false,
        keys: [],
        preserved: [],
        code: "ENGINE_STORE_UNREADABLE",
        error: disk.error,
      };
    }
    const plan = buildProviderStoreWrite(
      options.tree || {},
      options.records || [],
    );
    const next = { ...(options.raw || options.diskRaw || disk.raw), custom_provider: plan.tree };
    if (options.migrated) {
      next[PROVIDER_STORE_MIGRATION_MARKER] = {
        schema: PROVIDER_STORE_MIGRATION_SCHEMA,
        at: new Date().toISOString(),
      };
    }
    // Skip the write when the document would come out identical: a
    // no-op PUT should not touch mtime, and should not re-chmod a file
    // an operator just hand-edited.
    if (sameEngineConfigDocument(options.raw || disk.raw, next) && !options.migrated) {
      return { ok: true, written: false, keys: plan.keys, preserved: plan.preserved };
    }
    await atomicWriteYaml0600(configPath, next);
    return { ok: true, written: true, keys: plan.keys, preserved: plan.preserved };
  } catch (e) {
    return {
      ok: false,
      written: false,
      keys: [],
      preserved: [],
      code: "ENGINE_STORE_WRITE_FAILED",
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * Pure: would writing `next` change the document on disk? Compared on
 * the YAML text, not on the object, because that is what a reader
 * actually observes — and because object comparison would call a
 * re-ordered `custom_provider` a change when the engine does not care.
 *
 * @param {object|undefined} raw
 * @param {object} next
 * @returns {boolean}
 */
function sameEngineConfigDocument(raw, next) {
  if (!raw) return false;
  const dump = (o) => yaml.dump(o, { indent: 2, lineWidth: -1, noRefs: true });
  return dump(raw) === dump(next);
}

/**
 * Atomic YAML write + 0600 permission pin.
 *
 * Two-step: write the new content to a tmp file (mode 0600), then
 * rename. The rename preserves POSIX mode, but we chmod the target
 * afterwards as belt-and-suspenders (some filesystems and Windows
 * edge cases drop the mode on rename).
 *
 * @param {string} configPath
 * @param {object} object
 */
export async function atomicWriteYaml0600(configPath, object) {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = join(dirname(configPath), `.config-tmp-${randomBytes(6).toString("hex")}`);
  // mode 0600 — owner read/write only. The file carries plaintext
  // apiKeys; any looser mode would expose them to other users on the
  // host.
  await writeFile(tmp, yaml.dump(object, { indent: 2, lineWidth: -1, noRefs: true }), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, configPath);
    await chmod(configPath, 0o600);
  } catch (e) {
    // A rename that fails leaves the tmp file behind, and that file
    // carries every plaintext apiKey in the catalogue at mode 0600 in
    // the engine data dir — one leaked copy per failed write, none of
    // them ever read. The old double write had the same gap and only
    // ever tested the success path; this batch is the one that makes
    // the write atomic, so it is also the one that has to clean up
    // after itself when it cannot.
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// =====================================================================
// One-shot migration of the deprecated `providers.json`
// =====================================================================

/**
 * Does the deprecated `providers.json` exist?
 *
 * The read path asks this before it considers migrating, and that is
 * the whole reason it exists: there is nothing to migrate on a fresh
 * install, and a GET must never be what gives a machine its first
 * `config.yaml`. A file that exists but does not parse still counts as
 * present — the migration then runs, reads zero records out of it, and
 * stamps the marker, which is the correct outcome for a corrupt file
 * (the operator gets an empty catalogue they can rebuild rather than
 * a permanently-failing one).
 *
 * @returns {boolean}
 */
export function userLevelFileExists() {
  return existsSync(getUserLevelPath());
}

/**
 * In-flight migration promise, module scope. The migration is
 * triggered from the READ path, and a webui with several tabs polling
 * `/api/providers` would otherwise start one write per request. The
 * memo is cleared on settle, so a FAILED migration retries on the next
 * read — which is the fallback contract, not a bug: the store is
 * untouched, the marker is unwritten, and the legacy file is still
 * the authority until a later attempt succeeds.
 *
 * @type {Promise<object>|null}
 */
let migrationInFlight = null;

/**
 * Fold the deprecated `providers.json` into the store, once.
 *
 * Safe to call from every read. It is a no-op when the marker is
 * already present (the common case after the first PUT), and when the
 * legacy file is absent or empty it stamps the marker with an empty
 * catalogue so a fresh install stops looking for the file.
 *
 * Never throws. A failure returns a structured result and leaves both
 * files exactly as they were; the caller answers from the legacy file
 * in that case, which is the pre-B11 behaviour.
 *
 * @param {object[]} legacyProviders  Normalised records read from the
 *        deprecated file. The caller owns the read so this module
 *        never learns the webui data dir's layout.
 * @param {{configPath?: string}} [opts]
 * @returns {Promise<{ok: boolean, migrated: boolean, count: number,
 *   code?: string, error?: string}>}
 */
export async function migrateLegacyProviderStore(legacyProviders, opts = {}) {
  if (migrationInFlight) return migrationInFlight;
  const run = (async () => {
    const configPath = opts.configPath || getEngineConfigPath();
    const read = readEngineConfigRaw(configPath);
    if (!read.ok) {
      return {
        ok: false,
        migrated: false,
        count: 0,
        code: read.code,
        error: read.error,
      };
    }
    const raw = read.raw;
    if (raw[PROVIDER_STORE_MIGRATION_MARKER]) {
      return { ok: true, migrated: false, count: 0 };
    }
    const tree =
      raw.custom_provider &&
      typeof raw.custom_provider === "object" &&
      !Array.isArray(raw.custom_provider)
        ? raw.custom_provider
        : {};
    const records = legacyProviders || [];
    const result = await commitProviderStoreWrite({
      configPath,
      raw,
      tree,
      records,
      migrated: true,
    });
    if (!result.ok) {
      return { ok: false, migrated: false, count: 0, code: result.code, error: result.error };
    }
    return { ok: true, migrated: true, count: result.keys.length };
  })();
  migrationInFlight = run;
  try {
    return await run;
  } finally {
    migrationInFlight = null;
  }
}

/**
 * Test-only: drop the in-flight migration memo. A suite that drives
 * a failing migration and then a succeeding one needs the second
 * attempt to actually run.
 *
 * @returns {void}
 */
export function _resetProviderStoreMigration() {
  migrationInFlight = null;
}
