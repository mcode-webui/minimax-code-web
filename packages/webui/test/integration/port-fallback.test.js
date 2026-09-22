// webui/test/integration/port-fallback.test.js
// Live-boot proof for the default-port fallback (server/lib/port.js):
//
//   1. with no PORT configured and 18090 taken, server.js walks forward and
//      reports the port it actually bound
//   2. /api/health agrees with that port — a request-time reader, not a
//      snapshot of the configured value
//   3. the browser Origin for that port is trusted (CORS reflection), which
//      only holds if router.js reads the serving port rather than PORT
//
// The test takes 18090 itself when it is free, so the fallback is guaranteed
// rather than left to whatever the developer's machine happens to be running.
// When 18090 is already taken by something else the assertions still hold: the
// server cannot use it either way.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { MAX_PORT_ATTEMPTS } from "../../server/lib/port.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");
const DEFAULT_PORT = 18090;

/** Hold 18090 so the boot below has to fall back; undefined when already taken. */
function holdDefaultPort() {
  return new Promise((resolve) => {
    const holder = http.createServer((_req, res) => res.end("busy"));
    holder.once("error", () => resolve(undefined));
    holder.listen(DEFAULT_PORT, "127.0.0.1", () => resolve(holder));
  });
}

function release(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function request(port, path, headers) {
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

/**
 * Boot server.js with no PORT configured and isolated state. Resolves with the
 * port it reported, a `stop()` that tears the child down completely, and the
 * captured output for failure messages.
 */
function bootWithDefaultPort() {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-port-fallback-"));
  const env = {
    ...process.env,
    MCODE_WEBUI_SETTINGS_PATH: join(tmpDir, "settings.json"),
    MCODE_WEBUI_EVENTS_PATH: join(tmpDir, "events.ndjson"),
    MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
    MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
    TOKEN: "",
    MCODE_WEBUI_TOKEN_STDOUT: "0",
  };
  delete env.PORT; // the default port is what this test is about
  delete env.HOST; // default bind, so the URL is loopback

  return new Promise((resolve, reject) => {
    const proc = spawn("node", [serverJsPath], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const killChild = async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGTERM");
      const hardKill = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 1500);
      await exited;
      clearTimeout(hardKill);
    };
    const stop = async () => {
      await killChild();
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    };

    const bail = setTimeout(async () => {
      if (settled) return;
      settled = true;
      const output = { stdout, stderr };
      await stop();
      reject(new Error(`no listening line within 6s. stdout:\n${output.stdout}\nstderr:\n${output.stderr}`));
    }, 6000);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (settled || !match) return;
      settled = true;
      clearTimeout(bail);
      // The child stays up: the caller makes live requests and then stops it.
      resolve({ port: Number(match[1]), output: () => ({ stdout, stderr }), stop });
    });
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      await stop();
      reject(error);
    });
    proc.on("exit", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      const output = { stdout, stderr };
      await stop();
      reject(
        new Error(
          `server exited with ${code} before listening. stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    });
  });
}

test("taken default port: server.js binds the next free port and reports it", async () => {
  const holder = await holdDefaultPort();
  let booted;
  try {
    booted = await bootWithDefaultPort();
    const { stdout, stderr } = booted.output();

    assert.ok(
      booted.port > DEFAULT_PORT,
      `expected a port above ${DEFAULT_PORT}, got ${booted.port}. stdout:\n${stdout}`,
    );
    assert.ok(
      booted.port <= DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1,
      `fallback must stay inside the attempt budget, got ${booted.port}`,
    );
    assert.match(
      stderr,
      new RegExp(`port ${DEFAULT_PORT} is already in use`),
      `the fallback must be announced. stderr:\n${stderr}`,
    );

    // /api/health and the browser-Origin trust set are both request-time
    // readers of the serving port; a PORT snapshot would answer 18090 here and
    // refuse the Origin below.
    const health = await request(booted.port, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).port, booted.port);

    const origin = `http://127.0.0.1:${booted.port}`;
    const sameOrigin = await request(booted.port, "/api/health", { Origin: origin });
    assert.equal(
      String(sameOrigin.headers["access-control-allow-origin"] || "").toLowerCase(),
      origin,
      "the fallback port's own Origin must be trusted",
    );

    const staleOrigin = await request(booted.port, "/api/health", {
      Origin: `http://127.0.0.1:${DEFAULT_PORT}`,
    });
    assert.equal(
      staleOrigin.headers["access-control-allow-origin"],
      undefined,
      "the configured-but-unused port must not be trusted",
    );
  } finally {
    if (booted) await booted.stop();
    await release(holder);
  }
});
