// webui/server/routes/model.js
// GET /api/models, POST /api/set-model, POST /api/permissions, POST /api/answer (legacy)
//
// M3-B4: `GET /api/models` now reads the catalogue through the engine
// facade (`server/engine/model-reads.js`) instead of assembling it
// here. The three sources (the engine session's `model` config option,
// the merged providers config with the engine's `custom_provider`
// tree as its bottom layer, the builtin cli-bundle extraction), the
// two builtin-tree annotations (variant-style thinking levels and
// context-window options) and the three derived "what is active" figures
// all moved with it, as named pure functions pinned on their inputs.
//
// The response is byte-identical. This batch only moves the READ: the
// WRITE half (`handleSetModel`) stays here for B7/B9, together with the
// two other handlers below.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pushStateFor } from "../lib/state-bus.js";
import {
  mcodePermissionToWebui,
  setConfigOption,
  webuiPermissionToMcode,
  PERMISSION_MODES,
} from "../lib/mcode-rpc.js";
import { readEngineModelCatalogue } from "../engine/model-reads.js";
import { variantChannelFor, resolveModelId } from "../lib/engine-catalogue.js";
import { webuiModeToLabel } from "../lib/interaction/permission-presets.js";
import { readJson } from "../lib/read-json.js";

/**
 * Read the optional providers-config file — the v1 single-file reader.
 *
 * Path precedence: `MCODE_WEBUI_MODELS_CONFIG` env → `<cwd>/models.json`.
 * Shape: `{ providers: [{ id, label, models: [{ id, label?, contextLimit? }] }] }`.
 * Missing / unreadable / malformed → null (treated as "no config").
 *
 * KNOWN DEBT, kept deliberately: nothing calls this any more. The v2
 * layered resolution in `loadProvidersConfig()` (env > cwd > user-level
 * with deep merge) replaced it when #57 moved into
 * `engine/model-reads.js`, and the function was already unreferenced
 * before that move. It is retained rather than deleted because it is
 * the written record of the v1 contract `loadProvidersConfig`'s own
 * header cites; delete it in a batch whose subject is dead code, not as
 * a side effect of moving a read.
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
 * Translate a webui-recorded model id to the engine's wire form.
 *
 * The webui records `cs.model.name` in `<providerKey>/<engineModelKey>`
 * form (see `engine/model-reads.js#webuiFullModelId`). The engine's
 * `set_config_option` for `configId: "model"` rejects anything that
 * isn't the wire form `m:<encodedProvider>:<encodedModel>:u` (see
 * packages/tui/src/acp/control-state.ts#modelConfigValue / agent.ts
 * `parseModelConfigValue`). Without this translation a mid-session
 * pick of a multi-segment model id (`nousresearch/deepseek/x`) would
 * 400 from the engine.
 *
 * `resolveModelId` (in `lib/engine-catalogue.js`) owns the resolver —
 * it is the same code path `applyRecordedModel` uses on session boot, so
 * the mid-session push and the boot-time replay share one source of
 * truth. Returns `null` when the engine has no matching option yet
 * (the engine configOptions list is empty before the first session
 * event lands); the caller falls back to the recorded id and the
 * next session event re-attempts the apply via `applyRecordedModel`.
 *
 * `resolveOpts` (ticket 36) passes straight through to
 * `resolveModelId` — today only `preferVariant`, used to fold a
 * switchable builtin's on/off level into the model selection.
 */
function translateWebuiModelIdToEngineValue(cs, modelId, resolveOpts) {
  if (!modelId || typeof modelId !== "string") return null;
  const allOpts = Array.isArray(cs && cs.configOptions) ? cs.configOptions : [];
  const modelOption = allOpts.find((o) => o && o.id === "model");
  if (!modelOption) return null;
  return resolveModelId(modelId, modelOption, resolveOpts);
}

/**
 * GET /api/models — the composer model picker, through the engine
 * facade.
 *
 * The endpoint's whole contract is the payload the facade built:
 *
 *   - `models` — the flat list, every entry carrying `id` / `label` /
 *     `provider` / `source` plus whatever that source contributes
 *     (`contextLimit`, `protocol`, `thinkingLevels`, `modalities`,
 *     `contextWindowOptions`).
 *   - `groups` — the same entries grouped by provider, so the picker can
 *     render sections instead of a flat list. This is red line five's
 *     "模型按供应商分组": the group id is the provider key, and the
 *     builtin shell is always `minimax_api` regardless of the recorded
 *     pick.
 *   - `current` / `currentThinking` / `currentContextWindow` — the three
 *     derived figures, resolved engine-value-first and never invented
 *     from a default.
 *   - `source` — which layer won.
 *   - `reason: "no_catalogue"` — the soft marker, spread last and only
 *     when the catalogue came out empty.
 *
 * `engine/model-reads.js` owns the projection rules and their
 * derivations; this route writes the body. The facade re-reads every
 * source on every request, so editing `models.json`,
 * `~/.mcode-webui/providers.json` or the engine's `config.yaml` still
 * takes effect without a restart.
 *
 * Still a SYNCHRONOUS handler, exactly as before: the facade's read is
 * synchronous too, because every source it needs was already a static
 * import of this route (see the boot-path note in the engine module).
 */
export function handleGetModels(_req, res, ctx) {
  const { payload } = readEngineModelCatalogue({ cs: ctx && ctx.cs });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(payload));
}

// POST /api/set-model — only updates cs.model; with a session the same value
// is also pushed to the engine via session/set_config_option.
//
// Body: `{ model?: string, thinking?: string, contextWindow?: number|null }`.
// `thinking` is the reasoning-effort level the engine accepts on its
// `thinkingEffort` config option (`low` / `medium` / `high`, plus `off` / `none`
// for models that disable reasoning — see the engine's control-state.ts
// `thinkingEffortOption`). Per the engine's contract, the
// `thinkingEffort` set is rejected when no model is selected
// (`Select a Session model before changing thinking effort.`,
// agent.ts#1003), so a thinking-only update routes the same way the
// set_config_option engine path expects: model first, then effort.
//
// `thinking` is OPTIONAL: a model-only update leaves the recorded
// effort intact (it gets re-applied on the next session boot via
// `applyRecordedModel`); an effort-only update leaves the model alone.
// An empty string clears the recorded effort, signalling "no override
// — let the engine's default stand".
//
// `contextWindow` (U6) is the context-window choice in TOKENS, one of
// the model's `contextWindowOptions` from /api/models. `null` clears
// the recorded choice ("engine default stands"). It is RECORDED in
// `cs.model.contextWindow` and echoed back through /api/models'
// `currentContextWindow`, but NOT carried to the engine: the engine's
// ACP surface has no channel for it — `session/set_config_option`
// accepts exactly three config ids (permissionMode / model /
// thinkingEffort) and the `model` value's wire encoding
// (`m:<provider>:<model>:u|v:<variant>`, packages/tui/src/acp/
// control-state.ts#modelConfigValue) has no context segment; the
// engine's own runtime `models.select` accepts a `contextLimit` but
// is reachable only from the TUI/runtime clients today. Verified
// against the shipped engine bundle (0.5.5) as well as this repo's
// source: the ACP chunk carries no contextLimit anywhere. The
// recorded pick is therefore a webui-side preference that the picker
// reflects immediately; wiring it into an engine-side apply is the
// engine ticket's work, and this route's shape (validate → record →
// echo) is the seam that work plugs into.
export async function handleSetModel(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const modelId = typeof payload.model === "string" ? payload.model.trim() : "";
  const rawThinking =
    typeof payload.thinking === "string" ? payload.thinking.trim() : undefined;
  // "no field" → keep the existing cs.model.thinking; "empty string" →
  // clear it (no override). Both arrive as falsy here, but the
  // distinction is encoded by `thinkingWasProvided`.
  const thinkingWasProvided = Object.prototype.hasOwnProperty.call(payload, "thinking");
  const thinking = thinkingWasProvided ? (rawThinking || "") : undefined;
  // U6: same provided/absent split for the context window. `null` is
  // the documented clear sentinel (a number sets, null clears, absent
  // leaves alone); anything else is a 400 — a silent drop would leave
  // the picker claiming a window the server never recorded.
  const contextWindowWasProvided = Object.prototype.hasOwnProperty.call(payload, "contextWindow");
  let contextWindow;
  if (contextWindowWasProvided && payload.contextWindow !== null) {
    const v = payload.contextWindow;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "invalid contextWindow" }));
    }
    contextWindow = v;
  }
  if (!modelId && !thinkingWasProvided && !contextWindowWasProvided) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "model required" }));
  }
  cs.model = cs.model || {};
  if (modelId) cs.model.name = modelId;
  if (thinkingWasProvided) {
    cs.model.thinking = thinking;
  }
  if (contextWindowWasProvided) {
    if (contextWindow === undefined) delete cs.model.contextWindow;
    else cs.model.contextWindow = contextWindow;
  }
  // ticket 08 (set-model SSE race): stamp a per-field `*PickedAt`
  //   timestamp so `applyConfigOptionUpdate`'s ownership-aware mirror
  //   (server/lib/mcode-acp.js) defers the engine's response inside a
  //   4s window. Without this marker, the engine's `config_option_update`
  //   would re-assert its wire-form `currentValue` over the user's
  //   recorded pick a few ms after the optimistic write, causing the
  //   chip to flicker between user-friendly form and engine wire form.
  const pickAt = Date.now();
  if (modelId) cs.model.modelPickedAt = pickAt;
  if (thinkingWasProvided) cs.model.thinkingPickedAt = pickAt;
  if (contextWindowWasProvided) cs.model.contextWindowPickedAt = pickAt;
  const sid = cs.mcodeSessionId;
  let mcodeSynced = false;
  let thinkingSynced = false;
  let warning = sid ? null : "no mcode session yet — recorded for the next one";
  // Ticket 36 — variant channel. Switchable builtin models (the
  // engine's `thinking_config.mode: switchable` + variant tree,
  // e.g. MiniMax-M3) have NO engine effort vocabulary: the engine
  // rejects every `thinkingEffort` value for them ("Thinking effort
  // is not advertised for the selected model"). Their on/off level
  // rides the MODEL selection instead — the engine advertises such
  // models only as variant wire forms (`m:...:v:thinking` /
  // `m:...:v:none-thinking`). When the target model rides the
  // variant channel, one model push carries both the model and the
  // level; the thinkingEffort push below is skipped entirely.
  const variantTarget = modelId || (cs.model && cs.model.name) || "";
  const variantPlan = sid ? variantChannelFor(variantTarget) : null;
  // Engine contract: model first, then thinkingEffort (the engine
  // rejects a thinkingEffort set when no model is selected). Only push
  // when BOTH the recorded model and the new (or unchanged) thinking
  // are concrete — the engine will validate the level against the
  // selected model's effortOptions and reject unknown values.
  if (sid && variantPlan) {
    const level = variantPlan.level(
      thinkingWasProvided ? thinking : cs.model && cs.model.thinking,
    );
    const engineValue =
      translateWebuiModelIdToEngineValue(cs, variantTarget, {
        preferVariant: variantPlan.variant[level],
      }) ?? variantTarget;
    const r = await setConfigOption(sid, "model", engineValue, ctx.cid);
    if (modelId) mcodeSynced = r.ok;
    // "thinking synced" reports the level actually carried by the
    // push: an explicit pick, or a previously recorded one. An
    // engine-default variant (no user-chosen level) is not a sync.
    const carriedLevel = thinkingWasProvided ? !!thinking : !!(cs.model && cs.model.thinking);
    thinkingSynced = r.ok && carriedLevel;
    if (!r.ok) warning = r.error;
  } else if (sid) {
    if (modelId) {
      // The engine wire form is `m:<encodedProvider>:<encodedModel>:u`
      // (see packages/tui/src/acp/control-state.ts#modelConfigValue).
      // The webui id is `<providerKey>/<engineModelKey>` — translate it
      // to the engine wire form so `parseModelConfigValue` accepts it.
      // The same resolver used by `applyRecordedModel` lives in
      // `lib/mcode-acp.js#resolveModelId` and exports the helper we
      // need; the route layer keeps the apply path's reasoning
      // (single source of truth for "recorded → engine option.value").
      const engineValue = translateWebuiModelIdToEngineValue(cs, modelId) ?? modelId;
      const r = await setConfigOption(sid, "model", engineValue, ctx.cid);
      mcodeSynced = r.ok;
      if (!r.ok) warning = r.error;
    }
    if (thinkingWasProvided && thinking) {
      const r = await setConfigOption(sid, "thinkingEffort", thinking, ctx.cid);
      thinkingSynced = r.ok;
      if (!r.ok && (!warning || warning === null || warning === "no mcode session yet — recorded for the next one")) {
        warning = r.error;
      }
      if (r.ok) {
        // Mirror the apply on the local configOptions snapshot so a
        // follow-up /api/models reads the engine's new currentValue
        // before the SSE flush lands (same reason as
        // applyRecordedModel's cs.configOptions write).
        const opts = Array.isArray(cs.configOptions) ? cs.configOptions : [];
        for (const o of opts) {
          if (o && o.id === "thinkingEffort") {
            o.currentValue = thinking;
          }
        }
      }
    } else if (thinkingWasProvided && !thinking && modelId) {
      // Model changed AND effort cleared. The engine picks its own
      // default for the new model; we drop the local mirror so a
      // subsequent /api/models doesn't keep showing the cleared value.
      const opts = Array.isArray(cs.configOptions) ? cs.configOptions : [];
      for (const o of opts) {
        if (o && o.id === "thinkingEffort") {
          delete o.currentValue;
        }
      }
    }
  }
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingWasProvided ? { thinking } : {}),
      ...(contextWindowWasProvided ? { contextWindow: contextWindow ?? null } : {}),
      mcodeSynced,
      thinkingSynced,
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

// POST /api/answer — REMOVED capability, kept only as a tombstone.
//
// This route was a legacy no-op: it read the body, logged it, and answered
// `{ok:true, deprecated:true}` without ever reaching the engine. The webapp's
// plan modal (three buttons) and the ask modal's Skip button both called it,
// so a click looked successful while the prompt stayed pending — a fake
// capability, and the reason those four buttons did nothing.
//
// It now answers 410 Gone with `ok:false`. The remaining live channels are
// `POST /api/send {content, isAskAnswer:true}` (ask_user) and
// `POST /api/auth/decision` (authorization). A plan decision has NO
// webui-reachable channel: the engine's plan review is a runtime
// `questionnaire.ask` answered on the local-runtime channel
// (`runtime.replyQuestionnaire`), which this server does not speak. The
// protocol trace is in `webapp/components/modals.tsx#PlanModal`.
//
// Delete this route once no client in the wild references it; it is retained
// so a stale caller gets an explicit refusal rather than a 404 it cannot
// explain.
export async function handleAnswer(req, res, _ctx) {
  const payload = await readJson(req);
  if (process.env.MCODE_USAGE_DEBUG)
    console.log(
      `[api.answer] type=${payload.type} option=${payload.option} (removed, no engine channel)`,
    );
  res.writeHead(410, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: false,
      removed: true,
      error:
        "POST /api/answer never reached the engine and no longer pretends to. " +
        "Use POST /api/send with isAskAnswer for ask_user, or POST /api/auth/decision for authorization.",
    }),
  );
}
