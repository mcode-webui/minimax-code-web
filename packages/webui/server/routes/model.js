// webui/server/routes/model.js
// GET /api/models, POST /api/set-model, POST /api/permissions, POST /api/answer (legacy)

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pushStateFor } from "../lib/state-bus.js";
import {
  mcodePermissionToWebui,
  setConfigOption,
  webuiPermissionToMcode,
  PERMISSION_MODES,
} from "../lib/mcode-rpc.js";
import { getBuiltinModelsFromMcode } from "../lib/models.js";
import { loadProvidersConfig } from "../lib/providers-config.js";
import { webuiModeToLabel } from "../lib/interaction/permission-presets.js";
import { readJson } from "../lib/read-json.js";

/** The engine's `select` config option with this id, or null before a session exists. */
function configOption(cs, id) {
  const options = Array.isArray(cs && cs.configOptions) ? cs.configOptions : [];
  return options.find((o) => o && o.id === id) || null;
}

/**
 * Read the optional providers-config file.
 *
 * Path precedence: `MCODE_WEBUI_MODELS_CONFIG` env → `<cwd>/models.json`.
 * Shape: `{ providers: [{ id, label, models: [{ id, label?, contextLimit? }] }] }`.
 * Re-read on every request: editing the file does not require a server restart.
 * Missing / unreadable / malformed → null (treated as "no config").
 *
 * v2 layered resolution lives in `loadProvidersConfig()` (env > cwd >
 * user-level with deep merge). The /api/models route now reads
 * through that helper, so an env override of `MCODE_WEBUI_MODELS_CONFIG`
 * continues to win over the cwd file (matching the v1 contract), and
 * a `~/.mcode-webui/providers.json` layer is layered under both.
 */
function readModelsConfig() {
  const path =
    process.env.MCODE_WEBUI_MODELS_CONFIG || join(process.cwd(), "models.json");
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.providers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Layered resolver used by /api/models. Returns the merged
 * `{ providers }` (v2 shape) or `null` when every layer is missing.
 * The deep-merge + dedupe semantics are owned by
 * `loadProvidersConfig()`; this helper only shapes its return into
 * the legacy `{ providers: [...] }` view that the rest of
 * handleGetModels already understood.
 */
function readProvidersConfigForModels() {
  try {
    const cfg = loadProvidersConfig();
    if (!cfg || !Array.isArray(cfg.providers) || cfg.providers.length === 0) {
      return null;
    }
    return { providers: cfg.providers };
  } catch {
    return null;
  }
}

/**
 * Coerce a provider prefix out of a model id.
 *
 * `minimax_api/MiniMax-M3` → `minimax_api`. Bare `MiniMax-M3` falls back to
 * `minimax_api` (the engine's only shipping builtin provider) so a user-typed
 * short id still resolves to a known group instead of orphaning itself.
 */
function providerOf(modelId, fallback = "minimax_api") {
  if (!modelId) return fallback;
  const i = modelId.indexOf("/");
  if (i <= 0) return fallback;
  return modelId.slice(0, i);
}

/**
 * GET /api/models — catalogue, with priority-aware merging.
 *
 * Priority order (highest wins for `current`, first wins for each id):
 *   1. Engine session's `model` config option. Its `options[].value` is
 *      the engine's encoded id (e.g. `m:<provider>:<model>:v:<variant>`),
 *      so it round-trips straight through `POST /api/set-model`. Used
 *      when a session is active.
 *   2. Optional `MCODE_WEBUI_MODELS_CONFIG` / `models.json` providers
 *      config. Per-provider groups with labels and `contextLimit`s.
 *   3. `getBuiltinModelsFromMcode()` — extracted from mcode's own
 *      cli.js bundle, so the list tracks mcode's TUI without a webui
 *      release.
 *
 * `current` resolution:
 *   - With an active session config option: `option.currentValue`.
 *   - Without one: the recorded pre-session choice (`cs.model.name`),
 *     which `handleSetModel` already writes — so the selector shows
 *     the user's pick even before the engine attaches.
 *
 * Response carries `groups` so the UI can render provider sections,
 * alongside the flat `models` array for callers that do not care
 * about grouping.
 */
export function handleGetModels(_req, res, ctx) {
  const cs = ctx.cs;
  const option = configOption(cs, "model");
  const engineOption = option; // keep the alias so reviewers can read priority order

  const list = [];
  const groups = [];
  const seen = new Set();

  // 1) Engine session config option — authoritative when present. We keep
  //    its encoded ids verbatim so /api/set-model round-trips. Both `name`
  //    and `label` are set on engine-sourced entries because pre-existing
  //    callers (the composer chip) read `name`, while the new
  //    provider-grouped panel reads `label`.
  if (engineOption) {
    const engineGroupId = "__engine";
    const engineGroup = {
      id: engineGroupId,
      label: "Engine session",
      models: [],
    };
    for (const o of Array.isArray(engineOption.options) ? engineOption.options : []) {
      const id = o && typeof o.value === "string" ? o.value : null;
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const displayName = (o && o.name) || id;
      const entry = {
        id,
        name: displayName,
        label: displayName,
        provider: providerOf(id),
        source: "engine",
      };
      engineGroup.models.push(entry);
      list.push(entry);
    }
    if (engineGroup.models.length > 0) groups.push(engineGroup);
  }

  // 2) Providers config — read every request so editing the file does not
  //    require a restart. Config wins on id collision with the builtin
  //    catalogue so providers can override labels and contextLimit.
  //
  //    v2 layered resolution (env > cwd > user-level) is provided by
  //    `loadProvidersConfig()`; the v1 single-file reader stays as a
  //    fallback for callers that pass the legacy `models.json`
  //    through a different code path (none today, but keeping it
  //    documents the contract).
  const config = readProvidersConfigForModels();
  if (config) {
    for (const p of config.providers) {
      if (!p || typeof p.id !== "string" || !p.id) continue;
      const models = [];
      for (const m of Array.isArray(p.models) ? p.models : []) {
        if (!m || typeof m.id !== "string" || !m.id) continue;
        const fullId = m.id.includes("/") ? m.id : `${p.id}/${m.id}`;
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
        // thinkingLevels + modalities so the selector can pick the
        // right controls without a second round-trip. `auth` only
        // exposes hasKey + type — apiKey NEVER reaches this response.
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
      groups.push({
        id: p.id,
        label: typeof p.label === "string" && p.label ? p.label : p.id,
        // Auth shape: only `hasKey` and `type`; no apiKey/baseURL.
        // Operators see "configured or not" without leaking the secret.
        auth: {
          hasKey: !!(p.auth && p.auth.apiKey),
          type: p.auth && typeof p.auth.type === "string" ? p.auth.type : "byok",
        },
        protocol: typeof p.protocol === "string" ? p.protocol : "openai",
        models,
      });
    }
  }

  // 3) Builtin catalogue (extracted from mcode's cli.js bundle). The
  //    "current provider" is the one recorded in cs.model.name; falling
  //    back to minimax_api keeps a brand-new session from looking empty.
  const builtins = getBuiltinModelsFromMcode();
  const currentName =
    (cs.model && typeof cs.model.name === "string" && cs.model.name) || "";
  const currentProvider = currentName.includes("/")
    ? currentName.split("/")[0]
    : "minimax_api";
  let builtinGroup = groups.find((g) => g.id === currentProvider);
  if (!builtinGroup) {
    builtinGroup = { id: currentProvider, label: currentProvider, models: [] };
    groups.push(builtinGroup);
  }
  for (const m of builtins) {
    const fullId = `${currentProvider}/${m}`;
    if (seen.has(fullId)) continue;
    seen.add(fullId);
    const entry = {
      id: fullId,
      label: m,
      provider: currentProvider,
      source: "builtin",
    };
    list.push(entry);
    builtinGroup.models.push(entry);
  }

  // Drop the empty builtin shell — a no-bundle empty group is noise.
  // The drop is gated on "no providers config" so a fresh install with
  // a config that names no models still has somewhere to attach the
  // builtins once mcode reports them.
  if (builtinGroup && builtinGroup.models.length === 0 && !config) {
    const idx = groups.indexOf(builtinGroup);
    if (idx >= 0) groups.splice(idx, 1);
  }

  // `current` is the engine's value when one exists; otherwise the
  // recorded pre-session choice (`cs.model.name`, written by
  // `handleSetModel`). When neither exists we report `null` rather than
  // falling back to `DEFAULT_MODEL` — the old behaviour invented an
  // active model the engine never confirmed, and the chip ended up
  // claiming a model the session was not actually running. The chip
  // renders a neutral label when `current` is `null` (see composer.tsx
  // currentModelLabel).
  const current =
    (option && option.currentValue) ||
    currentName ||
    null;

  const source =
    option && Array.isArray(option.options) && option.options.length > 0
      ? "acp-session-config"
      : config
        ? "config+mcode-cli-bundle"
        : "mcode-cli-bundle";

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      models: list,
      groups,
      current,
      source,
      // Backwards-compat: surface the same soft-failure marker the older
      // engine-only build did when nothing could be sourced. With the
      // merge it should be rare (builtin catalogue + providers config
      // cover most installs), but a missing mcode bundle AND an absent
      // config leaves the catalogue empty — and a caller that wants to
      // know "is this a hard failure or just no engine attached?" still
      // gets the same hint.
      ...(list.length === 0 ? { reason: "no_catalogue" } : {}),
    }),
  );
}

// POST /api/set-model — only updates cs.model; with a session the same value
// is also pushed to the engine via session/set_config_option.
export async function handleSetModel(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const modelId = (payload.model || "").trim();
  if (!modelId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "model required" }));
  }
  cs.model = cs.model || {};
  cs.model.name = modelId;
  const sid = cs.mcodeSessionId;
  let mcodeSynced = false;
  let warning = sid ? null : "no mcode session yet — recorded for the next one";
  if (sid) {
    const r = await setConfigOption(sid, "model", modelId, ctx.cid);
    mcodeSynced = r.ok;
    if (!r.ok) warning = r.error;
  }
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      model: modelId,
      mcodeSynced,
      ...(warning ? { warning } : {}),
    }),
  );
}

// POST /api/permissions — mid-session permission mode change, through
//   session/set_config_option{configId:'permissionMode'}.
// body: { mode: 'ask'|'auto'|'read'|'full' 或 mcode 原值 }
export async function handleSetPermissions(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const webuiMode = (payload.mode || "full").toLowerCase();
  const label = webuiModeToLabel(webuiMode);
  const mcodeValue = webuiPermissionToMcode(webuiMode);
  const sid = cs.mcodeSessionId;
  let mcodeSynced = false;
  let warning = sid ? null : "no mcode session yet — applies to the next one";
  if (sid && mcodeValue) {
    const r = await setConfigOption(sid, "permissionMode", mcodeValue, ctx.cid);
    mcodeSynced = r.ok;
    if (!r.ok) warning = r.error;
  }
  cs.permissions = label;
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      permissions: label,
      mcodeSynced,
      ...(warning ? { warning } : {}),
    }),
  );
}

// GET /api/permissions-modes — 列出 webui 4 标签 + mcode 6 原值, 供前端 dropdown
export function handleListPermissionModes(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      webui: [
        { value: "ask", label: "Ask", mcodeValue: "default" },
        { value: "auto", label: "Auto", mcodeValue: "auto" },
        { value: "read", label: "Read", mcodeValue: "read" },
        {
          value: "full",
          label: "Full access",
          mcodeValue: "bypassPermissions",
        },
      ],
      mcode: PERMISSION_MODES.map((v) => ({
        value: v,
        label: mcodePermissionToWebui(v),
      })),
    }),
  );
}

// POST /api/answer — legacy no-op (新 webui 走 /api/send)
export async function handleAnswer(req, res, _ctx) {
  const payload = await readJson(req);
  if (process.env.MCODE_USAGE_DEBUG)
    console.log(
      `[api.answer] type=${payload.type} option=${payload.option} (legacy, no-op)`,
    );
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(
    JSON.stringify({
      ok: true,
      deprecated: true,
      note: "use /api/send for new flow",
    }),
  );
}
