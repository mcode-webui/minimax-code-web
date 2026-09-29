// webapp/test/tool-projection.test.ts
//
// Table-driven tests for the tool-card projection layer (ticket 46,
// PR3 — D4). Everything here drives `lib/tool-projection.ts` directly:
// the five-state normaliser (string spellings AND Desktop's numeric
// codes), the bilingual label table (zh column = the reference desktop
// copy), the read-style resource-path parser, and the 2000-character
// detail clamp. The render-side assertions live in
// activity-group.test.ts; this suite pins the derivations themselves.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  TOOL_DETAIL_CHAR_LIMIT,
  TOOL_STATUS_LABEL_KEY,
  clampDetailText,
  normalizeToolStatus,
  resourceDisplayName,
  toolCallLabel,
  toolResourcePath,
  toolSummaryResourcePath,
} from "../lib/tool-projection";

describe("normalizeToolStatus — wire strings", () => {
  test("maps the three statuses the wire actually writes", () => {
    assert.equal(normalizeToolStatus("completed"), "completed");
    assert.equal(normalizeToolStatus("failed"), "error");
    assert.equal(normalizeToolStatus("in_progress"), "running");
  });

  test("no status line yet means the call is in flight", () => {
    // The wire writes the `→ name` header first and the `[status]` line
    // only when the call settles — undefined IS running here (the
    // reference maps it to unknown because its records always carry an
    // explicit status field; see the module docblock).
    assert.equal(normalizeToolStatus(undefined), "running");
    assert.equal(normalizeToolStatus(null), "running");
    assert.equal(normalizeToolStatus(""), "running");
  });

  test("accepts the reference runtime's alternative spellings", () => {
    assert.equal(normalizeToolStatus("pending"), "pending");
    assert.equal(normalizeToolStatus("queued"), "pending");
    assert.equal(normalizeToolStatus("running"), "running");
    assert.equal(normalizeToolStatus("in-progress"), "running");
    assert.equal(normalizeToolStatus("done"), "completed");
    assert.equal(normalizeToolStatus("success"), "completed");
    assert.equal(normalizeToolStatus("succeeded"), "completed");
    assert.equal(normalizeToolStatus("error"), "error");
    assert.equal(normalizeToolStatus("cancelled"), "cancelled");
    assert.equal(normalizeToolStatus("canceled"), "cancelled");
    assert.equal(normalizeToolStatus("interrupted"), "cancelled");
  });

  test("case and surrounding whitespace are normalised", () => {
    assert.equal(normalizeToolStatus("  FAILED "), "error");
    assert.equal(normalizeToolStatus("Completed"), "completed");
  });

  test("an unrecognised string is unknown, never a guess", () => {
    assert.equal(normalizeToolStatus("warp"), "unknown");
  });
});

describe("normalizeToolStatus — Desktop numeric codes", () => {
  // Desktop's formatter maps Start/Finished/Failed explicitly and falls
  // back to pending for Preparing/Prepared; the wire never sends these
  // today, the normaliser keeps the table for parity.
  const cases: ReadonlyArray<[number, string]> = [
    [1, "running"],
    [2, "completed"],
    [3, "error"],
    [4, "pending"],
    [5, "pending"],
  ];
  for (const [code, expected] of cases) {
    test(`code ${code} → ${expected}`, () => {
      assert.equal(normalizeToolStatus(code), expected);
    });
  }

  test("any other number is unknown", () => {
    assert.equal(normalizeToolStatus(0), "unknown");
    assert.equal(normalizeToolStatus(6), "unknown");
    assert.equal(normalizeToolStatus(1.5), "unknown");
  });
});

describe("TOOL_STATUS_LABEL_KEY — all five states are covered", () => {
  test("every labelled state has a key and they are distinct", () => {
    const keys = Object.values(TOOL_STATUS_LABEL_KEY);
    assert.equal(keys.length, 5);
    assert.equal(new Set(keys).size, 5);
  });
});

describe("toolCallLabel — bilingual human labels", () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ["bash", "终端", "Terminal"],
    ["read", "读取文件", "Read file"],
    ["read_file", "读取文件", "Read file"],
    ["edit", "编辑文件", "Edit file"],
    ["str_replace", "编辑文件", "Edit file"],
    ["write", "写入文件", "Write file"],
    ["grep", "搜索", "Search"],
    ["glob", "查找文件", "Find files"],
    ["web_search", "网页搜索", "Web search"],
    ["task", "任务", "Task"],
    ["todowrite", "todowrite", "TodoWrite"],
  ];
  for (const [name, zh, en] of cases) {
    test(`${name} → ${zh} / ${en}`, () => {
      assert.equal(toolCallLabel(name, "zh"), zh);
      assert.equal(toolCallLabel(name, "en"), en);
    });
  }

  test("names are trimmed and lower-cased before the lookup", () => {
    assert.equal(toolCallLabel("  Bash ", "zh"), "终端");
    assert.equal(toolCallLabel("READ", "en"), "Read file");
  });

  test("an unknown name falls back to 「工具 / Tool」 like the reference", () => {
    assert.equal(toolCallLabel("mystery_tool", "zh"), "工具");
    assert.equal(toolCallLabel("mystery_tool", "en"), "Tool");
    assert.equal(toolCallLabel(undefined, "zh"), "工具");
  });
});

describe("toolResourcePath — read-style calls lift their path", () => {
  test("JSON object args with the common key spellings", () => {
    assert.equal(
      toolResourcePath("read", '{"file_path": "/ws/a.ts"}'),
      "/ws/a.ts",
    );
    assert.equal(
      toolResourcePath("read_file", '{"filePath": "/ws/a.ts"}'),
      "/ws/a.ts",
    );
    assert.equal(
      toolResourcePath("read", '{"path": "src/a.ts"}'),
      "src/a.ts",
    );
    assert.equal(
      toolResourcePath("read", '{"location": "/tmp/x"}'),
      "/tmp/x",
    );
  });

  test("a bare JSON string or a plain path string", () => {
    assert.equal(toolResourcePath("read", '"/ws/notes.md"'), "/ws/notes.md");
    assert.equal(toolResourcePath("read", "/ws/notes.md"), "/ws/notes.md");
  });

  test("non-read tools never expose a resource path", () => {
    assert.equal(
      toolResourcePath("edit", '{"file_path": "/ws/a.ts"}'),
      undefined,
    );
    assert.equal(toolResourcePath("bash", '{"path": "/ws"}'), undefined);
  });

  test("unusable payloads return undefined", () => {
    assert.equal(toolResourcePath("read", ""), undefined);
    assert.equal(toolResourcePath("read", undefined), undefined);
    assert.equal(toolResourcePath("read", "[]"), undefined);
    assert.equal(toolResourcePath("read", '{"command": "ls"}'), undefined);
  });

  test("resourceDisplayName keeps only the last segment", () => {
    assert.equal(resourceDisplayName("/ws/packages/a.ts"), "a.ts");
    assert.equal(resourceDisplayName("a.ts"), "a.ts");
    assert.equal(resourceDisplayName("C:\\ws\\a.ts"), "a.ts");
    // A trailing separator drops the empty segment — the directory name
    // is the display form.
    assert.equal(resourceDisplayName("/ws/"), "ws");
  });

  test("toolSummaryResourcePath falls back to the collected paths", () => {
    // Live-verified wire shape: the engine's `→ read` header carries no
    // args; the path arrives as a `@ path` body line the decoder
    // collects into toolPaths. The args derivation still wins when
    // present.
    assert.equal(
      toolSummaryResourcePath("read", "", ["/ws/lib/a.ts"]),
      "/ws/lib/a.ts",
    );
    assert.equal(
      toolSummaryResourcePath("read", '{"file_path":"/ws/args.ts"}', ["/ws/other.ts"]),
      "/ws/args.ts",
    );
    assert.equal(toolSummaryResourcePath("read", undefined, []), undefined);
    // Non-read tools never lift a path, even with paths collected.
    assert.equal(
      toolSummaryResourcePath("edit", "", ["/ws/a.ts"]),
      undefined,
    );
    assert.equal(
      toolSummaryResourcePath("bash", "", ["/ws/out.txt"]),
      undefined,
    );
  });
});

describe("clampDetailText — the 2000-character body clamp", () => {
  test("at and under the limit the value passes through untouched", () => {
    assert.equal(clampDetailText("x".repeat(2000)), "x".repeat(2000));
    assert.equal(clampDetailText("x".repeat(1999)), "x".repeat(1999));
    assert.equal(clampDetailText(""), "");
  });

  test("over the limit the body is cut and suffixed with ...", () => {
    const value = "y".repeat(2001);
    const clamped = clampDetailText(value);
    assert.equal(clamped.length, 2003); // 2000 chars + "..."
    assert.ok(clamped.startsWith("y".repeat(2000)));
    assert.ok(clamped.endsWith("..."));
  });

  test("the limit is the exported reference constant", () => {
    assert.equal(TOOL_DETAIL_CHAR_LIMIT, 2000);
  });
});
