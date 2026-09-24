// webui/test/server/state-snapshot-no-chat.test.js
//
// No client-facing payload may carry a session's `chat` array in its `sessions`
// list.
//
// Why. The webui keeps one `cs.chat` per client (the live conversation) and a
// separate persisted `sessions` store (the sidebar's list of conversations). The
// chat area hydrates from `state.chat`; the sidebar only needs each session's
// identity and title. Shipping the full per-session `chat` array inside
// `sessions` therefore
//
//   - widens the payload to every subscriber of that cid, including a LAN
//     client holding the token, exposing the history of conversations that have
//     nothing to do with the one it connected to; and
//   - makes every push and every `/api/state` fetch carry the whole corpus.
//
// `sessionsListForSnapshot()` in state-bus is the projection that strips `chat`.
// It was added for the two push sites inside state-bus and exported, but
// `routes/state.js` — a different file, building the `/api/state` body and the
// SSE connection's first frame — still called `loadSessions()` directly, so the
// leak survived the original fix. These tests pin all three call sites.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sessionsListForSnapshot } from "../../server/lib/state-bus.js";

const ROUTES_STATE = fileURLToPath(new URL("../../server/routes/state.js", import.meta.url));
const STATE_BUS = fileURLToPath(new URL("../../server/lib/state-bus.js", import.meta.url));

test("sessionsListForSnapshot — the projection drops chat", () => {
  // Shape-agnostic: the helper's own contract is "no chat key", whatever the
  // store currently holds.
  const out = sessionsListForSnapshot();
  for (const entry of out) {
    assert.ok(entry, "each entry should be an object");
    assert.equal(
      Object.prototype.hasOwnProperty.call(entry, "chat"),
      false,
      `session ${entry && entry.id} must not expose chat`,
    );
  }
});

test("routes/state.js — no raw loadSessions() reaches a client payload", async () => {
  const source = await readFile(ROUTES_STATE, "utf8");

  // The import itself is the strongest signal: routes/state.js has no reason to
  // read the whole store once the projection exists.
  assert.ok(
    !/import\s*\{[^}]*\bloadSessions\b[^}]*\}\s*from\s*["']\.\.\/lib\/sessions\.js["']/.test(source),
    "routes/state.js must not import loadSessions; use sessionsListForSnapshot()",
  );
  assert.ok(
    !/sessions:\s*loadSessions\(\)/.test(source),
    "routes/state.js must not inline loadSessions() into a payload",
  );

  // And it must actually use the projection in both payloads it builds.
  const uses = source.match(/sessions:\s*sessionsListForSnapshot\(\)/g) || [];
  assert.equal(
    uses.length,
    2,
    "expected the projection in both the SSE first frame and the /api/state body",
  );
});

test("state-bus.js — the projection is exported for cross-file use", async () => {
  const source = await readFile(STATE_BUS, "utf8");
  assert.match(
    source,
    /export\s+function\s+sessionsListForSnapshot\s*\(/,
    "sessionsListForSnapshot must be exported, or other files re-introduce the leak",
  );
});
