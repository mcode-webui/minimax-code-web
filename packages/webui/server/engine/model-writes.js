// webui/server/engine/model-writes.js
//
// Migration step M3, batch B10: the MODEL / PERMISSION WRITE family —
//
//   #58  POST /api/set-model      — pick a model, a thinking level, a context window
//   #59  POST /api/permissions    — change the session's permission mode
//
// B4 moved the READ half of this endpoint family
// (`engine/model-reads.js`); this moves the WRITE half. Nothing about the
// wire changes: every status, field, ordering and warning string these two
// routes produce is the one they produced before this batch, and the suite
// pins them as values. What changed is WHERE the reasoning lives — the
// model-id translation, the variant-channel decision, the thinking-effort
// mirror rule and the permission label mapping are now named, exported and
// tested on their inputs, instead of being inline branches in a route.
//
// The boundary, stated once:
//
//   THE ENGINE-FACING HALF MOVED HERE. EVERYTHING ELSE STAYED IN THE ROUTE.
//
// | Concern                                   | Home after B10                              |
// | ----------------------------------------- | ------------------------------------------- |
// | webui id → engine wire value              | `resolveEngineModelConfigValue` (here)      |
// | variant channel vs effort channel         | `planModelSelectionPush` (here)             |
// | the two `set_config_option` pushes        | `pushEngineModelSelection` (here)           |
// | permission mode → label / engine value    | `resolvePermissionSelection` (here)         |
// | the permission-mode engine push           | `pushEnginePermissionMode` (here)           |
// | body parsing, the 400s, the 200           | `routes/model.js`                           |
// | `cs.model` / `cs.permissions` writes      | `routes/model.js` (B9's rule, reused)       |
// | `pushStateFor` and the response body      | `routes/model.js`                           |
// | the `configOptions` snapshot mirror       | `applyThinkingEffortMirror` (rule here, write in the route) |
//
// The last row is the deliberate exception to "the route owns client
// state", and it is the same split B9 drew: this module owns the RULE
// ("after an accepted thinkingEffort push, the local snapshot should claim
// the engine's new value; after a cleared pick it should claim none"), the
// route owns the WRITE (`cs.configOptions` is webui's own view, mutated in
// place exactly as before, and only on the same conditions as before).
//
// What this file deliberately does NOT do:
//
//   - It does not gate either endpoint. The decision belongs to a human,
//     and the KNOWN DEBT section at the bottom costs both branches: the
//     push is one call site per endpoint, so arming either gate is one
//     line and nothing else in this file moves.
//   - It does not build a host. There is no host on this path.
//   - It does not own the transport table or the `501` mapping. B9 owns
//     those for #67/#68, and this batch does not duplicate them.
//
// Boot-path weight. `routes/model.js` imports this module directly rather
// than through `engine/index.js`, and that is the same call B4 made for
// `model-reads.js`: this module statically imports `lib/engine-catalogue.js`
// (which reaches `js-yaml`), so re-exporting it from the facade index would
// make `engine/index.js` heavier than the rest of the server's one shared
// import site. The server's own boot cost is unchanged — every module
// involved was already on it through this route. `lib/mcode-rpc.js` (and
// with it the ACP client) is reached through `await import()` inside the
// two data-plane functions, so the same rule every other engine family
// follows holds here too.

import { resolveModelId, variantChannelFor } from "../lib/engine-catalogue.js";

/**
 * #58's "no session yet" warning — the record-only path.
 *
 * A string, not a status: the route answers 200 with this in `warning` so
 * the composer can show the pick as local-only until a session exists. It
 * is exported because it is a WIRE value — a client-visible English
 * sentence with a test that compares it character for character — and
 * keeping a second hand-typed copy of it next to the only place that
 * produces it is how the two drift apart.
 *
 * @type {string}
 */
export const NO_SESSION_MODEL_WARNING = "no mcode session yet — recorded for the next one";

/**
 * #59's "no session yet" warning. Different sentence from #58's on
 * purpose — the recorded thing differs (a mode vs a model pick) and the
 * wire is byte-compared against the pre-B10 route in the suite.
 *
 * @type {string}
 */
export const NO_SESSION_PERMISSION_WARNING = "no mcode session yet — applies to the next one";

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
 *
 * @param {object} cs  The client state; only `configOptions` is read.
 * @param {string} modelId  The recorded webui id, or a variant target.
 * @param {{preferVariant?: string}} [resolveOpts]
 * @returns {string|null} The engine's `option.value`, or null.
 */
export function resolveEngineModelConfigValue(cs, modelId, resolveOpts) {
  if (!modelId || typeof modelId !== "string") return null;
  const allOpts = Array.isArray(cs && cs.configOptions) ? cs.configOptions : [];
  const modelOption = allOpts.find((o) => o && o.id === "model");
  if (!modelOption) return null;
  return resolveModelId(modelId, modelOption, resolveOpts);
}

/**
 * The model a request is aimed at: the one it names, else the one
 * already recorded.
 *
 * The fallback is what makes a thinking-only update on a switchable
 * builtin work — the variant rides the model, and a request that carries
 * only a level has to be attached to the model the session already has.
 * Exported because the executor needs the target BEFORE it can ask
 * `variantChannelFor` whether a plan exists, and deriving it twice from
 * two places is how the two copies drift.
 *
 * @param {object} cs  Client state; only `model.name` is read.
 * @param {string} [modelId]  The requested model, "" when absent.
 * @returns {string}
 */
export function modelSelectionTarget(cs, modelId) {
  return modelId || (cs && cs.model && cs.model.name) || "";
}

/**
 * The picks a /api/set-model request carries, as a plan the executor can
 * run without re-deriving anything.
 *
 * A plan is data, not a side effect: the branch structure below is the
 * part of #58 that is hardest to read in a route (two channels, three
 * fields, four interacting flags), and a route cannot test it. It is a
 * pure function of its inputs — `cs` is read, never written.
 *
 * The two channels are the whole of ticket 36, and they are mutually
 * exclusive:
 *
 *   VARIANT — the target rides the variant channel, i.e. it is a
 *   switchable builtin (the engine's `thinking_config.mode: switchable`
 *   + variant tree, e.g. MiniMax-M3). Such a model has NO engine effort
 *   vocabulary: the engine rejects every `thinkingEffort` value for it
 *   ("Thinking effort is not advertised for the selected model") and
 *   advertises it only as the wire pair `m:...:v:thinking` /
 *   `m:...:v:none-thinking`. ONE model push therefore carries both the
 *   model and the on/off level, and there is no second push at all.
 *
 *   EFFORT — everything else: a model push when the request names a
 *   model, then a `thinkingEffort` push when the request names a
 *   non-empty level. The ORDER IS THE ENGINE'S CONTRACT: it rejects a
 *   `thinkingEffort` set when no model is selected
 *   (`Select a Session model before changing thinking effort.`,
 *   agent.ts#1003), so model first, then effort.
 *
 * `carriedThinking` is the pre-B10 route's "was a level actually carried
 * by this push" test, and it differs per channel on purpose. On the
 * variant channel an UNCHANGED recorded level is still carried by the
 * model push, so an absent `thinking` field falls back to the recorded
 * value. On the effort channel a level is carried only when the request
 * carried one: an absent field means "leave the recorded effort alone",
 * and there is no wire form here that could carry it without also
 * re-selecting the model. A CLEARED field is carried on neither channel —
 * it is neither a level nor an absence, and `variantPlan.level("")`
 * resolves it to the engine's default variant. Pinned per channel because
 * collapsing them reads like a simplification and changes `thinkingSynced`
 * on real, successful pushes.
 *
 * @param {object} options
 * @param {object} options.cs  Client state; `configOptions`, `model.name`
 *        and `model.thinking` are read, nothing is written.
 * @param {string} [options.modelId]  The requested model, "" when absent.
 * @param {boolean} options.thinkingWasProvided  "the field was in the body",
 *        which is NOT the same as "the field is non-empty": an empty
 *        string is the documented clear sentinel.
 * @param {string} [options.thinking]  The requested level, "" to clear.
 * @param {{variant: object, defaultLevel: string, level: Function}|null} [options.variantPlan]
 *        From `variantChannelFor`; null on the effort channel.
 * @returns {{channel: "variant"|"effort", target: string,
 *            modelPush: {value: string}|null, thinkingPush: {value: string}|null,
 *            reportsModelSynced: boolean, carriedThinking: boolean}}
 */
export function planModelSelectionPush(options = {}) {
  const { cs, modelId = "", thinkingWasProvided = false, thinking = "", variantPlan = null } = options;
  const target = modelSelectionTarget(cs, modelId);
  const recordedThinking = (cs && cs.model && cs.model.thinking) || "";
  const reportsModelSynced = Boolean(modelId);

  if (variantPlan) {
    const level = variantPlan.level(thinkingWasProvided ? thinking : recordedThinking);
    const value =
      resolveEngineModelConfigValue(cs, target, { preferVariant: variantPlan.variant[level] }) ?? target;
    return {
      channel: "variant",
      target,
      modelPush: { value },
      thinkingPush: null,
      reportsModelSynced,
      carriedThinking: thinkingWasProvided ? Boolean(thinking) : Boolean(recordedThinking),
    };
  }

  return {
    channel: "effort",
    target,
    modelPush: modelId
      ? { value: resolveEngineModelConfigValue(cs, modelId) ?? modelId }
      : null,
    thinkingPush: thinkingWasProvided && thinking ? { value: thinking } : null,
    reportsModelSynced,
    carriedThinking: thinkingWasProvided ? Boolean(thinking) : false,
  };
}

/**
 * Which fields a /api/set-model pick stamps, and when.
 *
 * Ticket 08 (the set-model SSE race): the engine's `config_option_update`
 * re-asserts its own wire-form `currentValue`, and without a marker it
 * would land that wire form on the user's pick a few milliseconds after
 * the optimistic write — the chip flickering between the user-friendly
 * recorded form and the engine wire form. `server/lib/mcode-acp.js` reads
 * `modelPickedAt` / `thinkingPickedAt` and defers the mirror while the
 * stamp is FRESH (`PICK_DEFER_WINDOW_MS`, 4s). That file is not this
 * batch's to change; this function is the writer's half of the contract
 * and the suite pins the reader's half against it.
 *
 * Two properties are load-bearing and both are preserved verbatim:
 *
 *   1. ONE timestamp for every field of one request. The window is a race
 *      window, not three independent ones — a pick that takes 30ms must
 *      not leave the model field expiring 30ms before the effort field.
 *      The caller passes `pickAt` in (taken once, before the engine is
 *      called) so all stamped fields share it by construction.
 *   2. ONLY the fields the request actually carried. A thinking-only
 *      update must not refresh `modelPickedAt`, or a later cross-client
 *      model change would be suppressed by a pick the user never made —
 *      that is the reverse half of the race, and the one a
 *      "stamp everything" simplification silently breaks.
 *
 * `contextWindowPickedAt` rides along for symmetry with the two fields
 * the mirror reads. It is recorded and nothing consumes it today (the
 * engine has no context-window channel, see the route's comment on U6);
 * it was stamped before this batch and stays stamped.
 *
 * @param {object} request  Which fields the body carried.
 * @param {string} [request.modelId]
 * @param {boolean} [request.thinkingWasProvided]
 * @param {boolean} [request.contextWindowWasProvided]
 * @param {number} pickAt  The single timestamp for this request.
 * @returns {Record<string, number>} `{}` when nothing was carried, else
 *          one entry per carried field, all equal to `pickAt`.
 */
export function planModelPickStamps(request = {}, pickAt) {
  const stamps = {};
  if (request.modelId) stamps.modelPickedAt = pickAt;
  if (request.thinkingWasProvided) stamps.thinkingPickedAt = pickAt;
  if (request.contextWindowWasProvided) stamps.contextWindowPickedAt = pickAt;
  return stamps;
}

/**
 * Apply the local `configOptions` mirror rule for one /api/set-model
 * push. The RULE lives here; the WRITE is the caller's, because
 * `cs.configOptions` is webui's own state.
 *
 * The mirror exists so a follow-up `/api/models` reads the engine's new
 * `currentValue` before the SSE flush lands — the same reason
 * `applyRecordedModel` writes `cs.configOptions` on the boot path. The
 * two arms are the two outcomes:
 *
 *   `{kind: "set", value}`  — the engine accepted a new effort; claim it.
 *   `{kind: "clear"}`       — the effort was cleared AND a model changed;
 *     the engine picks its own default for the new model, so the local
 *     mirror is DROPPED rather than left showing the cleared value.
 *   `null`                  — nothing to do (every other case).
 *
 * Mutates the array in place and returns how many options it touched,
 * which is what makes the "no thinkingEffort option in the snapshot yet"
 * case observable instead of a silent no-op.
 *
 * @param {object[]|undefined} configOptions  `cs.configOptions`.
 * @param {{kind: "set", value: string}|{kind: "clear"}|null} mirror
 * @returns {number} Options changed.
 */
export function applyThinkingEffortMirror(configOptions, mirror) {
  if (!mirror) return 0;
  const opts = Array.isArray(configOptions) ? configOptions : [];
  let touched = 0;
  for (const o of opts) {
    if (!o || o.id !== "thinkingEffort") continue;
    if (mirror.kind === "clear") delete o.currentValue;
    else o.currentValue = mirror.value;
    touched++;
  }
  return touched;
}

/**
 * A /api/permissions mode, resolved to both forms the endpoint needs:
 * the webui label it records and pushes to every tab, and the engine
 * value it forwards.
 *
 * The five webui ids (`ask` / `auto` / `read` / `off` / `full`, plus any
 * unknown or missing one, which both mappers resolve to the `full`
 * entry) are mapped in `lib/interaction/permission-presets.js` and
 * `lib/mcode-rpc.js` respectively. This function is the single seam that
 * says the endpoint needs BOTH, so a future fifth form cannot be added to
 * one mapper and forgotten in the other.
 *
 * Async because one of the two mappers lives behind the RPC wrapper, and
 * the RPC wrapper is reached through `await import()` on this module's
 * boot-path rule. It is still a function of its input alone.
 *
 * @param {string} mode  The request's `mode`, any case.
 * @returns {Promise<{label: string, mcodeValue: string|null}>}
 */
export async function resolvePermissionSelection(mode) {
  const [presets, rpc] = await Promise.all([
    import("../lib/interaction/permission-presets.js"),
    import("../lib/mcode-rpc.js"),
  ]);
  const webuiMode = (mode || "full").toLowerCase();
  return {
    label: presets.webuiModeToLabel(webuiMode),
    mcodeValue: rpc.webuiPermissionToMcode(webuiMode),
  };
}

/**
 * #58 — push the planned model selection to the engine.
 *
 * The order below IS the endpoint's contract and none of it is new:
 *
 *   1. NO SESSION → answer with the local-only warning and stop. The pick
 *      is recorded by the route and re-applied on the next boot by
 *      `applyRecordedModel`; there is nothing to push and nothing to say
 *      about `mcodeSynced` beyond false.
 *   2. PLAN. `variantChannelFor` reads the engine's materialised builtin
 *      tree; a plan comes back for a switchable builtin and null for
 *      everything else.
 *   3. PUSH, in the plan's order. The first failure sets the warning; a
 *      second failure on the effort channel only escalates when the
 *      warning is still the untouched default, so a model rejection is
 *      not overwritten by the effort rejection it caused.
 *   4. MIRROR DECISION, returned rather than applied (see the module
 *      header).
 *
 * `mcodeSynced` reports the MODEL push only, and is false for a
 * thinking-only update even when that update succeeded — the field's
 * meaning is "the model is in the engine", and there was no model in the
 * request. `thinkingSynced` reports the LEVEL.
 *
 * @param {object} options
 * @param {object} options.cs  Client state; read only.
 * @param {string} [options.cid]  Routed to the RPC wrapper, which pins
 *        the call on the client that owns this tab's session.
 * @param {string} [options.modelId]
 * @param {boolean} [options.thinkingWasProvided]
 * @param {string} [options.thinking]
 * @returns {Promise<{channel: string, mcodeSynced: boolean,
 *          thinkingSynced: boolean, warning: string|null,
 *          thinkingMirror: {kind: "set", value: string}|{kind: "clear"}|null,
 *          plan: object}>}
 */
export async function pushEngineModelSelection(options = {}) {
  const { cs, cid, modelId = "", thinkingWasProvided = false, thinking = "" } = options;
  const sid = cs && cs.mcodeSessionId;
  if (!sid) {
    return {
      channel: "no-session",
      mcodeSynced: false,
      thinkingSynced: false,
      warning: NO_SESSION_MODEL_WARNING,
      thinkingMirror: null,
      plan: null,
    };
  }
  const [rpc] = await Promise.all([import("../lib/mcode-rpc.js")]);
  const variantPlan = variantChannelFor(modelSelectionTarget(cs, modelId));
  const plan = planModelSelectionPush({ cs, modelId, thinkingWasProvided, thinking, variantPlan });

  let mcodeSynced = false;
  let thinkingSynced = false;
  let warning = null;

  if (plan.channel === "variant") {
    const r = await rpc.setConfigOption(sid, "model", plan.modelPush.value, cid);
    mcodeSynced = plan.reportsModelSynced ? r.ok : false;
    thinkingSynced = Boolean(r.ok) && plan.carriedThinking;
    if (!r.ok) warning = r.error;
    return { channel: "variant", mcodeSynced, thinkingSynced, warning, thinkingMirror: null, plan };
  }

  if (plan.modelPush) {
    const r = await rpc.setConfigOption(sid, "model", plan.modelPush.value, cid);
    mcodeSynced = r.ok;
    if (!r.ok) warning = r.error;
  }
  if (plan.thinkingPush) {
    const r = await rpc.setConfigOption(sid, "thinkingEffort", plan.thinkingPush.value, cid);
    thinkingSynced = r.ok;
    // Escalate only when the model push left the warning untouched. The
    // pre-B10 route spelled this as a three-way disjunction
    // (`!warning || warning === null || warning === NO_SESSION_MODEL_WARNING`);
    // `warning` is `null` here or a string the model push already set —
    // this executor returns the no-session case before reaching the push —
    // so `!warning` is the same test without the branch that can never be
    // taken.
    if (!r.ok && !warning) warning = r.error;
  }
  // The two mirror arms, and the conditions are the pre-B10 ones: an
  // accepted effort claims the engine's new value, while a CLEARED
  // effort is mirrored by DROPPING the local value (and only when a
  // model also changed — a clear on its own is applied by the next
  // `config_option_update`, and dropping here would invent an engine
  // state the engine never reported). The clear does NOT depend on the
  // model push having succeeded, which is also pre-existing.
  const thinkingMirror =
    thinkingWasProvided && thinking
      ? thinkingSynced
        ? { kind: "set", value: thinking }
        : null
      : thinkingWasProvided && !thinking && modelId
        ? { kind: "clear" }
        : null;
  return { channel: "effort", mcodeSynced, thinkingSynced, warning, thinkingMirror, plan };
}

/**
 * #59 — push the permission mode to the engine.
 *
 * One push, one shape. The two conditions that guard it are the
 * pre-B10 ones: no session means the change is local until the next one
 * (the warning says so), and a mode with no engine value is recorded and
 * not pushed.
 *
 * The second condition is NOT hypothetical. The two mappers disagree on
 * an unrecognised mode on purpose: `webuiModeToLabel` falls back to
 * `full` so the UI always has a label, while `webuiPermissionToMcode`
 * returns null because there is no engine word for a mode the user
 * invented. So `POST /api/permissions {"mode":"nonsense"}` records
 * "Full access" and pushes nothing — and the guard is the difference
 * between "the engine is in this mode" and "we hope it is".
 *
 * @param {object} options
 * @param {object} options.cs  Client state; only `mcodeSessionId` is read.
 * @param {string} options.mcodeValue  From `resolvePermissionSelection`.
 * @param {string} [options.cid]
 * @returns {Promise<{mcodeSynced: boolean, warning: string|null}>}
 */
export async function pushEnginePermissionMode(options = {}) {
  const { cs, cid, mcodeValue } = options;
  const sid = cs && cs.mcodeSessionId;
  if (!sid) {
    return { mcodeSynced: false, warning: NO_SESSION_PERMISSION_WARNING };
  }
  if (!mcodeValue) {
    return { mcodeSynced: false, warning: null };
  }
  const [rpc] = await Promise.all([import("../lib/mcode-rpc.js")]);
  const r = await rpc.setConfigOption(sid, "permissionMode", mcodeValue, cid);
  return { mcodeSynced: Boolean(r.ok), warning: r.ok ? null : r.error };
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
//   1. NEITHER ENDPOINT IS GATED, AND THAT IS A DECISION LEFT OPEN FOR A
//      HUMAN — not an oversight. B9's gate already exempts exactly the two
//      config ids these endpoints write (`model` → `selectModel`,
//      `permissionMode` → `setPermissionMode`, see
//      `MODE_WRITE_BRIDGED_CONFIG_IDS` in `engine/mode-writes.js`), so
//      both sub-items are known names and neither needs rediscovering.
//      What stops the gate from being switched on here is one more config
//      id, and it is #58's:
//
//        - #59 /api/permissions writes `permissionMode` ONLY. Gating it
//          hard on `authCredentials.setPermissionMode` is behaviourally
//          inert today (no registered provider lists that sub-item as
//          missing, and the snapshot audit now proves both providers
//          really have the method) and is safe against the shipped UI,
//          which already hides the permission selector under exactly that
//          declaration (`webapp/lib/engine-capabilities.ts` +
//          `composer.tsx`). The change is one
//          `assertEngineCapability(...)` call before the push.
//
//        - #58 /api/set-model ALSO writes `thinkingEffort`, and
//          `thinkingEffort` is a GENERIC config id — the one the plan
//          (§3a, row 68) says has nowhere to be delivered under a
//          provider with no generic write. Gating #58 the same way makes
//          the thinking-effort control answer 501 for the same reason #68
//          does for an unrecognised id.
//
//      Two branches, both costed, neither chosen here:
//
//        (a) BRIDGE `thinkingEffort` as a THIRD id in
//            `MODE_WRITE_BRIDGED_CONFIG_IDS`, pointed at a sub-item that
//            means "the dedicated thinking-effort writer". Cost: a third
//            name in a table the frontend mirrors, and a third declaration
//            the snapshot audit must then prove exists on both surfaces
//            (today's probe found no `setThinkingEffort` /
//            `selectThinkingEffort` on either, so the name would have to
//            be agreed with the engine team first). Benefit: #58 becomes
//            gateable on the same table as #59, and the two controls stay
//            symmetric.
//
//        (b) ACCEPT the 501 and degrade the UI. Cost: the thinking-effort
//            control disappears for any provider that denies the generic
//            config write — which, under M4's ACP provider, is most of
//            them — and `#58` loses a working half to keep an enrichment.
//            `webapp/lib/engine-capabilities.ts` would need a third
//            bridged id for the effort control to follow the same
//            fail-open rule rather than a 501 at click time.
//
//      Until a human picks one, #58 keeps its pre-B10 behaviour, and this
//      module stays gate-ready: the push is already a single call site per
//      endpoint, so arming either gate is one line in the executor.
//
//   2. B9's KNOWN DEBT 2 (the bridge naming sub-items no audited host was
//      proven to have) IS CLOSED BY THIS BATCH, and the evidence is in
//      `test/lib/engine/capability-snapshot.test.js`: `selectModel` and
//      `setPermissionMode` are now in `REQUIRED_METHODS`, so the audit
//      asserts they are functions on BOTH the adapter and the cliService
//      surface of a real booted host. They were verified present before
//      being added. `engine/mode-writes.js` is a read-only reference in
//      this batch, so its own debt text is left as written; this entry is
//      the closure record.
//
//   3. `contextWindow` IS RECORDED AND NEVER PUSHED. The engine's ACP
//      surface has no channel for it (`session/set_config_option` accepts
//      exactly three config ids and the model wire encoding has no context
//      segment), so the pick is a webui-side preference the picker
//      reflects immediately. That is pre-existing and unchanged here; it
//      is listed because this batch is the one that owns the whole
//      #58 write, and a reader of this file should not assume the whole
//      request reaches the engine. Wiring it is engine-side work; the seam
//      is `planModelSelectionPush`'s output, which a future engine
//      channel would extend with a third push.
