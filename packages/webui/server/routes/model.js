// webui/server/routes/model.js
// GET /api/models, POST /api/set-model, POST /api/permissions, POST /api/answer (legacy)
//
// M3-B4 moved the READ (`GET /api/models`) behind the engine facade
// (`server/engine/model-reads.js`). M3-B10 moved the WRITE half: the
// model-id translation, the variant-channel decision, the two
// `set_config_option` pushes and the permission label mapping now live in
// `server/engine/model-writes.js`.
//
// What stayed here, and why: the body parsing and its 400s (caller
// confusion, not an engine limitation), the `cs.model` / `cs.permissions`
// writes, `pushStateFor`, and the response bodies. The mirror rule for
// `cs.configOptions` is the one seam that is half-and-half — the RULE
// (`applyThinkingEffortMirror`) is the facade's, the WRITE stays here,
// because `cs` is webui's own state. See that module's header for the
// full boundary table.
//
// The wire is byte-identical to the pre-B10 route: every status, field
// order, warning string and push order is pinned as a value in
// `test/lib/engine/model-writes.test.js` and, end to end through this
// route, in `test/routes/model.check.mjs`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pushStateFor } from "../lib/state-bus.js";
import { mcodePermissionToWebui, PERMISSION_MODES } from "../lib/mcode-rpc.js";
import { readEngineModelCatalogue } from "../engine/model-reads.js";
import {
  applyThinkingEffortMirror,
  planModelPickStamps,
  pushEngineModelSelection,
  pushEnginePermissionMode,
  resolvePermissionSelection,
} from "../engine/model-writes.js";
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
  //   One timestamp for the whole request, and only the fields the body
  //   actually carried — see `planModelPickStamps`.
  const pickAt = Date.now();
  Object.assign(
    cs.model,
    planModelPickStamps({ modelId, thinkingWasProvided, contextWindowWasProvided }, pickAt),
  );
  const { mcodeSynced, thinkingSynced, warning, thinkingMirror } = await pushEngineModelSelection({
    cs,
    cid,
    modelId,
    thinkingWasProvided,
    thinking,
  });
  applyThinkingEffortMirror(cs.configOptions, thinkingMirror);
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
//
// `resolvePermissionSelection` is the one seam that produces both forms
// of the mode — the webui label recorded on `cs.permissions` and pushed
// to every tab, and the engine value forwarded — so the two mappers
// cannot drift apart. The push itself, and the "no session yet" warning,
// belong to `engine/model-writes.js#pushEnginePermissionMode`.
export async function handleSetPermissions(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const { label, mcodeValue } = await resolvePermissionSelection(payload.mode);
  const { mcodeSynced, warning } = await pushEnginePermissionMode({ cs, cid, mcodeValue });
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
