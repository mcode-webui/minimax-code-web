// webapp/lib/path-clipboard.ts
//
// Clipboard helper for absolute file paths. The file tree already
// implements its own copy in components/panels.tsx#FileRow (it
// shows a transient "Path copied" confirmation). The file-tab
// breadcrumb (slice 15) needs the same copy without the
// confirmation banner — the breadcrumb is too compact for a
// transient label, and a global confirmation banner is overkill
// for a small affordance.
//
// The write itself lives in lib/clipboard.ts (webui-parity 89 moved it
// out of this file so the toolbar version badge's commit-id copy and
// this path copy share one fallback chain rather than keeping two
// copies of it); this module stays as the named entry point for path
// callers.

export { copyTextToClipboard as copyPathToClipboard } from "./clipboard";
