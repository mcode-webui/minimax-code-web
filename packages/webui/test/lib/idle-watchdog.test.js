// webui/test/lib/idle-watchdog.test.js
// Unit tests for the idle watchdog that replaced the fixed 90s wall-clock
// chat timeout (v2.3). A long-but-healthy stream must never trip it; only a
// silent stream may.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const { createIdleWatchdog } = await import(absPath("lib/idle-watchdog.js"));

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("idle-watchdog", () => {
  test("fires after idleMs with no activity", async () => {
    let fired = null;
    const wd = createIdleWatchdog({
      idleMs: 40,
      activityAt: () => 1000,
      now: () => 1000 + Date.now(), // wall clock relative to fixed start
      onTimeout: (idle) => { fired = idle; },
      minTickMs: 10,
    });
    await tick(120);
    assert.ok(fired !== null, "should have fired");
    assert.ok(fired >= 40);
    wd.stop();
  });

  test("does not fire while activity keeps advancing", async () => {
    let fired = false;
    let lastActivity = 0;
    // Simulate a stream emitting an event every 20ms while the idle window
    // is 60ms — total stream life far exceeds 60ms.
    const wd = createIdleWatchdog({
      idleMs: 60,
      activityAt: () => lastActivity,
      now: () => Date.now(),
      onTimeout: () => { fired = true; },
      minTickMs: 10,
    });
    const emitter = setInterval(() => { lastActivity = Date.now(); }, 20);
    await tick(220); // > 3x the idle window
    clearInterval(emitter);
    assert.equal(fired, false, "healthy stream must not trip the watchdog");
    wd.stop();
  });

  test("fires after the stream goes silent, even after a long active period", async () => {
    let fired = false;
    let lastActivity = Date.now();
    const wd = createIdleWatchdog({
      idleMs: 50,
      activityAt: () => lastActivity,
      now: () => Date.now(),
      onTimeout: () => { fired = true; },
    });
    const emitter = setInterval(() => { lastActivity = Date.now(); }, 15);
    await tick(120); // long healthy period
    clearInterval(emitter); // stream goes silent
    await tick(140); // idle window elapses
    assert.equal(fired, true, "silent stream must trip the watchdog");
    wd.stop();
  });

  test("stop() prevents any later firing", async () => {
    let fired = false;
    const wd = createIdleWatchdog({
      idleMs: 30,
      activityAt: () => 0,
      now: () => Date.now(),
      onTimeout: () => { fired = true; },
    });
    wd.stop();
    await tick(80);
    assert.equal(fired, false);
  });

  test("rejects invalid construction", () => {
    assert.throws(() => createIdleWatchdog({ idleMs: 0, activityAt: () => 0, onTimeout: () => {} }));
    assert.throws(() => createIdleWatchdog({ idleMs: 100 }));
  });
});
