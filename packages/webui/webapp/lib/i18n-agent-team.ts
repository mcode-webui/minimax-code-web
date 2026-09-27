/**
 * Bilingual strings — slice 06 (Agent Team) only.
 *
 * New module rather than extending `lib/i18n.ts` because that file is
 * owned by slice 01 (the file-tree slice, in flight). Adding keys here
 * avoids a merge conflict when both slices land.
 *
 * Every key MUST exist in both `en` and `zh` — the runtime check is the
 * `agent-team-i18n.test.ts` lock, not just a manual review. A key
 * missing in one locale silently falls back to the en value (or the key
 * name itself), and the panel ships in Chinese by default, so a missing
 * zh entry ships English text to a Chinese-locale user.
 */

import type { Locale } from "./i18n";

const AGENT_TEAM_STRINGS = {
  en: {
    // Status labels for the toolCard subagent badge. The label is
    // shown next to the agent name (e.g. "Running ▶ verifier") and
    // doubles as the `aria-label` body. `idle` is included for the
    // pre-status state the poller reports between subagent birth and
    // the first background_tasks refresh.
    "agentTeam.statusLabel.running": "Running",
    "agentTeam.statusLabel.done": "Done",
    "agentTeam.statusLabel.failed": "Failed",
    "agentTeam.statusLabel.stopped": "Stopped",
    "agentTeam.statusLabel.idle": "Idle",
    "agentTeam.statusLabel.queued": "Queued",
    // Fallback name when the runtime did not stamp an agent name
    // (older chat, or a mid-stream attach race).
    "agentTeam.subagentFallback": "subagent",
    // Known agent team member labels. The runtime stores these as
    // English tokens (`explore`, `worker`, `verifier`, `coder`) so
    // the frontend translates them per-locale. A token we have not
    // mapped (a future custom agent) falls back to the English token
    // verbatim.
    "agentTeam.agent.explore": "Explore",
    "agentTeam.agent.worker": "Worker",
    "agentTeam.agent.verifier": "Verifier",
    "agentTeam.agent.coder": "Coder",
    // Glyph prefix the badge renders before the agent label (e.g.
    // "▶ Explore"). U+25B6 (▶) for running; U+2713 (✓) for done;
    // U+2717 (✗) for failed; U+25A0 (■) for stopped; U+00B7 (·) for
    // queued / idle. Kept separate from the label so future i18n
    // (e.g. RTL) can swap just the glyph.
    "agentTeam.badge.glyph.running": "\u25B6",
    "agentTeam.badge.glyph.done": "\u2713",
    "agentTeam.badge.glyph.failed": "\u2717",
    "agentTeam.badge.glyph.stopped": "\u25A0",
    "agentTeam.badge.glyph.queued": "\u00B7",
    "agentTeam.badge.glyph.idle": "\u00B7",
    // The badge's full tooltip / aria-label. Shown to screen readers
    // and on hover; carries both the status and the session id so a
    // user can paste it into the run-mirror search field if the
    // click does not navigate.
    "agentTeam.badge.open": "Open subagent session",
  },
  zh: {
    "agentTeam.statusLabel.running": "\u8FD0\u884C\u4E2D",
    "agentTeam.statusLabel.done": "\u5DF2\u5B8C\u6210",
    "agentTeam.statusLabel.failed": "\u5931\u8D25",
    "agentTeam.statusLabel.stopped": "\u5DF2\u505C\u6B62",
    "agentTeam.statusLabel.idle": "\u7A7A\u95F2",
    "agentTeam.statusLabel.queued": "\u6392\u961F\u4E2D",
    "agentTeam.subagentFallback": "\u5B50 agent",
    "agentTeam.agent.explore": "\u63A2\u67E5\u8005",
    "agentTeam.agent.worker": "\u52A9\u624B",
    "agentTeam.agent.verifier": "\u9A8C\u8BC1\u8005",
    "agentTeam.agent.coder": "\u7F16\u7801\u8005",
    "agentTeam.badge.glyph.running": "\u25B6",
    "agentTeam.badge.glyph.done": "\u2713",
    "agentTeam.badge.glyph.failed": "\u2717",
    "agentTeam.badge.glyph.stopped": "\u25A0",
    "agentTeam.badge.glyph.queued": "\u00B7",
    "agentTeam.badge.glyph.idle": "\u00B7",
    "agentTeam.badge.open": "\u6253\u5F00\u5B50 agent \u4F1A\u8BDD",
  },
} as const;

export type AgentTeamKey = keyof typeof AGENT_TEAM_STRINGS["en"];

/** Exported for tests. Treat as immutable — the runtime only reads. */
export { AGENT_TEAM_STRINGS };

/**
 * Resolve a slice-06 string for the current locale.
 *
 * Falls back to en when the requested locale is unknown (defensive —
 * the webui only ships zh / en today, but the function should not
 * throw if a future third locale slips through). Falls back to the
 * raw key when the bucket is missing the entry, so a regression here
 * shows the key name (e.g. "agentTeam.statusLabel.X") in the UI
 * rather than rendering an empty badge.
 */
export function tAgentTeam(
  locale: Locale,
  key: AgentTeamKey,
): string {
  const safeLocale = (locale === "zh" ? "zh" : "en") as "zh" | "en";
  const bucket = AGENT_TEAM_STRINGS[safeLocale] || AGENT_TEAM_STRINGS.en;
  return bucket[key] || (AGENT_TEAM_STRINGS.en[key] ?? key);
}

/**
 * Map a server-side UI status (the AGENT_TEAM_STATUS vocabulary — see
 * `server/lib/agent-team-status.js`) to the locale-resolved badge
 * label and glyph pair. Returns `null` for statuses the badge does
 * not render, so the caller can decide whether to render at all.
 */
export function badgeLabelAndGlyph(
  locale: Locale,
  uiStatus: string | null | undefined,
): { label: string; glyph: string } | null {
  if (!uiStatus) return null;
  if (
    uiStatus !== "running" &&
    uiStatus !== "done" &&
    uiStatus !== "failed" &&
    uiStatus !== "stopped" &&
    uiStatus !== "idle" &&
    uiStatus !== "queued"
  ) {
    return null;
  }
  return {
    label: tAgentTeam(locale, `agentTeam.statusLabel.${uiStatus}`),
    glyph: tAgentTeam(locale, `agentTeam.badge.glyph.${uiStatus}`),
  };
}

/**
 * Resolve a runtime-stored agent name token (e.g. `verifier`) to its
 * locale-resolved label. Unknown tokens fall back to the English
 * verbatim (so a future custom agent still renders something
 * readable), then to the subagent fallback when the input is empty.
 */
export function agentLabel(locale: Locale, agentName: string | null | undefined): string {
  const safeLocale = (locale === "zh" ? "zh" : "en") as "zh" | "en";
  if (typeof agentName !== "string" || !agentName) {
    return tAgentTeam(locale, "agentTeam.subagentFallback");
  }
  const enKey = `agentTeam.agent.${agentName}`;
  if (enKey in AGENT_TEAM_STRINGS.en) {
    return AGENT_TEAM_STRINGS[safeLocale][enKey as AgentTeamKey] || agentName;
  }
  return agentName;
}
