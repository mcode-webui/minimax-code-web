// webapp/lib/follow-up.ts
//
// SB-4 (`doc/settings-batch-plan.md` §5 row 4): the decision half of the
// follow-up message behaviour, kept out of the composer so it is a total
// function over two facts instead of a chain of conditions inside a
// React callback.
//
// WHAT THIS DECIDES. The General page's 跟进消息行为 switch stores
// `webui-follow-up-behavior` (`off` / `queue` / `steer`). While a turn is
// running the composer can offer one of three things, and they are not
// variations of one another:
//
//   direct — no turn is running, the send goes through `POST /api/send`
//            exactly as it always has.
//   queue  — the turn is running and the user chose queueing: the message
//            is handed to the engine's queue, to run after this turn.
//   steer  — the turn is running and the user chose 立即发送: the message
//            is handed to the engine as steering for the turn that is
//            already running.
//   wait   — the turn is running and the user chose off: webui's standing
//            behaviour, the send control stays replaced by Stop and the
//            text stays in the box.
//
// `wait` is not a disabled control that still sends; it is the absence of
// a send, and the composer renders nothing new for it. That is the whole
// contract of the OFF position, and it is why the switch can honestly
// claim to have a third state at all (see `lib/settings-local.ts`).
//
// WHAT IT DOES NOT DECIDE. Whether the engine can actually take the
// message. The engine that owns the running turn may be another process
// entirely (the default `acp` transport runs turns in an `mcode acp`
// subprocess), and only the server knows which one it is. So the two
// actions that reach the engine can still be refused — with a stable code
// this module can read — and `followUpFailureKey` maps that refusal onto
// the banner the composer shows. The client never guesses: it renders what
// the server decided.

import type { FollowUpBehavior } from "./settings-local";
import { hasApiErrorCode } from "./api";
import type { MessageKey } from "./i18n";

/** What one press of the send control does. */
export type FollowUpAction = "direct" | "queue" | "steer" | "wait";

/**
 * The behaviour stored under `webui-follow-up-behavior` as a value this
 * module can decide on. Read through `readFollowUpBehavior()`, which is
 * total, but re-asserted here because the composer receives the value
 * from a React state update and a value that never came from that reader
 * must not silently become a third behaviour.
 */
export function normalizeFollowUpBehavior(value: unknown): FollowUpBehavior {
  return value === "off" || value === "steer" || value === "queue" ? value : "queue";
}

/**
 * The action for the current turn state.
 *
 * `running` is the composer's own `state.running.active`. There is no
 * third input on purpose: read-only, empty and in-flight are all handled
 * by the control that is already disabled, and folding them in here would
 * give this function four jobs and one truth.
 *
 * @param behavior The stored behaviour.
 * @param running Whether a turn is running in this conversation.
 */
export function resolveFollowUpAction(behavior: FollowUpBehavior, running: boolean): FollowUpAction {
  if (!running) return "direct";
  const normalized = normalizeFollowUpBehavior(behavior);
  if (normalized === "off") return "wait";
  return normalized;
}

/**
 * The two refusals the follow-up family answers with, as the composer
 * sees them.
 *
 *   no_active_turn     — the engine reports no running turn for this
 *                        session. The browser's `running` flag and the
 *                        engine's turn record disagree, which is a
 *                        transient fact (the turn ended between the render
 *                        and the click), so the right thing is to say the
 *                        text was not delivered rather than to run it.
 *   turn_not_owned     — a turn IS running, but it belongs to another
 *                        process. Queueing here would hand the message to
 *                        an engine that is not the one holding the turn,
 *                        and the engine would start a SECOND turn for the
 *                        same session. The composer therefore reports it
 *                        as a refusal and restores the text.
 *
 * Both are read structurally through `hasApiErrorCode`, like every other
 * engine code on the client, so a second copy of the api module across
 * realms still answers correctly.
 */
export function isFollowUpRefusal(cause: unknown): boolean {
  return (
    hasApiErrorCode(cause, FOLLOW_UP_NO_ACTIVE_TURN) || hasApiErrorCode(cause, FOLLOW_UP_TURN_NOT_OWNED)
  );
}

export const FOLLOW_UP_NO_ACTIVE_TURN = "no_active_turn";
export const FOLLOW_UP_TURN_NOT_OWNED = "turn_not_owned";

/**
 * The banner key for a failed follow-up.
 *
 * A refusal is the composer's existing `busy` kind, not a new one: it
 * says the same thing `POST /api/send`'s 409 says — a turn is running and
 * this text was NOT delivered, so it is not resendable yet — and reusing
 * the kind keeps one vocabulary for one fact. Anything else is the
 * generic failure. `null` means "no follow-up-specific wording", which is
 * the caller's cue to keep its own fallback.
 */
export function followUpFailureKey(cause: unknown): MessageKey | null {
  if (hasApiErrorCode(cause, FOLLOW_UP_TURN_NOT_OWNED)) return "error.followUp.notOwned";
  if (hasApiErrorCode(cause, FOLLOW_UP_NO_ACTIVE_TURN)) return "error.followUp.noActiveTurn";
  return null;
}
