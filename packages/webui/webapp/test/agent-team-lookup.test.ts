// webapp/test/agent-team-lookup.test.ts
// Unit tests for lib/agent-team-lookup.ts — the pure rule that picks the
// right `recentSubagents[]` entry for a tool block.
//
// Coverage contract (every line is a documented acceptance fix):
//
//   1. Two `→ task` lines in the same session must each jump to their
//      own child. The bug the previous slice shipped: every block took
//      `recent[last]`, so older tool lines jumped to the newest child.
//      The fix is to match by `toolCallId` (carried on the block by
//      the `##tc:` marker consumed by the decoder).
//
//   2. Non-subagent tool names (read / bash / write) return null even
//      when `recent` is non-empty.
//
//   3. Without a toolCallId (older chat, or a mid-stream attach race
//      where the marker landed before the runtime wrote the row),
//      fall back to the newest entry — pragmatic for legacy sessions.
//
//   4. An empty / nullish recent array returns null. A non-array
//      recent (defensive) returns null too.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { findSubagentForBlock, type ToolBlockLike } from "../lib/agent-team-lookup";
import type { RecentSubagent } from "../lib/types";

function recent(): RecentSubagent[] {
  return [
    {
      toolCallId: "tc_a",
      sessionId: "mvs_child_a",
      agentName: "explore",
      status: "done",
      createdAtMs: 1000,
      updatedAtMs: 1000,
    },
    {
      toolCallId: "tc_b",
      sessionId: "mvs_child_b",
      agentName: "verifier",
      status: "running",
      createdAtMs: 2000,
      updatedAtMs: 2000,
    },
    {
      toolCallId: "tc_c",
      sessionId: "mvs_child_c",
      agentName: "worker",
      status: "done",
      createdAtMs: 3000,
      updatedAtMs: 3000,
    },
  ];
}

function block(opts: ToolBlockLike): ToolBlockLike {
  return opts;
}

describe("findSubagentForBlock — the multi-dispatch correctness fix", () => {
  test("two → task lines each jump to their own child (the bug this fixes)", () => {
    // Reproduces the exact shape the agent team panel hits on every
    // multi-dispatch session. Each block asks "which subagent am I?"
    // and gets its OWN entry, not the newest one.
    const list = recent();
    const first = findSubagentForBlock(list, block({ toolName: "task", toolCallId: "tc_a" }));
    const second = findSubagentForBlock(list, block({ toolName: "task", toolCallId: "tc_b" }));
    const third = findSubagentForBlock(list, block({ toolName: "task", toolCallId: "tc_c" }));
    assert.equal(first?.sessionId, "mvs_child_a");
    assert.equal(second?.sessionId, "mvs_child_b");
    assert.equal(third?.sessionId, "mvs_child_c");
  });

  test("toolCallId matching wins over the newest entry (the regression guard)", () => {
    // The pre-fix behavior took `recent[last]` regardless of which
    // block was rendered. Without this test, a refactor that drops
    // the toolCallId gate would silently regress — every older tool
    // line would jump to the newest child.
    const list = recent();
    const out = findSubagentForBlock(list, block({ toolName: "task", toolCallId: "tc_a" }));
    assert.notEqual(out?.sessionId, "mvs_child_c", "must NOT take newest entry");
  });

  test("accepts the legacy 'delegate' / 'delegatetask' tool names too", () => {
    const list = recent();
    assert.equal(
      findSubagentForBlock(list, block({ toolName: "delegate", toolCallId: "tc_a" }))?.sessionId,
      "mvs_child_a",
    );
    assert.equal(
      findSubagentForBlock(list, block({ toolName: "delegatetask", toolCallId: "tc_a" }))?.sessionId,
      "mvs_child_a",
    );
  });

  test("matches case-insensitively against the legacy name variants", () => {
    const list = recent();
    assert.equal(
      findSubagentForBlock(list, block({ toolName: "TASK", toolCallId: "tc_a" }))?.sessionId,
      "mvs_child_a",
    );
  });

  test("ignores non-subagent tool names even when recent has entries", () => {
    const list = recent();
    assert.equal(findSubagentForBlock(list, block({ toolName: "read", toolCallId: "tc_a" })), null);
    assert.equal(findSubagentForBlock(list, block({ toolName: "bash", toolCallId: "tc_a" })), null);
    assert.equal(findSubagentForBlock(list, block({ toolName: "write", toolCallId: "tc_a" })), null);
  });

  test("ignores non-subagent tool names without a toolCallId too", () => {
    const list = recent();
    assert.equal(findSubagentForBlock(list, block({ toolName: "read" })), null);
  });

  test("empty / nullish recent array returns null without throwing", () => {
    assert.equal(findSubagentForBlock([], block({ toolName: "task", toolCallId: "tc" })), null);
    assert.equal(findSubagentForBlock(undefined, block({ toolName: "task", toolCallId: "tc" })), null);
    assert.equal(findSubagentForBlock(null as unknown as readonly RecentSubagent[], block({ toolName: "task", toolCallId: "tc" })), null);
  });

  test("missing toolCallId falls back to the newest entry (legacy chat compat)", () => {
    // Older chat predates the `##tc:` marker. The renderer must still
    // show SOME badge rather than drop the row, so the newest entry
    // is the documented fallback. This is the only path that lets the
    // pre-marker chat history render a usable badge at all.
    const list = recent();
    assert.equal(
      findSubagentForBlock(list, block({ toolName: "task" }))?.sessionId,
      "mvs_child_c",
    );
  });

  test("toolCallId present but no matching entry falls back to newest (mid-stream race)", () => {
    // The runtime sometimes writes the `##tc:` marker to chat BEFORE
    // it commits the `local_runtime_background_tasks` row, so the
    // marker has arrived but the polling-based refresh hasn't seen the
    // entry yet. Render the newest entry rather than nothing — the
    // user can still click; if the match eventually lands the badge
    // would change on the next tick. Pin this so a future change
    // cannot silently drop the badge.
    const list = recent();
    assert.equal(
      findSubagentForBlock(list, block({ toolName: "task", toolCallId: "tc_unknown" }))?.sessionId,
      "mvs_child_c",
    );
  });

  test("empty toolCallId string is treated as 'missing' (fall back to newest)", () => {
    const list = recent();
    assert.equal(
      findSubagentForBlock(list, block({ toolName: "task", toolCallId: "" }))?.sessionId,
      "mvs_child_c",
    );
  });
});
