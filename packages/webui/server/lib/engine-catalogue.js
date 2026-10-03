// webui/server/lib/engine-catalogue.js
// READ-ONLY catalogue projection of the engine's `custom_provider` tree
// (ticket 06 — engine-catalogue-parity).
//
// Background — the bug ticket 06 pins:
//
//   The webui's `/api/models` route built its catalogue from three
//   sources — the engine's session-time `model` config option,
//   `MCODE_WEBUI_MODELS_CONFIG` (env > cwd > user-level providers.json),
//   and the mcode cli-bundle builtin extraction. None of those
//   touched the engine's `custom_provider` tree — the operator's
//   hand-typed entries in `~/.minimax/config.yaml`. The webui
//   picker therefore surfaced a handful of builtins and an empty
//   `providers.json` even when the engine had 9 configured
//   providers (minimax-cn / deepseek-cn / zai-max / zai-pro /
//   kimi-taozi / opencode-go × 3 / nousresearch) with 30+ models.
//
//   Ticket 05 added the *write* half: webui projected its
//   providers.json into the engine's `custom_provider` tree with the
//   `_webui_owned: true` ownership marker. M3-B11 made that tree the
//   STORE rather than a projection of a second file
//   (`server/engine/provider-store.js`), so this module's read below
//   is of the primary source rather than of a mirror. Foreign entries
//   (added via `mcode provider add` or hand-edited by the operator)
//   are still preserved through every write — the ownership rule did
//   not move with the file.
//
//   Ticket 06 closes the loop on the *read* half: the same tree is
//   also a catalogue source for `/api/models`. Webui-only fields
//   (label, baseURL, model metadata, masking discipline) come from
//   the webui's own providers.json layer; engine-side fields
//   (the operator's manual providers, model lists, the
//   `thinking.effortOptions` / `limit.context` / `modalities.input`
//   metadata the engine already validates) come from
//   `custom_provider`. The two layers are merged.
//
// Security contract (pinned by tests):
//
//   - READ-ONLY. This module never writes to the engine's
//     `config.yaml`. Ticket 05's write side stays the sole
//     authority on engine-side persistence.
//
//   - Zero key material in any return value. The engine stores
//     apiKey as plaintext in `options.apiKey`; this projection
//     drops the field. The only auth fields returned are
//     `type` (always "byok"; engine `coding-plan` is not a
//     `custom_provider` shape) and `hasKey` (true when the
//     engine-side entry has a non-empty apiKey — so a UI can
//     render the configured/greyed state). `apiKeyMasked` and
//     `baseURL` are NEVER part of the engine-side projection
//     because the engine's secrets live at its own baseURL; the
//     webui shows them only when an operator's webui layer
//     already carries them.
//
// Merge rule (pinned by tests):
//
//   Layers (lowest to highest):
//     1. engine `custom_provider`  (read-only, foreign + webui-owned alike)
//     2. webui env    `MCODE_WEBUI_MODELS_CONFIG` (deployment)
//     3. webui cwd    `<cwd>/models.json`
//     4. webui user   `~/.mcode-webui/providers.json`
//
//   Same-id provider — webui wins (per-field merge, with webui scalar
//   fields taking precedence; engine-side fields fill in undefined
//   webui values). This lets an operator's webui edits override
//   display metadata (label, baseURL, model lists) without losing
//   the engine's "configured reality" when the operator's webui
//   layer is missing a provider.
//
//   Models inside a same-id provider: union-by-id, webui model wins
//   on id collision. The engine's `thinking.effortOptions` /
//   `modalities.input` / `limit.context` show up on models the webui
//   layer hasn't overridden; the webui layer's metadata wins when
//   the operator has set one.
//
//   Rationale (matching ticket 06's suggestion):
//     - "engine entries represent configured reality" → engine
//       entries supply providers the webui doesn't know about
//       (foreign + webui-owned alike, all of them);
//     - "webui user-layer wins collisions" → operators editing the
//       providers dialog can override display metadata without
//       touching the engine tree.
//
//   Protocol mapping (engine `api` → webui `protocol`):
//     openai-completions  → openai
//     openai-responses    → openai   (engine custom_provider accepts
//                                    both; webui does not differentiate
//                                    in its protocol enum — both are
//                                    reachable through the OpenAI SDK)
//     anthropic-messages  → anthropic
//     anything else       → "openai" (the most permissive fallback
//                                    — same default ticket 01 picked
//                                    for v1 records without protocol)

import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";

import { getEngineConfigPath } from "../engine/provider-store.js";

// =====================================================================
// Builtin-model thinking projection (ticket 36 — builtin-thinking-levels).
// =====================================================================
//
// Background — the bug ticket 36 pins:
//
//   The engine keeps TWO thinking schemas. Custom providers use the
//   effort shape (`thinking: { effortOptions: [...] }`) and the
//   projection above handles it. The builtin MiniMax catalogue uses
//   the variant shape, which the engine materialises into the SAME
//   config.yaml under `provider.minimax.models`:
//
//     MiniMax-M3:
//       thinking_config:
//         mode: switchable          # switchable | forced_on | forced_off | hidden
//         default_value: 'true'
//       variants:
//         none-thinking: { thinking: { type: disabled } }
//         thinking:        { thinking: { type: adaptive } }
//       thinking:                    # effort shape — M3.1-Flash carries
//         effortOptions: [...]       # BOTH (forced_on + real depths)
//
//   The catalogue only projected the effort shape, so every
//   `minimax_api` builtin — including MiniMax-M3 — surfaced with no
//   `thinkingLevels` and the composer never mounted the thinking
//   control for MiniMax's own models.
//
// Honesty rules this projection is pinned to:
//
//   - A switchable model with off+on variants is a TWO-STATE toggle.
//     It projects to exactly ["off","on"] — never a fabricated
//     off/low/medium/high scale. The depth vocabulary belongs to the
//     effort schema only.
//   - `forced_on` with no effortOptions has nothing user-settable
//     (thinking cannot be turned off, no depth to pick) → null. No
//     control. Same for `forced_off` / `hidden` / no thinking keys.
//   - `effortOptions`, when present, wins regardless of mode: those
//     are the engine's real effort values, passed through verbatim
//     (same hygiene as the custom_provider path).
//   - The level→variant map is DERIVED from the engine's variant
//     tree (the disabled side vs the adaptive side), not from
//     hard-coded variant names.

/**
 * Project one engine builtin model config (`provider.minimax.models`
 * entry) onto the webui thinking vocabulary. Pure.
 *
 * Returns `null` when the model exposes nothing user-settable.
 * Otherwise:
 *   - effort channel:  `{ levels: string[] }`
 *     (`levels` is `thinking.effortOptions`, filtered and verbatim;
 *     sync happens through the engine's `thinkingEffort` option)
 *   - variant channel: `{ levels: ["off","on"],
 *                        variant: { off: string, on: string },
 *                        defaultLevel: "off" | "on" }`
 *     (`variant` maps the webui level to the engine's variant name,
 *     derived from which variant disables thinking; `defaultLevel`
 *     mirrors the engine's `defaultThinkingVariant` — default_value
 *     'true' → "on", anything else → "off". Sync happens through a
 *     model selection that carries the variant, because the engine
 *     rejects `thinkingEffort` for models without effortOptions.)
 */
export function thinkingFromEngineBuiltinModel(modelConfig) {
  if (!modelConfig || typeof modelConfig !== "object") return null;
  // Effort shape first — it is the engine's own depth vocabulary and
  // takes precedence over the variant dimension whenever present.
  const thinking =
    modelConfig.thinking && typeof modelConfig.thinking === "object"
      ? modelConfig.thinking
      : null;
  if (thinking && Array.isArray(thinking.effortOptions)) {
    const levels = thinking.effortOptions.filter(
      (x) => typeof x === "string" && x.length > 0,
    );
    if (levels.length > 0) return { levels };
  }
  // Variant shape — only a switchable mode gives the user a choice.
  const config =
    modelConfig.thinking_config &&
    typeof modelConfig.thinking_config === "object"
      ? modelConfig.thinking_config
      : null;
  if (!config || config.mode !== "switchable") return null;
  const variants =
    modelConfig.variants && typeof modelConfig.variants === "object"
      ? modelConfig.variants
      : null;
  if (!variants) return null;
  // The engine's variant tree names the disabled side "none-thinking"
  // and the enabled side "thinking" — but we derive the map from the
  // shape (which variant DISABLES thinking), so a renamed or extra
  // variant still lands on the right side.
  let offVariant = null;
  let onVariant = null;
  for (const [name, v] of Object.entries(variants)) {
    if (!v || typeof v !== "object") continue;
    const t = v.thinking && typeof v.thinking === "object" ? v.thinking : null;
    if (t && t.type === "disabled") {
      if (offVariant === null) offVariant = name;
    } else if (onVariant === null) {
      onVariant = name;
    }
  }
  // Half a toggle is not a toggle — require both sides.
  if (offVariant === null || onVariant === null) return null;
  return {
    levels: ["off", "on"],
    variant: { off: offVariant, on: onVariant },
    // Mirror the engine's defaultThinkingVariant: only the literal
    // 'true' enables thinking by default.
    defaultLevel: config.default_value === "true" ? "on" : "off",
  };
}

/**
 * Read the engine's materialised builtin model tree
 * (`provider.minimax.models` in the engine config.yaml), verbatim.
 *
 * Shared file reader for the per-feature builtin projections
 * (`readEngineBuiltinThinking`, `readEngineBuiltinContextWindows`) so
 * the yaml parse and the tree walk live in exactly one place. Returns
 * `null` when the file is missing, unparseable, or the tree is the
 * wrong shape — callers treat that as "no builtin metadata", matching
 * the best-effort contract documented on each projection.
 *
 * Security: the record is the raw `provider.minimax.models` subtree.
 * It carries no key material, and the feature projections below only
 * read their own fields out of it.
 */
function readEngineBuiltinModelsRecord(configPath) {
  if (!existsSync(configPath)) return null;
  let parsed;
  try {
    const raw = readFileSync(configPath, "utf8");
    const doc = yaml.load(raw);
    parsed = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch {
    return null;
  }
  const provider = parsed.provider;
  const minimax =
    provider && typeof provider === "object" && !Array.isArray(provider)
      ? provider.minimax
      : null;
  const models =
    minimax && typeof minimax === "object" && !Array.isArray(minimax)
      ? minimax.models
      : null;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  return models;
}

/**
 * Read the engine's materialised builtin catalogue
 * (`provider.minimax.models` in the engine config.yaml) and project
 * each model's thinking schema. Returns a Map keyed by the BARE
 * model id (e.g. "MiniMax-M3") → projection-or-null. Models with
 * nothing user-settable stay keyed with a null value so callers can
 * distinguish "the engine says no control" from "unknown model".
 *
 * Best-effort like readEngineCatalogue: missing file, parse error,
 * or a wrong-shape tree all yield an empty Map — the route treats
 * that as "no builtin thinking metadata" (the pre-ticket-36
 * behaviour), never a 500. Reads the file once per call so an
 * operator's hand edit shows up on the next /api/models request.
 *
 * Security: only the thinking-related subtrees are projected; the
 * builtin tree carries no key material, but the reader never touches
 * anything outside `provider.minimax.models` anyway.
 */
export function readEngineBuiltinThinking(opts = {}) {
  const out = new Map();
  const models = readEngineBuiltinModelsRecord(
    opts.configPath || getEngineConfigPath(),
  );
  if (!models) return out;
  for (const [modelId, modelConfig] of Object.entries(models)) {
    if (typeof modelConfig !== "object" || modelConfig === null) continue;
    out.set(modelId, thinkingFromEngineBuiltinModel(modelConfig));
  }
  return out;
}

// =====================================================================
// Context-window options (U6) — builtin projection, same tree as the
// thinking projection above.
// =====================================================================

/**
 * Project one engine builtin model config onto the webui context-window
 * vocabulary. Pure.
 *
 * The engine materialises two optional keys per builtin model
 * (`provider.minimax.models.<id>` in the engine config.yaml):
 *
 *   contextWindowOptions:       [512000, 1000000]
 *   contextWindowOptionHints:   { "1000000": "higher_usage" }
 *
 * Hygiene rules, mirroring the engine's own `contextWindowOptions()`
 * helper (packages/tui/src/tui/features/model/context-window.ts):
 *
 *   - Options are Set-deduped in engine order, keeping only safe
 *     positive integers. Engine order is presentation order — do not
 *     sort.
 *   - Hints survive only for keys that name a KEPT option and only
 *     for the one value the engine emits today (`higher_usage`);
 *     anything else is dropped rather than passed through verbatim.
 *   - Fewer than two distinct options means the engine's own pickers
 *     mount no control (the TUI requires `length > 1`); the projection
 *     still reports what the tree says and lets the route/UI apply
 *     that gate, so the data and the gating rule stay separable.
 *   - `limit.context`, when a safe positive integer, rides along as
 *     `currentLimit`: the engine's CURRENT window for the model (its
 *     catalog default or an applied override). The /api/models route
 *     uses it as the radio's fallback active value so the picker shows
 *     the truth before the user's first in-webui pick.
 *
 * Returns `null` when the model advertises no usable options.
 */
export function contextWindowFromEngineBuiltinModel(modelConfig) {
  if (!modelConfig || typeof modelConfig !== "object") return null;
  const rawOptions = Array.isArray(modelConfig.contextWindowOptions)
    ? modelConfig.contextWindowOptions
    : [];
  const options = [
    ...new Set(
      rawOptions.filter(
        (v) => Number.isSafeInteger(v) && v > 0,
      ),
    ),
  ];
  if (options.length === 0) return null;
  const rawHints =
    modelConfig.contextWindowOptionHints &&
    typeof modelConfig.contextWindowOptionHints === "object" &&
    !Array.isArray(modelConfig.contextWindowOptionHints)
      ? modelConfig.contextWindowOptionHints
      : {};
  const hints = {};
  for (const value of options) {
    if (rawHints[String(value)] === "higher_usage") {
      hints[String(value)] = "higher_usage";
    }
  }
  const currentLimit =
    modelConfig.limit &&
    typeof modelConfig.limit === "object" &&
    Number.isSafeInteger(modelConfig.limit.context) &&
    modelConfig.limit.context > 0
      ? modelConfig.limit.context
      : undefined;
  return {
    options,
    ...(Object.keys(hints).length > 0 ? { hints } : {}),
    ...(currentLimit !== undefined ? { currentLimit } : {}),
  };
}

/**
 * Read the engine's materialised builtin catalogue and project each
 * model's context-window options. Same file, same best-effort contract
 * and security envelope as `readEngineBuiltinThinking` — see there.
 *
 * Returns a Map keyed by the BARE model id → `{ options, hints? }` for
 * models that advertise usable options; models without any stay keyed
 * with a `null` value (same "engine says no control" vs "unknown
 * model" distinction as the thinking reader).
 */
export function readEngineBuiltinContextWindows(opts = {}) {
  const out = new Map();
  const models = readEngineBuiltinModelsRecord(
    opts.configPath || getEngineConfigPath(),
  );
  if (!models) return out;
  for (const [modelId, modelConfig] of Object.entries(models)) {
    if (typeof modelConfig !== "object" || modelConfig === null) continue;
    out.set(modelId, contextWindowFromEngineBuiltinModel(modelConfig));
  }
  return out;
}

// =====================================================================
// Variant channel (ticket 36) — wire translation for switchable builtins.
// =====================================================================

/** The builtin provider prefix the webui catalogue uses for engine builtins. */
const BUILTIN_PROVIDER_PREFIX = "minimax_api/";

/**
 * Parse the engine's model wire value
 * (`m:<encodedProvider>:<encodedModel>:u` or
 * `m:<encodedProvider>:<encodedModel>:v:<encodedVariant>`) into its
 * parts, URL-decoding each segment.
 *
 * Returns `{ providerId, modelId, variant }` (variant `undefined`
 * for the unqualified `:u` form) or `null` when the value isn't in
 * the wire shape. Mirrors the engine's `parseModelConfigValue`
 * (packages/tui/src/acp/control-state.ts) for the shapes the engine
 * actually emits. Colons inside the encoded segments are
 * URL-encoded away by the engine's `modelConfigValue`, so a plain
 * split is structurally safe.
 *
 * Lives here (not in mcode-acp.js) because it is pure engine-shape
 * knowledge with no runtime-graph dependency — the /api/models route
 * annotates engine entries with it without pulling the acp client.
 */
export function parseEngineModelWireValue(wireValue) {
  if (typeof wireValue !== "string" || !wireValue) return null;
  // Two shapes: `m:<provider>:<model>:u` (4 parts, unqualified) and
  // `m:<provider>:<model>:v:<variant>` (5 parts). Anything longer is
  // not a shape the engine emits (its parseModelConfigValue rejects
  // trailing extra segments) — treat it as a non-match.
  const parts = wireValue.split(":");
  if (parts[0] !== "m") return null;
  const decode = (segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  const providerId = parts[1];
  const modelId = parts[2];
  if (typeof providerId !== "string" || !providerId) return null;
  if (typeof modelId !== "string" || !modelId) return null;
  if (parts.length === 4 && parts[3] === "u") {
    return { providerId: decode(providerId), modelId: decode(modelId), variant: undefined };
  }
  if (parts.length === 5 && parts[3] === "v" && parts[4]) {
    return {
      providerId: decode(providerId),
      modelId: decode(modelId),
      variant: decode(parts[4]),
    };
  }
  return null;
}

/**
 * The engine model key from a webui id — everything after the first
 * `/` (`minimax_api/MiniMax-M3` → `MiniMax-M3`; a bare name stays
 * whole). Local twin of mcode-acp.js#engineModelKeyFromId so this
 * helper stays dependency-free.
 */
function engineModelKey(id) {
  if (typeof id !== "string" || !id) return id;
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Variant-channel plan for a model id (ticket 36), or null.
 *
 * The plan exists only when the engine's materialised builtin tree
 * (`provider.minimax.models`) describes a switchable variant toggle
 * for the model AND the id belongs to the builtin provider
 * (`minimax_api/<model>` or a bare `<model>` name). A custom
 * provider's model that merely shares a model id never rides this
 * channel.
 *
 * Shape: `{ variant: { off, on }, defaultLevel, level(thinking) }`
 * where `level()` normalises a recorded thinking string ("on"/"off"
 * case-insensitive; anything stale falls back to the engine default)
 * to one of the two webui levels.
 */
export function variantChannelFor(modelId) {
  if (typeof modelId !== "string" || !modelId) return null;
  if (modelId.includes("/") && !modelId.startsWith(BUILTIN_PROVIDER_PREFIX)) {
    return null;
  }
  const bare = engineModelKey(modelId);
  const projection = readEngineBuiltinThinking().get(bare);
  if (!projection || !projection.variant) return null;
  return {
    variant: projection.variant,
    defaultLevel: projection.defaultLevel,
    level(thinking) {
      const t = typeof thinking === "string" ? thinking.trim().toLowerCase() : "";
      if (t === "on" || t === "off") return t;
      return this.defaultLevel;
    },
  };
}


// =====================================================================
// Webui id → engine option.value resolution (moved from mcode-acp.js,
// ticket 36: pure id translation with no runtime-graph dependency, so
// the /api/models route can resolve variant wire forms without pulling
// the acp client).
// =====================================================================

/**
 * Resolve the recorded id to one of the engine's option.values.
 *
 * Three match paths, in order:
 *
 *   1. Exact `option.value` match. Covers the engine wire form
 *      (`m:minimax:MiniMax-M3:u`, `m:custom_provider%3A<key>:<model>:u`)
 *      and any webui-recorded form that happens to equal the engine
 *      wire value verbatim.
 *
 *   2. Webui `<providerKey>/<engineModelKey>` → engine-model-key match.
 *      The webui id is structurally `<providerKey>/<engineModelKey>`
 *      where `engineModelKey` may itself contain `/` (the engine
 *      allows `/` inside model keys; the wire form's `/` is the
 *      structural separator between provider and model). The engine
 *      populates `option.name` from `displayName ?? modelId`, so for
 *      models without a separate displayName `option.name === engineModelKey`
 *      and the recorded id's segment-after-first-`/` matches it.
 *      This is the case ticket 09-02 ships for (upstream catalogue
 *      ids like `nousresearch/deepseek/x` → engine model key `deepseek/x`).
 *
 *   3. Last-segment fallback for legacy forms. `lastSegment(recorded)`
 *      returns the segment after the LAST `/` or `:`. This is the
 *      pre-ticket-09-02 fallback path and is preserved for callers
 *      that recorded `custom_provider:byok-zhipu/glm-5.3` or
 *      `minimax_api/MiniMax-M3` — those resolve to the bare model
 *      name `glm-5.3` / `MiniMax-M3`, which the engine's `option.name`
 *      carries.
 *
 * The match is case-insensitive (ticket 05). Multiple matches return
 * null — ambiguity is ambiguity, and the caller skips rather than
 * pick the wrong option.
 *
 * `opts.preferVariant` (ticket 36): when the caller knows which
 * thinking variant it wants (the variant channel for switchable
 * builtins), a multi-match candidate set is narrowed to the options
 * whose wire value carries exactly that variant. This collapses the
 * deliberate ambiguity of a variant model — the engine advertises
 * `m:...:v:thinking` AND `m:...:v:none-thinking`, both resolving to
 * the same bare name — without changing any outcome for models the
 * engine advertises in bare form only. A preferVariant that matches
 * nothing advertised falls through to the normal resolution.
 */
export function resolveModelId(recorded, modelOption, opts = {}) {
  if (!modelOption || !Array.isArray(modelOption.options)) return null;
  const options = modelOption.options.filter(
    (o) => o && typeof o === "object" && typeof o.value === "string",
  );
  // (1) Direct value match — engine wire form, or a webui id that
  // happens to equal an `option.value` verbatim.
  for (const o of options) {
    if (o.value === recorded) return o.value;
  }
  const preferVariant =
    typeof opts.preferVariant === "string" && opts.preferVariant
      ? opts.preferVariant
      : null;
  // Variant-aware narrowing (ticket 36): among an ambiguous candidate
  // set, keep the one option whose wire value carries the wanted
  // variant. Returns null when preferVariant is unset or narrows to
  // nothing/ambiguous — the caller then follows the pre-ticket-36
  // outcome for that pass.
  const byPreferredVariant = (candidates) => {
    if (!preferVariant) return null;
    const picked = candidates.filter((o) => {
      const wire = parseEngineModelWireValue(o.value);
      return wire !== null && wire.variant === preferVariant;
    });
    return picked.length === 1 ? picked[0].value : null;
  };
  // Branch on the structural shape of `recorded`. The webui id
  // form (ticket 09-02) is `<providerKey>/<engineModelKey>` — the
  // engine model key is everything after the FIRST `/`. Legacy
  // forms (`minimax_api/MiniMax-M3`, `custom_provider:byok-zhipu/glm-5.3`)
  // and bare names fall back to the last-segment match.
  const slash = typeof recorded === "string" ? recorded.indexOf("/") : -1;
  let bareName = null;
  if (slash >= 0) {
    // `<providerKey>/<engineModelKey>` form (engineModelKey may
    // itself contain `/`). The engine populates `option.name` from
    // `displayName ?? modelId` and appends ` · <variant>` when the
    // option advertises a variant (see packages/tui/src/acp/
    // control-state.ts#uniqueModelValues). The webui doesn't
    // surface variant in its id — the variant is a separate
    // concept the engine carries. We try the raw name first
    // (most options have no variant suffix), then fall back to
    // the variant-suffix-stripped name — so a recorded webui id
    // lands on the option whether the engine is offering the bare
    // or the variant form, and prefers the bare form when both
    // are advertised (the engine's default).
    bareName = recorded.slice(slash + 1);
  } else if (typeof recorded === "string" && recorded) {
    // Bare name or legacy colon form. `lastSegment` covers both.
    bareName = lastSegment(recorded);
  }
  if (!bareName) return null;
  const bareLower = bareName.toLowerCase();
  // First pass: prefer options whose name matches the bare form
  // exactly (covers `displayName === bareName`, no variant).
  const exact = options.filter(
    (o) => typeof o.name === "string" && o.name.toLowerCase() === bareLower,
  );
  if (exact.length === 1) return exact[0].value;
  if (exact.length > 1) {
    // Ticket 36: a variant model's options share the bare name —
    // narrow by the wanted variant before declaring ambiguity.
    const v = byPreferredVariant(exact);
    if (v !== null) return v;
    return null;
  }
  // Second pass: options whose name has the engine's ` · <variant>`
  // suffix stripped to bare. Only kicks in when no exact match
  // exists — so a multi-variant engine option set doesn't get
  // collapsed to an ambiguous answer.
  const stripped = options.filter(
    (o) =>
      typeof o.name === "string" &&
      stripVariantSuffix(o.name).toLowerCase() === bareLower,
  );
  if (stripped.length === 1) return stripped[0].value;
  if (stripped.length > 1) {
    const v = byPreferredVariant(stripped);
    if (v !== null) return v;
  }
  // Third pass: URL-decode the `option.value` (the engine wire
  // form is `m:<encodedProvider>:<encodedModel>:u|v:<variant>`)
  // and compare the engine model id verbatim. This catches the
  // case where `option.name` is the engine's `displayName` and
  // differs from the model id — e.g. an upstream catalogue
  // carries a router-style model id (`deepseek/deepseek-v4.1-flash`)
  // with a separate display name (`DeepSeek V4.1 Flash`); the
  // webui records the model id verbatim, but the engine's
  // `option.name` is the display name. The wire-form decode
  // recovers the model id and matches it.
  const decoded = options.filter((o) => {
    const wire = parseEngineModelWireValue(o.value);
    return wire !== null && wire.modelId.toLowerCase() === bareLower;
  });
  if (decoded.length === 1) return decoded[0].value;
  if (decoded.length > 1) {
    const v = byPreferredVariant(decoded);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Strip the engine's ` · <variant>` suffix from an `option.name`.
 *
 * The engine composes `option.name` as
 * `${displayName ?? modelId}${variant ? " · " + variant : ""}`
 * (packages/tui/src/acp/control-state.ts#uniqueModelValues). The
 * webui doesn't track variants in its id — they're a runtime-only
 * concern — so a bare webui id never carries the suffix. Stripping
 * before matching keeps the webui→engine translation round-trip
 * alive even when the engine is offering only the variant form.
 */
function stripVariantSuffix(name) {
  const i = name.indexOf(" · ");
  return i >= 0 ? name.slice(0, i) : name;
}

/** Last segment after `/` or `:` — `minimax_api/MiniMax-M3` → `MiniMax-M3`.
 *
 * Legacy fallback for callers that recorded a form where the model id
 * is the segment after the LAST separator. Kept for backward
 * compatibility (and pinned by `lastSegment` tests); ticket 09-02
 * prefers `engineModelKeyFromId` for the new `<providerKey>/<modelId>`
 * webui form.
 */
export function lastSegment(id) {
  const i = Math.max(id.lastIndexOf("/"), id.lastIndexOf(":"));
  return i >= 0 ? id.slice(i + 1) : id;
}

// =====================================================================
// Engine api → webui protocol mapping.
// =====================================================================

/**
 * Map an engine `custom_provider` entry's `api` field to the webui
 * `protocol` enum (`openai | anthropic | gemini`). The engine's own
 * `normalizeApiFormat` accepts a slightly wider set (e.g. it
 * distinguishes `openai-completions` and `openai-responses`); the
 * webui treats both as `openai` — the engine-side wire format detail
 * does not surface to the picker.
 *
 * Pure.
 */
export function engineApiToWebuiProtocol(api) {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "openai-completions" || api === "openai-responses") return "openai";
  // Unknown / missing — fall back to the most permissive protocol.
  // The webui v1 default for legacy records without a protocol
  // (ticket 01) is `openai`, and the picker is identical between
  // openai and unknown from a user perspective.
  return "openai";
}

// =====================================================================
// Engine entry → webui v2 provider projection.
// =====================================================================

/**
 * Project one engine `custom_provider` entry (and its `models`
 * sub-map) into the webui v2 shape. Pure.
 *
 * Returns `null` when the entry is not a usable byok provider — the
 * catalogue surface only shows providers the engine actually serves
 * (engine has apiKey, kind === 'custom', enabled !== false). The
 * exclusion set is deliberately narrow so the picker can show as
 * much of the operator's hand-typed config as possible; the dialog
 * can disable a provider via the webui side.
 *
 * Output shape (matches `normaliseProvider()` from
 * providers-config.js):
 *   {
 *     id, label,
 *     enabled,            // mirrors engine's `enabled` (defaults true)
 *     protocol,            // from `engineApiToWebuiProtocol(api)`
 *     auth: { type, hasKey },
 *     models: [{ id, label, contextLimit?, thinkingLevels?, modalities? }]
 *   }
 *
 * Security: apiKey / apiKeyMasked / baseURL NEVER appear. The webui's
 * own providers.json layer carries those for any provider an operator
 * configures through the dialog; the engine-side projection is
 * display-only.
 */
export function fromEngineCustomProviderEntry(engineKey, entry) {
  if (!entry || typeof entry !== "object") return null;
  // Engine kinds we never want in the catalogue. `custom` is the
  // byok shape the engine accepts from the webui PUT; everything
  // else (an internal `provider` tree under the engine's `provider.*`
  // namespace, future reserved kinds) is out of scope for the
  // picker.
  if (entry.kind && entry.kind !== "custom") return null;
  // Engine stores the apiKey under `options.apiKey`. `hasKey` is a
  // boolean — we deliberately do not expose the value or a mask of
  // it; the engine's secret is the engine's. The webui's own layer
  // (when it carries the same provider id) supplies the masking for
  // the merged view; without it, `hasKey` is the only signal the
  // picker can render.
  const apiKey =
    entry.options && typeof entry.options.apiKey === "string"
      ? entry.options.apiKey.trim()
      : "";
  const hasKey = apiKey.length > 0;
  // Engine may set `enabled: false` to hide an entry from the
  // engine's own picker. Honour that on the webui side too — a
  // "disabled in the engine" provider has no working model to pick.
  if (entry.enabled === false) return null;
  const protocol = engineApiToWebuiProtocol(entry.api);
  const label =
    typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : engineKey;
  const modelsIn = entry.models && typeof entry.models === "object" ? entry.models : {};
  const models = [];
  for (const [modelKey, m] of Object.entries(modelsIn)) {
    if (!m || typeof m !== "object") continue;
    const out = {
      id: modelKey,
      label:
        typeof m.name === "string" && m.name.trim() && m.name.trim() !== modelKey
          ? m.name.trim()
          : modelKey,
    };
    // Engine `limit.context` → webui `contextLimit`
    if (m.limit && typeof m.limit.context === "number" && m.limit.context > 0) {
      out.contextLimit = m.limit.context;
    }
    // Engine `thinking.effortOptions` → webui `thinkingLevels`.
    // The engine stores the array verbatim — every entry is a
    // string the engine accepts on the `thinkingEffort` config
    // option (low / medium / high / max / off / none / xhigh).
    if (
      m.thinking &&
      Array.isArray(m.thinking.effortOptions) &&
      m.thinking.effortOptions.length > 0
    ) {
      const filtered = m.thinking.effortOptions.filter(
        (x) => typeof x === "string" && x.length > 0,
      );
      if (filtered.length > 0) out.thinkingLevels = filtered;
    }
    // Engine `modalities.input` → webui `modalities`. The engine
    // records both `input` and `output`; webui v2 only annotates
    // input (output is text by default — see provider-presets.js).
    if (
      m.modalities &&
      Array.isArray(m.modalities.input) &&
      m.modalities.input.length > 0
    ) {
      const filtered = m.modalities.input.filter(
        (x) => typeof x === "string" && x.length > 0,
      );
      if (filtered.length > 0) out.modalities = filtered;
    }
    models.push(out);
  }
  return {
    id: engineKey,
    label,
    enabled: entry.enabled !== false,
    protocol,
    auth: {
      type: "byok",
      hasKey,
    },
    models,
  };
}

// =====================================================================
// File read.
// =====================================================================

/**
 * Read the engine's `custom_provider` tree and project it to an
 * array of webui v2 provider records (no key material).
 *
 * Returns `[]` on a missing file, an unreadable file, or a parse
 * error. The route never crashes on a missing engine config — a
 * fresh install without `config.yaml` should still serve an empty
 * catalogue, not a 500.
 *
 * Pure from the caller's perspective: same input → same output.
 * The filesystem is read once per call (the route reads on every
 * request, mirroring `loadProvidersConfig()`'s re-read behaviour so
 * an operator's hand edit to `config.yaml` shows up at the next
 * /api/models call without a restart).
 */
export function readEngineCatalogue(opts = {}) {
  const configPath = opts.configPath || getEngineConfigPath();
  if (!existsSync(configPath)) return [];
  let parsed;
  try {
    const raw = readFileSync(configPath, "utf8");
    const out = yaml.load(raw);
    parsed = out && typeof out === "object" && !Array.isArray(out) ? out : {};
  } catch {
    // YAML parse error — the engine will surface this on its next
    // read; we'd rather serve an empty catalogue than a 500. The
    // /api/models caller already handles an empty catalogue (the
    // builtin cli-bundle is a separate source).
    return [];
  }
  const custom = parsed.custom_provider;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return [];
  const out = [];
  for (const [key, entry] of Object.entries(custom)) {
    const proj = fromEngineCustomProviderEntry(key, entry);
    if (proj) out.push(proj);
  }
  return out;
}

// =====================================================================
// Layered merge.
// =====================================================================

/**
 * Merge an engine-side catalogue (lowest priority) with the
 * webui's layered providers (highest priority on collision).
 *
 * Layer order matches `loadProvidersConfig()` exactly — same shape,
 * same precedence:
 *
 *   [ engine, userLevel, cwdLayer, envLayer ]  (lowest → highest)
 *
 * The engine catalogue is the new bottom layer; `loadProvidersConfig`
 * already gives us [user, cwd, env] (lowest → highest), so the
 * caller passes `[engineCatalogue, ...webui.providers]` for the
 * merge. Each input is a `providers[]` array; missing inputs become
 * empty arrays.
 *
 * Same-id provider — webui wins (per-field merge). The merge is
 * "higher layer replaces lower layer wholesale; same id is then
 * field-merged" — the model is the same as `mergeProvider()` in
 * providers-config.js, lifted to operate on the engine-side
 * projection too. See the file header for the rationale.
 *
 *   - id / label / protocol — higher layer wins verbatim (operator's
 *     label override is the whole point of having a webui layer).
 *   - enabled — higher layer wins (operator can disable a
 *     engine-configured provider via the dialog).
 *   - auth.type — higher layer wins.
 *   - auth.hasKey — OR of both: `true` when EITHER layer has a key.
 *     Rationale: the engine layer says "the engine has an apiKey" and
 *     the webui layer says "the user has an apiKey"; both true
 *     answers must surface `hasKey: true` so the picker renders the
 *     configured state. A `hasKey: false` in the higher layer does
 *     NOT override `hasKey: true` from the engine — the engine's
 *     secret is the source of truth for "engine-can-drive-it", and
 *     the dialog may legitimately have no webui-side key yet (the
 *     operator could be picking a model whose key was injected via
 *     `mcode provider add` on the engine CLI).
 *   - models — union by id; higher-layer model wins on id collision.
 *
 * The function is pure: no IO, no mutation of inputs.
 */
export function mergeEngineAndWebuiProviders(engineCatalogue, webuiCatalogue) {
  const layers = [
    Array.isArray(engineCatalogue) ? engineCatalogue : [],
    Array.isArray(webuiCatalogue) ? webuiCatalogue : [],
  ];
  // `mergeProviderLists` already gives "later index > earlier index"
  // semantics. We pass [engine, webui] so the webui layer (already
  // user > cwd > env resolved inside `loadProvidersConfig`) wins
  // every collision.
  const byId = new Map();
  for (const layer of layers) {
    for (const p of layer) {
      if (!p || !p.id) continue;
      const existing = byId.get(p.id);
      if (!existing) {
        byId.set(p.id, cloneProvider(p));
        continue;
      }
      byId.set(p.id, mergeProviderPair(existing, p));
    }
  }
  return [...byId.values()];
}

function cloneProvider(p) {
  return {
    ...p,
    auth: { ...p.auth },
    models: Array.isArray(p.models) ? p.models.map((m) => ({ ...m })) : [],
  };
}

/**
 * Merge a lower-layer provider (`prev`) with a higher-layer
 * provider (`next`). Mirrors `mergeProvider()` from
 * providers-config.js — kept as a private helper here because the
 * fields we have to merge differ (no apiKey on the engine side; no
 * baseURL on either side; different `enabled` defaults).
 */
function mergeProviderPair(prev, next) {
  const modelById = new Map();
  for (const m of prev.models || []) modelById.set(m.id, m);
  for (const m of next.models || []) modelById.set(m.id, m);
  return {
    id: next.id,
    label: next.label || prev.label,
    preset: next.preset ?? prev.preset,
    enabled: typeof next.enabled === "boolean" ? next.enabled : prev.enabled,
    protocol: next.protocol || prev.protocol || "openai",
    auth: {
      // auth.type defaults to "byok" — the engine-side projection
      // always uses byok (engine `coding-plan` is not a
      // custom_provider shape), and the webui layer also defaults
      // to byok. See providers-config.js#normaliseProvider.
      type: next.auth?.type || prev.auth?.type || "byok",
      // OR semantics: if either layer says the provider is
      // configured with a key, the merged view says the same.
      // See file header for the rationale.
      hasKey: !!(prev.auth?.hasKey || next.auth?.hasKey),
    },
    models: [...modelById.values()],
  };
}