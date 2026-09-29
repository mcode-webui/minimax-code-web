/**
 * Tool-call projection — the pure derivation layer for the tool card
 * (ticket 46, PR3 — D4). Ported from the reference implementation's
 * `src/client/projection/tool-projection.ts`, reshaped for THIS wire:
 * the decoded transcript hands the renderer flat fields
 * (`toolName` / `toolArgs` / `toolStatus` / `toolOutput`) instead of the
 * reference's structured tool records, so each reader takes those
 * primitives directly. No React, no transport — the unit tests drive
 * every table here.
 *
 * Reference deltas that are deliberate, not oversights:
 *
 *   - `normalizeToolStatus(undefined)` returns `"running"`, not the
 *     reference's `"unknown"`. The reference consumes records that carry
 *     an explicit status field; this wire writes the `→ name` header
 *     first and the `[status]` line only when the call settles, so a
 *     tool block with no status line yet IS in flight — the same rule
 *     `isActivityGroupActive` already encodes.
 *   - Labels are bilingual `[zh, en]` pairs. The reference hardcodes the
 *     Chinese desktop copy; this frontend is bilingual by contract, so
 *     the zh column is the reference copy verbatim and the en column is
 *     the matching English phrase.
 */

/** The five reference lifecycle states plus `unknown`. */
export type WebuiToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "cancelled"
  | "unknown";

/**
 * Normalise a raw tool status onto the five-state vocabulary.
 *
 * Accepts the wire's status-line strings (`[completed]` / `[failed]` /
 * `[in_progress]`), the reference runtime's spellings, and Desktop's
 * numeric codes (1 running, 2 completed, 3 error, 4/5 pending —
 * Preparing/Prepared fall back to pending, matching the reference
 * formatter).
 */
export function normalizeToolStatus(
  raw: string | number | undefined | null,
): WebuiToolCallStatus {
  if (typeof raw === "number") {
    switch (raw) {
      case 1:
        return "running";
      case 2:
        return "completed";
      case 3:
        return "error";
      case 4:
      case 5:
        return "pending";
      default:
        return "unknown";
    }
  }
  if (typeof raw !== "string" || !raw.trim()) return "running";
  switch (raw.trim().toLowerCase()) {
    case "pending":
    case "queued":
      return "pending";
    case "running":
    case "in_progress":
    case "in-progress":
      return "running";
    case "done":
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "error":
    case "failed":
      return "error";
    case "cancelled":
    case "canceled":
    case "interrupted":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** i18n key for each labelled status. `unknown` has no copy — the
 *  reference renderer hides the status chip entirely for it. */
export const TOOL_STATUS_LABEL_KEY: Readonly<
  Record<Exclude<WebuiToolCallStatus, "unknown">, string>
> = {
  pending: "tool.status.pending",
  running: "tool.status.in_progress",
  completed: "tool.status.completed",
  error: "tool.status.failed",
  cancelled: "tool.status.cancelled",
};

/**
 * User-facing tool labels, `[zh, en]` per tool id. The zh column is the
 * reference desktop copy (`WEBUI_DESKTOP_TOOL_DISPLAY_LABELS` with the
 * legacy `labels` fallback merged in, desktop table winning on overlap);
 * template entries carrying `{{name}}` placeholders were dropped — this
 * renderer has no substitution site for them. Unrecognised names fall
 * back to 「工具 / Tool」 like the reference does.
 */
const TOOL_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  bash: ["终端", "Terminal"],
  terminal: ["终端", "Terminal"],
  command: ["终端", "Terminal"],
  shell: ["终端", "Terminal"],
  python: ["Python", "Python"],
  python3: ["Python", "Python"],
  execute: ["执行命令", "Run command"],
  execute_command: ["执行命令", "Run command"],

  read: ["读取文件", "Read file"],
  read_file: ["读取文件", "Read file"],
  read_image: ["读取图片", "Read image"],
  ls: ["列出目录", "List directory"],
  list_files: ["列出目录", "List directory"],
  find: ["查找文件", "Find files"],
  find_files: ["查找文件", "Find files"],
  glob: ["查找文件", "Find files"],

  write: ["写入文件", "Write file"],
  write_file: ["写入文件", "Write file"],
  edit: ["编辑文件", "Edit file"],
  edit_file: ["编辑文件", "Edit file"],
  str_replace: ["编辑文件", "Edit file"],

  grep: ["搜索", "Search"],
  search: ["搜索", "Search"],
  tool_search: ["查找工具", "Find tools"],
  find_tools: ["查找工具", "Find tools"],

  web_search: ["网页搜索", "Web search"],
  web: ["网页抓取", "Web fetch"],
  webfetch: ["网页抓取", "Web fetch"],
  web_fetch: ["网页抓取", "Web fetch"],

  matrix_mcp: ["处理媒体", "Process media"],
  mcp_call: ["MCP 工具", "MCP tool"],
  "archon.mcp.call": ["MCP 工具", "MCP tool"],
  browser: ["浏览器", "Browser"],
  mcp_browser: ["浏览器", "Browser"],
  "archon.browser.call": ["浏览器", "Browser"],
  deliver_asset: ["交付文件", "Deliver file"],
  "archon.asset.deliver": ["交付文件", "Deliver file"],
  "archon.communication.send": ["发送消息", "Send message"],
  website_deploy: ["部署网站", "Deploy site"],
  mavis: ["MiniMax Code", "MiniMax Code"],
  memory: ["读取与保存记忆", "Memory"],

  images_understand: ["理解图片", "Understand images"],
  image_understanding: ["理解图片", "Understand images"],
  understanding_images: ["理解图片", "Understand images"],
  image_synthesize: ["生成图片", "Generate image"],
  generate_image: ["生成图片", "Generate image"],
  matrix_generate_image: ["生成图片", "Generate image"],
  image_generation: ["生成图片", "Generate image"],
  images_search_and_download: ["搜索并下载图片", "Search & download images"],
  image_search: ["搜索图片", "Search images"],
  image_reverse_search: ["以图搜图", "Reverse image search"],
  image_source_lookup: ["查找图片来源", "Find image source"],

  submit_video_generation: ["生成视频", "Generate video"],
  query_video_generation: ["查询视频进度", "Query video progress"],
  check_video_progress: ["查询视频进度", "Query video progress"],
  gen_videos: ["生成视频", "Generate video"],
  batch_text_to_video: ["批量生成视频", "Batch video"],
  batch_generate_videos: ["批量生成视频", "Batch video"],
  batch_image_to_video: ["图片生成视频", "Image to video"],
  videos_understand: ["理解视频", "Understand videos"],
  video_understanding: ["理解视频", "Understand videos"],
  video_generation: ["生成视频", "Generate video"],

  get_voice_list: ["查看可用音色", "List voices"],
  batch_text_to_audio: ["批量语音合成", "Batch TTS"],
  batch_text_to_music: ["生成音乐", "Generate music"],
  synthesize_speech: ["文字转语音", "Text to speech"],
  batch_synthesize_speech: ["批量文字转语音", "Batch TTS"],
  audios_understand: ["理解音频内容", "Understand audio"],
  audio_understanding: ["理解音频", "Understand audio"],
  transcribe_audio: ["音频转文字", "Transcribe audio"],

  ask_user: ["用户确认", "User confirmation"],
  user_confirmation: ["用户确认", "User confirmation"],
  task: ["任务", "Task"],
  task_query: ["任务进度", "Task progress"],
  task_progress: ["任务进度", "Task progress"],
  task_output: ["任务结果", "Task result"],
  task_result: ["任务结果", "Task result"],
  task_stop: ["任务终止", "Stop task"],
  stop_task: ["任务终止", "Stop task"],

  todo_write: ["todowrite", "TodoWrite"],
  todowrite: ["todowrite", "TodoWrite"],

  create_goal: ["目标创建", "Create goal"],
  update_goal: ["目标更新", "Update goal"],
  get_goal: ["目标读取", "Read goal"],
};

/** The user-facing label for a tool call. Falls back to 「工具 / Tool」
 *  so the renderer never special-cases a missing name. */
export function toolCallLabel(
  name: string | undefined,
  locale: "zh" | "en",
): string {
  const key = (name ?? "").trim().toLowerCase();
  const entry = TOOL_LABELS[key];
  if (!entry) return locale === "zh" ? "工具" : "Tool";
  return locale === "zh" ? entry[0] : entry[1];
}

/** Tools whose resource path belongs on the summary row — the reference
 *  lifts it there for read-style calls only. */
const RESOURCE_PATH_TOOLS = new Set(["read", "read_file"]);

/**
 * The resource path for a read-style call, parsed out of the raw
 * `toolArgs` the wire carries after the tool name. Accepts a JSON
 * object (`{"file_path": "…"}` and the usual key spellings), a bare
 * JSON string (`"path/to/file"`), or a plain path string. Returns
 * `undefined` for every other tool or an unusable payload.
 */
export function toolResourcePath(
  name: string | undefined,
  args: string | undefined,
): string | undefined {
  const normalised = (name ?? "").trim().toLowerCase();
  if (!RESOURCE_PATH_TOOLS.has(normalised)) return undefined;
  const raw = (args ?? "").trim();
  if (!raw) return undefined;
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = raw;
  }
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "location"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** The display form of a resource path — its last segment. */
export function resourceDisplayName(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * The resource path a read-style summary row displays. `toolResourcePath`
 * first (the reference derivation — from the args); when the wire wrote
 * no args after the tool name (verified live: this engine's `→ read`
 * header carries none and the path arrives as a `@ path` body line the
 * decoder already collected into `toolPaths`), the first collected path
 * stands in. Non-read tools never get one.
 */
export function toolSummaryResourcePath(
  name: string | undefined,
  args: string | undefined,
  paths: readonly string[],
): string | undefined {
  if (!RESOURCE_PATH_TOOLS.has((name ?? "").trim().toLowerCase())) return undefined;
  return toolResourcePath(name, args) ?? paths[0];
}

/** Characters a tool detail section may show before truncation. The
 *  reference clamps at 2000 with a literal `...` suffix. */
export const TOOL_DETAIL_CHAR_LIMIT = 2000;

/** Clamp an over-long detail body to the reference limit. */
export function clampDetailText(
  value: string,
  limit: number = TOOL_DETAIL_CHAR_LIMIT,
): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
