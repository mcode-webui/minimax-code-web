// webui/test/port.test.js
// Unit coverage for the listen-port fallback (server/lib/port.js).
//
// The live-boot proof — a real server.js taking the next free port and then
// trusting that port's browser Origin — lives in
// test/integration/port-fallback.test.js. Here we pin only the pure rules and
// the listen/retry mechanics, on ports taken from the OS so nothing collides
// with a developer's own webui on the default port.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  MAX_PORT_ATTEMPTS,
  fallbackPort,
  isPortPinned,
  listenWithPortFallback,
} from "../server/lib/port.js";

/** Bind a bare listener and hand back the port it got. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler ?? ((_req, res) => res.end("ok")));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("isPortPinned", () => {
  test("a positive PORT value pins the port", () => {
    assert.equal(isPortPinned("18090"), true);
    assert.equal(isPortPinned(18090), true);
  });

  test("unset, empty, zero and non-numeric values count as not configured", () => {
    // These fall through to the default port and may fall back — the same set
    // that `Number(process.env.PORT) || 18090` maps onto the default.
    assert.equal(isPortPinned(undefined), false);
    assert.equal(isPortPinned(""), false);
    assert.equal(isPortPinned("   "), false);
    assert.equal(isPortPinned("0"), false);
    assert.equal(isPortPinned("-1"), false);
    assert.equal(isPortPinned("abc"), false);
  });
});

describe("fallbackPort", () => {
  test("walks one port at a time", () => {
    assert.equal(fallbackPort(18090, 1), 18091);
    assert.equal(fallbackPort(18091, 2), 18092);
  });

  test("stops once the attempt budget is spent", () => {
    assert.equal(fallbackPort(18090, MAX_PORT_ATTEMPTS), undefined);
    assert.equal(fallbackPort(18090, 1, 1), undefined);
    assert.equal(fallbackPort(18090, 1, 2), 18091);
  });

  test("stops at the end of the port range", () => {
    assert.equal(fallbackPort(65535, 1), undefined);
  });
});

describe("listenWithPortFallback", () => {
  test("a free port is used as-is and reported as bound", async () => {
    const { server: blocker, port } = await startServer();
    await stopServer(blocker); // the port is ours again, and definitely free

    const warnings = [];
    const server = http.createServer((_req, res) => res.end("served"));
    let bound;
    await new Promise((resolve) => {
      listenWithPortFallback(server, {
        port,
        host: "127.0.0.1",
        onListening: (p) => {
          bound = p;
          resolve();
        },
        onUnavailable: (error) => resolve(error),
        log: { warn: (m) => warnings.push(m) },
      });
    });

    assert.equal(bound, port);
    assert.equal(warnings.length, 0);
    assert.equal((await get(port, "/")).body, "served");
    await stopServer(server);
  });

  test("a taken default port walks forward to the next free port", async () => {
    const { server: blocker, port } = await startServer();

    const warnings = [];
    const server = http.createServer((_req, res) => res.end("served"));
    let bound;
    await new Promise((resolve) => {
      listenWithPortFallback(server, {
        port,
        host: "127.0.0.1",
        pinned: false,
        onListening: (p) => {
          bound = p;
          resolve();
        },
        onUnavailable: (error) => resolve(error),
        log: { warn: (m) => warnings.push(m) },
      });
    });

    assert.ok(bound > port, `expected a port above the taken one, got ${bound}`);
    assert.ok(
      bound - port <= MAX_PORT_ATTEMPTS,
      `fallback must stay inside the attempt budget, got ${bound - port}`,
    );
    assert.match(warnings.join("\n"), new RegExp(`port ${port} is already in use`));
    // The reported port is the one actually serving — the contract server.js
    // publishes to CORS origin trust and to the launcher's URL.
    assert.equal((await get(bound, "/")).body, "served");
    await stopServer(server);
    await stopServer(blocker);
  });

  test("a pinned port is never moved; the caller gets the listen error", async () => {
    const { server: blocker, port } = await startServer();

    const server = http.createServer((_req, res) => res.end("served"));
    let reported;
    await new Promise((resolve) => {
      listenWithPortFallback(server, {
        port,
        host: "127.0.0.1",
        pinned: true,
        onListening: resolve,
        onUnavailable: (error) => {
          reported = error;
          resolve();
        },
        log: { warn: () => {} },
      });
    });

    assert.equal(reported && reported.code, "EADDRINUSE");
    assert.equal(server.listening, false);
    await stopServer(blocker);
  });

  test("an exhausted budget reports the listen error instead of spinning", async () => {
    const { server: blocker, port } = await startServer();

    const server = http.createServer((_req, res) => res.end("served"));
    let reported;
    await new Promise((resolve) => {
      listenWithPortFallback(server, {
        port,
        host: "127.0.0.1",
        maxAttempts: 1,
        onListening: resolve,
        onUnavailable: (error) => {
          reported = error;
          resolve();
        },
        log: { warn: () => {} },
      });
    });

    assert.equal(reported && reported.code, "EADDRINUSE");
    assert.equal(server.listening, false);
    await stopServer(blocker);
  });

  test("an out-of-range port reports the error instead of throwing out of the helper", async () => {
    const server = http.createServer((_req, res) => res.end("served"));
    let reported;
    // `server.listen` throws synchronously (ERR_SOCKET_BAD_PORT) for this
    // rather than emitting 'error'. An escaped throw reaches the global handler,
    // which only logs — the live-but-not-listening process this change removes.
    await new Promise((resolve) => {
      listenWithPortFallback(server, {
        port: 70000,
        host: "127.0.0.1",
        pinned: true,
        onListening: resolve,
        onUnavailable: (error) => {
          reported = error;
          resolve();
        },
        log: { warn: () => {} },
      });
    });

    assert.equal(reported && reported.code, "ERR_SOCKET_BAD_PORT");
    assert.equal(server.listening, false);
  });
});
