// webui/test/lib/acp-process-group.test.js
// Regression test: stopping the mcode acp child must take down the whole
// process group, not just the direct child.
//
// The bug: `stop()` called `child.kill()`, which signals only the direct child.
// The engine's acp entry spawns its own plugin chain (codex-mcp-proxy →
// codex mcp-server → …); none of those receive the signal, so every restart
// orphans a full plugin tree. This test reproduces exactly that shape — a
// direct child with one grandchild — and asserts both die.
//
// It fails on the old `child.kill()`-only implementation (the grandchild
// survives) and passes once the child is spawned `detached` and `stop()` kills
// the group, escalating to SIGKILL if the group ignores SIGTERM.
//
// POSIX-only: Windows has no process groups to signal, and `stop()` there keeps
// the direct-child kill.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const posix = process.platform !== "win32";

/** A stand-in for the engine's acp entry: spawns one long-lived grandchild. */
const FAKE_ACP = `
// Spawns a grandchild that never exits on its own — the leak this test
// guards against. Both pids are published so the test can check on them.
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: "ignore",
});
writeFileSync(process.env.PID_FILE, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));

// Answer the initialize handshake so McodeAcpClient.start() can resolve.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    }
  }
});
process.stdin.resume();
`;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is not ours to signal.
    return e.code === "EPERM";
  }
}

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return await predicate();
}

describe("McodeAcpClient.stop() — process group teardown", { skip: !posix && "POSIX-only" }, () => {
  let dir;
  let entry;
  let McodeAcpClient;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "webui-acp-pg-"));
    entry = join(dir, "fake-acp.js");
    writeFileSync(entry, FAKE_ACP);
    const mod = await import("../../acp.mjs");
    McodeAcpClient = mod.McodeAcpClient;
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.MCODE_CMD;
    delete process.env.PID_FILE;
  });

  test("a grandchild of the acp child does not outlive stop()", async () => {
    const pidFile = join(dir, `pids-${Date.now()}.json`);
    process.env.MCODE_CMD = entry;
    process.env.PID_FILE = pidFile;

    const client = new McodeAcpClient();
    await client.start();
    assert.equal(client.alive, true);

    // The fake publishes its pids synchronously on spawn, but read with a
    // short poll so a slow filesystem cannot flake the test.
    const gotFile = await waitFor(() => existsSync(pidFile));
    assert.ok(gotFile, "fake acp never published its pids");
    const { child, grandchild } = JSON.parse(readFileSync(pidFile, "utf8"));

    // Both are running right now — the precondition for the assertion below.
    assert.equal(isAlive(child), true, "direct child should be running");
    assert.equal(isAlive(grandchild), true, "grandchild should be running");

    client.stop();

    // The direct child dies on the SIGTERM; the grandchild only dies if the
    // signal reached the whole group. Poll rather than sleep a fixed amount so
    // this tracks real process teardown, not scheduling luck.
    const gone = await waitFor(() => !isAlive(grandchild) && !isAlive(child), {
      timeoutMs: 8000,
    });
    assert.equal(
      gone,
      true,
      `process group survived stop(): child(alive=${isAlive(child)}) grandchild(alive=${isAlive(grandchild)})`,
    );
  });
});
