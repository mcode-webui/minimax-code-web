/**
 * Session-rail helpers — the reference rail's ordering/labeling algorithm,
 * moved verbatim from the reference client's `SessionRail.tsx`
 * (webui-parity 58, line B).
 *
 * The reference keeps its rail deterministic so paging and a refresh do not
 * reshuffle a project while the user is looking at it; the same guarantee is
 * what this port buys. Field adapters are the only change: the reference's
 * `WebuiClientSession` carries `sessionId` / `workspaceDir`, while our tree
 * payload (`lib/api.ts#TreeSession`) carries `id` and hangs the directory off
 * the parent level — so the functions below speak our field names and the
 * caller passes `workspaceDir` in where it is known.
 */

/** The reference's `sessionLabel`: a trimmed title, else the agent name, else the raw id. */
export function sessionLabel(session: {
  readonly title: string;
  readonly agent: string;
  readonly id: string;
}): string {
  return session.title?.trim() || session.agent || session.id;
}

/**
 * The reference's `workspaceProjectName`: the last path segment of a
 * workspace directory (`/a/b/mcode` → `mcode`), or 未选项目 when absent.
 */
export function workspaceProjectName(workspaceDir?: string): string {
  const value = workspaceDir?.trim();
  if (!value) return "未选项目";
  const normalized = value.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || normalized;
}

/**
 * The reference's `sortWebuiProjectSessionIds`: pinned sessions first, then
 * by `updatedAt` descending. Deterministic for equal inputs — the sort keys
 * are total (pin flag, then a number), so two sessions with the same
 * `updatedAt` keep the array's incoming order (the server's activity order).
 */
export function sortWebuiProjectSessionIds(
  sessions: readonly { readonly id: string; readonly updatedAt: number }[],
  pinnedSessions: Readonly<Record<string, boolean>>,
  sessionIds: readonly string[],
): string[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return [...sessionIds].sort((left, right) => {
    const pinDelta =
      Number(Boolean(pinnedSessions[right])) - Number(Boolean(pinnedSessions[left]));
    if (pinDelta) return pinDelta;
    return (byId.get(right)?.updatedAt ?? 0) - (byId.get(left)?.updatedAt ?? 0);
  });
}
