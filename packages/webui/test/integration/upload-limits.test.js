// webui/test/integration/upload-limits.test.js
// End-to-end coverage for PR #55 review point 3 ("Uploads are
// unbounded"): the real server.js + router + routes/upload.js +
// lib/upload.js stack with the three upload limits wired through env
// knobs. Complements test/lib/upload.test.js (parser unit level) with
// the HTTP wire behavior:
//
//   - normal upload → 200, exact bytes on disk, size in the response
//   - over-limit REQUEST → 413 mid-stream (client's write side stalls
//     far short of the body — the server stopped reading)
//   - over-limit FILE   → 413 UPLOAD_FILE_TOO_LARGE
//   - exhausted QUOTA   → 413 UPLOAD_QUOTA_EXCEEDED, dir untouched
//   - every failure leaves NO file (no temp, no half-write) in the
//     upload dir — including a client that tears the socket mid-upload
//   - non-multipart content-type still 400 (pre-existing behavior)
//
// Server spawn pattern matches test/integration/router-boot.test.js:
// isolated settings/events/uploads/sessions paths under a mkdtemp dir,
// loopback HOST, TOKEN explicit empty.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { findFreePort, parseListeningPort } from "../helpers/free-port.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");

// Spawn server.js with isolated state + per-test upload limit env
// overrides (`limits` maps 1:1 onto the MCODE_WEBUI_UPLOAD_* knobs).
//
// Port: findFreePort() allocates a kernel ephemeral port. The
//   returned `port` is the value the child logged on its "listening
//   on http://host:port" line, NOT the port we asked for —
//   server/lib/port.js#listenWithPortFallback walks forward on
//   EADDRINUSE, so the test must read the actual bound port or it
//   POSTs to a wrong/stale socket (see test/helpers/free-port.js).
async function spawnServer(limits = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-upload-e2e-"));
  const uploadDir = join(tmpDir, "uploads");
  const requestedPort = await findFreePort();
  const env = {
    ...process.env,
    PORT: String(requestedPort),
    HOST: "127.0.0.1",
    MCODE_WEBUI_SETTINGS_PATH: join(tmpDir, "settings.json"),
    MCODE_WEBUI_EVENTS_PATH: join(tmpDir, "events.ndjson"),
    MCODE_WEBUI_UPLOAD_DIR: uploadDir,
    MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
    TOKEN: "",
    MCODE_WEBUI_TOKEN_STDOUT: "0",
    MCODE_WEBUI_UPLOAD_MAX_REQUEST: String(limits.request ?? 256 * 1024 * 1024),
    MCODE_WEBUI_UPLOAD_MAX_FILE: String(limits.file ?? 128 * 1024 * 1024),
    MCODE_WEBUI_UPLOAD_QUOTA: String(limits.quota ?? 1024 * 1024 * 1024),
  };
  const proc = spawn("node", [serverJsPath], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: join(__dirname, "..", ".."),
    env,
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  let boundPort = null;
  await new Promise((resolve, reject) => {
    const onChunk = () => {
      const p = parseListeningPort(stdout);
      if (p !== null) {
        boundPort = p;
        proc.stdout.off("data", onChunk);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `server.js did not start within 3s on port ${requestedPort}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        ),
      3000,
    );
    proc.stdout.on("data", onChunk);
  });
  // If the server fell back to a different port (rare — findFreePort
  // already gave us an ephemeral one), trust the line, not our ask.
  const port = boundPort !== null ? boundPort : requestedPort;
  return {
    proc,
    port,
    requestedPort,
    tmpDir,
    uploadDir,
    // The child's output, for failure diagnostics. Without this a timeout
    // reports only "no response within Nms" and the actual reason — a boot
    // warning, a crash, a slow start — is lost.
    getLogs: () => ({ stdout, stderr }),
  };
}

async function stopServer(server) {
  if (server && server.proc && server.proc.exitCode === null) {
    try {
      server.proc.kill("SIGTERM");
    } catch {}
    await Promise.race([
      new Promise((r) => server.proc.on("exit", r)),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    if (server.proc.exitCode === null) {
      try {
        server.proc.kill("SIGKILL");
      } catch {}
    }
  }
  if (server && server.tmpDir) {
    try {
      rmSync(server.tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

const BOUNDARY = "e2eboundary9c1d";

function multipartBody(parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    let hd = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) hd += `; filename="${p.filename}"`;
    hd += "\r\n\r\n";
    chunks.push(Buffer.from(hd));
    chunks.push(Buffer.isBuffer(p.content) ? p.content : Buffer.from(p.content));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

// POST /api/upload with a chunked writer loop that yields to the event
// loop, so the 413-early-response path can preempt a large body mid-
// send. Resolves { status, json, bytesWritten } once the response ends.
function postUpload({ port, body, contentType, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesWritten = 0;
    const req = http.request(
      {
        method: "POST",
        host: "127.0.0.1",
        port,
        path: "/api/upload",
        headers: {
          "Content-Type": contentType || `multipart/form-data; boundary=${BOUNDARY}`,
          "Content-Length": String(body.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          try {
            req.destroy();
          } catch {}
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: raw, json, bytesWritten });
        });
        res.on("error", (e) => {
          if (settled) return;
          settled = true;
          reject(new Error(`response stream error: ${e.message}`));
        });
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {}
      reject(new Error(`postUpload: no response within ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("error", (e) => {
      if (settled || req.res) return; // post-response reset is expected
      // A write that breaks *because the server stopped reading* is the
      // behaviour under test, not a failure: the server answers 413 and closes
      // without draining the body, so the client's next write can lose the race
      // against the response and surface EPIPE first.
      //
      // Which of the two arrives first is a property of the interleaving, not
      // of the server, and asserting on it made this test fail roughly one run
      // in three on an unchanged tree. The 413 is the assertion; let the
      // `response` event (or the timeout) settle it.
      //
      // Connection-level failures are still real failures: nothing was ever
      // accepted, so there is no response coming.
      const midStreamAbort = ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"];
      if (midStreamAbort.includes(e.code)) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`request failed before response: ${e.message}`));
    });
    (async () => {
      const CH = 16384;
      for (let off = 0; off < body.length; off += CH) {
        if (req.destroyed || settled) return;
        const slice = body.slice(off, Math.min(off + CH, body.length));
        bytesWritten += slice.length;
        const ok = req.write(slice);
        if (ok) {
          await new Promise((r) => setImmediate(r));
        } else {
          // Server stopped reading (that IS the mid-stream abort): wait
          // for drain with a short poll so the response event can land.
          await new Promise((r) => {
            const t = setTimeout(r, 25);
            req.once("drain", () => {
              clearTimeout(t);
              r();
            });
          });
        }
      }
      if (!req.destroyed && !settled) req.end();
    })().catch(() => {});
  });
}

function listUploads(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// -----------------------------------------------------------------------

test("upload-limits: normal upload → 200, exact bytes on disk, size in response", async () => {
  const server = await spawnServer();
  try {
    const content = Buffer.from("e2e upload content — \0\xffbinary ok");
    const res = await postUpload({
      port: server.port,
      body: multipartBody([
        { name: "file", filename: "hello.txt", content },
      ]),
    });
    assert.equal(res.status, 200, `body: ${res.body}`);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.name, "hello.txt");
    assert.equal(res.json.size, content.length);
    assert.ok(res.json.path.startsWith(server.uploadDir), "lands in redirected dir");
    assert.equal(readFileSync(res.json.path).toString("hex"), content.toString("hex"));
    assert.match(basename(res.json.path), /^\d+-[0-9a-f]{6}\.txt$/);
    assert.equal(listUploads(server.uploadDir).length, 1, "one file, no temp");
  } finally {
    await stopServer(server);
  }
});

test("upload-limits: oversized request → 413 mid-stream, no leftover, client write stalls short", async () => {
  const server = await spawnServer({ request: 64 * 1024 });
  try {
    // 8 MiB body against a 64 KiB request cap.
    const body = multipartBody([
      { name: "file", filename: "huge.bin", content: Buffer.alloc(8 * 1024 * 1024, 0x71) },
    ]);
    // This is the heaviest test in the suite: it spawns a real server, pushes
    // 8 MiB, and the server then drains the unread remainder. `node --test` runs
    // test *files* in parallel, so this one competes with the rest of the suite
    // for CPU — measured: 5/5 passes in isolation, ~2/3 in a full run at the
    // default 15s. The bound is therefore a property of the machine's load, not
    // of the server, and 45s keeps the assertion meaningful (a server that never
    // answers still fails) without making the test a load detector.
    const res = await postUpload({ port: server.port, body, timeoutMs: 45_000 }).catch((e) => {
      const { stdout, stderr } = server.getLogs();
      throw new Error(
        `${e.message}\n--- server stdout ---\n${stdout.slice(-2000)}\n--- server stderr ---\n${stderr.slice(-2000)}`,
      );
    });
    assert.equal(res.status, 413, `body: ${res.body}`);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, "UPLOAD_REQ_TOO_LARGE");
    assert.match(res.json.error, /MCODE_WEBUI_UPLOAD_MAX_REQUEST/);
    assert.equal(
      String(res.headers["connection"] || "").toLowerCase(),
      "close",
      "413 must close the connection (body was not fully consumed)",
    );
    // The client did not hand over the whole body: the server stopped reading
    // mid-stream and answered instead of buffering all 8 MiB first.
    //
    // The property is "less than the whole body", not a byte threshold. An
    // earlier version asserted `< 4 MiB`, which is a proxy for the same idea
    // but measures how far the client's write loop got before the close took
    // effect — a scheduling outcome that varies run to run. It reported a
    // failure on an unchanged tree (4,308,992 of 8,388,718 written) while the
    // server had in fact behaved exactly as intended: a 413, `connection:
    // close`, and the body left unread.
    assert.ok(
      res.bytesWritten < body.length,
      `client wrote ${res.bytesWritten} of ${body.length} — server buffered the whole body instead of aborting mid-stream`,
    );
    assert.deepEqual(listUploads(server.uploadDir), [], "no file, no temp after abort");
  } finally {
    await stopServer(server);
  }
});

test("upload-limits: oversized single file → 413 UPLOAD_FILE_TOO_LARGE, no leftover", async () => {
  const server = await spawnServer({ file: 64 * 1024 });
  try {
    const body = multipartBody([
      { name: "file", filename: "big.bin", content: Buffer.alloc(2 * 1024 * 1024, 0x72) },
    ]);
    const res = await postUpload({ port: server.port, body });
    assert.equal(res.status, 413, `body: ${res.body}`);
    assert.equal(res.json.code, "UPLOAD_FILE_TOO_LARGE");
    assert.match(res.json.error, /MCODE_WEBUI_UPLOAD_MAX_FILE/);
    assert.deepEqual(listUploads(server.uploadDir), []);
  } finally {
    await stopServer(server);
  }
});

test("upload-limits: directory quota exhausted → 413 UPLOAD_QUOTA_EXCEEDED, earlier files intact", async () => {
  const server = await spawnServer({ quota: 100 * 1024 });
  try {
    const first = await postUpload({
      port: server.port,
      body: multipartBody([
        { name: "file", filename: "one.txt", content: Buffer.alloc(60 * 1024, 0x31) },
      ]),
    });
    assert.equal(first.status, 200, `body: ${first.body}`);
    assert.equal(first.json.size, 60 * 1024);
    assert.equal(listUploads(server.uploadDir).length, 1);

    // 60 KiB stored of a 100 KiB quota → only 40 KiB remain; the next
    // 60 KiB file must be refused mid-stream.
    const second = await postUpload({
      port: server.port,
      body: multipartBody([
        { name: "file", filename: "two.txt", content: Buffer.alloc(60 * 1024, 0x32) },
      ]),
    });
    assert.equal(second.status, 413, `body: ${second.body}`);
    assert.equal(second.json.code, "UPLOAD_QUOTA_EXCEEDED");
    assert.match(second.json.error, /MCODE_WEBUI_UPLOAD_QUOTA/);
    const files = listUploads(server.uploadDir);
    assert.equal(files.length, 1, "quota refusal leaves the earlier file and no temp");
    assert.equal(readFileSync(join(server.uploadDir, files[0])).length, 60 * 1024);
  } finally {
    await stopServer(server);
  }
});

test("upload-limits: non-multipart content-type → 400 (pre-existing behavior pinned)", async () => {
  const server = await spawnServer();
  try {
    const res = await postUpload({
      port: server.port,
      body: Buffer.from('{"not":"multipart"}'),
      contentType: "application/json",
    });
    assert.equal(res.status, 400, `body: ${res.body}`);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, "multipart required");
    assert.deepEqual(listUploads(server.uploadDir), []);
  } finally {
    await stopServer(server);
  }
});

test("upload-limits: multipart without a file part → 400 UPLOAD_MALFORMED", async () => {
  const server = await spawnServer();
  try {
    const res = await postUpload({
      port: server.port,
      body: multipartBody([{ name: "caption", content: "fields only" }]),
    });
    assert.equal(res.status, 400, `body: ${res.body}`);
    assert.equal(res.json.code, "UPLOAD_MALFORMED");
    assert.match(res.json.error, /no file part/);
    assert.deepEqual(listUploads(server.uploadDir), [], "empty temp cleaned up");
  } finally {
    await stopServer(server);
  }
});

test("upload-limits: client tears the socket mid-upload → temp cleaned, no half-write", async () => {
  const server = await spawnServer({ request: 16 * 1024 * 1024 });
  try {
    const content = Buffer.alloc(4 * 1024 * 1024, 0x73);
    const body = multipartBody([
      { name: "file", filename: "aborted.bin", content },
    ]);
    // Write a slice of the body, then destroy the socket mid-file.
    await new Promise((resolve) => {
      const req = http.request({
        method: "POST",
        host: "127.0.0.1",
        port: server.port,
        path: "/api/upload",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
          "Content-Length": String(body.length),
        },
      });
      req.on("error", () => {}); // ECONNRESET is the point of the test
      req.write(body.slice(0, 128 * 1024));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    // Give the server a moment to observe the abort and run cleanup.
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(
      listUploads(server.uploadDir),
      [],
      "aborted upload must leave no temp/half-written file",
    );
    // Server must still be alive and serving.
    const health = await new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: server.port, path: "/api/health" }, (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => resolve({ status: r.statusCode, body: b }));
        })
        .on("error", reject);
    });
    assert.equal(health.status, 200, `body: ${health.body}`);
  } finally {
    await stopServer(server);
  }
});
