// webapp/lib/use-thread-goal.ts
//
// PB-14 batch D: the goal the banner draws, bound to the conversation on
// screen.
//
// WHY A HOOK AND NOT `readThreadGoal(state.threadGoal)` INLINE, which is what
// batch C did. The SSE frame answers "what does the server currently believe
// about this conversation", and that is not the same question as "what should
// this tab draw right now", in three specific ways. Each one is a defect a
// person sees.
//
//   1. A STALE FRAME IS A GHOST. Switching sessions changes
//      `cs.sessionId` and `cs.mcodeSessionId` on the server, but the browser
//      holds the previous snapshot until the next frame arrives — and the
//      event bridge only pushes when the ENGINE emits a `thread_goal.*`
//      event, which a session switch does not cause. On the `acp` transport
//      the bridge is not armed at all, so the ghost does not clear by
//      itself. Rendering the frame verbatim means the objective, the token
//      count and the status chip of the previous conversation sit above the
//      new conversation's transcript until something else happens to fix it.
//      So: a frame is only drawn when it can be ATTRIBUTED to the session on
//      screen (`threadGoal.sessionId === mcodeSessionId`), and a switch
//      clears first and re-reads second.
//
//   2. NO FRAME IS NOT NO GOAL. The event bridge is armed at SSE connect and
//      re-armed by the three write handlers, so the first `/goal` of a tab
//      can land before any frame has been pushed for it, and a goal created
//      in another tab reaches this one only when the engine next touches it.
//      The banner therefore asks the server on every conversation change
//      rather than trusting the absence of a frame.
//
//   3. A TURN ENDING IS A MOMENT THE NUMBERS CHANGE. `timeUsedSeconds`,
//      `tokensUsed` and `turnsUsed` are the ENGINE's counters, advanced when
//      a turn closes, not on every token. Over `acp` there is no
//      `thread_goal.updated` to bring them forward, so a banner that trusts
//      only frames freezes at the figure from the last write — which is the
//      figure from BEFORE the turn the user just watched finish. The turn
//      boundary is a re-read point for the same reason the session switch is.
//
// WHAT THE HOOK DOES NOT DO. It does not decide whether a goal is open, what
// copy a status gets, or which actions exist: `lib/goal-state.ts` owns all of
// that, and this file calls into it rather than restating a rule. A second copy
// of `readThreadGoal` here would be the pair that drifts the first time a
// field moves.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiHttpError, getGoal } from "./api";
import { readThreadGoal, type ThreadGoal } from "./goal-state";

/**
 * Whether an SSE frame may be drawn for the conversation on screen.
 *
 * `null` in, `true` out — no frame is never a reason to paint anything, and
 * the caller's state was already cleared by the switch effect, so "does not
 * apply" and "there is nothing to draw" converge on the same rendering.
 *
 * THE ATTRIBUTION IS NOT OPTIONAL. `GlobalThreadGoal.sessionId` is the
 * ENGINE's session id, so it is compared with `mcodeSessionId` — never with
 * the webui sidebar id in `sessionId`, which is a different identifier
 * (`state-bus.js`: `sessionId` is a local `randomUUID`, `mcodeSessionId` is
 * the engine's). Comparing the wrong pair would either reject every real
 * frame or accept every ghost, which is exactly the failure this hook exists
 * to remove.
 *
 * An unknown `mcodeSessionId` rejects the frame rather than trusting it. The
 * honest reading of "I do not know which conversation this is" is "do not
 * paint"; the effect that runs alongside it re-reads the server, which is the
 * one path that can answer without a frame.
 */
export function frameMatchesSession(
  frame: ThreadGoal | null,
  mcodeSessionId: string | null,
): boolean {
  if (!frame) return false;
  if (!mcodeSessionId) return false;
  return frame.sessionId === mcodeSessionId;
}

/**
 * Is this turn-complete signal worth a re-read?
 *
 * The rising edge is a turn STARTING and the falling edge is a turn ENDING;
 * only the falling edge moves the engine's counters. Exported as a predicate
 * rather than buried in the effect so the edge — the part that is easy to get
 * backwards — can be pinned by a table test.
 */
export function isTurnComplete(previousRunning: boolean, running: boolean): boolean {
  return previousRunning === true && running === false;
}

export interface UseThreadGoalInput {
  /** `GET /api/goal/enabled` answered. `null` before the first answer. */
  readonly enabled: boolean;
  /** The webui conversation id; changes when the user switches session. */
  readonly sessionId: string | null;
  /** The ENGINE's session id for that conversation; the frame's key. */
  readonly mcodeSessionId: string | null;
  /** The raw `threadGoal` field off the state snapshot. */
  readonly frame: unknown;
  /** Whether a turn is running in this conversation. */
  readonly running: boolean;
}

/**
 * The goal this tab may draw right now, or `null`.
 *
 * `null` is a real answer with three distinct causes — the feature is off,
 * the conversation has no goal, and a conversation change whose re-read has
 * not come back yet — and the banner treats all three as "draw nothing",
 * which is the honest rendering in every case. The distinction between them is
 * not lost; it is simply not something a status chip should claim.
 */
export function useThreadGoal({
  enabled,
  sessionId,
  mcodeSessionId,
  frame,
  running,
}: UseThreadGoalInput): ThreadGoal | null {
  const [goal, setGoal] = useState<ThreadGoal | null>(null);

  // One monotonically increasing token per re-read. A `GET /api/goal` issued
  // for the previous conversation can still be in flight when the user
  // switches; without this the late answer would install the OLD goal into
  // the NEW conversation — the same ghost, one round trip later, and the one
  // this hook cannot fix by clearing on switch because the clear already
  // happened before the answer arrived.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const token = (requestSeq.current += 1);
    try {
      const answer = await getGoal();
      if (requestSeq.current !== token) return;
      setGoal(readThreadGoal(answer?.goal));
    } catch (cause) {
      if (requestSeq.current !== token) return;
      // A 404 is the server spelling "this conversation has no goal", which
      // is the same fact the SSE frame spells as `threadGoal: null` — so it
      // CLEARS. Every other failure (the feature off, a transport that
      // answers 501, the network) leaves whatever the last frame proved,
      // because "I could not ask" is not "there is nothing there", and a
      // banner that empties itself on a flaky request erases a goal that
      // exists.
      if (cause instanceof ApiHttpError && cause.status === 404) setGoal(null);
    }
  }, []);

  // (1) Conversation change, and first mount: CLEAR, then re-read. The order
  // matters — clearing first is what removes the previous conversation's card
  // for the one frame it takes the request to come back.
  useEffect(() => {
    setGoal(null);
    if (enabled && sessionId) void refresh();
  }, [enabled, sessionId, mcodeSessionId, refresh]);

  // (2) SSE frame: adopted only when it belongs to the session on screen.
  // A frame that fails attribution is IGNORED rather than treated as a
  // clearing — `threadGoal: null` and "a goal for another conversation" are
  // different wires, and only the first means "no goal".
  useEffect(() => {
    const parsed = readThreadGoal(frame);
    if (!parsed) {
      // A null frame on a settled conversation means the engine has no goal
      // (batch B clears the slot on `thread_goal.cleared`). `null` therefore
      // clears — but only once a conversation has been established, so the
      // very first snapshot of a freshly-opened tab cannot wipe a re-read
      // that is already in flight.
      if (sessionId && mcodeSessionId) setGoal(null);
      return;
    }
    if (frameMatchesSession(parsed, mcodeSessionId)) setGoal(parsed);
  }, [frame, sessionId, mcodeSessionId]);

  // (3) Turn boundary: the engine's usage counters only advance when a turn
  // closes, so the falling edge of `running` is the moment the banner's
  // timing line is stale by definition.
  const previousRunning = useRef(running);
  useEffect(() => {
    const was = previousRunning.current;
    previousRunning.current = running;
    if (enabled && sessionId && isTurnComplete(was, running)) void refresh();
  }, [running, enabled, sessionId, refresh]);

  return goal;
}
