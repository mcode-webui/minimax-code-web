// webui/test/integration/ws-channel.test.js
// D02 lease successor of sse-channel.test.js — end-to-end WebSocket event
// channel test after the SSE removal (live surface = WS event stream +
// REST; the old stream endpoint and its SSE adapter are gone).
//
// Boots the real server.js (isolated settings/events paths so tests don't
// bleed state) and exercises the live surfaces:
//   1. /api/stream — WS handshake → hello frame shape
//   2. auth.token_rotated control frame fires when settings resets the
//      token (driven through the real authorize gate wire path)
//   3. GET /api/alerts — REST snapshot (200 application/json)
//   4. resume smoke — {type:"resume"} replays state.snapshot/control
//      frames or answers error "resume-underrun"; an empty stream
//      (hello.latestSeq === null) may legitimately answer nothing.
//
// Startup/timeout/teardown pattern inherited from the old
// sse-channel.test.js: spawn a child server.js, 3s boot guard, per-test
// beforeEach/afterEach, SIGTERM → exit-wait(1500) → SIGKILL, rm tmpdir.
//
// WS client is hand-rolled in this file (RFC 6455):
//   - net upgrade: Connection: Upgrade / Upgrade: websocket headers + a
//     random 16-byte Sec-WebSocket-Key (base64); read the response and
//     require "HTTP/1.1 101" (Sec-WebSocket-Accept verified via the RFC
//     GUID SHA-1 formula).
//   - Server → client frames are NOT masked (RFC 6455 §5.1), so decoding
//     uses a local unmasked frame parser (same shape as
//     test/lib-ws-server.test.js#parseServerFrames —
//     lib/ws-frame.js#createFrameDecoder is the client→server direction
//     decoder and rejects unmasked frames with 1002, verified).
//   - Client → server frames are masked locally: FIN|0x81, mask bit set,
//     4-byte random key, payload XOR; text length < 126 (7-bit length).
//   - 2500ms timeout-resolve guard on connect: a hung handshake resolves
//     with timedOut:true instead of hanging the suite.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import http from "node:http";
import { decideNextAuthorization } from "../_setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function pickPort() {
    return 19600 + Math.floor(Math.random() * 80);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(pred, ms = 2500) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (pred()) return;
        await sleep(15);
    }
    assert.fail("waitUntil: condition not met within " + ms + "ms");
}

// spawnServer returns { proc, port, tmpDir, settingsPath, eventsPath,
// stderr }. Same boot contract as the old sse-channel.test.js (minus the
// STATE_PUSH_THROTTLE_MS knob — the throttle/coalesce adapter is gone).
async function spawnServer() {
    const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-d02-ws-"));
    const settingsPath = join(tmpDir, "settings.json");
    const eventsPath = join(tmpDir, "events.ndjson");
    const port = pickPort();
    const env = {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        MCODE_WEBUI_SETTINGS_PATH: settingsPath,
        MCODE_WEBUI_EVENTS_PATH: eventsPath,
        // U1 (2026-09-20 rigor fix): redirect upload dir + sessions db
        // away from MCODE_ROOT — see router-boot.test.js (stray
        // .webui-uploads/ breaks marketplace validate.mjs). tmpDir is
        // per-test mkdtemp'd and rmSync'd in stopServer below.
        MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
        MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
        TOKEN: "",
        MCODE_WEBUI_TOKEN_STDOUT: "0",
    };
    // Plain node (no mock flag): the authorize() test-mode auto-approve
    // was removed in the 2026-09-20 rigor fix. The token-reset test
    // below drives the gate through the production wire path (WS
    // needs_authorization control frame + POST /api/auth/decision).
    const proc = spawn("node", [serverJsPath], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: join(__dirname, "..", ".."),
        env,
    });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const ready = new Promise((resolve, reject) => {
        const onChunk = () => {
            if (/listening on/.test(stdout)) {
                proc.stdout.off("data", onChunk);
                resolve();
            }
        };
        proc.stdout.on("data", onChunk);
        setTimeout(() => {
            reject(
                new Error(
                    `server.js did not start within 3s on port ${port}\n` +
                    `stdout: ${stdout}\nstderr: ${stderr}`,
                ),
            );
        }, 3000);
    });
    await ready;
    return { proc, port, tmpDir, settingsPath, eventsPath, stderr };
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

// ---------------------------------------------------------------------------
// Hand-rolled WS client. Resolves { header, frames, send(text), close(),
// timedOut } — frames accumulate every server TEXT frame as parsed JSON.
// ---------------------------------------------------------------------------
function parseServerTextFrames(st, frames) {
    while (st.buf.length >= 2) {
        const opcode = st.buf[0] & 0x0f;
        let len = st.buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
            if (st.buf.length < 4) return;
            len = st.buf.readUInt16BE(2);
            offset = 4;
        } else if (len === 127) {
            if (st.buf.length < 10) return;
            len = Number(st.buf.readBigUInt64BE(2));
            offset = 10;
        }
        const masked = (st.buf[1] & 0x80) !== 0;
        const maskLen = masked ? 4 : 0;
        if (st.buf.length < offset + maskLen + len) return;
        let payload = st.buf.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
            const mk = st.buf.subarray(offset, offset + 4);
            const un = Buffer.allocUnsafe(len);
            for (let i = 0; i < len; i++) un[i] = payload[i] ^ mk[i & 3];
            payload = un;
        }
        st.buf = st.buf.subarray(offset + maskLen + len);
        if (opcode === 0x1) {
            const text = payload.toString("utf8");
            try { frames.push(JSON.parse(text)); } catch { frames.push({ raw: text }); }
        }
        // ping/pong/close/binary: consumed, not surfaced.
    }
}

function encodeMaskedTextFrame(text) {
    const body = Buffer.from(String(text), "utf8");
    assert.ok(body.length < 126, "test frames must fit the 7-bit length field");
    const key = randomBytes(4);
    const head = Buffer.alloc(6);
    head[0] = 0x81; // FIN | TEXT
    head[1] = 0x80 | body.length; // mask bit + 7-bit length
    key.copy(head, 2);
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
    return Buffer.concat([head, masked]);
}

function openWs({ port, path }) {
    return new Promise((resolve) => {
        const st = { header: "", buf: Buffer.alloc(0), handshook: false };
        const frames = [];
        let settled = false;
        const key = randomBytes(16).toString("base64");
        const api = {
            frames,
            send(text) { st.socket.write(encodeMaskedTextFrame(text)); },
            close() { try { st.socket.destroy(); } catch {} },
        };
        // 2500ms timeout-resolve guard: a hung handshake settles as
        // timedOut:true so the case fails loudly instead of hanging.
        const guard = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { st.socket.destroy(); } catch {}
            resolve({ ...api, header: st.header, timedOut: true });
        }, 2500);
        const done = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            if (err) {
                try { st.socket.destroy(); } catch {}
                resolve({ ...api, header: st.header, error: err, timedOut: false });
            } else {
                resolve({ ...api, header: st.header, timedOut: false });
            }
        };
        st.socket = net.connect(port, "127.0.0.1");
        st.socket.on("error", (e) => { if (!st.handshook) done(e); });
        st.socket.on("data", (chunk) => {
            if (!st.handshook) {
                st.header += chunk.toString("latin1");
                const idx = st.header.indexOf("\r\n\r\n");
                if (idx === -1) return;
                const head = st.header.slice(0, idx);
                const rest = Buffer.from(st.header.slice(idx + 4), "latin1");
                if (!/^HTTP\/1\.1 101\b/.test(head)) {
                    done(new Error("expected 101 upgrade, got: " + (head.split("\r\n")[0] || "(empty)")));
                    return;
                }
                const accept = head.match(/^sec-websocket-accept:\s*(.+)$/im);
                const expected = createHash("sha1").update(key + WS_GUID, "utf8").digest("base64");
                if (accept && accept[1].trim() !== expected) {
                    done(new Error("bad Sec-WebSocket-Accept"));
                    return;
                }
                st.handshook = true;
                if (rest.length) {
                    st.buf = Buffer.concat([st.buf, rest]);
                    parseServerTextFrames(st, frames);
                }
                done();
                return;
            }
            st.buf = Buffer.concat([st.buf, chunk]);
            parseServerTextFrames(st, frames);
        });
        st.socket.on("connect", () => {
            st.socket.write(
                "GET " + path + " HTTP/1.1\r\n" +
                "Host: 127.0.0.1:" + port + "\r\n" +
                "Connection: Upgrade\r\n" +
                "Upgrade: websocket\r\n" +
                "Sec-WebSocket-Key: " + key + "\r\n" +
                "Sec-WebSocket-Version: 13\r\n" +
                "\r\n",
            );
        });
    });
}

// Minimal JSON request helper (POST body / GET) — mirrors the old
// sse-channel.test.js postJson, extended with headers-only GETs.
function requestJson({ method = "GET", port, path, body, headers = {} }) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? "" : JSON.stringify(body);
        const req = http.request(
            {
                method,
                host: "127.0.0.1",
                port,
                path,
                headers: {
                    ...(body === undefined ? {} : {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(data),
                    }),
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
        if (body !== undefined) req.write(data);
        req.end();
    });
}

function helloOf(ws) {
    return ws.frames.find((f) => f && f.type === "hello");
}

function controlNamed(ws, name) {
    return ws.frames.find((f) => f && f.type === "control" && f.payload && f.payload.name === name);
}

// ---------------------------------------------------------------------------
describe("ws-channel: GET /api/stream", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("handshake returns 101 and the first frame is a well-formed hello", async () => {
        const ws = await openWs({ port: server.port, path: "/api/stream?cid=test-cid-1" });
        assert.equal(ws.timedOut, false, "connect timeout: header=" + ws.header);
        assert.equal(ws.error, undefined, "upgrade failed: " + (ws.error && ws.error.message));
        assert.ok(ws.header.startsWith("HTTP/1.1 101"), "header=" + ws.header);
        await waitUntil(() => helloOf(ws));
        const hello = helloOf(ws);
        assert.equal(hello.v, 1);
        assert.equal(hello.type, "hello");
        assert.equal(hello.payload.resumeSupported, true);
        assert.ok(
            hello.payload.latestSeq === null || typeof hello.payload.latestSeq === "number",
            `latestSeq must be number|null, got ${JSON.stringify(hello.payload.latestSeq)}`,
        );
        assert.equal(typeof hello.payload.heartbeatMs, "number");
        ws.close();
    });

    test("auth.token_rotated control frame fires on token reset", async () => {
        // Open the stream FIRST, then trigger the reset. The server pushes
        // the named control event auth.token_rotated to all connected cids.
        const ws = await openWs({ port: server.port, path: "/api/stream?cid=test-cid-rot" });
        assert.equal(ws.timedOut, false, "connect timeout: header=" + ws.header);
        await waitUntil(() => helloOf(ws));
        // The reset is authorize()-gated (no auto-approve since the
        // 2026-09-20 rigor fix). Subscribe the decider BEFORE firing the
        // POST (needs_authorization broadcasts are fire-once), then drive
        // the real wire path.
        const decisionPromise = decideNextAuthorization({
            port: server.port,
            approve: true,
            cid: "test-cid-decider",
        });
        await sleep(150);
        const postPromise = requestJson({
            method: "POST",
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
        // The control frame must land on our stream.
        await waitUntil(() => controlNamed(ws, "auth.token_rotated"), 2500);
        const rotated = controlNamed(ws, "auth.token_rotated");
        assert.ok(rotated, "expected auth.token_rotated control frame");
        // data is the raw new token (a 32-hex-ish string) — must arrive as
        // a NON-EMPTY string per the WS control-frame contract.
        assert.equal(typeof rotated.payload.data, "string");
        assert.ok(rotated.payload.data.length > 0, "auth.token_rotated data must be non-empty");
        ws.close();
    });

    test("resume smoke: any post-resume frame is replay or resume-underrun", async () => {
        const ws = await openWs({ port: server.port, path: "/api/stream?cid=test-cid-resume" });
        assert.equal(ws.timedOut, false, "connect timeout: header=" + ws.header);
        await waitUntil(() => helloOf(ws), 2500);
        const hello = helloOf(ws);
        assert.equal(hello.v, 1);
        // Settle: let connect-side pushes (pushOnlineCount / mavis
        // hydrate) land, then mark the boundary BEFORE sending resume.
        await sleep(300);
        const mark = ws.frames.length;
        ws.send(JSON.stringify({ v: 1, type: "resume", payload: { lastSeq: 0 } }));
        await sleep(600);
        const after = ws.frames.slice(mark);
        for (const f of after) {
            const ok =
                f.type === "state.snapshot" ||
                f.type === "control" ||
                (f.type === "error" && f.payload && f.payload.code === "resume-underrun");
            assert.ok(ok, `unexpected frame after resume: ${JSON.stringify(f)}`);
        }
        // For an empty stream (latestSeq===null) the server may replay
        // nothing at all — the per-frame assertion above is vacuous then,
        // which is exactly the contract for this smoke test.
        assert.ok(
            hello.payload.latestSeq === null || typeof hello.payload.latestSeq === "number",
        );
        ws.close();
    });
});

// ---------------------------------------------------------------------------
// GET /api/alerts — REST snapshot (was SSE; now plain JSON).
// ---------------------------------------------------------------------------
describe("ws-channel: GET /api/alerts (REST)", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("returns 200 application/json with kind=snapshot + alerts array", async () => {
        const res = await requestJson({ port: server.port, path: "/api/alerts" });
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        assert.ok(
            String(res.headers["content-type"] || "").includes("application/json"),
            `Content-Type must be application/json, got ${res.headers["content-type"]}`,
        );
        assert.ok(res.json, "body must parse as JSON: " + res.body.slice(0, 200));
        assert.equal(res.json.kind, "snapshot");
        assert.ok(Array.isArray(res.json.alerts), "body.alerts must be an array");
    });
});
