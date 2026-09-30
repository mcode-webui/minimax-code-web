// webui/server/lib/interaction/command-registry.js
// The declared command sets behind the two slash dispatch paths.
//
// Why a registry file: the dispatchers in commands.js are switch
// statements — their CASE LABELS are the contract, but a switch is not
// a list anyone can read. Before this file, "which commands does
// /api/cmd accept?" had exactly one answer (grep the switch) and the
// answer was wrong in the one place it mattered: routes/chat.js
// answered 200 {ok:true} for every input, so a command outside the
// switch (`/goal`, `/compact`, …) was dropped with a success code
// (webui-parity 62 D4). The 400 branch now needs the accepted set to
// build its message, the composer's routing needs it to decide which
// endpoint a typed slash input belongs to, and the browser must not
// carry a second copy of it. So the set is declared ONCE, here.
//
// Two sets, because the two endpoints are not the same surface:
//
//   CMD_BUTTON_COMMANDS — POST /api/cmd (handleCmdCommand). These take
//     no arguments: handleCmdCommand strips the leading slash and
//     matches the WHOLE remainder, so `/clear now` is not a member.
//   SEND_SLASH_COMMANDS — POST /api/send (handleLocalSlash). These are
//     typed-in commands with arguments (`/goal <text>`), and this set
//     exists only so the 400 branch can say "this one belongs to the
//     send path" instead of "unknown".
//
// DRIFT GUARD: a name added to either set without a matching case in
// commands.js (or a case added without a registry entry) fails
// webapp/test/slash-routing.test.ts, which parses both switch bodies
// out of the source and compares them to these arrays. The browser
// mirror (webapp/lib/slash-routing.ts) is pinned by the same file.

/** Commands POST /api/cmd accepts. `desc` feeds the /help fallback. */
export const CMD_BUTTON_COMMANDS = Object.freeze([
  Object.freeze({ name: "new", desc: "新建会话" }),
  Object.freeze({ name: "clear", desc: "清空当前对话" }),
  Object.freeze({ name: "status", desc: "查看当前状态" }),
  Object.freeze({ name: "sessions", desc: "查看最近会话" }),
  Object.freeze({ name: "review", desc: "审查工作区变更 (TUI /review)" }),
  Object.freeze({ name: "help", desc: "可用命令" }),
  Object.freeze({ name: "usage", desc: "查询用量" }),
  Object.freeze({ name: "stop", desc: "停止当前任务" }),
]);

/** The same set as bare names — what the switch labels must equal. */
export const CMD_BUTTON_COMMAND_NAMES = Object.freeze(
  CMD_BUTTON_COMMANDS.map((command) => command.name),
);

/**
 * Commands handleLocalSlash consumes on the /api/send path. Declared
 * for the 400 message only: routing never consults it (everything
 * outside CMD_BUTTON_COMMAND_NAMES goes to /api/send, which is what
 * makes engine commands like `/compact` reach mcode).
 */
export const SEND_SLASH_COMMANDS = Object.freeze([
  "goal",
  "goal-done",
  "goal-blocked",
  "clear",
  "new",
  "status",
  "review",
  "help",
  "usage",
]);

const CMD_BUTTON_NAME_SET = new Set(CMD_BUTTON_COMMAND_NAMES);
const SEND_SLASH_NAME_SET = new Set(SEND_SLASH_COMMANDS);

/** True when `name` (no leading slash) is a POST /api/cmd command. */
export function isCmdButtonCommand(name) {
  return typeof name === "string" && CMD_BUTTON_NAME_SET.has(name);
}

/** True when `name` is consumed by handleLocalSlash on the send path. */
export function isSendSlashCommand(name) {
  return typeof name === "string" && SEND_SLASH_NAME_SET.has(name);
}

/** `/new, /clear, …` — the "known commands" hint in the 400 body. */
export function cmdButtonCommandList() {
  return CMD_BUTTON_COMMAND_NAMES.map((name) => `/${name}`).join("、");
}
