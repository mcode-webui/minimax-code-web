// webui/server/engine/model-reads.js
//
// Migration step M3, batch B4: the model-catalogue read (模型目录读) —
//
//   #57  GET /api/models — the composer's provider-grouped model picker
//
// What this file is for. #57 is the LARGEST projection in webui and
// the one a refactor can damage most quietly. It merges three
// independent sources, dedupes them by a key that has changed shape
// twice, annotates each surviving entry with two separate projections
// of the engine's materialised builtin tree, and derives three
// "what is active right now" figures — none of which is compared
// against anything at runtime. A change that drops one annotation, or
// moves one entry into the wrong provider group, or resolves `current`
// to a different id, changes what the user picks and reports nothing.
// So the whole projection lives HERE, once, as named pure functions
// tested on their INPUTS, and the route assembles nothing but JSON.
//
// The three sources, in the order they are consumed (priority order is
// the endpoint's, not this file's invention — see `projectModelCatalogue`):
//
//   1. the engine SESSION's `model` config option — its `options[].value`
//      is the engine's encoded wire form, forwarded verbatim so
//      `POST /api/set-model` round-trips;
//   2. the PROVIDERS config — webui's `env > cwd > user` layers with the
//      engine's `custom_provider` tree as a new bottom layer
//      (`lib/engine-catalogue.js` owns the merge);
//   3. the BUILTIN catalogue — extracted from the engine's own cli
//      bundle, so the list tracks the engine without a webui release.
//
// Plus two projections of the SAME engine tree (`provider.minimax.models`)
// that annotate entries in both source 1 and source 3: the variant-style
// thinking schema (`readEngineBuiltinThinking`) and the context-window
// options (`readEngineBuiltinContextWindows`, "U6"). Both are read once
// per request and handed to the two annotation sites — the redundancy of
// reading them per entry was a real cost, and the two reads must agree
// because they are two views of one file.
//
// Why this family's gate is SOFT while the account family gates hard.
// The catalogue is NOT engine data in the way an account is. Its
// primary sources are files webui owns and can read without the engine:
// `models.json` / `~/.mcode-webui/providers.json` on the webui side, and
// a cli-bundle extraction on the engine side. A provider that declared
// no model surface would still leave a fully working picker over the
// webui layers plus the builtins. Gating the endpoint hard would REMOVE
// working functionality in response to a declaration about a capability
// the endpoint does not actually depend on — the exact reasoning
// `session-export.js` records for #11, reused here rather than
// re-argued. So `checkModelReadCapability` REPORTS and never throws; the
// read is unaffected by what it reports, and the report is what a later
// batch needs in order to decide whether the engine LAYER may be trusted.
//
// What this file deliberately does NOT do:
//
//   - It does not re-implement the engine's own projections.
//     `lib/engine-catalogue.js` owns the thinking schema, the
//     context-window hygiene rules, the wire-form parser, the
//     `custom_provider` read and the layer merge. A second projection
//     here would be a second answer to a question with exactly one.
//   - It does not write. `handleSetModel` stays in the route for B7/B9;
//     this batch only moves the READ.
//   - It does not build a second provider host and does not call any
//     provider method: every source here is a file read, which is why
//     the sub-item below names a READ rather than a method webui calls.
//
// Boot-path weight — the ONE place this batch deviates from the
// sibling families, and the deviation is deliberate on both sides of
// the import.
//
// The four static imports below (`lib/config.js`,
// `lib/engine-catalogue.js`, `lib/models.js`, `lib/providers-config.js`)
// were ALREADY static imports of `routes/model.js` before M3-B4, so the
// server's boot cost is exactly what it was. What they must not do is
// reach `@mavis/*` or `js-yaml` through the SHARED facade — and they
// do reach `@mavis/shared/local-runtime-paths` (via `lib/config.js`)
// and `js-yaml` (via `engine-provider-sync.js`). That is why this module
// is deliberately NOT re-exported from `engine/index.js`, and why
// `routes/model.js` imports it directly: `test/lib/engine/host-facade.test.js`
// guards `engine/index.js` and `routes/plugins.js` against exactly that
// pull, and the guard is right. See `engine/index.js` for the full
// statement and for what has to be true before this can move back.
//
// The price is that the read is SYNCHRONOUS. Making the four imports
// dynamic would let the module re-export from the facade, at the cost of
// turning `handleGetModels` into an async handler — a contract change
// for any caller that does not await, and the exact thing this batch
// promises not to do. The M1 lesson (209ms → 2700ms) was about the
// `@mavis/*` TypeScript host tree, which nothing here touches.
//
// Provider selection is M4's job, same as every other family:
// `providerByTransport()` maps a transport to a REGISTERED provider id;
// today only `runtime` has one, so the default `acp` transport reports
// `gate: "unregistered-transport"` and the read proceeds unchanged.

import { MCODE_WEBUI_TRANSPORT } from "../lib/config.js";
import {
  mergeEngineAndWebuiProviders,
  parseEngineModelWireValue,
  readEngineBuiltinContextWindows,
  readEngineBuiltinThinking,
  readEngineCatalogue,
} from "../lib/engine-catalogue.js";
import { getBuiltinModelsFromMcode } from "../lib/models.js";
import { loadProvidersConfig } from "../lib/providers-config.js";
// `assertEngineCapability` is deliberately NOT imported: this family's
// gate is soft, so it INSPECTS the declaration (`checkModelReadCapability`
// below) and reports what it found rather than delegating the verdict to
// the throwing helper. Importing it here would be a dead import that
// reads as if the soft path could still throw.
import { DEFAULT_ENGINE_PROVIDER_ID, getEngineProvider } from "./index.js";

/**
 * The provider every builtin entry belongs to.
 *
 * The builtin shell is keyed by `minimax_api` REGARDLESS of the
 * recorded pick. Deriving the group from `currentName.split("/")[0]`
 * was the bug ticket 09-02's acceptance replay caught as "8 config + 6
 * misplaced MiniMax builtins = 14 in `nousresearch`": a user who picked
 * a BYOK model dragged the engine's own builtins into that provider's
 * group. The constant lives here now because the attribution rule and
 * the group id are one decision.
 */
const BUILTIN_PROVIDER = "minimax_api";

/** The synthetic group id the engine session's own option list renders as. */
const ENGINE_GROUP_ID = "__engine";

/**
 * Transport → registered engine provider id. Absent means "no provider
 * claims this transport yet" (M4), NOT "the capability is unavailable" —
 * the two answer differently on purpose, mirroring
 * `session-reads.js#providerByTransport`, `session-tree-reads.js`,
 * `session-export.js` and `usage-reads.js`. Kept per-family so each
 * family owns its own gate policy; collapse them in M4, not here.
 *
 * Built per call rather than frozen at module scope: `engine/index.js`
 * re-exports this module, so a module-level table would read
 * `DEFAULT_ENGINE_PROVIDER_ID` while that binding is still in its
 * temporal dead zone on a cold `import("./engine/index.js")`.
 *
 * @returns {Readonly<Record<string, string>>}
 */
function providerByTransport() {
  return Object.freeze({ runtime: DEFAULT_ENGINE_PROVIDER_ID });
}

/**
 * The declaration this endpoint's ENGINE LAYER needs, and the sub-item
 * it needs from that capability.
 *
 * `authCredentials` is where the engine's model/provider surface is
 * declared — the local-runtime-v2 declaration says so in its own
 * comment ("full user model provider CRUD/test/discover, same source as
 * service/model-system"), and the 14 matrix keys have no separate
 * "models" row. `listModelProviders` names the READ, not a method webui
 * calls: the custom_provider tree and the builtin tree are files the
 * engine owns, read through `lib/engine-catalogue.js`, not a
 * `CliService` method. That distinction is the reason this family's
 * gate is soft — a missing declaration here removes ONE of the
 * catalogue's three sources, never the endpoint.
 *
 * @type {Readonly<Record<string, {capability: string, subItem: string, enforcement: "soft"}>>}
 */
export const MODEL_READ_ENDPOINTS = Object.freeze({
  "GET /api/models": {
    capability: "authCredentials",
    subItem: "listModelProviders",
    enforcement: "soft",
  },
});

/**
 * Resolve the provider that answers the model read on `transport`, or
 * `null` when none is registered yet.
 *
 * @param {string} transport  One of the `MCODE_WEBUI_TRANSPORT` values.
 * @returns {{id: string, transport: string, capabilities: object}|null}
 */
export function resolveModelReadProvider(transport) {
  const providerId = providerByTransport()[transport];
  if (!providerId) return null;
  return getEngineProvider(providerId);
}

/**
 * Read the declaration for #57 WITHOUT enforcing it.
 *
 * The `gate` values are the same vocabulary `session-export.js` uses,
 * for the same reason:
 *
 *   - `"checked"`               — provider resolved, capability `full`.
 *   - `"unregistered-transport"` — no provider claims this transport yet.
 *   - `"capability-absent"`     — the provider WAS found and does not
 *     offer the model surface. The caller's next move is to distrust the
 *     ENGINE LAYER, not to fail the request.
 *   - `"partial"`               — the provider is `partial` and this
 *     sub-item is absent.
 *
 * Deliberately never throws `EngineCapabilityNotSupportedError`. See the
 * header for why a hard gate here would remove working functionality.
 * A genuinely unknown endpoint key is still a plain Error — caller
 * confusion is not a capability question.
 *
 * @param {string} endpoint  A key of MODEL_READ_ENDPOINTS.
 * @param {string} transport The active transport.
 * @returns {{endpoint: string, gate: string, provider: string|null, capability: string|null, subItem: string|null, enforcement: "soft"}}
 */
export function checkModelReadCapability(endpoint, transport) {
  const need = MODEL_READ_ENDPOINTS[endpoint];
  if (need === undefined) {
    const err = new Error(
      `checkModelReadCapability: "${endpoint}" is not part of the model family ` +
        `(known: ${Object.keys(MODEL_READ_ENDPOINTS).join(", ")})`,
    );
    err.code = "unknown_model_read_endpoint";
    throw err;
  }
  const base = {
    endpoint,
    provider: null,
    capability: need.capability,
    subItem: need.subItem,
    enforcement: need.enforcement,
  };
  const provider = resolveModelReadProvider(transport);
  if (!provider) return { ...base, gate: "unregistered-transport" };
  const entry = provider.capabilities ? provider.capabilities[need.capability] : undefined;
  const descriptor = { ...base, provider: provider.id };
  if (entry && entry.level === "full") {
    return { ...descriptor, gate: "checked" };
  }
  if (entry && entry.level === "partial") {
    const absent = Array.isArray(entry.missing) && entry.missing.includes(need.subItem);
    return { ...descriptor, gate: absent ? "partial" : "checked" };
  }
  return { ...descriptor, gate: "capability-absent" };
}

// ---------------------------------------------------------------------------
// The projections. Pure functions, exported, and tested on their INPUTS.
// ---------------------------------------------------------------------------

/**
 * Coerce a provider prefix out of a model id.
 *
 * `minimax_api/MiniMax-M3` → `minimax_api`. Bare `MiniMax-M3` falls back
 * to `minimax_api` (the engine's only shipping builtin provider) so a
 * user-typed short id still resolves to a known group instead of
 * orphaning itself.
 *
 * Used only for engine session entries (their ids are the engine's wire
 * form `m:<encodedProvider>:<model>:u`); webui-side entries carry the
 * provider as an explicit `entry.provider` field, and the multi-segment
 * model id stays whole (see `webuiFullModelId`).
 *
 * @param {string} modelId
 * @param {string} [fallback]
 * @returns {string}
 */
export function providerOfModelId(modelId, fallback = BUILTIN_PROVIDER) {
  if (!modelId) return fallback;
  const i = modelId.indexOf("/");
  if (i <= 0) return fallback;
  return modelId.slice(0, i);
}

/**
 * Build the webui internal id for a catalogue entry: `<providerKey>/<modelId>`.
 *
 * The webui id is always two segments where the first is the provider
 * key and the second is the engine-side model id verbatim (the engine
 * allows `/` inside model ids — see `engine-catalogue.js`; the wire
 * form `formatModelKey(<providerId>, <modelId>)` uses `/` as the only
 * structural separator, so a downstream `<provider>/<model>` webui
 * form survives the round-trip through `resolveModelId`).
 *
 * Ticket 09-02 (grouping attribution): the previous implementation
 * skipped the prefix when `m.id.includes("/")` and let the bare
 * upstream id stand. That pushed the picker into the wrong group (the
 * id's first segment was used as a fallback for the provider
 * extraction) and let two providers with overlapping upstream ids
 * collide on the `seen` dedupe (e.g. `z-ai/glm-5.3` in `nousresearch`
 * ate the sibling `zai-max/glm-5.3`). Always prefixing — even when the
 * model id already contains `/` — keys every entry by
 * `(providerKey, modelId)` and the dedupe is per provider, as the
 * ticket requires.
 *
 * @param {string} providerKey
 * @param {string} modelId
 * @returns {string}
 */
export function webuiFullModelId(providerKey, modelId) {
  return `${providerKey}/${modelId}`;
}

/**
 * Attach the engine's context-window metadata ("U6") onto a catalogue
 * entry, mutating `entry`.
 *
 * `contextWindowOptions` / `contextWindowOptionHints` come from the
 * engine's materialised builtin tree (same read as the thinking
 * projection — see `lib/engine-catalogue.js`). Only the `minimax_api`
 * builtin entries carry them today: the engine's ACP `model` config
 * option (the engine-session entries' source) does not advertise the
 * metadata, so those entries are annotated through the same builtin
 * projection keyed by the wire form's model id. Custom-provider /
 * config-layer entries never get the fields — a model without options
 * must stay field-free so the composer mounts no control.
 *
 * `contextLimit` (the CURRENT effective window, from the engine tree's
 * `limit.context`) is attached when the entry has none yet — a config
 * layer entry keeps its own value; builtin shell entries get the
 * engine's current window so the picker can show the active radio
 * before the user's first in-webui pick.
 *
 * @param {object} entry      Mutated in place; the caller owns it.
 * @param {{options: number[], hints?: object, currentLimit?: number}|null} projection
 * @returns {void}
 */
export function attachContextWindowOptions(entry, projection) {
  if (!projection) return;
  entry.contextWindowOptions = [...projection.options];
  if (projection.hints) {
    entry.contextWindowOptionHints = { ...projection.hints };
  }
  if (entry.contextLimit === undefined && projection.currentLimit !== undefined) {
    entry.contextLimit = projection.currentLimit;
  }
}

/**
 * The engine session's `model` config option with this id, or `null`
 * before a session exists.
 *
 * @param {object} cs
 * @param {string} id
 * @returns {object|null}
 */
export function configOption(cs, id) {
  const options = Array.isArray(cs && cs.configOptions) ? cs.configOptions : [];
  return options.find((o) => o && o.id === id) || null;
}

/**
 * Build the flat `models` list and the provider-grouped `groups` array.
 *
 * Pure, and the whole of #57's payload except the three derived "what
 * is active" figures. The rules it encodes, in the order the endpoint
 * has always applied them:
 *
 *   1. Engine session entries first, under the synthetic `__engine`
 *      group, with the engine's wire ids kept verbatim. They carry BOTH
 *      `name` and `label` because pre-existing callers (the composer
 *      chip) read `name` while the provider-grouped panel reads `label`.
 *   2. Config-layer providers next, each under its own group, with the
 *      operator's per-model metadata winning wholesale on an id
 *      collision (the `seen` dedupe). A group is emitted even when its
 *      model list is empty — an operator who configured a provider with
 *      no models yet must still see the group to add one.
 *   3. Builtins last, appended to the `minimax_api` group (created on
 *      demand) — and the empty shell is dropped only when there is no
 *      providers config at all, so a fresh install with a config that
 *      names no models still has somewhere to attach the builtins once
 *      the engine reports them.
 *
 * @param {object} options
 * @param {object|null} options.sessionOption  The engine `model` config option.
 * @param {{providers: Array<object>}|null} options.providers  The merged
 *        providers config, or `null` when every layer was missing.
 * @param {string[]} options.builtins  Bare builtin model ids.
 * @param {Map<string, {levels: string[], variant?: object}|null>} options.builtinThinking
 * @param {Map<string, object|null>} options.builtinContextWindows
 * @returns {{list: Array<object>, groups: Array<object>}}
 */
export function projectModelCatalogue(options = {}) {
  const sessionOption = options.sessionOption || null;
  const providers = options.providers || null;
  const builtins = Array.isArray(options.builtins) ? options.builtins : [];
  const builtinThinking = options.builtinThinking || new Map();
  const builtinContextWindows = options.builtinContextWindows || new Map();
  const parseWire = options.parseEngineModelWireValue || defaultParseWireStub;

  const list = [];
  const groups = [];
  const seen = new Set();

  // 1) Engine session config option — authoritative when present.
  if (sessionOption) {
    const engineGroup = { id: ENGINE_GROUP_ID, label: "Engine session", models: [] };
    for (const o of Array.isArray(sessionOption.options) ? sessionOption.options : []) {
      const id = o && typeof o.value === "string" ? o.value : null;
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const displayName = (o && o.name) || id;
      const entry = {
        id,
        name: displayName,
        label: displayName,
        provider: providerOfModelId(id),
        source: "engine",
      };
      // The engine's wire-form `currentValue` is mirrored into
      // `cs.model.name` outside the pick window and the composer matches
      // the active model by id — annotate the wire-form entries too so
      // the thinking and context controls survive a cross-client change.
      const wire = parseWire(id);
      if (wire && wire.providerId === BUILTIN_PROVIDER) {
        const proj = builtinThinking.get(wire.modelId);
        if (proj) entry.thinkingLevels = [...proj.levels];
        attachContextWindowOptions(entry, builtinContextWindows.get(wire.modelId));
      }
      engineGroup.models.push(entry);
      list.push(entry);
    }
    if (engineGroup.models.length > 0) groups.push(engineGroup);
  }

  // 2) Providers config — read every request so editing the file does not
  //    require a restart. Config wins on id collision with the builtin
  //    catalogue so providers can override labels and contextLimit.
  if (providers) {
    for (const p of providers.providers) {
      if (!p || typeof p.id !== "string" || !p.id) continue;
      const models = [];
      for (const m of Array.isArray(p.models) ? p.models : []) {
        if (!m || typeof m.id !== "string" || !m.id) continue;
        const fullId = webuiFullModelId(p.id, m.id);
        if (seen.has(fullId)) continue;
        seen.add(fullId);
        const entry = {
          id: fullId,
          label: typeof m.label === "string" && m.label ? m.label : m.id,
          provider: p.id,
          source: "config",
        };
        if (typeof m.contextLimit === "number" && m.contextLimit > 0) {
          entry.contextLimit = m.contextLimit;
        }
        // v2 schema surfaces: each model carries protocol +
        // thinkingLevels + modalities so the selector can pick the right
        // controls without a second round-trip. `auth` only exposes
        // hasKey + type — an apiKey NEVER reaches this response.
        if (typeof p.protocol === "string" && p.protocol) {
          entry.protocol = p.protocol;
        }
        if (Array.isArray(m.thinkingLevels) && m.thinkingLevels.length > 0) {
          entry.thinkingLevels = [...m.thinkingLevels];
        }
        if (Array.isArray(m.modalities) && m.modalities.length > 0) {
          entry.modalities = [...m.modalities];
        }
        models.push(entry);
        list.push(entry);
      }
      // Auth shape: only `hasKey` and `type`; no apiKey/baseURL.
      // Operators see "configured or not" without leaking the secret.
      // The merged layer (engine + webui) may carry `hasKey` either via
      // `p.auth.apiKey` (webui-side plaintext — masked elsewhere) or via
      // `p.auth.hasKey` (engine-side boolean, set by
      // `lib/engine-catalogue.js`). Either signal means the provider is
      // configurable from the picker.
      const groupHasKey = !!((p.auth && p.auth.apiKey) || (p.auth && p.auth.hasKey));
      groups.push({
        id: p.id,
        label: typeof p.label === "string" && p.label ? p.label : p.id,
        auth: {
          hasKey: groupHasKey,
          type: p.auth && typeof p.auth.type === "string" ? p.auth.type : "byok",
        },
        protocol: typeof p.protocol === "string" ? p.protocol : "openai",
        models,
      });
    }
  }

  // 3) Builtin catalogue. The builtins all belong to the engine's
  //    `minimax_api` provider (see `lib/models.js#getBuiltinModelsFromMcode`
  //    — the cli.js extraction regex targets `MiniMax-M*`).
  let builtinGroup = groups.find((g) => g.id === BUILTIN_PROVIDER);
  if (!builtinGroup) {
    builtinGroup = { id: BUILTIN_PROVIDER, label: BUILTIN_PROVIDER, models: [] };
    groups.push(builtinGroup);
  }
  for (const m of builtins) {
    const fullId = webuiFullModelId(BUILTIN_PROVIDER, m);
    if (seen.has(fullId)) continue;
    seen.add(fullId);
    const entry = {
      id: fullId,
      label: m,
      provider: BUILTIN_PROVIDER,
      source: "builtin",
    };
    // `thinkingLevels` is exactly what the engine's tree supports —
    // ["off","on"] for a switchable variant toggle, the engine's effort
    // list when the model has one, and ABSENT for a forced_on model with
    // nothing user-settable (the composer then mounts no control, by
    // design). A config-layer entry with the same id has already taken
    // the slot (seen dedupe) — the operator's config wins wholesale,
    // unchanged rule.
    const proj = builtinThinking.get(m);
    if (proj) entry.thinkingLevels = [...proj.levels];
    attachContextWindowOptions(entry, builtinContextWindows.get(m));
    list.push(entry);
    builtinGroup.models.push(entry);
  }

  // Drop the empty builtin shell — a no-bundle empty group is noise.
  // The drop is gated on "no providers config" so a fresh install with
  // a config that names no models still has somewhere to attach the
  // builtins once the engine reports them.
  if (builtinGroup.models.length === 0 && !providers) {
    const idx = groups.indexOf(builtinGroup);
    if (idx >= 0) groups.splice(idx, 1);
  }

  return { list, groups };
}

/**
 * The three "what is active right now" figures #57 reports.
 *
 * `current` is the engine's value when one exists, otherwise the
 * recorded pre-session choice (`cs.model.name`, written by
 * `handleSetModel`). When neither exists the answer is `null` rather
 * than a fallback to a default model — the old behaviour invented an
 * active model the engine never confirmed, and the chip ended up
 * claiming a model the session was not actually running. The chip
 * renders a neutral label when `current` is `null` (see
 * `composer.tsx#currentModelLabel`).
 *
 * `currentThinking` prefers the engine's `thinkingEffort` option and
 * falls back to `cs.model.thinking` (the pre-session record that
 * `applyConfigOptionUpdate` refreshes). The selector reads it to
 * highlight the active level and to skip the picker when the active
 * model has no `thinkingLevels`.
 *
 * `currentContextWindow` is the recorded choice (`handleSetModel`
 * writes `cs.model.contextWindow`) with the current model's catalogue
 * `contextLimit` as fallback. There is no engine-value branch for the
 * window, deliberately: the engine's ACP surface has no context
 * channel, so the recorded pick is the only source. A recorded value
 * the current model no longer advertises is still reported verbatim —
 * the stale-pick display rule lives in the composer.
 *
 * @param {object} options
 * @param {object|null} options.sessionOption
 * @param {object} options.cs
 * @param {Array<object>} options.list  The projected flat list.
 * @returns {{current: string|null, currentThinking: string|null, currentContextWindow: number|null}}
 */
export function deriveModelSelection(options = {}) {
  const sessionOption = options.sessionOption || null;
  const cs = options.cs || {};
  const list = Array.isArray(options.list) ? options.list : [];
  const current =
    (sessionOption && sessionOption.currentValue) ||
    (cs.model && typeof cs.model.name === "string" && cs.model.name) ||
    null;
  const thinkingEffortOption = Array.isArray(cs.configOptions)
    ? cs.configOptions.find((o) => o && o.id === "thinkingEffort")
    : null;
  const currentThinking =
    (thinkingEffortOption && typeof thinkingEffortOption.currentValue === "string"
      ? thinkingEffortOption.currentValue
      : null) ||
    (cs.model && typeof cs.model.thinking === "string" && cs.model.thinking) ||
    null;
  const recordedContextWindow =
    cs.model && Number.isSafeInteger(cs.model.contextWindow) && cs.model.contextWindow > 0
      ? cs.model.contextWindow
      : null;
  const currentModelEntry = current ? list.find((m) => m.id === current) : null;
  const currentContextWindow =
    recordedContextWindow ??
    (currentModelEntry &&
    Number.isSafeInteger(currentModelEntry.contextLimit) &&
    currentModelEntry.contextLimit > 0
      ? currentModelEntry.contextLimit
      : null);
  return { current, currentThinking, currentContextWindow };
}

/**
 * The endpoint's `source` label — which of the three layers won.
 *
 * @param {object} options
 * @param {object|null} options.sessionOption
 * @param {{providers: Array<object>}|null} options.providers
 * @returns {"acp-session-config"|"config+mcode-cli-bundle"|"mcode-cli-bundle"}
 */
export function catalogueSourceLabel(options = {}) {
  const sessionOption = options.sessionOption || null;
  if (sessionOption && Array.isArray(sessionOption.options) && sessionOption.options.length > 0) {
    return "acp-session-config";
  }
  return options.providers ? "config+mcode-cli-bundle" : "mcode-cli-bundle";
}

/**
 * Compose the endpoint's response body. The key ORDER is the endpoint's
 * and is asserted by the test suite: `ok`, `models`, `groups`, the three
 * derived figures, `source`, and the soft-failure `reason` marker that
 * is spread LAST and only when the catalogue came out empty.
 *
 * The marker is backwards compatibility with the older engine-only
 * build. With the merge it should be rare (builtin catalogue +
 * providers config cover most installs), but a missing cli bundle AND
 * an absent config leave the catalogue empty — and a caller that wants
 * to know "is this a hard failure or just no engine attached?" still
 * gets the same hint.
 *
 * @param {object} options
 * @param {object|null} options.sessionOption
 * @param {{providers: Array<object>}|null} options.providers
 * @param {string[]} options.builtins
 * @param {Map} options.builtinThinking
 * @param {Map} options.builtinContextWindows
 * @param {object} options.cs
 * @param {Function} [options.parseEngineModelWireValue]
 * @returns {object} The exact #57 response body.
 */
export function buildModelCataloguePayload(options = {}) {
  const { list, groups } = projectModelCatalogue(options);
  const selection = deriveModelSelection({
    sessionOption: options.sessionOption,
    cs: options.cs,
    list,
  });
  const source = catalogueSourceLabel(options);
  return {
    ok: true,
    models: list,
    groups,
    current: selection.current,
    currentThinking: selection.currentThinking,
    currentContextWindow: selection.currentContextWindow,
    source,
    ...(list.length === 0 ? { reason: "no_catalogue" } : {}),
  };
}

/**
 * The wire-form parser used when the caller does not inject one. Only
 * ever reached from a unit test that calls `projectModelCatalogue`
 * without the engine-catalogue module; the read always injects the real
 * parser. A stub that returns `null` is the honest "not a wire form"
 * answer, which simply skips the builtin annotation — the same path a
 * plain id takes.
 */
function defaultParseWireStub() {
  return null;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * Where the catalogue's bytes came from. Always a layered `config`:
 * three sources, of which only the `custom_provider` layer is the
 * engine's, and the merged shape is webui's v2 `{providers}` view. The
 * per-entry `source` field ("engine" | "config" | "builtin") is the
 * fine-grained answer; this is the coarse one, kept so the descriptor
 * vocabulary matches the other families.
 *
 * @typedef {"config"} ModelReadSource
 */

/**
 * The #57 (`GET /api/models`) read.
 *
 * SYNCHRONOUS, deliberately — see the boot-path note in the header. The
 * route's handler signature is part of its contract: `app.js#invokeHandler`
 * accepts both shapes, but a caller that does not await gets a
 * half-written response from an async handler and a complete one from a
 * sync handler, and this batch is an absorption, not a scheduling
 * change.
 *
 * Every source is re-read on every call, exactly as before: editing
 * `models.json`, `~/.mcode-webui/providers.json` or the engine's
 * `config.yaml` must not require a server restart. The `payload` is
 * the endpoint's response body verbatim, including the soft-failure
 * `reason` marker for an empty catalogue — this facade does not convert
 * that into an error, because "no engine attached yet" is a state the
 * picker renders, not a failure.
 *
 * @param {object} [options]
 * @param {object} [options.cs]   The webui client state; `configOptions`,
 *        `model.name`, `model.thinking` and `model.contextWindow` are
 *        read from it, and the first two are echoed into the derived
 *        figures.
 * @param {string} [options.endpoint]   Endpoint key for the declaration
 *        check; defaults to `/api/models`.
 * @param {string} [options.transport]  Transport override; defaults to the
 *        active `MCODE_WEBUI_TRANSPORT`.
 * @returns {{payload: object, source: ModelReadSource, gate: object, transport: string}}
 */
export function readEngineModelCatalogue(options = {}) {
  const endpoint = options.endpoint || "GET /api/models";
  const transport = options.transport || MCODE_WEBUI_TRANSPORT;
  const gate = checkModelReadCapability(endpoint, transport);
  const cs = options.cs || {};
  const sessionOption = configOption(cs, "model");
  // The merged `{providers}` view, or `null` when every layer is
  // missing. The engine catalogue read is best-effort: a missing
  // `config.yaml` or a YAML parse error yields `[]`, and the merge
  // treats an empty engine catalogue as "no engine layer" — matching
  // the pre-ticket-06 behaviour for installs without an engine config.
  // The `try/catch` is the endpoint's own: a malformed webui layer must
  // degrade the catalogue to "webui layers only", never 500 the picker.
  let providers = null;
  try {
    const cfg = loadProvidersConfig();
    const webuiProviders = cfg && Array.isArray(cfg.providers) ? cfg.providers : [];
    const merged = mergeEngineAndWebuiProviders(readEngineCatalogue(), webuiProviders);
    if (merged.length > 0) providers = { providers: merged };
  } catch {
    providers = null;
  }
  const payload = buildModelCataloguePayload({
    sessionOption,
    providers,
    builtins: getBuiltinModelsFromMcode(),
    builtinThinking: readEngineBuiltinThinking(),
    builtinContextWindows: readEngineBuiltinContextWindows(),
    cs,
    parseEngineModelWireValue,
  });
  return { payload, source: "config", gate, transport };
}
