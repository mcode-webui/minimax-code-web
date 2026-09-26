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
//   Ticket 05 added the *write* half: webui's PUT handler now
//   projects its providers.json into the engine's `custom_provider`
//   tree (`server/lib/engine-provider-sync.js`) with the
//   `_webui_owned: true` ownership marker. Foreign entries (added
//   via `mcode provider add` or hand-edited by the operator) are
//   preserved through every sync.
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

import { getEngineConfigPath } from "./engine-provider-sync.js";

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