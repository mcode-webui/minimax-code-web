// webui/server/engine/provider-reads.js
//
// Migration step M3, batch B11 (= plan item A5, read half): the
// PROVIDER CATALOGUE READ family —
//
//   #62  GET  /api/providers            — the masked catalogue + layers
//   #64  POST /api/providers/test       — connectivity probe
//   #65  GET  /api/providers/presets    — the preset gallery
//
// The write half is `provider-writes.js`; the storage both halves share
// is `provider-store.js`. This module is the part that decides WHICH of
// two files is the catalogue, and that decision is the batch.
//
// ---------------------------------------------------------------------
// Before, and after
// ---------------------------------------------------------------------
//
//   BEFORE: `providers.json` was the catalogue and `config.yaml` was a
//   lossy projection of it. #62 read the first, the engine read the
//   second, and the two were kept in agreement by a double write that
//   could disagree with itself — the YAML write ran second, could fail,
//   and left the first already updated.
//
//   AFTER: `config.yaml#custom_provider` is the catalogue, carrying
//   each provider's webui record beside its engine fields, and
//   `providers.json` is a deprecated source read only until the store
//   carries the migration marker. The env and cwd layers are untouched:
//   they are deployment-owned files webui has never written and the
//   plan does not put them in scope.
//
// The two authorities, and why a failed migration is not a failure of
// the endpoint:
//
//   marker present  → the store answers; the deprecated file is not read
//                     at all.
//   marker absent   → the deprecated file answers and the store
//                     contributes nothing. A migration is attempted once
//                     per read, and its outcome is invisible to the
//                     response, because the response the operator sees
//                     is the one they saw before this batch. That is the
//                     fallback contract in full: the old format stays
//                     readable, and no state is ever half-consumed,
//                     because the migration's only durable effects (the
//                     records and the marker) ride the SAME atomic
//                     rename.
//
// #64 and #65 are named here for the GATE, not for a data plane: the
// probe is a network call webui makes from its own process and the
// gallery is a local template list, so neither reads the store. They
// belong to the family because each answers "is this deployment able to
// manage providers", and a provider that cannot is still better served
// by a working local probe than by a 501 that says nothing about the
// credential the operator pasted. KNOWN DEBT 1 costs the branch that
// would let the engine answer #64.
//
// ---------------------------------------------------------------------
// Gate policy: SOFT, for all three
// ---------------------------------------------------------------------
//
//   #62 and #65 are reads whose subject webui owns outright; a
//   provider that declared no provider surface would leave the
//   catalogue and the gallery perfectly well defined. Gating them hard
//   would delete a working endpoint over an enrichment — the
//   `session-export.js` argument, reused rather than re-argued. #64 is
//   a read too, and a stricter one, for the same reason. The 501
//   machinery stays unused by this family and the suite pins that.
//
// Boot-path weight. `routes/providers.js` imports this module
// directly, NOT through `engine/index.js`, for the reason
// `model-reads.js` set: this module reaches `js-yaml` (through
// `provider-store.js`), and `engine/index.js` is the one import site
// the whole server shares.

import {
  loadProvidersConfig,
  loadUserLevelProviders,
  SCHEMA_VERSION,
} from "../lib/providers-config.js";
import {
  migrateLegacyProviderStore,
  readProviderStore,
  userLevelFileExists,
} from "./provider-store.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * The declaration this family's engine-facing half needs.
 *
 * `subItem` names the ENGINE method that would eventually serve the
 * endpoint, not the one webui calls today. For #62 and #65 that is the
 * read pair (`listUserModelProviders` / `listProviderPresets`); for
 * #64 it is the engine's tester, which is a different method on a
 * different shape — see KNOWN DEBT 1.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "soft"}>>}
 */
export const PROVIDER_READ_ENDPOINTS = Object.freeze({
  "GET /api/providers": Object.freeze({
    capability: "authCredentials",
    subItem: "listUserModelProviders",
    enforcement: "soft",
  }),
  "POST /api/providers/test": Object.freeze({
    capability: "authCredentials",
    subItem: "testUserModelProvider",
    enforcement: "soft",
  }),
  "GET /api/providers/presets": Object.freeze({
    capability: "authCredentials",
    subItem: "listProviderPresets",
    enforcement: "soft",
  }),
});

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is
 * unavailable" — the same distinction every sibling family draws, and
 * for the same reason: one of them is a deployment gap and the other
 * is an engine limitation, and they answer with different statuses.
 *
 * Built per call rather than frozen at module scope, because
 * `engine/index.js` re-exports this module and a module-level table
 * would read `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still
 * in its temporal dead zone on a cold `import("./engine/index.js")`.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * Resolve the provider that answers the provider-read family on
 * `transport`, or `null` when none is registered yet.
 *
 * @param {string} transport
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveProviderReadProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * SOFT gate. Reports; never throws. A `none`, or a `partial` naming
 * this endpoint's sub-item, comes back as `degraded: true` with the
 * declaration's own `reason` — the same degradation record
 * `summarizeUnavailableCapabilities` produces and the same one the
 * frontend already renders from `/api/engine-capabilities`.
 *
 * @param {string} endpoint  A key of PROVIDER_READ_ENDPOINTS.
 * @param {string} transport
 * @returns {{endpoint: string, provider: string|null, capability: string,
 *   subItem: string, enforcement: "soft", gate: string, degraded: boolean,
 *   reason: string|null}}
 */
export function checkProviderReadCapability(endpoint, transport) {
  const need = PROVIDER_READ_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `checkProviderReadCapability: "${endpoint}" is not part of the provider-read family ` +
        `(known: ${Object.keys(PROVIDER_READ_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_provider_read_endpoint";
    throw err;
  }
  const provider = resolveProviderReadProvider(transport);
  if (!provider) {
    return {
      endpoint,
      provider: null,
      capability: need.capability,
      subItem: need.subItem,
      enforcement: need.enforcement,
      gate: "unregistered-transport",
      degraded: false,
      reason: null,
    };
  }
  const entry = provider.capabilities[need.capability];
  const missing = entry && Array.isArray(entry.missing) ? entry.missing : [];
  const degraded =
    !entry || entry.level === "none" || (entry.level === "partial" && missing.includes(need.subItem));
  return {
    endpoint,
    provider: provider.id,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
    gate: "checked",
    degraded,
    reason: degraded && entry && entry.reason ? entry.reason : null,
  };
}

/**
 * #62 — the resolved provider catalogue, whichever file is currently
 * the authority.
 *
 * The order of the steps is the contract:
 *
 *   1. Read the store. If it carries the migration marker, its records
 *      ARE the catalogue and the deprecated file is never opened.
 *   2. Otherwise, if the deprecated file exists, attempt the migration
 *      once and re-read the store. A failure here is NOT an error for
 *      the caller: the last branch answers from the deprecated file
 *      exactly as the pre-B11 route did.
 *   3. Merge. The user layer (store records, or the legacy records on
 *      the fallback path) goes UNDER the cwd and env layers, which
 *      keep their existing precedence and their existing
 *      re-read-per-call behaviour.
 *
 * A store that cannot be read at all (an unparseable `config.yaml`)
 * takes the same fallback: the deprecated file answers, because a
 * syntactically broken engine config must not take the provider dialog
 * down with it. What the write path does about that file is the write
 * path's problem, and it refuses to overwrite it.
 *
 * `userLevelFileExists` is what keeps a GET from ever writing: a fresh
 * install has no deprecated file, so there is nothing to migrate, and
 * polling #62 must not be what gives a machine its first
 * `config.yaml`.
 *
 * @param {{configPath?: string}} [opts]
 * @returns {Promise<{
 *   version: number,
 *   providers: object[],
 *   sources: {env: string|null, cwd: string|null, user: string},
 *   userPath: string,
 *   storePath: string,
 *   catalogueSource: "engine-store"|"legacy-file",
 *   migration: {attempted: boolean, migrated: boolean, count: number,
 *     code: string|null, error: string|null},
 * }>}
 */
export async function readEngineProviderCatalogue(opts = {}) {
  const store = readProviderStore(opts);
  if (store.ok && store.migrationDone) {
    return catalogueFrom(store.records, store, { attempted: false, migrated: false, count: 0 });
  }
  if (!userLevelFileExists()) {
    return catalogueFrom([], store, { attempted: false, migrated: false, count: 0 });
  }
  const legacy = loadUserLevelProviders();
  const migration = await migrateLegacyProviderStore(legacy, opts);
  if (migration.ok && migration.migrated) {
    const after = readProviderStore(opts);
    if (after.ok && after.migrationDone) {
      return catalogueFrom(after.records, after, {
        attempted: true,
        migrated: true,
        count: migration.count,
      });
    }
  }
  // Every remaining branch is the fallback: the migration failed, or it
  // was already done by a concurrent read, or the store turned out not
  // to be readable. The deprecated file answers, unchanged in format,
  // and the reason travels with the result for the route's log line.
  return catalogueFrom(legacy, store, {
    attempted: true,
    migrated: false,
    count: 0,
    code: migration.ok ? null : migration.code,
    error: migration.ok ? null : migration.error,
  });
}

/**
 * Run the layer merge for a resolved user layer. The env and cwd
 * layers come from `loadProvidersConfig`, which is where their
 * precedence and their per-call re-read live; this wrapper only decides
 * which providers take the user layer's place, and reports which file
 * won.
 *
 * @param {object[]} userLayer
 * @param {object} store  A `readProviderStore` result, for the paths.
 * @param {object} migration
 * @returns {object}
 */
function catalogueFrom(userLayer, store, migration) {
  const cfg = loadProvidersConfig({ userLayer });
  return {
    version: SCHEMA_VERSION,
    providers: cfg.providers,
    sources: cfg.sources,
    userPath: cfg.sources.user,
    storePath: store.configPath,
    catalogueSource: store.ok && store.migrationDone ? "engine-store" : "legacy-file",
    migration: {
      attempted: migration.attempted,
      migrated: migration.migrated,
      count: migration.count || 0,
      code: migration.code || null,
      error: migration.error || null,
    },
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
//   1. #64'S SUB-ITEM NAMES A METHOD THAT CANNOT ANSWER IT, AND THE
//      GATE IS STILL WORTH ARMING. The engine's tester is
//      `testUserModelProvider(providerId)` — keyed on a PERSISTED
//      provider. #64 tests an UNSAVED candidate: the body carries the
//      protocol, the key, the baseURL and the headers of a form the
//      operator has not submitted yet, and the endpoint's whole
//      contract is "does THIS work". There is no id to hand the engine
//      yet, so the sub-item can only ever be aspirational.
//
//      Two branches, both costed, neither chosen here:
//
//        (a) PERSIST-THEN-TEST. Materialise the candidate, ask the
//            engine, roll the store back. Cost: a write on a read-only
//            endpoint, a window in which another tab's #62 sees a
//            half-configured provider, and a rollback that can fail — a
//            "Test" button that can lose a concurrent edit is worse
//            than one that runs its own fetch.
//
//        (b) GIVE THE ENGINE AN UNSAVED-CANDIDATE TESTER, e.g.
//            `testUserModelProviderCandidate(input)` taking the same
//            shape `createUserModelProvider` does. Cost: an engine API
//            change, which is M4's to negotiate, and a capability
//            sub-item the snapshot audit would then have to prove.
//
//      Until one is chosen the probe stays webui-local, which is also
//      the only option that keeps its two load-bearing properties: the
//      local key-format check runs BEFORE any network call, and the
//      apiKey is sent to the configured baseURL and nowhere else.
//
//   2. #65'S PRESET GALLERY IS STILL WEBUI'S OWN TEMPLATE LIST, and the
//      engine has a different one. The two are not the same taxonomy —
//      the engine's `McodeProviderTemplate` and webui's
//      `PROVIDER_PRESETS` disagree on what a template carries — so the
//      plan's "两套模板对齐" regression note is NOT closed by this batch,
//      only made visible: the gate now names `listProviderPresets`, so
//      a provider that declines to serve presets says so instead of the
//      two lists quietly disagreeing. Merging them is an engine-side
//      taxonomy decision, recorded here rather than guessed at.
//
//   3. THE ENV AND CWD LAYERS WERE LEFT ALONE ON PURPOSE. They are
//      deployment-owned files webui has never written, they keep their
//      precedence, and folding them into the store would mean webui
//      writing files it does not own. Their records are normalised into
//      the same shape, so a future merge is a matter of moving the
//      READ, not of changing a schema.
