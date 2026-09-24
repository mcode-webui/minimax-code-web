// webui/server/routes/model.js
// GET /api/models, POST /api/set-model, POST /api/permissions, POST /api/answer (legacy)

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

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
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
export function handleGetModels(_req, res, ctx) {
  const cs = ctx.cs;
  const option = configOption(cs, "model");
  const models = (option && Array.isArray(option.options) ? option.options : []).map((o) => ({
    id: o.value,
    name: o.name,
  }));
  const current = (option && option.currentValue) || null;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      models,
      current,
      source: "acp-session-config",
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
