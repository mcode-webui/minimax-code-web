// webui/test/lib/acp-turn-message-id.test.js
// webui-parity 83 — which messageId the transport keeps for a turn.
//
// The engine persists a turn's file-change record under the msg_id of that
// turn's LAST assistant MESSAGE
// (`local-runtime-v2/.../turn-outcome.ts#readAssistantMessageId` reads
// AgentMessage / AgentMessageChunk and never a thought). A turn carries
// more than one id on the wire — one per message segment, plus one per
// thought segment — so "any id" selects the wrong record.
//
// The rule is pinned here against the real `McodeAcpClient#prompt`, driven
// by a fake `request` that replays `session/update` frames. No child process
// is spawned: the client is constructed but never `start()`ed, and only
// `on` / `off` / `request` are exercised.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", rel)).href;
const { McodeAcpClient } = await import(absPath("acp.mjs"));

/**
 * Replay `frames` as `session/update` events, then resolve `session/prompt`.
 * `prompt` subscribes through `on` and unsubscribes in its own settle path,
 * so the fake has to dispatch through the real EventEmitter.
 */
function fakeClient(frames) {
  const client = new McodeAcpClient();
  client.started = false;
  client.request = async (method) => {
    if (method !== "session/prompt") throw new Error(`unexpected request ${method}`);
    for (const frame of frames) client.emit("sessionUpdate", frame);
    return { stopReason: "end_turn" };
  };
  return client;
}

const text = (t) => ({ type: "text", text: t });
const thought = (id, t) => ({ sessionUpdate: "agent_thought_chunk", content: text(t), messageId: id });
const message = (id, t) => ({ sessionUpdate: "agent_message_chunk", content: text(t), messageId: id });

describe("prompt keeps the turn's last assistant messageId", () => {
  test("a simple turn yields that turn's only message id", async () => {
    const client = fakeClient([message("m1", "答案")]);
    const result = await client.prompt("mvs_x", "hi", () => {});
    assert.equal(result.lastAssistantMessageId, "m1");
  });

  test("a turn with several message segments keeps the LAST one", async () => {
    // The turn the real engine runs: a first message, a tool call, then a
    // second message. The record is filed under the second one.
    const client = fakeClient([
      message("m1", "我先看看"),
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash" },
      message("m2", "改好了"),
    ]);
    const result = await client.prompt("mvs_x", "hi", () => {});
    assert.equal(result.lastAssistantMessageId, "m2");
  });

  test("a thought id never wins over the message id", async () => {
    // The engine's reader ignores thoughts entirely. Taking the thought's id
    // would send the endpoint a selector that matches no diff record — an
    // empty card on a turn that really did change files.
    const client = fakeClient([
      thought("t1", "先想一下"),
      message("m1", "动手"),
      thought("t2", "再想想"),
    ]);
    const result = await client.prompt("mvs_x", "hi", () => {});
    assert.equal(result.lastAssistantMessageId, "m1");
  });

  test("a turn with no message chunk yields no id at all", async () => {
    // A thinking-only turn has no assistant message, so there is no selector.
    // Emitting the thought's id here would be the "any chunk" bug wearing a
    // different hat.
    const client = fakeClient([thought("t1", "只有思考")]);
    const result = await client.prompt("mvs_x", "hi", () => {});
    assert.equal(result.lastAssistantMessageId, null);
  });

  test("a chunk without a messageId does not clear the one already seen", async () => {
    const client = fakeClient([message("m1", "有 id"), message(undefined, "没有 id")]);
    const result = await client.prompt("mvs_x", "hi", () => {});
    assert.equal(result.lastAssistantMessageId, "m1");
  });

  test("the id is per-prompt, not accumulated on the client", async () => {
    // Two turns on one client: the second must not inherit the first turn's
    // id, or every card after the first would query the wrong turn.
    const queue = [[message("first", "第一轮")], [message("second", "第二轮")]];
    const client = fakeClient([]);
    client.request = async (method) => {
      if (method !== "session/prompt") throw new Error("unexpected");
      for (const f of queue.shift() ?? []) client.emit("sessionUpdate", f);
      return { stopReason: "end_turn" };
    };
    const one = await client.prompt("mvs_x", "one", () => {});
    assert.equal(one.lastAssistantMessageId, "first");
    const two = await client.prompt("mvs_x", "two", () => {});
    assert.equal(two.lastAssistantMessageId, "second");
  });
});
