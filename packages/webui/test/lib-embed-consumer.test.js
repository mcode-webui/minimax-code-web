// webui/test/lib-embed-consumer.test.js
// embed 聊天行归约器（server/lib/embed-consumer.js）：事件→聊天行、收尾记账、
// 生成器返回值捕获。状态推送经 setupMocks 隔离真实目录。

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setupMocks, registerAcpMock, registerSessionsStore } from "./_setup.js";

// 延迟导入（checks 文件的已证实模式）：mock.module 必须先注册，
// 否则被测模块在加载期绑定真实 acp-client，pushStateFor 缓存未命中时
// 会 spawn 真实引擎子进程导致挂死。
let collectEmbedResult;

function fakeCs() {
  return {
    chat: ["› 测试问题"],
    mcodeSessionId: "mvs_x",
    model: { name: "minimax_api/MiniMax-M3" },
    context: { tokens: 0, used: 0, percent: 0, limit: 512000, tps: 0, thinkingStatus: "Idle", thinkingDuration: null, lastUsageAt: null },
    usage: { sessionInput: 0, sessionOutput: 0, sessionTotal: 0 },
    running: {},
  };
}

function fakeGen(events, result) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          if (i < events.length) return Promise.resolve({ value: events[i++], done: false });
          return Promise.resolve({ value: result, done: true });
        },
      };
    },
  };
}

// 装配置于模块顶层（checks/lib-state-bus.check.mjs 已证实的模式：
// describe 内的 before 钩子上下文不带 .mock，顶层 before 带）。
before(async (t) => {
  await setupMocks(t);
  ({ collectEmbedResult } = await import("../server/lib/embed-consumer.js"));
});
beforeEach(() => {
  registerAcpMock({
    getMcodeSessionsForWorkspace: async () => [],
    getMcodeSessionsCacheSync: () => null,
    getMcodeSessionsStaleSync: () => null,
  });
  registerSessionsStore({ initial: [] });
});

describe("collectEmbedResult", () => {

  it("事件→聊天行：▲/● 增量 + 工具标记行", async () => {
    const cs = fakeCs();
    const r = await collectEmbedResult(
      fakeGen([
        { kind: "thought", text: "思考" },
        { kind: "message", text: "正文" },
        { kind: "tool_call", update: { title: "Bash" } },
      ], { status: "succeeded", answer: "正文", thinking: "思考", sessionId: "mvs_x", usage: null }),
      { cs, cid: "t1", label: "prompt" },
    );
    // 断言语义（▲/● 与文本存在），不耦合 sessions.js mock 桩的行格式
    assert.ok(cs.chat.some((l) => typeof l === "string" && l.includes("▲") && l.includes("思考")));
    assert.ok(cs.chat.some((l) => typeof l === "string" && l.includes("●") && l.includes("正文")));
    assert.ok(cs.chat.includes("→ Bash"));
    assert.equal(r.status, "succeeded");
    assert.equal(r.answer, "正文");
  });

  it("收尾：running 复位、状态 Idle、流式光标清除、sessionId 回写", async () => {
    const cs = fakeCs();
    const r = await collectEmbedResult(
      fakeGen([{ kind: "message", text: "流式" }], { status: "succeeded", answer: "流式", sessionId: "mvs_new" }),
      { cs, cid: "t2" },
    );
    assert.equal(cs.running.active, false);
    assert.equal(cs.context.thinkingStatus, "Idle");
    assert.equal(cs.mcodeSessionId, "mvs_new");
    assert.ok(cs.chat.every((l) => typeof l !== "string" || !l.endsWith(" ▍")));
    assert.equal(r.sessionId, "mvs_new");
  });

  it("用量记账：真实 usage 直记，无 usage 走估算（除 3 规则）", async () => {
    const csA = fakeCs();
    await collectEmbedResult(
      fakeGen([{ kind: "message", text: "abc" }], { status: "succeeded", answer: "abc", usage: { totalTokens: 10, inputTokens: 4, outputTokens: 6 } }),
      { cs: csA, cid: "t3a" },
    );
    assert.equal(csA.context.tokens, 10);
    assert.equal(csA.context.estimated, false);
    assert.equal(csA.usage.sessionTotal, 10);

    const csB = fakeCs();
    await collectEmbedResult(
      fakeGen([{ kind: "message", text: "abcdefghi" }], { status: "failed", error: { message: "x" } }),
      { cs: csB, cid: "t3b" },
    );
    assert.equal(csB.context.estimated, true);
    // estOut = ceil(9/3) = 3；estIn = ceil(len("› 测试问题")/3)
    assert.equal(csB.usage.sessionOutput, 3);
    assert.ok(csB.usage.sessionInput > 0);
  });

  it("生成器返回值即结果 r（手写迭代不丢返回值）", async () => {
    const cs = fakeCs();
    const marker = { status: "succeeded", answer: "z", marker: true };
    const r = await collectEmbedResult(fakeGen([], marker), { cs, cid: "t4" });
    assert.equal(r.marker, true);
  });
});