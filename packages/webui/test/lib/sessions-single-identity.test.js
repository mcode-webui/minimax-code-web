// webui/test/lib/sessions-single-identity.test.js
// v2.4 单一基础会话模型 — behavioral pins:
//
//   - ensureOverlayForMcodeSid is idempotent: the same mcode session maps
//     to ONE record, and that record's id IS the mcode session id
//   - promoteDraftToMcodeSid renames a draft record to the engine identity
//     after the first acp turn; a pre-existing overlay for the same mcode
//     session absorbs the draft's chat (never two records)
//   - sessionKeyOf / findOverlayForMcodeSid cover legacy uuid wrappers
//
// Env before import: SESSIONS_DB is resolved at config.js import time.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "sessions-single-id-"));
process.env.MCODE_WEBUI_SESSIONS_DB = join(dir, "sessions.json");
process.env.MCODE_WEBUI_UPLOAD_DIR = join(dir, "uploads");

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

let sessions;
before(async () => {
  sessions = await import(absPath("lib/sessions.js"));
});

const SID = "mvs_" + "a".repeat(32);
const SID2 = "mvs_" + "b".repeat(32);

function writeStore(items) {
  sessions.saveSessions(items);
}
function readStore() {
  return sessions.loadSessions();
}

describe("v2.4 single base session — overlay helpers", () => {
  test("ensureOverlayForMcodeSid: creates ONE record whose id is the mcode sid", () => {
    writeStore([]);
    const all = readStore();
    const rec = sessions.ensureOverlayForMcodeSid(all, SID, { title: "T", workspace: "/w" });
    sessions.saveSessions(all);
    assert.equal(rec.id, SID, "record id === mcode session id (single identity)");
    assert.equal(rec.mcodeSessionId, SID);
    assert.equal(readStore().length, 1);
  });

  test("ensureOverlayForMcodeSid: idempotent — second call reuses, never duplicates", () => {
    const all = readStore();
    const again = sessions.ensureOverlayForMcodeSid(all, SID, { title: "T2" });
    assert.equal(again.id, SID);
    assert.equal(readStore().length, 1, "no second record for the same mcode session");
    assert.equal(again.title, "T", "existing real title not clobbered");
  });

  test("ensureOverlayForMcodeSid: repairs placeholder titles only", () => {
    // reset the record to the placeholder, then resolve a real title
    const all = readStore();
    all.find((r) => r.id === SID).title = "Mcode session";
    sessions.saveSessions(all);
    const rec = sessions.ensureOverlayForMcodeSid(readStore(), SID, { title: "Real title" });
    assert.equal(rec.title, "Real title", "placeholder replaced by the resolved title");
    // non-placeholder titles are never clobbered
    const rec2 = sessions.ensureOverlayForMcodeSid(readStore(), SID, { title: "Other" });
    assert.equal(rec2.title, "Real title", "real title preserved on later calls");
  });

  test("ensureOverlayForMcodeSid: finds legacy uuid wrapper records too", () => {
    writeStore([{ id: "legacy-uuid", mcodeSessionId: SID2, title: "Old", chat: ["› x"], updatedAt: 5, createdAt: 4 }]);
    const all = readStore();
    const rec = sessions.ensureOverlayForMcodeSid(all, SID2, { title: "New" });
    assert.equal(rec.id, "legacy-uuid", "legacy wrapper reused as-is");
    assert.equal(rec.title, "Old");
    assert.equal(readStore().length, 1);
  });

  test("promoteDraftToMcodeSid: renames a draft to the engine identity", () => {
    writeStore([{ id: "draft-uuid", title: "New session", workspace: "/w", chat: ["› hi", "● ok"], updatedAt: 9, createdAt: 8 }]);
    const cs = { sessionId: "draft-uuid", mcodeSessionId: SID };
    const changed = sessions.promoteDraftToMcodeSid(cs);
    assert.equal(changed, true);
    assert.equal(cs.sessionId, SID, "cs now keyed by the engine identity");
    const store = readStore();
    assert.equal(store.length, 1);
    assert.equal(store[0].id, SID);
    assert.equal(store[0].mcodeSessionId, SID);
    assert.deepEqual(store[0].chat, ["› hi", "● ok"], "draft chat carried over");
  });

  test("promoteDraftToMcodeSid: pre-existing overlay absorbs the draft (no duplicates)", () => {
    writeStore([
      { id: "overlay-uuid", mcodeSessionId: SID, title: "Existing", chat: ["› old"], updatedAt: 20, createdAt: 1 },
      { id: "draft-uuid", title: "New session", chat: ["› new"], updatedAt: 30, createdAt: 29 },
    ]);
    const cs = { sessionId: "draft-uuid", mcodeSessionId: SID };
    assert.equal(sessions.promoteDraftToMcodeSid(cs), true);
    assert.equal(cs.sessionId, "overlay-uuid");
    const store = readStore();
    assert.equal(store.length, 1, "one record for one conversation");
    assert.deepEqual(store[0].chat, ["› old", "› new"], "draft chat merged into the overlay");
  });

  test("promoteDraftToMcodeSid: no-op when already keyed by the engine identity", () => {
    writeStore([{ id: SID, mcodeSessionId: SID, title: "T", chat: [], updatedAt: 1, createdAt: 1 }]);
    const cs = { sessionId: SID, mcodeSessionId: SID };
    assert.equal(sessions.promoteDraftToMcodeSid(cs), false);
    assert.equal(readStore().length, 1);
  });

  test("sessionKeyOf: mcode binding wins, drafts fall back to id", () => {
    assert.equal(sessions.sessionKeyOf({ id: "x", mcodeSessionId: SID }), SID);
    assert.equal(sessions.sessionKeyOf({ id: "draft" }), "draft");
    assert.equal(sessions.sessionKeyOf(null), null);
  });

  test("bindDraftToMcodeSid: binds + promotes at session/new time (one record from the start)", () => {
    writeStore([{ id: "draft-uuid", title: "New session", workspace: "/w", chat: ["› hi"], updatedAt: 9, createdAt: 8 }]);
    const cs = { sessionId: "draft-uuid", mcodeSessionId: null };
    assert.equal(sessions.bindDraftToMcodeSid(cs, SID), true);
    assert.equal(cs.mcodeSessionId, SID, "binding recorded on cs");
    assert.equal(cs.sessionId, SID, "draft promoted to the engine identity immediately");
    const store = readStore();
    assert.equal(store.length, 1, "one record from the start — no uuid/mvs duplicate");
    assert.equal(store[0].id, SID);
    assert.equal(store[0].mcodeSessionId, SID);
    assert.deepEqual(store[0].chat, ["› hi"]);
  });

  test("bindDraftToMcodeSid: idempotent on re-bind (finalize is a no-op)", () => {
    writeStore([{ id: "draft-uuid", title: "New session", workspace: "/w", chat: ["› x"], updatedAt: 5, createdAt: 4 }]);
    const cs = { sessionId: "draft-uuid", mcodeSessionId: null };
    assert.equal(sessions.bindDraftToMcodeSid(cs, SID), true, "first bind promotes the draft");
    assert.equal(sessions.bindDraftToMcodeSid(cs, SID), false, "already keyed by the engine identity");
    assert.equal(readStore().length, 1, "re-bind never duplicates the record");
    assert.equal(readStore()[0].id, SID);
  });

  test("bindDraftToMcodeSid: guards empty sid / missing cs", () => {
    assert.equal(sessions.bindDraftToMcodeSid(null, SID), false);
    assert.equal(sessions.bindDraftToMcodeSid({ sessionId: "x" }, ""), false);
    assert.equal(sessions.bindDraftToMcodeSid({ sessionId: "x" }, null), false);
  });
});
