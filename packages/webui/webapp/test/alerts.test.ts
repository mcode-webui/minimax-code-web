import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyAlertFrame, parseAlertFrame } from "../lib/alerts";
import type { AlertItem } from "../lib/api";

/**
 * The alerts channel is SSE, and this parser is the boundary where its frames
 * become UI state. It exists because the previous consumer treated the endpoint
 * as JSON: `fetch()` never resolved, and each leaked connection ate one slot of
 * the browser's per-host budget until unrelated requests (creating a session,
 * switching one) stopped returning. The frame contract is pinned here so a
 * future change to the stream surfaces as a test failure rather than as a hung
 * button.
 */

const alert = (id: string, level: AlertItem["level"] = "warn", count = 1): AlertItem => ({
  id,
  ts: 1,
  level,
  msg: `msg-${id}`,
  src: "test",
  cid: null,
  sessionId: null,
  count,
});

describe("parseAlertFrame", () => {
  it("reads the opening snapshot", () => {
    const frame = parseAlertFrame("", JSON.stringify({ kind: "snapshot", alerts: [alert("a")] }));
    assert.deepEqual(frame, { kind: "snapshot", alerts: [alert("a")] });
  });

  it("reads append and update frames", () => {
    assert.deepEqual(parseAlertFrame("", JSON.stringify({ kind: "append", alert: alert("b") })), {
      kind: "append",
      alert: alert("b"),
    });
    assert.deepEqual(parseAlertFrame("", JSON.stringify({ kind: "update", alert: alert("b", "warn", 3) })), {
      kind: "update",
      alert: alert("b", "warn", 3),
    });
  });

  it("treats the named heartbeat frame as a keepalive", () => {
    assert.deepEqual(parseAlertFrame("heartbeat", JSON.stringify({ ts: 1 })), { kind: "heartbeat" });
  });

  it("reports malformed frames instead of throwing", () => {
    assert.equal(parseAlertFrame("", "{oops").kind, "malformed");
    assert.equal(parseAlertFrame("", JSON.stringify({ kind: "nope" })).kind, "malformed");
    assert.equal(parseAlertFrame("", JSON.stringify({ kind: "append" })).kind, "malformed");
    assert.equal(parseAlertFrame("surprise", "{}").kind, "malformed");
    assert.equal(parseAlertFrame("", "null").kind, "malformed");
  });

  it("accepts an unnamed `message` event as a payload frame", () => {
    const frame = parseAlertFrame("message", JSON.stringify({ kind: "snapshot", alerts: [] }));
    assert.deepEqual(frame, { kind: "snapshot", alerts: [] });
  });
});

describe("applyAlertFrame", () => {
  it("reverses the snapshot into newest-first display order", () => {
    const frame = parseAlertFrame(
      "",
      JSON.stringify({ kind: "snapshot", alerts: [alert("old"), alert("new")] }),
    );
    assert.deepEqual(
      applyAlertFrame([], frame).map((item) => item.id),
      ["new", "old"],
    );
  });

  it("prepends an append", () => {
    const next = applyAlertFrame([alert("new"), alert("old")], { kind: "append", alert: alert("newest") });
    assert.deepEqual(
      next.map((item) => item.id),
      ["newest", "new", "old"],
    );
  });

  it("replaces an update in place without reordering", () => {
    const next = applyAlertFrame([alert("a"), alert("b")], {
      kind: "update",
      alert: alert("b", "error", 4),
    });
    assert.deepEqual(
      next.map((item) => `${item.id}:${item.count}`),
      ["a:1", "b:4"],
    );
  });

  it("prepends an update for an alert it has not seen", () => {
    const next = applyAlertFrame([alert("a")], { kind: "update", alert: alert("z", "error", 2) });
    assert.deepEqual(
      next.map((item) => item.id),
      ["z", "a"],
    );
  });

  it("leaves the list untouched for heartbeats and malformed frames", () => {
    const current = [alert("a")];
    assert.equal(applyAlertFrame(current, { kind: "heartbeat" }), current);
    assert.equal(applyAlertFrame(current, { kind: "malformed", detail: "x" }), current);
  });
});
