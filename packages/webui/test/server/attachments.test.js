// webui/test/server/attachments.test.js
//
// Uploaded paths are untrusted input; only files inside UPLOAD_DIR may become
// prompt content, and they must arrive as the one block type this engine
// accepts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveAttachment,
  resolveAttachments,
  MAX_ATTACHMENTS_PER_TURN,
  buildPromptBlocks,
  promptTextFor,
} from "../../server/lib/attachments.js";
import { UPLOAD_DIR } from "../../server/lib/config.js";

// UPLOAD_DIR is read at import time from the env, so point it at a scratch dir
// for the duration of this file.
const ROOT = resolve(UPLOAD_DIR);
const t = test;

t.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function seed(relPath, body = "x") {
  const abs = join(ROOT, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

test("resolveAttachment — accepts a real file inside UPLOAD_DIR", () => {
  const abs = seed("note.txt", "hello");
  const got = resolveAttachment(abs);
  assert.ok(got, "should resolve");
  assert.equal(got.path, abs);
  assert.equal(got.name, "note.txt");
  assert.equal(got.size, 5);
});

test("resolveAttachment — accepts the composer's `@path` mention form", () => {
  // onPickFiles pushes `@${result.path}`; the chip strips the `@` for display.
  // Rejecting it would leave the UI offering an action the server refuses.
  const abs = seed("mention.txt", "hey");
  const withAt = resolveAttachment(`@${abs}`);
  assert.ok(withAt, "the @-prefixed form the client actually sends must resolve");
  assert.equal(withAt.path, abs);
  assert.equal(withAt.name, "mention.txt");
  // The prefix is not a containment bypass: `@/etc/passwd` is still outside.
  assert.equal(resolveAttachment("@/etc/passwd"), null);
  // One prefix, not a repeated one — `@@/abs` is not a path.
  assert.equal(resolveAttachment(`@@${abs}`), null);
});

test("resolveAttachment — rejects anything outside UPLOAD_DIR", () => {
  // The escape that matters: name a file the user never uploaded and get the
  // agent to reference it. The reference text is fed to the model as if the
  // user had typed it, so this is a real containment boundary.
  assert.equal(resolveAttachment("/etc/passwd"), null);
  assert.equal(resolveAttachment(join(ROOT, "..", "..", "etc", "passwd")), null);
  assert.equal(resolveAttachment(join(ROOT, "..", "sibling.txt")), null);
  // A prefix of the root is not the root: "<root>-evil" must not pass.
  assert.equal(resolveAttachment(`${ROOT}-evil/x.txt`), null);
  // The root itself is a directory, not an attachment.
  assert.equal(resolveAttachment(ROOT), null);
});

test("resolveAttachment — rejects non-strings, relative paths, and missing files", () => {
  assert.equal(resolveAttachment(undefined), null);
  assert.equal(resolveAttachment(42), null);
  assert.equal(resolveAttachment(""), null);
  assert.equal(resolveAttachment("relative/note.txt"), null);
  assert.equal(resolveAttachment(join(ROOT, "never-uploaded.txt")), null);
  seed("a-directory/inner.txt");
  assert.equal(resolveAttachment(join(ROOT, "a-directory")), null, "a directory is not an attachment");
});

test("resolveAttachments — keeps the good, counts the bad, drops duplicates", () => {
  const good = seed("keep.txt", "ok");
  const result = resolveAttachments([good, "/etc/shadow", "nope.txt", good]);
  assert.equal(result.attachments.length, 1, "only the contained file survives");
  assert.equal(result.attachments[0].path, good);
  assert.equal(result.rejected, 2, "/etc/shadow and the relative path are unusable");
  assert.equal(result.dropped, 1, "the repeat of the same file is dropped");
  assert.deepEqual(resolveAttachments(undefined), { attachments: [], rejected: 0, dropped: 0 });
  assert.deepEqual(resolveAttachments("not-an-array"), { attachments: [], rejected: 0, dropped: 0 });
});

test("resolveAttachments — the per-turn cap bounds the prompt", () => {
  // The list is client-supplied, so it must not be able to grow the prompt
  // without limit. Previously every entry became a block.
  const many = [];
  for (let i = 0; i < MAX_ATTACHMENTS_PER_TURN + 5; i++) {
    many.push(seed(`many-${i}.txt`, "x"));
  }
  const result = resolveAttachments(many);
  assert.equal(result.attachments.length, MAX_ATTACHMENTS_PER_TURN);
  assert.equal(result.dropped, 5);
  // A list of repeats cannot inflate the prompt either.
  const one = seed("repeat.txt", "x");
  const repeated = resolveAttachments(new Array(1000).fill(one));
  assert.equal(repeated.attachments.length, 1);
  assert.equal(repeated.dropped, 999);
});

test("buildPromptBlocks — resource_link, because that is what the engine accepts", () => {
  // packages/tui/src/acp/agent.ts#promptToText accepts `text` and
  // `resource_link`; anything else is rejected with "not supported in ACP P0".
  const abs = seed("ref.txt", "x");
  const [a] = resolveAttachments([abs]).attachments;
  const blocks = buildPromptBlocks("look at this", [a]);
  assert.deepEqual(blocks, [
    { type: "text", text: "look at this" },
    { type: "resource_link", name: "ref.txt", uri: abs },
  ]);
  // The desktop's internal `resource` / `image` shapes would be rejected by the
  // engine, so neither may appear here.
  for (const b of blocks) {
    assert.ok(["text", "resource_link"].includes(b.type), `unexpected block type ${b.type}`);
  }
});

test("buildPromptBlocks — an attachment-only turn has no empty text block", () => {
  const abs = seed("only.txt", "x");
  const [a] = resolveAttachments([abs]).attachments;
  const blocks = buildPromptBlocks("", [a]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "resource_link");
  // No text at all → no blocks. A turn with nothing to say and nothing
  // attached is not a turn; the route rejects it before here.
  assert.deepEqual(buildPromptBlocks("", []), []);
  assert.deepEqual(buildPromptBlocks("   ", []), []);
});

test("promptTextFor — mirrors the engine's own rendering for exec", () => {
  // mcode exec writes plain text to stdin, so the blocks are flattened with the
  // same wording packages/tui/src/acp/agent.ts#promptToText produces.
  const abs = seed("exec.txt", "x");
  const [a] = resolveAttachments([abs]).attachments;
  assert.equal(
    promptTextFor("check it", [a]),
    `check it\n\nReferenced resource: exec.txt (${abs})`,
  );
  assert.equal(promptTextFor("plain", []), "plain");
});
