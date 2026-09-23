// webui/test/lib-sse-golden.test.js
// SSE 线上机制 golden 等价（sse-adapter.js）：帧字节、diff 门、fresh-res、
// 背压守卫、节流合并（窗口实例经 query 隔离模块实例）、命名控制帧格式。

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  scheduleStatePush,
  formatControlFrame,
  writeControlFrame,
  clearCidCoalesce,
  resetCoalesceState,
  flushPendingPushes,
  peekLastPushed,
  peekLastPushedRes,
  STATE_PUSH_THROTTLE_MS,
} from "../server/lib/sse-adapter.js";

function fakeRes() {
  return {
    writableEnded: false,
    destroyed: false,
    writableNeedDrain: false,
    frames: [],
    write(chunk) {
      this.frames.push(chunk);
    },
  };
}

describe("sse-adapter golden（默认实例：节流禁用）", () => {
  beforeEach(() => resetCoalesceState());

  it("环境默认值：STATE_PUSH_THROTTLE_MS = 0（与旧实现代码一致）", () => {
    assert.equal(STATE_PUSH_THROTTLE_MS, 0);
  });

  it("状态推送帧字节精确：data: + JSON + 两个换行", () => {
    const res = fakeRes();
    scheduleStatePush("g1", '{"a":1}', res);
    assert.deepEqual(res.frames, ["data: {\"a\":1}\n\n"]);
  });

  it("字节 diff 门：相同 payload 二次推送跳过", () => {
    const res = fakeRes();
    scheduleStatePush("g2", "SAME", res);
    scheduleStatePush("g2", "SAME", res);
    assert.equal(res.frames.length, 1);
  });

  it("diff 门放行不同 payload", () => {
    const res = fakeRes();
    scheduleStatePush("g3", "V1", res);
    scheduleStatePush("g3", "V2", res);
    assert.deepEqual(res.frames, ["data: V1\n\n", "data: V2\n\n"]);
  });

  it("fresh-res 检测：res 换代无条件直写且清理旧状态", () => {
    const res1 = fakeRes();
    scheduleStatePush("g4", "SAME", res1);
    const res2 = fakeRes();
    scheduleStatePush("g4", "SAME", res2);
    assert.equal(res1.frames.length, 1);
    assert.equal(res2.frames.length, 1);
    assert.equal(peekLastPushedRes("g4"), res2);
  });

  it("背压守卫：writableNeedDrain 跳过且不写 diff 缓存（排空后重推落线）", () => {
    const res = fakeRes();
    res.writableNeedDrain = true;
    scheduleStatePush("g5", "V1", res);
    assert.equal(res.frames.length, 0);
    assert.equal(peekLastPushed("g5"), undefined);
    res.writableNeedDrain = false;
    scheduleStatePush("g5", "V1", res);
    assert.equal(res.frames.length, 1);
  });

  it("死套接字守卫：destroyed / writableEnded 静默丢弃", () => {
    const res = fakeRes();
    res.destroyed = true;
    scheduleStatePush("g6", "V", res);
    const res2 = fakeRes();
    res2.writableEnded = true;
    scheduleStatePush("g6b", "V", res2);
    assert.equal(res.frames.length + res2.frames.length, 0);
  });

  it("命名控制帧格式（token 轮转原文 data；其余为 JSON 字符串由调用方编码）", () => {
    assert.equal(
      formatControlFrame("auth.token_rotated", "abc123"),
      "event: auth.token_rotated\ndata: abc123\n\n",
    );
    assert.equal(
      formatControlFrame("token.first_run", '{"token":"t"}'),
      'event: token.first_run\ndata: {"token":"t"}\n\n',
    );
    const res = fakeRes();
    writeControlFrame(res, formatControlFrame("x", "y"));
    assert.deepEqual(res.frames, ["event: x\ndata: y\n\n"]);
  });

  it("writeControlFrame 吞写异常", () => {
    const res = fakeRes();
    res.write = () => { throw new Error("dead"); };
    writeControlFrame(res, "whatever"); // 不应抛出
  });

  it("clearCidCoalesce：dropResRef 控制 res 引用释放", () => {
    const res = fakeRes();
    scheduleStatePush("g7", "V", res);
    clearCidCoalesce("g7");
    assert.equal(peekLastPushedRes("g7"), res); // 默认保留 res 引用
    clearCidCoalesce("g7", { dropResRef: true });
    assert.equal(peekLastPushedRes("g7"), undefined);
  });
});

describe("sse-adapter 节流合并（16ms 窗口实例，last-call-wins）", () => {
  it("窗口内多次推送合并为最后一份；flushPendingPushes 冲刷", async () => {
    process.env.STATE_PUSH_THROTTLE_MS = "16";
    const a = await import("../server/lib/sse-adapter.js?throttle=16");
    const res = fakeRes();
    a.scheduleStatePush("w1", "V1", res); // 窗口外：同步写出
    a.scheduleStatePush("w1", "V2", res); // 窗口内：挂起
    a.scheduleStatePush("w1", "V3", res); // 窗口内：覆盖（last-call-wins）
    assert.deepEqual(res.frames, ["data: V1\n\n"]);
    a.flushPendingPushes();
    assert.deepEqual(res.frames, ["data: V1\n\n", "data: V3\n\n"]);
    delete process.env.STATE_PUSH_THROTTLE_MS;
  });
});