import type { TranscriptLine } from "./types";
// Slice 20 (webui-parity): `extractToolPaths` derives candidate file paths
// from a tool call's name + JSON arguments, since the engine's structured
// `tool_update.locations` is never emitted in normal operation (verified:
// 0 of 7,609 real tool calls). Kept in a separate module so the per-tool
// rules can be unit-tested in isolation and so the `@ path` source stays
// the wire contract this decoder owns.
import { extractToolPaths, normalisePath } from "./tool-paths";

/**
 * Decoder for the server's line-oriented transcript.
 *
 * The webui server holds the conversation as a flat array of strings and encodes
 * speaker and state as a leading glyph, with a trailing " ▍" marking the streaming
 * cursor. This module is the only place that knows that encoding: everything above
 * it works with `TranscriptBlock` values.
 *
 * The glyph vocabulary and the order in which the markers are tested are a fixed
 * wire contract with the server's chat-line mapper (`server/lib/transcript.js`),
 * so any line the server emits decodes to the block it intended here. When the
 * server grows a structured message contract, this file is the single swap point.
 */

export type BlockRole =
  | "user"
  | "assistant"
  | "system"
  | "plan"
  | "ask"
  | "goal"
  | "todo"
  | "thinking"
  | "tool";

export interface TranscriptBlock {
  role: BlockRole;
  text: string;
  /** True for the trailing assistant block while tokens are still arriving. */
  streaming?: boolean;
  /**
   * Optional timestamp (ms epoch) for the turn. The transcript stream does not
   * currently carry per-line timestamps, so this is left undefined in practice;
   * the message action row simply hides its clock when it is.
   */
  ts?: number;
  /** Todo blocks only: the leading glyph, normalised to done/doing/failed/info. */
  todoState?: "done" | "doing" | "failed" | "info";
  /** Tool blocks only: the tool name from the `→ name` header. */
  toolName?: string;
  /** Tool blocks only: the raw arguments as they appear after the name. */
  toolArgs?: string;
  /** Tool blocks only: the run state line the server writes (`[completed]` etc.). */
  toolStatus?: string;
  /** Tool blocks only: output lines, with the server's two-space indent removed. */
  toolOutput?: string[];
  /** Tool blocks only: local paths the tool touched (the server's `@ path` lines). */
  toolPaths?: string[];
  /**
   * Tool blocks only: the runtime tool call id attached by the decoder
   * when it sees a `##tc:<id>` marker line immediately before the
   * `→ name` header. The ToolCard uses this to look up the precise
   * `recentSubagents[]` entry for THIS dispatch (matching by tool
   * NAME alone would badge every `→ task` line with the newest
   * child). Optional for older sessions whose chat predates the
   * marker; the renderer falls back to the newest entry in that case.
   */
  toolCallId?: string;
  /**
   * Assistant blocks only: total turn wall-clock duration in milliseconds, attached
   * by `decodeTranscript` when it encounters a `§§ processed_duration=Nms` marker
   * line in the transcript (server writes the marker at prompt finalise in
   * `server/lib/mcode-{acp,exec}.js#finalize`). The renderer reads this for the
   * upstream `turn_process_disclosure` collapse bar.
   */
  processedDuration?: number;
  /**
   * Assistant blocks only: the engine-side turn coordinate — the msg_id of
   * this turn's last assistant message, which is the value the runtime
   * persisted as `local_runtime_turn_diffs.assistant_message_id` for the turn.
   * Attached by `decodeTranscript` from the `§§ turn_msg=<id>` marker the
   * server writes at prompt finalise (`server/lib/mcode-acp.js#finalize`) and
   * from the same marker `server/lib/transcript.js` synthesises when it
   * backfills an existing session from the v2 message rows.
   *
   * Absent for a turn with no marker: sessions recorded before the marker
   * shipped, sessions read through the legacy transcript probe (no coordinate
   * columns), and the exec escape transport (no message ids on the wire).
   * Callers MUST degrade honestly when it is missing — querying the turn-diff
   * endpoint without it would return the engine's *latest* turn, i.e. another
   * turn's numbers.
   */
  assistantMessageId?: string;
}

/** Leading glyphs that begin a new block. */
const BLOCK_START = /^[›>●•○◯◎✓✔◌✗✘×▲!→]/;
const PLAN_HEADING = /^Plan\s*[:：]/i;
const ASK_HEADING = /^Ask\b/i;
const GOAL_HEADING = /^[◎]\s*Goal\b/i;

const USER_LINE = /^[›>]\s+(.*)$/;
/** Tool header: `→ name  {json}` (arguments optional). */
const TOOL_LINE = /^→\s+(\S+)\s*(.*)$/;
/** Thinking: `▲ text`. */
const THINKING_LINE = /^▲\s+(.*)$/;
/**
 * Tool body lines. The server writes them indented by two spaces — the status
 * line `[completed]`, the raw output, and `@ /path` entries for touched files.
 */
const TOOL_BODY = /^\s{2,}\S/;
/**
 * Orphan tool-body protocol shape — `  [status]`, `  @ /path`, `  ! error`
 * arriving with no preceding `→ name` header. The carver-out in
 * `decodeTranscript`'s fall-through matches this so a stray status line can
 * never become a `chat.system` block; arbitrary indented prose (which has
 * no leading protocol glyph) is not affected.
 */
const ORPHAN_TOOL_BODY = /^\s{2,}(?:\[|@|!)/;
const TOOL_STATUS_LINE = /^\[([a-z_]+)\]$/;
const TOOL_PATH_LINE = /^@\s*(.+)$/;
const ASSISTANT_LINE = /^[●•]\s+(.*)$/;
const TODO_LINE = /^([✓✔○◌◯✗✘×])\s+(.+)$/;
/**
 * Server-written turn metadata: `§§ processed_duration=Nms`.
 *
 * Appended by `server/lib/mcode-{acp,exec}.js` at prompt finalise so the webui
 * can attach `processedDuration` to the matching assistant block and show the
 * upstream `turn_process_disclosure` bar. `§§` is deliberately outside the
 * glyph vocab so the decoder can recognise and consume it without polluting
 * the block stream.
 */
const TURN_PROCESS_LINE = /^§§\s+processed_duration=(\d+)(ms)?$/;
/**
 * Server-written turn coordinate: `§§ turn_msg=<assistantMessageId>`.
 *
 * webui-parity 83. The engine persists a turn's file-change record under the
 * msg_id of that turn's last assistant message, and the ACP wire already
 * carries that id — the server used to drop it. It is written at prompt
 * finalise next to `processed_duration`, and the transcript backfill
 * synthesises the same line from the runtime's `turn_id` / `msg_id` columns,
 * so one marker serves both the live and the restored path.
 *
 * The decoder consumes it (it never appears in the rendered chat body) and
 * attaches the id to the turn's assistant block, which is what lets the
 * 「已编辑 N 个文件」 card ask the engine for THIS turn's diff instead of
 * guessing a turn ordinal.
 */
const TURN_MESSAGE_ID_LINE = /^§§\s+turn_msg=(\S+)$/;
/**
 * Slice 06 (Agent Team): server-written toolCallId marker.
 *
 * `server/lib/mcode-acp.js#applyToolUpdate` (and the tool_call branch of
 * the stream callback) writes `##tc:<toolCallId>` as a separate chat
 * line immediately BEFORE the `→ name` header. The decoder consumes it
 * and attaches the id to the following tool block, so the ToolCard can
 * match the block against `recentSubagents[]` by id (NOT by tool name)
 * — a session with multiple subagent dispatches would otherwise badge
 * every `→ task` line with the newest child, which is wrong.
 *
 * Older sessions written before this marker shipped simply lack it;
 * `ToolCard` falls back to the newest `recentSubagents` entry when
 * `toolCallId` is missing.
 */
const TOOL_CALL_ID_LINE = /^##tc:(\S+)$/;

/** Server text that is really a system notice, even under a todo glyph. */
const SYSTEM_NOTICE = /^(?:\[(?:error|warning|info|system)\]\s*)|(?:Questionnaire|requires.*(?:user input|interactive))/i;

/** The streaming cursor the server appends while a reply is still arriving. */
const STREAM_CURSOR = /\s▍$/;

const TODO_STATE: Record<string, TranscriptBlock["todoState"]> = {
  "✓": "done",
  "✔": "done",
  "◌": "doing",
  "○": "info",
  "◯": "info",
  "✗": "failed",
  "✘": "failed",
  "×": "failed",
};

function isBlockStart(line: string): boolean {
  return (
    BLOCK_START.test(line) ||
    PLAN_HEADING.test(line.trim()) ||
    ASK_HEADING.test(line.trim())
  );
}

/**
 * Collect a run of continuation lines up to the next block start.
 * Returns the joined text and the index of the next unconsumed line.
 */
function collectContinuation(
  lines: readonly string[],
  from: number,
): { text: string[]; next: number } {
  const collected: string[] = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line === "") break;
    if (isBlockStart(line)) break;
    collected.push(line);
    i += 1;
  }
  return { text: collected, next: i };
}

/**
 * Decode transcript lines into renderable blocks.
 *
 * Marker precedence is plan → ask → goal → user → assistant → todo/system. That
 * order is load-bearing: `○` is both a todo and a system/warning glyph, and the
 * todo branch must lose to the system branch when the text reads like a notice.
 */
export function decodeTranscript(
  lines: readonly TranscriptLine[],
  opts: { workspaceDir?: string | null } = {},
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let current: TranscriptBlock | null = null;
  // Slice 06 (Agent Team): carry the most recently seen `##tc:<id>`
  // marker until the next tool block picks it up. The marker is
  // emitted by the server on every `→ name` line whose `toolCallId`
  // is known — without it the ToolCard cannot correlate a tool block
  // with its `recentSubagents[]` entry by id (matching by tool name
  // alone would badge every `→ task` line with the newest child).
  let pendingToolCallId: string | undefined;

  const flush = () => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  /**
   * Attach a per-turn server marker to the block that owns the turn: the
   * currently open assistant block, or — when the turn already closed (a
   * trailing system note, a tool line) — the most recently flushed assistant
   * block. Shared by the `processed_duration` and `turn_msg` markers so both
   * resolve the same owner the same way.
   */
  const attachToTurnAssistant = (apply: (block: TranscriptBlock) => void) => {
    if (current && current.role === "assistant") {
      apply(current);
      return;
    }
    for (let j = blocks.length - 1; j >= 0; j--) {
      const prev = blocks[j];
      if (prev && prev.role === "assistant") {
        apply(prev);
        return;
      }
    }
  };

  /** Append a line to the open block, or open a new one. */
  const pushText = (role: BlockRole, text: string) => {
    if (current && current.role === role) {
      current.text = `${current.text}\n${text}`;
      return;
    }
    flush();
    current = { role, text };
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw === undefined) break;
    const line = raw;
    const trimmed = line.trim();

    if (trimmed === "") {
      // Blank *and* whitespace-only lines are separators, not content: the server
      // emits bare newlines between turns, and an indented blank line would
      // otherwise open a system block holding nothing but spaces.
      i += 1;
      continue;
    }

    // --- per-turn metadata emitted by `server/lib/mcode-{acp,exec}.js#finalize`.
    //
    // Attached to the *currently open* assistant block (the one whose `●`
    // header precedes the marker) or, if no block is open, to the most
    // recently flushed assistant block. Consumed here so the marker never
    // becomes visible content.
    const turnProcess = TURN_PROCESS_LINE.exec(line);
    if (turnProcess) {
      const dur = Number.parseInt(turnProcess[1] ?? "", 10);
      if (Number.isFinite(dur) && dur > 0) {
        attachToTurnAssistant((block) => {
          block.processedDuration = dur;
        });
      }
      i += 1;
      continue;
    }

    // --- webui-parity 83 turn coordinate (`§§ turn_msg=<id>`).
    //
    // Same owner resolution as the duration marker, one step later in the
    // stream: the server writes both at prompt finalise. Older transcripts
    // simply lack the line — `assistantMessageId` stays undefined and the
    // turn-diff card degrades to the path-only rendering.
    const turnMessageId = TURN_MESSAGE_ID_LINE.exec(line);
    if (turnMessageId) {
      const id = turnMessageId[1] ?? "";
      if (id) {
        attachToTurnAssistant((block) => {
          block.assistantMessageId = id;
        });
      }
      i += 1;
      continue;
    }

    // --- slice 06 toolCallId marker (`##tc:<id>`).
    //
    // Consumed (it never appears in the rendered chat body) and the id
    // is parked into `pendingToolCallId` until the next tool block
    // opens — that block picks it up and exposes it as `toolCallId`.
    // Older sessions whose chat was written before this marker shipped
    // simply lack the line; `pendingToolCallId` stays undefined and
    // the ToolCard falls back to the newest `recentSubagents` entry.
    const tcMarker = TOOL_CALL_ID_LINE.exec(line);
    if (tcMarker) {
      pendingToolCallId = tcMarker[1];
      i += 1;
      continue;
    }

    // --- block-style sections, driven by the state snapshot as well as the text
    if (PLAN_HEADING.test(trimmed)) {
      flush();
      const { text, next } = collectContinuation(lines, i + 1);
      blocks.push({ role: "plan", text: [line, ...text].join("\n") });
      i = next;
      continue;
    }
    if (ASK_HEADING.test(trimmed) || /^◎\s*Ask\b/i.test(trimmed)) {
      flush();
      const { text, next } = collectContinuation(lines, i + 1);
      blocks.push({ role: "ask", text: [line, ...text].join("\n") });
      i = next;
      continue;
    }
    if (GOAL_HEADING.test(trimmed)) {
      flush();
      const { text, next } = collectContinuation(lines, i + 1);
      blocks.push({ role: "goal", text: [line, ...text].join("\n") });
      i = next;
      continue;
    }

    // --- speaker lines
    const user = USER_LINE.exec(line);
    if (user) {
      // `current`/`pushText` keep consecutive same-speaker lines in one block.
      pushText("user", user[1] ?? "");
      i += 1;
      continue;
    }

    const assistant = ASSISTANT_LINE.exec(line);
    if (assistant) {
      pushText("assistant", assistant[1] ?? "");
      i += 1;
      continue;
    }

    // --- todo / system glyphs
    const todo = TODO_LINE.exec(line);
    if (todo) {
      const body = todo[2] ?? "";
      if (SYSTEM_NOTICE.test(body)) {
        pushText("system", body);
      } else {
        flush();
        blocks.push({
          role: "todo",
          text: body,
          todoState: TODO_STATE[todo[1] ?? ""] ?? "info",
        });
      }
      i += 1;
      continue;
    }

    // --- thinking (`▲ text`).
    //
    // One thought is one block: consecutive `▲` lines are the same thought
    // (the grammar emits one entry per output line), so they merge with "\n"
    // exactly like prose does. The activity summary counts *runs* of thinking
    // blocks, so a thought is still reported once.
    const thinking = THINKING_LINE.exec(line);
    if (thinking) {
      pushText("thinking", thinking[1] ?? "");
      i += 1;
      continue;
    }

    // --- tool call: the `→ name {args}` header plus the indented body the server
    // writes beneath it (status, output, `@ path` lines). The body belongs to this
    // tool, so it is consumed here rather than treated as continuation text.
    const tool = TOOL_LINE.exec(line);
    if (tool) {
      flush();
      const block: TranscriptBlock = {
        role: "tool",
        text: line,
        toolName: tool[1] ?? "tool",
        toolArgs: (tool[2] ?? "").trim(),
        toolOutput: [],
        toolPaths: [],
        // Slice 06: attach the parked toolCallId marker (cleared so the
        // next tool block starts fresh — a marker that never picked up
        // its block on the way through a malformed transcript is
        // intentionally not retained).
        ...(pendingToolCallId ? { toolCallId: pendingToolCallId } : {}),
      };
      pendingToolCallId = undefined;
      let j = i + 1;
      while (j < lines.length) {
        const body = lines[j];
        if (body === undefined) break;
        if (!TOOL_BODY.test(body)) break;
        const inner = body.replace(/^\s{2}/, "");
        const status = TOOL_STATUS_LINE.exec(inner);
        const path = TOOL_PATH_LINE.exec(inner);
        if (status) block.toolStatus = status[1];
        else if (path) block.toolPaths?.push((path[1] ?? "").trim());
        else block.toolOutput?.push(inner);
        j += 1;
      }
      // Slice 20 (webui-parity): merge the `  @ path` source with the
      // tool-arguments-derived one, deduped through the same
      // `normalisePath` the extractor uses. Two cases drive the merge:
      //
      //   1. The engine does not emit `tool_update.locations` in normal
      //      operation (verified against the runtime sqlite: 0 of
      //      7,609 tool calls). Without this merge the chip row is
      //      ALWAYS empty in real sessions — exactly the bug this
      //      slice fixes.
      //
      //   2. If the engine DOES start emitting `locations` later, the
      //      `@ path` lines still win for the absolute path they
      //      already carry, and the extractor picks up any relative
      //      paths the agent typed (e.g. `src/foo.ts` against the
      //      workspace dir) the server never sees.
      //
      // Both sources land in `toolPaths`; the dedupe key is the
      // normalised form (so `/abs/foo` from `@ path` matches `/abs/foo`
      // produced by absolutising a relative args path).
      const derived = extractToolPaths(block.toolName, block.toolArgs, opts);
      if (derived && derived.length > 0) {
        const existing = block.toolPaths ?? [];
        const seen = new Set<string>();
        const merged: string[] = [];
        for (const raw of existing) {
          const norm = normalisePath(raw, opts.workspaceDir) ?? raw;
          if (!seen.has(norm)) {
            seen.add(norm);
            merged.push(norm);
          }
        }
        for (const candidate of derived) {
          if (!seen.has(candidate)) {
            seen.add(candidate);
            merged.push(candidate);
          }
        }
        block.toolPaths = merged;
      } else if (block.toolPaths && block.toolPaths.length > 0) {
        // No derived paths — still normalise the `@ path` source so a
        // relative `  @ src/foo.ts` lands as `/ws/src/foo.ts` in the
        // chip row and the file-open click resolves.
        block.toolPaths = block.toolPaths.map(
          (p) => normalisePath(p, opts.workspaceDir) ?? p,
        );
      }
      blocks.push(block);
      i = j;
      continue;
    }

    // --- anything else is continuation text for the open block, or a system line
    //
    // Orphan tool-body protocol lines — `  [completed]` status, `  @ /path`
    // location, `  ! error` — without a preceding `→ name` header to belong
    // to cannot be attributed to any tool. They arrive when
    // `server/lib/mcode-acp.js#applyToolUpdate` writes body lines for a
    // `toolCallId` whose `tool_call` header never made it (webui attached
    // mid-stream, or the update was the first frame seen for the tool).
    // Without an owner they belong in neither a tool block nor a system
    // block — drop them rather than fabricate a `chat.system` row out of
    // raw protocol text. Plain indented continuation prose (`  text` without
    // a protocol prefix) is NOT covered here, so the existing
    // `"  indented continuation"` continuation contract is preserved.
    if (ORPHAN_TOOL_BODY.test(line)) {
      i += 1;
      continue;
    }
    if (current) {
      current.text = `${current.text}\n${line}`;
    } else {
      current = { role: "system", text: line };
    }
    i += 1;
  }

  flush();

  // The streaming cursor belongs to the server's text, not to the message: strip it
  // and report the state, so the renderer can draw its own cursor.
  const last = blocks[blocks.length - 1];
  if (last && last.role === "assistant" && STREAM_CURSOR.test(last.text)) {
    last.text = last.text.replace(STREAM_CURSOR, "");
    last.streaming = true;
  }

  return blocks;
}

/**
 * The "activity" summary upstream shows above an assistant turn.
 *
 * Upstream does not render a raw count pair. Each tool declares, in its descriptor,
 * a `getSummaryContributions()` entry carrying a *category*; the header then
 * aggregates those per category, orders them by the category priorities below, keeps
 * at most `MAX_SUMMARY_CATEGORIES`, and renders each with the matching
 * `tool_call.summary.*` message, joined with ", ". That is why the desktop says
 * 「查看 2 个文件, 执行 1 条命令」 rather than 「使用 3 个工具」.
 */
export interface ActivitySummary {
  /** Thought *runs*, not thinking blocks — see the note on `summarizeActivity`. */
  thinking: number;
  tools: number;
  /** Per-category counts, already ordered by priority and capped. `file-edit` is
   *  a distinct-file count, not a call count — see `summarizeActivity`. */
  contributions: { category: SummaryCategory; count: number; iconType: SummaryIconType }[];
  /**
   * A tool with no terminal status line yet, i.e. the one currently running.
   * Present only while the turn streams; upstream labels that state with
   * `tool_call.summary.active_tool` instead of the contribution list.
   */
  activeTool?: string;
  /**
   * The icon type matching the leading contribution (or the active tool when
   * streaming). The ActivityGroup header uses this to render the category
   * glyph upstream puts to the left of the label (`data-tool-icon-type`,
   * `data-testid="activity-group-header-icon"`).
   */
  iconType: SummaryIconType;
}

/**
 * The category-icon names upstream picks from the registry's iconType table.
 * The set is bounded — only nine categories ever appear — so we type it
 * literally and use `SummaryIconType` everywhere the header/tool needs a glyph.
 * The Icon component falls back to an emoji placeholder when the name is not
 * in `icons.tsx`; precise upstream SVGs land in a follow-up commit.
 */
export type SummaryIconType =
  | "plugin"
  | "file-edit"
  | "edit"
  | "agent"
  | "skill"
  | "web"
  | "search"
  | "thinking"
  | "file"
  | "command"
  | "tool"
  | "logo"
  | "bot"
  | "summary"
  | "code"
  | "memory"
  | "alert";

/**
 * Upstream's category order (`maxCategories: 3`, priorities 1..9), the
 * `tool_call.summary.*` message each one renders through, and the
 * `data-tool-icon-type` it picks for the leading glyph. Copied from the
 * desktop bundle's summary module (`90321` byte 2133850).
 */
const SUMMARY_CATEGORY_ORDER: {
  category: string;
  key: string;
  iconType: SummaryIconType;
}[] = [
  { category: "plugin", key: "activity.usedPlugins", iconType: "logo" },
  { category: "file-edit", key: "activity.editedFiles", iconType: "edit" },
  { category: "agent", key: "activity.agentActions", iconType: "bot" },
  { category: "skill", key: "activity.readSkills", iconType: "skill" },
  { category: "web", key: "activity.fetchedWebs", iconType: "web" },
  { category: "thinking", key: "activity.thoughtSteps", iconType: "thinking" },
  { category: "file", key: "activity.viewedFiles", iconType: "file" },
  { category: "command", key: "activity.ranCommands", iconType: "command" },
  { category: "tool", key: "activity.usedTools", iconType: "tool" },
];

export type SummaryCategory = (typeof SUMMARY_CATEGORY_ORDER)[number]["category"];

/** Upstream's cap: at most this many contribution lines in the header. */
export const MAX_SUMMARY_CATEGORIES = 3;

/** Category → i18n key, for the renderer. */
export const SUMMARY_CATEGORY_KEY: Record<string, string> = Object.fromEntries(
  SUMMARY_CATEGORY_ORDER.map((entry) => [entry.category, entry.key]),
);

/**
 * Tool name → category.
 *
 * Upstream gets this from a per-tool descriptor registry (one declaration per tool,
 * each stating its own contributions). Reproducing that table wholesale is out of
 * scope, so this is a deliberately *conservative* name table: the names below are the
 * ones whose category is unambiguous, and anything unrecognised falls through to
 * `tool`. Falling through under-states what ran (「使用 N 个工具」) instead of
 * mis-stating it (claiming files were edited when none were), which is the safe
 * direction to be wrong in.
 *
 * `thinking` is not here: it is counted from thinking blocks, not tool names.
 */
const TOOL_CATEGORY: Record<string, SummaryCategory> = {
  bash: "command",
  shell: "command",
  run_command: "command",
  execute_command: "command",
  terminal: "command",

  read_file: "file",
  read: "file",
  view_file: "file",

  edit: "file-edit",
  edit_file: "file-edit",
  write_file: "file-edit",
  create_file: "file-edit",
  apply_patch: "file-edit",
  multi_edit: "file-edit",
  notebook_edit: "file-edit",

  web_search: "web",
  web_fetch: "web",

  skill: "skill",

  task: "agent",
  agent: "agent",

  plugin: "plugin",
};

/**
 * Tool name → iconType. Mirrors upstream's `iconByName` lookup in the tool
 * registry (`90321-77b4136b479ca1e4.js` byte 2131600); the names are
 * lower-cased before the lookup. The fallback `"tool"` is the registry's
 * default branch and matches what the desktop puts at the leading edge of
 * an unrecognised call.
 */
const TOOL_ICON: Record<string, SummaryIconType> = {
  bash: "command",
  shell: "command",
  command: "command",
  run_command: "command",
  execute_command: "command",
  terminal: "command",
  python: "command",
  python3: "command",

  read: "file",
  read_file: "file",
  view_file: "file",
  ls: "file",

  edit: "edit",
  edit_file: "edit",
  write_file: "edit",
  write: "edit",
  create_file: "edit",
  apply_patch: "edit",
  multi_edit: "edit",
  notebook_edit: "edit",
  str_replace: "edit",
  file_edit: "edit",

  find: "search",
  glob: "search",
  grep: "search",
  search: "search",
  workspace_semantic_search: "search",

  web_search: "web",
  web_fetch: "web",
  browse: "web",

  skill: "skill",
  read_skill: "skill",

  task: "agent",
  agent: "agent",
  code_review: "code",

  plugin: "logo",
};

export function iconByName(toolName: string | undefined): SummaryIconType {
  if (!toolName) return "tool";
  return TOOL_ICON[toolName.trim().toLowerCase()] ?? "tool";
}

/**
 * Whether `TOOL_CATEGORY` reads this tool name as a file edit.
 *
 * Exported so the edited-files card (ticket 77) and the activity summary cannot
 * drift into two different notions of "an edit": both ask this one predicate.
 * A name outside the table is *not* an edit, which is the safe direction — the
 * summary under-states what ran rather than claiming files changed when none
 * did.
 */
export function isFileEditTool(toolName: string | undefined): boolean {
  return TOOL_CATEGORY[(toolName ?? "tool").trim().toLowerCase()] === "file-edit";
}

/**
 * Identity for "the same file named twice".
 *
 * Lives here, beside `isFileEditTool`, for the same reason: the activity-group
 * summary and the turn's edited-files card both count files, and two copies of
 * this function are two calibers. Separators are folded so a Windows-style
 * `a\b.ts` and an `a/b.ts` do not read as two files. Case is left alone on
 * purpose: macOS and Linux are case-sensitive, and folding case there would
 * merge two genuinely distinct files into one row.
 */
export function editedFileKey(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

/**
 * Count the activity in a run of blocks (see `groupActivity`).
 *
 * `thinking` counts **thoughts**, not thinking blocks. The grammar writes one
 * block per output line, so a thought that spans eight lines used to be reported
 * as "思考 8 次" — the counts did not match the work that was actually done (the
 * reported "思考次数…数量也对不上"). A thought here is a maximal run of adjacent
 * thinking blocks, which is what a reader counts.
 *
 * `tools` stays a block count: the grammar already writes exactly one `→ name`
 * header per tool call, and its output lines are folded into that block by the
 * decoder.
 *
 * The `file-edit` contribution is the one category that is **not** a call
 * count. It counts the **distinct files** the run's edit tools named, keyed by
 * `editedFileKey` — the sentence behind it is 「已编辑 N 个文件」, whose subject
 * is a file. Five edits to one file used to read 「已编辑 5 个文件」 in the
 * group header while the turn's card listed that one file: the same turn, two
 * numbers, one of them false. An edit call that named no path contributes
 * nothing rather than a phantom row, which is the same under-statement rule
 * `isFileEditTool` follows. How many calls ran is not lost: it is `tools`,
 * which the turn bar reports as 「用了 N 次工具」.
 */
export function summarizeActivity(blocks: readonly TranscriptBlock[]): ActivitySummary {
  let thinking = 0;
  let tools = 0;
  let previousWasThinking = false;
  let activeTool: string | undefined;
  const counts = new Map<string, number>();
  const editedFiles = new Set<string>();

  const add = (category: string) => counts.set(category, (counts.get(category) ?? 0) + 1);

  for (const block of blocks) {
    const isThinking = block.role === "thinking";
    if (isThinking) {
      if (!previousWasThinking) {
        thinking += 1;
        add("thinking");
      }
    } else if (block.role === "tool") {
      tools += 1;
      const name = (block.toolName ?? "tool").trim();
      const category = TOOL_CATEGORY[name.toLowerCase()] ?? "tool";
      if (category === "file-edit") {
        for (const path of block.toolPaths ?? []) {
          const key = editedFileKey(path);
          if (key) editedFiles.add(key);
        }
      } else {
        add(category);
      }
      // No status line yet means the call is still in flight. The *last* such tool
      // is the active one, so later blocks overwrite earlier ones.
      if (!block.toolStatus && name) activeTool = name;
    }
    previousWasThinking = isThinking;
  }

  // Files the run's edit tools named, resolved before the priority filter: an
  // edit call with no nameable path leaves the set empty and the category out
  // of `counts`, so the group says nothing about it rather than 「0 个文件」.
  if (editedFiles.size > 0) counts.set("file-edit", editedFiles.size);

  const contributions = SUMMARY_CATEGORY_ORDER.filter((entry) => counts.has(entry.category))
    .slice(0, MAX_SUMMARY_CATEGORIES)
    .map((entry) => ({
      category: entry.category,
      count: counts.get(entry.category) ?? 0,
      iconType: entry.iconType,
    }));

  // The leading icon: while streaming, upstream renders `iconByName(activeTool)`
  // — fall back to the active tool's category icon if the tool name is one we
  // recognise, otherwise the generic "tool" icon. Once the turn settles we use
  // the highest-priority contribution's iconType (the first one we kept).
  const iconType = activeTool
    ? iconByName(activeTool)
    : contributions[0]?.iconType ?? "tool";

  return activeTool
    ? { thinking, tools, contributions, activeTool, iconType }
    : { thinking, tools, contributions, iconType };
}

/** A renderable unit: either a single block, or a folded activity run. */
export type RenderUnit =
  | { kind: "block"; block: TranscriptBlock }
  | { kind: "activity"; blocks: TranscriptBlock[]; summary: ActivitySummary };

/**
 * Fold each run of thinking/tool blocks into one activity unit.
 *
 * Upstream renders those runs as a single collapsible group with a summary line
 * ("Thought N times, used M tools") rather than one element per step, so the folding
 * happens here — beside the decode, where the sequence is known — instead of in the
 * component.
 */
export function groupActivity(blocks: readonly TranscriptBlock[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  let run: TranscriptBlock[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    units.push({ kind: "activity", blocks: run, summary: summarizeActivity(run) });
    run = [];
  };

  for (const block of blocks) {
    if (block.role === "thinking" || block.role === "tool") {
      run.push(block);
      continue;
    }
    flushRun();
    units.push({ kind: "block", block });
  }
  flushRun();
  return units;
}
