// webui/server/engine/goal.js
//
// PB-14 batch A (fact baseline `doc/pb14-goal-baseline.md` §1/§3): the
// engine facade over the THREAD GOAL surface — the one domain the engine
// had fully implemented with no window in front of it at all.
//
//   GET    /api/goal/enabled → adapter.isGoalEnabled
//   GET    /api/goal         → adapter.getGoal
//   POST   /api/goal         → adapter.createGoal
//   PATCH  /api/goal         → adapter.patchGoal
//   DELETE /api/goal         → adapter.clearGoal
//
// WHY THE ADAPTER AND NOT `cliService`. Both carry the five methods —
// `cli-service.ts:488-515` delegates to the same `applications.goals`
// facade the adapter reaches. The adapter is chosen for one reason: it is
// the surface the TUI's own `/goal` flow drives (`tui/runtime/adapter.ts:283-295`
// over `adapters/goal-access.ts`), so the object this file binds is the
// object whose behaviour `/goal` in the CLI already has. Going through
// `cliService` would be a second path to the same facade with no
// behavioural difference and one more place for the two to drift apart.
// `streaming-send.js` already reaches `catalogue.adapter` for the same
// reason.
//
// WHY THE FIVE, AND WHY NOT `/goal`'s PARSER. The parser
// (`tui/application/thread-goal-command.ts`) is a CLIENT-side concern:
// eight intents over a command string, with budget K/M suffixes and CJK
// boundary leniency. webui's composer is that client, and it is batch C's
// file (`webapp/lib/goal-command.ts`), not this one. What the engine
// recognises is the five methods below and nothing else — so the server
// exposes the five methods, and every product decision about what a user
// typed stays on the side that owns the input box.
//
// READS PEEK, WRITES BOOT — `engine/host.js`'s rule, for PB-13's reason.
// `GET /api/goal` is on the session-switch path and `GET /api/goal/enabled`
// is the frontend's switch check, so a booting getter would turn the first
// paint of a fresh process into a multi-second stall. The three writes
// boot: the user pressed a button.
//
// WHY A DISABLED GOAL IS ITS OWN ANSWER. The facade throws a plain
// `Error("Thread Goal is disabled.")` with no status when the feature is
// off (`compat/v1/runtime.ts:774`), which a generic error map can only
// turn into a 500 — a server fault for a configuration fact. So
// `isGoalEnabled` is asked ONCE per request here, before the session-scoped
// call, and a disabled goal answers 503 `goal_disabled` with nothing
// called. That is also the answer the frontend's switch wants: "the goal
// surface is off" and "the runtime is not up yet" are different facts and
// stay different codes.
//
// 501 IS THE HONEST ANSWER FOR AN UNREACHABLE METHOD, and it is returned
// as a value rather than thrown as `EngineCapabilityNotSupportedError`
// (which `app.js#invokeHandler` would map centrally): every other outcome
// in this file is a returned value too, and a facade whose four failure
// modes have three shapes is a facade whose callers must catch. The wire
// result is the same — 501 with a structured body — and the tests drive
// the same seam either way.

import { mapFollowUpError } from "./follow-up.js";

/** The endpoint label every failure line starts with. */
const ENDPOINT = "/api/goal";

/**
 * The six statuses a goal can hold, as the engine spells them
 * (`packages/shared/src/global-events.ts:126-164`). This is the SAME
 * enumeration the desktop operation validator uses
 * (`other-minimax-code/packages/webui/src/server/operation/goal.ts:11`),
 * transcribed rather than invented: a status outside this set is a client
 * bug, and letting it reach the engine turns a typo into a 500.
 *
 * @type {ReadonlySet<string>}
 */
export const GOAL_STATUSES = Object.freeze(
  new Set([
    "active",
    "paused",
    "blocked",
    "complete",
    "budget_limited",
    "usage_limited",
  ]),
);

/**
 * The five engine methods, as one table.
 *
 * `member` is `"adapter"` for all five: the goal surface lives on the
 * TuiRuntimeAdapter the catalogue host constructs. Naming it as a field
 * rather than hard-coding `host.adapter` at five call sites is what makes
 * a sixth action a table edit, and it keeps the 501 message able to name
 * the exact path that was missing.
 *
 * @type {Readonly<Record<string, Readonly<{member: "adapter", method: string}>>>}
 */
export const GOAL_ACTIONS = Object.freeze({
  enabled: Object.freeze({ member: "adapter", method: "isGoalEnabled" }),
  read: Object.freeze({ member: "adapter", method: "getGoal" }),
  create: Object.freeze({ member: "adapter", method: "createGoal" }),
  patch: Object.freeze({ member: "adapter", method: "patchGoal" }),
  clear: Object.freeze({ member: "adapter", method: "clearGoal" }),
});

/**
 * Resolve the host under one boot policy.
 *
 * @param {object} options
 * @param {boolean} [options.read] Peek instead of boot.
 * @param {Function} [options.getHost] Test seam: production leaves it
 *   unset, a test passes a fake host and the policy becomes irrelevant.
 * @returns {Promise<object|null>}
 */
async function resolveGoalHost(options) {
  if (options.getHost) return options.getHost();
  const { peekEngineCatalogueHost, getEngineCatalogueHost } = await import("./host.js");
  return options.read === true ? peekEngineCatalogueHost() : getEngineCatalogueHost();
}

/**
 * Locate the host, or report why it cannot be located.
 *
 * @param {object} options
 * @param {boolean} [options.read] Peek instead of boot.
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, host: object}|{ok: false, code: string, status: number, error: string}>}
 */
async function locateGoalHost(options) {
  let host;
  try {
    host = await resolveGoalHost(options);
  } catch (e) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: e && e.message ? e.message : String(e),
    };
  }
  if (!host) {
    return {
      ok: false,
      code: "engine_host_unavailable",
      status: 503,
      error: `${ENDPOINT}: the engine catalogue host is not available`,
    };
  }
  return { ok: true, host };
}

/**
 * Locate the host and bind one goal method off it.
 *
 * A missing host is 503 and a missing method is 501, and they are kept
 * apart on purpose: "no runtime is up" is a fact about this process that
 * a retry may fix, while "this host cannot be asked about goals" is a fact
 * about the provider that a retry will never fix.
 *
 * @param {object} options
 * @param {keyof GOAL_ACTIONS} options.action
 * @param {boolean} [options.read]
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, host: object, member: Function}|{ok: false, code: string, status: number, error: string}>}
 */
async function requireGoalMethod(options) {
  const located = await locateGoalHost(options);
  if (!located.ok) return located;
  const bound = requireGoalMethodSync(located.host, options.action);
  if (!bound.ok) return bound;
  return { ok: true, host: located.host, member: bound.member };
}

/**
 * Ask whether the goal feature is on, as a value rather than a call that
 * can throw.
 *
 * `isGoalEnabled` is SYNCHRONOUS on the adapter (it reads a facade flag,
 * not a store), so it is wrapped rather than awaited — and a host whose
 * flag method itself throws is reported, not treated as "off": a failed
 * question and a false answer are different facts.
 *
 * @param {object} options
 * @param {object} options.host
 * @returns {{ok: true, enabled: boolean}|{ok: false, code: string, status: number, error: string}}
 */
export function readGoalEnabledFlag(options) {
  const bound = requireGoalMethodSync(options.host, "enabled");
  if (!bound.ok) return bound;
  try {
    return { ok: true, enabled: bound.member() === true };
  } catch (error) {
    return mapGoalError(error, `${ENDPOINT} (isGoalEnabled)`);
  }
}

/**
 * The synchronous half of `requireGoalMethod`: the enabled check runs
 * BEFORE the session-scoped call, and it must not boot a runtime to ask a
 * question about a feature flag.
 *
 * @param {object} host
 * @param {keyof GOAL_ACTIONS} action
 * @returns {{ok: true, member: Function}|{ok: false, code: string, status: number, error: string}}
 */
function requireGoalMethodSync(host, action) {
  const { member: memberName, method } = GOAL_ACTIONS[action];
  const surface = host?.[memberName];
  if (typeof surface?.[method] !== "function") {
    return {
      ok: false,
      code: "engine_member_unavailable",
      status: 501,
      error: `${ENDPOINT}: host.${memberName}.${method} is not a function — this engine does not serve goals`,
    };
  }
  return { ok: true, member: surface[method].bind(surface) };
}

/**
 * Map an engine error onto a wire result.
 *
 * `mapFollowUpError` is reused rather than reimplemented because the
 * interesting case is the same one it already handles: the engine's
 * `ThreadGoalContractError` carries `status` 404 and `code`
 * `"GOAL_NOT_FOUND"` (`local-runtime/src/thread-goal/contract.ts:74-83`,
 * thrown by `compat/v1/runtime.ts#goalNotFound`), so the 404 the desktop
 * client sees is the engine's own, not a webui translation of it.
 *
 * @param {unknown} error
 * @param {string} label
 * @returns {{ok: false, code: string, status: number, error: string}}
 */
export function mapGoalError(error, label) {
  return mapFollowUpError(error, label);
}

/**
 * The disabled gate shared by the four session-scoped actions.
 *
 * @param {object} options
 * @param {object} options.host
 * @returns {null|{ok: false, code: string, status: number, error: string}}
 *   `null` means goals are enabled and the caller may proceed.
 */
export function classifyGoalDisabled(options) {
  const flag = readGoalEnabledFlag(options);
  if (!flag.ok) return flag;
  if (flag.enabled) return null;
  return {
    ok: false,
    code: "goal_disabled",
    status: 503,
    error: `${ENDPOINT}: the engine has the thread-goal feature turned off, so this session has no goal to read or change`,
  };
}

/**
 * `GET /api/goal/enabled` — the frontend's switch check.
 *
 * Answers ONLY the flag. It does not look for a goal: "the feature is off"
 * and "there is no goal yet" are different answers to different questions,
 * and collapsing them would leave the composer unable to tell a user why
 * their `/goal` did nothing.
 *
 * @param {object} [options]
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function readEngineGoalEnabled(options = {}) {
  const located = await locateGoalHost({
    read: true,
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!located.ok) return located;
  const flag = readGoalEnabledFlag({ host: located.host });
  if (!flag.ok) return flag;
  return { ok: true, payload: { ok: true, enabled: flag.enabled } };
}

/**
 * `GET /api/goal` — this session's goal, or 404.
 *
 * The 404 is the ENGINE's: `getGoal` returns `undefined` for a session
 * with no goal, and webui maps that to 404 `GOAL_NOT_FOUND` rather than to
 * a 200 with `goal:null`. A client polling this on session switch has to
 * be able to say "this conversation has no goal" as a fact rather than
 * infer it from an absent field — the same reason the queue answers
 * `reachable:false` instead of an empty list.
 *
 * @param {object} options
 * @param {string} options.sessionId The ENGINE session id, never the body's.
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function readEngineGoal(options) {
  const bound = await requireGoalMethod({
    action: "read",
    read: true,
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!bound.ok) return bound;
  const disabled = classifyGoalDisabled({ host: bound.host });
  if (disabled) return disabled;
  let goal;
  try {
    goal = await bound.member(options.sessionId);
  } catch (error) {
    return mapGoalError(error, `${ENDPOINT} (getGoal)`);
  }
  if (!goal) {
    return {
      ok: false,
      code: "GOAL_NOT_FOUND",
      status: 404,
      error: `${ENDPOINT}: this conversation has no goal`,
    };
  }
  return projectGoalAnswer(goal);
}

/**
 * `POST /api/goal` — create this session's goal.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {unknown} options.objective Validated by `validateGoalObjective`
 *   before it gets here.
 * @param {unknown} options.tokenBudget Validated by `validateGoalTokenBudget`.
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function createEngineGoal(options) {
  const invalid = validateGoalObjective(options.objective);
  if (invalid) return invalid;
  const budget = validateGoalTokenBudget(options.tokenBudget);
  if (budget) return budget;
  const bound = await requireGoalMethod({
    action: "create",
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!bound.ok) return bound;
  const disabled = classifyGoalDisabled({ host: bound.host });
  if (disabled) return disabled;
  let goal;
  try {
    goal = await bound.member({
      sessionId: options.sessionId,
      objective: options.objective,
      ...(options.tokenBudget !== undefined
        ? { tokenBudget: options.tokenBudget }
        : {}),
    });
  } catch (error) {
    return mapGoalError(error, `${ENDPOINT} (createGoal)`);
  }
  return projectGoalAnswer(goal);
}

/**
 * `PATCH /api/goal` — change the objective, the budget or the status.
 *
 * `{status:"complete", statusReason:"user_requested"}` is the case the
 * baseline flags as the risk to verify, and it is handled here rather than
 * specially: `statusReason` is NOT part of the patch the engine accepts
 * (`TuiGoalAccess.patch` takes status / objective / tokenBudget and the
 * engine derives the reason itself), so a client that sends it is
 * accepted and the field is DROPPED rather than forwarded. Forwarding it
 * would hand the engine an object its own contract does not declare, and
 * the engine would either ignore it silently or reject the whole patch —
 * the first is a claim webui cannot verify, the second breaks a request
 * the desktop client makes successfully.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {unknown} options.status
 * @param {unknown} options.objective
 * @param {unknown} options.tokenBudget
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function patchEngineGoal(options) {
  const patch = {};
  if (options.status !== undefined) {
    if (typeof options.status !== "string" || !GOAL_STATUSES.has(options.status)) {
      return invalidGoal(`status must be one of: ${[...GOAL_STATUSES].join(", ")}`);
    }
    patch.status = options.status;
  }
  if (options.objective !== undefined) {
    const invalid = validateGoalObjective(options.objective);
    if (invalid) return invalid;
    patch.objective = options.objective;
  }
  if (options.tokenBudget !== undefined) {
    const invalid = validateGoalTokenBudget(options.tokenBudget);
    if (invalid) return invalid;
    patch.tokenBudget = options.tokenBudget;
  }
  if (Object.keys(patch).length === 0) {
    return invalidGoal(
      "a goal patch needs at least one of: status, objective, tokenBudget",
    );
  }
  const bound = await requireGoalMethod({
    action: "patch",
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!bound.ok) return bound;
  const disabled = classifyGoalDisabled({ host: bound.host });
  if (disabled) return disabled;
  let goal;
  try {
    goal = await bound.member(options.sessionId, patch);
  } catch (error) {
    return mapGoalError(error, `${ENDPOINT} (patchGoal)`);
  }
  return projectGoalAnswer(goal);
}

/**
 * `DELETE /api/goal` — drop this session's goal.
 *
 * The engine's `clear` answers `true` only when it really deleted a goal,
 * and `false` is mapped to the same 404 `GOAL_NOT_FOUND` the facade itself
 * throws for a missing goal — otherwise "there was nothing to delete" and
 * "the goal is gone" would both be a 200 and a client that pressed clear
 * twice could not tell the second press did nothing.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {Function} [options.getHost]
 * @returns {Promise<{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}>}
 */
export async function clearEngineGoal(options) {
  const bound = await requireGoalMethod({
    action: "clear",
    ...(options.getHost ? { getHost: options.getHost } : {}),
  });
  if (!bound.ok) return bound;
  const disabled = classifyGoalDisabled({ host: bound.host });
  if (disabled) return disabled;
  let deleted;
  try {
    deleted = await bound.member(options.sessionId);
  } catch (error) {
    return mapGoalError(error, `${ENDPOINT} (clearGoal)`);
  }
  if (deleted !== true) {
    return {
      ok: false,
      code: "GOAL_NOT_FOUND",
      status: 404,
      error: `${ENDPOINT}: this conversation has no goal to clear`,
    };
  }
  return { ok: true, payload: { ok: true, success: true } };
}

/**
 * Project one engine goal onto the wire.
 *
 * Every field of `GlobalThreadGoal` the client renders is passed through
 * whole, INCLUDING the ones webui has no opinion about — `statusReason`,
 * `lastVerification`, `executionWait`, `tokensUsed`, `turnsUsed`,
 * `timeUsedSeconds`. Batch C's banner reads them and webui does not get
 * to decide which ones are real. The projection exists to spread the
 * engine's own record — no field is renamed, dropped or defaulted — and to
 * REFUSE an answer that is not an object at all, which an untrusted
 * boundary should not assume away. It returns a result value rather than
 * throwing, because every other failure mode in this file is a value and a
 * facade with two shapes forces its callers to catch.
 *
 * @param {unknown} goal
 * @returns {{ok: true, goal: object}|{ok: false, code: string, status: number, error: string}}
 */
export function projectGoal(goal) {
  if (!goal || typeof goal !== "object") {
    return {
      ok: false,
      code: "engine_contract_violation",
      status: 502,
      error: `${ENDPOINT}: the engine answered a goal that is not an object`,
    };
  }
  return { ok: true, goal: { ...goal } };
}

/**
 * Project an engine goal and wrap it in this family's success payload.
 *
 * One helper rather than four `projectGoal` call sites each re-deriving the
 * wrapper, because the wrapper IS the wire contract (`{ok:true, goal}`) and
 * four copies of it are four chances to spell it differently.
 *
 * @param {unknown} goal
 * @returns {{ok: true, payload: object}|{ok: false, code: string, status: number, error: string}}
 */
export function projectGoalAnswer(goal) {
  const projected = projectGoal(goal);
  if (!projected.ok) return projected;
  return { ok: true, payload: { ok: true, goal: projected.goal } };
}

/**
 * A 400 result in this family's one shape.
 *
 * @param {string} message
 * @returns {{ok: false, code: string, status: number, error: string}}
 */
function invalidGoal(message) {
  return {
    ok: false,
    code: "invalid_body",
    status: 400,
    error: `${ENDPOINT}: ${message}`,
  };
}

/**
 * An objective must be a non-empty string.
 *
 * Ported from the desktop validator
 * (`other-minimax-code/packages/webui/src/server/operation/goal.ts:29,42`)
 * with its predicate unchanged: `trim()` rather than a length check, so a
 * whitespace-only objective is refused here instead of becoming an engine
 * goal nobody can act on.
 *
 * @param {unknown} value
 * @returns {null|{ok: false, code: string, status: number, error: string}}
 */
export function validateGoalObjective(value) {
  if (typeof value !== "string" || !value.trim()) {
    return invalidGoal("objective must be a non-empty string");
  }
  return null;
}

/**
 * A token budget must be a positive integer or `null` (which means
 * "no budget"). `undefined` is accepted here and means "not supplied" —
 * the caller decides whether to forward the key at all.
 *
 * Same predicate as the desktop validator
 * (`operation/goal.ts:30,43`), including the refusal of a float: a budget
 * of 1000.5 would round differently in every layer that touches it.
 *
 * @param {unknown} value
 * @returns {null|{ok: false, code: string, status: number, error: string}}
 */
export function validateGoalTokenBudget(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return invalidGoal("tokenBudget must be a positive integer or null");
  }
  return null;
}

// ---------------------------------------------------------------------------
// KNOWN DEBT
// ---------------------------------------------------------------------------
//
// 1. `kickoffAttachments` is not exposed. The engine's `create` takes it
//    and the TUI's `setObjective` uses it to attach the files a goal starts
//    from, but the webui composer has no attachment picker wired to it
//    yet, and an endpoint that accepts an array of paths no other part of
//    webui can produce would be a capability with no way to reach it.
// 2. `statusReason` is accepted on a patch and dropped. See
//    `patchEngineGoal`: the engine derives the reason, so there is nothing
//    for the client to set. It is tolerated rather than refused because
//    the desktop client sends it, and refusing a request that succeeds
//    there would make webui the odd one out for no gain.
