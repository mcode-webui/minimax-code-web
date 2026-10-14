// webapp/lib/goal-enabled.ts
//
// PB-14 batch C: whether the engine's goal feature is on, shared by the two
// places that need the answer.
//
// WHO ASKS. Exactly two: the composer (to know whether `/goal` is a command
// or somebody else's word) and the chat column (to know whether a banner may
// appear at all). Two subscribers with one endpoint between them is why this
// is one module rather than a `useState` in each — two independent reads
// would be two answers to the same question, and they could disagree.
//
// WHY IT IS ASKED ONCE AND CACHED. `isGoalEnabled` reads an engine FACADE
// flag, not a per-session store: it is the same answer for every conversation
// this tab will ever open, and it does not change while a page is loaded (the
// engine would have to be reconfigured under us). So the read happens once
// per page load and every subscriber hears the same answer. A tab that opens
// ten conversations asks one question.
//
// WHY `null` IS THE STARTING ANSWER AND NOT `false`. A tri-state
// (`null` = not read yet, `true`, `false`) is what lets the UI distinguish
// "we have not asked" from "the engine said no". Collapsing them would make
// every control flash into existence a moment after the page paints, which
// is the layout jump this gate exists to prevent.
//
// THE DEFAULT UNDER UNCERTAINTY IS `false`. This is the opposite of
// `lib/engine-capabilities.ts`, which fails OPEN, and the difference is
// deliberate rather than an inconsistency: that gate hides a control when the
// PROVIDER declares no capability, and its failure mode is a hidden model
// picker during a slow probe. This gate hides a control when the ENGINE has
// the feature switched off, and its failure mode if we failed open would be
// a `/goal` that accepts the user's text and then answers 501 — a command
// that takes an objective and loses it. Refusing to offer is recoverable;
// accepting and dropping is not.

import { useEffect, useState } from "react";

import { getGoalEnabled } from "./api";
import { readGoalEnabled } from "./goal-state";

/** `null` until the first answer arrives; then the engine's own flag. */
export type GoalEnabled = boolean | null;

let current: GoalEnabled = null;
let inFlight: Promise<GoalEnabled> | null = null;
const listeners = new Set<() => void>();

function publish(next: GoalEnabled): void {
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Read the flag once and share the answer with every subscriber.
 *
 * The in-flight promise is kept rather than the boolean alone so that two
 * components mounting in the same tick produce ONE request: the second caller
 * awaits the first call's promise instead of starting a second read. A failed
 * read publishes `false` and clears the promise, so the next mount retries
 * rather than caching a transient network failure for the life of the page.
 */
export async function readGoalEnabledOnce(): Promise<GoalEnabled> {
  if (current !== null) return current;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const answer = readGoalEnabled(await getGoalEnabled());
      publish(answer);
      return answer;
    } catch {
      // A probe that failed says nothing about the engine, and the honest
      // answer to "is this feature on" when nobody could ask is "do not
      // offer it". See the header for why this is not fail-open.
      publish(false);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * The shared flag, for callers outside React (the composer's submit path).
 *
 * Deliberately returns the CURRENT value without kicking off a read: the
 * composer's `/goal` branch runs on a submit, and starting a network request
 * inside that callback would make a command's meaning depend on a request it
 * did not ask for. The page read is armed by `useGoalEnabled` at mount; a
 * composer mounted before any read simply does not claim the command.
 */
export function peekGoalEnabled(): GoalEnabled {
  return current;
}

/** Subscribe to the flag. Test seam: lets a suite drive both consumers. */
export function subscribeGoalEnabled(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget the answer. Test seam, and the hook's cleanup owner on unmount. */
export function resetGoalEnabledCache(): void {
  current = null;
  inFlight = null;
  for (const listener of [...listeners]) listener();
}

/**
 * The flag as a component sees it, starting the read on mount.
 *
 * `useSyncExternalStore` would be the textbook choice, and it is not used:
 * the store is written from a promise callback and read during render, and
 * the two-line subscription below is the whole of the coupling. The read is
 * fire-and-forget and cannot reject, so the effect has no cleanup beyond the
 * unsubscribe — an in-flight read is not aborted on unmount, because its only
 * effect is to publish an answer the next subscriber would want anyway.
 */
export function useGoalEnabled(): GoalEnabled {
  const [value, setValue] = useState<GoalEnabled>(current);
  useEffect(() => {
    setValue(current);
    const unsubscribe = subscribeGoalEnabled(() => setValue(current));
    void readGoalEnabledOnce();
    return unsubscribe;
  }, []);
  return value;
}