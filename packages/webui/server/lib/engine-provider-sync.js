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
// Ownership rule — ticket 05 acceptance (merge-over-replace):
//
//   The webui's PUT does NOT replace the engine's whole `custom_provider`
//   tree. A manually-added operator entry (e.g. via `mcode provider add`
//   on the engine CLI) is FOREIGN to the webui and must survive an
//   unrelated webui PUT. The hard destruction class this commit is
//   closing: pre-fix sync, removing a webui provider OR running an
//   empty-eligible-list sync would silently DROP a foreign entry the
//   operator typed in by hand.
//
//   Ownership is tracked per-entry by an opaque marker field:
//
//      _webui_owned: true      ← every entry webui writes carries this
//
//   The engine ignores unknown fields (it parses via js-yaml with no
//   schema-rejection; see `parseCustomProvidersConfig` in
//   `packages/config/src/byok-config.ts`), so the marker is engine-safe.
//   The sync algorithm:
//
//     existing engine keys ∩ eligible webui keys   → UPDATE in place
//     existing engine keys ∖ eligible webui keys:
//       _webui_owned === true                       → DELETE (webui owns it,
//                                                      operator removed the
//                                                      webui provider)
//       _webui_owned !== true (or missing)           → PRESERVE (foreign;
//                                                      operator owns it;
//                                                      webui leaves it alone)
//     eligible webui keys ∖ existing engine keys    → ADD (new provider)
//
//   This means a foreign `manual-only` provider stays in the engine
//   tree even after every webui PUT, even after the operator deletes
//   every webui-managed provider. The webui NEVER deletes a foreign
//   entry. The only way to delete a foreign entry is the engine CLI's
//   own `mcode provider delete` (or hand-editing `config.yaml`).
//
// Write strategy:
//
//   The engine reads `<MINIMAX_DATA_DIR>/config.yaml` (the same dir the
//   webui already knows about — see server/lib/config.js#resolveDataDir).
//   We do an atomic tmp+rename YAML write keyed on `custom_provider`
//   only; we never touch the operator's other engine config
//   (provider.*, defaultModel, etc.). The engine subprocess running the
//   singleton client has a stale `getConfig()` cache after a write —
//   the route handler then calls `shutdownMcodeAcpSingleton()` so the
//   next operation spawns a fresh subprocess that reads the new file.
//   Brand-new prompt subprocesses spawned by `runMcodeAcp` always pick
//   up the latest config, so the rest of the system stays in lockstep.
//
// File permissions — ticket 05 acceptance (0600):
//
//   config.yaml carries the apiKey as plaintext. umask-default 0664
//   would expose the key to every user on the host. The engine's own
//   `updateLocalByokConfig` writes 0600 (see
//   `packages/config/src/local-model-provider-write.ts`); the helper
//   matches. The new tmp file is created 0600, the rename preserves
//   the mode on POSIX, and a final chmod pins it for platforms where
//   the rename semantics differ.
//
//   We deliberately do NOT route through the engine's
//   `updateLocalByokConfig` (`@mavis/config`) — pulling that into the
//   webui bundle would drag in js-yaml + proper-lockfile just for a
//   one-way write we do rarely, and the lockfile is meaningful only when
//   multiple `mcode` subprocesses are racing the same file (which the
//   webui does not do — `mcode acp` does not edit `config.yaml` at
//   runtime, only the `mcode provider add` CLI does, and that flow
//   cannot run concurrently with a webui PUT in the same process tree).

import { writeFile, rename, mkdir, chmod } from "node:fs/promises";
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
 * Ownership marker field. Every entry the webui writes carries
 * `_webui_owned: true`. The engine ignores it (js-yaml parses the whole
 * record and the engine's downstream consumers read named fields only);
 * the field is the on-disk fingerprint the sync algorithm uses to
 * distinguish webui-managed entries from operator-managed ones.
 *
 * The constant is exported only so tests can assert against it without
 * drifting if the marker ever changes (rename = data loss for every
 * operator-managed entry on the next sync). Do not rename lightly.
 */
export const WEBUI_OWNED_MARKER = "_webui_owned";

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

/**
 * Atomic YAML write + 0600 permission pin.
 *
 * Two-step: write the new content to a tmp file (mode 0600), then
 * rename. The rename preserves POSIX mode, but we chmod the target
 * afterwards as belt-and-suspenders (some filesystems and Windows
 * edge cases drop the mode on rename). The engine's own
 * `updateLocalByokConfig` does the same dance — see
 * `packages/config/src/local-model-provider-write.ts`.
 */
async function atomicWriteYaml0600(configPath, object) {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = join(
    dirname(configPath),
    `.config-tmp-${randomBytes(6).toString("hex")}`,
  );
  // mode 0600 — owner read/write only. The file carries plaintext
  // apiKeys; any looser mode would expose them to other users on the
  // host.
  await writeFile(tmp, yaml.dump(object, { indent: 2, lineWidth: -1, noRefs: true }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tmp, 0o600);
  await rename(tmp, configPath);
  await chmod(configPath, 0o600);
}

/**
 * Is this engine entry webui-owned (vs operator/foreign)?
 *
 * The marker is set on every entry the webui writes. Operators who add
 * custom providers via the engine CLI never set it, so the marker
 * distinguishes the two ownerships on disk.
 */
function isWebuiOwned(entry) {
  return !!(entry && typeof entry === "object" && entry[WEBUI_OWNED_MARKER] === true);
}

/**
 * Build the next `custom_provider` map by merging the eligible webui
 * projection over the existing engine tree (see the file-level
 * ownership rule). Pure: no IO, no writes.
 *
 * Algorithm:
 *   1. eligible webui keys ⊂ existing engine keys → UPDATE in place
 *      (the webui entry replaces the engine entry; we still carry
 *      `_webui_owned: true` so the next sync treats it as webui).
 *   2. existing engine keys ∖ eligible webui keys:
 *        marker === true → DELETE
 *        marker !== true → PRESERVE (foreign, operator-owned)
 *   3. eligible webui keys ∖ existing engine keys → ADD
 *
 * The returned map carries the ownership marker on every webui-owned
 * entry; foreign entries are passed through verbatim (including their
 * original structure — we never edit a foreign entry's fields).
 */
function mergeCustomProviderTree(existingCustom, eligible) {
  const next = {};
  // Carry forward any foreign entries that the engine already has.
  // We do this first so the eligibility-driven UPDATE/DELETE pass
  // below only touches webui-owned keys.
  for (const [key, entry] of Object.entries(existingCustom || {})) {
    if (!entry || typeof entry !== "object") continue;
    if (!isWebuiOwned(entry)) {
      next[key] = entry;
    }
  }
  const eligibleKeys = new Set();
  for (const { key, entry } of eligible) {
    eligibleKeys.add(key);
    // Strip the existing entry (if any) — we'll replace it below with
    // the new webui projection. The marker on the new entry will be
    // preserved across sync cycles.
    delete next[key];
    // Build the new entry with the ownership marker set. We stamp
    // the marker AFTER cloning so we don't mutate the input (the
    // route caches the eligible list across calls).
    next[key] = { ...entry, [WEBUI_OWNED_MARKER]: true };
  }
  // No further work: webui-owned entries that are no longer eligible
  // were omitted from `next` (we never re-add them), so the DELETE
  // step is implicit.
  void eligibleKeys;
  return next;
}

/**
 * Project a list of webui v2 providers into the engine's `custom_provider`
 * tree and write the engine's `config.yaml` atomically (mode 0600).
 *
 * Ownership rule (see file header): the merge preserves operator /
 * foreign entries — only entries webui wrote (the `_webui_owned`
 * marker is the on-disk fingerprint) are added / updated / removed.
 * Foreign entries survive every webui PUT.
 *
 * Returns:
 *   - { ok: true,  written: true|false, keys: [providerKey, ...],
 *       preserved: [foreignKey, ...] }
 *     `written: false` means there was nothing eligible to write (the
 *     webui's catalogue is empty or every provider was ineligible); the
 *     foreign set is still reported so the route can log it. `keys`
 *     lists the webui keys the sync touched (added/updated). `preserved`
 *     lists the foreign keys that survived untouched.
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
    // touched. The engine's `defaultModel` (when pointing at a
    // `custom_provider:<key>/<modelId>`) is left to the operator.
    const next = { ...existing };
    const existingCustom =
      existing.custom_provider && typeof existing.custom_provider === "object"
        ? existing.custom_provider
        : {};
    const merged = mergeCustomProviderTree(existingCustom, eligible);
    // List foreign keys we kept untouched, for the route response /
    // log. Owned entries (webui + foreign-derived from marker) are
    // excluded — only the operator-managed ones we preserved go here.
    const preserved = [];
    for (const key of Object.keys(merged)) {
      const e = merged[key];
      if (!isWebuiOwned(e)) preserved.push(key);
    }
    if (
      eligible.length === 0 &&
      Object.keys(merged).length === Object.keys(existingCustom).length &&
      Object.keys(merged).every((k) => existingCustom[k] === merged[k])
    ) {
      // Nothing eligible AND the merged tree is byte-identical to
      // the existing one (no webui-owned entries changed, no
      // foreign entries added/removed). Skip the write — the engine's
      // view of the world is unchanged, and a no-op write would
      // still touch mtime / chmod.
      return { ok: true, written: false, keys: [], preserved };
    }
    next.custom_provider = merged;
    await atomicWriteYaml0600(configPath, next);
    return {
      ok: true,
      written: true,
      keys: eligible.map((e) => e.key),
      preserved,
    };
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