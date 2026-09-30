// webui/test/lib/transcript.test.js
// Unit tests for server/lib/transcript.js — the mcode runtime-DB
// transcript reader (extracted from routes/export.js, v2
// 2026-09-20 webui-manual-audit) plus the messages→chat-lines
// inverse mapper used by the switch backfill.
//
// Coverage contract:
//   1. readMcodeTranscript gate order + legacy probe behavior is
//      IDENTICAL to the code that lived inline in export.js (same
//      reasons, same row mapping) — export.js must not change
//      behavior by the extraction.
//   2. the v2 data_json probe (the schema the real runtime DB
//      carries today) normalizes rows into the legacy message shape.
//   3. messagesToChatLines emits ONLY line shapes the legacy parser
//      (export.js#_parseChatLines) round-trips; ambiguous content is
//      skipped, never re-encoded.
//   4. caps: last 400 lines / 200KB total, whichever binds first; a
//      single oversized line gets an explicit truncation marker
//      instead of a silent drop; a front-truncation never leaves
//      orphan indented lines.
//
// Test strategy: NO mock.module — transcript.js takes getDb / dbPath
// / probes as options, so a fake better-sqlite3 class keyed by SQL
// string is injected directly.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import {rmSync, existsSync, writeFileSync} from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkTmpDir } from "../helpers/tmp.js";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const {
  readMcodeTranscript,
  messagesToChatLines,
  loadTranscriptChatLines,
  LEGACY_TRANSCRIPT_PROBES,
  V2_DATA_JSON_PROBES,
} = await import(absPath("lib/transcript.js"));

// ---------------------------------------------------------------------------
// Fake better-sqlite3: prepare(sql) succeeds ONLY for SQL keys present in
// rowsBySql (each entry: sid → rows); everything else throws, exactly like
// a real prepare() on a missing table / missing column.
//
// The result rows are PROJECTED onto the statement's own SELECT list, the
// way SQLite does it. Without that, a fixture row's every field would reach
// the mapper no matter what the query asked for — and a column missing from
// the SELECT list would be invisible to the suite while being invisible in
// production too, because a real `SELECT role, data_json` never returns
// `turn_id`. That is the silent-degradation shape the switch-backfill test
// documents; this fake is the half that lets the suite see it.
// ---------------------------------------------------------------------------
function selectedColumns(sql) {
  const m = /^\s*SELECT\s+(.+?)\s+FROM\s/i.exec(sql);
  assert.ok(m, `fake db: cannot read the SELECT list out of ${sql.slice(0, 60)}`);
  return m[1].split(",").map((c) => c.trim());
}

function project(row, columns) {
  const out = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

function makeFakeDb({ rowsBySql = {}, constructThrows = false } = {}) {
  return class FakeDb {
    constructor(path, opts) {
      if (constructThrows) throw new Error("fake better-sqlite3: boom");
      this.path = path;
      this.opts = opts;
    }
    prepare(sql) {
      const bySid = rowsBySql[sql];
      if (!bySid) throw new Error(`fake db: no such column (${sql.slice(0, 52)}…)`);
      const columns = selectedColumns(sql);
      return {
        all: (sid) => (bySid[sid] || []).map((row) => project(row, columns)),
      };
    }
    close() {
      this.closed = true;
    }
  };
}

// Real file on disk so the existsSync gate passes (content never read —
// the fake Db ignores the path).
let _tmpDir;
function realDbPath(name = "runtime-state.sqlite") {
  if (!_tmpDir) _tmpDir = mkTmpDir("webui-transcript-test-");
  const p = join(_tmpDir, name);
  if (!existsSync(p)) writeFileSync(p, "sqlite fixture placeholder");
  return p;
}
after(() => {
  if (_tmpDir) {
    try { rmSync(_tmpDir, { recursive: true, force: true }); } catch {}
  }
});

const SID = "mvs_0123456789abcdef0123456789abcdef"; // 32 hex chars

describe("readMcodeTranscript — gate order (must match export.js exactly)", () => {
  test("no sid → no_mcode_sid", () => {
    const r = readMcodeTranscript("", { dbPath: realDbPath(), getDb: () => makeFakeDb() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_mcode_sid");
  });

  test("non-mvs sid → bad_mcode_sid", () => {
    const r = readMcodeTranscript("not-a-sid", { dbPath: realDbPath(), getDb: () => makeFakeDb() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "bad_mcode_sid");
  });

  test("missing db file → mcode_db_not_found (checked BEFORE better-sqlite3)", () => {
    // Synthesize a path that DOES NOT exist on disk. We do not mkdir the
    // parent — readMcodeTranscript must report mcode_db_not_found before
    // it ever touches better-sqlite3, so creating the parent would
    // defeat the assertion.
    const missingParent = join(tmpdir(), "webui-no-such-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8));
    const missing = join(missingParent, "x.sqlite");
    const r = readMcodeTranscript(SID, { dbPath: missing, getDb: () => null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mcode_db_not_found");
  });

  test("better-sqlite3 not loadable → better_sqlite3_not_loaded", () => {
    const r = readMcodeTranscript(SID, { dbPath: realDbPath(), getDb: () => null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "better_sqlite3_not_loaded");
  });

  test("constructor throw → db_error with message", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({ constructThrows: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "db_error");
    assert.match(r.error, /boom/);
  });

  test("no probe matches → no_matching_table", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({ rowsBySql: {} }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_matching_table");
  });
});

describe("readMcodeTranscript — legacy probes (extraction is behavior-preserving)", () => {
  const legacySql0 = LEGACY_TRANSCRIPT_PROBES[0].sql;

  test("first legacy probe hit: role lowercased, content coerced, tool_calls_json parsed", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({
        rowsBySql: {
          [legacySql0]: {
            [SID]: [
              { role: "USER", content: "hi", tool_calls_json: null },
              { role: "assistant", content: "", tool_calls_json: '[{"function":{"name":"web_search","arguments":"{\\"q\\":\\"x\\"}"}}]' },
            ],
          },
        },
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, "local_runtime_message_rows");
    assert.equal(r.probe, "legacy-cols");
    assert.deepEqual(r.messages, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "web_search", arguments: '{"q":"x"}' } }],
      },
    ]);
  });

  test("probe 1 misses (schema drift) → probe 2 table fallback", () => {
    const legacySql1 = LEGACY_TRANSCRIPT_PROBES[1].sql;
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({
        rowsBySql: {
          [legacySql1]: { [SID]: [{ role: "user", content: "from table 2" }] },
        },
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, "local_runtime_messages");
    assert.deepEqual(r.messages, [{ role: "user", content: "from table 2" }]);
  });

  test("role default under legacy mapper is 'system' (export.js parity)", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({
        rowsBySql: { [legacySql0]: { [SID]: [{ role: null, content: "anon" }] } },
      }),
    });
    assert.deepEqual(r.messages, [{ role: "system", content: "anon" }]);
  });
});

describe("readMcodeTranscript — v2 data_json probe (real runtime schema)", () => {
  const v2Sql = V2_DATA_JSON_PROBES[0].sql;

  function v2Db(rows) {
    return makeFakeDb({
      // legacy SQLs intentionally absent → they throw, v2 hits (mirrors the
      // real DB where all three legacy probes fail with "no such column").
      rowsBySql: { [v2Sql]: { [SID]: rows } },
    });
  }

  test("normalizes msg_content / thinking_content / tool_calls", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => v2Db([
        {
          role: "user",
          data_json: JSON.stringify({ role: "user", msg_type: 1, msg_content: "调研一下" }),
        },
        {
          role: "assistant",
          data_json: JSON.stringify({
            role: "assistant",
            msg_type: 2,
            msg_content: "我先看看",
            thinking_content: "想一下",
            tool_calls: [
              {
                tool_name: "bash",
                tool_call_id: "c1",
                tool_call_status: 2,
                tool_call_args: '{"command":"ls"}',
                tool_call_result_data: '{"content":[{"type":"text","text":"file1\\nfile2"}]}',
              },
            ],
          }),
        },
      ]),
      probes: [...LEGACY_TRANSCRIPT_PROBES, ...V2_DATA_JSON_PROBES],
    });
    assert.equal(r.ok, true);
    assert.equal(r.probe, "v2-data-json");
    assert.deepEqual(r.messages, [
      { role: "user", content: "调研一下" },
      {
        role: "assistant",
        content: "我先看看",
        thinking: "想一下",
        tool_calls: [
          {
            name: "bash",
            arguments: '{"command":"ls"}',
            status: "completed",
            result: "file1\nfile2",
          },
        ],
      },
    ]);
  });

  test("tool_call_status 3 → 'failed'; unknown ints → null (never invent a verdict)", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => v2Db([
        {
          role: "assistant",
          data_json: JSON.stringify({
            role: "assistant",
            msg_content: "",
            tool_calls: [
              { tool_name: "edit", tool_call_status: 3, tool_call_args: "{}", tool_call_result_data: null },
              { tool_name: "read", tool_call_status: 99, tool_call_args: "{}", tool_call_result_data: null },
            ],
          }),
        },
      ]),
      probes: V2_DATA_JSON_PROBES,
    });
    assert.equal(r.messages[0].tool_calls[0].status, "failed");
    assert.equal(r.messages[0].tool_calls[1].status, null);
  });

  test("drops unrecognized roles and malformed data_json rows", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => v2Db([
        { role: "tool_executor", data_json: JSON.stringify({ role: "tool_executor", msg_content: "x" }) },
        { role: "", data_json: "{not json" },
        { role: "system", data_json: JSON.stringify({ role: "system", msg_content: "sys" }) },
      ]),
      probes: V2_DATA_JSON_PROBES,
    });
    assert.deepEqual(r.messages, [{ role: "system", content: "sys" }]);
  });
});

describe("messagesToChatLines — inverse line grammar", () => {
  test("user / thinking / assistant / system / tool shapes", () => {
    const { lines, skipped } = messagesToChatLines([
      { role: "user", content: "hello\nmulti\nline" },
      {
        role: "assistant",
        thinking: "hmm\ndeep",
        content: "answer **here**",
        tool_calls: [
          {
            name: "bash",
            arguments: '{"command":"ls"}',
            status: "completed",
            result: "file1\nfile2",
          },
          { name: "read_file", arguments: "", status: "failed", result: "" },
        ],
      },
      { role: "system", content: "sys msg" },
      { role: "mystery", content: "skip me" },
    ]);
    // Every source line gets its own syntax line. The decoder rejoins runs of
    // same-role prose with "\n" (see `decodeTranscript`), so a user message
    // containing newlines has to stay split here — collapsing it to one line
    // would permanently lose the breaks and with them markdown blocks.
    assert.deepEqual(lines, [
      "› hello",
      "› multi",
      "› line",
      "▲ hmm",
      "▲ deep",
      "● answer **here**",
      "→ bash  {\"command\":\"ls\"}",
      "  [completed]",
      "  file1",
      "  file2",
      "→ read_file",
      "  [failed]",
      "○ sys msg",
    ]);
    assert.equal(skipped, 1, "unknown-role message contributes nothing");
  });

  test("OpenAI-ish tool_calls (legacy tool_calls_json shape) map via function.name", () => {
    const { lines } = messagesToChatLines([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "web_search", arguments: '{"q":"x"}' } }],
      },
    ]);
    assert.deepEqual(lines, ['→ web_search  {"q":"x"}']);
  });

  test("ambiguous result lines are skipped, not re-encoded", () => {
    // A result line that IS a full "[…]" would re-parse as a status line;
    // "! x" as an error; "@ /p" as a location. Skipping keeps the render
    // honest instead of silently re-classifying content.
    const { lines } = messagesToChatLines([
      {
        role: "assistant",
        tool_calls: [
          {
            name: "t",
            arguments: "",
            status: "completed",
            result: "[completed]\n! danger\n@ /path\nkeep me\n\n  ",
          },
        ],
      },
    ]);
    assert.deepEqual(lines, ["→ t", "  [completed]", "  keep me"]);
  });

  test("tool call without a name is skipped (cannot build a header)", () => {
    const { lines } = messagesToChatLines([
      { role: "assistant", tool_calls: [{ arguments: "{}" }, { name: "ok", arguments: "{}" }] },
    ]);
    assert.deepEqual(lines, ["→ ok  {}"]);
  });

  test("unknown status emits NO status line (frontend default 'pending')", () => {
    const { lines } = messagesToChatLines([
      { role: "assistant", tool_calls: [{ name: "t", arguments: "", status: "weird", result: "out" }] },
    ]);
    assert.deepEqual(lines, ["→ t", "  out"]);
  });
});

describe("messagesToChatLines — caps (400 lines / 200KB)", () => {
  const MAX_BYTES = 200 * 1024;

  test("line cap keeps the LAST 400 lines", () => {
    const msgs = [];
    for (let i = 0; i < 500; i++) msgs.push({ role: "user", content: `msg ${i}` });
    const { lines, truncated } = messagesToChatLines(msgs);
    assert.equal(lines.length, 400);
    assert.equal(lines[0], "› msg 100", "tail kept — line 0 is message #100");
    assert.equal(lines[399], "› msg 499");
    assert.equal(truncated, true);
  });

  test("byte cap drops from the front while over 200KB", () => {
    // 3 user lines of ~90KB each = ~270KB raw → front lines dropped until
    // the total fits; the LAST message must always survive.
    const big = "x".repeat(90 * 1024);
    const msgs = [
      { role: "user", content: big },
      { role: "user", content: big },
      { role: "user", content: big },
      { role: "user", content: "final short" },
    ];
    const { lines } = messagesToChatLines(msgs);
    const total = lines.reduce((s, l) => s + Buffer.byteLength(l, "utf8"), 0);
    assert.ok(total <= MAX_BYTES, `total ${total} must be <= ${MAX_BYTES}`);
    assert.equal(lines.length, 3, "exactly one oversized line dropped from the front");
    assert.equal(lines[lines.length - 1], "› final short");
  });

  test("a single oversized line is marker-truncated, never silently emptied", () => {
    const { lines, truncated } = messagesToChatLines([
      { role: "assistant", content: "y".repeat(300 * 1024) },
    ]);
    assert.equal(lines.length, 1);
    const total = Buffer.byteLength(lines[0], "utf8");
    assert.ok(total <= MAX_BYTES, `total ${total} must be <= ${MAX_BYTES}`);
    assert.match(lines[0], / …\[truncated\]$/, "explicit truncation marker");
    assert.equal(truncated, true);
  });

  test("front-truncation never leaves orphan indented tool-output lines", () => {
    // One tool block with many output lines, then user messages; cap the
    // lines so the slice boundary falls INSIDE the tool block. The first
    // emitted line must not be an indented orphan (its → header was cut).
    const toolCall = {
      name: "bash",
      arguments: "{}",
      status: "completed",
      result: Array.from({ length: 30 }, (_, i) => `out ${i}`).join("\n"),
    };
    const msgs = [{ role: "assistant", tool_calls: [toolCall] }];
    for (let i = 0; i < 30; i++) msgs.push({ role: "user", content: `u ${i}` });
    const { lines } = messagesToChatLines(msgs, { maxLines: 20 });
    assert.equal(lines.length <= 20, true);
    assert.ok(!/^\s{2,}\S/.test(lines[0]), `first line must not be an orphan: ${JSON.stringify(lines[0])}`);
  });
});

describe("loadTranscriptChatLines — read + map composition", () => {
  test("legacy + v2 probes by default; failure lands as ok:false, never throws", () => {
    // All probes miss → ok:false with reason (the switch path continues
    // with chat: [] on this outcome).
    const r = loadTranscriptChatLines(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({}),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_matching_table");
    assert.deepEqual(r.lines, []);
  });

  test("happy path: v2 rows → capped chat lines", () => {
    const v2Sql = V2_DATA_JSON_PROBES[0].sql;
    const rows = [
      {
        role: "user",
        data_json: JSON.stringify({ role: "user", msg_content: "q" }),
      },
      {
        role: "assistant",
        data_json: JSON.stringify({
          role: "assistant",
          msg_content: "a",
          tool_calls: [
            {
              tool_name: "bash",
              tool_call_status: 2,
              tool_call_args: '{"command":"ls"}',
              tool_call_result_data: '{"content":[{"type":"text","text":"o1"}]}',
            },
          ],
        }),
      },
    ];
    const r = loadTranscriptChatLines(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({ rowsBySql: { [v2Sql]: { [SID]: rows } } }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.probe, "v2-data-json");
    assert.equal(r.messageCount, 2);
    assert.deepEqual(r.lines, [
      "› q",
      "● a",
      "→ bash  {\"command\":\"ls\"}",
      "  [completed]",
      "  o1",
    ]);
  });

  test("sid gate still applies in the composed path", () => {
    const r = loadTranscriptChatLines("junk");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "bad_mcode_sid");
  });
});

// ---------------------------------------------------------------------------
// webui-parity 83 — the turn coordinate carried back into the transcript
// ---------------------------------------------------------------------------
//
// The engine persists a turn's file-change record under the msg_id of that
// turn's LAST assistant message, and it writes one message row per message
// into `local_runtime_message_rows` with `turn_id` / `msg_id` columns. The
// backfill turns those two columns into the SAME `§§ turn_msg=<id>` marker
// the live path writes, so a restored session reaches the same per-turn diff
// card a live turn does — and the endpoint can be given an exact selector
// instead of a turn ordinal that no longer lines up with the engine's rows.
//
// The invariant that matters most is the last one: a transcript with NO
// coordinate columns must come out byte-for-byte as it did before this
// feature, because the legacy probes have no such columns and every stored
// session older than them still has to render.
describe("messagesToChatLines — the §§ turn_msg marker", () => {
  const TURN_A = "turn-a";
  const TURN_B = "turn-b";

  function read(rows) {
    return readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({ rowsBySql: { [V2_DATA_JSON_PROBES[0].sql]: { [SID]: rows } } }),
      probes: [...LEGACY_TRANSCRIPT_PROBES, ...V2_DATA_JSON_PROBES],
    });
  }

  function userRow(turn_id, msg_id, content) {
    return { role: "user", turn_id, msg_id, data_json: JSON.stringify({ role: "user", msg_content: content }) };
  }
  function assistantRow(turn_id, msg_id, content) {
    return { role: "assistant", turn_id, msg_id, data_json: JSON.stringify({ role: "assistant", msg_content: content }) };
  }

  test("the probe's own SELECT list carries the coordinate columns", () => {
    // The mapper reads `r.turn_id` / `r.msg_id`, and a row only has those
    // fields because the statement SELECTED them. Narrowing that list is the
    // one edit that loses every coordinate at once while leaving the schema,
    // the writer and the marker syntax untouched — so the list itself is
    // pinned, not just the behaviour it produces.
    const columns = selectedColumns(V2_DATA_JSON_PROBES[0].sql);
    assert.ok(columns.includes("turn_id"), `SELECT list is ${columns.join(", ")}`);
    assert.ok(columns.includes("msg_id"), `SELECT list is ${columns.join(", ")}`);
  });

  test("one marker per turn, carrying that turn's LAST assistant msg_id", () => {
    const r = read([
      userRow(TURN_A, "m-u1", "改一下"),
      // Three assistant rows in the turn — thinking, a tool step, the answer.
      // The engine stored the record under the LAST one, so the marker must
      // be the last one too; taking the first would select nothing.
      assistantRow(TURN_A, "m-a1", "我先看看"),
      assistantRow(TURN_A, "m-a2", "中间步骤"),
      assistantRow(TURN_A, "m-a3", "改好了"),
      userRow(TURN_B, "m-u2", "再来一次"),
      assistantRow(TURN_B, "m-b1", "第二次的答案"),
    ]);
    assert.equal(r.ok, true);
    const lines = messagesToChatLines(r.messages).lines;
    assert.deepEqual(
      lines.filter((l) => l.startsWith("§§")),
      ["§§ turn_msg=m-a3", "§§ turn_msg=m-b1"],
    );
  });

  test("the marker lands AFTER the turn's last line, not before it", () => {
    const r = read([userRow(TURN_A, "m-u1", "q"), assistantRow(TURN_A, "m-a1", "a")]);
    const lines = messagesToChatLines(r.messages).lines;
    assert.deepEqual(lines, ["› q", "● a", "§§ turn_msg=m-a1"]);
  });

  test("a turn with no assistant message contributes no marker", () => {
    // An aborted prompt. The engine wrote no diff record, so there is no id
    // to select — and inventing one is exactly the fallback this forbids.
    const r = read([userRow(TURN_A, "m-u1", "q")]);
    const lines = messagesToChatLines(r.messages).lines;
    assert.deepEqual(lines, ["› q"]);
  });

  test("a turn coordinate split across two turns never leaks across", () => {
    // Turn A's marker must be A's last assistant id, not turn B's. A marker
    // emitted one turn late would make the card show the NEXT turn's counts.
    const r = read([
      assistantRow(TURN_A, "a-only", "第一回合"),
      userRow(TURN_B, "m-u2", "第二问"),
      assistantRow(TURN_B, "b-last", "第二回合"),
    ]);
    const lines = messagesToChatLines(r.messages).lines;
    assert.deepEqual(lines, ["● 第一回合", "§§ turn_msg=a-only", "› 第二问", "● 第二回合", "§§ turn_msg=b-last"]);
  });

  test("rows without the coordinate columns produce no marker at all", () => {
    // The legacy probe shape. This is every session older than the columns,
    // and it must decode exactly as it did before the feature shipped.
    const legacy = [
      { role: "user", content: "旧问题" },
      { role: "assistant", content: "旧答案" },
    ];
    assert.deepEqual(messagesToChatLines(legacy).lines, ["› 旧问题", "● 旧答案"]);
  });

  test("the COLUMN wins over the payload's own copy of msg_id", () => {
    // A partial write or schema drift can leave the two disagreeing. The
    // column is the index the runtime's own selector is built on, so it is
    // the one that must reach the transcript.
    const r = read([
      {
        role: "assistant",
        turn_id: TURN_A,
        msg_id: "column-id",
        data_json: JSON.stringify({ role: "assistant", msg_id: "payload-id", msg_content: "答案" }),
      },
    ]);
    assert.equal(r.ok, true);
    const lines = messagesToChatLines(r.messages).lines;
    assert.ok(lines.includes("§§ turn_msg=column-id"));
    assert.ok(!lines.some((l) => l.includes("payload-id")));
  });

  test("a user row's msg_id is never mistaken for the turn's coordinate", () => {
    const r = read([userRow(TURN_A, "m-u1", "q"), assistantRow(TURN_A, "m-a1", "a")]);
    const lines = messagesToChatLines(r.messages).lines;
    assert.ok(!lines.some((l) => l.includes("m-u1")));
  });
});
