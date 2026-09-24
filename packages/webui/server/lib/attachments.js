// webui/server/lib/attachments.js
// Turn uploaded file paths into the ACP content blocks the engine accepts.

import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { existsSync, statSync } from "node:fs";

import { UPLOAD_DIR } from "./config.js";

/**
 * Why this module exists.
 *
 * `POST /api/send` accepted an `attachments` array and then dropped it: the
 * route validated `content` only, and neither transport read the field. The
 * composer deliberately enables Send for an attachment with no text
 * (`empty = value.length === 0 && attachments.length === 0`), so the UI
 * offered an action the server answered with `400 content required` — and with
 * text present the file uploaded, showed a chip, and still never reached the
 * agent. Silent non-delivery on a control that looks like it works.
 *
 * ## The block type is not a guess
 *
 * The engine's own `promptToText` (packages/tui/src/acp/agent.ts) decides this:
 *
 *   text          → the text
 *   resource_link → `Referenced resource: <title ?? name> (<uri>)`
 *   anything else → RequestError "Prompt content type X is not supported in
 *                    ACP P0."
 *
 * So a file goes as `resource_link`. The desktop's composer emits
 * `type: "resource"` and `type: "image"` blocks, but those are its internal
 * editor shapes — this engine rejects both, and sending them would turn a
 * working turn into an engine error.
 *
 * The rendering string is deliberately NOT duplicated here. The engine owns
 * it; pre-rendering it into prose on this side would be a second copy to keep
 * in sync, and would hide any future change to how the engine names a
 * reference.
 *
 * ## Containment
 *
 * The paths arrive from the client, so they are untrusted. An attachment must
 * resolve inside `UPLOAD_DIR` and exist there as a file. Without that check a
 * caller could name any file on the host and get the agent to reference it —
 * the reference text is fed to the model as if the user had typed it.
 */

/**
 * A resolved, contained attachment.
 *
 * @typedef {{ path: string; name: string; size: number }} ResolvedAttachment
 */

/**
 * An ACP content block, narrowed to the two types this engine accepts:
 * `{ type: "text", text }` or `{ type: "resource_link", name, uri }`.
 *
 * @typedef {{ type: "text", text: string }
 *         | { type: "resource_link", name: string, uri: string }} PromptBlock
 */

/**
 * Validate and resolve a client-supplied attachment path.
 *
 * @param {unknown} raw
 * @returns {ResolvedAttachment | null} null when the path is not a string, is
 *   not absolute, escapes `UPLOAD_DIR`, or is not an existing file.
 */
export function resolveAttachment(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  // The composer sends `@<path>`: a leading `@` is the desktop's "mention this
  // resource" convention (the chip strips it for display), and it is what
  // `onPickFiles` pushes. Accept it and validate the path underneath — one
  // optional `@`, not a repeated prefix.
  const candidate = raw.startsWith("@") ? raw.slice(1) : raw;
  // Only a plain absolute path, which is what `POST /api/upload` returns.
  if (!isAbsolute(candidate)) return null;

  const root = resolve(UPLOAD_DIR);
  const abs = resolve(candidate);
  // `relative` yields `..` segments when `abs` escapes `root`; an absolute
  // result means a different root entirely. Either way: outside.
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return { path: abs, name: basename(abs), size: statSync(abs).size };
  } catch {
    return null;
  }
}

/**
 * How many attachments one turn may carry.
 *
 * The list is client-supplied and was previously unbounded, so a caller could
 * name the same uploaded file a hundred thousand times and have it become a
 * hundred thousand prompt blocks. The composer never offers more than a
 * handful, so a cap costs nothing real and bounds the work.
 */
export const MAX_ATTACHMENTS_PER_TURN = 16;

/**
 * Resolve a list: keep what is contained in the uploads dir, drop the rest,
 * collapse duplicates, and stop at `MAX_ATTACHMENTS_PER_TURN`.
 *
 * @param {unknown} list
 * @returns {{attachments: import("./attachments.js").ResolvedAttachment[];
 *   rejected: number; dropped: number}}
 *   `rejected` counts paths that were not usable; `dropped` counts usable ones
 *   left out because of the cap or a duplicate.
 */
export function resolveAttachments(list) {
  if (!Array.isArray(list)) return { attachments: [], rejected: 0, dropped: 0 };
  const attachments = [];
  const seen = new Set();
  let rejected = 0;
  let dropped = 0;
  for (const entry of list) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_TURN) {
      dropped += 1;
      continue;
    }
    const resolved = resolveAttachment(entry);
    if (!resolved) {
      rejected += 1;
      continue;
    }
    if (seen.has(resolved.path)) {
      dropped += 1;
      continue;
    }
    seen.add(resolved.path);
    attachments.push(resolved);
  }
  return { attachments, rejected, dropped };
}

/**
 * The ACP content blocks for a turn: the text (when there is any) followed by
 * one `resource_link` per attachment.
 *
 * An empty text block is omitted. The engine joins blocks with a blank line, so
 * a leading empty block would only add whitespace — and `parseCommand`
 * already declines any multi-block prompt as a slash command, which is correct:
 * a turn carrying an attachment is not a command.
 */
export function buildPromptBlocks(text, attachments) {
  /** @type {import("./attachments.js").PromptBlock[]} */
  const blocks = [];
  const trimmed = (text || "").trim();
  if (trimmed) blocks.push({ type: "text", text: trimmed });
  for (const a of attachments) {
    blocks.push({ type: "resource_link", name: a.name, uri: a.path });
  }
  return blocks;
}

/**
 * The same prompt as one string, for transports with no block channel
 * (`mcode exec` writes plain text to stdin).
 *
 * Mirrors the engine's `promptToText` rendering so both transports put the
 * same text in front of the model.
 */
export function promptTextFor(text, attachments) {
  return buildPromptBlocks(text, attachments)
    .map((b) => (b.type === "text" ? b.text : `Referenced resource: ${b.name} (${b.uri})`))
    .join("\n\n");
}
