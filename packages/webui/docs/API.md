# HTTP API reference

**English** | [简体中文](API.zh-CN.md)

> Complete enumeration of every endpoint. REST is JSON unless noted; the
> two SSE endpoints are `/api/events` (chat / state) and `/api/alerts`
> (anomaly / audit).

All non-API routes return static files (`server.js` → `serveStatic` /
`serveIndex`).

## Conventions

- **Base URL**: `http://127.0.0.1:18090` (or LAN IP if enabled)
- **Path prefix**: `/api/`
- **Content-Type**: `application/json; charset=utf-8` for both request and response
- **Auth header**: if `TOKEN` env is set, every request must include either
  - query: `?token=…`
  - header: `Authorization: Bearer …`
  - 401 if missing or wrong
- **CID**: each request should include `?cid=<uuid>` to identify the webui
  tab. The webui injects this automatically; if missing, the server falls
  back to the `default` CID.
- **Errors**: every error response is `{ok: false, error: 'human-readable message'}`
  with an appropriate 4xx/5xx status. Some legacy endpoints still return
  `{ok: true, …}` even on soft failures — those are called out below.

---

## Health

### `GET /api/health`

Returns server status. No auth required, no CID required.

**Response 200**
```json
{
  "ok": true,
  "port": 18090,
  "defaultModel": "minimax_api/MiniMax-M3",
  "defaultWorkspace": "C:\\Users\\you\\.minimax-code\\webui",
  "mcodeCmd": "C:\\Users\\you\\.minimax-code\\mcode.cmd",
  "mcodeVersion": "0.5.2",
  "maxConcurrent": 3
}
```

`mcodeVersion` is the engine's own version (from the ACP `initialize`
reply). It is `"unknown"` before a client has attached — the endpoint
does not pin a constant.

### `GET /api/account`

Account card data: display name, plan tier, and quota. Fetched on
demand rather than pushed in the SSE state snapshot — the snapshot is
broadcast to every subscriber including LAN clients, and account data
should not be in that channel. The engine holds the credential; webui
only relays the projection (see `server/lib/mcode-rpc.js#getAccountStatus`).

**Response 200** (engine answered)
```json
{ "ok": true, "name": "weekbin", "planTier": "max", "remaining": 86, "weeklyRemaining": 92, "resetAt": 1790164800, "weeklyResetAt": 1790524800 }
```

**Response 200** (engine unavailable — soft failure)
```json
{ "ok": false, "reason": "no_client" }
```

`reason` is one of `no_client` / `rpc_error` / `account_unavailable` —
the card renders its empty state, the route never invents a name or a
plan.

---

## State & event stream

### `GET /api/state`

Returns the current `state` object for this CID. See
[ARCHITECTURE.md §4](ARCHITECTURE.md) for the full shape.

**Response 200**
```json
{ "ok": true, "version": "0.5.2", "running": {"active": false}, … }
```

### `GET /api/alerts`

REST snapshot of the anomaly / system-signal ring buffer (at most 100
entries, oldest first). Live updates are not delivered here — they
arrive as `alerts.append` / `alerts.update` control frames on the
WebSocket event stream (`GET /api/stream`); clients merge those frames
into this snapshot and de-duplicate by `alert.id`.

**Response 200** (`Content-Type: text/event-stream`)
```
event: state
data: {"version":"0.5.2","running":{"active":false},…}

event: delta
data: {"text":"hello","isPartial":true}

event: exec
data: {"status":"ok","durationMs":12345}
```

### `GET /api/stream`

WebSocket event stream endpoint (design doc `docs/drafts/arch_net_solution_0922.md` §7.2). The endpoint is always enabled — there is no transport switch — and the upgrade executes the same gate chain (origin / LAN / token) as every other `/api/*` route; a plain `GET` without an `Upgrade` header answers 426, and a successful RFC 6455 handshake establishes the connection. Server-to-client frames are WS text JSON: `hello` (`{v:1, type:"hello", payload:{cid, resumeSupported, latestSeq, heartbeatMs, ringCapacity}}` — `cid` echoes the client id this stream is bound to), `state.snapshot` and `control` event frames carrying `seq`/`ts`, and `error` frames. The shipped SPA consumes this endpoint: it receives state snapshots and control events here, takes its first-connect baseline from `GET /api/state`, and its alert snapshot from `GET /api/alerts`. The client may send only JSON text frames (`resume`/`ping`/`pong`/`close`); binary frames close the connection with 1002. Resume: `{v:1, type:"resume", payload:{lastSeq}}` replays buffered events in strictly increasing `seq` order; when the ring buffer has underrun, the most recent `state.snapshot` is sent as the baseline. Heartbeats are WS ping control frames (default 30s; two missed pongs close with 1001). The inbound token-bucket quota is 20 frames/s sustained with a burst of 40; exceeding it closes with 1013.

### `GET /api/alerts`

Independent anomaly / system-signal SSE channel. The chat/state
stream is per-CID; `/api/alerts` is global. The bell icon and the
audit log subscribe here. See `server/routes/alerts.js` for the wire
format.

**Response 200** (`Content-Type: text/event-stream`)
```
data: {"kind":"snapshot","alerts":[{…}, …]}

data: {"kind":"append","alert":{…}}
data: {"kind":"update","alert":{…}}

event: heartbeat
data: {"ts":1730000000000}
```

- `snapshot` is sent once on connect, carrying the 100-entry ring
  buffer's current contents.
- `append` / `update` carry individual alerts (id, level, message,
  source, dedupKey, count, firstSeenAt, lastSeenAt).
- `heartbeat` every 30 s — keeps proxies from idling the channel out.

---

## Chat

### `POST /api/send`

Send a user message. Spawns (or reuses) the mcode subprocess for this CID
and streams the result over the WebSocket event stream (`GET /api/stream`).

**Request**
```json
{
  "content": "refactor the workspace picker to use a tree",
  "attachments": ["@C:\\path\\to\\file.py"],
  "isAskAnswer": false
}
```

- `content` (string, required) — the user message. May include `@path`
  references to attachments; the webui injects these automatically.
- `attachments` (string[], optional) — list of `@path` strings to
  prepend to the content. The webui populates this from the attachment
  UI; you usually don't pass it directly.
- `isAskAnswer` (bool, optional) — when `true`, the content is the
  answer to an active `ask_user` question. Set by the ask modal
  automatically.

**Response 200** `{ok: true}` immediately. The actual response streams
over the WebSocket event stream (`/api/stream`).

**Errors**
- 409 if `state.running.active === true` (already running)
- 400 if `content` is empty

### `POST /api/stop`

Cancel the current run. Tries `session/cancel` via acp (the cancel
notification is delivered to the active child subprocess; the route
server falls back to SIGTERM on the subprocess if the notification could
not be delivered, then SIGKILL after 2s).

**Request** `{}`

**Response 200** `{ok: true, cancelled: true, killEndpoint: "/api/stop"}`

When the notification does not reach the engine, the route answers with
`{ok: true, cancelled: false, warning, code, killEndpoint: "/api/stop"}` —
the caller can re-issue `POST /api/stop` for the hard-kill cascade.

### `POST /api/cmd`

Send a raw slash command (e.g. `/compact`, `/clear`). The server sends
the command to mcode and streams the result.

**Request**
```json
{ "cmd": "/compact" }
```

**Response 200** `{ok: true}`

---

## Sessions

### `GET /api/sessions`

List webui sessions + mcode sessions (merged, deduplicated).

**Response 200**
```json
{
  "ok": true,
  "count": 12,
  "sessions": [
    { "id": "uuid", "title": "…", "workspace": "C:\\…", "mcodeSessionId": "mvs_…", "updatedAt": 1234567890 }
  ]
}
```

### `POST /api/sessions`

Create a new webui session. Optionally tied to a workspace.

**Request**
```json
{ "workspace": "C:\\path\\to\\project" }
```

When `workspace` is provided it must clear the same containment gate as
`POST /api/workspace` (existing directory inside an allowed root, symlinks
resolved) — 400 otherwise, and no session record is created.

**Response 200** `{ok: true, id: "uuid"}`

### `POST /api/sessions/switch`

Switch to an existing session. Loads its chat history and (if linked)
re-attaches to the mcode session.

**Request**
```json
{ "id": "uuid" }
```

**Response 200** `{ok: true}`

### `POST /api/sessions/rename`

Rename a session (CRUD "update"). `id` accepts a webui uuid, an `mvs_…`
mcode session id, or a bare `mvs_…` with no webui wrapper yet (an overlay
record is created to carry the title). The title is user-authoritative: the
record is flagged `titleCustom: true` and mcode's automatic title generation
never overwrites it afterwards.

Not gated by the `authorize()` modal — renaming is non-destructive and
reversible (same class as `session.create`); a `session.rename` audit event
(`from` → `to`) is appended to the hash chain either way.

**Request**
```json
{ "id": "uuid", "title": "my renamed session" }
```

**Response 200**
```json
{ "ok": true, "session": { "id": "uuid", "mcodeSessionId": "mvs_…", "title": "my renamed session", "titleCustom": true } }
```

**Errors** — 400 missing `id` / blank `title` / `title` over 200 chars;
404 unknown non-`mvs_` id.

### `POST /api/sessions/cleanup-orphans`

Delete mcode sessions that no webui session references. Two scopes:

- `scope: "orphans"` (default) — only delete mcode sessions with no
  webui reference. The currently-active session is always preserved.
- `scope: "all"` — delete every mcode session, then re-link webui
  sessions that had a `mcodeSessionId` (which now points to a deleted
  session — they become "webui-only" again).

**Request**
```json
{ "scope": "orphans" }
```

**Response 200**
```json
{
  "ok": true,
  "scope": "orphans",
  "total": 37,
  "targets": 18,
  "deleted": 18,
  "failed": 0,
  "log": ["deleted mvs_5103ca…", "deleted mvs_88c796…", …]
}
```

### `DELETE /api/sessions/:id`

Delete a webui session AND its linked mcode session (if any). The mcode
deletion is a single SQLite transaction across the 32 session-keyed
`local_runtime_*` tables (plus `local_runtime_sessions`) — any
non-absent per-table error rolls the whole transaction back.

Pass `?dryRun=true` to preview the mcode-side impact without modifying
anything.

**Response 200** (main path)
```json
{
  "ok": true,
  "deleted": "uuid",
  "matchKind": "webuiId",
  "dryRun": false,
  "remaining": 11,
  "mcodeDbDel": {
    "ok": true,
    "outcome": "deleted",
    "log": ["local_runtime_sessions:1", "local_runtime_message_rows:42", "…"],
    "totalRowsDeleted": 57,
    "tablesAbsent": 0
  }
}
```

**`mcodeDbDel.outcome` — explicit verdicts (no fake success)**:

| outcome / reason | Meaning |
|---|---|
| `deleted` | Transaction committed; rows were removed. |
| `already_absent` | Transaction committed; nothing matched for this sid (tables individually missing are skipped only when the schema catalog confirms the absence). |
| `unsupported_schema` (`ok:false`, `reason`) | A table exists but has no `session_id` key column; rolled back, `table` names it. |
| `db_error` (`ok:false`, `reason`) | Lock conflict (`SQLITE_BUSY`/`LOCKED`), prepare/run failure, or IO error; rolled back. |
| `audit_write_failed` (`ok:false`, `reason`) | Rows may be gone but the audit event could not be recorded — surfaced, never a clean success. |

The `session.delete` audit event carries the `outcome`
(`tablesAffected` / `tablesAbsent` / `totalRowsDeleted`). On the orphan
path (`mvs_*` id with no webui session), a failed mcode delete answers
**500** with the same `mcodeDbDel` failure object embedded; on the main
path the 200 body's `mcodeDbDel.ok` / `outcome` fields are the source
of truth for the mcode-side result.

**Response 404** `{"ok": false, "error": "session not found"}` — id
matches neither a webui session nor an `mvs_*` pattern.

### `GET /api/acp-sessions`

Raw mcode session list (from sqlite). No webui merge.

**Response 200** `{ok: true, sessions: [...]}`

### `GET /api/acp-session-title?sessionId=mvs_…`

Get the title of an mcode session.

**Response 200** `{ok: true, title: "…"}`

### `GET /api/session-tree?refresh=1`

Sidebar tree: workspaces with their sessions nested. Cached for
15 s (`CACHE_TTL_MS` in `server/routes/sessions.js`). Mutations
(`POST /api/sessions`, `/api/sessions/rename`, `DELETE /api/sessions/:id`)
bust the cache automatically; clients that race the bust can pass
`?refresh=1` to force a reread.

**Response 200**
```json
{
  "ok": true,
  "tree": [
    {
      "dir": "C:\\path\\to\\project",
      "name": "project",
      "current": true,
      "sessionCount": 3,
      "lastActiveAt": 1730000000000,
      "sessions": [
        { "id": "uuid", "title": "…", "mcodeSessionId": "mvs_…", "updatedAt": 1730000000000 }
      ]
    }
  ]
}
```

### `GET /api/sessions/search?q=…&workspace=…&limit=20`

Cross-workspace fuzzy title search, deduped per workspace (best match
wins). `limit` is clamped to `[1, 100]`. An empty `q` returns
`{ok: true, results: []}` by design — search is a query, not a list-all
endpoint. Gated by the per-request authorize path (action
`session.search`).

**Response 200**
```json
{
  "ok": true,
  "results": [
    { "id": "uuid", "title": "refactor the workspace picker", "workspace": "C:\\…", "updatedAt": 1730000000000, "matchScore": 100 }
  ]
}
```

**Response 403** `{ok: false, error: "authorize declined", decidedBy, decidedAt}`

### `GET /api/sessions/:id/export?format=md|json&download=true|false`

Export a session's chat as Markdown or JSON. Reads
`$WEBUI_DATA_DIR/sessions.json` (primary) + `runtime-state.sqlite`
(best-effort secondary). Gated by the per-request authorize path
(action `session.export`). The default `format` is `md`; `download=true`
attaches a `Content-Disposition` so the browser saves it.

**Response 200** — `format=md` → `text/markdown; charset=utf-8` body
with the chat rendered as Markdown; `format=json` → `application/json`
body with the full session record (id, title, workspace, mcodeSessionId,
chat, createdAt, updatedAt).

**Errors** — 400 missing `id` / unsupported format (with `allowed` list);
403 authorize declined; 404 unknown id.

---

## Workspace

### `POST /api/workspace`

Change the workspace for the current CID.

**Request**
```json
{
  "dir": "C:\\path\\to\\project",
  "syncTui": true
}
```

- `dir` (string, required) — absolute path
- `syncTui` (bool, optional) — also write the path to `cwd.json` so the
  mcode TUI sees it
- `action: "detect"` — instead of changing, return the current TUI cwd
- `action: "useTui"` — copy the TUI's cwd to webui
- `action: "reset"` — restore webui's default workspace

**Response 200** `{ok: true, dir: "…", branch: "main", treeState: "clean"}`

### `GET /api/workspace/browse?path=…`

List a directory for the tree browser.

**Request** query: `?path=C:\\Users` (omit for drive roots on Windows
or `/` for Linux)

**Response 200**
```json
{
  "ok": true,
  "path": "C:\\Users",
  "children": [
    { "name": "Public", "path": "C:\\Users\\Public", "isDir": true }
  ]
}
```

When `path` is omitted, the root view lists only the **allowed roots**
(🔒 v2 — see below); the response keeps its platform-compatible shape:
- Windows: `roots: ["C:\\Users\\you", …]` (the allowed roots), `dir: null`
- POSIX: `dir: "/"`, `roots: ["/home/you", "/tmp", …]`, `children: []`

**🔒 v2 workspace containment (PR #55 review point 5)**: a candidate
path is `resolve()`d and symlink-resolved (`realpath`), and must land
within an allowed root — default allowed roots are the user's home
directory + the default workspace + the system tmp directory. The
`MCODE_WEBUI_WORKSPACE_ROOTS` env var (path-separator-separated
segments) **fully replaces** the default set. Out-of-root paths —
including `../` traversal and symlink escapes — are rejected with an
actionable error naming the resolved path, the allowed roots, and the
env knob. Both this endpoint and `POST /api/workspace` enforce the same
boundary.

### `GET /api/workspace/tree`

Workspace → session tree, used by the sidebar's workspace dropdown
and the Switch Workspace sheet. Groups the webui sessions store by
`workspace` dir; sorts by `current` first, then `lastActiveAt` desc.
The currently-active workspace appears at the top even when it has
zero sessions (the most common choice when starting a new chat).

**Response 200**
```json
{
  "ok": true,
  "current": "C:\\path\\to\\project",
  "defaultWorkspace": "C:\\…\\webui",
  "home": "C:\\Users\\you",
  "tmpDir": "C:\\Users\\you\\AppData\\Local\\Temp",
  "platform": "win32",
  "workspaces": [
    {
      "dir": "C:\\path\\to\\project",
      "name": "project",
      "sessionCount": 3,
      "lastActiveAt": 1730000000000,
      "current": true,
      "sessions": [
        { "id": "uuid", "mcodeSessionId": "mvs_…", "title": "…", "updatedAt": 1730000000000 }
      ]
    }
  ]
}
```

### `GET /api/workspace/resolve?name=<folder-name>`

Resolve a folder name (the only thing `<input webkitdirectory>` gives
the browser) into absolute-path candidates across the common roots
(home, default workspace, tmp). The user confirms which one matches.
The server runs on the same machine as the browser, so a name lookup
is enough — no permission prompt needed.

**Response 200**
```json
{ "ok": true, "candidates": ["C:\\path\\to\\folder", "/home/you/folder"] }
```

### `GET /api/workspace/recent?search=&limit=5`

Recent workspaces, optionally filtered by a substring match against
the dir. `limit` is clamped to `[1, 20]`; default is 5. The `tmpDir`
field on the response is for the "no workspace needed" button.

**Response 200**
```json
{
  "ok": true,
  "items": [{ "dir": "C:\\…", "name": "project", "lastActiveAt": 1730000000000, "sessionCount": 3 }],
  "total": 12,
  "search": "",
  "limit": 5,
  "tmpDir": "C:\\Users\\you\\AppData\\Local\\Temp"
}
```

### `POST /api/workspace/pick`

Spawn the native OS folder picker (`zenity` / `kdialog` / `osascript` /
PowerShell `FolderBrowser`) and return the chosen path. The route
never throws — a user cancel answers `200 {ok: true, path: null}`; a
spawn failure answers `200 {ok: false, error}`.

**Response 200** (user picked something)
```json
{ "ok": true, "path": "C:\\path\\to\\folder" }
```

**Response 200** (user cancelled)
```json
{ "ok": true, "path": null }
```

---

## Filesystem

The fs endpoints are read/write primitives for the workspace picker
panels. They share the same containment boundary as
`POST /api/workspace` / `GET /api/workspace/browse`: a candidate path
is `resolve()`d, symlink-resolved (`realpath`), and must land within
an allowed root (default home + default workspace + tmp;
`MCODE_WEBUI_WORKSPACE_ROOTS` fully replaces the set).

### `GET /api/fs/read?path=<dir>&showHidden=0|1`

List a directory inside an allowed root. `path` is required;
`showHidden=1` includes dotfiles. Symlinks-as-files are returned as
`Dirent` entries (webui shows them as files; no symlink-follow yet —
see [CAPABILITIES.md §6](CAPABILITIES.md)).

**Response 200** (the shape comes from `readDirectory()`)
```json
{ "ok": true, "path": "C:\\Users\\you\\Documents", "entries": [{ "name": "…", "path": "C:\\…", "isDir": true }] }
```

**Errors** — 400 missing `path`; 403 out-of-root.

### `POST /api/fs/mkdir`

Create a directory inside an allowed root. The target does not have
to exist yet — the route validates the **parent** path is in-bounds
before creating.

**Request**
```json
{ "path": "C:\\Users\\you\\Documents\\new-folder" }
```

**Response 200** `{ok: true, path: "C:\\…\\new-folder"}`

**Errors** — 400 invalid JSON; 403 parent out-of-root; 409 already
exists.

---

## Settings

### `GET /api/settings`

Returns the full settings snapshot. **This endpoint is exempt from
the LAN guard** — it's how a remote user toggles LAN back on after
locking themselves out. The same snapshot is also pushed over the
WebSocket event stream on state changes (see
[ARCHITECTURE.md §5 event schema](./ARCHITECTURE.md#5-event-schema-websocket-event-stream)).

**Response 200** (🆕 v1.0.1, 🔒 v2 security — PR #55 review)
```json
{
  "ok": true,
  "lanBroadcast": true,
  "port": 18090,
  "host": "127.0.0.1",
  "lanIp": "192.168.1.50",
  "lanUrl": "http://192.168.1.50:18090",
  "lanUrlWithToken": "http://192.168.1.50:18090/?token=…",  // 🔒 v2 — FIRST-RUN BOOTSTRAP ONLY: present while tokenAcknowledged=false, omitted entirely after ack (UI falls back to lanUrl); re-issued once per rotation
  "localUrl": "http://127.0.0.1:18090",
  "lanBind": false,                // 🔒 v2 — persisted LAN-bind opt-in; true binds 0.0.0.0 on next boot (env HOST still wins)
  "bindHost": "127.0.0.1",         // 🔒 v2 — what the NEXT boot resolves to (env HOST > lanBind > loopback)
  "lanExposed": false,             // 🔒 v2 — effective bind is not loopback
  "bindRestartPending": false,     // 🔒 v2 — setting no longer matches the live socket; never true when env HOST owns the bind
  "lanExposureNotice": "",         // 🔒 v2 — bilingual exposure disclosure (non-empty when exposed / pending)
  "trustedOrigins": [],            // 🔒 v2 — explicit cross-origin allowlist for CORS reflection (see below)
  "mcodeCmd": "C:\\…\\mcode.cmd",
  "mcodeVersion": "0.5.2",
  "defaultWorkspace": "C:\\…",
  "defaultModel": "minimax_api/MiniMax-M3",
  "readOnly": false,                // 🆕 v1.0.1 — read-only mode toggle
  "tokenEnabled": true,             // 🆕 v1.0.1 — token auth master switch (default true)
  "currentToken": "…",              // 🆕 v1.0.1 — auto-generated 32-hex token; "" after tokenAcknowledged=true
  "tokenAcknowledged": false,       // 🆕 v1.0.1 — operator has confirmed they saved the token
  "tokenRotatedAt": 1724259600000   // 🆕 v1.0.1 — ms-since-epoch of the last rotation
}
```

Notes on the 🔒 v2 fields:

- `host` stays the **actual boot-time bind**; `bindHost` recomputes
  what the next boot would resolve to from current state
  (`resolveBindHost`: env `HOST` > `lanBind` > `127.0.0.1`).
- `trustedOrigins` is the explicit CORS allowlist — origins listed here
  are reflected verbatim in `Access-Control-Allow-Origin` in addition
  to the server's own serving origins (loopback + LAN address while
  LAN sharing is on). See
  [SECURITY-NOTES CORS](../references/SECURITY-NOTES.md#cors--cross-origin-resource-sharing).

Fields `currentToken` and `tokenAcknowledged` are persisted to
`~/.mcode-webui/settings.json` (mode `0600` on Unix). `currentToken`
and `lanUrlWithToken` are **omitted after `tokenAcknowledged=true`** —
the server only ships the token while the operator still has a copy of
it in the UI.
`MCODE_WEBUI_SETTINGS_PATH` env overrides the file location.

### `POST /api/settings`

Update one or more settings. v1.0.1 expanded the payload — any
combination of the fields below is settable in one request.
**Always exempt from the LAN guard AND the read-only gate** (so the
admin can always toggle things remotely, even in read-only mode).

**v2 request — all settable fields** (🆕 v1.0.1, 🔒 v2 security — PR #55 review)
```json
{
  "lanBroadcast": true,            // (existing) LAN on/off
  "lanBind": true,                 // 🔒 v2 — persisted LAN-bind opt-in; binds 0.0.0.0 on next boot (restart-effective)
  "trustedOrigins": ["https://webui.example.com"],  // 🔒 v2 — explicit CORS allowlist; replaces the stored list wholesale
  "readOnly": true,                // 🆕 v1.0.1 — toggle read-only mode
  "tokenEnabled": false,           // 🆕 v1.0.1 — toggle token auth master switch
  "resetToken": true,              // 🆕 v1.0.1 — generate new token + broadcast auth.token_rotated over the event stream
  "acknowledgeToken": true         // 🆕 v1.0.1 — operator confirms they saved the token; server stops sending it
}
```

`trustedOrigins` validation (fail-closed, whole batch): `http`/`https`
origin serialization only (`scheme://host[:port]` — no path / query /
userinfo), at most 16 entries of 1..200 chars each; an invalid batch is
rejected **400 before any state changes** (a malformed allowlist can
never partially widen the CORS surface).

**Responses**

- `200 {"ok":true, "changed":true, …}` — at least one field was updated
- `200 {"ok":true, "tokenRotated":true, "currentToken":"…", "tokenAcknowledged":false, "tokenRotatedAt":…}` — special response for `resetToken:true` (returns the new value so the caller can update its localStorage)
- `200 {"ok":true, "changed":false}` — no field actually changed
- `400 {"ok":false, "error":"invalid origin: …"}` (and similar) — `trustedOrigins` batch failed validation
- `500 {"ok":false, "error":"…"}` — only on `rotateToken` disk write failure (rare)

---

## Upload

### `POST /api/upload`

Multipart file upload. Saves to `MCODE_WEBUI_UPLOAD_DIR` and returns
the absolute path. 🔒 v2 security (PR #55 review point 3): the parser
is a bounded streaming state machine (memory O(chunk), never O(body)),
with three limits enforced mid-stream:

| Limit | Default | Env override (positive integer) | Error code |
|---|---|---|---|
| Total request body | 50 MiB | `MCODE_WEBUI_UPLOAD_MAX_REQUEST` | `UPLOAD_REQ_TOO_LARGE` |
| Single file | 25 MiB | `MCODE_WEBUI_UPLOAD_MAX_FILE` | `UPLOAD_FILE_TOO_LARGE` |
| Upload-directory quota | 200 MiB | `MCODE_WEBUI_UPLOAD_QUOTA` | `UPLOAD_QUOTA_EXCEEDED` |

**Request** `multipart/form-data` with a `file` field.

**Response 200**
```json
{
  "ok": true,
  "path": "C:\\…\\.mcode-webui\\uploads\\screenshot.png",
  "name": "screenshot.png",
  "size": 12345
}
```

(`size` is the stored byte count; the file lands at its final name only
via `rename()` after a clean stream end — failures leave no
half-written artifact.)

**Errors** — status is mapped from the error code, and the code is
echoed in the body so the client sees WHICH limit fired:

```json
{ "ok": false, "error": "file exceeds size limit: 26214401 > 26214400 bytes (adjust MCODE_WEBUI_UPLOAD_MAX_FILE to allow more)", "code": "UPLOAD_FILE_TOO_LARGE" }
```

- `413` + `Connection: close` — `UPLOAD_REQ_TOO_LARGE` /
  `UPLOAD_FILE_TOO_LARGE` / `UPLOAD_QUOTA_EXCEEDED` (the over-limit
  body was deliberately not consumed)
- `400` — `UPLOAD_MALFORMED` (malformed / truncated multipart) /
  `UPLOAD_ABORTED` (client tore the stream)
- `500` — anything else (disk I/O, audit write, unknown)

---

## Model

### `GET /api/models`

Returns the builtin + currently-configured model list.

**Response 200**
```json
{
  "ok": true,
  "current": "minimax_api/MiniMax-M3",
  "models": [
    { "id": "minimax_api/MiniMax-M3", "label": "MiniMax-M3", "provider": "minimax_api" }
  ]
}
```

If the list is empty, the response includes a `hint` field pointing
the user at the mcode TUI for model configuration.

### `POST /api/set-model`

Change the model for the current CID. Persists into `cs.model` so the
composer reflects it immediately; with a live mcode session it also
calls `session/set_config_option {configId:'model'}`, routed through
the cid's active child. Without a session, the change is recorded
for the next one.

**Request**
```json
{ "model": "minimax_api/MiniMax-M3" }
```

**Response 200** (engine accepted)
```json
{ "ok": true, "model": "minimax_api/MiniMax-M3", "mcodeSynced": true }
```

Without an `mcodeSessionId` yet: `{ok: true, model: "...", mcodeSynced: false, warning: "no mcode session yet — recorded for the next one"}`.

### `POST /api/permissions`

Change the session-level permission mode. Mid-session routing goes
through `session/set_config_option {configId:'permissionMode'}` (see
[§Protocol](#protocol-acp-shim)). The route also writes the new mode
label into the local `cs.permissions` so the UI updates immediately.

**Request**
```json
{ "mode": "ask" }
```

- `mode` (string) — one of `ask`, `auto`, `read`, `full`. The webui
  maps these to the engine's `permissionMode` values internally; clients
  should send the short alias and not the engine's raw value.

**Response 200** (typical — engine accepts the change)
```json
{ "ok": true, "permissions": "Ask", "mcodeSynced": true }
```

- `permissions` is the display label (`Ask` / `Auto` / `Read` /
  `Full access`).
- `mcodeSynced: true` when the engine's `session/set_config_option`
  call landed on the active child.
- Without an `mcodeSessionId` yet (no session for this CID), the
  response also carries `warning: "no mcode session yet — applies to
  the next one"` and `mcodeSynced: false`.

**Errors** — 400 missing/empty `mode`; the engine's refusal (404/501/…)
is mapped to `{ok: false, error, code}` with the matching HTTP status,
and `mcodeSynced: false`.

### `GET /api/permissions-modes`

List the available permission modes. The response carries both the
webui display labels and the engine's raw `permissionMode` values so a
client can render the dropdown without doing the conversion itself.

**Response 200**
```json
{
  "ok": true,
  "webui": [
    { "value": "ask",  "label": "Ask",         "mcodeValue": "default" },
    { "value": "auto", "label": "Auto",        "mcodeValue": "auto" },
    { "value": "read", "label": "Read",        "mcodeValue": "read" },
    { "value": "full", "label": "Full access", "mcodeValue": "bypassPermissions" }
  ],
  "mcode": [
    { "value": "default", "label": "Ask" },
    { "value": "auto",    "label": "Auto" },
    { "value": "read",    "label": "Read" },
    { "value": "bypassPermissions", "label": "Full access" }
  ]
}
```

### `POST /api/answer`

Respond to an active permission / plan / ask_user prompt.

**Request**
```json
{ "type": "permission", "option": "ask" }
```

- `type` (string) — `permission` | `plan` | `planmode` | `ask`
- `option` (string) — depends on type:
  - `permission`: `ask` | `auto` | `full`
  - `plan`: `agree` | `skip` | `add`
  - `planmode`: `continue` | `deny`
  - `ask`: `esc` (skip) | `<index>` (option) | `<text>` (free-form)

**Response 200** `{ok: true}`

---

## Usage

### `POST /api/usage` and `POST /api/usage-trigger`

Read the Token Plan quota for the account. Both routes dispatch through
`usageRoute.handleUsage`.

The figures come from the engine. mcode holds the account credential and reports
the plan tier plus each window's remaining percentage through the ACP extension
method `mcode/account/status`; webui keeps no Subscription Key of its own (see
`server/lib/usage.js`).

`remaining` and `weeklyRemaining` are percentages, and both appear only when the
engine reported a figure — a body without them means "no gauge to draw", not 0%.
`resetAt` and `weeklyResetAt` are unix seconds. `ok: false` with `error` means the
engine could not be asked (no ACP client, or the method failed); the HTTP status
stays 200 because the request itself succeeded.

(An older revision of this entry advertised `GET /api/usage`. That route was
never wired up, and the heading now names the two POSTs the router actually
registers, so `scripts/check-docs-alignment.mjs` keeps agreeing with it.)

**Response 200**
```json
{
  "ok": true,
  "source": "acp",
  "remaining": 99,
  "weeklyRemaining": 86,
  "resetAt": 1790164800,
  "weeklyResetAt": 1790524800,
  "fetchedAt": 1790000000000
}
```

### `GET /api/usage-real`

Fetch per-turn context usage from the `mavis` runtime db. This is the
source of truth for "已用 N / 占比 N%" in the right panel.

**Response 200**
```json
{
  "ok": true,
  "lastTurnContextTokens": 12345,
  "lastInputTokens": 1000,
  "lastCacheReadTokens": 500,
  "lastCacheWriteTokens": 200,
  "lastOutputTokens": 800,
  "contextLimit": 524288,
  "model": "MiniMax-M3",
  "ts": 1234567890
}
```

### `POST /api/refresh`

Push the caller's current state to its SSE clients. The usage popover's refresh
button calls this and then `POST /api/usage`, which is what actually re-reads the
quota from the engine.

**Response 200** `{ok: true}`

### `GET /api/usage/forecast`

Predict quota exhaustion time. Reads
`$WEBUI_DATA_DIR/usage-history.ndjson` and runs the linear + robust
(Huber) extrapolation; the UI shows the bilingual countdown. Best-
effort: a missing or empty history file answers `200 {ok: true,
forecast: { reason: "no_history" }}` so the UI can render a "collecting
data…" placeholder rather than an error.

**Response 200**
```json
{
  "ok": true,
  "forecast": {
    "fiveHour": { "etaIso": "2025-10-29T18:00:00.000Z", "method": "linear", "remainingPct": 86, "samples": 12 },
    "weekly":   { "etaIso": "2025-11-02T03:30:00.000Z", "method": "huber", "remainingPct": 92, "samples": 12 }
  }
}
```

When there is not enough data yet, `forecast` collapses to `{ reason: "no_history" }` or `{ reason: "insufficient_samples" }`.

---

## Protocol (acp shim)

These endpoints wrap the acp protocol methods the webui can call.
Each route dispatches through `server/lib/mcode-rpc.js` and pins the
notification on the active child's subprocess (the cid's per-prompt
`McodeAcpClient`, not the singleton). Engine refusal modes
(`unsupported`, `no_client`, `not_found`, `policy`) are mapped to
`501 / 503 / 404 / 409` respectively; everything else is `502` or `500`.

### `POST /api/protocol/set-mode`

Calls `session/set_mode {sessionId, modeId}`. The webui uses this for
plan / goal mode switches; permission-mode switches go through
`session/set_config_option` instead (see
[§POST /api/permissions](#post-apipermissions)).

**Request** `{sessionId: "mvs_…", mode: "plan_mode" | "goal_mode" | "default" | …}`

**Response 200** `{ok: true, mode: "plan_mode", data: <acp reply>}`

### `POST /api/protocol/set-config-option`

Calls `session/set_config_option {sessionId, configId, value}`. The
generic config-option route: `permissionMode` and `model` are the two
real callers today.

**Request** `{sessionId: "mvs_…", key: "permissionMode", value: "default"}`

**Response 200** `{ok: true, key: "permissionMode", value: "default", data: <acp reply>}`

When `key === "permissionMode"` the route also writes the webui label
into the local `cs.permissions` so the UI updates without waiting for
the next SSE state push.

### `POST /api/protocol/cancel`

Calls `session/cancel {sessionId}`. This route only sends the
notification; on failure it answers `200 { ok: true, cancelled: false,
warning, code, killEndpoint: "/api/stop" }`. The gentle-then-SIGKILL
cascade lives behind `POST /api/stop` — call it explicitly when a hard
kill is what you want.

**Request** `{sessionId: "mvs_…"}`

**Response 200** (notification accepted) `{ok: true, cancelled: true, data: <acp reply>}`

### `POST /api/protocol/load-session`

Calls `session/load`. Loads an mcode session into the webui without
switching the active webui session. Pass `createWebuiEntry: true` to
also append a webui sidebar entry for it.

**Request**
```json
{
  "sessionId": "mvs_…",
  "cwd": "C:\\…",
  "createWebuiEntry": false
}
```

**Response 200**
```json
{ "ok": true, "sessionId": "mvs_…", "webuiEntry": null }
```

When `createWebuiEntry: true` and no webui session referenced the
`mcodeSessionId` yet, `webuiEntry` is the newly-created sidebar entry
(id, mcodeSessionId, title "Mcode session", createdAt, updatedAt).

### `POST /api/protocol/activate-session`

Calls `session/activate`. Switches the current CID to the named mcode
session; resets the local context so the next prompt starts on the new
session.

**Request** `{sessionId: "mvs_…"}`

**Response 200**
```json
{ "ok": true, "activeSessionId": "mvs_…", "data": <acp reply> }
```

### `GET /api/protocol/list-sessions?cwd=…`

Calls `session/list`. Lists every mcode session; if `cwd` is supplied,
the response is filtered to that workspace (path-normalised: case-
insensitive, trailing slash-insensitive, `\` and `/` interchangeable).

**Response 200**
```json
{ "ok": true, "sessions": [<mcode session rows>], "cwd": "C:\\…" }
```

### `GET /api/protocol/capabilities`

Returns the engine's `agentInfo` (from the `initialize` reply) plus the
capability table webui knows about (`MCODE_ACP_CAPABILITIES` in
`server/lib/mcode-rpc.js`). Used by the webui to decide which UI
controls to enable.

**Response 200**
```json
{
  "ok": true,
  "mcodeVersion": "0.5.2",
  "mcodeName": "mcode",
  "mcodeTitle": "mcode",
  "capabilities": {
    "set_mode": true,
    "set_config_option": true,
    "cancel": true,
    "activate": true,
    "fork": true,
    "resume": true,
    "delete": false,
    "load": true,
    "close": true,
    "list": true,
    "new": true,
    "prompt": true
  },
  "notes": {
    "set_mode": "Takes a modeId from the session's availableModes.",
    "set_config_option": "With configId 'permissionMode' this changes the mode mid-session.",
    "cancel": "Sent as a notification; /api/stop falls back to SIGKILL only when the client cannot be reached.",
    "activate": "One acp client tracks a single active session.",
    "fork": "Implemented by the engine; no webui route exposes it yet."
  }
}
```

`mcodeVersion` is `"unknown"` before a client has attached (no `initialize`
reply yet); the endpoint does not invent a version.

---

## Authorize decisions

The server-side authorize gate (`server/lib/authorize.js`) asks the
user to approve destructive actions (`session.delete`,
`sessions.cleanup-orphans`, `session.cleanup-all`, `session.export`,
`session.search`, `token.reset`, `slash.clear`, `startup.cleanup`).
The pending requests are exposed through this single endpoint — the
client UI shows the modal, the user clicks Allow / Deny, and the
decision is delivered back here. See [CAPABILITIES.md §12](CAPABILITIES.md)
for the action whitelist and the default 5-minute timeout.

### `POST /api/auth/decision`

**Request**
```json
{ "requestId": "auth-…", "approve": true }
```

**Response 200** (resolved) `{ok: true, approved: true, decidedBy: "user", decidedAt: 1730000000000}`

**Errors**
- 400 missing/empty `requestId`
- 404 `{ok: false, error: "no pending request with that id"}`
  (already decided, expired, or never existed)
- 410 `{ok: false, error: "already decided"}` is **not** returned —
  the route treats "already decided" and "no such request" identically
  as 404, by design: replaying a decision must not leak whether the
  request originally existed.

---

## Debug (gated)

### `POST /api/debug/inject`

Inject a fake event into the event stream for a CID. Used for testing
the UI without a real mcode subprocess.

**Request**
```json
{
  "goal":    { "text": "…", "done": false },
  "todo":    [{ "id": "1", "text": "…", "done": false }],
  "ask":     { "questions": [{ "header": "…", "question": "…", "options": ["…"] }] },
  "plan":    { "title": "…", "summary": "…", "options": ["…"] },
  "enterPlanMode": { "active": true },
  "appendChat": ["› a line to append", "● and a reply"]
}
```

`appendChat` must be an **array of chat lines**. A bare string is silently
ignored — the response still says `ok: true` with an empty `applied`, so
check `applied.appendedChatLines`. The other fields are merged or replaced
according to their own shape (`todo` is replaced wholesale, `goal` /
`ask` / `plan` / `enterPlanMode` are shallow-merged into the existing
object).

**Response 200** `{"ok": true, "applied": {…}, "cid": "…"}` — `applied` names
each field that was actually consumed, which is how you tell a no-op from a
write.

**Gating**: this endpoint only works if `DEBUG_INJECT=1` is set in the
server's environment. The server logs a warning every time it's
called. Production deployments should leave the env unset.

### `GET /api/debug/state`

Returns the full per-cid state including internal flags. Same
`DEBUG_INJECT` gating.

---

## Static

### `GET /`

Returns `webapp/out/index.html` (the Next static export's entry point).
Served by `serveIndex`. There is no `public/` fallback for the main UI
— the legacy `/app/*.js`, `/styles/*.css`, `/lib/marked.min.js`, and
`/brand-logo.png` paths are unreachable (they were removed along with
the vanilla-JS SPA; see `test/lib/static.test.js`).

### `GET /<file>`

Returns the file from `webapp/out/` only. Served by `serveStatic`. The
Trajectory Studio under `public/trajectory/` is mounted at `/trajectory/`
by its own handler (separate backend, CSP, token posture) — it is not
part of this static root. Cache headers:

- HTML: `no-cache` (revalidate every time)
- `_next/static/*` (content-hashed): `public, max-age=31536000, immutable`
- everything else: `public, max-age=3600`

There is no manual `?v=N` cache-bust any more — every chunk URL under
`_next/static/<hash>/…` is content-addressed and self-cancelling on rebuild.

---

## Error responses

All errors follow one of these shapes:

```json
{ "ok": false, "error": "human-readable message" }
```

```json
{ "ok": false, "code": "unsupported", "error": "session/set_mode not implemented by this engine" }
```

```json
{ "ok": false, "error": "LAN 访问已关闭。在本机打开设置开启。" }
```

The HTTP status is appropriate to the cause (400 / 401 / 403 / 404 / 409 / 413 / 500 / 501).
