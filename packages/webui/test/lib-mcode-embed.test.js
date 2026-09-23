// webui/test/lib-mcode-embed.test.js
// mcode-embed.js（引擎宿主 Worker 传输骨架）单元测试 —— 桩 Worker 驱动 RPC v:1
// 协议全路径。验收清单：
//   1. boot 成功 / 失败（含真实 engine-host.worker.js 的 boot-failed 路径）；
//   2. prompt 事件流的 NormalizedEvent 与 mcode-acp.js 逐字段一致；
//   3. prompt-done 落定（finalize 语义：收尾结果与 runMcodeAcp 返回值同形）；
//   4. steer / cancel RPC 往返；
//   5. fatal → generator 优雅结束（失败事件 + 不抛）；
//   6. shutdown 无悬挂句柄（自然退出，不走 terminate 兜底）。
//
// NormalizedEvent 的期望对象逐字段取自 acp.mjs prompt() 的 onChunk 载荷构造
// （agent_thought_chunk → {kind:'thought', text}；tool_call → {kind:'tool_call',
// update}；tool_call_update → {kind:'tool_update', update}；usage_update →
// {kind:'usage', update}；done → {kind:'done', stopReason, usage}），也就是
// mcode-acp.js streamAcpPrompt 流回调消费的同一对象 —— 生成器必须逐字透传。
// 桩不加载引擎（test/fixtures/engine-host.stub.worker.js），事件序列经
// workerData.script 脚本化。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(TEST_DIR, "..", "server");
const STUB_WORKER = pathToFileURL(
  join(TEST_DIR, "fixtures", "engine-host.stub.worker.js"),
).href;
const ENGINE_ENTRY = join(
  TEST_DIR,
  "..",
  "..",
  "local-runtime-v2",
  "dist",
  "local",
  "index.js",
);

const {
  bootEngineHost,
  runMcodeEmbed,
  steerEmbed,
  cancelEmbed,
  stopEmbed,
  isEmbedRunning,
} = await import(
  pathToFileURL(join(SERVER_DIR, "lib", "mcode-embed.js")).href
);

/**
 * 驱动生成器到终点：收集全部 NormalizedEvent 与收尾结果（生成器返回值 =
 * streamAcpPrompt 的 r）。
 */
async function collect(gen) {
  const events = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { events, result: value };
    events.push(value);
  }
}

/** 以脚本化桩 Worker 启动宿主；测试结束自动拆除（无跨用例状态残留）。 */
async function bootStub(t, script) {
  const r = await bootEngineHost({
    workerPath: STUB_WORKER,
    workerData: { script },
  });
  t.after(() => stopEmbed());
  return r;
}

// ── 参考数据（字段与 acp.mjs / mcode-acp.js 的载荷构造一致）─────────────────
const USAGE = {
  totalTokens: 1300,
  inputTokens: 800,
  outputTokens: 500,
  thoughtTokens: 120,
};
const TOOL_CALL_UPDATE = {
  sessionUpdate: "tool_call",
  toolCallId: "call-1",
  title: "Bash",
  name: "Bash",
  status: "running",
  rawInput: { command: "ls" },
};
const TOOL_DONE_UPDATE = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-1",
  status: "completed",
  rawOutput: { content: [{ type: "text", text: "file.txt" }] },
  locations: [{ path: "/tmp/file.txt" }],
};
const USAGE_UPDATE = { used: 1200, size: 512000, cost: 0.01 };
const PLAN_UPDATE = {
  sessionUpdate: "plan_update",
  planId: "p1",
  title: "方案",
  summary: "摘要",
  options: [{ label: "a", description: "A" }],
};

describe("bootEngineHost — 桩 Worker", () => {
  test("boot 成功 → {ok:true, engineVersion}，isEmbedRunning() 为真", async (t) => {
    const r = await bootStub(t, { boot: "ok", engineVersion: "stub-1.0.0" });
    assert.deepStrictEqual(r, { ok: true, engineVersion: "stub-1.0.0" });
    assert.equal(isEmbedRunning(), true);
  });

  test("boot-failed → {ok:false, reason}，失败不抛且宿主自动拆除", async (t) => {
    const r = await bootStub(t, {
      boot: "fail",
      bootError: "engine dist not built",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /engine dist not built/);
    // 失败即回退语义：宿主拆除后 isEmbedRunning() 为假
    assert.equal(isEmbedRunning(), false);
  });

  test("真实 engine-host.worker.js 的 boot-failed 路径（dist 未构建属预期）", async (t) => {
    // 引擎 dist 未构建时必须落定 {ok:false}（可测的 boot-failed 路径）；
    // 若未来仓库构建了 dist，则只校验结果形状（避免测试绑定构建状态）。
    const engineBuilt = existsSync(ENGINE_ENTRY);
    const r = await bootEngineHost();
    t.after(() => stopEmbed());
    assert.equal(typeof r.ok, "boolean");
    if (!engineBuilt) {
      assert.equal(r.ok, false);
      assert.equal(typeof r.reason, "string");
      assert.ok(r.reason.length > 0, "boot-failed 必须给出 reason");
    } else if (r.ok) {
      assert.ok("engineVersion" in r);
    }
  });
});

describe("runMcodeEmbed — prompt 事件流与收尾", () => {
  test("NormalizedEvent 与 mcode-acp.js 逐字段一致（逐字透传）", async (t) => {
    const expectedEvents = [
      { kind: "thought", text: "让我想想" },
      {kind: "message", text: "你好" },
      { kind: "tool_call", update: TOOL_CALL_UPDATE },
      { kind: "tool_update", update: TOOL_DONE_UPDATE },
      { kind: "usage", update: USAGE_UPDATE },
      { kind: "plan_update", update: PLAN_UPDATE },
      { kind: "done", stopReason: "end_turn", usage: USAGE },
    ];
    await bootStub(t, {
      prompts: [
        {
          events: expectedEvents,
          reply: {
            ok: true,
            payload: { sessionId: "mvs_stub_1", stopReason: "end_turn", usage: USAGE },
          },
        },
      ],
    });
    const { events } = await collect(runMcodeEmbed("你好", {}));
    assert.deepStrictEqual(events, expectedEvents);
  });

  test("prompt-done 落定：收尾结果与 runMcodeAcp 的 r 同形同义", async (t) => {
    await bootStub(t, {
      prompts: [
        {
          events: [
            { kind: "thought", text: "思考" },
            { kind: "message", text: "正文" },
            { kind: "done", stopReason: "end_turn", usage: USAGE },
          ],
          reply: {
            ok: true,
            payload: { sessionId: "mvs_stub_2", stopReason: "end_turn", usage: USAGE },
          },
        },
      ],
    });
    const { events, result: r } = await collect(runMcodeEmbed("hi", {}));
    // done 事件是流的最后一帧（prompt-done）
    assert.deepStrictEqual(events[events.length - 1], {
      kind: "done",
      stopReason: "end_turn",
      usage: USAGE,
    });
    // 返回值与 streamAcpPrompt 的 r 字段逐项一致
    assert.deepStrictEqual(
      Object.keys(r).sort(),
      ["answer", "thinking", "status", "error", "usage", "sessionId", "durationMs", "stopReason", "tps"].sort(),
    );
    assert.equal(r.status, "succeeded");
    assert.equal(r.answer, "正文");
    assert.equal(r.thinking, "思考");
    assert.equal(r.stopReason, "end_turn");
    assert.deepStrictEqual(r.usage, USAGE);
    assert.equal(r.sessionId, "mvs_stub_2");
    assert.equal(r.error, null);
    assert.equal(typeof r.durationMs, "number");
    // mcode-acp.js 的 r.tps 保持 null（tps 只写 cs.running）
    assert.equal(r.tps, null);
  });

  test("reply 覆盖累积值（streamAcpPrompt 的 result.answer || r.answer 语义）", async (t) => {
    await bootStub(t, {
      prompts: [
        {
          events: [{ kind: "message", text: "Hello" }],
          reply: {
            ok: true,
            payload: { answer: "Hello world", stopReason: "max_tokens" },
          },
        },
      ],
    });
    const { result: r } = await collect(runMcodeEmbed("hi", {}));
    assert.equal(r.answer, "Hello world");
    assert.equal(r.thinking, null); // 无 thought 增量且 reply 未给 —— 保持 null
    assert.equal(r.stopReason, "max_tokens");
  });

  test("reply 失败 → {kind:'error'} 事件 + status:'failed' 优雅结束", async (t) => {
    await bootStub(t, {
      prompts: [{ events: [], reply: { ok: false, error: "engine exploded" } }],
    });
    const { events, result: r } = await collect(runMcodeEmbed("hi", {}));
    assert.deepStrictEqual(events, [{ kind: "error", text: "engine exploded" }]);
    assert.equal(r.status, "failed");
    assert.deepStrictEqual(r.error, { message: "engine exploded" });
  });

  test("未 boot 调用 → 失败事件 + status:'failed'（不抛，回退决策在调用方）", async () => {
    assert.equal(isEmbedRunning(), false);
    const { events, result: r } = await collect(runMcodeEmbed("hi", {}));
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "error");
    assert.equal(r.status, "failed");
    assert.match(r.error.message, /not booted/);
  });

  test("空闲看门狗：流静默超时 → status:'timeout'（事件续命语义同 mcode-acp.js）", async (t) => {
    await bootStub(t, {
      prompts: [
        {
          events: [{ delay: 600 }, { kind: "message", text: "late" }],
          reply: { ok: true, payload: { answer: "late" } },
        },
      ],
    });
    const { events, result: r } = await collect(
      runMcodeEmbed("hi", { idleTimeoutMs: 60 }),
    );
    assert.equal(r.status, "timeout");
    assert.match(r.error.message, /inactive for/);
    assert.equal(events[events.length - 1].kind, "error");
  });
});

describe("steerEmbed / cancelEmbed — RPC 往返", () => {
  test("steer / cancel 往返：ok 载荷与 error 应答", async (t) => {
    await bootStub(t, {
      steer: { ok: true, payload: { steered: true } },
      cancel: { ok: false, error: "no-active-prompt" },
    });
    const steer = await steerEmbed("mvs_stub_3", "继续");
    assert.deepStrictEqual(steer, { ok: true, payload: { steered: true } });
    const cancel = await cancelEmbed("mvs_stub_3");
    assert.deepStrictEqual(cancel, { ok: false, error: "no-active-prompt" });
  });

  test("宿主未运行时 RPC 返回 {ok:false}（不抛）", async () => {
    assert.equal(isEmbedRunning(), false);
    const r = await cancelEmbed("any");
    assert.equal(r.ok, false);
    assert.match(r.error, /not running/);
  });
});

describe("fatal — 未捕获异常", () => {
  test("fatal → generator 产出失败事件并优雅结束（不抛）", async (t) => {
    await bootStub(t, {
      prompts: [
        {
          events: [{ kind: "thought", text: "a" }, { fatal: { error: "boom" } }],
          reply: { ok: true, payload: {} }, // fatal 后不会到达
        },
      ],
    });
    const { events, result: r } = await collect(runMcodeEmbed("hi", {}));
    assert.deepStrictEqual(events, [
      { kind: "thought", text: "a" },
      { kind: "error", text: "boom" },
    ]);
    assert.equal(r.status, "failed");
    assert.deepStrictEqual(r.error, { message: "boom" });
  });
});

describe("stopEmbed — shutdown 无悬挂句柄", () => {
  test("shutdown 后 Worker 自然退出（不走 2s terminate 兜底）且可再次 boot", async (t) => {
    const booted = await bootStub(t, { boot: "ok", engineVersion: "stub-1.0.0" });
    assert.equal(booted.ok, true);
    assert.equal(isEmbedRunning(), true);
    const t0 = Date.now();
    await stopEmbed();
    const elapsed = Date.now() - t0;
    // 自然退出远快于 terminate 兜底（2000ms）—— 若有悬挂句柄会拖到兜底才落定
    assert.ok(elapsed < 1500, `stopEmbed 耗时 ${elapsed}ms，疑似有悬挂句柄`);
    assert.equal(isEmbedRunning(), false);
    // 状态已清空 —— 可立即再次 boot（无跨用例残留）
    const again = await bootStub(t, { boot: "ok", engineVersion: "stub-1.0.0" });
    assert.deepStrictEqual(again, { ok: true, engineVersion: "stub-1.0.0" });
    assert.equal(isEmbedRunning(), true);
  });
});
