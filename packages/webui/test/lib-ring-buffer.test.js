// webui/test/lib-ring-buffer.test.js
// 环形缓冲（seq 索引重放窗口）单元测试。
// 覆盖规格：push/replay 基本行为、覆盖最旧、欠载 complete=false、
// fromSeq===latestSeq()+1 边界、空缓冲两例，以及实现的防御性行为。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;
const { createRingBuffer } = await import(absPath("lib/ring-buffer.js"));

describe("ring-buffer", () => {
  test("push / replay 基本行为：按 seq 过滤并升序返回", () => {
    const buf = createRingBuffer(10);
    assert.equal(buf.push(1, "a"), true);
    assert.equal(buf.push(2, "b"), true);
    assert.equal(buf.push(3, "c"), true);
    const r = buf.replay(2);
    assert.deepEqual(r.items, [
      { seq: 2, item: "b" },
      { seq: 3, item: "c" },
    ]);
    assert.equal(r.complete, true);
  });

  test("push 拒绝非递增 seq（重复与回退均返回 false）", () => {
    const buf = createRingBuffer(10);
    assert.equal(buf.push(5, "a"), true);
    assert.equal(buf.push(5, "dup"), false);
    assert.equal(buf.push(4, "back"), false);
    assert.equal(buf.push(6, "ok"), true);
    assert.equal(buf.size(), 2); // 被拒绝的写入不占位
  });

  test("容量满时覆盖最旧条目", () => {
    const buf = createRingBuffer(3);
    for (const n of [1, 2, 3, 4]) buf.push(n, `item-${n}`);
    assert.equal(buf.size(), 3);
    const r = buf.replay(1);
    // 最旧的 seq=1 已被覆盖，保留 2..4
    assert.deepEqual(r.items.map((e) => e.seq), [2, 3, 4]);
  });

  test("欠载：fromSeq 早于最旧保留 seq → complete=false", () => {
    const buf = createRingBuffer(3);
    for (const n of [5, 6, 7, 8]) buf.push(n, n); // 覆盖掉 5，保留 6..8
    const r = buf.replay(1);
    assert.equal(r.complete, false);
    assert.deepEqual(r.items.map((e) => e.seq), [6, 7, 8]);
  });

  test("边界：fromSeq === latestSeq()+1 → 空列表且 complete=true", () => {
    const buf = createRingBuffer(5);
    for (const n of [1, 2, 3]) buf.push(n, n);
    assert.equal(buf.latestSeq(), 3);
    const r = buf.replay(4);
    assert.deepEqual(r.items, []);
    assert.equal(r.complete, true);
  });

  test("空缓冲：fromSeq===1 → 空列表且 complete=true", () => {
    const buf = createRingBuffer(5);
    assert.equal(buf.latestSeq(), null);
    const r = buf.replay(1);
    assert.deepEqual(r.items, []);
    assert.equal(r.complete, true);
  });

  test("空缓冲：fromSeq>1 且 latestSeq()===null → complete=false", () => {
    const buf = createRingBuffer(5);
    const r = buf.replay(2);
    assert.deepEqual(r.items, []);
    assert.equal(r.complete, false);
  });

  test("capacity 非法值抛 RangeError", () => {
    assert.throws(() => createRingBuffer(0), RangeError);
    assert.throws(() => createRingBuffer(-1), RangeError);
    assert.throws(() => createRingBuffer(1.5), RangeError);
  });

  test("push 拒绝非有限 seq（NaN / Infinity）", () => {
    const buf = createRingBuffer(5);
    assert.equal(buf.push(NaN, "x"), false);
    assert.equal(buf.push(Infinity, "x"), false);
    assert.equal(buf.size(), 0);
    assert.equal(buf.latestSeq(), null);
  });

  test("latestSeq / size / capacity 访问器随写入演进", () => {
    const buf = createRingBuffer(2);
    assert.equal(buf.capacity, 2);
    buf.push(1, "a");
    assert.equal(buf.latestSeq(), 1);
    assert.equal(buf.size(), 1);
    buf.push(2, "b");
    buf.push(3, "c"); // 覆盖最旧
    assert.equal(buf.latestSeq(), 3);
    assert.equal(buf.size(), 2);
  });
});
