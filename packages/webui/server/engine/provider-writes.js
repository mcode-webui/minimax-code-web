// webui/server/engine/provider-writes.js
//
// Migration step M3, batch B11 (= plan item A5, write half): the
// PROVIDER CATALOGUE WRITE family —
//
//   #63  PUT  /api/providers                      — replace the catalogue
//   #66  POST /api/providers/preset/:id/enable    — materialise a preset
//
// The read half is `provider-reads.js`; the storage both halves share
// is `provider-store.js`.
//
// ---------------------------------------------------------------------
// Why this is the batch's HARD-gated half
// ---------------------------------------------------------------------
//
//   Before this batch, #63 wrote `providers.json` FIRST and projected
//   it into the engine's `config.yaml` SECOND. That is two durable
//   writes with no transaction between them, and the order was chosen
//   so the projection could never advertise something the catalogue
//   did not have — which is a real property, bought with a worse one:
//   when the second write failed, the first had already landed, the
//   response was 200 with a `warning`, and the operator's next edit was
//   computed from a file the engine had never seen. The catalogue and
//   the engine were allowed to disagree, permanently, with a warning
//   nobody was required to read.
//
//   There is one file now and one rename, so the disagreement cannot
//   be constructed. What is left to decide is what an engine that
//   cannot manage providers should answer, and the answer is 501: the
//   endpoint's entire product is "the provider configuration is now
//   this", a state the engine reads and webui does not. A 200 there
//   would be #110's fake success in its purest form — a panel showing
//   a key the runtime will never send.
//
//   #66 shares the gate with #63 because it IS #63: it materialises a
//   template and hands the result to the same commit. One gate, one
//   commit, two routes.
//
// ---------------------------------------------------------------------
// What the route keeps
// ---------------------------------------------------------------------
//
//   Body parsing, the 400s, the keep-key convention's PLACEMENT, the
//   `providers.updated` SSE frame, the ACP singleton teardown, the
//   response shape and the `engineSync` / `warning` fields all stay in
//   `routes/providers.js`. This module owns the gate, the decision of
//   which records the write persists, and the write itself.

import {
  commitProviderStoreWrite,
  readProviderStore,
} from "./provider-store.js";
import { applyKeepKeyConvention } from "../lib/providers-config.js";
import { assertEngineCapability } from "./capabilities.js";
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * The declaration this family's engine-facing half needs.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "hard"}>>}
 */
export const PROVIDER_WRITE_ENDPOINTS = Object.freeze({
  "PUT /api/providers": Object.freeze({
    capability: "authCredentials",
    subItem: "updateUserModelProvider",
    enforcement: "hard",
  }),
  "POST /api/providers/preset/:id/enable": Object.freeze({
    capability: "authCredentials",
    subItem: "createUserModelProvider",
    enforcement: "hard",
  }),
});

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is
 * unavailable" — the distinction every sibling family draws, and the
 * one that decides whether this endpoint answers 404-for-an-unknown-
 * provider (a deployment question) or 501 (an engine limitation).
 *
 * Built per call, never frozen at module scope: `engine/index.js`
 * re-exports this module, and a module-level table would read
 * `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its
 * temporal dead zone on a cold `import("./engine/index.js")`.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * Resolve the provider that answers the provider-write family on
 * `transport`, or `null` when none is registered yet.
 *
 * @param {string} transport
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveProviderWriteProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * HARD gate for both endpoints. Throws
 * `EngineCapabilityNotSupportedError` for a declared `none`, and for a
 * `partial` naming this endpoint's sub-item; the router maps it to the
 * shared 501 body from `errors.js#engineCapabilityHttpResponse`.
 *
 * An unregistered transport is NOT a 501. It returns
 * `gate: "unregistered-transport"` and lets the write proceed, which is
 * what every other family in this migration does and the reason M4
 * exists: the transport table is empty until M4, and a 501 that meant
 * "nobody has written M4 yet" would be a lie about the engine.
 *
 * @param {string} endpoint  A key of PROVIDER_WRITE_ENDPOINTS.
 * @param {string} transport
 * @returns {{endpoint: string, provider: string|null, capability: string,
 *   subItem: string, enforcement: "hard", gate: string}}
 */
export function assertProviderWriteCapability(endpoint, transport) {
  const need = PROVIDER_WRITE_ENDPOINTS[endpoint];
  if (need === undefined) {
    // Caller confusion, not an engine limitation: a plain Error, so a
    // typo in webui's own key can never be reported to an operator as
    // an engine limitation.
    const err = new Error(
      `assertProviderWriteCapability: "${endpoint}" is not part of the provider-write family ` +
        `(known: ${Object.keys(PROVIDER_WRITE_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_provider_write_endpoint";
    throw err;
  }
  const base = {
    endpoint,
    provider: null,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
  const provider = resolveProviderWriteProvider(transport);
  if (!provider) return { ...base, gate: "unregistered-transport" };
  assertEngineCapability(provider.capabilities, need.capability, provider.id, need.subItem);
  return { ...base, gate: "checked", provider: provider.id };
}

/**
 * The records a #63 body resolves to, ready to persist.
 *
 * Two rules, both pre-existing and both about WHICH key survives a
 * round trip:
 *
 *   1. The keep-key convention. An incoming `auth.apiKey` that is
 *      empty OR absent means "do not change the existing key", and the
 *      previous value is copied onto the record before validation.
 *      `existing` must be the STORE's records, not the merged
 *      catalogue: a key sourced from the env or cwd layer is
 *      deployment-owned, and copying one into the store would pin a
 *      deployment secret to operator-managed disk where the env layer
 *      can no longer rotate it.
 *   2. The whole catalogue is the body. There is no patch semantics,
 *      and there was none before this batch; a provider the body omits
 *      is a provider the operator removed.
 *
 * Pure — no IO, no clock, no store access — so the convention's scope
 * is a thing a test can pin rather than a comment.
 *
 * @param {object[]} incoming  The body's `providers`.
 * @param {object[]} existing  The store's current records.
 * @returns {object[]}
 */
export function planProviderCatalogueWrite(incoming, existing) {
  return applyKeepKeyConvention(existing || [], incoming || []);
}

/**
 * #63 / #66 — persist a provider catalogue to the store.
 *
 * The commit is ONE atomic rename of the whole `config.yaml`, and
 * every outcome is a value:
 *
 *   { ok: true,  written, keys, preserved, records }  — the store now
 *       holds exactly `records`, with the marker stamped (this is the
 *       write that also closes the deprecated `providers.json`).
 *   { ok: false, code: "ENGINE_STORE_UNREADABLE" }    — `config.yaml`
 *       does not parse. The file is left exactly as it is, because
 *       overwriting it would destroy whatever the operator had in the
 *       sections this batch does not own. The route answers 500.
 *   { ok: false, code: "ENGINE_STORE_WRITE_FAILED" }  — the write
 *       itself failed. The previous document is intact; the route
 *       answers 500.
 *
 * `records` is the persisted catalogue in the order it will be read
 * back, which is the order the operator PUT — the store is a YAML
 * mapping, and this is what keeps the catalogue's order stable across
 * a round trip through it.
 *
 * @param {object} options
 * @param {object[]} options.records  Normalised records to persist.
 * @param {string} [options.configPath]
 * @returns {Promise<{ok: boolean, written?: boolean, keys?: string[],
 *   preserved?: string[], records?: object[], code?: string, error?: string}>}
 */
export async function commitProviderCatalogueWrite(options = {}) {
  const store = readProviderStore(options);
  if (!store.ok) {
    return {
      ok: false,
      code: "ENGINE_STORE_UNREADABLE",
      error: store.error,
    };
  }
  const result = await commitProviderStoreWrite({
    configPath: store.configPath,
    raw: store.raw,
    tree: store.tree,
    records: options.records || [],
    // Every store write stamps the marker. A PUT is a full
    // replacement, so it has just made the deprecated file
    // irrelevant whether or not one existed, and stamping it here is
    // what makes "delete every provider" stick: without the marker a
    // later read would go back to the deprecated file and resurrect
    // what the operator removed.
    migrated: true,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    written: result.written,
    keys: result.keys,
    preserved: result.preserved,
    records: options.records || [],
  };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
//   1. THE ACP SINGLETON TEARDOWN IS STILL THE ROUTE'S, AND IT IS NOW
//      A NO-OP FOR MOST DEPLOYMENTS. #63 used to call
//      `shutdownMcodeAcpSingleton()` after a successful projection so
//      the next catalogue call would re-read `config.yaml` into a
//      fresh subprocess. That reason survives — the subprocess caches
//      its config — but the call is a no-op under the `runtime`
//      transport, where the host is the in-process one this module
//      wrote to directly. It is left in place because the `acp`
//      transport still spawns the child, and removing it on an
//      assumption about M4's provider table is how the next batch
//      inherits a stale-config bug nobody can reproduce.
//
//   2. THE ENGINE'S OWN WRITER (`updateLocalByokConfig`) IS STILL NOT
//      USED. It would give the write a cross-process lock, which
//      matters only when a `mcode provider` CLI command races a webui
//      PUT — and it drags `js-yaml` plus `proper-lockfile` into the
//      webui bundle for a one-way write webui makes rarely. The atomic
//      rename this module uses is what makes the PUT atomic *within*
//      the process, which is the failure the death line named. The
//      cross-process case is real and unclaimed; the argument for
//      leaving it is the same one the module it replaces recorded, and
//      it is recorded here rather than silently re-decided.
//
//   3. A WEBUI PROVIDER WHOSE ENGINE KEY COLLIDES WITH A FOREIGN ENTRY
//      OVERWRITES THAT ENTRY, exactly as the double-write it replaces
//      did. `buildProviderStoreWrite` writes every record first and
//      carries foreign entries after, so a foreign key that a webui
//      provider also claims is lost.
//
//      The obvious fix — suffix the webui key — is worse than the bug
//      for a reason specific to this batch: the key IS the runtime id.
//      `custom_provider:<key>/<model>` is what `applyRecordedModel` and
//      B4's `resolveModelId` match a pre-session pick against, so a
//      silent rename turns a user's already-chosen model into an
//      unresolvable one. Choosing between "an operator's hand-written
//      entry disappears" and "a recorded model stops resolving" is a
//      product decision, not a refactor's. The pre-existing behaviour
//      is preserved and pinned by a named test so the choice stays
//      visible.
