/**
 * Where a session switch actually landed.
 *
 * The switch response names the session the engine activated. Comparing it
 * with the row the user clicked is the only way to tell a switch that worked
 * from one that silently did nothing — the failure webui-parity 63 recorded as
 * defect E, where the sidebar, the URL and the engine's active session simply
 * disagreed and the UI said nothing.
 *
 * Kept as a pure function so the decision is testable without a DOM harness,
 * and so the three outcomes stay distinguishable: only a proven mismatch may
 * raise a notice, a response that carries no session identity is not evidence
 * of anything.
 */

/** `unknown` — the response named no session; nothing to compare. */
export type SwitchLanding = "landed" | "mismatch" | "unknown";

export function classifySwitchLanding(
  landed: { id?: string | null; mcodeSessionId?: string | null } | undefined | null,
  requestedId: string,
): SwitchLanding {
  if (!landed) return "unknown";
  // Either field may be the one the caller used: a legacy webui-uuid record is
  // addressed by its uuid, a first-touch overlay by the engine id. Matching on
  // the pair is what keeps a legitimate switch from being reported as a miss.
  const identities = [landed.id, landed.mcodeSessionId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (identities.length === 0) return "unknown";
  return identities.includes(requestedId) ? "landed" : "mismatch";
}
