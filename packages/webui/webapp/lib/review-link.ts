// webapp/lib/review-link.ts — the 「Review」 button's state.
//
// PB-16 (`doc/placeholder-batch-plan.md` §6.2-6.3). The desktop's edited-files
// card carries a 「Review」 control next to 「撤销」
// (`design-ref/screenshots/06-browser-tree-tasks-review.jpg`); this module
// decides whether that control can do anything.
//
// WHAT THE ENGINE KNOWS. The runtime RECORDS a review link when an agent turn
// ran `gh pr create|view` or `glab mr create|view`
// (packages/local-runtime/src/review-link/store.ts), keyed by
// `<workspaceDir>\n<branch>`. It is never fetched from a git host, so "no link"
// is the ordinary state of a repository nobody has opened a PR from — not a
// failure, and not something the client may paper over.
//
// THE THREE THINGS THIS MODULE KEEPS APART:
//
//   1. `normaliseReviewLink` — the untrusted-boundary reader. A server answer
//      is not a usable link until every field has been checked, including that
//      the url is http(s). A button that opens `javascript:` is a control the
//      user did not consent to.
//   2. `reviewLinkDisabledReason` — why a card must not offer a clickable
//      control. Three distinct absences (no workspace, no branch, no recorded
//      review) and one distinct failure (the engine could not answer) are four
//      different sentences, and collapsing them into "unavailable" would be
//      the vague-tooltip failure mode the desktop-fidelity work exists to
//      remove.
//   3. `useReviewLink` — ONE read per session, not one per rendered card. A
//      transcript can hold a dozen cards; the link belongs to the workspace,
//      not to a turn.
//
// A disabled button is deliberate and is NOT the "no link → draw nothing"
// discipline `edited-files-card.tsx` applies to undo. The desktop always shows
// 「Review」 in that slot, so a card that silently drops it would read as a
// missing FEATURE rather than as an honest absence — and the reason is always
// reachable in its tooltip. What never happens is a live button that opens
// nothing.

"use client";

import { useEffect, useState } from "react";
import { getReviewLink, type ReviewLinkWire } from "./api";

/** A review the button may actually open. */
export interface ReviewLink {
  readonly vendor: "github" | "gitlab";
  readonly url: string;
  readonly number: number;
  readonly branch: string;
  readonly origin: "created" | "viewed";
}

/** The absences the server names (`engine/review-link.js#REVIEW_LINK_REASONS`). */
export type ReviewLinkReason = "unknown_workspace" | "no_branch" | "no_review_link";

/**
 * Why the control is inert.
 *
 * `engine_unavailable` is the one value this module ADDS, and it is the
 * important one: 501 / 503 / 400 mean the engine never answered the question,
 * which is a different sentence from "there is no review". The server keeps
 * them apart on purpose and the tooltip must as well.
 */
export type ReviewLinkDisabled = ReviewLinkReason | "engine_unavailable";

export type ReviewLinkState =
  /** The read has not landed yet; the control is inert rather than wrong. */
  | { readonly status: "loading" }
  | { readonly status: "available"; readonly link: ReviewLink }
  | { readonly status: "unavailable"; readonly reason: ReviewLinkDisabled };

/** The state before any read has been attempted. */
export const INITIAL_REVIEW_LINK_STATE: ReviewLinkState = { status: "loading" };

const VENDORS = ["github", "gitlab"] as const;
const ORIGINS = ["created", "viewed"] as const;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Project one wire record into a link the button may open.
 *
 * Returns `null` for anything incomplete, which the caller reports as "no
 * review" rather than as an error: a half-record on disk is unreadable state,
 * and the honest rendering of unreadable state is a disabled control.
 *
 * Exported so the rule can be pinned by a test without a renderer.
 *
 * @param raw The untrusted answer.
 * @returns {ReviewLink|null}
 */
export function normaliseReviewLink(raw: unknown): ReviewLink | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as ReviewLinkWire;
  const { vendor, url, number, branch, origin } = record;
  if (typeof vendor !== "string" || !VENDORS.includes(vendor as "github")) return null;
  if (typeof origin !== "string" || !ORIGINS.includes(origin as "created")) return null;
  if (typeof branch !== "string" || branch.length === 0) return null;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  if (typeof url !== "string" || url.length === 0 || !isHttpUrl(url)) return null;
  return {
    vendor: vendor as "github" | "gitlab",
    origin: origin as "created" | "viewed",
    url,
    number,
    branch,
  };
}

/**
 * Read one answer into a state the card can render.
 *
 * Kept separate from the fetch so every branch — the honest empty, the
 * unusable record, the refusal — is decided in one testable function.
 *
 * @param raw The untrusted answer.
 * @param error Whatever the fetch threw, when it threw.
 * @returns {ReviewLinkState}
 */
export function reviewLinkStateOf(raw: unknown, error?: unknown): ReviewLinkState {
  if (error) {
    // A thrown `ApiHttpError` means the engine did not answer (400 no session,
    // 501 no capability, 503 no host). Any other throw is the same sentence
    // from the user's side: nothing was established, so nothing is claimed.
    return { status: "unavailable", reason: "engine_unavailable" };
  }
  if (!raw || typeof raw !== "object") {
    return { status: "unavailable", reason: "engine_unavailable" };
  }
  const payload = raw as { reviewLink?: unknown; reason?: unknown };
  const link = normaliseReviewLink(payload.reviewLink);
  if (link) return { status: "available", link };
  const reason = payload.reason;
  if (typeof reason === "string" && reason.length > 0) {
    return { status: "unavailable", reason: reason as ReviewLinkReason };
  }
  // A 200 that carries neither a usable link nor a reason is a server answer
  // this module cannot interpret. Claiming "no review" from it would be a
  // guess about someone else's bug.
  return { status: "unavailable", reason: "engine_unavailable" };
}

/**
 * One read per session, shared by every card in the transcript.
 *
 * `enabled` is false while there is no conversation at all: without a session
 * the endpoint answers 400, and a 400 the app could have avoided by not asking
 * is noise in the console and a disabled control that flickers on every new
 * conversation.
 *
 * @param enabled Whether this tab has a conversation worth asking about.
 * @param load Injected for tests; production passes the real endpoint call.
 * @returns {ReviewLinkState}
 */
export function useReviewLink(
  enabled: boolean,
  load: () => Promise<unknown> = getReviewLink,
): ReviewLinkState {
  const [state, setState] = useState<ReviewLinkState>(INITIAL_REVIEW_LINK_STATE);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Re-enter as loading whenever the conversation changes: the previous
    // session's link belongs to a different workspace, and leaving it on
    // screen would be a stale control.
    setState(INITIAL_REVIEW_LINK_STATE);
    load().then(
      (raw) => {
        if (cancelled) return;
        setState(reviewLinkStateOf(raw));
      },
      (error) => {
        if (cancelled) return;
        setState(reviewLinkStateOf(null, error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, load]);

  return state;
}