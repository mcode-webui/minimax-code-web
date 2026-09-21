// webui/test/lib-state-bus-restore.test.js
// Regression for v2.3 session resume: a fresh per-cid client (page reload,
// new tab) must bind to the most recent session in its workspace instead of
// starting empty — otherwise every reload forks the conversation into a new
// webui session AND a new mcode session (sidebar records multiply).
//
// Env before import: config.js reads MCODE_WEBUI_SESSIONS_DB at import time;
// node --test gives this file its own process, so set env first and import
// dynamically.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "state-bus-restore-"));
process.env.MCODE_WEBUI_SESSIONS_DB = join(dir, "sessions.json");
process.env.MCODE_WEBUI_UPLOAD_DIR = join(dir, "uploads");

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

let getClient;
let makeClientState;
let WORKSPACE;

before(async () => {
  ({ DEFAULT_WORKSPACE: WORKSPACE } = await import(absPath("lib/config.js")));
  ({ getClient, makeClientState } = await import(absPath("lib/state-bus.js")));
});

function writeStore(items) {
  writeFileSync(
    process.env.MCODE_WEBUI_SESSIONS_DB,
    JSON.stringify(items, null, 2),
    "utf8",
  );
}

describe("getClient — session restore on fresh clients (v2.3)", () => {
  test("fresh client resumes the most recent session in its workspace", () => {
    const ws = WORKSPACE;
    writeStore([
      { id: "older", workspace: ws, title: "Old", updatedAt: 100, chat: ["› 旧消息"], mcodeSessionId: "mvs_old" },
      { id: "latest", workspace: ws, title: "Newest", updatedAt: 200, chat: ["› 你好", "● 你好！"], mcodeSessionId: "mvs_latest" },
      { id: "other-ws", workspace: "/elsewhere", title: "Elsewhere", updatedAt: 300, chat: ["› nope"], mcodeSessionId: "mvs_other" },
    ]);
    const cs = getClient("cid-restore-a");
    assert.equal(cs.sessionId, "latest", "must bind the latest session in the same workspace");
    assert.equal(cs.mcodeSessionId, "mvs_latest", "mcode session id carried over");
    assert.equal(cs.sessionTitle, "Newest");
    assert.deepEqual(cs.chat, ["› 你好", "● 你好！"], "chat history restored");
  });

  test("an existing cid is never re-restored (identity preserved)", () => {
    const cs = getClient("cid-restore-a");
    cs.sessionId = "user-switched";
    const again = getClient("cid-restore-a");
    assert.equal(again.sessionId, "user-switched", "second getClient returns the same live state");
  });

  test("fresh client in an empty store starts empty (no crash)", () => {
    writeStore([]);
    const cs = getClient("cid-restore-empty");
    assert.equal(cs.sessionId, null);
    assert.deepEqual(cs.chat, []);
  });

  test("no session in the current workspace → stays empty", () => {
    writeStore([
      { id: "other-ws", workspace: "/definitely/not-here", title: "X", updatedAt: 999, chat: ["› x"] },
    ]);
    const cs = getClient("cid-restore-nomatch");
    assert.equal(cs.sessionId, null);
  });

  test("legacy records without workspace belong to the default workspace", () => {
    writeStore([
      { id: "legacy", title: "Legacy", updatedAt: 50, chat: ["› legacy"], mcodeSessionId: "mvs_legacy" },
    ]);
    const cs = getClient("cid-restore-legacy");
    assert.equal(cs.sessionId, "legacy", "workspace-less record restored when ws is the default");
    assert.deepEqual(cs.chat, ["› legacy"]);
  });

  test("restored cs matches makeClientState shape elsewhere", () => {
    writeStore([
      { id: "s1", workspace: WORKSPACE, title: "T", updatedAt: 1, chat: [] },
    ]);
    const cs = getClient("cid-restore-shape");
    const fresh = makeClientState();
    for (const key of Object.keys(fresh)) {
      assert.ok(key in cs, `state shape keeps ${key}`);
    }
    assert.equal(cs.running.active, false);
  });
});
