// webui/server/lib/engine-provider-sync.js
// Engine-side projection of webui's providers.json (ticket 05).
//
// Background — the root cause pinned by ticket 05:
//
//   Webui keeps its own `providers.json` (a v2 catalogue, layered merge,
//   keep-key convention) so the dialog can show provider groups, "enabled"
//   toggles and "configured with key" greying without talking to the engine
//   on every render. The engine has its own `custom_provider` registry
//   (packages/local-runtime-v2/src/service/model-system/management/service-custom-provider-operations.ts)
//   that is the ONLY source the `model` config option
//   (packages/tui/src/acp/control-state.ts) advertises. Pre-ticket-05, the
//   two never met: webui's PUT handler persisted its file, the engine kept
//   its `custom_provider` from `config.yaml` independent of the webui —
//   selecting a provider model in the dialog was UI-only and
//   `applyRecordedModel` had nothing to match against, so the engine
//   silently kept its default.
//
// Fix — write the engine's `custom_provider` shape right here so the engine
// sees the same providers the webui advertises:
//
//   webui provider (v2) → engine custom_provider entry
//     { id, label, protocol, auth, models }
//     → { name, kind: 'custom', enabled, api, options: {apiKey, baseURL, authMode},
//         models: { modelId: { limit: {context}, thinking: {effortOptions}, modalities } } }
//
// Conversion rules (pinned by tests):
//   - provider id → engine provider key (sluggified so the
//     `custom_provider:<key>/...` runtime id stays alphanumeric + dot +
//     underscore + hyphen)
//   - webui `enabled: false` AND/OR empty apiKey AND/OR missing baseURL →
//     entry is OMITTED (the engine's `custom_provider` rejects apiKey-less
//     `createUserProvider` and the `enabled: false` switch turns the entry
//     invisible to `listByokRuntimeModels`)
//   - protocol → api format: openai → openai-completions,
//     anthropic → anthropic-messages, gemini → openai-completions (Gemini's
//     OpenAI-compat endpoint is what `auth.type: 'byok'` callers point at;
//     the engine does not have a native Gemini api format)
//   - model id → engine model key; thinkingLevels → thinking.effortOptions,
//     modalities → modalities.input, contextLimit → limit.context
//   - auth.type === 'coding-plan' → SKIP (engine handles coding-plan via
//     its own OAuth / Codex / Claude Code flows — out of scope for the
//     byok projection)
//
// Write strategy:
//
//   The engine reads `<MINIMAX_DATA_DIR>/config.yaml` (the same dir the
//   webui already knows about — see server/lib/config.js#resolveDataDir).
//   We do an atomic tmp+rename YAML write keyed on `custom_provider` only;
//   we never touch the operator's other engine config (provider.minimax
//   tables, defaultModel, etc.). The engine subprocess running the
//   singleton client has a stale `getConfig()` cache after a write —
//   the route handler then calls `shutdownMcodeAcpSingleton()` so the
//   next operation spawns a fresh subprocess that reads the new file.
//   Brand-new prompt subprocesses spawned by `runMcodeAcp` always pick
//   up the latest config, so the rest of the system stays in lockstep.
//
//   We deliberately do NOT route through the engine's
//   `updateLocalByokConfig` (`@mavis/config`) — pulling that into the
//   webui bundle would drag in js-yaml + proper-lockfile just for a
//   one-way write we do rarely, and the lockfile is meaningful only when
//   multiple `mcode` subprocesses are racing the same file (which the
//   webui does not do — `mcode acp` does not edit `config.yaml` at
//   runtime, only the `mcode provider add` CLI does, and that flow
//   cannot run concurrently with a webui PUT in the same process tree).

import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { randomBytes } from "node:crypto";

import { applyKeepKeyConvention } from "./providers-config.js";

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
const RESERVED_ENGINE_KEYS = new Set([
  "minimax",
  "minimax_api",
  "provider",
  "custom_provider",
]);

const PROVIDER_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Resolve the engine's data directory.
 *
 * The engine resolves its own data dir via `packages/config/src/config.ts`:
 *   MINIMAX_DATA_DIR || MAVIS_DATA_DIR || ~/.minimax
 * We mirror that exact resolution here so a webui-managed PUT lands in the
 * directory the engine subprocess will read on next spawn. The webui itself
 * already uses the same env precedence in server/lib/config.js — the
 * resolver is the same shape, kept here as a copy so the helper has no
 * cross-package import surface.
 */
export function resolveEngineDataDir() {
  const env = (process.env.MINIMAX_DATA_DIR?.trim() ||
    process.env.MAVIS_DATA_DIR?.trim() ||
    "");
  if (env) return env;
  return join(homedir(), ".minimax");
}

export function getEngineConfigPath() {
  return join(resolveEngineDataDir(), "config.yaml");
}

/** Pure: a webui v2 id → an engine-safe provider key. */
export function providerKeyFromId(id) {
  const trimmed = (id || "").trim();
  if (!trimmed) return "";
  if (!PROVIDER_KEY_REGEX.test(trimmed)) return "";
  if (RESERVED_ENGINE_KEYS.has(trimmed)) {
    return `${trimmed}-byok`;
  }
  return trimmed;
}

/** Pure: webui model id → engine-safe model key. */
export function modelKeyFromId(id) {
  const trimmed = (id || "").trim();
  if (!trimmed) return "";
  // Engine model keys are even less constrained than provider keys (they
  // appear inside a per-provider record), but the same alphanumeric
  // character class keeps the keys safe to serialise into the runtime
  // id `custom_provider:<key>/<modelKey>` without URL-escaping.
  if (!PROVIDER_KEY_REGEX.test(trimmed)) return "";
  return trimmed;
}

/** Pure: webui v2 → engine custom_provider entry. Returns null when ineligible. */
export function toEngineCustomProvider(provider) {
  if (!provider || typeof provider !== "object") return null;
  // coding-plan providers go through the engine's OAuth / Codex /
  // subscription flows — out of scope for the byok projection.
  if (provider.auth && provider.auth.type === "coding-plan") return null;
  if (provider.enabled === false) return null;
  const apiKey =
    typeof provider.auth?.apiKey === "string" ? provider.auth.apiKey.trim() : "";
  if (!apiKey) return null;
  const baseURL =
    typeof provider.auth?.baseURL === "string" ? provider.auth.baseURL.trim() : "";
  if (!baseURL) {
    // No baseURL → engine has nothing to call. Skip (matches the dialog's
    // "configured without baseURL" grey-out: same semantics as no key).
    return null;
  }
  const protocol =
    typeof provider.protocol === "string" ? provider.protocol.trim() : "openai";
  const api = WEBUI_PROTOCOL_TO_ENGINE_API[protocol];
  if (!api) return null;
  const providerKey = providerKeyFromId(provider.id);
  if (!providerKey) return null;
  const name =
    typeof provider.label === "string" && provider.label.trim()
      ? provider.label.trim()
      : providerKey;
  const models = {};
  if (Array.isArray(provider.models)) {
    for (const m of provider.models) {
      if (!m || typeof m !== "object") continue;
      const modelKey = modelKeyFromId(m.id);
      if (!modelKey) continue;
      const engineModel = {};
      if (
        typeof m.label === "string" &&
        m.label.trim() &&
        m.label.trim() !== modelKey
      ) {
        engineModel.name = m.label.trim();
      }
      if (typeof m.contextLimit === "number" && m.contextLimit > 0) {
        engineModel.limit = { context: m.contextLimit };
      }
      if (
        Array.isArray(m.thinkingLevels) &&
        m.thinkingLevels.length > 0 &&
        m.thinkingLevels.every((x) => typeof x === "string" && x.length > 0)
      ) {
        engineModel.thinking = { effortOptions: [...m.thinkingLevels] };
      }
      if (
        Array.isArray(m.modalities) &&
        m.modalities.length > 0 &&
        m.modalities.every((x) => typeof x === "string" && x.length > 0)
      ) {
        engineModel.modalities = { input: [...m.modalities] };
      }
      models[modelKey] = engineModel;
    }
  }
  return {
    key: providerKey,
    entry: {
      name,
      kind: "custom",
      enabled: true,
      api,
      options: {
        apiKey,
        baseURL,
        authMode: "api-key",
      },
      ...(Object.keys(models).length > 0 ? { models } : {}),
    },
  };
}

/**
 * Read the engine's existing `config.yaml` so a sync can preserve
 * `provider.*`, `defaultModel`, and any operator-managed sections the
 * webui must not touch.
 *
 * Returns a plain object (possibly empty). A missing file is not an
 * error — the writer creates it.
 */
function readEngineConfigRaw(configPath) {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    // YAML parse error — the engine will surface this on its next read;
    // we'd rather write a broken-than-empty file than drop the operator's
    // section. Bail out as "no-op" so the route can answer with a clear
    // structured error.
    return null;
  }
}

async function atomicWriteYaml(configPath, object) {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = join(
    dirname(configPath),
    `.config-tmp-${randomBytes(6).toString("hex")}`,
  );
  await writeFile(
    tmp,
    yaml.dump(object, { indent: 2, lineWidth: -1, noRefs: true }),
    "utf8",
  );
  await rename(tmp, configPath);
}

/**
 * Project a list of webui v2 providers into the engine's `custom_provider`
 * tree and write the engine's `config.yaml` atomically.
 *
 * Returns:
 *   - { ok: true,  written: true|false, keys: [providerKey, ...] }
 *     `written: false` means there was nothing eligible to write (the
 *     webui's catalogue is empty or every provider was ineligible).
 *   - { ok: false, code: 'ENGINE_SYNC_FAILED', error: string }
 *
 * Never throws — surfaces every failure as a structured result so the
 * route handler can attach the error to the response without try/catch.
 */
export async function syncProvidersToEngine(providers, opts = {}) {
  const configPath = opts.configPath || getEngineConfigPath();
  try {
    const eligible = [];
    for (const p of providers || []) {
      const out = toEngineCustomProvider(p);
      if (out) eligible.push(out);
    }
    const existing = readEngineConfigRaw(configPath);
    if (existing === null) {
      return {
        ok: false,
        code: "ENGINE_SYNC_FAILED",
        error: `engine config at ${configPath} is unreadable (YAML parse error)`,
      };
    }
    // Preserve every operator-owned section; only `custom_provider` is
    // owned by this helper. The engine's `defaultModel` (when pointing at
    // a `custom_provider:<key>/<modelId>`) is left to the operator — the
    // dialog still resolves a model on demand via `applyRecordedModel`.
    const next = { ...existing };
    if (eligible.length === 0) {
      // Nothing eligible — leave the engine's tree untouched rather than
      // wipe an operator's manual custom_provider entries. The webui
      // records a no-op result so the route can log it.
      const existingCustom = existing.custom_provider || {};
      const existingKeys = Object.keys(existingCustom).filter((k) =>
        k.endsWith("-byok"),
      );
      return { ok: true, written: false, keys: existingKeys };
    }
    const customProvider = {};
    for (const { key, entry } of eligible) {
      customProvider[key] = entry;
    }
    next.custom_provider = customProvider;
    await atomicWriteYaml(configPath, next);
    return { ok: true, written: true, keys: eligible.map((e) => e.key) };
  } catch (e) {
    return {
      ok: false,
      code: "ENGINE_SYNC_FAILED",
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * Compatibility wrapper for the routes that already have the raw PUT body
 * in hand (they apply keep-key convention themselves for the user-level
 * file write). This wraps the body in the same shape the route would pass
 * to `syncProvidersToEngine` after normalisation, so the sync sees the
 * same provider list the engine should advertise.
 */
export async function syncProvidersFromPutBody(parsedBody, existingUserLevel, opts) {
  const incoming = Array.isArray(parsedBody?.providers) ? parsedBody.providers : null;
  if (incoming === null) {
    return { ok: false, code: "BAD_BODY", error: "providers must be an array" };
  }
  const resolved = applyKeepKeyConvention(existingUserLevel || [], incoming);
  return syncProvidersToEngine(resolved, opts);
}