// webui/test/server/graceful-shutdown.test.js
//
// Bounded graceful-shutdown regression pin for the watcher wedge
// (ticket session-isolation/05). `installGracefulShutdown` must:
//
//   1. exit within the hard bound even when an SSE / long-poll
//      socket is still alive (the dev watcher's most-recent
//      failure mode);
//   2. exit within the close() callback when nothing is hanging
//      (the fast path, otherwise we add 1.5s to every restart);
//   3. force-destroy remaining sockets inside the grace window
//      so server.close()'s callback can fire on the next tick;
//   4. be idempotent — SIGINT + SIGTERM both fire under the
//      watcher's process group, and a double-handler would
//      re-arm the timers.
//
// These run against a real `node:http` server on an ephemeral
// port so the assertion is the integration shape, not a mock.

import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { installGracefulShutdown } from "../../server/lib/graceful-shutdown.js";

/**
 * Track every exit() invocation so the assertions can read both
 * the timing and the code without dying the test runner.
 */
function recordExits() {
  const calls = [];
  return { exit: (code) => calls.push({ code, t: Date.now() }), calls };
}

function bootEchoServer() {
  const server = createServer((req, res) => {
    // Answer fast so the test can read the response and keep the
    // socket open — that's the shape an SSE / long-poll client
    // holds across the SIGTERM.
    res.writeHead(200, { "content-type": "text/plain" });
    if (req.url === "/hold") {
      // Stream forever; the test will force-destroy on shutdown.
      res.write("keep-alive\n");
      // Periodic keep-alive writes so the client knows the
      // socket is still alive.
      const interval = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(interval);
        }
      }, 100);
      req.on("close", () => clearInterval(interval));
    } else {
      res.end("ok");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, opts, (res) => {
      // Resolve immediately on headers so callers can opt in
      // to a held connection by NOT consuming the body.
      resolve({ req, res, on: res.on.bind(res) });
    });
    req.on("error", reject);
    req.end();
  });
}

// Handles to uninstall at suite teardown so signal handlers do
// not leak across tests. Hoisted to file scope so the second
// describe below can register there too.
const handles = [];
after(() => {
  for (const h of handles) {
    try {
      h.uninstall();
    } catch {
      // already torn down
    }
  }
});
function track(uninstall) {
  handles.push({ uninstall });
}

describe("installGracefulShutdown — bounded exit", () => {
  // marker for the next describe (no shared state; track is module-scope now)
  void handles;

  test("SIGTERM with no active connection exits within the close callback window", async () => {
    const { server, port } = await bootEchoServer();
    const { exit, calls } = recordExits();
    const uninstall = installGracefulShutdown(server, {
      exit,
      graceMs: 200,
      hardExitMs: 1000,
    });
    track(uninstall);
    // Fire the signal.
    process.emit("SIGTERM");
    // The close callback path runs within one tick of the signal.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1, "exactly one exit");
    assert.equal(calls[0].code, 0);
  });

  test("SIGTERM with a held SSE-style connection still exits within the hard bound", async () => {
    const { server, port } = await bootEchoServer();
    const { exit, calls } = recordExits();
    const uninstall = installGracefulShutdown(server, {
      exit,
      graceMs: 100, // very short — the held socket would otherwise wait forever
      hardExitMs: 600,
    });
    track(uninstall);
    // Open a long-lived connection, do NOT consume the body.
    const { req, res } = await get(`http://127.0.0.1:${port}/hold`);
    // Wait for the first chunk so we know the response is established.
    await new Promise((r) => res.once("data", r));
    // Now signal — without the grace + hard bound this would hang
    // until the dev watcher's SIGKILL 5s later.
    process.emit("SIGTERM");
    // The grace window destroys the held socket; server.close()
    // fires its callback; exit(0) is called.
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(calls.length, 1, "exactly one exit");
    assert.equal(calls[0].code, 0);
    // Cleanup.
    req.destroy();
  });

  test("SIGINT + SIGTERM is idempotent — exit called once", async () => {
    const { server, port } = await bootEchoServer();
    const { exit, calls } = recordExits();
    const uninstall = installGracefulShutdown(server, {
      exit,
      graceMs: 200,
      hardExitMs: 1000,
    });
    track(uninstall);
    process.emit("SIGINT");
    process.emit("SIGTERM");
    process.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1, "idempotent — second signal is a no-op");
  });

  test("hard bound fires even if cleanup callbacks throw", async () => {
    const { server } = await bootEchoServer();
    const { exit, calls } = recordExits();
    let stopCalled = false;
    const uninstall = installGracefulShutdown(server, {
      exit,
      stopTranscriptSync: () => {
        stopCalled = true;
        throw new Error("transcript cleanup failed");
      },
      graceMs: 100,
      hardExitMs: 250,
    });
    track(uninstall);
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(stopCalled, true, "the failing cleanup was called");
    assert.equal(calls.length, 1, "hard bound fired despite throw");
  });

  test("uninstall() removes the signal handlers", async () => {
    const { server } = await bootEchoServer();
    const { exit, calls } = recordExits();
    const uninstall = installGracefulShutdown(server, {
      exit,
      graceMs: 100,
      hardExitMs: 500,
    });
    uninstall();
    track({ uninstall: () => {} });
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls.length, 0, "no exit after uninstall");
  });
});
describe("installGracefulShutdown — signal attribution logging (v2)", () => {
  test("logs signal + pid + ppid + timestamp on the SIGTERM path", async () => {
    // Best-effort forensic: when SIGTERM lands, the helper logs
    // its own identity (pid, ppid, signal name, ISO timestamp) so a
    // post-incident review can correlate the shutdown with the
    // launcher's child-exit line and external pkill logs.
    const { server } = await bootEchoServer();
    const { exit, calls } = recordExits();
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const uninstall = installGracefulShutdown(server, {
        exit,
        graceMs: 100,
        hardExitMs: 300,
      });
      // `track` and `uninstall` are defined in the outer describe;
      // we register the uninstall so handlers do not leak across
      // tests.
      track(uninstall);
      process.emit("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      console.log = original;
    }
    const attribution = lines.find((line) => line.startsWith("[graceful-shutdown] signal=SIGTERM"));
    assert.ok(
      attribution,
      `graceful-shutdown signal line missing; got: ${JSON.stringify(lines)}`,
    );
    // Pin the format so future readers know exactly what to grep.
    assert.match(attribution, /pid=\d+/);
    assert.match(attribution, /ppid=\d+/);
    assert.match(attribution, /ts=\d{4}-\d{2}-\d{2}T/); // ISO-8601 starts with YYYY-MM-DD
  });
});
