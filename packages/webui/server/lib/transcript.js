// webui/server/lib/transcript.js
// v2 (2026-09-20 webui-manual-audit): mcode runtime-DB transcript reader +
//   webui chat-line mapper, extracted from routes/export.js#_readMcodeTranscript
//   so POST /api/sessions/switch can backfill history without duplicating the
//   schema-probing logic. Two exports matter:
//
//   readMcodeTranscript(mcodeSid, opts) — read-only probe of the runtime DB,
//     returns { messages, ok, reason?, source?, error? }. The default probe
//     list is byte-for-byte the legacy 3-candidate set export.js used (same
//     SQL, same row mapping, same fail-soft reasons) so wiring export.js to
//     this module changes zero export behavior.
//
//   messagesToChatLines(messages, opts) — the INVERSE of the webui chat line
//     grammar (export.js#_parseChatLines
//     parse lines→messages; we map messages→lines). Only shapes both parsers
//     round-trip confidently are emitted; anything ambiguous is skipped, not
//     invented (see _AMBIGUOUS_INDENT_RE).
//
//   loadTranscriptChatLines(mcodeSid, opts) — read (legacy + v2 data_json
//     probes) then map, with the switch-path caps applied (last 400 lines /
//     200KB total, whichever binds first).

import { existsSync } from "node:fs";
import { MCODE_RUNTIME_DB } from "./config.js";
import { getMcodeBetterSqlite3 } from "./sqlite-resolver.js";

// ============================================================
// Probe candidates — the mcode schema is unstable, try a handful
// of likely shapes. If none match, fail-soft with a reason.
// ============================================================

// v2 (2026-09-20 webui-manual-audit): LEGACY set — extracted VERBATIM from
//   routes/export.js (same SQL strings, same order). export.js keeps this
//   default so its behavior (and its tests) are untouched.
export const LEGACY_TRANSCRIPT_PROBES = [
  {
    table: "local_runtime_message_rows",
    sql:
      "SELECT role, content, tool_calls_json FROM local_runtime_message_rows WHERE session_id = ? ORDER BY seq ASC, ts ASC, rowid ASC",
    kind: "legacy-cols",
    mapRow: _mapLegacyRow,
  },
  {
    table: "local_runtime_messages",
    sql:
      "SELECT role, content, tool_calls_json FROM local_runtime_messages WHERE session_id = ? ORDER BY seq ASC, ts ASC, rowid ASC",
    kind: "legacy-table",
    mapRow: _mapLegacyRow,
  },
  {
    table: "local_runtime_message_rows",
    sql:
      "SELECT role, content FROM local_runtime_message_rows WHERE session_id = ? ORDER BY rowid ASC",
    kind: "legacy-cols-min",
    mapRow: _mapLegacyRow,
  },
];

// v2 (2026-09-20 webui-manual-audit): the schema the runtime DB ACTUALLY
//   carries today (probed against a live ~/.minimax/v2/sqlite/runtime-state
//   .sqlite): local_runtime_message_rows(id, session_id, msg_id, role,
//   turn_id, created_at_ms, data_json, source, source_context_json) where
//   data_json = {msg_id, timestamp, role, msg_type, msg_content,
//   thinking_content, tool_calls: [{tool_name, tool_call_id,
//   tool_call_status, tool_call_args, tool_call_result_data}], ...}.
//   The legacy probes all miss on it ("no such column: content"), which is
//   why export's enrichment was silently dead — this probe revives reads for
//   the switch path. NOT part of the default set: export.js must not change
//   behavior, so only callers that opt in (switch backfill) append it.
//
//   webui-parity 83: the probe also selects `turn_id` and `msg_id`. Those two
//   columns are the engine's own turn coordinate — the last assistant row of a
//   turn carries exactly the `assistant_message_id` the turn's diff record was
//   persisted under — so the mapper can synthesise the same `§§ turn_msg=<id>`
//   marker the live path writes, and an existing session gains the coordinate
//   on the next switch without the engine being asked anything.
export const V2_DATA_JSON_PROBES = [
  {
    table: "local_runtime_message_rows",
    sql:
      "SELECT role, data_json, turn_id, msg_id FROM local_runtime_message_rows WHERE session_id = ? ORDER BY created_at_ms ASC, rowid ASC",
    kind: "v2-data-json",
    mapRow: _mapV2DataJsonRow,
  },
];

// Row mapper for the legacy probes — exact copy of export.js's original
// normalization (role defaults to "system", content coerced to string,
// tool_calls_json parsed as array when possible).
function _mapLegacyRow(r) {
  const role = (r && r.role) ? String(r.role).toLowerCase() : "system";
  const content = (r && typeof r.content === "string") ? r.content : "";
  let tool_calls = null;
  if (r.tool_calls_json) {
    try {
      const parsed = JSON.parse(r.tool_calls_json);
      if (Array.isArray(parsed)) tool_calls = parsed;
    } catch {
      /* malformed — ignore */
    }
  }
  const m = { role, content };
  if (tool_calls) m.tool_calls = tool_calls;
  return m;
}

// tool_call_status enum as observed in the live DB (38662 rows at 2, 1660 at
// 3; the 3-family result texts are tool failures like "Could not find the
// exact text…"). Mapped conservatively: unknown ints emit NO status line —
// the frontend then renders its own "pending" default instead of us
// inventing a wrong verdict.
function _v2ToolStatus(n) {
  if (n === 2) return "completed";
  if (n === 3) return "failed";
  return null;
}

// tool_call_result_data is a JSON string shaped like the acp tool_update
// rawOutput: {"content":[{"type":"text","text":"…"}]}. Extract the text
// parts joined with "\n" — mirrors routes' outText extraction in
// server/lib/mcode-acp.js (tool_update handler). Non-string / malformed
// results yield "" (conservative: no output lines).
function _v2ResultText(raw) {
  if (!raw) return "";
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "";
    }
  }
  if (!parsed || !Array.isArray(parsed.content)) return "";
  return parsed.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// Row mapper for the v2 data_json probe. Normalizes to the same
// {role, content, tool_calls} message shape the legacy probes produce, plus
// two switch-only extras (thinking, per-call status/result) that the
// chat-line mapper consumes. Unrecognized roles are dropped (not coerced to
// system — export's coercion stays in the legacy mapper only).
function _mapV2DataJsonRow(r) {
  let d = null;
  if (r && typeof r.data_json === "string" && r.data_json) {
    try {
      d = JSON.parse(r.data_json);
    } catch {
      d = null;
    }
  } else if (r && r.data_json && typeof r.data_json === "object") {
    d = r.data_json;
  }
  if (!d) return null;
  const role = (r && r.role ? String(r.role) : (d.role ? String(d.role) : "")).toLowerCase();
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const content = typeof d.msg_content === "string" ? d.msg_content : "";
  const thinking = typeof d.thinking_content === "string" ? d.thinking_content : "";
  let tool_calls = null;
  if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) {
    const calls = [];
    for (const tc of d.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const name = tc.tool_name || tc.name;
      if (!name || typeof name !== "string") continue; // no name → cannot build a "→ name" header
      let args = tc.tool_call_args !== undefined ? tc.tool_call_args : tc.arguments;
      if (args && typeof args === "object") {
        try { args = JSON.stringify(args); } catch { args = ""; }
      }
      calls.push({
        name,
        arguments: typeof args === "string" ? args : "",
        status: _v2ToolStatus(tc.tool_call_status),
        result: _v2ResultText(tc.tool_call_result_data),
      });
    }
    if (calls.length > 0) tool_calls = calls;
  }
  const m = { role, content };
  if (thinking) m.thinking = thinking;
  if (tool_calls) m.tool_calls = tool_calls;
  // webui-parity 83: the engine's own turn coordinate. The COLUMN is
  // authoritative — `data_json` carries its own copies of both fields, and a
  // row whose column and payload disagree (partial write, schema drift) must
  // not fabricate a selector. Absent (legacy table, or a row the engine wrote
  // before these columns existed) simply means "no coordinate for this turn",
  // and the transcript degrades to the marker-free card.
  if (typeof r.turn_id === "string" && r.turn_id) m.turnId = r.turn_id;
  if (typeof r.msg_id === "string" && r.msg_id) m.msgId = r.msg_id;
  return m;
}

// ============================================================
// readMcodeTranscript — read-only probe loop (sync: better-sqlite3 is sync,
// the switch hot path must not gain an awaitable).
// Gate order matches export.js's original exactly:
//   no sid → bad sid → db missing → better-sqlite3 missing → probe loop.
// ============================================================
export function readMcodeTranscript(mcodeSid, opts = {}) {
  const dbPath = opts.dbPath || MCODE_RUNTIME_DB;
  const getDb = opts.getDb || getMcodeBetterSqlite3;
  const probes =
    Array.isArray(opts.probes) && opts.probes.length > 0
      ? opts.probes
      : LEGACY_TRANSCRIPT_PROBES;
  if (!mcodeSid) return { messages: [], ok: false, reason: "no_mcode_sid" };
  if (!/^mvs_[a-f0-9]{32}$/.test(mcodeSid)) {
    return { messages: [], ok: false, reason: "bad_mcode_sid" };
  }
  if (!existsSync(dbPath)) {
    return { messages: [], ok: false, reason: "mcode_db_not_found" };
  }
  const Db = getDb();
  if (!Db) {
    return { messages: [], ok: false, reason: "better_sqlite3_not_loaded" };
  }
  let db;
  try {
    db = new Db(dbPath, { readonly: true });
    for (const c of probes) {
      try {
        const rows = db.prepare(c.sql).all(mcodeSid);
        if (Array.isArray(rows) && rows.length > 0) {
          const msgs = rows
            .map((r) => c.mapRow(r))
            .filter(Boolean)
            .filter((m) => m.content || m.thinking || (m.tool_calls && m.tool_calls.length));
          db.close();
          // `source` keeps the probe's TABLE name (export.js surfaces it in
          // _meta as the enrichment source); `probe` names the shape for logs.
          return { messages: msgs, ok: true, source: c.table, probe: c.kind };
        }
      } catch {
        // table missing or schema mismatch — try next
      }
    }
    db.close();
    return { messages: [], ok: false, reason: "no_matching_table" };
  } catch (e) {
    if (db) try { db.close(); } catch {}
    return { messages: [], ok: false, reason: "db_error", error: e.message };
  }
}

// ============================================================
// messagesToChatLines — the INVERSE of the webui chat-line grammar.
//
// Line grammar emitted (must stay parseable by BOTH
// export.js#_parseChatLines):
//   user       "› " + text        (newlines collapsed to spaces — the live
//                                 writer chat.js:50 keeps raw newlines, but
//                                 both parsers read ONE array element = ONE
//                                 line, so collapsing is what round-trips)
//   thinking   "▲ " + text        (collapsed; emitted before the ● line,
//                                 matching the live stream order ▲-then-●)
//   assistant  "● " + text        (collapsed; same as chat.js:122-133 does
//                                 for the final answer)
//   system     "○ " + text        (collapsed)
//   tool       "→ " + name [+ "  " + argsJSON]   (two-space separator,
//                                 exactly like mcode-acp.js:364), followed by
//                                 indented block lines:
//                                   "  [completed]" / "  [failed]"
//                                   "  " + resultTextLine
//                                 Result lines that would be REPARSED as a
//                                 different shape (a full "[…]" status line,
//                                 "! error", "@ path") are skipped, not
//                                 re-encoded — conservative per the audit
//                                 fix contract: never invent a shape.
//
// Caps (switch hot path — the SSE state push carries cs.chat wholesale):
//   keep the LAST maxLines lines, then drop from the front while the total
//   UTF-8 byte size exceeds maxBytes. A single line that alone exceeds
//   maxBytes is byte-truncated with an explicit " …[truncated]" marker —
//   the alternative (dropping the whole tail) would empty the chat.
// ============================================================

// Stripped indented forms that parseChatLines would classify as status /
// error / location instead of output text. Emitting them verbatim would
// silently change their meaning on re-parse.
const _AMBIGUOUS_INDENT_RE = /^\[[^\]]*\]$|^!\s|^@\s/;

// Collapse newlines the way the live writers do (chat.js:122
// `r.answer.replace(/\n+/g, " ").trim()`); \r included for CRLF transcripts.
function _oneLine(s) {
  return String(s == null ? "" : s).replace(/\r?\n+/g, " ").trim();
}

// Prose keeps its line structure.
//
// The grammar is line-oriented and the frontend parser re-joins consecutive
// same-role lines with "\n" (see `decodeTranscript`'s pushText), so emitting one
// entry per source line round-trips the original text: markdown tables, lists,
// headings and paragraph breaks all survive.
//
// Every message used to go through `_oneLine()`, which replaces newlines with
// spaces (mirroring the live writer at routes/chat.js:122). That is what made a
// markdown table render as a raw `| --- |` line and left each message as one
// dense block — by the time `marked` saw the text there were no newlines left to
// parse.
//
// A blank source line becomes a bare prefix (`"● "`), which the parser matches as
// an empty line inside the same block rather than as a new block or a stray
// glyph.
function _proseLines(prefix, value) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  if (!text.trim()) return [];
  return text.split("\n").map((line) =>
    line.trim() === "" ? `${prefix} ` : `${prefix} ${line.replace(/\s+$/, "")}`,
  );
}

// Byte length in UTF-8 (ASCII fast path — the common case for JSON args).
function _bytes(s) {
  return /[^\x00-\x7F]/.test(s) ? Buffer.byteLength(s, "utf8") : s.length;
}

function _byteTruncate(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Cut on a UTF-8 character boundary, then append the marker.
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}

// Map one message to raw (uncapped) lines. Returns the lines; shapes we
// cannot map confidently contribute nothing (skipped, not invented).
function _messageToLines(m) {
  const out = [];
  if (!m || typeof m !== "object") return out;
  const role = String(m.role || "").toLowerCase();
  const content = typeof m.content === "string" ? m.content : "";

  if (role === "user") {
    for (const line of _proseLines("›", content)) out.push(line);
    return out;
  }
  if (role === "system") {
    for (const line of _proseLines("○", content)) out.push(line);
    return out;
  }
  if (role !== "assistant") return out; // unknown role → skip

  // thinking first (live stream order: ▲ accumulates, then ● finalizes)
  for (const line of _proseLines("▲", m.thinking)) out.push(line);
  for (const line of _proseLines("●", content)) out.push(line);

  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      // Accept both the v2 normalized shape ({name, arguments}) and an
      // OpenAI-ish {function:{name, arguments}} so legacy tool_calls_json
      // rows map too.
      const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
      const name = tc.name || (fn && fn.name);
      if (!name || typeof name !== "string" || !/\S/.test(name)) continue;
      let args = tc.arguments !== undefined ? tc.arguments : (fn && fn.arguments);
      if (args && typeof args === "object") {
        try { args = JSON.stringify(args); } catch { args = ""; }
      }
      if (typeof args !== "string") args = "";
      args = args.replace(/\r?\n+/g, " ").trim(); // JSON.stringify is 1-line; defensive only
      out.push(args ? `→ ${name}  ${args}` : `→ ${name}`);
      // Status line only when the enum was recognized (2/3) — an unknown
      // status must NOT become an invented verdict.
      if (tc.status === "completed" || tc.status === "failed") {
        out.push(`  [${tc.status}]`);
      }
      // Output lines: from the v2 `result` text (or a legacy `output`
      // string when present). Blank / ambiguous lines are skipped.
      const resultText =
        typeof tc.result === "string" ? tc.result :
        typeof tc.output === "string" ? tc.output : "";
      if (resultText) {
        for (const ln of resultText.split("\n")) {
          if (!ln.trim()) continue; // a bare "  " line terminates the tool block in the frontend parser
          if (_AMBIGUOUS_INDENT_RE.test(ln.trim())) continue; // would re-parse as status/error/path
          out.push(`  ${ln.replace(/\s+$/, "")}`);
        }
      }
      if (tc.error && typeof tc.error === "string") {
        out.push(`  ! ${tc.error.replace(/\r?\n+/g, " ").trim()}`);
      }
    }
  }
  return out;
}

export function messagesToChatLines(messages, opts = {}) {
  const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : 400;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 200 * 1024;
  const src = Array.isArray(messages) ? messages : [];
  const raw = [];
  let skipped = 0;
  // webui-parity 83 (turn coordinate). Every v2 row carries the engine's own
  // `turn_id`, and the LAST assistant row of a turn carries the exact msg_id
  // that turn's diff record was persisted under (turn-outcome.ts reads the
  // last agent *message* response; the runtime writes one message row per
  // message). Emitting `§§ turn_msg=<id>` at the end of each turn group gives
  // an existing session the same coordinate the live path writes, so one
  // decoder serves both. Rows without a `turn_id` (legacy probes) contribute
  // no marker at all — the card degrades instead of inventing one.
  let groupTurnId = null;
  let groupTurnMsgId = null;
  const flushTurnGroup = () => {
    if (groupTurnId !== null && groupTurnMsgId) raw.push(`§§ turn_msg=${groupTurnMsgId}`);
    groupTurnId = null;
    groupTurnMsgId = null;
  };
  for (const m of src) {
    const turnId = m && typeof m.turnId === "string" && m.turnId ? m.turnId : null;
    if (turnId !== groupTurnId) {
      flushTurnGroup();
      groupTurnId = turnId;
    }
    const lines = _messageToLines(m);
    if (lines.length === 0) skipped++;
    raw.push(...lines);
    const role = m && typeof m.role === "string" ? m.role.toLowerCase() : "";
    if (role === "assistant" && typeof m.msgId === "string" && m.msgId) {
      groupTurnMsgId = m.msgId;
    }
  }
  flushTurnGroup();
  // Cap 1 — line count: keep the TAIL (recent history is what the user
  // switched TO see).
  let lines = raw.length > maxLines ? raw.slice(raw.length - maxLines) : raw.slice();
  // A front-truncation can orphan a tool block's indented output lines
  // (their "→ name" header fell off). Both parsers drop such orphans
  // silently; drop them here too so the stored chat has no dead lines.
  while (lines.length > 0 && /^\s{2,}\S/.test(lines[0])) lines.shift();
  // Cap 2 — total bytes: drop from the front while over budget.
  let total = lines.reduce((s, l) => s + _bytes(l), 0);
  while (lines.length > 1 && total > maxBytes) {
    total -= _bytes(lines[0]);
    lines.shift();
  }
  // Last resort: a single surviving line still over budget gets an explicit
  // truncation marker (never a silent full drop — that would read as
  // "switching does nothing", the exact bug this module exists to fix).
  let truncated = false;
  if (lines.length === 1 && _bytes(lines[0]) > maxBytes) {
    const MARKER = " …[truncated]";
    lines = [_byteTruncate(lines[0], maxBytes - _bytes(MARKER)) + MARKER];
    truncated = true;
  } else if (raw.length > 0 && lines.length < raw.length) {
    truncated = true;
  }
  return { lines, skipped, truncated };
}

// ============================================================
// loadTranscriptChatLines — switch-path convenience: legacy + v2 probes,
// then map with the default caps. Never throws (caller still wraps in
// try/catch as belt-and-braces, but a read failure lands here as ok:false).
// ============================================================
export function loadTranscriptChatLines(mcodeSid, opts = {}) {
  const r = readMcodeTranscript(mcodeSid, {
    ...opts,
    probes:
      Array.isArray(opts.probes) && opts.probes.length > 0
        ? opts.probes
        : [...LEGACY_TRANSCRIPT_PROBES, ...V2_DATA_JSON_PROBES],
  });
  if (!r.ok) return { ok: false, lines: [], reason: r.reason, error: r.error };
  const mapped = messagesToChatLines(r.messages, {
    maxLines: opts.maxLines,
    maxBytes: opts.maxBytes,
  });
  return {
    ok: true,
    lines: mapped.lines,
    source: r.source,
    probe: r.probe,
    messageCount: r.messages.length,
    skipped: mapped.skipped,
    truncated: mapped.truncated,
  };
}

// ============================================================
// mergeEngineTranscript — fold a fresh engine-DB read into the lines
// the browser already shows, instead of overwriting them.
// ============================================================
//
// Why this exists. `transcript-sync.js` polls the engine runtime DB so a
// conversation driven by ANOTHER client (the desktop app, the TUI, another
// agent) catches up in an open tab. The poll used to assign
// `cs.chat = read.lines` outright. That is correct for engine lines and
// catastrophic for everything the webui authors itself: the slash-command
// echo written by `interaction/commands.js` (`› /help`, `● 可用命令：…`,
// `● 当前 model=…`, `● 变更概览 …`) never reaches the engine, so the poll
// deleted it about four seconds after the user asked for it — and then
// persisted the deletion, so even a reload could not bring it back. Users
// saw `POST /api/cmd → 200`, the composer cleared, and nothing at all on
// screen (webui-parity 81 D-1).
//
// The rule. `read` is the SPINE: the engine's own view of the conversation,
// in order. `current` is what is already rendered. Walk both in lockstep;
// whenever a `current` line does not line up with the `read` line at the
// cursor, that line was authored by the webui and is kept, advancing only
// `current`. When `read` runs out first, the remainder of `current` is
// still webui-authored and is kept; when `current` runs out first, the
// remainder of `read` is engine content this tab has not seen yet (the
// foreign-client case the poll exists for) and is appended.
//
// One exception, added after that rule shipped: a `current` line that is a
// LOSSY MIRROR of the engine's own output is not authored content, it is a
// whitespace-folded copy of it, and keeping it alongside the engine's
// line-by-line version is what rendered every assistant answer, tool block and
// thinking chain twice. Such a line retires — the engine's lines take its
// place. The identification is a positive content-identity test described
// under "Retiring a lossy mirror" below; it never fires on a line the engine
// read does not already contain, so the slash-command echo this function was
// built to protect cannot be caught by it.
//
// The one assumption is that the engine APPENDS — it does not rewrite an
// already-emitted line. The switch path has always relied on that (it only
// backfills an empty or visibly-cumulative stored chat), and the merge adds
// no new dependency on it: a rewrite would surface as the old line being
// kept next to its replacement rather than being replaced. Nothing this
// server produces does that.
//
// Annotations are not conversation lines. `§§ processed_duration=Nms`,
// `§§ turn_msg=<assistantMessageId>` (webui-parity 83) and the slice-06
// `##tc:<toolCallId>` marker carry per-turn metadata; `decodeTranscript`
// consumes all three and none of them reaches the chat body. Each is written
// into the very array the browser reads — the `§§` pair by
// `mcode-{acp,exec}.js#finalize`, `##tc:` by the tool-call branch of the ACP
// stream callback — and the v2 backfill synthesises the same `§§` lines from
// the message rows' `turn_id` / `msg_id` columns, so an annotation is
// routinely present in `read` and absent from `current` for a tab whose chat
// was recorded before its marker shipped.
//
// Such a line is emitted where the ENGINE put it — at the cursor, before the
// `current` line that failed to line up — never at the tail. Position is the
// whole contract: the decoder resolves an annotation onto the assistant block
// above it, so a relocated `§§ turn_msg=` hands the turn coordinate to a later
// block (a `/status` echo would answer with another turn's file diff), and a
// transcript recorded without markers would otherwise be replayed twice, once
// annotated and once not.
//
// Capped reads (400 lines / 200KB) are the caller's concern, not this
// function's: `transcript-sync.js` skips a capped read that would shrink
// the view, so a truncated `read` here is always a prefix-preserving
// window and every line it dropped is a line the engine no longer returns.
//
// Server-written turn metadata. Matched by prefix, not by an exact key
// list: a new marker has to be recognised here the day it is written, and
// the alternative — a whitelist that misses one — degrades silently into
// the misplacement the comment above rules out.
const ANNOTATION_LINE = /^(?:§§\s|##tc:)/;

// ============================================================
// Retiring a lossy mirror
// ============================================================
//
// The rule above keeps every `current` line the engine did not match. That
// is right for the lines this server authors and wrong for the lines it
// MIRRORS. While a turn streams, `mcode-acp.js` (and the runtime-transport
// twin, and `routes/chat.js` on finalize) write a lossy copy of the engine's
// own output into the very array the browser reads:
//
//   · an answer or a thinking segment is flattened to ONE line
//     (`r.answer.replace(/\n+/g, " ").trim()`), where the engine keeps one
//     array entry per source line;
//   · a tool header is written as `→ bash` when the frame carried no
//     `rawInput`, where the engine writes `→ bash  {"command":…}`.
//
// Those two shapes can never be byte-equal to the engine's line-by-line copy,
// so the walk above classified every one of them as "webui-authored" and kept
// it — and then appended the engine's whole spine behind it. The user saw the
// assistant answer, the tool block and the thinking chain TWICE, and
// `persistCurrentChat` made the duplicate permanent. Reproduced on a live
// session: 81 stored lines, 14 of them a second copy of engine content that
// had not been there a minute earlier.
//
// The fix is to make a mirror RETIRE when the engine read proves it is one.
//
// The proof is content identity under whitespace folding, anchored at the
// lockstep cursor — not a shape heuristic:
//
//   · a prose mirror (`●`/`▲`/`›`/`○`) retires when the maximal run of engine
//     lines carrying the SAME glyph, starting at the cursor, folds — their
//     texts joined with a single space, all whitespace runs collapsed — to
//     exactly the mirror's folded text;
//   · a tool header retires when the engine line at the cursor is a header for
//     the same tool name; the whole indented block on both sides goes with it,
//     because the body the mirror wrote is the same lossy copy.
//
// Why this cannot mistake a genuinely short local message for a mirror: the
// engine must already contain that exact text at that exact cursor position.
// A local line the engine has never seen (`› /help`, `● 当前 model=…`,
// `● 可用命令：`, a `! [warn]` notice) has no fold to match and is kept, which
// is the #126 behaviour this function exists for. A local line that DOES fold
// onto engine text is the same sentence the engine already has, so retiring
// it removes a duplicate rather than content.
//
// Why the failure direction is safe: every judgement here is a positive
// identity test. When it misses — an answer with unusual spacing, a tool block
// the engine has not finished writing — the mirror is kept and the result is
// exactly the old double render, which is the bug we already had. No path in
// this function drops a line the engine read did not account for.

// One conversation line, split into its role glyph and its text. The glyphs
// are the four `lib/chat-line.js` writers use for prose; a `→ name` header is
// a tool block, not prose, and is handled separately.
const PROSE_LINE = /^(›|●|▲|○) (.*)$/;
// `→ name` with an optional two-space args tail. The name is the first
// whitespace-delimited token, so a mirror that lost its args still names the
// same tool as the engine's complete header.
const TOOL_HEADER = /^→ (\S+)/;
// The indented body of a tool block. A bare whitespace-only line counts: the
// streaming writer emits one as a block terminator (`"  "`), and cutting the
// body short there would leave the rest of the mirror stranded.
const INDENTED_LINE = /^\s{2,}/;

/** Collapse every whitespace run to one space and trim — the fold a lossy
 *  mirror applies, and the only normalisation applied to engine text. */
function _fold(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

/** End of the `current` line's block: the line itself plus any indented
 *  tool body under it. A prose line is never followed by an indented line, so
 *  this is the identity for the prose case. */
function _blockEnd(lines, at) {
  let k = at + 1;
  while (k < lines.length && INDENTED_LINE.test(lines[k])) k += 1;
  return k;
}

/** End of the maximal run of same-glyph prose lines starting at `at`. */
function _proseRunEnd(lines, at, glyph) {
  let k = at;
  while (k < lines.length) {
    const m = PROSE_LINE.exec(lines[k]);
    if (!m || m[1] !== glyph) break;
    k += 1;
  }
  return k;
}

/**
 * How many `dbLines` the `current` line at `i` is a lossy mirror of, or 0.
 *
 * Returns a span, not a boolean: the engine's own lines in that span are what
 * the caller emits, so a mirror spanning nine `▲` entries is replaced by all
 * nine, and none of them is appended a second time at the tail.
 */
function _mirrorSpan(haveLines, i, dbLines, j) {
  const line = haveLines[i];
  if (typeof line !== "string") return 0;

  const prose = PROSE_LINE.exec(line);
  if (prose) {
    const target = _fold(prose[2]);
    // A bare `● ` placeholder is a blank line of a multi-line message, not a
    // fold of anything; the engine emits those too and they pair by equality.
    if (!target) return 0;
    const end = _proseRunEnd(dbLines, j, prose[1]);
    if (end === j) return 0;
    const parts = [];
    for (let k = j; k < end; k += 1) parts.push(PROSE_LINE.exec(dbLines[k])[2]);
    return _fold(parts.join(" ")) === target ? end - j : 0;
  }

  const tool = TOOL_HEADER.exec(line);
  if (tool) {
    const head = TOOL_HEADER.exec(typeof dbLines[j] === "string" ? dbLines[j] : "");
    // Ordered consumption: the walk is in lockstep, so "the same tool name at
    // the cursor" already means the Nth `→ name` on each side are the same
    // call, however many calls of that name the turn made.
    if (!head || head[1] !== tool[1]) return 0;
    return _blockEnd(dbLines, j) - j;
  }

  return 0;
}

export function mergeEngineTranscript(read, current) {
  const dbLines = Array.isArray(read) ? read : [];
  const haveLines = Array.isArray(current) ? current : [];
  const merged = [];
  let i = 0; // cursor into haveLines
  let j = 0; // cursor into dbLines
  while (i < haveLines.length) {
    const line = haveLines[i];
    if (j < dbLines.length && dbLines[j] === line) {
      merged.push(line);
      i += 1;
      j += 1;
      continue;
    }
    // An annotation the tab does not carry is emitted in the engine's
    // position, and `current` keeps the cursor: it annotates the turn
    // just aligned, not the webui line that is about to be kept.
    if (j < dbLines.length && ANNOTATION_LINE.test(dbLines[j])) {
      merged.push(dbLines[j]);
      j += 1;
      continue;
    }
    // A lossy mirror of engine content the cursor is sitting on. The engine's
    // own lines take the mirror's place — emitted here, so the tab sees the
    // complete per-line version, and not re-appended at the tail below.
    const span = _mirrorSpan(haveLines, i, dbLines, j);
    if (span > 0) {
      for (let k = j; k < j + span; k += 1) merged.push(dbLines[k]);
      j += span;
      i = _blockEnd(haveLines, i);
      continue;
    }
    // Not the engine's line at this position — keep it and leave the
    // engine cursor alone so the next `have` line can still line up.
    merged.push(line);
    i += 1;
  }
  // Everything the engine has that this tab has not rendered yet.
  for (; j < dbLines.length; j += 1) merged.push(dbLines[j]);
  return merged;
}
