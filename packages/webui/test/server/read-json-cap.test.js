// webui/test/server/read-json-cap.test.js
//
// The shared JSON body reader caps and drains, and both dispatch layers answer
// 413 for an over-sized body.
//
// Why. Nine modules each carried their own copy of
//
//   let body = "";
//   for await (const chunk of req) body += chunk;
//
// with no size cap. `lib/upload.js` has three caps (50 MiB request / 25 MiB
// file / 200 MiB quota) but those apply only to `POST /api/upload`, so a client
// holding the token could POST a multi-gigabyte JSON body to `/api/send` and
// have it concatenated into one V8 string before `JSON.parse` was reached. The
// gates reject an unauthenticated caller cheaply, so this is specifically a
// post-authentication memory-exhaustion vector.
//
// The drain is the subtle half. The first version called `req.destroy()` the
// moment the cap was passed, which kills the socket before the handler chain
// can write anything — measured on a running server, the client saw a bare
// `HTTP 100` and a dropped connection instead of a 413. Breaking out of
// `for await` has the same failure, because the iterator's `return()` destroys
// the stream. So an over-sized body is read and discarded, not retained.

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { readJson, tryReadJson, BodyTooLargeError, MAX_JSON_BYTES } from "../../server/lib/read-json.js";

/**
 * A fake IncomingMessage that records how many bytes were actually pulled.
 *
 * Deliberately not asserting on `req.destroy()`: Node's streams auto-destroy on
 * end, so a flag set from a `destroy` override cannot distinguish the reader's
 * own teardown from the stream's normal lifecycle. What matters — and what the
 * first version got wrong — is whether the reader kept consuming after the cap
 * was passed. Draining means every byte gets pulled; destroying means the
 * producer stops early.
 */
function countingReq(total) {
  let pulled = 0;
  const req = new Readable({
    read() {
      if (pulled >= total) {
        this.push(null);
        return;
      }
      const n = Math.min(64 * 1024, total - pulled);
      pulled += n;
      this.push(Buffer.alloc(n, 0x61));
    },
  });
  req.bytesPulled = () => pulled;
  return req;
}

test("readJson — accepts a body under the cap", async () => {
  const payload = { content: "hello", n: 42 };
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  assert.deepEqual(await readJson(req), payload);
});

test("readJson — an empty body is {}", async () => {
  assert.deepEqual(await readJson(Readable.from([])), {});
});

test("readJson — malformed JSON is {} (not a throw), as the per-route copies did", async () => {
  assert.deepEqual(await readJson(Readable.from(["{not json"])), {});
});

test("readJson — a primitive or null body normalises to {}", async () => {
  assert.deepEqual(await readJson(Readable.from(["null"])), {});
  assert.deepEqual(await readJson(Readable.from(["42"])), {});
  assert.deepEqual(await readJson(Readable.from(['"str"'])), {});
});

test("readJson — an over-sized body throws, retains nothing, and drains", async () => {
  const over = MAX_JSON_BYTES + 64 * 1024;
  const req = countingReq(over);
  await assert.rejects(() => readJson(req), BodyTooLargeError);
  // Drained, not abandoned. `req.destroy()` the moment the cap is passed looked
  // cheaper but kills the socket before the handler can write the 413 — the
  // client then sees a bare HTTP 100 and a dropped connection.
  assert.equal(
    req.bytesPulled(),
    over,
    "the whole body must be consumed (and discarded) so the 413 can be written",
  );
});

test("readJson — a body beyond the drain ceiling stops consuming", async () => {
  // Absurd, not merely over the cap: stop holding the socket open.
  const absurd = MAX_JSON_BYTES + 256 * 1024 * 1024;
  const req = countingReq(absurd);
  await assert.rejects(() => readJson(req), BodyTooLargeError);
  // Far short of the whole body — the exact figure is the drain ceiling plus
  // whatever the stream had already buffered, so assert the shape not a byte.
  assert.ok(
    req.bytesPulled() < absurd,
    "past the drain ceiling the reader must stop pulling rather than read forever",
  );
});

test("tryReadJson — reports the 413 without throwing", async () => {
  const req = countingReq(MAX_JSON_BYTES + 1024);
  const r = await tryReadJson(req);
  assert.equal(r.ok, false);
  assert.equal(r.tooLarge, true);
  assert.equal(r.limit, MAX_JSON_BYTES);
});

test("tryReadJson — a good body resolves normally", async () => {
  const r = await tryReadJson(Readable.from([Buffer.from('{"a":1}')]));
  assert.equal(r.ok, true);
  assert.equal(r.tooLarge, false);
  assert.deepEqual(r.value, { a: 1 });
});

/** Strip comments so a prose mention of the old shape is not read as code. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

test("no route carries its own unbounded body reader", async () => {
  // The structural guard: the cap lives in one module, so a route that grows a
  // private reader is visible here rather than only at runtime.
  //
  // Both reader shapes have to be matched. An earlier version of this test
  // only looked for `for await (const chunk of req)` and therefore passed while
  // `handleFsMkdir` still buffered without a cap through
  // `req.on('data', …)` — a route that read one byte per line of its own and
  // was invisible to the check that was supposed to prevent exactly that.
  //
  // Comments are stripped first: the fix for that route necessarily *names* the
  // old pattern, and prose about a shape is not a use of it.
  const dir = fileURLToPath(new URL("../../server/", import.meta.url));
  const { readdir } = await import("node:fs/promises");
  const offenders = [];
  const ALLOWED = new Set(["upload.js", "read-json.js"]);
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = `${d}/${entry.name}`;
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith(".js")) continue;
      // upload.js has its own streaming parser with three caps; read-json.js
      // is the bounded reader itself.
      if (ALLOWED.has(entry.name)) continue;
      const src = codeOnly(await readFile(p, "utf8"));
      const shapes = [
        ["for-await", /for await \(const chunk of req\)/],
        ["on-data-accumulate", /req\.on\(\s*['"]data['"]\s*,\s*\(?\s*chunk\s*\)?\s*=>\s*\{[^}]*\+=\s*chunk/],
        ["on-data-accumulate2", /req\.on\(\s*['"]data['"]\s*,\s*function[^{]*\{[^}]*\+=/],
      ];
      for (const [name, re] of shapes) {
        if (re.test(src)) offenders.push(`${p.replace(/.*\/server\//, '')} (${name})`);
      }
    }
  };
  await walk(dir);
  assert.deepEqual(offenders, [], "these files still buffer a request body without a cap");
});

test("the fs mkdir route goes through the shared bounded reader", async () => {
  // Named explicitly because it is the one that slipped through: it read the
  // body itself instead of importing the helper, and the shape-based check
  // above only learned to look for it after it was found.
  const src = codeOnly(
    await readFile(
      fileURLToPath(new URL("../../server/routes/fs.js", import.meta.url)),
      "utf8",
    ),
  );
  assert.match(src, /from\s*["']\.\.\/lib\/read-json\.js["']/, "fs.js must import the bounded reader");
  assert.ok(!/req\.on\(\s*['"]data['"]/.test(src), "fs.js must not buffer the body itself");
});

test("both dispatch layers map the 413", async () => {
  const app = await readFile(
    fileURLToPath(new URL("../../server/app.js", import.meta.url)),
    "utf8",
  );
  const router = await readFile(
    fileURLToPath(new URL("../../server/router.js", import.meta.url)),
    "utf8",
  );
  // Hono: the async rejection path must be handled, not just a sync throw —
  // the handlers are async, so a throw surfaces as a rejection.
  assert.match(app, /BodyTooLargeError/, "app.js must handle the 413");
  assert.match(app, /handled\.then\([\s\S]*?cause/, "must catch the async rejection");
  // Legacy router: its catch-all would otherwise turn 413 into 500.
  assert.match(router, /BodyTooLargeError/, "router.js must handle the 413");
  assert.match(router, /413/, "router.js must answer 413, not 500");
});
