// webui/test/lib/mcode-acp-tc-marker.test.js
// Regression for slice 06's `##tc:<toolCallId>` marker emission.
//
// What this locks. The marker is the contract that lets the chat
// renderer correlate a `→ name` block with the matching
// `recentSubagents[]` entry by id (matching by tool name would badge
// every `→ task` line with the newest child, which is wrong for
// sessions that spawn multiple subagents). Without the marker on
// the wire, the ToolCard falls back to the newest entry — which
// happened to be the bug the acceptance pass flagged.
//
// Coverage contract:
//   1. `applyToolUpdate` emits `##tc:<id>` immediately BEFORE the
//      `→ name` header on the synthetic-header path (no prior
//      tool_call).
//   2. `applyToolUpdate` does NOT re-emit the marker on subsequent
//      updates for the same toolCallId (the marker is paired with
//      the header, not with every body line).
//   3. `applyToolUpdate` does NOT emit the marker when a known
//      toolCallId is inserted after an existing header (the header
//      was already emitted by a prior tool_call, whose marker is
//      already in the chat).

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

const {
  applyToolUpdate,
} = await import("../../server/lib/mcode-acp.js");
const { getMcodeAcpClient, shutdownMcodeAcpSingleton } = await import(
  "../../server/lib/acp-client.js"
);

// Tear down the ACP singleton so the test process exits (same pattern
// as mcode-acp-note.test.js).
after(async () => {
  try {
    await getMcodeAcpClient();
  } catch {
    /* engine never started */
  }
  try {
    shutdownMcodeAcpSingleton();
  } catch {
    /* nothing was started */
  }
  await new Promise((r) => setTimeout(r, 50));
});

describe("applyToolUpdate — emits ##tc:<id> marker for slice 06 correlation", () => {
  test("emits the marker BEFORE the synthetic → name header", () => {
    const cs = { chat: ["› hi"] };
    const r = {};
    applyToolUpdate(r, cs, {
      toolCallId: "tc-marker-1",
      title: "task",
      status: "in_progress",
    });
    // The marker must come immediately before the header (so the
    // decoder can park it and attach to the next tool block).
    assert.equal(cs.chat[0], "› hi");
    assert.equal(cs.chat[1], "##tc:tc-marker-1");
    assert.equal(cs.chat[2], "→ task");
    assert.equal(cs.chat[3], "  [in_progress]");
    // toolIndexById points at the header (the marker is consumed by
    // the decoder; it's not a position the server tracks separately).
    assert.equal(r.toolIndexById.get("tc-marker-1"), 2);
  });

  test("does NOT re-emit the marker on subsequent updates for the same id", () => {
    const cs = { chat: [] };
    const r = {};
    applyToolUpdate(r, cs, { toolCallId: "tc-reuse", title: "task", status: "in_progress" });
    applyToolUpdate(r, cs, { toolCallId: "tc-reuse", status: "completed" });
    // One marker, one header, then bodies. The marker would never
    // appear again — subsequent body lines splice after the header.
    const markerCount = cs.chat.filter((line) => line === "##tc:tc-reuse").length;
    assert.equal(markerCount, 1, "marker must emit exactly once per dispatch");
  });

  test("does NOT emit a marker when inserting into an existing header", () => {
    // Simulate a prior tool_call that already wrote the marker.
    // applyToolUpdate's insert-after-existing path must not duplicate.
    const cs = { chat: ["##tc:tc-known", "→ task  {}", "  [in_progress]"] };
    const r = {
      toolIndexById: new Map([["tc-known", 1]]),
    };
    applyToolUpdate(r, cs, { toolCallId: "tc-known", status: "completed" });
    // No new marker line; the body splices after the existing header.
    const markerCount = cs.chat.filter((line) => line === "##tc:tc-known").length;
    assert.equal(markerCount, 1, "marker must NOT duplicate on insert-after");
  });

  test("omits the marker when toolCallId is absent (older engine contract)", () => {
    const cs = { chat: [] };
    const r = {};
    applyToolUpdate(r, cs, {
      // no toolCallId on purpose — older engines do not stamp one.
      title: "task",
      status: "in_progress",
    });
    // The marker is conditional on a toolCallId existing; without
    // one, the header still lands but with no marker so the decoder
    // falls back to the newest-entry lookup (lib/agent-team-lookup).
    assert.equal(cs.chat[0], "→ task");
    assert.equal(
      cs.chat.some((line) => line.startsWith("##tc:")),
      false,
    );
  });
});
