// webui/server/lib/chat-line.js
// Pure helper: append/replace a streaming "<prefix> <text>" line on the
// chat array, with a trailing " ▍" cursor. No state, no side-effects
// beyond the passed-in chat array, no module-level constants.
//
// Cursor semantics (no dedicated unit test; exercised end-to-end via
// test/lib/transcript.test.js and the chat-line fixtures):
//   - If the chat's last line starts with "<prefix> ", it is REPLACED
//     in place with "<prefix> <text> ▍" — the streaming cursor follows
//     the same prefix across SSE pushes (e.g. ▲ thinking keeps writing
//     to the same line until ● takes over).
//   - Otherwise a new line "<prefix> <text> ▍" is appended (the stream
//     is starting a NEW <prefix> line — e.g. the first ● after a ▲ run).
//   - Before either path, any other chat line ending in " ▍" has the
//     trailing cursor stripped (思考 ▲ → 正文 ● switch: the thinking
//     block must not keep a blinking cursor in the previous line).
export function streamUpdateLine(chat, prefix, text) {
  const target = `${prefix} `;
  for (let i = 0; i < chat.length; i++) {
    if (typeof chat[i] === "string" && chat[i].endsWith(" ▍")) {
      chat[i] = chat[i].slice(0, -2);
    }
  }
  const last = chat[chat.length - 1];
  if (last && last.startsWith(target)) {
    chat[chat.length - 1] = `${target}${text} ▍`;
  } else {
    chat.push(`${target}${text} ▍`);
  }
}