// webapp/test/transcript.test.ts
// Unit tests for lib/transcript.ts — the decoder that turns the server's
// line-oriented transcript into typed blocks.
//
// Why this test exists: this module is the boundary between the ACP bridge and the
// UI. The server hands the frontend a flat array of glyph-prefixed strings (`› `
// user, `● ` assistant, `○ ` system, and so on) rather than structured messages, so
// every rendering decision depends on this decode. Getting a marker's precedence
// wrong silently reroutes a message into the wrong branch — for example `○` is both
// a todo glyph and the system-notice glyph, and the notice check has to win.
//
// Test strategy: the decoder is a pure function over string arrays, so no DOM is
// needed (same approach as webapp/test/chat-virtual-list.test.ts). These tests pin:
//   - one marker per role, and the merging of consecutive same-speaker lines
//   - the `○` / todo-vs-system precedence, which is the easiest thing to break
//   - the streaming cursor: stripped from the text and reported as state
//   - block sections (Plan / Ask / Goal) and where they end

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decodeTranscript, groupActivity, summarizeActivity } from "../lib/transcript";

describe("decodeTranscript — speakers", () => {
  test("user and assistant markers map to their roles", () => {
    const blocks = decodeTranscript(["› hello", "● hi there"]);
    assert.deepEqual(
      blocks.map((b) => [b.role, b.text]),
      [
        ["user", "hello"],
        ["assistant", "hi there"],
      ],
    );
  });

  test("consecutive lines from one speaker merge into a single block", () => {
    const blocks = decodeTranscript(["● first", "● second", "● third"]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.text, "first\nsecond\nthird");
  });

  test("a speaker change starts a new block", () => {
    const blocks = decodeTranscript(["● a", "› b", "● c"]);
    assert.deepEqual(
      blocks.map((b) => b.role),
      ["assistant", "user", "assistant"],
    );
  });

  test("`>` is accepted as a user marker alongside `›`", () => {
    assert.equal(decodeTranscript(["> alt"])[0]?.role, "user");
  });
});

describe("decodeTranscript — todo markers and the system-notice precedence", () => {
  test("each todo glyph maps to a state", () => {
    const blocks = decodeTranscript(["✓ done", "◌ doing", "✗ failed", "○ info"]);
    assert.deepEqual(
      blocks.map((b) => [b.role, b.todoState]),
      [
        ["todo", "done"],
        ["todo", "doing"],
        ["todo", "failed"],
        ["todo", "info"],
      ],
    );
  });

  test("`○` carrying a bracketed level is a system notice, not a todo", () => {
    // This is the precedence that matters: the todo branch must lose to the
    // system branch when the text reads like a notice, or warnings disappear
    // into the todo list.
    const blocks = decodeTranscript(["○ [error] it broke"]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.role, "system");
    assert.equal(blocks[0]?.text, "[error] it broke");
    assert.equal(blocks[0]?.todoState, undefined);
  });

  test("adjacent system notices merge into one block like any other speaker", () => {
    const blocks = decodeTranscript(["○ [info] one", "○ [info] two"]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.role, "system");
    assert.equal(blocks[0]?.text, "[info] one\n[info] two");
  });

  test("`○` mentioning a questionnaire is a system notice", () => {
    const blocks = decodeTranscript(["○ Questionnaire requires user input"]);
    assert.equal(blocks[0]?.role, "system");
  });
});

describe("decodeTranscript — streaming cursor", () => {
  test("a trailing cursor is stripped and reported as state", () => {
    const blocks = decodeTranscript(["● partial answer ▍"]);
    assert.equal(blocks[0]?.text, "partial answer");
    assert.equal(blocks[0]?.streaming, true);
  });

  test("the cursor is only read from the final assistant block", () => {
    const blocks = decodeTranscript(["● done ▍", "› and now a question"]);
    const first = blocks[0];
    assert.equal(first?.role, "assistant");
    assert.equal(first?.text, "done ▍", "inner cursor text is left untouched");
    assert.equal(first?.streaming, undefined);
  });

  test("a cursor inside a line is not treated as the streaming marker", () => {
    const blocks = decodeTranscript(["● inline ▍ not at end"]);
    assert.equal(blocks[0]?.streaming, undefined);
  });
});

describe("decodeTranscript — block sections", () => {
  test("a Plan heading opens a plan block and collects continuation lines", () => {
    const blocks = decodeTranscript(["Plan: rework the picker", "step one", "step two"]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.role, "plan");
    assert.match(blocks[0]?.text ?? "", /rework the picker/);
    assert.match(blocks[0]?.text ?? "", /step two/);
  });

  test("a plan block ends at the next marker", () => {
    const blocks = decodeTranscript(["Plan: x", "detail", "● implementation starts"]);
    assert.deepEqual(
      blocks.map((b) => b.role),
      ["plan", "assistant"],
    );
  });

  test("an Ask heading opens an ask block", () => {
    const blocks = decodeTranscript(["Ask: which database?", "1. sqlite", "2. postgres"]);
    assert.equal(blocks[0]?.role, "ask");
  });

  test("a goal heading opens a goal block", () => {
    const blocks = decodeTranscript(["◎ Goal: ship it", "keep going"]);
    assert.equal(blocks[0]?.role, "goal");
  });
});

describe("decodeTranscript — turn_process metadata marker", () => {
  test("attaches processedDuration to the preceding assistant block", () => {
    const blocks = decodeTranscript(["● hi there", "§§ processed_duration=1234ms"]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.role, "assistant");
    assert.equal(blocks[0]?.processedDuration, 1234);
    assert.equal(blocks[0]?.text, "hi there");
  });

  test("marker without explicit `ms` suffix is still recognised", () => {
    const blocks = decodeTranscript(["● hi", "§§ processed_duration=250"]);
    assert.equal(blocks[0]?.processedDuration, 250);
  });

  test("marker attaches to the open assistant block before flushing", () => {
    const blocks = decodeTranscript([
      "● first",
      "● continuation",
      "§§ processed_duration=900ms",
    ]);
    assert.equal(blocks.length, 1, "consecutive ● lines merge");
    assert.equal(blocks[0]?.processedDuration, 900);
    assert.match(blocks[0]?.text ?? "", /continuation/);
  });

  test("marker attaches to the most recent assistant block when current is not assistant", () => {
    const blocks = decodeTranscript([
      "● hi",
      "› follow-up question",
      "§§ processed_duration=800ms",
    ]);
    const last = blocks[blocks.length - 1];
    assert.equal(last?.role, "user");
    const assistant = blocks.find((b) => b.role === "assistant");
    assert.equal(assistant?.processedDuration, 800);
  });

  test("marker with non-numeric value is dropped silently", () => {
    const blocks = decodeTranscript(["● hi", "§§ processed_duration=oops"]);
    assert.equal(blocks[0]?.processedDuration, undefined);
  });

  test("marker does not become visible content", () => {
    const blocks = decodeTranscript(["● hi", "§§ processed_duration=42ms", "› user again"]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]?.role, "assistant");
    assert.equal(blocks[1]?.role, "user");
    assert.equal(blocks[0]?.text, "hi");
  });
});

describe("decodeTranscript — robustness", () => {
  test("empty input yields no blocks", () => {
    assert.deepEqual(decodeTranscript([]), []);
  });

  test("blank lines are skipped rather than opening a block", () => {
    assert.deepEqual(decodeTranscript(["", "  ", ""]), []);
  });

  test("unmarked text with no open block becomes a system block", () => {
    const blocks = decodeTranscript(["plain text with no marker"]);
    assert.equal(blocks[0]?.role, "system");
  });

  test("unmarked text continues the open block", () => {
    const blocks = decodeTranscript(["● start", "  indented continuation"]);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0]?.text ?? "", /indented continuation/);
  });

  // Regression (defect #1, transcript side): orphan tool-body lines — two-space
  // indented protocol lines with no preceding `→ name` header — were being
  // misclassified as `system` blocks because the fall-through branch had no
  // carve-out for the tool-body shape. The transcript shape below is the
  // exact layout the user saw in their webui: a tool whose `tool_call`
  // header never arrived, so `applyToolUpdate` appended these lines without
  // a `→ name` owner.
  test("orphan tool-body lines do NOT become a system block", () => {
    const lines = [
      "  [in_progress]",
      "  [in_progress]",
      "  [completed]",
      "  [completed]",
      "  @ /home/<user>/.agents/rule.md",
      "  @ /home/<user>/.agents/rule.md",
    ];
    const blocks = decodeTranscript(lines);
    assert.equal(blocks.length, 0, "orphan tool-body lines must be dropped, not fabricated into a system block");
    assert.ok(
      !blocks.some((b) => b.role === "system"),
      "no transcript row must claim the protocol text",
    );
  });

  // Defensive carve-out still drops orphan tool-body lines even after a
  // preceding speaker block was open — the body lines have no owner and
  // should not be appended to an unrelated block either.
  test("orphan tool-body lines after a speaker block are dropped, not appended", () => {
    const blocks = decodeTranscript([
      "● answer text",
      "  [completed]",
    ]);
    const assistant = blocks.find((b) => b.role === "assistant");
    assert.ok(assistant, "the assistant block must still exist");
    assert.equal(
      assistant?.text,
      "answer text",
      "the orphan tool-body line must not be appended to the assistant block",
    );
    assert.ok(
      !blocks.some((b) => b.role === "system" || b.role === "tool"),
      "no tool/system block must be fabricated",
    );
  });
});

describe("decodeTranscript — thinking and tool calls", () => {
  // Contract change (desktop parity): one thought is one block. The grammar emits
  // one entry per output line, so consecutive `▲` lines used to become separate
  // blocks — the desktop renders one ThinkingBlock per thought, and the activity
  // summary counts runs (see `summarizeActivity`), so merging loses nothing.
  test("`▲` accumulates consecutive lines into a single thought", () => {
    const blocks = decodeTranscript(["▲ first thought", "▲ second thought"]);
    assert.deepEqual(
      blocks.map((b) => [b.role, b.text]),
      [["thinking", "first thought\nsecond thought"]],
    );
  });

  test("a tool call between two thoughts keeps them apart", () => {
    const blocks = decodeTranscript(["▲ first", "→ Bash  {}", "▲ second"]);
    assert.deepEqual(
      blocks.map((b) => [b.role, b.text]),
      [
        ["thinking", "first"],
        ["tool", "→ Bash  {}"],
        ["thinking", "second"],
      ],
    );
  });

  test("a tool header carries its name and arguments", () => {
    const blocks = decodeTranscript(['→ Bash  {"command":"ls"}']);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.role, "tool");
    assert.equal(blocks[0]?.toolName, "Bash");
    assert.equal(blocks[0]?.toolArgs, '{"command":"ls"}');
  });

  test("a header with no arguments yields an empty args string", () => {
    const blocks = decodeTranscript(["→ Read"]);
    assert.equal(blocks[0]?.toolName, "Read");
    assert.equal(blocks[0]?.toolArgs, "");
  });

  test("the indented body is split into status, output and paths", () => {
    // This is the exact layout server/lib/mcode-acp.js writes: the header, then
    // `  [status]`, then the output lines and `  @ path` entries, all indented.
    const blocks = decodeTranscript([
      "→ Read  {\"path\":\"a.ts\"}",
      "  [completed]",
      "  line one of output",
      "  line two of output",
      "  @ /tmp/a.ts",
      "● done",
    ]);
    const tool = blocks[0];
    assert.equal(tool?.role, "tool");
    assert.equal(tool?.toolStatus, "completed");
    assert.deepEqual(tool?.toolOutput, ["line one of output", "line two of output"]);
    assert.deepEqual(tool?.toolPaths, ["/tmp/a.ts"]);
    assert.equal(blocks[1]?.role, "assistant", "the body must not swallow the next line");
  });

  test("a tool with no body leaves output empty", () => {
    const blocks = decodeTranscript(["→ Bash  {}", "● next"]);
    assert.deepEqual(blocks[0]?.toolOutput, []);
    assert.equal(blocks[0]?.toolStatus, undefined);
    assert.equal(blocks[1]?.role, "assistant");
  });

  test("a failed tool keeps its status", () => {
    const blocks = decodeTranscript(["→ Bash  {}", "  [failed]"]);
    assert.equal(blocks[0]?.toolStatus, "failed");
  });
});

describe("summarizeActivity — counting thoughts, not lines", () => {
  // The grammar emits one block per output line, so the block count used to
  // overstate the work: a thought spanning n lines read as "思考 n 次".
  const thinking = (text: string) => ({ role: "thinking" as const, text });
  const tool = (name: string, status?: string) => ({
    role: "tool" as const,
    text: `→ ${name} {}`,
    toolName: name,
    toolArgs: "{}",
    toolOutput: [],
    toolPaths: [],
    ...(status ? { toolStatus: status } : {}),
  });
  const assistant = (text: string) => ({ role: "assistant" as const, text });

  test("counts an unbroken run of thinking lines as one thought", () => {
    const summary = summarizeActivity([thinking("a"), thinking("b"), thinking("c")]);
    assert.deepEqual(summary, {
      thinking: 1,
      tools: 0,
      contributions: [{ category: "thinking", count: 1, iconType: "thinking" }],
      iconType: "thinking",
    });
  });

  test("counts a second run, split by a tool call, as a second thought", () => {
    const summary = summarizeActivity([
      thinking("a"),
      thinking("b"),
      tool("bash", "completed"),
      thinking("c"),
    ]);
    assert.equal(summary.thinking, 2);
    assert.equal(summary.tools, 1);
  });

  test("counts each tool block once and ignores prose", () => {
    const summary = summarizeActivity([
      tool("bash", "completed"),
      assistant("done"),
      tool("read", "completed"),
    ]);
    assert.equal(summary.thinking, 0);
    assert.equal(summary.tools, 2);
  });

  test("is zero for an empty run", () => {
    assert.deepEqual(summarizeActivity([]), { thinking: 0, tools: 0, contributions: [], iconType: "tool" });
  });

  test("groups tools into upstream's categories, ordered by priority", () => {
    const summary = summarizeActivity([
      tool("bash", "completed"),
      tool("bash", "completed"),
      tool("read", "completed"),
      tool("edit", "completed"),
    ]);
    // Upstream order is plugin, file-edit, agent, skill, web, thinking, file,
    // command, tool — so file-edit precedes file, which precedes command.
    assert.deepEqual(summary.contributions, [
      { category: "file-edit", count: 1, iconType: "edit" },
      { category: "file", count: 1, iconType: "file" },
      { category: "command", count: 2, iconType: "command" },
    ]);
  });

  test("caps the contribution list at upstream's maxCategories", () => {
    const summary = summarizeActivity([
      tool("read", "completed"),
      tool("edit", "completed"),
      tool("bash", "completed"),
      tool("web_search", "completed"),
      tool("task", "completed"),
      tool("skill", "completed"),
    ]);
    assert.equal(summary.contributions.length, 3);
    assert.deepEqual(
      summary.contributions.map((c) => c.category),
      ["file-edit", "agent", "skill"],
    );
  });

  test("an unrecognised tool falls back to the generic tool category", () => {
    const summary = summarizeActivity([tool("some_future_tool", "completed")]);
    assert.deepEqual(summary.contributions, [{ category: "tool", count: 1, iconType: "tool" }]);
  });

  test("reports the in-flight tool, ignoring ones that already finished", () => {
    const done = summarizeActivity([tool("bash", "completed")]);
    assert.equal(done.activeTool, undefined);
    const running = summarizeActivity([tool("bash", "completed"), tool("edit")]);
    assert.equal(running.activeTool, "edit");
  });
});

describe("groupActivity — folding runs into one unit", () => {
  test("summary counts thinking entries and tool calls", () => {
    const blocks = decodeTranscript([
      "▲ one",
      "→ Bash  {}",
      "  [completed]",
      "▲ two",
      "→ Read  {}",
      "● the answer",
    ]);
    const units = groupActivity(blocks);
    assert.equal(units.length, 2);
    const first = units[0];
    assert.equal(first?.kind, "activity");
    if (first?.kind === "activity") {
      // `Bash` / `Read` are matched case-insensitively, so these land in the
      // command and file categories rather than the generic tool bucket.
      assert.deepEqual(first.summary, {
        thinking: 2,
        tools: 2,
        activeTool: "Read",
        iconType: "file",
        contributions: [
          { category: "thinking", count: 2, iconType: "thinking" },
          { category: "file", count: 1, iconType: "file" },
          { category: "command", count: 1, iconType: "command" },
        ],
      });
      assert.equal(first.blocks.length, 4);
    }
    assert.equal(units[1]?.kind, "block");
  });

  test("text between runs breaks the group", () => {
    const blocks = decodeTranscript(["▲ one", "● mid", "▲ two", "● end"]);
    const units = groupActivity(blocks);
    assert.deepEqual(
      units.map((u) => u.kind),
      ["activity", "block", "activity", "block"],
    );
  });

  test("a transcript with no activity has no activity units", () => {
    const units = groupActivity(decodeTranscript(["› hi", "● there"]));
    assert.deepEqual(
      units.map((u) => u.kind),
      ["block", "block"],
    );
  });

  test("an empty transcript yields no units", () => {
    assert.deepEqual(groupActivity([]), []);
  });
});
