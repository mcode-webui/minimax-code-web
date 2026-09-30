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

## State & SSE

### `GET /api/state`

Returns the current `state` object for this CID. See
[ARCHITECTURE.md §4](ARCHITECTURE.md) for the full shape.

**Response 200**
```json
{ "ok": true, "version": "0.5.2", "running": {"active": false}, … }
```

### `GET /api/events`

Server-Sent Events stream for this CID. The connection stays open
indefinitely. Events are listed in
[ARCHITECTURE.md §5](ARCHITECTURE.md).

**Response 200** (`Content-Type: text/event-stream`)
```
event: state
data: {"version":"0.5.2","running":{"active":false},…}

event: delta
data: {"text":"hello","isPartial":true}

event: exec
data: {"status":"ok","durationMs":12345}
```

The connection is held open until the client closes it (`EventSource.close()`)
or the server shuts down. No automatic reconnect from the server side;
the webui handles reconnection with exponential backoff.

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
and streams the result via SSE.

**Request**
```json
{
  "content": "refactor the workspace picker to use a tree",
  "attachments": ["@/home/you/.mcode-webui/uploads/1790228071891-8d8ec6.txt"],
  "isAskAnswer": false
}
```

- `content` (string) — the user message. Required **unless** `attachments`
  is non-empty: the composer deliberately enables Send for an attachment with
  no text, so a bare file is a valid turn.
- `attachments` (string[], optional) — uploaded files, as returned by
  `POST /api/upload`. A single leading `@` is accepted and stripped (the
  desktop's mention convention, and what the composer sends).
  Each path must resolve **inside `UPLOAD_DIR` and exist as a file**;
  anything else is rejected — the reference text is fed to the model as if the
  user had typed it, so an unchecked path would let a caller name any file on
  the host. Duplicates are collapsed and the list is capped at 16 per turn
  (`MAX_ATTACHMENTS_PER_TURN`). Rejections and drops are counted and pushed to
  the alert channel rather than silently ignored.
- `isAskAnswer` (bool, optional) — when `true`, the content is the answer to
  an active `ask_user` question, and the server does not add a `›` line to the
  transcript. Set by the ask modal automatically.

**How attachments reach the engine.** As ACP `resource_link` content blocks —
`[{type:"text",…}, {type:"resource_link", name, uri}, …]` — because the
engine's own `promptToText` (`packages/tui/src/acp/agent.ts`) accepts exactly
`text` and `resource_link` and rejects anything else with "Prompt content type
X is not supported in ACP P0". The desktop's own `resource` / `image` blocks
are *not* valid here. On the `mcode exec` transport, which has no block
channel, the same wording the engine uses is written to stdin instead.

**Response 200** `{ok: true}` immediately. The actual response is streamed
via `/api/events`.

**Run watchdog.** A run that stays silent for `MCODE_WEBUI_PROMPT_IDLE_TIMEOUT`
seconds (default 120) is aborted — every acp/exec stream event resets the
timer, so a run that keeps emitting never times out. The value is in
**seconds** and is exported as `PROMPT_IDLE_TIMEOUT_MS` (`server/lib/config.js`);
non-positive or non-finite values fall back to 120 s. This is a silence budget,
not a total-turn ceiling.

**Errors**
- 400 when `content` is empty **and** no attachment survives validation
- 409 when a turn is already in flight — `reason: "cid-busy"` (this client is
  busy), `"session-busy"` (another client is running this conversation), or
  `"at-capacity"` (the server is at `MAX_CONCURRENT`, which `/api/health`
  reports as `maxConcurrent`)

### `POST /api/stop`

Cancel the current run. Tries `session/cancel` via acp (the cancel
notification is delivered to the active child subprocess; the route
server falls back to SIGTERM on the subprocess if the notification could
not be delivered, then SIGKILL after 2s).

**Request** `{}`

**Response 200**
```json
{ "ok": true, "wasRunning": true, "cancelled": true, "hardKilled": false, "note": "gentle cancel" }
```

- `wasRunning` — whether an active child backed this cid.
- `cancelled` — the `session/cancel` notification was delivered. Only
  meaningful when `wasRunning` and the turn is on the **ACP** transport; the
  exec transport has no engine session to notify, so it answers
  `cancelled:false` with the hard-kill note.
- `hardKilled` — the SIGTERM/SIGKILL cascade fired.
- `note` — `"gentle cancel"` or `"hard kill (session/cancel could not be
  delivered)"`. This is the field to read; there is no `killEndpoint`,
  `warning` or `code` in this response.

An earlier revision of this document described `{warning, code,
killEndpoint}` here. Those fields are not in the response; the hard-kill
cascade is this same route, so a client that needs it re-issues `POST
/api/stop`.

### `POST /api/cmd`

Run one of the webui **button commands**. The accepted set is declared in
`server/lib/interaction/command-registry.js#CMD_BUTTON_COMMANDS`:
`new`, `clear`, `status`, `sessions`, `review`, `help`, `usage`, `stop`.
The command must be the bare `/name` form — these handlers take no
argument, and the dispatcher matches the whole text after the slash.

This endpoint does **not** forward to mcode. Engine commands
(`/compact` and friends) and the typed webui commands (`/goal <text>`,
`/goal-done`, `/goal-blocked`) belong to `POST /api/send`, whose
`handleLocalSlash` consumes the webui ones and forwards everything else
to the engine unchanged.

The response is written after the dispatch, so it reports the command's
outcome, not the receipt.

**Request**
```json
{ "cmd": "/clear" }
```

**Response 200** — the dispatcher claimed the command and ran it:
```json
{ "ok": true, "cmd": "/clear" }
```

**Response 400** — no command claimed it; nothing was mutated:
```json
{
  "ok": false,
  "error": "/api/cmd 不处理该命令：/compact。未知命令。可用的命令：/new、/clear、/status、/sessions、/review、/help、/usage、/stop；引擎命令（如 /compact）请作为普通消息发送。",
  "reason": "unknown_command",
  "cmd": "/compact",
  "knownCommands": ["new", "clear", "status", "sessions", "review", "help", "usage", "stop"],
  "suggestion": "未知命令。可用的命令：/new、/clear、/status、/sessions、/review、/help、/usage、/stop；引擎命令（如 /compact）请作为普通消息发送。"
}
```

- `error` — the one-line string the webui composer shows in its error
  banner. It is a user-facing product string and is Chinese, like the
  rest of the chat surface; do not parse it.
- `reason` — the machine-readable discriminator. `unknown_command` is
  the only reason this route produces itself. A **declined**
  `authorize("slash.clear")` gate does **not** fail the request:
  `handleCmdCommand` appends `● 已取消 /<cmd> (授权未通过: <decidedBy>)`
  to the transcript and returns `handled:true`, so the answer is
  `200 {ok:true, cmd}` with nothing mutated. A **failure** in the gate,
  the write-ahead audit (fail-closed by design), or a command body
  answers `5xx`; the shared request gates can reject before the handler
  runs with `403` (untrusted `Origin`, bad token) or `429` (rate limit).
- `knownCommands` — the accepted set, so a client never has to keep its
  own copy of the list.
- `suggestion` — for a `/api/send` command such as `/goal`, the body
  says so explicitly ("send it as a normal message") instead of calling
  it unknown.

An earlier revision of this endpoint documented "the server sends the
command to mcode"; that was never true of the route, and the response
was written before the dispatch, so an unclaimed command answered
`200 {ok:true}` and the input was lost.

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

**Response 200** `{ok: true, session: <the full session record>}`

The whole record comes back, not just an id — the client renders the new row
from it without a follow-up fetch. `id`, `title`, `workspace`, `mcodeSessionId`,
`chat`, `createdAt`, `updatedAt`, and (once set) `titleCustom`.

### `POST /api/sessions/switch`

Switch to an existing session. Loads its chat history and (if linked)
re-attaches to the mcode session.

**Request**
```json
{ "id": "uuid" }
```

`id` accepts a webui uuid or an `mvs_…` engine id.

**Response 200**
```json
{
  "ok": true,
  "session": { "id": "uuid", "mcodeSessionId": "mvs_…", "title": "…", "chat": ["› …", "● …"] }
}
```

The chat is returned here because switching is a navigation the client must
render immediately, before the next SSE push arrives.

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

Delete mcode sessions that no webui session references. There is **no request
body and no `scope` parameter** — the route only ever deletes orphans, and
never the currently-active session.

`?dryRun=true` previews without side effects (and without the authorize gate,
since nothing is touched). The real path is gated by
`authorize("sessions.cleanup-orphans")` and audited
(`sessions.cleanup-orphans.intent` before any delete, `.done` after).

**Request** — no body. Optional query: `?dryRun=true`

**Response 200** (preview)
```json
{ "ok": true, "dryRun": true, "count": 18, "ids": ["mvs_5103ca…", "mvs_88c796…"] }
```

**Response 200** (executed)
```json
{
  "ok": true,
  "dryRun": false,
  "deleted": 18,
  "failed": 0,
  "deletedIds": ["mvs_5103ca…"],
  "failedItems": [{ "id": "mvs_…", "status": 500, "reason": "…" }],
  "decidedBy": "user",
  "decidedAt": 1730000000000
}
```

**Response 200** (nothing to do) `{ok: true, dryRun: false, deleted: 0, ids: []}`
— returned before the authorize gate, since there is nothing to approve.

**Response 403** `{ok: false, error: "authorize declined", decidedBy, decidedAt}`

If the `.done` audit append fails the route answers 5xx even though some
deletes already ran: the operator must see the audit gap rather than a silent
200.

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

**Response 200** — `format=md` → `text/markdown; charset=utf-8` body with the
chat rendered as Markdown.

`format=json` → `application/json`:
```json
{
  "ok": true,
  "session": { "id": "uuid", "title": "…", "workspace": "C:\\…", "createdAt": 0, "updatedAt": 0, "mcodeSessionId": "mvs_…" },
  "messages": [{ "role": "user", "content": "…" }],
  "_meta": {
    "source": "merged",
    "exportedAt": 1730000000000,
    "messageCount": 2,
    "mcode_unavailable": false
  }
}
```

The conversation is under **`messages`**, not `chat` — it is a merged,
role-tagged list (webui transcript + engine rows), which is a different shape
from the `chat` string array kept in the session store. `_meta.mcode_unavailable`
reports whether the engine side could be read; when it is `true`,
`mcode_unavailable_reason` says why.

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

**Response 200**
```json
{
  "ok": true,
  "workspace": { "dir": "C:\\path\\to\\project", "branch": null, "tree": null },
  "tuiCwd": "/home/you/projects/foo",
  "defaultWorkspace": "C:\\Users\\you\\.mcode-webui\\webui"
}
```

The current workspace is nested under `workspace`, not flattened to the top
level. `branch` and `tree` are `null` — the server does not shell out to git,
and a previous revision of this document claimed `"main"` / `"clean"`, which
were never measured.

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

### `GET /api/fs/read-file?path=<file>`

Read the contents of a single regular file as text. Drives the right-panel
file preview (slice 02 — `webapp/components/file-preview.tsx`). Same
containment boundary as `/api/fs/read`; the gate runs first, so an
out-of-root path is rejected before the file is even stat'd.

Files over **512 KiB** are rejected with `413` rather than silently
truncated — the caller (the webapp preview) renders a "too large" state
and points the user at a real editor. The body still carries the file's
detected `mime` / `language` so the UI can route it to the right
renderer without a second round-trip.

Binary detection scans the first 4 KiB for a NUL byte. A binary file is
returned with `ok:false, error:"binary file not supported"` and a 415
status; the webapp renders an "无法预览" placeholder. The error path
still carries `mime` / `language` so the UI can hint at why (e.g.
"image, use the raw endpoint" for `.png`).

**Response 200**
```json
{
  "ok": true,
  "path": "C:\\Users\\you\\README.md",
  "size": 2400,
  "mtime": 1790609123912.887,
  "mime": "text/markdown; charset=utf-8",
  "language": "markdown",
  "binary": false,
  "encoding": "utf-8",
  "content": "# Title\n\n…"
}
```

`encoding` is `"utf-8"` on success (with the BOM stripped); `language` is
one of `markdown` / `typescript` / `javascript` / `json` / `yaml` / `css`
/ `html` / `python` / `go` / `rust` / `bash` / `sql` / `dockerfile` /
`plain` (informational — the renderer is allowed to ignore it). `mtime`
is the file's `stat().mtimeMs` at read time (slice 27): the preview
editor records it together with `size` as the conflict-detection baseline
and sends both back on save — `POST /api/fs/write` answers `409` when
the disk has moved on in the meantime.

**Errors** — 400 missing `path`; 403 out-of-root; 403 `{code:"credential"}`
on a credential-shaped basename (unless `?confirm=1`); 413 over the 512 KiB
cap; 415 binary file or non-regular file (directory / device / socket);
500 stat failure (file vanished mid-request).

**Credential predicate is name-based — hardlink aliasing is NOT covered.**
`classifyCredential` (`server/lib/credential-file.js`, mirrored verbatim in
`webapp/lib/credential-file.ts`) compares the **basename** of the request
path against the credential shape table. The defence therefore covers
symlinks (resolved by `realpathSync` before the read) but not hardlinks —
two names that share an inode (`config.txt → .env`) are indistinguishable
by basename, since the kernel does not expose the "primary" name from
the inode alone. Operators concerned about hardlink aliasing must keep
the workspace tree uncluttered. The same predicate is reused in streaming
form by `/api/fs/raw` and is re-applied by `/api/fs/search` (where
matches are flagged `credential: true` but never content-stripped).

### `GET /api/fs/raw?path=<file>`

Stream raw bytes for a file. Used by `<img>` and download affordances in
the preview (slice 02). Same containment boundary as `/api/fs/read`;
**20 MiB** hard cap (matches the pr-22 reference).

`Content-Type` is mapped from the extension; unknown extensions fall
through to `application/octet-stream`. `Cache-Control: no-store` — local
files have no immutable hash, the cache must not lie about freshness.

**Response 200** — binary stream. Examples:

| extension | Content-Type |
|---|---|
| `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.ico` / `.pdf` | as listed |
| `.svg` | `image/svg+xml` |
| `.html` / `.htm` / `.css` / `.js` / `.mjs` / `.json` / `.md` / `.txt` | `text/...; charset=utf-8` |
| `.woff2` | `font/woff2` |
| (anything else) | `application/octet-stream` |

**Errors** — 400 missing `path`; 403 out-of-root; 404 not found; 400 not
a regular file; 413 over the 20 MiB cap.

---

### `POST /api/fs/write` — save the preview editor's buffer (slice 27)

The preview toolbar's save button lands here. This is the ONLY write
surface the file preview opens, and every boundary below is enforced
server-side — the webapp is a presenter over the structured answer.

**Request**
```json
{
  "path": "C:\\Users\\you\\README.md",
  "content": "# Title\n\nedited in the preview panel\n",
  "expectedMtime": 1790609123912.887,
  "expectedSize": 2400,
  "confirm": false
}
```

| Field | Required | Meaning |
|---|---|---|
| `path` | yes | absolute path (or `~/...`); through the SAME `safePath` → `assertWorkspacePath` gate as every other `/api/fs/*` route — realpath-resolved, symlink-aware, out-of-root = 403 |
| `content` | yes | the full file body as a UTF-8 string; non-string = 400 `invalid-content` |
| `expectedMtime` | no | the `mtime` `GET /api/fs/read-file` returned when the file was opened |
| `expectedSize` | no | the `size` from the same read |
| `confirm` | no | `true` = the user passed the credential confirmation card (see below) |

**Conflict detection.** When either baseline field is present and no
longer matches the live stat, the route answers `409` and writes
NOTHING — an external edit must surface as a conflict the user resolves,
never a silent overwrite. A body with NO baseline fields is the
explicit-overwrite shape; the panel only sends it after the user
answered the conflict card ("覆盖磁盘版本").

**Credential guard (slice 16 alignment).** Credential-shaped basenames
(`.env` / `*.pem` / `id_rsa` / `credentials*` / … — the same
`classifyCredential` predicate the read routes use) default-refuse with
`403 {code:"credential", credentialReason}` and the file is untouched.
`confirm:true` releases the write AND emits the same `credential.override`
stderr audit line as the read override, with `endpoint:"write"`. Rationale:
the server broadcasts a LAN URL, and a web-editable `.env` makes every
LAN peer an author of the local machine's config.

**Controlled write.** The handler is a bare `writeFileSync(path, content,
'utf8')` on the gated path — no shell, no exec, no command interpolation
anywhere on this path. The editor edits EXISTING files only; there is no
create-through-the-web path.

**Response 200** — the fresh baseline the next save should conflict-check
against:
```json
{
  "ok": true,
  "path": "C:\\Users\\you\\README.md",
  "size": 40,
  "mtime": 1790609400000.5
}
```

`path` is the **realpath-normalised absolute form** (the shared gate
resolves symlinks before anything else — the same slice-16 form every
`/api/fs/*` route returns; on macOS, a write to `/var/folders/…`
answers `/private/var/folders/…`).

**Errors** — 400 `missing-path` / `missing-content` / `invalid-content` /
`not-a-regular-file`; 403 out-of-root (shared gate; a missing path
normally fails containment here with the realpath error — the read route
documents the same behaviour); 403 `credential` (unconfirmed credential
shape); 404 `not-found` (file vanished between gate and stat — TOCTOU
guard); 409 `conflict` (`{diskMtime, diskSize}` on the body); 413
`too-large` (content over `WRITE_MAX_BYTES` = the read's 512 KiB — you
cannot save what you could never have loaded); 413 `BODY_TOO_LARGE`
(JSON body over the shared 1 MiB reader cap); 500 `write-failed` (the
`writeFileSync` itself threw — e.g. `EACCES`; the disk file is untouched).

**Credential predicate is name-based — hardlink aliasing is NOT covered**,
exactly as documented under `GET /api/fs/read-file`.

---

### `POST /api/fs/open-default` — open with OS default app (slice 14)

Hands `path` to the platform's default opener (`open` / `xdg-open` /
`cmd` / `Start-Process`). Containment gate is the same `assertWorkspacePath`
+ per-node realpath check used by `/api/fs/read`; the route's job is to
JSON-decode the body and map the helper's structured codes to HTTP status.

**Request**
```json
{ "path": "/home/you/repo/README.md" }
```

**Response 200** `{ ok: true }`

**Errors** (sourced from `routes/fs.js#codeToStatus`):
- `400 {code:"missing-path"}` — no `path` in body
- `403 {code:"out-of-bounds"}` — containment rejected
- `400 {code:"not-a-regular-file"}` — directory / non-existent / symlink escape
- `503 {code:"no-opener"}` — host has no GUI binary on `PATH`; the UI
  disables the button on this answer so a click never silently no-ops
- `502 {code:"spawn-failed"}` — binary ENOENTed between probe and exec

### `POST /api/fs/reveal` — reveal in file manager (slice 14)

Same wire model as `/api/fs/open-default`; macOS / Windows select the file's
row, Linux opens the parent directory (no portable "select" command exists
under freedesktop).

**Request**
```json
{ "path": "/home/you/repo/README.md" }
```

**Response 200** `{ ok: true }`

**Errors** — identical code → status map to `open-default`.

---

## Git

The git endpoints drive the right-panel Git panel (slice 03 —
`webapp/components/panels.tsx#GitPanel`) and the `/review` slash
command. They share the same containment boundary as the fs endpoints
(`/api/fs/*`): a candidate `dir` is `resolve()`d, symlink-resolved
(`realpath`), and must land within an allowed workspace root (default
home + default workspace + tmp; `MCODE_WEBUI_WORKSPACE_ROOTS` fully
replaces the set). Out-of-root directories are answered with a
`{ok:false, error:"…不在允许根内…"}` payload — the panel surfaces
that as an empty state rather than as a red toast.

Security invariants (pinned by `test/routes/git.test.js`):

* `git` is invoked through `execFile` with `['-C', dir, ...args]` —
  no shell, no metacharacter surface.
* `gitCheckout` matches the branch name against `^[A-Za-z0-9._/-]+$`
  and additionally rejects names that start with `-` (a branch named
  `--upload-pack=…` would otherwise be re-interpreted as a `git
  checkout` option by the binary itself).
* `gitDiff` always passes the user-supplied file after a `--` token,
  so a filename like `--output=/etc/x` cannot be re-interpreted as a
  `git diff` option. The same input is rejected up front by an
  explicit `startsWith('-')` guard.

### `GET /api/fs/search?root=<dir>&q=<glob>[&depth=&maxNodes=&wallMs=&limit=&includeHidden=1]`

Bounded workspace-wide search by basename glob (slice 19a). The shipped
file-tree filter matches names only against already-expanded nodes, so
a `package.json` three directories deep shows nothing until the user
manually expands every intermediate directory. This endpoint walks the
workspace behind the same `assertWorkspacePath` gate the other
`/api/fs/*` routes use, with hard budgets so a hostile or pathological
request cannot pin the server.

The panel calls this endpoint when the user types into the filter
box and the in-memory tree has no match. Each call is a single
round-trip that returns every match under `root` in one response; the
panel "expands to the match" by walking the `ancestors` chain it gets
back.

**Query parameters** — `root` and `q` are required; every other
parameter is optional and bounded by an absolute upper limit (an
out-of-range value is clamped, not rejected):

| Param | Default | Max | Notes |
|---|---|---|---|
| `root` | — | — | absolute path or `~/...`. Goes through `assertWorkspacePath`; out-of-root = 403. Must point at a directory. |
| `q` | — | — | glob; `*` any run, `?` one char, case-insensitive, anchored. Empty = 400. |
| `depth` | 8 | 16 | max directory depth from `root`. Exceeded → `truncated: true, truncatedReason: "depth"`. |
| `maxNodes` | 5000 | 50000 | number of visited entries (files + dirs). Exceeded → `"nodes"`. |
| `wallMs` | 1500 | 5000 | wall-clock cap in ms. Exceeded → `"wallClock"`. |
| `limit` | 200 | 1000 | max matches returned. (Alias `maxMatches` also accepted.) Exceeded → `"matches"`. |
| `includeHidden` | 0 | — | `1` to include dotfile entries; default mirrors the file tree's hidden-by-default behaviour. |

The walker skips these directories by default (`node_modules` /
`.git` are non-overridable; the build/cache set can be opted back
into with the `includeDirs` option server-side):

| Skip reason | Default on? | Notes |
|---|---|---|
| `node_modules` | yes (non-overridable) | canonical search stall at every JS project |
| `.git` | yes (non-overridable) | privacy surface; never the user's intent |
| `dist` / `build` / `.next` / `.cache` / `.parcel-cache` / `.turbo` / `.nx` / `coverage` / `.svn` / `.hg` / `.idea` / `.vscode` | yes (overridable server-side) | build outputs & VCS metadata, each a known walker trap |
| huge dir (> 10 000 readdir entries) | yes | per-directory entry count, not bytes |
| credential-shaped names | flagged, never omitted | see "credential decision" below |

**Response 200**
```json
{
  "ok": true,
  "root": "/home/you/文档/demo002",
  "q": "package.json",
  "matches": [
    {
      "path": "/home/you/文档/demo002/codersday/package.json",
      "name": "package.json",
      "type": "file",
      "ancestors": ["codersday"],
      "credential": false
    }
  ],
  "scanned":  { "dirs": 12, "files": 47, "total": 59 },
  "skipped":  {
    "node_modules": 1,
    ".git": 0,
    "credential": 0,
    "huge": 0,
    "optional": { "dist": 0, "build": 0, ".next": 0 }
  },
  "truncated": false,
  "truncatedReason": null,
  "elapsedMs": 7,
  "budgets":   { "maxDepth": 8, "maxNodes": 5000, "wallMs": 1500, "maxMatches": 200, "includeHidden": false, "includeDirs": [] }
}
```

`ancestors` is the path components between `root` (exclusive)
and the match (exclusive); for a top-level match it is `[]` so
the client can use `path` directly. The walker NEVER returns
file contents — `matches[i]` has `path / name / type /
ancestors` plus the optional `credential` flag and nothing
else. No `size` sample, no `mtime` sample, no preview metadata.

**Truncation honesty.** A response with `truncated: true` is the
walker's explicit "I didn't finish" signal. The reasons are pinned:
`"depth" | "nodes" | "wallClock" | "matches"`. The UI shows
`searched N, skipped M, truncated by <reason>` so the user knows
the displayed list is partial.

**Credential decision — flagged, never omitted, never read.**
`classifyCredential` (the slice-16 predicate in
`lib/credential-file.js`) is the single source of truth. A
credential-shaped match is included with `credential: true`
plus a stable `credentialReason` (one of `dotenv` / `key-file` /
`ssh-key` / `credentials` / `ssh-meta`), AND `skipped.credential`
is incremented. The rationale:

  - The user has the right to know the file exists (mirrors
    `/api/fs/read`, which keeps credentials visible in the tree
    listing).
  - The path is the realpath form; a user-initiated click on the
    match lands on `/api/fs/read-file`, whose slice-16 gate
    refuses by default with the same `code: "credential"`
    answer the right panel already speaks.
  - Omitting the match would make a search for `q=*.env` (or
    `q=.env`) return zero rows — actively misleading because
    the workspace DOES contain those files.
  - The response never carries content (or size / mtime / any
    preview metadata), so the search cannot itself become a
    credential leak even when the user is looking for one.

**Errors** — 400 missing `root` / `q` / `root` is not a directory;
403 out-of-root (same message as the other `/api/fs/*` routes);
the gate runs first, so a malformed `root` is refused before the
walker runs.

### `GET /api/git/status?dir=<workspace>`

Workspace status for the panel header. `dir` is required.

`status --porcelain=v1 -b` gives a deterministic stream: one header
line (`## <branch>[...<upstream>] [ahead N, behind M]`) followed by
the per-file entries. The route parses both halves; a detached HEAD
or a branch with no upstream simply produces a `null` upstream /
zero ahead/behind without an error.

**Response 200**
```json
{
  "ok": true,
  "isRepo": true,
  "branch": "feat/git-panel",
  "upstream": "origin/feat/git-panel",
  "ahead": 0,
  "behind": 0,
  "files": [
    { "x": "M", "y": " ", "path": "README.md", "origPath": null, "staged": true },
    { "x": "?", "y": "?", "path": "untracked.txt", "origPath": null, "staged": false }
  ]
}
```

`x` / `y` are the raw porcelain status codes (see `git status --help`
§ "porcelain v1 format"); `staged` is `x !== ' ' && x !== '?'`
(includes `M`, `A`, `D`, `R`, `C` in the index position). Renames
carry `origPath` (the pre-rename path) alongside `path` (the new
path). `isRepo:false` answers a non-git directory without an error.

**Errors** — 400 missing `dir`; the body is `{ok:false, error}` and
the status stays `200` (the panel reads `ok` rather than the HTTP
code, so a non-git directory is a normal state).

### `GET /api/git/branches?dir=<workspace>`

Local branches plus a `current` marker. The panel renders this list
as the branch switcher — `gitCheckout` requires the picked name to
match the same set, so the switcher never has a choice it cannot
honour.

**Response 200**
```json
{
  "ok": true,
  "branches": [
    { "name": "feat/git-panel", "current": true },
    { "name": "main", "current": false }
  ]
}
```

**Errors** — 400 missing `dir`; `{ok:false, error}` on git failure.

### `GET /api/git/diff?dir=<workspace>&file=<path>`

Single-file diff against `HEAD`. Untracked files (`?` in porcelain)
fall back to `git diff --no-index -- /dev/null <file>`, which
produces a synthetic all-add diff so the panel can preview them too.
The fallback returns `{ok:true, diff}` (never an error) when the
input file exists; an `ok:false` is reserved for the gate rejection
or for a `git` invocation failure.

**Response 200**
```json
{ "ok": true, "diff": "diff --git a/README.md b/README.md\n…" }
```

**Errors** — 400 missing `dir`/`file`; `{ok:false, error}` for
containment or invalid path. The HTTP status stays `200` for
soft-fail paths; the panel reads `ok`.

### `POST /api/git/checkout`

Switch to a local branch. **Destructive** — the panel gates the
button behind a confirmation prompt before sending. Server-side
defence in depth: the branch name is matched against
`^[A-Za-z0-9._/-]+$` and rejected if it starts with `-`, so a
forged client cannot smuggle an option through.

**Request**
```json
{ "dir": "C:\\Users\\you\\projects\\foo", "branch": "feat/git-panel" }
```

**Response 200** `{ok:true}` on success; `{ok:false, error}` on
gate / allow-list rejection or `git` failure. The HTTP status
stays `200`; the panel reads `ok`.

**Errors** — 400 missing `dir`/`branch`, invalid JSON;
`{ok:false, error:"非法分支名"}` on allow-list rejection;
`{ok:false, error}` on `git` failure.

---

## Plugins

Plugin management (ticket 60, phase 1), served by
`server/routes/plugins.js`. Every handler reaches the
`local-runtime-v2` plugin system through the catalogue host, which
starts lazily on the first plugin call; the routes hold no plugin
state of their own. The gate chain (CORS → origin/CSRF → LAN → token →
rate limit → read-only) is inherited from `app.js` exactly as for
`/api/git/*` — there is no second authentication path here. The
surface that calls these endpoints is `plugins-surface.tsx`, through
`webapp/lib/api.ts`.

Two answer conventions cover the whole group:

- A **runtime** failure is HTTP 200 with `{ok:false, error, code}`.
  The panel branches on `code`; a non-2xx status would misreport an
  expected state as a transport fault. When the catalogue host cannot
  boot, every endpoint answers `{ok:false, error:"runtime unavailable",
  code:"RUNTIME_UNAVAILABLE"}`.
- A **rejected request** is an HTTP error: 400 `{ok:false,
  code:"invalidBody"}` for a missing or malformed parameter, 400 with
  the code intact for the three facade validation codes
  (`INVALID_PLUGIN_SOURCE`, `PLUGIN_LIMIT_INVALID`,
  `PLUGIN_CURSOR_INVALID`), 403 in read-only mode for every POST (gate
  5 — the correct answer, not a bug), 413 for a body above 1 MiB.

`source` names the plugin origin and is numeric on the wire: `1` =
official (cloud registry), `2` = local (packages on this machine). It
is **required** on `GET /api/plugins/marketplace`, because the runtime
reads a missing source as "official" and a silent default would aim
every request at a registry the local edition cannot reach.

In **responses** the numeric `source` is passed through as the runtime
produced it, and the route additionally stamps a protocol-free
`sourceKind` string — `"official"` or `"local"` — on the page, on every
plugin row, and on every mutation answer. The webapp branches on
`sourceKind`, which is how it stays free of an `@mavis/protocol`
dependency (`@mavis/webui` does not have one). An element whose
`source` is neither 1 nor 2 gets `sourceKind:"unknown"`.

Phase 1 covers the plugins domain only. `skills`, `mcp`, `apps` and
`agents` have no endpoints yet; the other four tabs of the panel
render a staged placeholder that says their management surface opens
in a later phase. The state of the surface is recorded in
[docs/webui.md](../../../docs/webui.md).

| func_name | Endpoint | Panel use |
|---|---|---|
| `plugins.list.installed` | `GET /api/plugins/installed` | Installed list |
| `plugins.list.marketplace` | `GET /api/plugins/marketplace` | Marketplace, one source per call |
| `plugins.list.enabled` | `GET /api/plugins/enabled` | The plugins the current turn can use |
| `plugins.refresh.all` | `POST /api/plugins/refresh` | Reconcile button |
| `plugins.enable.by_name` | `POST /api/plugins/enable` | Card switch, on |
| `plugins.disable.by_name` | `POST /api/plugins/disable` | Card switch, off |
| `plugins.install.by_name` | `POST /api/plugins/install` | Official install |
| `plugins.uninstall.by_name` | `POST /api/plugins/uninstall` | Delete, behind a confirmation |
| `plugins.import.preview_url` | `POST /api/plugins/import/preview` | Import dialog, dry run |
| `plugins.import.from_url` | `POST /api/plugins/import` | Import dialog, commit |

**What is real and what is a placeholder.** The installed list, the
local marketplace (`source=2`) and both GitHub import endpoints are
**real data** — the import path fetches a public repository directly
and never touches the cloud registry. The official marketplace
(`source=1`) and the official install / enable / disable / uninstall
actions are the **only** honest placeholders of this phase: the cloud
base URL does not resolve in the local edition, so the official listing
answers `{ok:false}` and the panel renders the
`plugins.market.official.notLocal.*` copy rather than an error toast.
The four non-plugin tabs render a staged placeholder of their own
(`plugins.area.<domain>.pending.*`) that says the management surface
opens in a later phase.

### `GET /api/plugins/installed?keyword=&limit=&cursor=`

**func_name** `plugins.list.installed`. Installed plugins, official and
local segments merged, one page. `keyword` filters by name; `limit`
defaults to 50 and is capped at 200; `cursor` is the opaque forward
cursor from `nextCursor`.

**Response 200**
```json
{
  "ok": true,
  "plugins": [
    {
      "name": "acme-notes",
      "version": "1.2.0",
      "displayName": "Acme Notes",
      "description": "…",
      "author": "acme",
      "iconUrl": "https://…/icon.png",
      "source": 2,
      "sourceKind": "local",
      "enabled": true,
      "capabilities": { "appCount": 0, "mcpServerCount": 1, "skillCount": 3, "hookCount": 0 }
    }
  ],
  "hasMore": false
}
```

The empty state is `{ok:true, plugins:[], hasMore:false}` — nothing
installed is an answer, not an error. `hasMore:true` carries
`nextCursor`. The panel shows skeleton rows while this is in flight.

**Errors** — 400 on a malformed parameter: a non-integer `limit` or a
`category` that is not an integer answers `code:"invalidBody"`, and a
cursor issued for a different `keyword` answers 400 with
`code:"PLUGIN_CURSOR_INVALID"` (the panel drops the cursor and restarts
the list). Runtime failures answer 200 with their own `code`. Note that
the webapp helper turns any non-2xx into a thrown error carrying the
server's `error` text, which is why the panel resets the cursor when the
filter changes rather than on the failure itself.

### `GET /api/plugins/marketplace?source=&keyword=&limit=&cursor=&category=&skillLimit=&skillCursor=`

**func_name** `plugins.list.marketplace`. `source` is required (§Plugins
above). `category` is a numeric category id (0 other … 10 education);
`skillLimit` / `skillCursor` page the standalone-skill segment.

**Response 200**
```json
{
  "ok": true,
  "source": 2,
  "sourceKind": "local",
  "plugins": [
    {
      "name": "acme-notes",
      "displayName": "Acme Notes",
      "description": "…",
      "installExists": false,
      "enabled": false,
      "category": 7,
      "capabilities": { "appCount": 0, "mcpServerCount": 1, "skillCount": 3 },
      "sourceKind": "local"
    }
  ],
  "hasMore": false,
  "pluginTotal": 1,
  "marketplaceSkills": [
    { "id": 41, "name": "weekly-digest", "displayName": "Weekly digest", "added": true }
  ],
  "skillHasMore": false
}
```

A marketplace summary carries no `source` of its own — the page *is* one
source — so the route stamps `sourceKind` on every row from the
requested source. The empty state is `{ok:true, source, sourceKind,
plugins:[], hasMore:false}`. `marketplaceSkills` carries the standalone
skills the local branch projects alongside the plugin rows; it is
present for `source=2` and the panel decides whether to interleave the
two. The official branch may additionally answer
`cursorResetRequired:true`, meaning the registry rejected the cursor
and the caller restarts from the first page.

**Errors** — 400 when `source` is missing or not `1`/`2`, when `limit`
is not a positive integer, or when `category` is not an integer
(`code:"invalidBody"`); `source=1` answers `ok:false` in the local
edition (unreachable cloud base URL) and the panel renders the
not-local placeholder for it. `source=2` failures are ordinary errors
and surface as one.

### `GET /api/plugins/enabled`

**func_name** `plugins.list.enabled`. The plugins the current runtime
snapshot reports as enabled — narrower than the installed list, which
also carries disabled entries.

**Response 200**
```json
{ "ok": true, "plugins": [{ "name": "acme-notes", "displayName": "Acme Notes" }] }
```

The empty state is `{ok:true, plugins:[]}`.

**Errors** — 200 `{ok:false, error, code}` when the runtime is
unreachable; 400 is not possible (no parameters).

### `POST /api/plugins/refresh`

**func_name** `plugins.refresh.all`. Reconciles installed state against
both sources. No parameters; the request body is drained and ignored.

**Response 200** `{ok:true}` — the answer carries no data, so the caller
re-pulls `GET /api/plugins/installed` afterwards. The panel shows a
spinner on the refresh button while it runs.

**Errors** — 200 `{ok:false, error, code}` with the runtime's own code;
403 in read-only mode.

### `POST /api/plugins/enable`

Turn a plugin on. **func_name** `plugins.enable.by_name`.

### `POST /api/plugins/disable`

Turn a plugin off; the plugin's turn hooks deactivate, and a session
already running on it is not interrupted. **func_name**
`plugins.disable.by_name`.

### `POST /api/plugins/install`

Install a plugin. Only the official source installs in the local
edition — a local package answers `LOCAL_PLUGIN_INSTALL_UNSUPPORTED`
and the panel never renders the button. **func_name**
`plugins.install.by_name`.

### `POST /api/plugins/uninstall`

Uninstall a plugin. **Destructive** — the panel gates the button
behind a confirmation prompt, and uninstalling a target that is not
installed is idempotent rather than a failure. **func_name**
`plugins.uninstall.by_name`.

These four share one body and one answer shape.

**Request**
```json
{ "pluginName": "acme-notes", "source": 2 }
```

`source` is optional, and an omitted one is forwarded as-is — the
runtime reads a missing source as "official" one layer down, so a
caller that knows which side the plugin came from should pass it. A
`pluginName` that is missing or blank answers 400 `invalidBody`, as
does a `source` that is neither 1 nor 2. Uninstalling a target that is
not installed is **idempotent**, not a failure.

**Response 200**
```json
{ "ok": true, "source": 2, "sourceKind": "local", "installExists": true, "enabled": false }
```

`installExists` says whether the plugin is on disk; `enabled` is the
resulting state. The panel shows a row-level spinner for the duration
of the call.

**Errors** — `PLUGIN_NOT_FOUND`, `PLUGIN_AUTH_REQUIRED` and
`PLUGIN_AUTH_SYNC_TIMEOUT` as `code` on a 200 answer; 400 `invalidBody`
for a body the route will not read; 403 in read-only mode. The official
mutations are the placeholder half of this surface: `PLUGIN_AUTH_REQUIRED`
is the expected answer for them in the local edition, and the panel
stays silent rather than raising a toast.

### `POST /api/plugins/import/preview`

**func_name** `plugins.import.preview_url`. Resolves a GitHub URL and
reports what importing it would bring, without installing anything. It
fetches the public repository directly — no cloud account, no registry.

**Request**
```json
{ "url": "https://github.com/acme/mcode-plugin" }
```

**Response 200**
```json
{
  "ok": true,
  "source": { "repositoryUrl": "https://github.com/acme/mcode-plugin", "commitSha": "0f1e2d3" },
  "plugin": {
    "summary": { "name": "acme-notes", "displayName": "Acme Notes", "capabilities": { "appCount": 0, "mcpServerCount": 0, "skillCount": 2 } },
    "skillCount": 2,
    "mcpServerCount": 0,
    "hasStdioMcp": false
  },
  "diagnostics": [{ "code": "SKILL_NAME_COLLISION", "capability": "skill", "name": "weekly-digest" }],
  "packageSizeBytes": 18432,
  "canImport": true
}
```

`source` is the pinned coordinate to hand to the commit call;
`canImport:false` with populated `diagnostics` is a valid answer, and
the dialog shows them instead of an error. The panel shows a loading
state for the duration of the fetch.

**Errors** — 400 on a malformed body; 200 `{ok:false, error, code}` for
an invalid URL, a repository the public internet cannot reach,
`PLUGIN_NO_SUPPORTED_CAPABILITY`, or `PLUGIN_IMPORT_UNAVAILABLE`.

### `POST /api/plugins/import`

**func_name** `plugins.import.from_url`. Installs the plugin a preview
resolved; the answer carries the plugin summary, enabled.

**Request**
```json
{
  "source": {
    "repositoryUrl": "https://github.com/acme/mcode-plugin",
    "commitSha": "0f1e2d3",
    "subPath": "packages/notes"
  }
}
```

`subPath` is optional and selects a plugin inside a monorepo.

**Response 200**
```json
{ "ok": true, "plugin": { "name": "acme-notes", "displayName": "Acme Notes", "enabled": true, "capabilities": { "appCount": 0, "mcpServerCount": 0, "skillCount": 2 } } }
```

**Errors** — `PLUGIN_ALREADY_EXISTS` when the plugin is already
imported, `PLUGIN_IMPORT_INVALID` for a coordinate the runtime cannot
use, both on a 200 answer; 403 in read-only mode.

---

## Settings

### `GET /api/settings`

Returns the full settings snapshot. **This endpoint is exempt from
the LAN guard** — it's how a remote user toggles LAN back on after
locking themselves out. The same snapshot is also pushed via SSE on
state changes (see [ARCHITECTURE.md §5 SSE state push](./ARCHITECTURE.md#5-sse-state-push)).

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
  "resetToken": true,              // 🆕 v1.0.1 — generate new token + broadcast auth.token_rotated SSE
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

Returns the model catalogue from the **engine session's own config options** —
not a builtin list and not anything read out of the engine binary. `listModels`
is per-session, so there is nothing to report until a session exists.

**Response 200**
```json
{
  "ok": true,
  "current": "minimax_api/MiniMax-M3",
  "source": "acp-session-config",
  "models": [
    { "id": "minimax_api/MiniMax-M3", "name": "MiniMax-M3" }
  ],
  "groups": [
    {
      "id": "__engine",
      "label": "Engine session",
      "models": [
        { "id": "minimax_api/MiniMax-M3", "label": "MiniMax-M3", "provider": "minimax_api", "source": "engine" }
      ]
    }
  ]
}
```

- `models[]` entries are `{id, name, label, provider, source}` — `id`
  is the engine's config value, `name` and `label` its display name,
  `provider` the prefix split off `id`, `source` one of
  `engine` / `config` / `builtin`.
- `current` is the option's `currentValue`, or `null` when the session has
  not reported one. It is never backfilled from a guess: a previous version
  wrote the default model back into `cs.model` here, which is what put an
  invented name into the state a later prompt would use.

If the list is empty the response adds `reason: "no_session_config"`. The
`current` field is then `null`; nothing is written back.

When a v2 providers config is present (`/api/providers` PUT
target), each model carries `protocol` / `thinkingLevels` /
`modalities` from the config; each provider group carries
`auth: {hasKey, type}` (no `apiKey`, no `baseURL` — those exist
only on the `/api/providers` surface where the key is masked).

**Context-window fields (U6).** Minimax_api builtin entries whose
engine-materialised tree declares `contextWindowOptions` carry three
extra fields — `contextWindowOptions` (token counts, engine order),
`contextWindowOptionHints` (today only `{"1000000": "higher_usage"}`),
and `contextLimit` (the engine's current effective window, also the
highlight fallback). Models without options stay field-free. The
response top level adds `currentContextWindow`: the recorded
`cs.model.contextWindow`, falling back to the current model's
`contextLimit`, or `null`.

### `POST /api/set-model`

Change the model for the current CID. Persists into `cs.model` so the
composer reflects it immediately; with a live mcode session it also
calls `session/set_config_option {configId:'model'}`, routed through
the cid's active child. Without a session, the change is recorded
for the next one.

**Request**
```json
{ "model": "minimax_api/MiniMax-M3", "contextWindow": 1000000 }
```

- `model` (string, optional together with the other fields — at least
  one field must be present) — the model id.
- `thinking` (string, optional; `""` clears) — the recorded effort.
- `contextWindow` (number, optional; `null` clears) — U6. A safe
  positive integer, one of the model's `contextWindowOptions`; any
  other value is a `400 {"ok": false, "error": "invalid contextWindow"}`.
  **Recorded only, not engine-applied today**: the engine's ACP
  `set_config_option` has no config id or wire slot for a context
  choice, so the route validates → records `cs.model.contextWindow`
  → echoes the value back. The picker highlights it via
  `/api/models`' `currentContextWindow`. See `docs/webui.md`
  "Context window" for the verified engine-side boundary.

**Response 200** (engine accepted)
```json
{ "ok": true, "model": "minimax_api/MiniMax-M3", "contextWindow": 1000000, "mcodeSynced": true }
```

The response echoes each provided field (`model`, `thinking`,
`contextWindow`) alongside `mcodeSynced` / `thinkingSynced`.

Without an `mcodeSessionId` yet: `{ok: true, model: "...", mcodeSynced: false, warning: "no mcode session yet — recorded for the next one"}`.

`warning` distinguishes the same three cases as [POST
/api/permissions](#post-apipermissions) — `no_acp_session` when the live run
is on the exec transport (structural, applies to the next turn) versus
`no_client` when an ACP run is expected but has no registered client.

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
- The change is recorded in `cs.permissions` either way, which is what
  selects the transport and supplies the mode for the next prompt.

**Warnings** — `mcodeSynced: false` comes with a `warning` saying which case
it is, because the two are not the same problem:

- `no mcode session yet — applies to the next one` — no engine session has
  been created for this CID yet.
- `no_acp_session`: "this turn uses the exec transport, which has no live
  engine session to update — the change applies from the next turn". The
  engine transport is selected by permission mode (`runMcodeAcp` uses exec
  whenever the mode is not Full access) and the one-shot `mcode exec` CLI has
  no persistent session to address. This is structural, not an outage.
- `no_client` — an ACP turn is expected but no live client is registered.

**A missing or empty `mode` is not a 400.** The route reads
`(payload.mode || "full")`, so an absent mode resolves to Full access rather
than erroring. Send the mode explicitly; do not rely on a default.

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
    { "value": "default",          "label": "Ask" },
    { "value": "bypassPermissions","label": "Full access" },
    { "value": "auto",             "label": "Auto" },
    { "value": "off",              "label": "…" },
    { "value": "read",             "label": "Read" },
    { "value": "full",             "label": "…" }
  ]
}
```

`webui[]` is the curated four the UI offers. `mcode[]` is the engine's full
`PERMISSION_MODES` list — six values, including `off` and `full`, which the
`webui[]` projection does not surface. `mcodePermissionToWebui` supplies the
label; `off` and `full` have no webui alias, so their label is whatever that
map yields.

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

**Response 200**
```json
{ "ok": true, "deprecated": true, "note": "use /api/send for new flow" }
```

The route is a **legacy no-op**: it logs the call and answers without acting on
it. Answers go through `POST /api/send` with `{content, isAskAnswer: true}`.
`deprecated: true` is always present — a client that only checks `ok` will keep
calling an endpoint that does nothing.

### `GET /api/providers`

Return the merged v2 provider catalogue, with every `apiKey` masked
(`apiKeyMasked`) — the plaintext credential is never returned in any
response path. The response also names the file paths the server
actually read for each layer, so an operator can confirm which file
the live config came from.

Layered resolution: `MCODE_WEBUI_MODELS_CONFIG` env → cwd `models.json`
→ user-level `~/.mcode-webui/providers.json` (the PUT write target).
Same-id provider deep merge; models dedupe by id with the higher layer
winning.

**Response 200**
```json
{
  "ok": true,
  "version": 2,
  "providers": [
    {
      "id": "openai_compat",
      "label": "OpenAI Compat",
      "enabled": true,
      "protocol": "openai",
      "auth": {
        "type": "byok",
        "hasKey": true,
        "apiKeyMasked": "sk-a***yz",
        "baseURL": "https://api.openai.com"
      },
      "models": [
        {
          "id": "gpt-4o-mini",
          "label": "GPT-4o mini",
          "contextLimit": 128000,
          "thinkingLevels": ["low", "medium", "high"],
          "modalities": ["text", "image"]
        }
      ]
    }
  ],
  "sources": {
    "env": null,
    "cwd": "/srv/webui/models.json",
    "user": "/home/you/.mcode-webui/providers.json"
  },
  "userPath": "/home/you/.mcode-webui/providers.json"
}
```

- `auth.apiKeyMasked` is the only apiKey shape returned by any route
  in this surface. A test (and `scripts/check-docs-alignment.mjs`)
  pins the rule: the plaintext key MUST NEVER appear in any
  `/api/providers*` response, regardless of which layer held it.
- `sources.env` is `null` when `MCODE_WEBUI_MODELS_CONFIG` is unset;
  `sources.cwd` is omitted from the layer set in that case (the env
  override is the cwd file).

### `PUT /api/providers`

Validate-and-persist a v2 provider config to the user-level file
(`~/.mcode-webui/providers.json`, the file written by this handler).
The env / cwd layers are deployment-owned and never written here.

The handler atomically writes via rename (no half-written file on
disk), reloads the layer set on the next call, and broadcasts an
SSE `providers.updated` named event with the masked payload so
every connected client refreshes its catalogue without polling.
`/api/models` picks up the change on the next request — no restart
required.

**Request**
```json
{
  "version": 2,
  "providers": [
    {
      "id": "openai_compat",
      "label": "OpenAI Compat",
      "enabled": true,
      "protocol": "openai",
      "auth": { "type": "byok", "apiKey": "sk-realkey...", "baseURL": "https://api.openai.com" },
      "models": [
        { "id": "gpt-4o-mini", "label": "GPT-4o mini", "contextLimit": 128000 }
      ]
    }
  ]
}
```

**Response 200**
```json
{
  "ok": true,
  "providers": [ /* masked view, same shape as GET */ ],
  "path": "/home/you/.mcode-webui/providers.json"
}
```

- `400 BAD_BODY` — invalid provider shape, unknown protocol, or
  validation failure (each error carries a human-readable `error`
  string with the offending field).
- `500 WRITE_FAILED` — disk I/O failure (the in-memory state did
  not change; the operator should retry).

### `POST /api/providers/test`

Run a per-protocol minimal connectivity probe. Local key-format
validation happens BEFORE any network call — a malformed key gets
`400 INVALID_KEY` with no fetch. A successful probe returns
`{ok:true, latencyMs, detail}`; a network failure returns
`502 PROBE_FAILED` with the upstream status code (no response body
— upstream error messages can echo the credential in a misconfigured
proxy).

**Request**
```json
{
  "protocol": "openai",
  "auth": { "type": "byok", "apiKey": "sk-realkey...", "baseURL": "https://api.openai.com" }
}
```

**Response 200** (probe succeeded)
```json
{ "ok": true, "protocol": "openai", "code": "OK", "latencyMs": 187, "detail": "HTTP 200" }
```

**Response 400** (malformed key — no network call)
```json
{ "ok": false, "protocol": "openai", "code": "INVALID_KEY", "error": "auth.apiKey is too short (< 8 chars)" }
```

**Response 502** (upstream rejected the request)
```json
{ "ok": false, "protocol": "openai", "code": "PROBE_FAILED", "error": "HTTP 401", "latencyMs": 412 }
```

- Protocol whitelist: `openai` (`GET /v1/models`), `anthropic`
  (`POST /v1/messages` with `claude-3-5-sonnet-20241022`,
  `max_tokens:1`), `gemini` (`GET /v1beta/models?key=...`).
  Anything else returns `400 BAD_PROTOCOL` with no network call.
- The key is sent only to the `baseURL` from the request body (or
  the protocol default). The plaintext key never leaves the
  server in any response path.

### `GET /api/providers/presets`

Built-in preset provider gallery (ticket 02). The response lists every
curated template (currently 11 — 智谱 / Kimi / 百炼 / 火山 / mimo /
minimax / opencode go / OpenRouter / Claude Code / Codex / DeepSeek)
with the metadata each one would write into the user-level file on
enable. The `enabled` flag and `enabledIds` array mark templates whose
id already appears in the configured catalogue, so the UI can render
"Enabled" / "Enable" buttons without a second round-trip.

Templates never carry key material: `apiKey` / `apiKeyMasked` / `hasKey`
are intentionally absent from the gallery payload. Users supply the
credential after enabling a preset.

A preset's `auth.type` (`byok` or `coding-plan`) is currently
COSMETIC at this layer: no code path branches on it, and an enabled
preset with empty key is consumed identically to a byok record by
the engine. The label is preserved on the persisted record so a
future subscription-auth behaviour (per-provider key flow,
auto-refresh, scoped quotas) has a stable placeholder to attach to;
it does NOT change behaviour today.

**Response 200**
```json
{
  "ok": true,
  "version": 2,
  "presets": [
    {
      "id": "zhipu",
      "label": "智谱 (Zhipu / GLM)",
      "protocol": "openai",
      "auth": { "type": "byok", "baseURL": "https://open.bigmodel.cn/api/paas/v4/" },
      "models": [
        { "id": "glm-4-plus", "label": "GLM-4 Plus", "contextLimit": 128000, "modalities": ["text"] }
      ],
      "enabled": false
    }
  ],
  "enabledIds": ["zhipu"]
}
```

### `POST /api/providers/preset/:id/enable`

One-click materialisation of a preset into the user-level catalogue.
The handler resolves the template, merges it into the existing
catalogue, writes the file via the same `writeProvidersConfig`
pipeline that PUT uses (atomic rename, full v2 validation gate), and
broadcasts the standard `providers.updated` SSE event so every
connected client refreshes its catalogue. The next `/api/models`
read picks up the new entries without a restart (the user-level file
is re-read on every call).

Idempotent: a second call for the same id returns `200` with
`alreadyEnabled: true` and the existing masked record rather than
clobbering the user's later edits to `apiKey` / `baseURL`. Custom
providers that share an id with a preset are NOT overwritten — the
handler surfaces the existing record under the same idempotent
contract.

The persisted record starts with an empty `apiKey`; the user fills
it through the same form the custom-providers UI uses.

**Response 200** (newly enabled)
```json
{
  "ok": true,
  "alreadyEnabled": false,
  "provider": { /* masked view, same shape as GET */ },
  "path": "/home/you/.mcode-webui/providers.json"
}
```

**Response 200** (idempotent — preset already configured)
```json
{
  "ok": true,
  "alreadyEnabled": true,
  "provider": { /* the existing masked record */ }
}
```

- `400 UNKNOWN_PRESET` — `:id` does not name a known template.
- `500 WRITE_FAILED` — disk I/O failure (the in-memory state did
  not change; the operator should retry).

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
  "found": true,
  "sid": "mvs_…",
  "rows": [{ "ts": 1730000000000, "input": 1000, "output": 800 }],
  "totalInput": 1000,
  "totalOutput": 800,
  "totalCacheRead": 500,
  "totalCacheWrite": 200,
  "totalReasoning": 120,
  "contextUsed": 1920,
  "model": "MiniMax-M3",
  "modelLimit": 524288,
  "firstTs": 1730000000000,
  "lastTs": 1730000000000,
  "dbPath": "/home/you/.mavis/usage.db"
}
```

- `contextUsed` is `totalInput + totalOutput + totalReasoning` — the cache
  counters are a subset of input, not additional context.
- `modelLimit` comes from the model's config, and is `null` when unknown.
- `found: false` (with `dbExists`) when the db or the session row is absent —
  see the 404 shape below.

### `POST /api/refresh`

Push the caller's current state to its SSE clients. The usage popover's refresh
button calls this and then `POST /api/usage`, which is what actually re-reads the
quota from the engine.

**Response 200** `{ok: true}`

### `GET /api/usage/forecast`

Predict quota exhaustion time. Reads `$WEBUI_DATA_DIR/usage-history.ndjson`
and extrapolates the 5-hour and weekly windows. Best-effort: a missing or
empty history file still answers `200`, so the UI can render a "collecting
data…" placeholder rather than an error.

**Response 200**
```json
{
  "ok": true,
  "forecast": {
    "hoursUntilExhaustion5h": 3.5,
    "hoursUntilExhaustionWeekly": 82.0,
    "confidence5h": 0.8,
    "confidenceWeekly": 0.6,
    "samples": 12,
    "model": "least-squares-linear"
  }
}
```

**Response 200** (not enough data) — the numeric fields are still present and
`null`, they do not collapse away:
```json
{
  "ok": true,
  "forecast": {
    "hoursUntilExhaustion5h": null,
    "hoursUntilExhaustionWeekly": null,
    "confidence5h": 0,
    "confidenceWeekly": 0,
    "samples": 0,
    "model": "least-squares-linear",
    "reason": "no_history"
  }
}
```

`reason` is `"no_history"` (empty/missing file) or `"insufficient_samples"`
(fewer than 3 samples). An `hoursUntilExhaustion*` value is always a future
number — the model clamps a past exhaustion to "won't run out" rather than
reporting a negative time.

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
decision is delivered back here. See [CAPABILITIES.md §13](CAPABILITIES.md)
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

Overwrite slices of a CID's in-memory state, for exercising the UI without a
real engine. Each field is optional; supplied ones replace, omitted ones are
left alone. This is **not** a raw SSE event injector — it mutates state, and
the normal push path then broadcasts it.

**Request** (the CID comes from the `?cid=` query, not the body)
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
