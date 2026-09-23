// webui/test/lib-event-bus.test.js
// 事件总线（server/lib/event-bus.js）：seq 语义、cid 隔离、订阅扇出。

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  emitEvent,
  subscribeEvents,
  getLatestSeq,
  resetEventBusForTests,
} from "../server/lib/event-bus.js";

describe("event-bus", () => {
  beforeEach(() => resetEventBusForTests());

  it("seq 按 cid 从 1 起单调递增、连续", () => {
    const got = [];
    subscribeEvents("a", (item) => got.push(item.seq));
    emitEvent("a", { type: "control", name: "x", data: "1" });
    emitEvent("a", { type: "control", name: "x", data: "2" });
    emitEvent("a", { type: "control", name: "x", data: "3" });
    assert.deepEqual(got, [1, 2, 3]);
    assert.equal(getLatestSeq("a"), 3);
  });

  it("cid 隔离：互不影响序列空间", () => {
    emitEvent("a", { type: "control", name: "x", data: "" });
    emitEvent("b", { type: "control", name: "x", data: "" });
    emitEvent("b", { type: "control", name: "x", data: "" });
    assert.equal(getLatestSeq("a"), 1);
    assert.equal(getLatestSeq("b"), 2);
  });

  it("fan-out：多订阅者同序收到；退订后停止", () => {
    const a = [];
    const b = [];
    const unsubA = subscribeEvents("c", (i) => a.push(i.seq));
    subscribeEvents("c", (i) => b.push(i.seq));
    emitEvent("c", { type: "control", name: "x", data: "" });
    unsubA();
    emitEvent("c", { type: "control", name: "x", data: "" });
    assert.deepEqual(a, [1]);
    assert.deepEqual(b, [1, 2]);
  });

  it("unsubscribe 幂等", () => {
    const unsub = subscribeEvents("d", () => {});
    unsub();
    unsub();
    emitEvent("d", { type: "control", name: "x", data: "" });
    assert.equal(getLatestSeq("d"), 1);
  });

  it("订阅者异常隔离：抛错不影响其他订阅者", () => {
    const ok = [];
    subscribeEvents("e", () => { throw new Error("boom"); });
    subscribeEvents("e", (i) => ok.push(i.seq));
    emitEvent("e", { type: "control", name: "x", data: "" });
    assert.deepEqual(ok, [1]);
  });

  it("事件体原样透传（快照与控制两类）", () => {
    const got = [];
    subscribeEvents("f", (i) => got.push(i.event));
    const snap = { version: "1.0" };
    emitEvent("f", { type: "state.snapshot", snapshot: snap });
    emitEvent("f", { type: "control", name: "auth.token_rotated", data: "tok" });
    assert.equal(got[0].type, "state.snapshot");
    assert.equal(got[0].snapshot, snap);
    assert.equal(got[1].name, "auth.token_rotated");
    assert.equal(got[1].data, "tok");
  });
});