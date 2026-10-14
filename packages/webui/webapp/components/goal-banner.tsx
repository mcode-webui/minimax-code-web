// webapp/components/goal-banner.tsx
//
// PB-14 batch C: the session-level goal card.
//
// PORTED FROM `other-minimax-code/packages/webui/src/client/components/GoalBanner.tsx`
// (125 lines) with its `role=status aria-live=polite` banner, its objective-
// as-a-button gesture, its usage line (tokens · turns · timer, ticking once a
// second while the goal is active), its four actions, its `executionWait` row,
// its three guidance lines and its two-step clear confirmation all kept. The
// transport is the difference: the desktop calls a `WebuiTransport` handed
// down as props, this one calls `lib/api.ts` directly and rolls back
// optimistically on failure.
//
// THREE DECISIONS WORTH NAMING, all of them about honesty rather than looks.
//
//   1. OPTIMISTIC, AND THE ROLLBACK IS THE SERVER'S ANSWER. A status toggle
//      repaints the chip before the request goes out, because the engine's own
//      answer can take a turn's worth of time and a pause button that does
//      nothing visible for two seconds reads as broken. If the request fails
//      the previous snapshot is put back AND the server's error is shown —
//      never swallowed into "the click did nothing", which is the failure
//      mode of a component with no error state at all.
//
//   2. `threadGoal` IS THE SOURCE OF TRUTH, NOT THE RESPONSE. Every write
//      returns the engine's fresh snapshot and the banner adopts it, but the
//      SSE frame is what drives a re-render. They are the same object: the
//      engine's `patchGoal` is the same call that made the event, so the
//      optimistic paint and the event frame converge instead of fighting. The
//      one case where they can disagree — an engine whose event never arrives,
//      over the `acp` transport — is the case where the optimistic paint is
//      what the user has, and the next session read corrects it.
//
//   3. `goalActions` DECIDES, THE COMPONENT RENDERS. Which buttons exist is
//      `lib/goal-state.ts#goalActions`, not a chain of conditionals here. The
//      desktop spells out four `&&` chains in its JSX and every one of them is
//      a status that can be forgotten; one table is a status named once.
//
// TWO IMPORT CONVENTIONS IN ONE DIRECTORY, AND WHY THIS FILE IS THE RELATIVE
// ONE. Most webapp components import through the Next.js `@/` alias
// (`webapp/tsconfig.json#paths`). The test harness does not: `node --test`
// loads this file through `tsx` plus `server/lib/workspace-source-hooks.mjs`,
// which resolves `@mavis/*` workspace packages and falls through to Node for
// everything else — and Node has no `@/`. So an aliased component cannot be
// rendered by `renderToStaticMarkup`, and a banner whose render branches are
// only ever checked by reading its source is a banner nobody has seen render.
// Relative specifiers are what the harness can follow, so this file uses
// them; the sibling components keep the alias. The cost is one visible
// inconsistency, and the alternative is zero render coverage.
//
// React is also imported explicitly, because the tsx loader honours
// `jsx: "preserve"` with the classic runtime — same reason as
// `components/activity-group.tsx`.

import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { clearGoal, patchGoal } from "../lib/api";
import {
  buildGoalEditPatch,
  formatGoalDuration,
  goalActions,
  goalGuidanceKey,
  goalStatusKey,
  goalWaitKey,
  isGoalOpen,
  readThreadGoal,
  type GoalAction,
  type ThreadGoal,
} from "../lib/goal-state";
import { translate, type Locale, type MessageKey } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Icons — inline SVG, no icon-font dependency, same geometry as the desktop.
// ---------------------------------------------------------------------------

function GoalIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function PauseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M6 4.5v11M14 4.5v11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <path d="m7 4.5 8 5.5-8 5.5v-11Z" fill="currentColor" />
    </svg>
  );
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9h6.6l.7-9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** How long the "updated" chip stays up before the real status comes back. */
const UPDATED_BADGE_MS = 2_400;

/** The label each action button carries, as a key rather than a string. */
const ACTION_LABEL_KEYS: Readonly<Record<GoalAction, MessageKey>> = Object.freeze({
  resume: "goal.action.resume",
  pause: "goal.action.pause",
  clear: "goal.action.clear",
  close: "goal.action.close",
  // Never rendered as a button (`goalActions` does not return it); present so
  // the union above stays one type with no per-call-site cast.
  edit: "goal.action.edit",
});

export interface GoalBannerProps {
  /** The ENGINE's goal, already narrowed by `readThreadGoal`. */
  readonly goal: ThreadGoal;
  readonly locale: Locale;
  /**
   * The freshest snapshot the client has, from the SSE frame.
   *
   * Read every render rather than captured once: it is the state the
   * optimistic patch rolls back TO, and a rollback to a stale snapshot is
   * how a banner ends up disagreeing with the server until the next event.
   */
  readonly frame?: ThreadGoal | null;
  /** Set while a turn is running — the pause control honours it. */
  readonly busy?: boolean;
  /**
   * PB-14 batch D — ask the page to focus the pending authorize modal.
   *
   * Optional, and the banner degrades honestly without it: the wait row stays
   * a line of text instead of becoming a button. That is deliberate, because
   * the alternative would be a control that looks actionable and does
   * nothing — the exact failure mode this component's comments keep warning
   * about.
   */
  readonly onFocusAuthorize?: () => void;
  /**
   * Whether a tool-approval request is actually open in this tab right now.
   *
   * This is what separates "click here to be taken to the thing" from "there
   * is no thing here to go to", and the difference is the whole point of the
   * linkage: a blocked goal says "Waiting for your permission", and clicking
   * that and getting nothing back is indistinguishable from a broken banner.
   * With no request open the click still answers — it prints where to look —
   * rather than silently doing nothing.
   */
  readonly authorizePending?: boolean;
}

export function GoalBanner({
  goal,
  locale,
  frame,
  busy = false,
  onFocusAuthorize,
  authorizePending = false,
}: GoalBannerProps): React.JSX.Element {
  const t = useCallback((key: MessageKey) => translate(locale, key), [locale]);
  const [editing, setEditing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [objective, setObjective] = useState(goal.objective);
  const [budget, setBudget] = useState(goal.tokenBudget ? String(goal.tokenBudget) : "");
  const [pending, setPending] = useState<ThreadGoal | null>(null);
  const [busyAction, setBusyAction] = useState<GoalAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justUpdated, setJustUpdated] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Re-seed the editor whenever the ENGINE's goal changes underneath it. The
  // dependency list is the goal's identity and the two editable fields, not
  // the goal object: a snapshot that changes only `tokensUsed` must not
  // overwrite what the user is halfway through typing.
  useEffect(() => {
    setObjective(goal.objective);
    setBudget(goal.tokenBudget ? String(goal.tokenBudget) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.goalId, goal.objective, goal.tokenBudget]);

  // The optimistic overlay: `pending` wins over the frame while it is set,
  // and is dropped the moment a newer frame names a different snapshot.
  const shown = pending ?? frame ?? goal;
  useEffect(() => {
    if (pending && frame && frame.goalId !== pending.goalId) setPending(null);
  }, [pending, frame]);

  // The timer ticks only while the goal is ACTIVE and not waiting on
  // something — a goal blocked on a permission prompt is not consuming
  // wall-clock attention, and a counter that keeps climbing through a prompt
  // makes the wait look like progress.
  useEffect(() => {
    if (shown.status !== "active" || shown.executionWait) {
      setElapsed(0);
      return undefined;
    }
    const base = typeof shown.timeUsedSeconds === "number" ? shown.timeUsedSeconds : 0;
    const update = () => setElapsed(Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(base)));
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [shown.status, shown.executionWait, shown.timeUsedSeconds]);

  useEffect(() => {
    if (!justUpdated) return undefined;
    const timer = setTimeout(() => setJustUpdated(false), UPDATED_BADGE_MS);
    return () => clearTimeout(timer);
  }, [justUpdated]);

  const run = useCallback(
    async (action: GoalAction, apply: (previous: ThreadGoal) => ThreadGoal) => {
      const previous = pending ?? frame ?? goal;
      setBusyAction(action);
      setError(null);
      setPending(apply(previous));
      try {
        if (action === "clear" || action === "close") {
          await clearGoal();
          setConfirmClear(false);
        } else if (action === "pause") {
          const answer = await patchGoal({ status: "paused" });
          setPending(readSnapshot(answer) ?? apply(previous));
        } else if (action === "resume") {
          const answer = await patchGoal({ status: "active" });
          setPending(readSnapshot(answer) ?? apply(previous));
        } else {
          await clearGoal();
        }
        setJustUpdated(true);
      } catch (cause) {
        // Roll back to the snapshot the server was still holding, then say
        // why. Painting the failure is the point: a silent rollback looks
        // exactly like the button being broken.
        setPending(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyAction(null);
      }
    },
    [pending, frame, goal],
  );

  const saveEdit = useCallback(async () => {
    const built = buildGoalEditPatch(objective, budget);
    if (!built.ok) {
      setError(t(built.errorKey));
      return;
    }
    setBusyAction("edit");
    setError(null);
    const previous = pending ?? frame ?? goal;
    setPending({ ...previous, ...built.patch });
    try {
      const answer = await patchGoal(built.patch);
      setPending(readSnapshot(answer) ?? { ...previous, ...built.patch });
      setEditing(false);
      setJustUpdated(true);
    } catch (cause) {
      setPending(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  }, [objective, budget, t, pending, frame, goal]);

  const actions = useMemo(() => goalActions(shown), [shown]);
  const wait = shown.executionWait;
  const guidance = goalGuidanceKey(shown.status);
  const statusKey = justUpdated ? "goal.status.updated" : goalStatusKey(shown.status);
  const disabled = busyAction !== null || busy;

  // PB-14 batch D — the blocked → authorize linkage.
  //
  // A `blocked` goal with an `executionWait` is blocked on a DECISION, and the
  // decision is a modal rendered at the page level. So the wait line becomes
  // the way there. Two guards, and both matter:
  //
  //   - ONLY WHILE BLOCKED. An `active` goal that happens to be waiting is
  //     mid-turn, not stuck; turning its wait line into a button would offer
  //     an action for a state in which the user has nothing to decide.
  //   - ONLY WITH A HANDLER. Without `onFocusAuthorize` the line stays text.
  //     A control that cannot act is worse than no control.
  //
  // `noAuthorizeShown` is set when the click found nothing to focus, and it
  // REPLACES itself rather than sticking around: the request arrives later on
  // its own SSE frame, and a banner still insisting "nothing is waiting here"
  // after the modal has appeared would be the banner lying.
  const canFocusAuthorize =
    shown.status === "blocked" && Boolean(wait) && typeof onFocusAuthorize === "function";
  const [noAuthorizeShown, setNoAuthorizeShown] = useState(false);
  useEffect(() => {
    if (authorizePending) setNoAuthorizeShown(false);
  }, [authorizePending]);
  const focusAuthorize = useCallback(() => {
    if (!onFocusAuthorize) return;
    onFocusAuthorize();
    setNoAuthorizeShown(!authorizePending);
  }, [onFocusAuthorize, authorizePending]);

  return (
    <section
      className="mb-3 flex flex-col gap-2 rounded-xl border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated px-4 py-2"
      data-testid="thread-goal-banner"
      data-goal-status={shown.status}
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex-none text-icon_default_secondary" aria-hidden="true">
          <GoalIcon />
        </span>
        <span
          className="flex-none rounded-md bg-bg_interaction_secondary_hover px-2 py-0.5 text-caption-small-strong text-text_default_secondary"
          data-testid="thread-goal-status"
        >
          {t(statusKey)}
        </span>
        {/* The objective IS the edit button — the desktop's gesture, and one
            control instead of two that do the same thing. */}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[14px] text-text_default_primary hover:underline"
          data-testid="thread-goal-objective"
          aria-expanded={editing}
          title={shown.objective}
          disabled={disabled || !isGoalOpen(shown)}
          onClick={() => setEditing((value) => !value)}
        >
          {shown.objective}
        </button>
        <span
          className="flex-none text-caption-small text-text_default_tertiary"
          data-testid="thread-goal-usage"
        >
          <span data-testid="thread-goal-tokens">{shown.tokensUsed ?? 0}</span>{" "}
          {t("goal.usage.tokens")} · <span data-testid="thread-goal-turns">{shown.turnsUsed ?? 0}</span>{" "}
          {t("goal.usage.turns")} ·{" "}
          <span data-testid="thread-goal-timer">
            {formatGoalDuration((shown.timeUsedSeconds ?? 0) + elapsed)}
          </span>
        </span>
        <span className="ml-auto flex flex-none items-center gap-1">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-icon_default_secondary hover:bg-bg_interaction_tertiary_hover"
              data-testid={`thread-goal-${action}`}
              aria-label={t(ACTION_LABEL_KEYS[action])}
              title={t(ACTION_LABEL_KEYS[action])}
              disabled={disabled}
              onClick={() => {
                if (action === "clear" || action === "close") {
                  setConfirmClear(true);
                  return;
                }
                void run(action, (previous) => ({
                  ...previous,
                  status: action === "pause" ? "paused" : "active",
                }));
              }}
            >
              {action === "pause" ? <PauseIcon /> : action === "resume" ? <PlayIcon /> : <TrashIcon />}
            </button>
          ))}
        </span>
      </div>

      {wait ? (
        canFocusAuthorize ? (
          <button
            type="button"
            className="self-start text-left text-caption-small text-text_default_secondary underline decoration-dotted underline-offset-2 hover:text-text_default_primary"
            data-testid="thread-goal-wait-action"
            aria-label={t("goal.blocked.action")}
            title={t("goal.blocked.action")}
            onClick={focusAuthorize}
          >
            <span data-testid="thread-goal-wait">{t(goalWaitKey(wait.reason))}</span>
          </button>
        ) : (
          <p className="text-caption-small text-text_default_secondary" data-testid="thread-goal-wait">
            {t(goalWaitKey(wait.reason))}
          </p>
        )
      ) : null}
      {canFocusAuthorize && noAuthorizeShown ? (
        <p
          role="status"
          className="text-caption-small text-text_default_secondary"
          data-testid="thread-goal-no-authorize"
        >
          {t("goal.blocked.noAuthorize")}
        </p>
      ) : null}
      {guidance ? (
        <p className="text-caption-small text-text_default_secondary" data-testid="thread-goal-guidance">
          {t(guidance)}
        </p>
      ) : null}

      {editing && isGoalOpen(shown) ? (
        <div className="flex flex-col gap-2" data-testid="thread-goal-editor">
          <label className="flex flex-col gap-1 text-caption-small text-text_default_secondary">
            {t("goal.edit.objectiveLabel")}
            <textarea
              className="rounded-lg border-[0.5px] border-border_default bg-bg_default_primary px-2 py-1 text-[14px] text-text_default_primary"
              data-testid="thread-goal-edit-objective"
              rows={2}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-caption-small text-text_default_secondary">
            {t("goal.edit.budgetLabel")}
            <input
              className="rounded-lg border-[0.5px] border-border_default bg-bg_default_primary px-2 py-1 text-[14px] text-text_default_primary"
              data-testid="thread-goal-edit-budget"
              value={budget}
              placeholder={t("goal.edit.budgetPlaceholder")}
              onChange={(event) => setBudget(event.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg px-3 py-1 text-caption-small text-text_default_secondary hover:bg-bg_interaction_tertiary_hover"
              data-testid="thread-goal-edit-cancel"
              disabled={busyAction !== null}
              onClick={() => setEditing(false)}
            >
              {t("goal.edit.cancel")}
            </button>
            <button
              type="button"
              className="rounded-lg bg-bg_interaction_primary_default px-3 py-1 text-caption-small text-text_default_inverted"
              data-testid="thread-goal-edit-save"
              disabled={busyAction !== null}
              onClick={() => void saveEdit()}
            >
              {t("goal.edit.save")}
            </button>
          </div>
        </div>
      ) : null}

      {confirmClear ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-bg_interaction_secondary_hover px-3 py-2"
          data-testid="thread-goal-clear-confirm"
          role="alertdialog"
          aria-label={t("goal.confirm.title")}
        >
          <strong className="text-[14px] text-text_default_primary">{t("goal.confirm.title")}</strong>
          <span className="text-caption-small text-text_default_secondary">{t("goal.confirm.body")}</span>
          <button
            type="button"
            className="rounded-lg px-3 py-1 text-caption-small text-text_default_secondary hover:bg-bg_interaction_tertiary_hover"
            data-testid="thread-goal-clear-cancel"
            disabled={busyAction !== null}
            onClick={() => setConfirmClear(false)}
          >
            {t("goal.edit.cancel")}
          </button>
          <button
            type="button"
            className="rounded-lg bg-bg_interaction_primary_default px-3 py-1 text-caption-small text-text_default_inverted"
            data-testid="thread-goal-clear-confirm-button"
            disabled={busyAction !== null}
            onClick={() => void run("clear", () => ({ ...(shown as ThreadGoal), status: "complete" }))}
          >
            {t("goal.action.clear")}
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-caption-small text-text_default_secondary" data-testid="thread-goal-error">
          {t("goal.banner.error")}: {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Narrow a PATCH/POST answer to a goal, or `null`.
 *
 * Delegated to `readThreadGoal` rather than re-narrowed here. The banner
 * already has ONE reader for "is this frame a goal" — the same one the SSE
 * frame goes through — and a second structural copy inside a component is
 * exactly the pair that drifts the first time a field moves. The write
 * endpoints answer `{ok, goal}`, so the only thing this adds is unwrapping
 * the envelope; a shape the server would never send yields `null` and the
 * caller keeps the snapshot it already had.
 */
function readSnapshot(answer: unknown): ThreadGoal | null {
  if (!answer || typeof answer !== "object") return null;
  return readThreadGoal((answer as { goal?: unknown }).goal);
}