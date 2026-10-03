// webui/server/routes/logs.js
// GET /api/logs/export — the About section's 「导出日志」 action (SB-8 / D-3).
//
// This endpoint REPLACED a permanently disabled 「上传日志」 button. The old
// label promised a destination this edition does not have (no telemetry
// sink, no ticket intake, nothing leaves the machine), so the honest action
// is a download of the server's own diagnostic trail. The bundle is
// assembled by `lib/log-export.js`; this file owns the wire.
//
// Contract:
//   - 200 `text/plain; charset=utf-8` with `Content-Disposition:
//     attachment` — the browser saves the bytes under a timestamped
//     filename. There is no `?download=` flag and no JSON variant: one
//     shape, one meaning.
//   - ALWAYS 200, including when a log file is missing or unreadable.
//     Those cases are reported INSIDE the body (lib/log-export.js records
//     them per section), because the UI hands the user a plain anchor and
//     a 4xx would silently land a JSON error document in their downloads
//     folder under a `.txt` name — a file that looks like logs and is not.
//     A status code is the wrong channel when the deliverable is a file.
//
// Gate posture: this is a GET, so the shared chain (router gates 1-5) puts
// it behind the same token / LAN / rate-limit rules as every other read —
// the log trail is not a lower-sensitivity surface than the session list.

import { buildLogBundle, logBundleFilename } from "../lib/log-export.js";

export function handleExportLogs(_req, res, _ctx) {
  const { text } = buildLogBundle();
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${logBundleFilename()}"`,
    "Content-Length": Buffer.byteLength(text, "utf8"),
  });
  return res.end(text);
}
