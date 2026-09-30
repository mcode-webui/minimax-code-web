// webapp/lib/turn-diff.ts — this turn's real file-change record.
//
// webui-parity 83 (ticket 80's plan B). The engine persists a turn's file
// changes under the msg_id of that turn's LAST assistant message; the
// transcript carries that id as `§§ turn_msg=<id>` and `decodeTranscript`
// attaches it to the turn's assistant block. This module turns that id into
// the engine's own record — real `+N` / `-N` per file, and the `canUndo` /
// `canReapply` gates — so the 「已编辑 N 个文件」 card stops describing a turn
// by inference and starts describing what actually happened.
//
// The one rule everything else follows: **no id, no record.** The engine's
// selector falls back to `latestForSession` when it is given no id
// (`local-runtime/src/turns/diff-api.ts:209-220`), so a request without
// `assistantMessageId` would answer with a DIFFERENT turn's numbers and let
// an undo button rewrite the wrong files. A real run confirmed the engine
// itself does not fall back for an unknown id (it returns empty), but a
// missing id is a different case and is never sent. Turns without one — old
// sessions, the legacy read path, the exec transport — render exactly the
// path-only card they render today.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getTurnDiff, revertTurnDiff, reapplyTurnDiff } from "./api";

/** One file the engine recorded as changed, with its real line counts. */
export interface FileDiffInfo {
  readonly file: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status?: string;
  readonly diff?: string;
  readonly external?: boolean;
}

/** `TurnDiffView` from packages/protocol — the fields the card can prove. */
export interface TurnDiff {
  readonly fileChanges: readonly FileDiffInfo[];
  readonly sourceMessageId?: string;
  readonly changeSetId?: string;
  readonly status?: string;
  readonly undoable?: boolean;
  readonly canUndo?: boolean;
  readonly canReapply?: boolean;
}

export interface TurnDiffResponse {
  readonly ok: boolean;
  readonly turnDiff: TurnDiff | null;
}

export type TurnDiffErrorKind = "conflict" | "unavailable" | "other";

export interface TurnDiffFailure {
  readonly kind: TurnDiffErrorKind;
  readonly message: string;
}

/**
 * Project one engine answer into the card's view, or `null` for "no record".
 *
 * Exported because the three degradation tiers are decided HERE, and a
 * projection that quietly invented a default would put another turn's counts
 * under this card. An answer with no `changeSetId` selected nothing at all
 * (the runtime returns an all-undefined view for an id it does not know, and
 * the route answers `turnDiff: null` when there was no id to begin with) —
 * that is the absence of a record, never a record with zero files.
 */
export function normaliseTurnDiff(raw: unknown): TurnDiff | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const changes = Array.isArray(r.fileChanges) ? r.fileChanges : [];
  const fileChanges: FileDiffInfo[] = [];
  for (const entry of changes) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.file !== "string" || !e.file) continue;
    fileChanges.push({
      file: e.file,
      additions: typeof e.additions === "number" ? e.additions : 0,
      deletions: typeof e.deletions === "number" ? e.deletions : 0,
      ...(typeof e.status === "string" ? { status: e.status } : {}),
      ...(typeof e.diff === "string" ? { diff: e.diff } : {}),
      ...(e.external === true ? { external: true } : {}),
    });
  }
  // An engine answer with no `changeSetId` selected no record at all (the
  // runtime returns an all-undefined view for an id it does not know). That
  // is the "no record" case, not a record with zero files.
  if (typeof r.changeSetId !== "string" || !r.changeSetId) return null;
  return {
    fileChanges,
    ...(typeof r.sourceMessageId === "string" ? { sourceMessageId: r.sourceMessageId } : {}),
    changeSetId: r.changeSetId,
    ...(typeof r.status === "string" ? { status: r.status } : {}),
    ...(typeof r.undoable === "boolean" ? { undoable: r.undoable } : {}),
    ...(typeof r.canUndo === "boolean" ? { canUndo: r.canUndo } : {}),
    ...(typeof r.canReapply === "boolean" ? { canReapply: r.canReapply } : {}),
  };
}

/**
 * Classify a failed turn-diff call.
 *
 * The 409 the engine raises for a non-latest turn carries the only sentence
 * that says why the undo did nothing, so it is classified as a conflict and
 * shown verbatim rather than folded into a generic failure.
 */
export function turnDiffFailureOf(error: unknown): TurnDiffFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/only the latest turn/i.test(message)) return { kind: "conflict", message };
  if (/conflict|changed on disk|not available for this turn/i.test(message)) {
    return { kind: "conflict", message };
  }
  if (/runtime unavailable/i.test(message)) return { kind: "unavailable", message };
  return { kind: "other", message };
}

export interface TurnDiffsState {
  /** turnIndex → record. Absent means "nothing fetched yet / no coordinate". */
  readonly diffs: ReadonlyMap<number, TurnDiff>;
  /** turnIndex → last failure, kept so a card can show it and retry. */
  readonly errors: ReadonlyMap<number, TurnDiffFailure>;
  /** Turn indices with a mutation in flight. */
  readonly busy: ReadonlySet<number>;
  readonly revert: (turnIndex: number) => Promise<void>;
  readonly reapply: (turnIndex: number) => Promise<void>;
  readonly clearError: (turnIndex: number) => void;
}

/**
 * Fetch each turn's record, once per coordinate.
 *
 * Keyed by the turn's `assistantMessageId`, so a turn that re-renders while
 * streaming does not re-fetch, and a turn whose id is absent is never
 * requested. One effect issues every turn's lookup rather than one effect per
 * card, so a long transcript does not mount a dozen independent fetch loops.
 */
export function useTurnDiffs(
  sessionId: string | null,
  coordinates: ReadonlyMap<number, string>,
): TurnDiffsState {
  const [diffs, setDiffs] = useState<ReadonlyMap<number, TurnDiff>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<number, TurnDiffFailure>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());

  // A stable string key so the effect depends on the CONTENT of the map, not
  // on a fresh Map identity from the parent on every render.
  const coordinateKey = useMemo(
    () =>
      [...coordinates.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([turnIndex, id]) => `${turnIndex}=${id}`)
        .join("|"),
    [coordinates],
  );

  useEffect(() => {
    const entries = coordinateKey === "" ? [] : coordinateKey.split("|").map((pair) => {
      const at = pair.indexOf("=");
      return [Number.parseInt(pair.slice(0, at), 10), pair.slice(at + 1)] as const;
    });
    if (!sessionId || entries.length === 0) {
      setDiffs(new Map());
      return;
    }
    let cancelled = false;
    for (const [turnIndex, assistantMessageId] of entries) {
      void getTurnDiff(sessionId, assistantMessageId)
        .then((payload) => {
          if (cancelled) return;
          const diff = normaliseTurnDiff(payload.turnDiff);
          setDiffs((current) => {
            const next = new Map(current);
            if (diff) next.set(turnIndex, diff);
            else next.delete(turnIndex);
            return next;
          });
        })
        .catch((error) => {
          if (cancelled) return;
          setErrors((current) => {
            const next = new Map(current);
            next.set(turnIndex, turnDiffFailureOf(error));
            return next;
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [sessionId, coordinateKey]);

  const mutate = useCallback(
    async (turnIndex: number, action: "revert" | "reapply") => {
      const assistantMessageId = coordinates.get(turnIndex);
      // No coordinate → nothing to act on. Never a default turn.
      if (!sessionId || !assistantMessageId) return;
      setBusy((current) => new Set(current).add(turnIndex));
      setErrors((current) => {
        const next = new Map(current);
        next.delete(turnIndex);
        return next;
      });
      try {
        const call = action === "revert" ? revertTurnDiff : reapplyTurnDiff;
        const payload = await call(sessionId, assistantMessageId);
        const diff = normaliseTurnDiff(payload.turnDiff);
        setDiffs((current) => {
          const next = new Map(current);
          if (diff) next.set(turnIndex, diff);
          else next.delete(turnIndex);
          return next;
        });
      } catch (error) {
        setErrors((current) => new Map(current).set(turnIndex, turnDiffFailureOf(error)));
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(turnIndex);
          return next;
        });
      }
    },
    [sessionId, coordinates],
  );

  const revert = useCallback((turnIndex: number) => mutate(turnIndex, "revert"), [mutate]);
  const reapply = useCallback((turnIndex: number) => mutate(turnIndex, "reapply"), [mutate]);
  const clearError = useCallback((turnIndex: number) => {
    setErrors((current) => {
      if (!current.has(turnIndex)) return current;
      const next = new Map(current);
      next.delete(turnIndex);
      return next;
    });
  }, []);

  return { diffs, errors, busy, revert, reapply, clearError };
}
