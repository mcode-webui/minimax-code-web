/**
 * The decision and the result reading for message-level edit / rewind
 * (PB-15, `doc/placeholder-batch-plan.md` §7 row G-3).
 *
 * Why this file exists rather than living in `components/chat.tsx`. Two
 * decisions have to be made before any button is drawn, and both are wrong
 * easily:
 *
 *   1. WHICH ENGINE CALL a confirm performs. The engine's
 *      `editSessionMessage` is atomic — it rewinds to the message, rewrites
 *      it and resubmits in one operation. The engine's `rewindSession` only
 *      truncates and stops. So a confirm with CHANGED text is one call, and
 *      a confirm with UNCHANGED text is a rewind followed by an ordinary
 *      `/api/send` — because re-running an identical message through the
 *      atomic path would mint a second engine operation for no change to
 *      the text.
 *
 *   2. WHETHER THE ENGINE ACTUALLY DID IT. Both answers carry `rewound`,
 *      and both endpoints can answer 200 with `rewound:false`. A caller
 *      that treats "the request succeeded" as "the message was replaced"
 *      would tell a user their conversation was rewritten when it was not.
 *
 * Both are pure functions of their inputs, so both are testable without a
 * DOM harness — which is where they were found wrong first.
 */

/** What a confirm on the inline editor performs. */
export type MessageEditPlan =
  /** Text changed — one atomic engine call. */
  | { readonly kind: "edit"; readonly content: string }
  /** Text unchanged — truncate, then resend the same text. */
  | { readonly kind: "resend"; readonly content: string }
  /** Nothing to send. */
  | { readonly kind: "blocked"; readonly reason: "empty" };

/**
 * Decide which engine call a confirm performs.
 *
 * The comparison is EXACT, not trimmed: the engine stores what it is given,
 * and a draft that differs only in trailing whitespace is a different
 * message. Trimming first would silently drop the user's edit.
 *
 * @param original The text the user message currently shows.
 * @param draft What is in the inline editor.
 */
export function planMessageEdit(original: string, draft: string): MessageEditPlan {
  if (typeof draft !== "string" || draft.trim().length === 0) {
    return { kind: "blocked", reason: "empty" };
  }
  return draft === original ? { kind: "resend", content: original } : { kind: "edit", content: draft };
}

/** What the engine's per-turn file outcome means to the user. */
export type DiffRewindVerdict =
  /** The engine reverted every turn it reported. */
  | "reverted"
  /** The engine reported an outcome the webapp does not name. */
  | "other"
  /** The engine rewound the history but did not restore every file. */
  | "partial";

/** The engine's file outcome, read from what the endpoint actually returned. */
export interface RewindDiffReport {
  readonly status: string;
  readonly revertedTurnIds?: readonly string[];
  readonly errorCode?: string;
}

/** What the user is told after a confirm, however it ended. */
export type MessageEditOutcome =
  /** The engine rewound and resubmitted the rewritten message. */
  | { readonly status: "edited"; readonly deletedCount: number }
  /** The engine truncated and the resend was accepted. */
  | {
      readonly status: "resent";
      readonly deletedCount: number;
      readonly diffRewind: DiffRewindVerdict;
    }
  /** The engine answered 200 but did not rewind. */
  | { readonly status: "not_rewound" }
  /** The call failed; `code` and `message` are the server's, not invented. */
  | { readonly status: "refused"; readonly code: string; readonly message: string };

/**
 * Read the engine's file outcome without inventing a verdict.
 *
 * `null` (no outcome reported) is NOT success: the engine can rewind a
 * history and leave the files a discarded turn wrote exactly as they were,
 * and a client that rendered that as "reverted" would be describing a
 * workspace the engine never restored. `partial` is the honest word for it,
 * and it is why the UI's success sentence is scoped to the conversation
 * rather than to the files.
 *
 * @param report The endpoint's `turnDiffRewind`, verbatim.
 */
export function readDiffRewindVerdict(
  report: RewindDiffReport | null | undefined,
): DiffRewindVerdict {
  if (!report || typeof report.status !== "string" || report.status === "") return "partial";
  // An errorCode wins over a `reverted` status: the engine can report that it
  // REVERTED a turn and still carry the reason it could not finish, and
  // reading the status alone would drop the reason.
  if (typeof report.errorCode === "string" && report.errorCode !== "") return "partial";
  return report.status === "reverted" ? "reverted" : "other";
}

/**
 * Read an edit answer.
 *
 * `rewound:false` is a first-class outcome, not a success with a caveat.
 *
 * @param answer The endpoint's payload.
 */
export function readEditOutcome(answer: {
  readonly rewound?: boolean;
  readonly deletedCount?: number;
}): MessageEditOutcome {
  if (answer?.rewound !== true) return { status: "not_rewound" };
  return {
    status: "edited",
    deletedCount:
      typeof answer.deletedCount === "number" && answer.deletedCount >= 0
        ? answer.deletedCount
        : 0,
  };
}

/**
 * Read a rewind answer.
 *
 * @param answer The endpoint's payload.
 */
export function readRewindOutcome(answer: {
  readonly rewound?: boolean;
  readonly deletedCount?: number;
  readonly turnDiffRewind?: RewindDiffReport | null;
}): MessageEditOutcome {
  if (answer?.rewound !== true) return { status: "not_rewound" };
  return {
    status: "resent",
    deletedCount:
      typeof answer.deletedCount === "number" && answer.deletedCount >= 0
        ? answer.deletedCount
        : 0,
    diffRewind: readDiffRewindVerdict(answer.turnDiffRewind),
  };
}

/**
 * Read a thrown `ApiHttpError` into the same outcome union, so the editor
 * has one place to render every ending and no path can render a success by
 * accident.
 *
 * @param error Whatever the client threw.
 */
export function readRefusalOutcome(error: unknown): MessageEditOutcome {
  const record = (error ?? {}) as { code?: unknown; message?: unknown };
  return {
    status: "refused",
    code: typeof record.code === "string" && record.code ? record.code : "edit_failed",
    message:
      typeof record.message === "string" && record.message
        ? record.message
        : "the message could not be changed",
  };
}