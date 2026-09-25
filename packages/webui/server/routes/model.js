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

/** The engine's `select` config option with this id, or null before a session exists. */
function configOption(cs, id) {
  const options = Array.isArray(cs && cs.configOptions) ? cs.configOptions : [];
  return options.find((o) => o && o.id === id) || null;
}
// B04: webuiModeToLabel extracted to the permission-presets seam (per
// BORROW-dsh-deepseek-harness-2026-08-28 § 3). Same string-mapping
// behavior as the inline ternary chain that lived here before.
import { webuiModeToLabel } from "../lib/interaction/permission-presets.js";
import { readJson } from "../lib/read-json.js";

/**
 * Optional model-catalogue overlay, re-read on every request so editing the
 * file takes effect without a restart.
 *
 * Path: `MCODE_WEBUI_MODELS_CONFIG`, else `models.json` under the server's cwd.
 * Shape: `{ providers: [{ id, label, models: [{ id, label, contextLimit? }] }] }`.
 *
 * This is an *overlay*, not a replacement. The engine's session config option
 * stays the authority on which models exist and which one is current — an
 * overlay entry that the engine does not list is not offered, and an engine
 * entry the overlay does not mention is still offered. The overlay only
 * supplies display metadata (label, contextLimit) and lets an operator name
 * the provider groups. Reading a missing or malformed file is not an error;
 * it just means no overlay.
 */
function readModelsOverlay() {
  const path =
    process.env.MCODE_WEBUI_MODELS_CONFIG || join(process.cwd(), "models.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || !Array.isArray(parsed.providers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Provider for an engine model id.
 *
 * The engine encodes a selection as `m:<provider>:<model>:v:<variant>`, so the
 * provider is the second colon-delimited field. Ids that are not in that
 * encoding fall back to the `provider/` prefix form, and anything else reports
 * an empty provider (the caller renders those as one unnamed group).
 */
function providerOf(modelId) {
  if (typeof modelId !== "string") return "";
  const encoded = /^m:([^:]+):/.exec(modelId);
  if (encoded) return encoded[1];
  const slash = /^([^/]+)\//.exec(modelId);
  return slash ? slash[1] : "";
}

/** Model name within an engine id: `m:<provider>:<model>:v:<variant>` → `<model>`. */
function bareNameOf(modelId) {
  if (typeof modelId !== "string") return "";
  const encoded = /^m:[^:]+:([^:]+):/.exec(modelId);
  if (encoded) return encoded[1];
  const slash = /^[^/]+\/(.+)$/.exec(modelId);
  return slash ? slash[1] : modelId;
}

/**
 * Index the overlay by provider, then by the model ids it can supply metadata
 * for. A model may be written bare (`MiniMax-M3`) or fully qualified
 * (`minimax_api/MiniMax-M3`); both resolve to the same entry.
 */
function indexOverlay(overlay) {
  const byProvider = new Map();
  for (const p of overlay.providers) {
    if (!p || typeof p.id !== "string" || !p.id) continue;
    const byModel = new Map();
    for (const m of Array.isArray(p.models) ? p.models : []) {
      if (!m || typeof m.id !== "string" || !m.id) continue;
      byModel.set(m.id, m);
      const bare = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
      byModel.set(bare, m);
    }
    byProvider.set(p.id, { label: typeof p.label === "string" && p.label ? p.label : p.id, byModel });
  }
  return byProvider;
}

// GET /api/models
// The catalogue is the engine's `model` config option (the same list the TUI's
// /models shows), which arrives with the session. `value` is the engine's
// encoded selection — `m:<provider>:<model>:v:<variant>` — so it round-trips
// straight back through /api/set-model.
//
// Without that option there is no catalogue and no current model to report, and
// this used to answer with `DEFAULT_MODEL` (`minimax_api/MiniMax-M3`), which is
// neither the engine's encoding nor the engine's state: the client rendered it as
// the active model while the session was running something else entirely. It
// answers `null` now, and the caller shows a neutral label. Nothing is written
// back into `cs.model` either — that backfill is what put the invented name into
// the state a later prompt would use.
//
// `groups` partitions that same catalogue by provider so a client can render
// one section per provider instead of one flat list. It is derived from the
// engine ids, so it is always consistent with `models`; the optional
// `models.json` overlay may rename a group and enrich an entry.
export function handleGetModels(_req, res, ctx) {
  const cs = ctx.cs;
  const option = configOption(cs, "model");
  const overlay = readModelsOverlay();
  const overlayIndex = overlay ? indexOverlay(overlay) : null;

  const groups = new Map();
  const models = (option && Array.isArray(option.options) ? option.options : []).map((o) => {
    const provider = providerOf(o.value);
    const providerEntry = overlayIndex?.get(provider);
    const overlayModel = providerEntry?.byModel.get(bareNameOf(o.value))
      ?? providerEntry?.byModel.get(o.value);
    const entry = {
      id: o.value,
      name: o.name,
      // `label` is the overlay's display name when it has one, else the
      // engine's. Both spellings ship so older clients reading `name` keep
      // working and newer ones can prefer `label`.
      label: typeof overlayModel?.label === "string" && overlayModel.label ? overlayModel.label : o.name,
      provider,
    };
    if (typeof overlayModel?.contextLimit === "number" && overlayModel.contextLimit > 0) {
      entry.contextLimit = overlayModel.contextLimit;
    }
    if (!groups.has(provider)) {
      groups.set(provider, { id: provider, label: providerEntry?.label ?? provider, models: [] });
    }
    groups.get(provider).models.push(entry);
    return entry;
  });

  const current = (option && option.currentValue) || null;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      models,
      groups: [...groups.values()],
      current,
      source: overlayIndex ? "acp-session-config+overlay" : "acp-session-config",
      // listModels is per-session, so there is nothing to report until the
      // engine has created one.
      ...(models.length === 0 ? { reason: "no_session_config" } : {}),
    }),
  );
}

// POST /api/set-model — 只更新 cs.model
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
  // Switching the engine's model is a session config option; without a session
  // this only records the choice for the session that is about to be created.
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
  // B04: webuiModeToLabel lives in interaction/permission-presets.js
  // (extracted from this inline ternary chain — same byte-identical output).
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
