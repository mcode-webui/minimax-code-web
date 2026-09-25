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

export interface ComposerDraft {
  /** Text currently typed in the textarea. */
  value: string;
  /** Last send-failure message, or null. Rendered as the error banner. */
  error: string | null;
  /** Accepted upload references, `@path` prefixed. */
  attachments: string[];
}

const EMPTY_DRAFT: ComposerDraft = { value: "", error: null, attachments: [] };

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
