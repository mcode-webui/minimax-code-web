// webapp/test/tool-paths.test.ts
// Unit tests for the slice-20 `extractToolPaths` module.
//
// What this pins:
//   - the tool→field map for every name the engine actually emits
//     (verified against the runtime sqlite; not invented)
//   - the explicit "no extraction" decision for `glob` (pattern is a
//     scope, not a file) and `bash` (command embeds paths but they
//     are not "files the tool touched")
//   - normalisation rules: relative→absolute against workspaceDir,
//     JSON unescape, surrounding-quote strip, empty/./whitespace drop,
//     trailing-slash collapse, ~ / URLs left alone
//   - dedupe + per-call cap
//
// Test strategy: the module is a pure function. No DOM. Node:test.
//
// All paths in this file are OBVIOUSLY FAKE — the engine's actual data
// carries real user paths that must never appear in a test fixture
// (a previous slice tripped gitleaks and needed a history rewrite).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { extractToolPaths, normalisePath } from "../lib/tool-paths";

const WS = "/home/example/proj";

describe("extractToolPaths — read tools surface `path`", () => {
  test("read picks up `path`", () => {
    assert.deepEqual(
      extractToolPaths("read", JSON.stringify({ path: "/srv/file.ts" })),
      ["/srv/file.ts"],
    );
  });

  test("read_file picks up `path`", () => {
    assert.deepEqual(
      extractToolPaths("read_file", JSON.stringify({ path: "/srv/file.ts" })),
      ["/srv/file.ts"],
    );
  });

  test("view picks up `path`", () => {
    assert.deepEqual(
      extractToolPaths("view", JSON.stringify({ path: "/srv/file.ts" })),
      ["/srv/file.ts"],
    );
  });

  test("case-insensitive tool name", () => {
    assert.deepEqual(
      extractToolPaths("Read", JSON.stringify({ path: "/srv/file.ts" })),
      ["/srv/file.ts"],
    );
  });
});

describe("extractToolPaths — write tools", () => {
  test("write picks up `path`", () => {
    assert.deepEqual(
      extractToolPaths("write", JSON.stringify({ path: "/srv/new.ts", content: "// body" })),
      ["/srv/new.ts"],
    );
  });

  test("write_file picks up `path`", () => {
    assert.deepEqual(
      extractToolPaths("write_file", JSON.stringify({ path: "/srv/new.ts" })),
      ["/srv/new.ts"],
    );
  });

  test("create_file picks up `path`", () => {
    assert.deepEqual(
      extractToolPaths("create_file", JSON.stringify({ path: "/srv/new.ts" })),
      ["/srv/new.ts"],
    );
  });
});

describe("extractToolPaths — edit tools surface `file_path`", () => {
  test("edit picks up `file_path`", () => {
    assert.deepEqual(
      extractToolPaths(
        "edit",
        JSON.stringify({ file_path: "/srv/file.ts", old_string: "a", new_string: "b" }),
      ),
      ["/srv/file.ts"],
    );
  });

  test("edit falls back to `path` when `file_path` is absent", () => {
    assert.deepEqual(
      extractToolPaths("edit", JSON.stringify({ path: "/srv/file.ts" })),
      ["/srv/file.ts"],
    );
  });

  test("apply_patch picks up `file_path`", () => {
    assert.deepEqual(
      extractToolPaths("apply_patch", JSON.stringify({ file_path: "/srv/file.ts" })),
      ["/srv/file.ts"],
    );
  });

  test("str_replace picks up `file_path`", () => {
    assert.deepEqual(
      extractToolPaths("str_replace", JSON.stringify({ file_path: "/srv/file.ts" })),
      ["/srv/file.ts"],
    );
  });

  test("multi_edit picks up `file_path`", () => {
    assert.deepEqual(
      extractToolPaths("multi_edit", JSON.stringify({ file_path: "/srv/file.ts" })),
      ["/srv/file.ts"],
    );
  });
});

describe("extractToolPaths — notebook tools surface `notebook_path`", () => {
  test("notebook_read picks up `notebook_path`", () => {
    assert.deepEqual(
      extractToolPaths("notebook_read", JSON.stringify({ notebook_path: "/srv/nb.ipynb" })),
      ["/srv/nb.ipynb"],
    );
  });

  test("notebook_read falls back to `path` when `notebook_path` is absent", () => {
    assert.deepEqual(
      extractToolPaths("notebook_read", JSON.stringify({ path: "/srv/nb.ipynb" })),
      ["/srv/nb.ipynb"],
    );
  });

  test("notebook_edit picks up `file_path` (observed in real data)", () => {
    assert.deepEqual(
      extractToolPaths(
        "notebook_edit",
        JSON.stringify({ file_path: "/srv/nb.ipynb", old_string: "a", new_string: "b" }),
      ),
      ["/srv/nb.ipynb"],
    );
  });
});

describe("extractToolPaths — grep surfaces scope, NOT search term", () => {
  test("grep surfaces `path` and drops `pattern`", () => {
    const r = extractToolPaths(
      "grep",
      JSON.stringify({ pattern: "search-term", path: "/srv/file.ts", output_mode: "content" }),
    );
    assert.deepEqual(r, ["/srv/file.ts"]);
  });

  test("grep with no `path` returns undefined (whole-tree search → no chip)", () => {
    const r = extractToolPaths("grep", JSON.stringify({ pattern: "search-term" }));
    assert.equal(r, undefined);
  });

  test("find picks up `path`", () => {
    assert.deepEqual(
      extractToolPaths("find", JSON.stringify({ path: "/srv/sub" })),
      ["/srv/sub"],
    );
  });

  test("workspace_semantic_search picks up `path`", () => {
    assert.deepEqual(
      extractToolPaths("workspace_semantic_search", JSON.stringify({ path: "/srv/sub" })),
      ["/srv/sub"],
    );
  });
});

describe("extractToolPaths — glob NEVER surfaces the pattern", () => {
  test("glob returns undefined even though it carries `pattern`", () => {
    // `**/*.tsx` is a search scope across many files; surfacing it as
    // a single "file chip" would mislead the user.
    const r = extractToolPaths("glob", JSON.stringify({ pattern: "**/*.tsx" }));
    assert.equal(r, undefined);
  });

  test("glob with no fields still returns undefined", () => {
    assert.equal(extractToolPaths("glob", JSON.stringify({})), undefined);
  });
});

describe("extractToolPaths — bash NEVER regex-mines the command string", () => {
  test("bash returns undefined regardless of paths embedded in the command", () => {
    const r = extractToolPaths(
      "bash",
      JSON.stringify({ command: "cat /srv/secret/id_rsa > /tmp/srv/leak.txt" }),
    );
    assert.equal(r, undefined);
  });

  test("shell aliases behave the same", () => {
    for (const name of ["shell", "run_command", "execute_command", "terminal", "command"]) {
      const r = extractToolPaths(
        name,
        JSON.stringify({ command: "ls /srv/some/dir" }),
      );
      assert.equal(r, undefined, `${name} should not extract paths from command`);
    }
  });
});

describe("extractToolPaths — tools with no path field return undefined", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["task", { agent_name: "explore", prompt: "look around" }],
    ["agent", { prompt: "go" }],
    ["skill", { name: "lint" }],
    ["web_fetch", { url: "https://example.com" }],
    ["web_search", { query: "x" }],
    ["todowrite", { todos: [{ content: "do x" }] }],
    ["ask_user", { steps: [] }],
    ["get_goal", {}],
    ["update_goal", { status: "done" }],
    ["task_append", { task_id: "t1", content: "x" }],
    ["task_output", { task_id: "t1" }],
    ["task_query", { task_id: "t1" }],
    ["task_stop", { task_id: "t1" }],
    ["image_synthesize", { requests: [{ prompt: "x" }] }],
  ];
  for (const [name, args] of cases) {
    test(`${name} returns undefined`, () => {
      assert.equal(extractToolPaths(name, JSON.stringify(args)), undefined);
    });
  }
});

describe("extractToolPaths — array of paths is exploded into chips", () => {
  test("a `path` array of two files yields two chips", () => {
    const r = extractToolPaths(
      "write",
      JSON.stringify({ path: ["/srv/a.ts", "/srv/b.ts"] }),
    );
    assert.deepEqual(r, ["/srv/a.ts", "/srv/b.ts"]);
  });
});

describe("extractToolPaths — normalisation", () => {
  test("relative path absolutised against workspaceDir", () => {
    const r = extractToolPaths(
      "read",
      JSON.stringify({ path: "src/foo.ts" }),
      { workspaceDir: WS },
    );
    assert.deepEqual(r, [`${WS}/src/foo.ts`]);
  });

  test("leading `./` is stripped before absolutising", () => {
    const r = extractToolPaths(
      "read",
      JSON.stringify({ path: "./src/foo.ts" }),
      { workspaceDir: WS },
    );
    assert.deepEqual(r, [`${WS}/src/foo.ts`]);
  });

  test("absolute path is left untouched (workspace is irrelevant)", () => {
    const r = extractToolPaths(
      "read",
      JSON.stringify({ path: "/srv/foo.ts" }),
      { workspaceDir: WS },
    );
    assert.deepEqual(r, ["/srv/foo.ts"]);
  });

  test("workspaceDir='' keeps relative paths relative", () => {
    const r = extractToolPaths(
      "read",
      JSON.stringify({ path: "src/foo.ts" }),
      { workspaceDir: "" },
    );
    assert.deepEqual(r, ["src/foo.ts"]);
  });

  test("URL is preserved verbatim", () => {
    const r = extractToolPaths("read", JSON.stringify({ path: "https://example.com/x" }));
    assert.deepEqual(r, ["https://example.com/x"]);
  });

  test("a `~`-prefixed path is preserved (we do not have the home dir)", () => {
    const r = extractToolPaths("read", JSON.stringify({ path: "~/notes.md" }));
    assert.deepEqual(r, ["~/notes.md"]);
  });

  test("JSON-escaped quote is unescaped", () => {
    // The server's JSON.stringify already produces real chars; we still
    // re-unescape so a manually-typed test string works. The source
    // literal `"/srv/foo\\".ts"` (note the inner `\\"` — a real escape
    // sequence, not a closing quote) round-trips to `/srv/foo".ts`:
    //   step 1 (replace \\ with the char it encodes): `/srv/foo\".ts`
    //   step 2 (strip outer quotes once): `/srv/foo\".ts`
    // The embedded `"` survives (the input genuinely contained a quote
    // mid-path); a malformed path is no worse than what an upstream
    // tool might have emitted, and the file-open endpoint will reject
    // a path with a literal `"` in it cleanly.
    const r = extractToolPaths("read", JSON.stringify({ path: '"/srv/foo\\".ts"' }));
    assert.deepEqual(r, ['/srv/foo".ts']);
  });

  test("surrounding single quotes are stripped", () => {
    const r = extractToolPaths(
      "read",
      JSON.stringify({ path: "'/srv/foo.ts'" }),
    );
    assert.deepEqual(r, ["/srv/foo.ts"]);
  });

  test("empty / '.' / '/./' values are dropped", () => {
    for (const value of ["", " ", ".", "./"]) {
      const r = extractToolPaths("read", JSON.stringify({ path: value }));
      assert.equal(r, undefined, `value ${JSON.stringify(value)} should not produce a chip`);
    }
  });

  test("trailing slashes are collapsed (one, not repeated)", () => {
    const r = extractToolPaths("read", JSON.stringify({ path: "/srv/dir///" }));
    assert.deepEqual(r, ["/srv/dir"]);
  });

  test("non-object args return undefined (defensive)", () => {
    assert.equal(extractToolPaths("read", "null"), undefined);
    assert.equal(extractToolPaths("read", '"just-a-string"'), undefined);
    assert.equal(extractToolPaths("read", "[1,2,3]"), undefined);
  });

  test("malformed JSON returns undefined (does not crash the decoder)", () => {
    assert.equal(extractToolPaths("read", "{path: /srv/foo.ts"), undefined);
  });

  test("missing toolName returns undefined", () => {
    assert.equal(extractToolPaths(undefined, JSON.stringify({ path: "/srv/foo.ts" })), undefined);
    assert.equal(extractToolPaths("", JSON.stringify({ path: "/srv/foo.ts" })), undefined);
  });

  test("missing toolArgs returns undefined", () => {
    assert.equal(extractToolPaths("read", undefined), undefined);
    assert.equal(extractToolPaths("read", ""), undefined);
    assert.equal(extractToolPaths("read", "   "), undefined);
  });
});

describe("extractToolPaths — dedupe and cap", () => {
  test("the same path twice within one call produces one chip", () => {
    const r = extractToolPaths(
      "edit",
      JSON.stringify({ file_path: "/srv/foo.ts", path: "/srv/foo.ts" }),
    );
    assert.deepEqual(r, ["/srv/foo.ts"]);
  });

  test("a `path` array with duplicates collapses to unique chips", () => {
    const r = extractToolPaths(
      "write",
      JSON.stringify({ path: ["/srv/a.ts", "/srv/a.ts", "/srv/b.ts"] }),
    );
    assert.deepEqual(r, ["/srv/a.ts", "/srv/b.ts"]);
  });

  test("respects the per-call cap (returns early)", () => {
    // Build an array of 15 paths; the cap is 10, so we expect 10.
    const paths = Array.from({ length: 15 }, (_, i) => `/srv/f${i}.ts`);
    const r = extractToolPaths("write", JSON.stringify({ path: paths }));
    assert.equal(r?.length, 10);
    assert.deepEqual(r, paths.slice(0, 10));
  });
});

describe("normalisePath — standalone rules", () => {
  test("strips surrounding quotes in a single round", () => {
    assert.equal(normalisePath('"/srv/foo.ts"'), "/srv/foo.ts");
    assert.equal(normalisePath("'/srv/foo.ts'"), "/srv/foo.ts");
  });

  test("absolutises a relative path against the workspace", () => {
    assert.equal(normalisePath("src/foo.ts", WS), `${WS}/src/foo.ts`);
    assert.equal(normalisePath("./src/foo.ts", WS), `${WS}/src/foo.ts`);
  });

  test("leaves URLs and ~ paths alone", () => {
    assert.equal(normalisePath("https://example.com/x"), "https://example.com/x");
    assert.equal(normalisePath("~/notes.md"), "~/notes.md");
  });

  test("collapses repeated trailing slashes", () => {
    assert.equal(normalisePath("/srv/dir///"), "/srv/dir");
  });

  test("drops empty / dot / whitespace-only values", () => {
    assert.equal(normalisePath(""), null);
    assert.equal(normalisePath("   "), null);
    assert.equal(normalisePath("."), null);
    assert.equal(normalisePath("./"), null);
  });
});