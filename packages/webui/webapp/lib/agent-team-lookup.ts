// webapp/lib/agent-team-lookup.ts
// Pure lookup helper: pick the right `recentSubagents[]` entry for a tool
// block the renderer is about to badge.
//
// Why this lives in its own module. The renderer (`ToolCard`) used to
// inline the rule: take `recent[recent.length - 1]` and call it a day.
// That works for a session that spawned exactly one subagent, but a
// normal Agent Team session spawns many (one per dispatched tool_call),
// and the rule was badge-with-the-newest regardless of which block is
// being rendered — clicking an older `→ task` line then jumped to the
// wrong subagent. The dispatch brief flags this as a correctness bug.
//
// The fix is to match by `toolCallId` (the decoder attaches it to the
// block via a `##tc:<id>` marker emitted by `applyToolUpdate`). When
// the marker is missing — older chat written before this slice shipped
// — we fall back to the newest entry with a matching agent name, so
// legacy sessions still render a usable badge.
//
// The rule is exported as a pure function so a unit test can pin both
// paths (marker present → exact match, marker absent → newest fallback)
// without a DOM, an EventSource, or a real runtime db.

import type { RecentSubagent } from "./types";

/**
 * The kind of tool the renderer is asking about. We accept the
 * `block`-shaped input rather than the bare toolCallId so callers do
 * not have to recompute the toolName gate at every site.
 */
export interface ToolBlockLike {
  toolName?: string;
  toolCallId?: string;
}

/**
 * Pick the `recentSubagents[]` entry that matches a given tool block.
 *
 * @returns the matching entry, or null when the tool name is not a
 *   subagent dispatch OR no entry exists.
 *
 * Rules:
 *   1. Non-subagent tool names return null (read / bash / write never
 *      have a child session to jump to).
 *   2. With a `toolCallId` on the block, match exactly. This is the
 *      primary path — it lets two `→ task` lines in the same session
 *      each jump to their own child.
 *   3. Without a `toolCallId` (older chat, or a tool_call whose id
 *      never reached the marker), fall back to the newest entry —
 *      pragmatic for legacy sessions; the slice 06 marker is the
 *      durable contract going forward.
 */
export function findSubagentForBlock(
  recent: readonly RecentSubagent[] | undefined,
  block: ToolBlockLike,
): RecentSubagent | null {
  if (!Array.isArray(recent) || recent.length === 0) return null;
  const name = String(block.toolName || "").toLowerCase().replace(/[^a-z]/g, "");
  // Accept 'task' (canonical) and the legacy 'delegate' / 'delegatetask'
  // variants the engine has emitted in the wild.
  if (name !== "task" && name !== "delegate" && name !== "delegatetask") return null;
  if (block.toolCallId) {
    const match = recent.find((r) => r && r.toolCallId === block.toolCallId);
    if (match) return match;
    // toolCallId present but no matching recentSubagents entry: a
    // mid-stream attach race where the marker landed in chat before
    // the runtime wrote the background_tasks row. Fall back to the
    // newest entry rather than render nothing — the run-mirror run
    // is visible regardless, and the badge surfaces a hint that the
    // match will resolve when the poller next tick fires.
  }
  return recent[recent.length - 1] || null;
}
