// webui/test/helpers/free-port.js
// Test-side port allocation for integration tests that boot the real
// server.js as a child process.
//
// Two invariants this helper enforces:
//   - findFreePort(): bind a node:net server on 127.0.0.1:0, read
//     server.address().port, close the server, return the port.
//     Pure OS-allocated free port — no guessing, no collisions with
//     the dev server on 18090 or any other test that ran first.
//   - parseListeningPort(stdout): regex out the last
//     "listening on http://<host>:<port>" line's port from the
//     server's stdout, returning a number or null. Callers must use
//     THIS port, never the one they asked for — server.js's
//     `Number(process.env.PORT) || 18090` rule treats 0 as "unset"
//     and the server's MAX_PORT_ATTEMPTS=20 fallback (server/lib/port.js)
//     walks forward on EADDRINUSE; without parseListeningPort, a
//     fallback on the server side is invisible to the test and the
//     next POST hits a stale/foreign port (EPIPE / 404).
//
// Race window: there is a small window between close() and the child
// process binding the port. The server's own MAX_PORT_ATTEMPTS=20
// fallback covers that case — but it is precisely why callers must
// always read the bound port, never the requested one.

import net from "node:net";

/**
 * Bind a TCP listener on 127.0.0.1:0 and return the port the kernel
 * chose. The listener is closed before the promise resolves, so the
 * port is only briefly held — see the header note about the race
 * window and the server-side fallback that handles it.
 *
 * @returns {Promise<number>} an ephemeral port currently free on loopback
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      // addr.port is the integer the kernel handed us; .close() must
      // be called before resolve so we don't hand out a port we still
      // own (and so a second caller's own bind doesn't see EADDRINUSE
      // from us).
      server.close((err) => {
        if (err) return reject(err);
        if (!addr || typeof addr.port !== "number") {
          return reject(new Error("findFreePort: server.address() had no port"));
        }
        resolve(addr.port);
      });
    });
  });
}

/**
 * Pull the port out of the server's startup log. The server prints
 *   [webui] listening on http://<host>:<port>
 * once it has bound the socket (server/bootstrap.js:127). We match the
 * LAST occurrence because the boot path logs additional `LAN url:`
 * and `http layer:` lines after the listening line — none of those
 * carry the live port, so anchoring on the first match is wrong.
 *
 * Returns the parsed integer port, or null when the line hasn't
 * appeared yet (caller should keep waiting for more stdout).
 *
 * @param {string} stdout  accumulated child stdout
 * @returns {number | null}
 */
export function parseListeningPort(stdout) {
  if (typeof stdout !== "string" || !stdout) return null;
  // global flag → find every match, take the last one.
  const re = /listening on http:\/\/[^/\s:]+:(\d+)/g;
  let m;
  let last = null;
  while ((m = re.exec(stdout)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n <= 65535) last = n;
  }
  return last;
}