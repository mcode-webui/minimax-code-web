/**
 * Composer draft store — the typed text, the `@path` attachment chips, and
 * the send-error banner, held OUTSIDE the React tree.
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
 * The store is deliberately tiny — one object, last write wins — and is
 * consumed through `useSyncExternalStore` (see `components/composer.tsx`)
 * so a remounting instance reads the same draft a previous instance wrote.
 * This module must stay React-free: `webapp/test/composer-draft.test.ts`
 * imports it directly under the plain Node test runner.
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
 * `unconfirmed` — the acknowledgement never arrived and the follow-up read
 * against the server could not establish whether the turn started. The text
 * may already be executing. Never rendered as a failure, and the draft is
 * only restored when the server positively holds no record of the send.
 */
export type ComposerErrorKind = "rejected" | "unconfirmed";

const EMPTY_DRAFT: ComposerDraft = {
  value: "",
  error: null,
  errorKind: null,
  unconfirmed: null,
  attachments: [],
};

let draft: ComposerDraft = EMPTY_DRAFT;
const listeners = new Set<() => void>();

export type ComposerDraftPatch =
  | Partial<ComposerDraft>
  | ((current: ComposerDraft) => Partial<ComposerDraft>);

/** Write a patch (or an updater, mirroring `setState` semantics). */
export function setComposerDraft(patch: ComposerDraftPatch): void {
  const resolved = typeof patch === "function" ? patch(draft) : patch;
  draft = { ...draft, ...resolved };
  for (const listener of listeners) listener();
}

/** Read the current draft. Stable identity between writes. */
export function getComposerDraft(): ComposerDraft {
  return draft;
}

/** `useSyncExternalStore` subscription. Returns the unsubscribe thunk. */
export function subscribeComposerDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: reset the draft to empty between cases. */
export function resetComposerDraftForTests(): void {
  draft = EMPTY_DRAFT;
  listeners.clear();
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
