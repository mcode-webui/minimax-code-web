// webui/server/lib/log-export.js
//
// The body behind the About section's 「导出日志」 action (SB-8 / D-3).
//
// Why a bundle and not an upload. The disabled placeholder read 「上传日志」,
// which promises a destination this edition does not have: there is no
// telemetry sink, no ticket intake, and nothing leaves the machine. The
// honest action for a self-hosted server is to hand the operator a file.
// So this module assembles the server's own diagnostic trail into ONE text
// file that the browser saves, and the route serves it as an attachment.
//
// The two sources, and why only two:
//
//   - `.server.err` — the crash trail `config.js#installGlobalErrorHandlers`
//     appends to (uncaught exceptions, unhandled rejections). Small, and the
//     first thing anyone debugging a dead server asks for.
//   - `events.ndjson` — the append-only event log `lib/events.js` writes
//     (session lifecycle, authorization decisions, exports). On a long-lived
//     install this is tens of megabytes, so only its tail ships.
//
// What is deliberately NOT here: `sessions.json` (conversation transcripts),
// `settings.json` (provider credentials) and `uploads/`. A diagnostics file
// that a user is likely to attach to a bug report must not be the one file
// on the machine carrying their API keys and their conversations.
//
// Every failure is a VALUE, not an exception. A missing data directory, an
// unreadable file, a file that grew past the byte cap — each becomes a
// section that says so, so the downloaded file is never silently shorter
// than the operator believes.

import { readFileSync } from "node:fs";

import { SERVER_ERR_LOG } from "./config.js";
import * as events from "./events.js";
import { fileTimestamp } from "./markdown.js";

// Line cap per source. The event log is the only one that realistically
// exceeds it; `.server.err` is a crash trail and stays whole.
export const DEFAULT_MAX_LINES_PER_FILE = 2000;

// Byte cap per source, applied AFTER the line cap, because a single
// pathological line (a giant tool payload echoed into a log) would
// otherwise slip past a line-based bound.
export const DEFAULT_MAX_BYTES_PER_FILE = 2 * 1024 * 1024;

/**
 * The sources, resolved at call time.
 *
 * Both paths come from the modules that WRITE them rather than from a
 * second hardcoded guess: `SERVER_ERR_LOG` for the crash trail, and
 * `events.path()` for the event log (which honours
 * `MCODE_WEBUI_EVENTS_PATH`, so a test or an operator with a relocated
 * data directory is read from where it actually writes).
 *
 * `resolve` returning `null` means "this edition does not have that file
 * at all" and the section records that instead of reading a guess.
 */
export function resolveLogSources() {
  return [
    { id: "server-errors", label: "Server error log (.server.err)", path: SERVER_ERR_LOG },
    { id: "events", label: "Event log (events.ndjson, most recent last)", path: events.path() },
  ];
}

/**
 * Keep the tail of `text`, bounded by BOTH a line count and a byte count.
 *
 * The tail (not the head) is what a diagnostic export needs: the failure
 * being investigated happened most recently. `truncated` carries the counts
 * the header prints, so the reader learns from the file itself that an
 * older part was left out — a bounded file that looks complete is the one
 * failure mode this whole module exists to avoid.
 */
export function tailText(text, { maxLines, maxBytes } = {}) {
  const source = typeof text === "string" ? text : "";
  const lines = source.split("\n");
  // A trailing newline yields a final empty element; it is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const keptLines = lines.slice(Math.max(0, totalLines - maxLines));
  let body = keptLines.join("\n");
  const linesTruncated = totalLines > keptLines.length;
  const bytesTruncated = body.length > maxBytes;
  if (bytesTruncated) body = body.slice(body.length - maxBytes);
  return {
    body,
    totalLines,
    keptLines: keptLines.length,
    linesTruncated,
    bytesTruncated,
    truncated: linesTruncated || bytesTruncated,
  };
}

/** `mcode-webui-logs-<timestamp>.txt` — the attachment filename. */
export function logBundleFilename(now = Date.now()) {
  return `mcode-webui-logs-${fileTimestamp(now)}.txt`;
}

/**
 * Assemble the downloadable bundle.
 *
 * Returns the body text plus a per-source report, so a test (and the
 * route's own audit line) can assert on what was actually included
 * instead of on prose.
 */
export function buildLogBundle({
  sources = resolveLogSources(),
  maxLinesPerFile = DEFAULT_MAX_LINES_PER_FILE,
  maxBytesPerFile = DEFAULT_MAX_BYTES_PER_FILE,
  now = Date.now(),
} = {}) {
  const stamp = new Date(Number(now) || Date.now()).toISOString();
  const header = [
    "mcode-webui diagnostic log bundle",
    `generated: ${stamp}`,
    `sources per file: last ${maxLinesPerFile} lines / last ${maxBytesPerFile} bytes`,
    "note: this bundle is produced by the server you are running; nothing was uploaded anywhere.",
  ];
  const sections = [];
  const report = [];

  for (const source of sources) {
    const title = `===== ${source.label} =====`;
    if (!source.path) {
      const text = "(not available on this server)";
      sections.push(`${title}\n${text}\n`);
      report.push({ id: source.id, path: source.path ?? null, state: "unavailable" });
      continue;
    }
    let raw;
    try {
      raw = readFileSync(source.path, "utf8");
    } catch (e) {
      // ENOENT is not a failure to report as one: a server that has never
      // crashed has no `.server.err`, and a fresh install has no event log.
      // That is the bundle's NORMAL state, and the file says so in the same
      // words the other sections use for an honest empty.
      const missing = e.code === "ENOENT";
      const text = missing
        ? "(not written yet — this server has logged nothing to this file)"
        : `(unreadable: ${e.code || e.message})`;
      sections.push(`${title}\n${text}\n`);
      report.push({
        id: source.id,
        path: source.path,
        state: missing ? "absent" : "unreadable",
        ...(missing ? {} : { reason: e.code || e.message }),
      });
      continue;
    }
    const tail = tailText(raw, { maxLines: maxLinesPerFile, maxBytes: maxBytesPerFile });
    if (tail.totalLines === 0) {
      sections.push(`${title}\n(empty — the file exists but holds no lines yet)\n`);
      report.push({ id: source.id, path: source.path, state: "empty" });
      continue;
    }
    const notes = [];
    if (tail.linesTruncated) {
      notes.push(`[truncated: showing the last ${tail.keptLines} of ${tail.totalLines} lines]`);
    }
    if (tail.bytesTruncated) {
      notes.push(`[truncated: also cut to the last ${maxBytesPerFile} bytes]`);
    }
    sections.push(`${title}\n${notes.length ? `${notes.join(" ")}\n` : ""}${tail.body}\n`);
    report.push({
      id: source.id,
      path: source.path,
      state: "read",
      totalLines: tail.totalLines,
      keptLines: tail.keptLines,
      truncated: tail.truncated,
    });
  }

  const text = `${header.join("\n")}\n\n${sections.join("\n")}`;
  return { text, sources: report, generatedAt: stamp };
}
