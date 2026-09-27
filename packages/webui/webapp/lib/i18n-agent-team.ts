/**
 * Bilingual strings — slice 06 (Agent Team) only.
 *
 * New module rather than extending `lib/i18n.ts` because that file is
 * owned by slice 01 (the file-tree slice, in flight). Adding keys here
 * avoids a merge conflict when both slices land.
 *
 * Two locales are required by the existing webui convention; add both
 * entries when adding a key. The runtime check in `useLocale` is
 * unchanged.
 */

import type { Locale } from "./i18n";

const AGENT_TEAM_STRINGS = {
  en: {
    "agentTeam.running": "running",
    "agentTeam.done": "done",
    "agentTeam.failed": "failed",
    "agentTeam.stopped": "stopped",
    "agentTeam.open": "Open subagent session",
    "agentTeam.badge.running": "Running \u25B6",
    "agentTeam.badge.queued": "Queued",
    "agentTeam.toolLine.subagentPrefix": "subagent:",
  },
  zh: {
    "agentTeam.running": "\u8FD0\u884C\u4E2D",
    "agentTeam.done": "\u5DF2\u5B8C\u6210",
    "agentTeam.failed": "\u5931\u8D25",
    "agentTeam.stopped": "\u5DF2\u505C\u6B62",
    "agentTeam.open": "\u6253\u5F00\u5B50 agent \u4F1A\u8BDD",
    "agentTeam.badge.running": "\u8FD0\u884C\u4E2D \u25B6",
    "agentTeam.badge.queued": "\u6392\u961F\u4E2D",
    "agentTeam.toolLine.subagentPrefix": "\u5B50 agent\uFF1A",
  },
} as const;

export type AgentTeamKey = keyof typeof AGENT_TEAM_STRINGS["en"];

/** Resolve a slice-06 string for the current locale. */
export function tAgentTeam(locale: Locale, key: AgentTeamKey): string {
  const bucket =
    AGENT_TEAM_STRINGS[locale as "en" | "zh"] || AGENT_TEAM_STRINGS.en;
  return bucket[key] || key;
}
