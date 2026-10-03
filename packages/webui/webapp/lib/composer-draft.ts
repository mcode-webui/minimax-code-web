/**
 * Composer draft store — the typed text, the `@path` attachment chips, and
 * the send-error banner, held OUTSIDE the React tree and keyed BY SESSION.
 *
 * Why module scope instead of component state: `app/page.tsx` swaps the
 * composer between two tree positions — `<HomeState><Composer inline/></
 * HomeState>` on the empty home screen versus a sibling of `<Chat/>` once a
 * conversation exists. The swap fires exactly when the first `› user line`
 * lands in a state push, i.e. in the middle of a turn. React unmounts one
 * `Composer` and mounts the other, and unmounting threw away everything
 * `useState` held: text typed for the next message, the attachments, and
 * the send-error banner (e.g. a 409 session-busy) — which is how a failed
 * send looked like a silent vanish. Any future remount (a `key` added
 * upstream, an error boundary) would wipe the same fields again, so the
 * fix must not depend on where the component sits in the tree.
 *
 * Why PER-SESSION keys (webui-parity 106, smoke-report P5): the first
 * version of this store was one shared bucket, so everything above — text,
 * attachments, banner — rode along when the user switched sessions. The
 * smoke run captured the result: session 2's view showed session 1's typed
 * draft, session 1's 409 banner, and misled the user about what a send
 * would do. The store is now a `Map` keyed by the active session id (the
 * same `state?.sessionId ?? ""` string the composer already derives);
 * switching sessions swaps the whole box, and both boxes keep their
 * contents. The empty key `""` is the no-session bucket (the home screen,
 * before the first snapshot names a session). Drafts are deliberately NOT
 * persisted to storage: they are working state for the current page visit,
 * and the persisted surface (UI state, tabs, scroll) is `lib/persist.ts`'s
 * contract, not this one.
 *
 * The store is deliberately tiny — one map, last write wins — and is
 * consumed through `useSyncExternalStore` (see `components/composer.tsx`)
 * with a keyed getter, so a session change swaps drafts synchronously
 * during render instead of a frame later. This module must stay
 * React-free: `webapp/test/composer-draft.test.ts` imports it directly
 * under the plain Node test runner.
 */

// Type-only, so the runtime dependency graph is unchanged — this store stays
// importable under a plain Node test runner with no DOM and no fetch.
import type { SendProbeOutcome } from "./send-confirmation";

export interface ComposerDraft {
  /** Text currently typed in the textarea. */
  value: string;
  /** Last send-failure message, or null. Rendered as the error banner. */
  error: string | null;
  /**
   * Which kind of failure `error` is, or null when there is no banner.
   *
   * Why this is not derived from the message: the send acknowledgement can
   * time out while the engine is already running the prompt, and that is not
   * a failure (webui-parity 81 D-2). The banner must then read as "not
   * confirmed, do not resend" — different words, different colour, and never
   * the "could not send" headline. Only the caller knows which happened, so
   * it says so here; `error` stays the raw server string for the `rejected`
   * case, which is a real refusal and does deserve to be quoted.
   */
  errorKind: ComposerErrorKind | null;
  /**
   * What the post-timeout probe against the server concluded, or null when
   * there is no banner or the failure was a real refusal. Drives which of
   * the three unconfirmed banners renders — they are not interchangeable:
   * "the engine is running it, do not resend" and "we could not find out"
   * call for opposite behaviour.
   */
  unconfirmed: SendProbeOutcome | null;
  /** Accepted upload references, `@path` prefixed. */
  attachments: string[];
}

/**
 * `rejected` — the server refused the send (4xx, network error before the
 * request left). A real failure; the text goes back in the box.
 *
 * `busy` — the server refused because THIS CONVERSATION is already running
 * a turn (409 `cid-busy` / `session-busy`). The send never reached the
 * engine and never will, so it is a refusal like `rejected` — but the
 * remedy is "wait for the turn to end", not "the send is broken", and
 * conflating the two is what made a refused message read as a lost one
 * (P16: a message sent into a running conversation looked like it had
 * vanished, and the banner told the user not to resend it).
 *
 * `unconfirmed` — the acknowledgement never arrived and the follow-up read
 * against the server could not establish whether the turn started. The text
 * may already be executing. Never rendered as a failure, and the draft is
 * only restored when the server positively holds no record of the send.
 *
 * `followUp` — a follow-up sent into a running turn (SB-4) was REFUSED, and
 * `error` is then the finished sentence rather than a server string: both
 * refusals this family can answer with mean "not delivered, the text is back
 * in the box" for different reasons, and quoting the engine's own wording
 * would put an internal code in the banner. It wears the `busy` colour
 * because it is the same class of fact.
 */
export type ComposerErrorKind = "rejected" | "busy" | "unconfirmed" | "followUp";

const EMPTY_DRAFT: ComposerDraft = {
  value: "",
  error: null,
  errorKind: null,
  unconfirmed: null,
  attachments: [],
};

/** Per-session buckets. Entries appear on first write and live for the
 *  page visit; each is a few small fields, so no pruning is needed. */
const drafts = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();

export type ComposerDraftPatch =
  | Partial<ComposerDraft>
  | ((current: ComposerDraft) => Partial<ComposerDraft>);

/**
 * Read the draft of ONE session. Stable identity between writes — the
 * returned object only changes when that session's draft is written, and
 * the shared `EMPTY_DRAFT` singleton stands in for sessions without one,
 * so `useSyncExternalStore` can compare by reference.
 */
export function getComposerDraft(sessionKey: string): ComposerDraft {
  return drafts.get(sessionKey) ?? EMPTY_DRAFT;
}

/** Write a patch (or an updater, mirroring `setState` semantics) into ONE
 *  session's draft. Other sessions' drafts are untouched — that is the
 *  isolation contract the smoke report's P5 depends on. */
export function setComposerDraft(
  sessionKey: string,
  patch: ComposerDraftPatch,
): void {
  const current = drafts.get(sessionKey) ?? EMPTY_DRAFT;
  const resolved = typeof patch === "function" ? patch(current) : patch;
  drafts.set(sessionKey, { ...current, ...resolved });
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` subscription. Returns the unsubscribe thunk. */
export function subscribeComposerDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The patch that puts a rejected submission back into the composer
 * without clobbering what the user typed while it was in flight.
 *
 * `restored` is the payload `failComposerSent` hands back when the
 * dispatch context still matches. The user may have kept typing in the
 * meantime, and the send was optimistically cleared at dispatch, so
 * the rejected text lives ONLY in that payload — dropping it loses the
 * user's input with no way back.
 *
 * Two rules, both about order: the interim text stays FIRST (it is what
 * the user is looking at) and the restored text follows after a blank
 * line, and the restored attachments come first in the chip list (the
 * order the user assembled them in). A blank/whitespace-only interim
 * draft counts as empty — otherwise a stray space typed during a slow
 * send would separate the two messages by a blank line for nothing.
 *
 * The error banner is NOT part of the returned patch: the caller sets
 * it separately, because the banner must appear even when nothing is
 * restored (a failure in a session the user already left).
 */
export function mergeRestoredDraft(
  current: ComposerDraft,
  restored: { content: string; attachments: string[] },
): Partial<ComposerDraft> {
  const interim = current.value.trim();
  return {
    value:
      interim.length > 0
        ? `${current.value}\n\n${restored.content}`
        : restored.content,
    attachments: [...restored.attachments, ...current.attachments],
  };
}

/**
 * The patch to apply when a turn ends, or `null` for "nothing to do".
 *
 * The unconfirmed banner's three-value display semantics are #126's and are
 * NOT touched here — this only owns WHEN the banner goes away. A send whose
 * acknowledgement timed out leaves a grey "the engine is running this
 * message — do not resend" banner; once the turn it warned about is over,
 * the warning describes nothing and must disappear (smoke-report P4: after
 * `sleep 35` completed, the banner stayed until the next send or reload).
 * A real `rejected` refusal is a different fact and stays until the user
 * acts on it.
 *
 * The turn-end signal is the running flag falling: `prevRunning === true`
 * and `running === false`. A banner that appears while no turn runs (the
 * fast-turn echo path) never sees that fall inside the same mount, so it
 * keeps the pre-existing dismiss paths — the next send in the same session
 * clears it, as does a session switch (per-session isolation, above).
 */
export function unconfirmedPatchOnTurnEnd(
  prevRunning: boolean,
  running: boolean,
  errorKind: ComposerErrorKind | null,
): ComposerDraftPatch | null {
  if (!(prevRunning && !running)) return null;
  if (errorKind !== "unconfirmed") return null;
  return { error: null, errorKind: null, unconfirmed: null };
}

/** Test-only: reset every session's draft and the listeners between cases. */
export function resetComposerDraftForTests(): void {
  drafts.clear();
  listeners.clear();
}
