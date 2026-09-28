// webapp/test/transcript-tool-paths.test.ts
// Slice 20 (webui-parity) — regression for the chip row wiring.
//
// A real-shape transcript fixture is built and decoded; the
// `TranscriptBlock.toolPaths` value is the only signal the ToolCard
// uses to render chips. Before this slice the value was always empty
// in real sessions (the engine does not emit `tool_update.locations`,
// verified against the runtime sqlite: 0 of 7,609 tool calls).
//
// All file paths in this fixture are obviously fake — the engine's
// actual data carries real user paths that must never appear in a
// test (a previous slice tripped gitleaks and needed a history
// rewrite). The arg shapes ARE real (taken verbatim from the
// `local_runtime_message_rows.data_json` in the engine's sqlite),
// so a regression here means a real-world regression.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decodeTranscript, type TranscriptBlock } from "../lib/transcript";

/** First tool block matching `name`, or fail loudly. */
function pickTool(blocks: TranscriptBlock[], name: string): TranscriptBlock {
  const found = blocks.find((b) => b.role === "tool" && b.toolName === name);
  if (!found) {
    const seen = blocks.filter((b) => b.role === "tool").map((b) => b.toolName);
    throw new Error(
      `expected a tool block named ${JSON.stringify(name)}; saw ${JSON.stringify(seen)}`,
    );
  }
  return found;
}

const WS = "/home/example/proj";

/**
 * Realistic transcript reconstructed from the engine's wire grammar
 * (`server/lib/mcode-acp.js#streamAcpPrompt` + `applyToolUpdate`,
 * `server/lib/transcript.js#messagesToChatLines`). Every tool shape
 * here was sampled from the runtime sqlite; the paths are fake.
 */
function realisticChat(): string[] {
  return [
    "› read the file foo.ts and rewrite the helper",
    "● let me look at the helper first, then rewrite it.",
    "##tc:tc-001",
    `→ read  ${JSON.stringify({ path: `${WS}/src/foo.ts` })}`,
    "  [completed]",
    "  // rest of fake TS",
    "##tc:tc-002",
    `→ edit  ${JSON.stringify({
      file_path: `${WS}/src/foo.ts`,
      old_string: "function old() { return 1; }",
      new_string: "function next() { return 2; }",
    })}`,
    "  [completed]",
    "  edited",
    "##tc:tc-003",
    `→ write  ${JSON.stringify({
      path: `${WS}/src/new.ts`,
      content: "// new file",
    })}`,
    "  [completed]",
    "##tc:tc-004",
    `→ grep  ${JSON.stringify({
      pattern: "search-term",
      path: `${WS}/src`,
      output_mode: "content",
    })}`,
    "  [completed]",
    "  src/foo.ts:1: function old() { return 1; }",
    "##tc:tc-005",
    `→ glob  ${JSON.stringify({ pattern: "**/*.tsx" })}`,
    "  [completed]",
    "##tc:tc-006",
    `→ bash  ${JSON.stringify({
      command: `cat ${WS}/src/foo.ts && ls ${WS}/src`,
    })}`,
    "  [completed]",
    "##tc:tc-007",
    `→ read  ${JSON.stringify({ path: "src/relative.ts" })}`,
    "  [completed]",
  ];
}

describe("decodeTranscript — slice 20 chip wiring (real-shape fixture)", () => {
  test("read populates toolPaths from `path`", () => {
    const blocks = decodeTranscript(realisticChat(), { workspaceDir: WS });
    const r = pickTool(blocks, "read");
    // `r` may be one of two read blocks; we only assert the first.
    assert.ok(
      r.toolPaths?.includes(`${WS}/src/foo.ts`),
      `expected ${WS}/src/foo.ts in toolPaths, got ${JSON.stringify(r.toolPaths)}`,
    );
  });

  test("edit populates toolPaths from `file_path`", () => {
    const blocks = decodeTranscript(realisticChat(), { workspaceDir: WS });
    const e = pickTool(blocks, "edit");
    assert.ok(
      e.toolPaths?.includes(`${WS}/src/foo.ts`),
      `expected ${WS}/src/foo.ts in edit.toolPaths, got ${JSON.stringify(e.toolPaths)}`,
    );
  });

  test("write populates toolPaths from `path`", () => {
    const blocks = decodeTranscript(realisticChat(), { workspaceDir: WS });
    const w = pickTool(blocks, "write");
    assert.ok(
      w.toolPaths?.includes(`${WS}/src/new.ts`),
      `expected ${WS}/src/new.ts in write.toolPaths, got ${JSON.stringify(w.toolPaths)}`,
    );
  });

  test("grep surfaces the search SCOPE (path), never the pattern", () => {
    const blocks = decodeTranscript(realisticChat(), { workspaceDir: WS });
    const g = pickTool(blocks, "grep");
    assert.deepEqual(g.toolPaths, [`${WS}/src`]);
    // The pattern itself must never appear as a chip.
    for (const p of g.toolPaths ?? []) {
      assert.ok(
        !p.includes("search-term"),
        `grep must not surface the pattern as a chip; saw ${p}`,
      );
    }
  });

  test("glob yields NO chips (pattern is a scope, not a file)", () => {
    const blocks = decodeTranscript(realisticChat(), { workspaceDir: WS });
    const gl = pickTool(blocks, "glob");
    assert.deepEqual(gl.toolPaths, [], "glob must not produce any chip");
  });

  test("bash yields NO chips (no path field; command is not regex-mined)", () => {
    const blocks = decodeTranscript(realisticChat(), { workspaceDir: WS });
    const b = pickTool(blocks, "bash");
    assert.deepEqual(b.toolPaths, [], "bash must not produce any chip");
  });

  test("a relative read path is absolutised against the workspace dir", () => {
    const blocks = decodeTranscript(realisticChat(), { workspaceDir: WS });
    const reads = blocks.filter((b) => b.role === "tool" && b.toolName === "read");
    // Two reads in the fixture: an absolute one and a relative one.
    assert.equal(reads.length, 2);
    const relativeRead = reads.find((r) =>
      r.toolPaths?.some((p) => p === `${WS}/src/relative.ts`),
    );
    assert.ok(relativeRead, "relative `src/relative.ts` must be absolutised to /ws/src/relative.ts");
  });
});

describe("decodeTranscript — `@ path` body lines still merge cleanly", () => {
  /**
   * The engine does not emit `locations` today, but the slice-12 wire
   * contract stays in place. A transcript where the server DID write
   * `  @ /abs/foo` must still produce a chip (forward-compat) AND
   * merge dedupe with anything the args extractor derived.
   */
  test("`@ path` body lines populate toolPaths when the engine emits them", () => {
    const blocks = decodeTranscript(
      [
        "##tc:tc-100",
        `→ read  ${JSON.stringify({ path: "/abs/from-args.ts" })}`,
        "  [completed]",
        "  @ /abs/from-at.ts",
      ],
      { workspaceDir: WS },
    );
    const r = pickTool(blocks, "read");
    // Order: `  @ path` body lines arrive first in the decoder, then
    // the args-derived paths; the merge keeps first-seen order. Both
    // sources are deduped against the normalised key.
    assert.deepEqual(r.toolPaths, ["/abs/from-at.ts", "/abs/from-args.ts"]);
  });

  test("`@ path` and args-deduped when both describe the same file", () => {
    const blocks = decodeTranscript(
      [
        "##tc:tc-101",
        `→ read  ${JSON.stringify({ path: "/abs/same.ts" })}`,
        "  [completed]",
        "  @ /abs/same.ts",
      ],
      { workspaceDir: WS },
    );
    const r = pickTool(blocks, "read");
    assert.deepEqual(r.toolPaths, ["/abs/same.ts"]);
  });

  test("a relative `  @ src/x.ts` is absolutised by normalisePath too", () => {
    const blocks = decodeTranscript(
      [
        "##tc:tc-102",
        `→ read  ${JSON.stringify({ path: "src/x.ts" })}`,
        "  [completed]",
        "  @ src/y.ts",
      ],
      { workspaceDir: WS },
    );
    const r = pickTool(blocks, "read");
    // The `@ path` source carries the (empty) body loop result first,
    // so the merged order matches the decoder's append order:
    // `@ src/y.ts` is added while walking the body, then the
    // args-derived `src/x.ts` lands next.
    assert.deepEqual(r.toolPaths, [`${WS}/src/y.ts`, `${WS}/src/x.ts`]);
  });
});

describe("decodeTranscript — no workspace dir leaves relative paths relative", () => {
  test("relative paths stay relative when workspaceDir is omitted", () => {
    const blocks = decodeTranscript(
      [`→ read  ${JSON.stringify({ path: "src/foo.ts" })}`],
      { workspaceDir: null },
    );
    const r = pickTool(blocks, "read");
    assert.deepEqual(r.toolPaths, ["src/foo.ts"]);
  });

  test("absolute paths still absolutise (workspace is irrelevant)", () => {
    const blocks = decodeTranscript(
      [`→ read  ${JSON.stringify({ path: "/abs/foo.ts" })}`],
      { workspaceDir: null },
    );
    const r = pickTool(blocks, "read");
    assert.deepEqual(r.toolPaths, ["/abs/foo.ts"]);
  });
});

describe("decodeTranscript — malformed args never crash the decoder", () => {
  test("a tool with non-JSON args still decodes", () => {
    const blocks = decodeTranscript([
      "→ read  {not valid json",
      "  [completed]",
    ]);
    // The block exists, has no paths, did not throw.
    const r = pickTool(blocks, "read");
    assert.deepEqual(r.toolPaths, []);
  });

  test("a tool with no args at all still decodes", () => {
    const blocks = decodeTranscript(["→ read", "  [completed]"]);
    const r = pickTool(blocks, "read");
    assert.deepEqual(r.toolPaths, []);
  });
});