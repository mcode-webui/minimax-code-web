// webui/test/routes/logs-export.test.js
//
// SB-8 (D-3) — `GET /api/logs/export`, the About section's 「导出日志」.
//
// The decision this suite defends: the action is a LOCAL FILE HAND-OVER,
// not an upload. The row it replaced was a permanently disabled button
// labelled 「上传日志」, which promised a cloud destination this
// self-hosted edition does not have. Four invariants make the replacement
// honest, and each has a test below that fails when it is removed:
//
//   1. The endpoint ALWAYS answers 200 `text/plain` with a
//      `Content-Disposition: attachment` — including when a log file is
//      missing or unreadable. A 4xx here would land a JSON error document
//      in the user's downloads folder under a `.txt` name, which is a file
//      that looks like logs and is not.
//   2. A bounded file says it was bounded. `events.ndjson` is tens of
//      megabytes on a long-lived install, so only its tail ships — and the
//      truncation note carries the counts, so the reader learns from the
//      file itself that an older part was left out.
//   3. The bundle carries the two diagnostic sources and nothing else. The
//      files this server writes that hold CONVERSATIONS or CREDENTIALS
//      (`sessions.json`, `settings.json`, `uploads/`) must never appear:
//      a file users attach to a bug report cannot be the one file on the
//      machine with their API keys in it.
//   4. The default sources are the ones the WRITERS use — `SERVER_ERR_LOG`
//      for the crash trail, `events.path()` for the event log. A second
//      hardcoded guess about where logs live is the failure mode that
//      makes an export silently empty.
//
// `WEBUI_DATA_DIR` is read at import time by `server/lib/config.js`, so the
// per-test overrides below are installed BEFORE the dynamic imports — the
// same rule the spawn-isolation lint states for the four MCODE_WEBUI_*
// variables. Without them this suite would read the developer's own
// ~/.mcode-webui (which is how the first run of it "passed" while asserting
// against a stranger's EADDRINUSE log). The temp directory comes from
// `test/helpers/tmp.js` (mkTmpDir), never a bare mkdtemp, so the suite's
// exit/signal handlers clean it up.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { mkTmpDir } from "../helpers/tmp.js";

const dataDir = mkTmpDir("logs-export-");
const eventsPath = join(dataDir, "events.ndjson");
// The four the isolation lint names, plus DATA_DIR (the bundle's own
// default source list is derived from it).
process.env.MCODE_WEBUI_DATA_DIR = dataDir;
process.env.MCODE_WEBUI_EVENTS_PATH = eventsPath;
process.env.MCODE_WEBUI_SETTINGS_PATH = join(dataDir, "settings.json");
process.env.MCODE_WEBUI_SESSIONS_DB = join(dataDir, "sessions.json");
process.env.MCODE_WEBUI_UPLOAD_DIR = join(dataDir, "uploads");

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const { tailText, logBundleFilename, buildLogBundle, resolveLogSources } =
  await import(absPath("lib/log-export.js"));
const { handleExportLogs } = await import(absPath("routes/logs.js"));

// A response writer with the three methods the route uses. The `done`
// promise lets a caller await the end of the response without a socket.
function fakeRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  return {
    status: 0,
    headers: {},
    body: "",
    done,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      resolveDone();
    },
  };
}

// Each test starts from an empty data directory, so "this file does not
// exist" is a state a test can actually create.
beforeEach(() => {
  for (const name of [".server.err", "events.ndjson", "settings.json", "sessions.json", "usage-history.ndjson"]) {
    rmSync(join(dataDir, name), { force: true });
  }
});

function writeLines(path, count, prefix = "line") {
  const body = Array.from({ length: count }, (_, i) => `${prefix}-${i}`).join("\n") + "\n";
  writeFileSync(path, body, "utf8");
  return body;
}

describe("tailText — the tail is bounded by lines AND by bytes", () => {
  test("keeps the LAST lines, not the first", () => {
    const text = "a\nb\nc\nd\ne\n";
    const tail = tailText(text, { maxLines: 2, maxBytes: 1024 });
    assert.equal(tail.body, "d\ne");
    assert.equal(tail.totalLines, 5);
    assert.equal(tail.keptLines, 2);
    assert.equal(tail.linesTruncated, true);
    assert.equal(tail.truncated, true);
  });

  test("the trailing newline is not counted as a line", () => {
    // Without this, a one-line file with a final newline reports two lines
    // and every "showing N of M" note is off by one.
    const tail = tailText("only\n", { maxLines: 10, maxBytes: 1024 });
    assert.equal(tail.totalLines, 1);
    assert.equal(tail.keptLines, 1);
    assert.equal(tail.truncated, false);
  });

  test("a byte cap also bites, and is reported separately from the line cap", () => {
    const tail = tailText("x".repeat(50) + "\n" + "y".repeat(50), { maxLines: 100, maxBytes: 10 });
    assert.equal(tail.bytesTruncated, true);
    assert.equal(tail.linesTruncated, false);
    assert.equal(tail.truncated, true);
    assert.equal(tail.body, "y".repeat(10));
  });

  test("a file under both caps is not marked truncated", () => {
    const tail = tailText("one\ntwo\n", { maxLines: 10, maxBytes: 1024 });
    assert.equal(tail.truncated, false);
  });
});

describe("logBundleFilename", () => {
  test("is a Windows-safe .txt name stamped with the export time", () => {
    // The assertion is on the SHAPE, because the clock zone is the host's,
    // not this suite's.
    const name = logBundleFilename(Date.UTC(2026, 9, 4, 0, 46, 0));
    assert.match(name, /^mcode-webui-logs-\d{8}T\d{6}\.txt$/);
    assert.ok(!name.includes(":"), "no colons — Windows-safe");
  });
});

describe("buildLogBundle — what ships and what must never ship", () => {
  test("includes both diagnostic sources when both exist", () => {
    writeFileSync(join(dataDir, ".server.err"), "[uncaughtException] boom\n", "utf8");
    writeLines(eventsPath, 3, "event");
    const { text, sources } = buildLogBundle({ now: 0 });
    assert.match(text, /===== Server error log \(\.server\.err\) =====/);
    assert.match(text, /===== Event log \(events\.ndjson, most recent last\) =====/);
    assert.match(text, /\[uncaughtException\] boom/);
    assert.match(text, /event-2/);
    assert.deepEqual(sources.map((s) => s.state), ["read", "read"]);
  });

  test("says so, per section, when a file was never written", () => {
    const { text, sources } = buildLogBundle({ now: 0 });
    assert.match(text, /not written yet/);
    assert.deepEqual(sources.map((s) => s.state), ["absent", "absent"]);
    // Absent is a state, not a crash: the bundle is still produced.
    assert.ok(text.length > 0);
  });

  test("an empty file reads as empty, not as absent", () => {
    writeFileSync(join(dataDir, ".server.err"), "", "utf8");
    const { text, sources } = buildLogBundle({ now: 0 });
    assert.match(text, /empty — the file exists but holds no lines yet/);
    assert.equal(sources[0].state, "empty");
  });

  test("truncation is stated in the file, with the counts", () => {
    writeLines(eventsPath, 50, "e");
    const { text } = buildLogBundle({ maxLinesPerFile: 5, now: 0 });
    assert.match(text, /\[truncated: showing the last 5 of 50 lines\]/);
    assert.ok(!/e-0\b/.test(text), "the oldest lines are the ones dropped");
    assert.match(text, /e-49/);
  });

  test("never carries conversations or credentials out of the data directory", () => {
    // The reason the source list is a closed two. A future change that adds
    // "settings.json because it is in the same directory" fails here.
    writeFileSync(join(dataDir, ".server.err"), "[uncaughtException] boom\n", "utf8");
    writeLines(eventsPath, 2, "e");
    writeFileSync(join(dataDir, "settings.json"), '{"apiKey":"SECRET-KEY-MARKER"}', "utf8");
    writeFileSync(join(dataDir, "sessions.json"), '[{"chat":["PRIVATE-CONVERSATION-MARKER"]}]', "utf8");
    writeFileSync(join(dataDir, "usage-history.ndjson"), "USAGE-MARKER\n", "utf8");

    const { text } = buildLogBundle({ now: 0 });
    for (const marker of ["SECRET-KEY-MARKER", "PRIVATE-CONVERSATION-MARKER", "USAGE-MARKER"]) {
      assert.ok(!text.includes(marker), `bundle leaked ${marker}`);
    }
  });

  test("the header states the cap and denies any upload", () => {
    const { text } = buildLogBundle({ now: 0 });
    assert.match(text, /last 2000 lines/);
    assert.match(text, /nothing was uploaded anywhere/);
  });
});

describe("resolveLogSources — the default paths come from the writers", () => {
  test("the crash trail is the config constant and the event log follows its env", () => {
    const sources = resolveLogSources();
    assert.equal(sources[0].path, join(dataDir, ".server.err"));
    assert.equal(sources[1].path, eventsPath);
    assert.ok(!existsSync(sources[0].path), "the fixture starts empty");
  });
});

describe("handleExportLogs — the wire", () => {
  test("answers 200 text/plain as an attachment, always", async () => {
    writeFileSync(join(dataDir, ".server.err"), "[uncaughtException] boom\n", "utf8");
    const res = fakeRes();
    handleExportLogs({ url: "/api/logs/export" }, res, { cid: "c", cs: {}, pathname: "/api/logs/export" });
    await res.done;

    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "text/plain; charset=utf-8");
    assert.match(res.headers["Content-Disposition"], /^attachment; filename="mcode-webui-logs-\d{8}T\d{6}\.txt"$/);
    assert.equal(res.headers["Content-Length"], Buffer.byteLength(res.body, "utf8"));
    assert.match(res.body, /mcode-webui diagnostic log bundle/);
    assert.match(res.body, /\[uncaughtException\] boom/);
  });

  test("a missing log file is still 200, and says so in the body", async () => {
    // The failure this guards: a 404 here would be saved by the browser as
    // `mcode-webui-logs-<ts>.txt` containing a JSON error body.
    const res = fakeRes();
    handleExportLogs({ url: "/api/logs/export" }, res, { cid: "c", cs: {}, pathname: "/api/logs/export" });
    await res.done;

    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Disposition"], /^attachment;/);
    assert.match(res.body, /not written yet/);
    assert.ok(!res.body.includes("ENOENT"), "an absent file is not an error to the reader");
  });
});
