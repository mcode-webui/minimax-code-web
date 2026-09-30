/**
 * What to do when a send's acknowledgement never arrived.
 *
 * The defect this module exists for (webui-parity 81 D-2): `POST /api/send`
 * writes its 200 at the top of `routes/chat.js#handleSend` and runs the turn
 * afterwards, so a slow round trip tells the browser nothing about whether the
 * engine took the prompt. The composer used to treat the 30s deadline as a
 * failure, show a red "message failed" banner, put the text back in the box,
 * and wait for the user to press Enter again. The engine had already received
 * and executed the prompt: `sleep 35` ran twice. The lie about a side effect
 * that may already have happened is the defect; the refill is what turned it
 * into a duplicate execution.
 *
 * So the timeout path stops guessing and asks the only party that knows:
 *
 *   accepted   — the server shows this turn running, or the prompt is already
 *                in the transcript. The send landed. Do NOT offer a resend.
 *   rejected   — the server answered and shows no trace of it. The send did
 *                not land. Restoring the text cannot duplicate anything.
 *   unreachable— no read came back. Nothing was learned; the send may or may
 *                not have landed. Treated as unknown, never as "failed".
 *
 * The probe is BOUNDED on purpose: a fixed attempt list with a fixed budget,
 * no open-ended polling. Exhausting it is a legitimate answer, not a reason to
 * keep waiting or to guess.
 *
 * This module is pure apart from `probeSend`, which owns the (short) I/O, so
 * every decision below is testable without a browser, a fetch, or a clock.
 */

import type { WebuiState } from "./types";
import * as api from "./api";

/** What the server's own state says about the send we are asking about. */
export type SendProbeOutcome =
  /** The turn is running, or the prompt is already in the transcript. */
  | "accepted"
  /** The server answered and holds no record of this send. */
  | "rejected"
  /** No read came back — the question is unanswered, not answered "no". */
  | "unreachable";

/**
 * The prompt's echo line, in the three forms the server can leave it.
 *
 * `handleSend` writes `› <content>` before the turn starts. `bodyGoal` then
 * rewrites that same line to `› <text>` when `/goal <text>` is forwarded to the
 * engine, so a goal's echo never appears under the text the user typed. Both
 * forms plus the bare running indicator are checked; anything narrower would
 * call a live `/goal` turn "rejected" and refill a prompt the engine is
 * already running.
 */
function echoForms(content: string): string[] {
  const forms = [`› ${content}`];
  // `/goal <text>` — the rest after the command name is what bodyGoal forwards.
  const withoutCommand = content.replace(/^\/\S+\s+/, "").trim();
  if (withoutCommand && withoutCommand !== content) forms.push(`› ${withoutCommand}`);
  return forms;
}

/**
 * Does this state show the send we asked about as taken?
 *
 * Two independent signals, either sufficient:
 *
 *   1. A turn is running for this cid. Since a busy cid answers the send with a
 *      409 immediately (`beginRun` in `handleSend`), a turn observed after a
 *      deadline expiry is this one.
 *   2. The prompt's echo line is in the transcript — proof the server accepted
 *      it, whether or not the turn has already finished.
 */
export function stateAcceptsSend(state: WebuiState, content: string): boolean {
  if (state && state.running && state.running.active === true) return true;
  const chat = state && Array.isArray(state.chat) ? state.chat : [];
  const forms = echoForms(content);
  return chat.some((line) => forms.includes(line));
}

/**
 * Reduce the probe's reads to one answer.
 *
 * The first read that shows the send as accepted wins — that is a fact about
 * the server, and a later read cannot take it away (the prompt stays in the
 * transcript). Otherwise the first read that came back at all decides: it is
 * the server saying it holds no record. Only when NOTHING came back is the
 * answer `unreachable`.
 */
export function classifySendProbe(
  reads: readonly (WebuiState | null)[],
  content: string,
): SendProbeOutcome {
  let sawServer = false;
  for (const state of reads) {
    if (!state) continue;
    sawServer = true;
    if (stateAcceptsSend(state, content)) return "accepted";
  }
  return sawServer ? "rejected" : "unreachable";
}

/**
 * Probe budget. Fixed, and small: three reads inside about three seconds.
 *
 * The delay before the first read is zero — a send that timed out at 30s has
 * already been in flight long enough that the server is very likely already
 * mid-turn, and every extra second the composer holds the draft is a second
 * the user is looking at a message that has not resolved. The later reads only
 * cover the case where the request itself is still queued on the server
 * (a saturated dev proxy), which is precisely the situation that produced the
 * false negative.
 */
export const SEND_PROBE_ATTEMPTS = 3 as const;
export const SEND_PROBE_DELAYS_MS: readonly number[] = [0, 700, 2000];
/** Per-read deadline. Bounds one request so the whole probe stays bounded. */
export const SEND_PROBE_READ_TIMEOUT_MS = 4_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Ask the server whether it took the send. Never rejects: a failed read is
 * `null`, which `classifySendProbe` folds into the answer.
 *
 * `read` is injectable so the tests drive the decision table without a fetch.
 */
export async function probeSend(
  content: string,
  deps: {
    read?: () => Promise<WebuiState | null>;
    delay?: (ms: number) => Promise<void>;
  } = {},
): Promise<SendProbeOutcome> {
  const read = deps.read ?? defaultRead;
  const delay = deps.delay ?? sleep;
  const reads: (WebuiState | null)[] = [];
  for (let attempt = 0; attempt < SEND_PROBE_ATTEMPTS; attempt += 1) {
    const waitMs = SEND_PROBE_DELAYS_MS[attempt] ?? 0;
    if (waitMs > 0) await delay(waitMs);
    // The guard lives HERE, not only in the default reader: a caller that
    // injects its own `read` must get the same "never rejects, a failed read
    // is null" contract, or an exception would escape into the composer's
    // catch branch and be reported as a send failure — the exact lie this
    // module exists to stop.
    try {
      reads.push(await read());
    } catch {
      reads.push(null);
    }
  }
  return classifySendProbe(reads, content);
}

async function defaultRead(): Promise<WebuiState | null> {
  try {
    return await api.getState(SEND_PROBE_READ_TIMEOUT_MS);
  } catch {
    return null;
  }
}
/**
 * Should the composer put the text back?
 *
 * The rule, in one line: restore only when no send is known to be running.
 *
 * `accepted` is the case that caused the duplicate execution, so the text stays
 * out of the box — one Enter must not be able to re-run a prompt the engine is
 * already running.
 *
 * `unreachable` restores, and that is a deliberate trade rather than an
 * oversight. A failed read says the server could not be asked, not that the
 * send was refused, so the banner has to say the status is unknown and to tell
 * the user to read the history before sending again — but hiding the text from
 * them instead would trade a warned-about resend for silently losing what they
 * typed, and this codebase treats that as the worse defect
 * (`lib/composer-draft.ts` exists to prevent it). The copy is what makes the
 * restore safe, and `error.send` is never shown for this case.
 */
export function shouldRestoreDraft(outcome: SendProbeOutcome): boolean {
  return outcome !== "accepted";
}
