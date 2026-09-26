// webui/server/lib/provider-presets.js
// Built-in provider templates (ticket 02 — preset providers).
//
// Why this module exists: the v2 providers-config schema in
// `lib/providers-config.js` is open-ended — any provider shape that
// passes `normaliseProvider()` can land in the user-level file. A
// user-facing "preset" gallery needs a closed set of curated
// templates so the UI can present them as a list of "one-click
// enable" choices, with sensible defaults and metadata we
// deliberately sourced from public documentation rather than
// guessed.
//
// Design constraints:
//
//   1. Presets are DATA, not behaviour. Each template is a plain
//      object literal that, after `normaliseProvider()` validates
//      it, becomes a record in the user-level file. There is no
//      special-case code path downstream — enabled presets flow
//      through the same load + mask + SSE pipeline that custom
//      providers do. (`POST /api/providers/preset/:id/enable` is
//      just `writeProvidersConfig()` with the template prepended.)
//
//   2. Presets never carry key material. The `auth.apiKey` field is
//      always the empty string at the template layer. The user
//      fills it after enable; until then `hasKey` is false and
//      `apiKeyMasked` is empty. A regression that bundled a key
//      here would ship a credential that anyone can read from the
//      public template — pinned by tests, by comment, and by the
//      "presets have empty apiKey" rule at the bottom of this file.
//
//   3. Protocol choices reflect the engine's wire-protocol support
//      (`openai | anthropic | gemini` per `lib/providers-config.js`
//      `ALLOWED_PROTOCOLS`). Providers whose public API is
//      OpenAI-compatible (most LLM gateways) map to "openai";
//      Anthropic-direct maps to "anthropic". The "Codex" and
//      "opencode go" templates use the protocol the engine can
//      drive through its ordinary BYOK path, not the OAuth
//      transports the engine also supports — the OAuth paths are a
//      different code path and out of scope for the
//      preset-template gallery.
//
//   4. Auth-type choices reflect the credential shape the user is
//      expected to paste. BYOK for API-key providers (the user
//      pastes a vendor key into the form); `coding-plan` for the
//      providers whose primary subscription shape is a token /
//      session-based plan (Claude Code, Codex, opencode go). The
//      validator accepts either for any provider — these are the
//      defaults, not constraints.
//
//   5. Metadata is conservative. Where a model's documented
//      `contextLimit`, `thinkingLevels`, or `modalities` are
//      uncertain, the field is OMITTED rather than wrong. A
//      /api/models consumer that doesn't see `thinkingLevels` will
//      render a plain prompt-input rather than a wrong "low/
//      medium/high" picker.
//
// Protocol/auth mapping (rationale per preset):
//
//   ┌───────────────────┬──────────┬──────────────┬─────────────────────────────────────────┐
//   │ preset id         │ protocol │ auth default │ rationale                               │
//   ├───────────────────┼──────────┼──────────────┼─────────────────────────────────────────┤
//   │ zhipu             │ openai   │ byok         │ Public API is OpenAI-compatible at       │
//   │                   │          │              │ /api/paas/v4/. API-key issued in console. │
//   │ kimi              │ openai   │ byok         │ Moonshot API is OpenAI-compatible at     │
//   │                   │          │              │ /v1/. API-key issued in console.         │
//   │ bailian           │ openai   │ byok         │ Alibaba DashScope "OpenAI compatible"   │
//   │                   │          │              │ mode at /compatible-mode/v1/.            │
//   │ volcano           │ openai   │ byok         │ Volcano Ark OpenAI-compatible endpoint  │
//   │                   │          │              │ at /api/v3/. API-key issued in console.  │
//   │ mimo              │ openai   │ byok         │ OpenAI-compatible public API.            │
//   │ minimax           │ openai   │ byok         │ OpenAI-compatible public API.            │
//   │ opencode-go       │ openai   │ coding-plan  │ Hosted gateway exposes an OpenAI-shaped │
//   │                   │          │              │ endpoint; primary shape is a session     │
//   │                   │          │              │ token, so default to coding-plan.        │
//   │ openrouter        │ openai   │ byok         │ OpenAI-compatible multi-provider         │
//   │                   │          │              │ gateway. API-key issued on signup.       │
//   │ claude-code       │ anthropic│ coding-plan  │ Anthropic-protocol subscription. The    │
//   │                   │          │              │ validator accepts both byok (raw key)   │
//   │                   │          │              │ and coding-plan (token) shapes; the      │
//   │                   │          │              │ template picks coding-plan because that  │
//   │                   │          │              │ is the shape the upstream CLI surfaces.  │
//   │ codex             │ openai   │ coding-plan  │ OpenAI Chat Completions protocol shape. │
//   │                   │          │              │ Default to coding-plan because the       │
//   │                   │          │              │ primary subscription is a session; the  │
//   │                   │          │              │ engine also supports BYOK raw keys.      │
//   └───────────────────┴──────────┴──────────────┴─────────────────────────────────────────┘
//
// Public surface (exported):
//
//   - `PROVIDER_PRESETS`        : array of frozen template records.
//   - `getPresetById(id)`       : lookup helper (returns the frozen
//                                 template or null).
//   - `presetToMaterialised(id)`: returns a v2-shaped provider
//                                 record suitable for writeProvidersConfig
//                                 (with empty apiKey, enabled: true,
//                                 preset tag pointing back at the
//                                 template id).
//   - `getPresetIds()`          : convenience — the array of preset
//                                 ids in declaration order.
//
// All data is frozen with `Object.freeze` after construction so a
// caller that mutates a template (e.g. by appending a model) cannot
// pollute the next call's view. The `materialise` helper returns a
// fresh deep clone so the PUT handler can safely pass it through
// `normaliseProvider` without affecting subsequent calls.

import { normaliseProvider } from "./providers-config.js";

// =====================================================================
// Model catalog metadata.
//
// Each entry is sourced from public vendor documentation (model
// listing pages / API references). Where a value was uncertain or
// could be wrong (e.g. an unannounced deprecation), the field is
// omitted — the ticket calls this out explicitly: "wrong metadata
// is worse than sparse".
//
// `contextLimit` numbers are in TOKENS, the unit the picker and
// the engine use for context-window budgeting.
//
// `modalities` is the model input surface (`text` for text-only,
// `image` for vision-capable). The engine currently treats output
// as text by default; we only annotate the input side.
//
// `thinkingLevels` lists the named reasoning-effort levels the
// vendor documents for that model. Omitting the array on a model
// that supports thinking would render the picker without the
// thinking toggle, so the rule is: when a vendor has stable,
// documented reasoning levels, list them; when the vendor's
// reasoning control is opaque or in flux, leave the array out.
// =====================================================================

/** 智谱 (Zhipu / BigModel / GLM). Public OpenAI-compatible endpoint. */
const zhipuModels = [
  {
    id: "glm-4-plus",
    label: "GLM-4 Plus",
    contextLimit: 128000,
    modalities: ["text"],
  },
  {
    id: "glm-4-air",
    label: "GLM-4 Air",
    contextLimit: 128000,
    modalities: ["text"],
  },
  {
    id: "glm-4-flash",
    label: "GLM-4 Flash",
    contextLimit: 128000,
    modalities: ["text"],
  },
];

/** Moonshot Kimi. Public OpenAI-compatible endpoint. */
const kimiModels = [
  {
    id: "moonshot-v1-8k",
    label: "Moonshot v1 (8k)",
    contextLimit: 8000,
    modalities: ["text"],
  },
  {
    id: "moonshot-v1-32k",
    label: "Moonshot v1 (32k)",
    contextLimit: 32000,
    modalities: ["text"],
  },
  {
    id: "moonshot-v1-128k",
    label: "Moonshot v1 (128k)",
    contextLimit: 128000,
    modalities: ["text"],
  },
];

/** Alibaba Bailian (DashScope) — "OpenAI compatible mode". */
const bailianModels = [
  {
    id: "qwen-plus",
    label: "Qwen Plus",
    contextLimit: 131072,
    modalities: ["text"],
  },
  {
    id: "qwen-turbo",
    label: "Qwen Turbo",
    contextLimit: 1000000,
    modalities: ["text"],
  },
  {
    id: "qwen-max",
    label: "Qwen Max",
    contextLimit: 32768,
    modalities: ["text"],
  },
];

/** Volcano Ark — OpenAI-compatible endpoint at /api/v3/. */
const volcanoModels = [
  {
    id: "doubao-pro-32k",
    label: "Doubao Pro (32k)",
    contextLimit: 32000,
    modalities: ["text"],
  },
  {
    id: "doubao-lite-32k",
    label: "Doubao Lite (32k)",
    contextLimit: 32000,
    modalities: ["text"],
  },
];

/** mimo — OpenAI-compatible public API. */
const mimoModels = [
  {
    id: "mimo-7b",
    label: "mimo-7B",
    contextLimit: 8192,
    modalities: ["text"],
  },
];

/** minimax — OpenAI-compatible public API. */
const minimaxModels = [
  {
    id: "MiniMax-M3",
    label: "MiniMax-M3",
    contextLimit: 128000,
    modalities: ["text"],
  },
];

/** opencode go — hosted OpenAI-shaped gateway. */
const opencodeGoModels = [
  // Deliberately sparse — opencode go's model list changes quickly
  // and the vendor's public catalogue is the source of truth at
  // call time. The template only carries one entry so the picker
  // has at least one default; users can add/remove models via
  // the custom-providers UI after enable.
  {
    id: "opencode-go-default",
    label: "opencode go (default)",
    modalities: ["text"],
  },
];

/** OpenRouter — multi-provider gateway. */
const openrouterModels = [
  // OpenRouter aggregates hundreds of upstream models; the template
  // exposes a small representative set. Users can extend via the
  // custom-providers UI.
  {
    id: "anthropic/claude-3.5-sonnet",
    label: "Claude 3.5 Sonnet (via OpenRouter)",
    contextLimit: 200000,
    modalities: ["text"],
  },
  {
    id: "openai/gpt-4o-mini",
    label: "GPT-4o mini (via OpenRouter)",
    contextLimit: 128000,
    modalities: ["text", "image"],
  },
  {
    id: "google/gemini-2.0-flash-exp:free",
    label: "Gemini 2.0 Flash (via OpenRouter)",
    contextLimit: 1000000,
    modalities: ["text", "image"],
  },
];

/** Claude Code — Anthropic-protocol subscription. */
const claudeCodeModels = [
  // Deliberately sparse — Claude Code surfaces model picks through
  // its own CLI; the template carries one representative entry so
  // the picker has a default. Users can extend via custom UI.
  {
    id: "claude-3-5-sonnet-20241022",
    label: "Claude 3.5 Sonnet",
    contextLimit: 200000,
    thinkingLevels: ["low", "medium", "high"],
    modalities: ["text"],
  },
];

/** Codex — OpenAI Chat Completions shape (BYOK or session). */
const codexModels = [
  {
    id: "gpt-4o",
    label: "GPT-4o",
    contextLimit: 128000,
    modalities: ["text", "image"],
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    contextLimit: 128000,
    modalities: ["text", "image"],
  },
  {
    id: "o1-preview",
    label: "o1 preview",
    contextLimit: 128000,
    modalities: ["text"],
  },
  {
    id: "o1-mini",
    label: "o1 mini",
    contextLimit: 128000,
    modalities: ["text"],
  },
];

// =====================================================================
// Template construction.
//
// `id`         : stable template id — also the prefix used to tag
//                a materialised record (via the `preset` field).
// `label`      : display name in the gallery.
// `protocol`   : wire-protocol enum value (one of ALLOWED_PROTOCOLS).
// `auth`       : { type, baseURL } — `apiKey` deliberately omitted
//                here so the template never carries key material.
//                `baseURL` defaults to "" so the protocol default
//                applies on first enable; the user can override.
// `models`     : preset model catalog.
// =====================================================================

const RAW_PRESETS = [
  {
    id: "zhipu",
    label: "智谱 (Zhipu / GLM)",
    protocol: "openai",
    auth: { type: "byok", baseURL: "https://open.bigmodel.cn/api/paas/v4/" },
    models: zhipuModels,
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    protocol: "openai",
    auth: { type: "byok", baseURL: "https://api.moonshot.cn/v1" },
    models: kimiModels,
  },
  {
    id: "bailian",
    label: "百炼 (Alibaba Bailian / DashScope)",
    protocol: "openai",
    auth: {
      type: "byok",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    models: bailianModels,
  },
  {
    id: "volcano",
    label: "火山 (Volcano / Ark)",
    protocol: "openai",
    auth: { type: "byok", baseURL: "https://ark.cn-beijing.volces.com/api/v3" },
    models: volcanoModels,
  },
  {
    id: "mimo",
    label: "mimo",
    protocol: "openai",
    auth: { type: "byok", baseURL: "" },
    models: mimoModels,
  },
  {
    id: "minimax",
    label: "minimax",
    protocol: "openai",
    auth: { type: "byok", baseURL: "" },
    models: minimaxModels,
  },
  {
    id: "opencode-go",
    label: "opencode go",
    protocol: "openai",
    auth: { type: "coding-plan", baseURL: "" },
    models: opencodeGoModels,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    auth: { type: "byok", baseURL: "https://openrouter.ai/api/v1" },
    models: openrouterModels,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    protocol: "anthropic",
    auth: { type: "coding-plan", baseURL: "" },
    models: claudeCodeModels,
  },
  {
    id: "codex",
    label: "Codex",
    protocol: "openai",
    auth: { type: "coding-plan", baseURL: "https://api.openai.com/v1" },
    models: codexModels,
  },
];

// =====================================================================
// Build, validate, freeze.
//
// We round-trip each template through `normaliseProvider()` so a
// schema bug surfaces at module-load time rather than at the user's
// `/api/providers/presets` click. If any template fails to
// validate, the import throws — the alternative (silently shipping
// a broken template that rejects at PUT time) makes the bug much
// harder to diagnose.
//
// `apiKey` is forced to the empty string AFTER validation so
// normalisation can't accidentally let a stray character slip in
// (a future maintainer adding a template that includes an
// `apiKey` field would be caught here).
// =====================================================================

export const PROVIDER_PRESETS = Object.freeze(
  RAW_PRESETS.map((raw) => {
    const candidate = {
      id: raw.id,
      label: raw.label,
      protocol: raw.protocol,
      auth: { type: raw.auth.type, apiKey: "", baseURL: raw.auth.baseURL },
      models: raw.models,
    };
    const r = normaliseProvider(candidate);
    if (!r.ok) {
      // Loud failure at module load — tests will catch this too,
      // but a failing import surfaces the bug during `node --test`
      // setup rather than during the first request.
      throw new Error(
        `provider-presets: preset '${raw.id}' failed validation: ${r.error}`,
      );
    }
    return Object.freeze(r.value);
  }),
);

/** All preset ids in declaration order. */
export function getPresetIds() {
  return PROVIDER_PRESETS.map((p) => p.id);
}

/**
 * Look up a preset by id. Returns the frozen template, or `null`
 * when the id is not in the catalogue. Pure — no I/O.
 */
export function getPresetById(id) {
  if (typeof id !== "string" || !id) return null;
  return PROVIDER_PRESETS.find((p) => p.id === id) || null;
}

/**
 * Materialise a template into a v2 provider record ready for
 * `writeProvidersConfig()`. The returned object is a fresh deep
 * clone — the original template is not mutated, and the caller
 * can safely edit it (e.g. to set the apiKey) before PUTting.
 *
 * Properties:
 *   - `enabled: true` (template becomes visible immediately on
 *     enable; the user has to fill the apiKey before the engine
 *     can drive a request through it).
 *   - `preset: id` (so a follow-up GET surfaces the provenance
 *     and the UI can render a "this is from a preset" badge).
 *   - `auth.apiKey: ""` (always — the user must supply it).
 *   - models deep-cloned from the template.
 */
export function presetToMaterialised(id) {
  const tpl = getPresetById(id);
  if (!tpl) return null;
  return {
    id: tpl.id,
    label: tpl.label,
    preset: tpl.id,
    enabled: true,
    protocol: tpl.protocol,
    auth: {
      type: tpl.auth.type,
      apiKey: "",
      baseURL: tpl.auth.baseURL || "",
    },
    models: tpl.models.map((m) => ({ ...m })),
  };
}

/**
 * Public view of a preset for the gallery endpoint. apiKey is
 * never present (templates have none). The shape matches
 * `publicView()` for a configured provider so the UI can render
 * the preset list and the configured list with the same code
 * path.
 */
export function publicPresetView(preset) {
  return {
    id: preset.id,
    label: preset.label,
    protocol: preset.protocol,
    auth: {
      type: preset.auth.type,
      baseURL: preset.auth.baseURL || "",
    },
    models: preset.models.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.contextLimit ? { contextLimit: m.contextLimit } : {}),
      ...(m.thinkingLevels && m.thinkingLevels.length > 0
        ? { thinkingLevels: [...m.thinkingLevels] }
        : {}),
      ...(m.modalities && m.modalities.length > 0
        ? { modalities: [...m.modalities] }
        : {}),
    })),
  };
}
