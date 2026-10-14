// webapp/lib/goal-state.ts
//
// The pure projection behind the goal banner (PB-14 batch C, fact baseline
// `doc/pb14-goal-baseline.md` §3/§5). No React, no transport: this module
// decides what the banner is allowed to claim and turns a text field into a
// wire patch.
//
// WHY A PROJECTION AT ALL, when the SSE frame is already the engine's
// `GlobalThreadGoal` verbatim. Two reasons, and neither is taste.
//
//   - THE COPY IS OURS, THE STATE IS NOT. The six statuses and the eight
//     `executionWait` reasons are the engine's vocabulary
//     (`packages/shared/src/global-events.ts:88-164`); the words a person
//     reads next to them are a product decision that changes without a
//     release, and it must be bilingual. Keeping the map here — keyed by the
//     engine's own string — means a new engine status shows up as a missing
//     dictionary key at compile time instead of as an empty chip.
//
//   - AN UNTRUSTED FRAME NEEDS A READER. `threadGoal` arrives on a JSON SSE
//     frame. `readThreadGoal` is the only place that decides whether a frame
//     is a goal at all, and the banner treats a frame it cannot read as "no
//     goal" rather than rendering `undefined` into a chip.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not know the six-status
// state machine (which transitions are legal is the engine's, and an
// out-of-range value is passed through rather than rewritten), and it does not
// re-derive the goal from anything — there is no local goal any more, only
// the engine's.

import type { MessageKey } from "./i18n";

/**
 * The engine's six statuses (`global-events.ts:126-164`).
 *
 * Declared as a string union so an exhaustive switch is a compile error, but
 * NOT enforced on the wire: `readThreadGoal` accepts any non-empty string,
 * because a host one version ahead of this bundle must still render a banner
 * with an unfamiliar status rather than lose the goal entirely.
 */
export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "complete"
  | "budget_limited"
  | "usage_limited";

/** The eight reasons the engine may be waiting on (`global-events.ts:116-124`). */
export type ThreadGoalWaitReason =
  | "questionnaire"
  | "permission"
  | "plan"
  | "required_background"
  | "automation_owner_conflict"
  | "dependency_unavailable"
  | "verification"
  | "unknown";

/**
 * The part of `GlobalThreadGoal` the banner reads.
 *
 * Every field is optional except the identity and the objective: this is a
 * reader's view of a frame from a wire, not a restatement of the engine's
 * type. `readThreadGoal` is what guarantees the shape.
 */
export interface ThreadGoal {
  goalId: string;
  sessionId: string;
  objective: string;
  status: string;
  /** Epoch milliseconds — the desktop banner ticks against it too. */
  updatedAt?: number;
  tokensUsed?: number;
  turnsUsed?: number;
  timeUsedSeconds?: number;
  tokenBudget?: number | null;
  statusReason?: string;
  hasKickoffAttachments?: boolean;
  executionWait?: { reason?: string } | null;
}

/**
 * Copy for each status, as dictionary keys rather than strings.
 *
 * `updated` is the transient badge the banner flashes for 2.4s after a patch
 * lands. It is not an engine status and is kept in the same table so the chip
 * has exactly one lookup site.
 */
/** The one status neither table names, pinned so the fallbacks below are
 *  total under `noUncheckedIndexedAccess`. `GOAL_STATUS_COPY_KEYS.unknown`
 *  reads as a string too, but a bare object index yields
 *  `MessageKey | undefined` and the whole point of these two helpers is that
 *  they never do. */
export const GOAL_STATUS_UNKNOWN_KEY: MessageKey = "goal.status.unknown";
export const GOAL_WAIT_UNKNOWN_KEY: MessageKey = "goal.wait.unknown";

export const GOAL_STATUS_COPY_KEYS: Record<string, MessageKey> = {
  active: "goal.status.active",
  paused: "goal.status.paused",
  blocked: "goal.status.blocked",
  complete: "goal.status.complete",
  budget_limited: "goal.status.budget_limited",
  usage_limited: "goal.status.usage_limited",
  updated: "goal.status.updated",
};

/**
 * Copy for each `executionWait` reason.
 *
 * An unknown reason falls back to `unknown` rather than rendering the raw
 * enum: the engine may add a ninth reason, and a person must not be shown an
 * internal identifier where a sentence belongs.
 */
export const GOAL_WAIT_COPY_KEYS: Record<string, MessageKey> = {
  questionnaire: "goal.wait.questionnaire",
  permission: "goal.wait.permission",
  plan: "goal.wait.plan",
  required_background: "goal.wait.requiredBackground",
  automation_owner_conflict: "goal.wait.automationOwnerConflict",
  dependency_unavailable: "goal.wait.dependencyUnavailable",
  verification: "goal.wait.verification",
  unknown: "goal.wait.unknown",
};

/**
 * Human-readable duration for the banner's elapsed timer.
 *
 * A non-finite or negative input formats as `0s` instead of `NaN`: this runs
 * on a field that arrived over the wire, and a banner that reads `NaNs` is a
 * banner that has told the user something false.
 */
export function formatGoalDuration(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}min` : ""}`;
  if (minutes > 0) return `${minutes}min${rest > 0 ? `${rest}s` : ""}`;
  return `${rest}s`;
}

export type GoalEditPatchResult =
  | { readonly ok: true; readonly patch: { readonly objective: string; readonly tokenBudget: number | null } }
  | { readonly ok: false; readonly errorKey: MessageKey };

/**
 * Turn the banner's edit form into a `PATCH /api/goal` body.
 *
 * `K`/`M` suffixes are accepted for the same reason the composer command
 * accepts them: the budget is a number a person reads out of a usage panel,
 * and typing `50K` is how they hold it in their head. An empty budget means
 * "no cap", which is `null` and not `undefined` — the engine distinguishes
 * "remove the cap" from "do not touch the cap", and collapsing them would
 * make clearing a budget silently do nothing.
 */
export function buildGoalEditPatch(objective: string, budget: string): GoalEditPatchResult {
  const text = objective.trim();
  if (!text) return { ok: false, errorKey: "goal.error.objectiveRequired" };
  const trimmed = budget.trim();
  const parsed = trimmed ? parseGoalBudgetValue(trimmed) : null;
  if (trimmed && (parsed === null || !Number.isInteger(parsed) || parsed <= 0)) {
    return { ok: false, errorKey: "goal.error.budgetInvalid" };
  }
  return { ok: true, patch: { objective: text, tokenBudget: parsed } };
}

/**
 * One `budget=` value: a positive integer with an optional K/M suffix.
 *
 * Returns `null` for anything that is not one, which is also what "no cap"
 * parses to — the caller distinguishes them by whether the input was empty,
 * so the two meanings never have to share a sentinel.
 *
 * A DECIMAL IS REFUSED UNLESS A SUFFIX CARRIES IT. `1.5K` is 1500 tokens and
 * is a real thing to want; a bare `1.5` is 1.5 tokens, which is not, and
 * rounding it to 2 would set a goal that quietly spends something nobody
 * asked for. This is the desktop's predicate
 * (`other-minimax-code/.../goal-state.ts:95`) and the reason for it is
 * visible there: its check is `Number.isInteger` on the substituted string,
 * and a bare decimal does not survive it.
 */
export function parseGoalBudgetValue(raw: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)([km])?$/i.exec(raw.trim());
  if (!match) return null;
  const suffix = match[2]?.toLowerCase();
  if (match[1]?.includes(".") && !suffix) return null;
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  const value = Math.round(Number(match[1]) * multiplier);
  return value > 0 ? value : null;
}

/**
 * Decide whether an SSE `threadGoal` frame is a goal the banner may render.
 *
 * `null` in, `null` out — "this conversation has no goal" is the frame's own
 * spelling of the absence (the engine has no null goal), so the reader needs
 * no separate empty case. A frame that fails the shape check is treated the
 * same way: a banner that hid an unreadable frame is safer than one that
 * painted `undefined` into a chip.
 */
export function readThreadGoal(raw: unknown): ThreadGoal | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.goalId !== "string" || !value.goalId) return null;
  if (typeof value.sessionId !== "string" || !value.sessionId) return null;
  if (typeof value.objective !== "string") return null;
  if (typeof value.status !== "string" || !value.status) return null;
  return raw as ThreadGoal;
}

/**
 * Read `GET /api/goal/enabled`.
 *
 * Anything that is not an explicit `true` is `false`. The endpoint is the
 * composer's permission to OFFER the goal entry at all, and the failure modes
 * are asymmetric: a false negative hides a control the user may want, a false
 * positive offers one that answers 501 on every press. The honest default
 * under uncertainty is the one that offers nothing.
 */
export function readGoalEnabled(raw: unknown): boolean {
  return Boolean(
    raw && typeof raw === "object" && (raw as { ok?: unknown }).ok === true &&
      (raw as { enabled?: unknown }).enabled === true,
  );
}

/**
 * Whether the engine is holding this goal open, or has closed it.
 *
 * `budget_limited` and `usage_limited` count as OPEN: the goal exists and the
 * banner must keep showing what it cost. Only `complete` and a cleared frame
 * are closed — which is exactly why the banner's clear button and its
 * completion marker are different controls rather than one "dismiss".
 */
export function isGoalOpen(goal: ThreadGoal): boolean {
  return goal.status !== "complete";
}

/**
 * The chip key for one status, TOTAL over any string.
 *
 * The `unknown` entry in `GOAL_STATUS_COPY_KEYS` is what makes this total.
 * A status this build does not name is still a real goal with a real cost,
 * and rendering the raw identifier where a sentence belongs tells the user
 * nothing; "unknown" says the one honest thing, which is that this client is
 * behind the engine. The chip is the least bad place to meet a seventh
 * status, because every other field of the banner still renders correctly.
 */
export function goalStatusKey(status: string): MessageKey {
  return GOAL_STATUS_COPY_KEYS[status] ?? GOAL_STATUS_UNKNOWN_KEY;
}

/**
 * The wait line's key for one `executionWait.reason`, total over any value.
 *
 * The fallback is `unknown` — "Waiting for the runtime to be ready" — and
 * not an absent line, because the banner's job on this row is to say the
 * goal is WAITING, and the reason word is a refinement of that fact. A ninth
 * reason must not make an actively waiting goal render as if nothing were
 * happening.
 */
export function goalWaitKey(reason: unknown): MessageKey {
  const known =
    typeof reason === "string" ? GOAL_WAIT_COPY_KEYS[reason] : undefined;
  return known ?? GOAL_WAIT_UNKNOWN_KEY;
}

/** The three interactive states a goal can be in, as the banner sees them. */
export type GoalPhase = "running" | "paused" | "closed";

/**
 * Which phase a goal is in.
 *
 * `budget_limited` and `usage_limited` fold into `closed` even though the
 * engine records them as non-terminal and `isGoalOpen` counts them as open.
 * The two functions answer different questions on purpose and must not be
 * collapsed: `isGoalOpen` asks "should the banner still be drawn", and this
 * asks "is there any action here that the engine would accept". A
 * `budget_limited` goal still gets its banner — it spent real tokens and the
 * user is owed that number — but the only thing that can be done about it is
 * clearing it and creating another, which is what its guidance line says, so
 * offering a resume button would be a control that answers 400.
 *
 * `blocked` and `paused` are the same phase: the engine resumes either one
 * with `{status:"active"}`, and the banner has no way to tell the user which
 * of the two it will be resuming, so it must not pretend to.
 */
export function goalPhase(status: string): GoalPhase {
  if (status === "active") return "running";
  if (status === "complete" || status === "budget_limited" || status === "usage_limited") {
    return "closed";
  }
  return "paused";
}

/**
 * The actions the banner can be busy with.
 *
 * `edit` is the odd one out: `goalActions` NEVER returns it, because
 * editing is reached by clicking the objective rather than by a button in
 * the action slot. It is in the union because the save path sets it as the
 * busy action, and a narrower union would force that one call site to invent
 * a second busy flag for the same slot — which is how two controls end up
 * able to be busy at once and neither of them disabling the other.
 */
export type GoalAction = "resume" | "pause" | "clear" | "close" | "edit";

/**
 * The actions one goal offers, in render order — or an empty list.
 *
 * A LIST rather than four booleans is what keeps the banner's JSX a `map`:
 * the desktop component spells out four `&&` chains, and every one of them
 * is a status somebody can forget when the state machine grows. Here a
 * status is named exactly once, in this function.
 *
 * `pause` is withheld while `executionWait` is set. A goal blocked on a
 * permission the user is about to answer is not pausable from here: pausing
 * it would strand the pending question with no goal to resume into, which is
 * a state the engine has no way to leave. The desktop applies the same guard.
 *
 * `close` appears only for a `complete` goal and `clear` for everything
 * else, because they are different promises: clearing a live goal says "stop
 * pursuing this and go back to ordinary conversation", while closing a
 * finished one only takes the card away. One button would have to promise
 * both, and the second one would be a lie.
 */
export function goalActions(goal: ThreadGoal): GoalAction[] {
  const phase = goalPhase(goal.status);
  if (phase === "closed") return goal.status === "complete" ? ["close"] : [];
  if (phase === "running") return goal.executionWait ? [] : ["pause"];
  return ["resume", "clear"];
}

/**
 * The sentence that follows a goal the user cannot act their way out of, or
 * `null` when there is nothing to add.
 *
 * The desktop's three guidance lines are kept as they were written, because
 * each names the ONE thing that actually resolves that status: a new goal, a
 * provider quota, or nothing at all. Adding a generic "contact support" to
 * any of them would name an action the product does not offer.
 */
export function goalGuidanceKey(status: string): MessageKey | null {
  if (status === "budget_limited") return "goal.guidance.budgetLimited";
  if (status === "usage_limited") return "goal.guidance.usageLimited";
  if (status === "complete") return "goal.guidance.complete";
  return null;
}
