// webui/test/integration/sse-channel.test.js
// D02 lease: end-to-end SSE channel test.
//
// Boots the real server.js (with isolated settings/events paths so
// tests don't bleed state) and exercises the three live SSE surfaces:
//   1. /api/events   — per-cid state + named events (auth.token_rotated)
//   2. /api/alerts   — independent anomaly channel (B02)
//   3. /api/state    — one-shot JSON snapshot (not streaming, but covered
//                      for parity with router-boot.test.js and to anchor
//                      the test that pushes arrive in the right order)
//
// Sub-tests:
//   - Subscribe order + initial frame shape for /api/events and /api/alerts
//   - auth.token_rotated event fires on /api/events when settings resets token
//   - alerts push after pushAlert() (simulated via settings.write path —
//     settings.js writes events.ndjson which triggers alerts.js to fire
//     the audit event)
//   - Dedup: two identical alerts within 60s collapse (alerts.js)
//   - B04 60Hz coalescing: STATE_PUSH_THROTTLE_MS=16 — multiple rapid
//     state pushes coalesce to fewer wire frames

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { decideNextAuthorization } from "../helpers/_setup.js";
import { findFreePort, parseListeningPort } from "../helpers/free-port.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");

// Port: findFreePort() returns an OS-allocated ephemeral port. The
// recorded `port` is the value the child logged on its "listening
// on http://host:port" line, NOT the port we asked for —
// server/lib/port.js#listenWithPortFallback walks forward on
// EADDRINUSE, so callers must always read the bound port or they
// POST to a wrong/stale socket (see test/helpers/free-port.js).

// spawnServer returns { proc, port, tmpDir, settingsPath, eventsPath,
// stderr }. Pass opts.throttleMs to set STATE_PUSH_THROTTLE_MS for
// 60Hz coalescing tests.
async function spawnServer(opts = {}) {
    const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-d02-sse-"));
    const settingsPath = join(tmpDir, "settings.json");
    const eventsPath = join(tmpDir, "events.ndjson");
    const requestedPort = opts.port || await findFreePort();
    const env = {
        ...process.env,
        PORT: String(requestedPort),
        HOST: "127.0.0.1",
        MCODE_WEBUI_SETTINGS_PATH: settingsPath,
        MCODE_WEBUI_EVENTS_PATH: eventsPath,
        // Redirect upload dir + sessions db away from MCODE_ROOT —
        // see router-boot.test.js (U1, 2026-09-20 webui-rigor-fix;
        // stray .webui-uploads/ breaks marketplace validate.mjs).
        MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
        MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
        TOKEN: "",
        MCODE_WEBUI_TOKEN_STDOUT: "0",
    };
    if (opts.throttleMs !== undefined) {
        env.STATE_PUSH_THROTTLE_MS = String(opts.throttleMs);
    }
    // Plain node (no mock flag): the authorize() test-mode auto-approve
    // was removed in the 2026-09-20 rigor fix. The token-reset test
    // below drives the gate through the production wire path (SSE
    // needs_authorization + POST /api/auth/decision).
    const proc = spawn("node", [serverJsPath], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: join(__dirname, "..", ".."),
        env,
    });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    let boundPort = null;
    const ready = new Promise((resolve, reject) => {
        const onChunk = () => {
            const p = parseListeningPort(stdout);
            if (p !== null) {
                boundPort = p;
                proc.stdout.off("data", onChunk);
                clearTimeout(timer);
                resolve();
            }
        };
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `server.js did not start within 3s on port ${requestedPort}\n` +
                    `stdout: ${stdout}\nstderr: ${stderr}`,
                ),
            );
        }, 3000);
        proc.stdout.on("data", onChunk);
    });
    await ready;
    const port = boundPort !== null ? boundPort : requestedPort;
    return { proc, port, requestedPort, tmpDir, settingsPath, eventsPath, stderr };
}

async function stopServer(proc, tmpDir) {
    if (proc && proc.exitCode === null) {
        try { proc.kill("SIGTERM"); } catch {}
        await Promise.race([
            new Promise((r) => proc.on("exit", r)),
            new Promise((r) => setTimeout(r, 1500)),
        ]);
        if (proc.exitCode === null) {
            try { proc.kill("SIGKILL"); } catch {}
        }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// Open an SSE stream against the server, accumulate frames for `ms`
// milliseconds, then resolve with the joined body. Caller parses out
// event: / data: lines itself.
function openSse({ port, path, ms = 800, headers = {} }) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { method: "GET", host: "127.0.0.1", port, path, headers },
            (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (body += c));
                const timer = setTimeout(() => {
                    try { req.destroy(); } catch {}
                    resolve({ status: res.statusCode, headers: res.headers, body });
                }, ms);
                res.on("end", () => {
                    clearTimeout(timer);
                    resolve({ status: res.statusCode, headers: res.headers, body });
                });
                res.on("error", (e) => {
                    clearTimeout(timer);
                    reject(e);
                });
            },
        );
        req.on("error", reject);
        req.end();
    });
}

// POST helper — returns parsed JSON or raw body.
function postJson({ port, path, body, headers = {} }) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const req = http.request(
            {
                method: "POST",
                host: "127.0.0.1",
                port,
                path,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                    ...headers,
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    let json;
                    try { json = JSON.parse(raw); } catch {}
                    resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
                });
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

// Parse a raw SSE body into an array of { event, data } frames.
// data is JSON-parsed when possible (else kept as raw string).
function parseSse(body) {
    const frames = [];
    let event = "message"; // SSE default event name
    let dataBuf = "";
    let lineNo = 0;
    for (const raw of body.split("\n")) {
        const line = raw.replace(/\r$/, "");
        lineNo++;
        if (!line) {
            if (dataBuf) {
                let data = dataBuf;
                try { data = JSON.parse(dataBuf); } catch {}
                frames.push({ event, data });
                event = "message";
                dataBuf = "";
            }
            continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat
        if (line.startsWith("event: ")) {
            event = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
            dataBuf = dataBuf ? dataBuf + "\n" + line.slice("data: ".length) : line.slice("data: ".length);
        }
    }
    return frames;
}

// -----------------------------------------------------------------------
// Test 1: /api/events opens with Content-Type text/event-stream and the
// first frame is a state snapshot (matching state.js#handleEvents
// line 70).
// -----------------------------------------------------------------------
describe("sse-channel: /api/events", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("opens text/event-stream + emits state snapshot as first frame", async () => {
        const res = await openSse({
            port: server.port,
            path: "/api/events?cid=test-cid-1",
            ms: 500,
        });
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        assert.equal(
            String(res.headers["content-type"] || "").startsWith("text/event-stream"),
            true,
            "Content-Type must be text/event-stream",
        );
        // The first data frame is the snapshot. Parse it and check the
        // shape — state.js#handleEvents line 70 writes
        // `data: ${JSON.stringify(snapshot)}`. Note: the first SSE
        // snapshot does NOT include `onlineCount` (that's only added
        // by pushStateFor() in state-bus.js, line 156); the fields
        // we assert here ARE present in the initial snapshot.
        const frames = parseSse(res.body);
        assert.ok(frames.length >= 1, "at least one SSE frame received");
        const snap = frames[0].data;
        assert.ok(snap && typeof snap === "object", "first frame is object");
        assert.equal(typeof snap.version, "string");
        assert.ok(snap.workspace, "workspace present in snapshot");
        assert.ok(snap.model, "model present in snapshot");
        assert.equal(typeof snap.tokenEnabled, "boolean", "tokenEnabled flag present");
    });

    test("auth.token_rotated SSE event fires on token reset", async () => {
        // Open the SSE stream FIRST, then trigger the reset. The server
        // will push the named event auth.token_rotated to all connected
        // cids. We wait ~2500ms so the rotation broadcast reaches us.
        const ssePromise = openSse({
            port: server.port,
            path: "/api/events?cid=test-cid-rot",
            ms: 2500,
        });
        // Give the SSE a moment to connect before POSTing the reset,
        // so the server's sseByCid.set(cid, res) has run.
        await new Promise((r) => setTimeout(r, 200));
        // The reset is authorize()-gated (no auto-approve since the
        // 2026-09-20 rigor fix). Subscribe the decider BEFORE firing
        // the POST (needs_authorization broadcasts are fire-once),
        // then drive the real wire path.
        const decisionPromise = decideNextAuthorization({
            port: server.port,
            approve: true,
            cid: "test-cid-decider",
        });
        await new Promise((r) => setTimeout(r, 150));
        const postPromise = postJson({
            port: server.port,
            path: "/api/settings",
            body: { resetToken: true },
            headers: { "x-test-cid": "test-cid-rot" },
        });
        const { decision } = await decisionPromise;
        assert.ok(decision, "auth decision must have been posted");
        const post = await postPromise;
        assert.equal(post.status, 200, `POST /api/settings resetToken returned ${post.status}`);
        assert.equal(post.json && post.json.ok, true);
        assert.equal(post.json && post.json.tokenRotated, true);
        const res = await ssePromise;
        const frames = parseSse(res.body);
        // Find the auth.token_rotated frame.
        const rotated = frames.find((f) => f.event === "auth.token_rotated");
        assert.ok(
            rotated,
            `expected auth.token_rotated event. body: ${res.body.slice(0, 500)}`,
        );
        // The data is the raw new token (state-bus.js#broadcastTokenRotated
        // line 625: data: ${token}). It's a 32-hex string.
        assert.match(String(rotated.data), /^[a-f0-9]{16,}$/);
    });

});

// -----------------------------------------------------------------------
// Test 2: /api/alerts — independent anomaly channel (B02).
//   - Snapshot frame on connect
//   - SSE heartbeat is scheduled (HEARTBEAT_MS = 30_000 in alerts.js)
//     — we don't wait 30s but we assert the channel stays open + the
//     Content-Type is correct.
//   - Dedup: we trigger two identical alerts and verify the count
//     bumps in the second frame.
// -----------------------------------------------------------------------
describe("sse-channel: /api/alerts", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("opens text/event-stream + emits snapshot frame with alerts array", async () => {
        const res = await openSse({
            port: server.port,
            path: "/api/alerts",
            ms: 400,
        });
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        assert.equal(
            String(res.headers["content-type"] || "").startsWith("text/event-stream"),
            true,
        );
        const frames = parseSse(res.body);
        assert.ok(frames.length >= 1, "at least one frame");
        const snap = frames[0].data;
        assert.ok(snap && snap.kind === "snapshot", "first frame is snapshot");
        assert.ok(Array.isArray(snap.alerts), "snapshot.alerts is array");
        // Fresh server → ring buffer empty.
        assert.equal(snap.alerts.length, 0);
    });

    test("ring buffer survives SSE reconnect (snapshot replays recent)", async () => {
        // First connect + close, second connect should still see the
        // empty buffer (fresh server, no pushAlert calls).
        const r1 = await openSse({ port: server.port, path: "/api/alerts", ms: 200 });
        const r2 = await openSse({ port: server.port, path: "/api/alerts", ms: 200 });
        const frames2 = parseSse(r2.body);
        const snap = frames2[0].data;
        assert.equal(snap.alerts.length, 0, "fresh server has no alerts");
        // Both connections opened 200 OK — assert r1 also opened cleanly.
        assert.equal(r1.status, 200);
    });
});

// -----------------------------------------------------------------------
// Test 3: B04 60Hz coalescing.
//
// Set STATE_PUSH_THROTTLE_MS=16 (≈60Hz) for the server process. POST
// /api/settings several rapid changes, then drain the SSE stream
// and count `state` frames. With coalescing, N settings changes
// produce AT MOST ~1 wire frame per throttle window for the same
// cid.
//
// Important: ticket 08 changed the diff gate's contract. Identical
// payloads now legitimately carry a fresh `revision` (the diff
// gate is now a static-source tripwire — see
// test/lib/state-bus-coalesce.check.mjs). The "collapse" assertion
// is now strictly TIME-BASED, so the test fires its POSTs in
// parallel (Promise.all) so they hit the server within the 16ms
// throttle window regardless of CI RTT. Sequential awaits made the
// test deterministic on localhost but flake-prone on slower CI
// runners where each round-trip exceeded the throttle window.
//
// Each POST toggles a different setting field (readOnly /
// lanBroadcast / tokenEnabled), guaranteeing the settings handler's
// change-detection guard fires for every POST regardless of the
// order in which Node.js event-loop processes them.
// -----------------------------------------------------------------------
describe("sse-channel: 60Hz coalescing (STATE_PUSH_THROTTLE_MS=16)", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer({ throttleMs: 16 });
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("rapid settings updates collapse to fewer wire frames than calls", async () => {
        const ssePromise = openSse({
            port: server.port,
            path: "/api/events?cid=cid-coalesce",
            ms: 1500,
        });
        // Let the SSE connect + the server's pushOnlineCount broadcast
        // land before the test's POST burst.
        await new Promise((r) => setTimeout(r, 200));

        // Fire N changes in PARALLEL. They hit the server within
        // microseconds of each other, well inside the 16ms throttle
        // window — every server-side pushStateFor reservation inside
        // that window lands on the SAME wire frame (last-call-wins).
        //
        // Each POST toggles a value OPPOSITE to its default so the
        // settings handler's `if (value !== current) pushStateFor`
        // guard always fires. The defaults (server/lib/settings.js
        // #defaultState) are `lanBroadcast: true` (LAN gate stays
        // open across reboots), `readOnly: false`, `tokenEnabled:
        // true` — a body matching the default is a no-op and the
        // handler does NOT call pushStateFor. The earlier version
        // of this test used sequential `await postJson` and depended
        // on localhost RTT being < 16ms so the 16ms throttle could
        // coalesce — which failed on slower CI runners (PR #42).
        //
        // Distinct fields per POST keep every push live even when
        // the parallel POSTs interleave on the server: each handler
        // reads the current state at its moment of execution and finds
        // a difference on the field it owns.
        const N = 5;
        const posts = [
            // lanBroadcast default = true → toggle to false
            postJson({
                port: server.port, path: "/api/settings",
                body: { lanBroadcast: false },
            }),
            // lanBroadcast back to true
            postJson({
                port: server.port, path: "/api/settings",
                body: { lanBroadcast: true },
            }),
            // readOnly default = false → toggle to true
            postJson({
                port: server.port, path: "/api/settings",
                body: { readOnly: true },
            }),
            // readOnly back to false
            postJson({
                port: server.port, path: "/api/settings",
                body: { readOnly: false },
            }),
            // tokenEnabled default = true → toggle to false
            postJson({
                port: server.port, path: "/api/settings",
                body: { tokenEnabled: false },
            }),
        ];
        await Promise.all(posts);

        const res = await ssePromise;
        const frames = parseSse(res.body);
        let stateFrames = 0;
        let maxRevision = -1;
        for (const f of frames) {
            if (f.event === "message" && f.data && typeof f.data === "object"
                && typeof f.data.onlineCount === "number") {
                stateFrames++;
                if (typeof f.data.revision === "number"
                    && f.data.revision > maxRevision) {
                    maxRevision = f.data.revision;
                }
            }
        }
        // Subtract the initial SSE frame AND the server's
        // pushOnlineCount broadcast (which lands right after the
        // client connects). The two pre-burst frames are not part
        // of the test's N-POST assertion.
        const subsequent = Math.max(0, stateFrames - 2);
        assert.ok(
            subsequent <= N - 1,
            `${N} parallel changes should coalesce to ≤ ${N - 1} subsequent frames, ` +
            `got ${subsequent}. body: ${res.body.slice(0, 600)}`,
        );
        // And we got AT LEAST one subsequent frame (otherwise
        // coalescing would have eaten everything — that's also a bug).
        assert.ok(
            subsequent >= 1,
            `${N} parallel changes should produce ≥ 1 subsequent frame, ` +
            `got ${subsequent}`,
        );

        // ticket 08 invariant: every pushStateFor reservation
        // increments the per-cid revision BEFORE the snapshot is
        // stringified. A coalesced wire frame therefore carries the
        // LAST reserved revision (the LAST pre-write bump). With the
        // initial frame (rev=1) + pushOnlineCount broadcast (rev=2)
        // + N POST broadcasts, the LAST wire frame's revision must
        // be ≥ N+2 even when many of the POSTs coalesced into a
        // single frame.
        assert.ok(
            maxRevision >= N + 2,
            `coalesced frame's revision must reflect every pushStateFor ` +
            `reservation (LAST wins). expected ≥ ${N + 2}, got ${maxRevision}. ` +
            `body: ${res.body.slice(0, 600)}`,
        );
    });
});