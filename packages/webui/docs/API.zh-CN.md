# HTTP API 参考

> 简体中文 | [English](API.md)

> 完整枚举所有端点。除非另有说明，REST 均为 JSON；唯一的
> 服务端推送事件（SSE）端点是 `/api/events`。

所有非 API 路由返回静态文件（`server.js` → `serveStatic` /
`serveIndex`）。

## 约定

- **基础 URL**：`http://127.0.0.1:18090`（若启用则为局域网 IP）
- **路径前缀**：`/api/`
- **Content-Type**：请求与响应均为 `application/json; charset=utf-8`
- **认证头**：若设置了 `TOKEN` 环境变量，每个请求必须包含以下二者之一
  - 查询参数：`?token=…`
  - 请求头：`Authorization: Bearer …`
  - 缺失或错误时返回 401
- **CID**：每个请求应携带 `?cid=<uuid>` 以标识 webui
  标签页。webui 会自动注入；若缺失，服务器将回退到
  `default` CID。
- **错误**：每个错误响应均为 `{ok: false, error: 'human-readable message'}`，
  并配有适当的 4xx/5xx 状态码。一些旧端点在软失败时仍返回
  `{ok: true, …}` —— 下文会特别指出这些情况。

---

## 健康检查

### `GET /api/health`

返回服务器状态。无需认证，无需 CID。

**响应 200**
```json
{
  "ok": true,
  "port": 18090,
  "defaultModel": "minimax_api/MiniMax-M3",
  "defaultWorkspace": "C:\\Users\\you\\.minimax-code\\webui",
  "mcodeCmd": "C:\\Users\\you\\.minimax-code\\mcode.cmd",
  "mcodeVersion": "0.1.2",
  "maxConcurrent": 3
}
```

---

## 状态与 SSE

### `GET /api/state`

返回此 CID 当前的 `state` 对象。完整结构参见
[ARCHITECTURE.md §4](ARCHITECTURE.md)。

**响应 200**
```json
{ "ok": true, "version": "0.1.3", "running": {"active": false}, … }
```

### `GET /api/events`

此 CID 的服务端推送事件（Server-Sent Events）流。连接会无限期保持
打开。事件列表见
[ARCHITECTURE.md §5](ARCHITECTURE.md)。

**响应 200**（`Content-Type: text/event-stream`）
```
event: state
data: {"version":"0.1.3","running":{"active":false},…}

event: delta
data: {"text":"hello","isPartial":true}

event: exec
data: {"status":"ok","durationMs":12345}
```

连接会一直持有，直到客户端关闭（`EventSource.close()`）
或服务器关闭。服务器端不会自动重连；
webui 会以指数退避方式处理重连。

---

## 聊天

### `POST /api/send`

发送一条用户消息。为此 CID 启动（或复用）mcode 子进程，
并通过 SSE 流式返回结果。

**请求体**
```json
{
  "content": "refactor the workspace picker to use a tree",
  "attachments": ["@C:\\path\\to\\file.py"],
  "isAskAnswer": false
}
```

- `content`（字符串，必填）—— 用户消息。可以包含指向附件的
  `@path` 引用；webui 会自动注入这些引用。
- `attachments`（字符串数组，可选）—— 要前置到内容中的
  `@path` 字符串列表。webui 会从附件 UI 填充此字段；
  通常不需要直接传递。
- `isAskAnswer`（布尔值，可选）—— 为 `true` 时，内容是对一个
  进行中的 `ask_user` 提问的回答。由询问弹窗自动设置。

**响应 200** 立即返回 `{ok: true}`。实际响应通过
`/api/events` 流式推送。

**错误**
- 若 `state.running.active === true`（已在运行）返回 409
- 若 `content` 为空返回 400

### `POST /api/stop`

取消当前运行。尽力而为：先尝试通过 acp 调用 `session/cancel`
（0.1.5 中未实现），然后 SIGTERM，2 秒后 SIGKILL。

**请求体** `{}`

**响应 200** `{ok: true}`

### `POST /api/cmd`

发送一条原始斜杠命令（例如 `/compact`、`/clear`）。服务器将
命令发送给 mcode 并流式返回结果。

**请求体**
```json
{ "cmd": "/compact" }
```

**响应 200** `{ok: true}`

---

## 会话

### `GET /api/sessions`

列出 webui 会话 + mcode 会话（已合并、去重）。

**响应 200**
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

创建一个新的 webui 会话。可选地关联到某个工作区。

**请求体**
```json
{ "workspace": "C:\\path\\to\\project" }
```

传 `workspace` 时必须通过与 `POST /api/workspace` 相同的围栏校验
（目录存在、落在允许根内、软链解析后不越界）—— 否则返回 400，
且不创建任何会话记录。

**响应 200** `{ok: true, id: "uuid"}`

### `POST /api/sessions/switch`

切换到已有会话。加载其聊天历史，并（若已关联）
重新挂接到对应的 mcode 会话。

**请求体**
```json
{ "id": "uuid" }
```

**响应 200** `{ok: true}`

### `POST /api/sessions/rename`

重命名会话（增删改查中的"改"）。`id` 接受 webui uuid、`mvs_…` 形式的
mcode 会话 id，或尚无 webui 壳记录的裸 `mvs_…`（会自动建壳承接标题）。
标题以用户为准：记录会打上 `titleCustom: true` 标记，mcode 的自动标题
生成此后永不覆盖它。

不走 `authorize()` 弹窗闸门 —— 改名非破坏性且可逆（与 `session.create`
同级）；无论结果如何都会向哈希链追加 `session.rename` 审计事件
（`from` → `to`）。

**请求体**
```json
{ "id": "uuid", "title": "我的新标题" }
```

**响应 200**
```json
{ "ok": true, "session": { "id": "uuid", "mcodeSessionId": "mvs_…", "title": "我的新标题", "titleCustom": true } }
```

**错误** —— 400：缺 `id` / `title` 为空 / `title` 超过 200 字符；
404：id 不存在且不是 `mvs_` 形式。

### `POST /api/sessions/cleanup-orphans`

删除没有任何 webui 会话引用的 mcode 会话。两个作用域：

- `scope: "orphans"`（默认）—— 仅删除没有 webui 引用的
  mcode 会话。当前活动会话始终会被保留。
- `scope: "all"` —— 删除所有 mcode 会话，然后重新关联那些
  带有 `mcodeSessionId` 的 webui 会话（该 id 现在指向一个已删除
  的会话 —— 它们重新变为"仅 webui"会话）。

**请求体**
```json
{ "scope": "orphans" }
```

**响应 200**
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

删除一个 webui 会话及其关联的 mcode 会话（若有）。mcode
侧的删除是在 32 个以会话为键的 `local_runtime_*` 表
（外加 `local_runtime_sessions`）上的单个 SQLite 事务 —— 任何
非"表不存在"的按表错误都会回滚整个事务。

传入 `?dryRun=true` 可在不修改任何内容的情况下预览 mcode
侧的影响。

**响应 200**（主路径）
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

**`mcodeDbDel.outcome` —— 明确的判定结果（绝不伪装成功）**：

| outcome / reason | 含义 |
|---|---|
| `deleted` | 事务已提交；行已被移除。 |
| `already_absent` | 事务已提交；此 sid 没有任何匹配（个别缺失的表只有在 schema 目录确认其不存在时才会被跳过）。 |
| `unsupported_schema`（`ok:false`、`reason`） | 某张表存在但没有 `session_id` 键列；已回滚，`table` 字段指明该表。 |
| `db_error`（`ok:false`、`reason`） | 锁冲突（`SQLITE_BUSY`/`LOCKED`）、prepare/run 失败或 IO 错误；已回滚。 |
| `audit_write_failed`（`ok:false`、`reason`） | 行可能已被删除但审计事件无法记录 —— 会被如实上报，绝不视为干净的成功。 |

`session.delete` 审计事件携带 `outcome`
（`tablesAffected` / `tablesAbsent` / `totalRowsDeleted`）。在孤儿
路径上（`mvs_*` id 且无对应 webui 会话），mcode 删除失败会返回
**500**，并内嵌相同的 `mcodeDbDel` 失败对象；在主路径上，
200 响应体中的 `mcodeDbDel.ok` / `outcome` 字段是 mcode 侧
结果的唯一权威来源。

**响应 404** `{"ok": false, "error": "session not found"}` —— id
既不匹配任何 webui 会话，也不匹配 `mvs_*` 模式。

### `GET /api/acp-sessions`

原始 mcode 会话列表（来自 sqlite）。不与 webui 合并。

**响应 200** `{ok: true, sessions: [...]}`

### `GET /api/acp-session-title?sessionId=mvs_…`

获取某个 mcode 会话的标题。

**响应 200** `{ok: true, title: "…"}`

---

## 工作区

### `POST /api/workspace`

更改当前 CID 的工作区。

**请求体**
```json
{
  "dir": "C:\\path\\to\\project",
  "syncTui": true
}
```

- `dir`（字符串，必填）—— 绝对路径
- `syncTui`（布尔值，可选）—— 同时把该路径写入 `cwd.json`，
  以便 mcode TUI 能看到
- `action: "detect"` —— 不做更改，返回当前 TUI 的 cwd
- `action: "useTui"` —— 把 TUI 的 cwd 复制到 webui
- `action: "reset"` —— 恢复 webui 的默认工作区

**响应 200** `{ok: true, dir: "…", branch: "main", treeState: "clean"}`

### `GET /api/workspace/browse?path=…`

为树形浏览器列出一个目录。

**请求** 查询参数：`?path=C:\\Users`（Windows 上省略时列出各盘符根，
Linux 上为 `/`）

**响应 200**
```json
{
  "ok": true,
  "path": "C:\\Users",
  "children": [
    { "name": "Public", "path": "C:\\Users\\Public", "isDir": true }
  ]
}
```

当省略 `path` 时，根视图只列出**允许根**
（🔒 v2 —— 见下文）；响应保持其跨平台兼容的结构：
- Windows：`roots: ["C:\\Users\\you", …]`（即允许根），`dir: null`
- POSIX：`dir: "/"`，`roots: ["/home/you", "/tmp", …]`，`children: []`

**🔒 v2 工作区边界限定（PR #55 评审第 5 点）**：候选
路径会经过 `resolve()` 并解析符号链接（`realpath`），且必须落在
某个允许根之内 —— 默认允许根为用户主目录 + 默认工作区 +
系统 tmp 目录。`MCODE_WEBUI_WORKSPACE_ROOTS` 环境变量
（以路径分隔符分隔的多个段）会**完全替换**默认集合。越界
路径 —— 包括 `../` 穿越和符号链接逃逸 —— 会被拒绝，并返回
可操作的错误，指明解析后的路径、允许根以及对应的
环境变量开关。本端点与 `POST /api/workspace` 执行相同的
边界检查。

---

## 设置

### `GET /api/settings`

返回完整的设置快照。**此端点豁免于局域网防护** —— 它是远程
用户在把自己锁在门外之后重新开启局域网访问的途径。同一快照
也会在状态变化时通过 SSE 推送
（见 [ARCHITECTURE.md §5 SSE state push](./ARCHITECTURE.md#5-sse-state-push)）。

**响应 200**（🆕 v1.0.1，🔒 v2 安全 —— PR #55 评审）
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
  "mcodeVersion": "0.1.2",
  "defaultWorkspace": "C:\\…",
  "defaultModel": "minimax_api/MiniMax-M3",
  "readOnly": false,                // 🆕 v1.0.1 — read-only mode toggle
  "tokenEnabled": true,             // 🆕 v1.0.1 — token auth master switch (default true)
  "currentToken": "…",              // 🆕 v1.0.1 — auto-generated 32-hex token; "" after tokenAcknowledged=true
  "tokenAcknowledged": false,       // 🆕 v1.0.1 — operator has confirmed they saved the token
  "tokenRotatedAt": 1724259600000   // 🆕 v1.0.1 — ms-since-epoch of the last rotation
}
```

关于 🔒 v2 字段的说明：

- `host` 始终是**实际启动时的绑定地址**；`bindHost` 会根据当前
  状态重新计算下次启动将解析到的地址
  （`resolveBindHost`：环境变量 `HOST` > `lanBind` > `127.0.0.1`）。
- `trustedOrigins` 是显式的 CORS 允许列表 —— 列在其中的
  来源会被逐字反射到 `Access-Control-Allow-Origin` 中，此外还有
  服务器自身的提供来源（环回地址 + 局域网共享开启时的
  局域网地址）。参见
  [SECURITY-NOTES CORS](../references/SECURITY-NOTES.md#cors--cross-origin-resource-sharing)。

字段 `currentToken` 和 `tokenAcknowledged` 会持久化到
`~/.mcode-webui/settings.json`（Unix 上权限为 `0600`）。
`currentToken` 和 `lanUrlWithToken` 在 **`tokenAcknowledged=true`
之后会被省略** —— 只有当操作员在 UI 中仍持有令牌副本时，
服务器才会下发令牌。
`MCODE_WEBUI_SETTINGS_PATH` 环境变量可覆盖该文件位置。

### `POST /api/settings`

更新一项或多项设置。v1.0.1 扩展了载荷 —— 下列字段的任意
组合都可以在一次请求中设置。
**始终豁免于局域网防护和只读门禁**（这样管理员始终可以
远程切换各项设置，即使在只读模式下）。

**v2 请求体 —— 全部可设置字段**（🆕 v1.0.1，🔒 v2 安全 —— PR #55 评审）
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

`trustedOrigins` 校验（失败即关闭，整批处理）：仅允许
`http`/`https` 来源序列化形式（`scheme://host[:port]` —— 不允许
路径 / 查询串 / userinfo），最多 16 条、每条 1..200 个字符；
无效批次会在**任何状态变更之前**以 400 整体拒绝（畸形的
允许列表绝不可能部分扩大 CORS 暴露面）。

**响应**

- `200 {"ok":true, "changed":true, …}` —— 至少有一个字段被更新
- `200 {"ok":true, "tokenRotated":true, "currentToken":"…", "tokenAcknowledged":false, "tokenRotatedAt":…}` —— `resetToken:true` 的专用响应（返回新值，以便调用方更新其 localStorage）
- `200 {"ok":true, "changed":false}` —— 没有字段实际发生变化
- `400 {"ok":false, "error":"invalid origin: …"}`（及类似）—— `trustedOrigins` 批次未通过校验
- `500 {"ok":false, "error":"…"}` —— 仅在 `rotateToken` 磁盘写入失败时（罕见）

---

## 上传

### `POST /api/upload`

Multipart 文件上传。保存到 `MCODE_WEBUI_UPLOAD_DIR` 并返回
绝对路径。🔒 v2 安全（PR #55 评审第 3 点）：解析器是一个有
上界的流式状态机（内存为 O(chunk)，绝不达到 O(body)），
并在流的中途强制执行三项限制：

| 限制 | 默认值 | 环境变量覆盖（正整数） | 错误码 |
|---|---|---|---|
| 请求体总量 | 50 MiB | `MCODE_WEBUI_UPLOAD_MAX_REQUEST` | `UPLOAD_REQ_TOO_LARGE` |
| 单个文件 | 25 MiB | `MCODE_WEBUI_UPLOAD_MAX_FILE` | `UPLOAD_FILE_TOO_LARGE` |
| 上传目录配额 | 200 MiB | `MCODE_WEBUI_UPLOAD_QUOTA` | `UPLOAD_QUOTA_EXCEEDED` |

**请求** `multipart/form-data`，带有一个 `file` 字段。

**响应 200**
```json
{
  "ok": true,
  "path": "C:\\…\\.webui-uploads\\screenshot.png",
  "name": "screenshot.png",
  "size": 12345
}
```

（`size` 是实际存储的字节数；文件只有在流干净结束后才会通过
`rename()` 落到最终文件名 —— 失败时不会留下写了一半的
残迹。）

**错误** —— 状态码由错误码映射而来，且错误码会在响应体中
回显，让客户端看到触发了哪一项限制：

```json
{ "ok": false, "error": "file exceeds size limit: 26214401 > 26214400 bytes (adjust MCODE_WEBUI_UPLOAD_MAX_FILE to allow more)", "code": "UPLOAD_FILE_TOO_LARGE" }
```

- `413` + `Connection: close` —— `UPLOAD_REQ_TOO_LARGE` /
  `UPLOAD_FILE_TOO_LARGE` / `UPLOAD_QUOTA_EXCEEDED`（超限的
  请求体被有意地不予消费）
- `400` —— `UPLOAD_MALFORMED`（畸形 / 截断的 multipart）/
  `UPLOAD_ABORTED`（客户端掐断了流）
- `500` —— 其他一切情况（磁盘 I/O、审计写入、未知错误）

---

## 模型

### `GET /api/models`

返回内置 + 当前已配置的模型列表。

**响应 200**
```json
{
  "ok": true,
  "current": "minimax_api/MiniMax-M3",
  "models": [
    { "id": "minimax_api/MiniMax-M3", "label": "MiniMax-M3", "provider": "minimax_api" }
  ]
}
```

如果列表为空，响应会包含一个 `hint` 字段，指引用户前往
mcode TUI 进行模型配置。

### `POST /api/set-model`

更改当前 CID 的模型。

**请求体**
```json
{ "model": "minimax_api/MiniMax-M3" }
```

**响应 200** `{ok: true, model: "…"}`

### `POST /api/permissions`

更改会话级权限模式。

**请求体**
```json
{ "permissions": "ask" }
```

- `permissions`（字符串）—— 取值为 `ask`、`auto`、`full`、`plan` 之一

**响应 200** `{ok: true, permissions: "ask"}`

> 注意：mcode 0.1.5 的 acp 未实现 `session/set_mode`。
> webui 的 UI 会显示用户选择的模式，但底层 mcode 会话
> 不会改变。服务器控制台会记录为
> `[mcode-rpc] UNSUPPORTED session/set_mode`。待
> mcode 实现该方法后即可生效。

### `GET /api/permissions-modes`

列出可用的权限模式。

**响应 200** `{ok: true, modes: ["default", "bypassPermissions", "auto", "off", "read", "full"]}`

### `POST /api/answer`

回应一个进行中的权限 / 计划 / ask_user 提示。

**请求体**
```json
{ "type": "permission", "option": "ask" }
```

- `type`（字符串）—— `permission` | `plan` | `planmode` | `ask`
- `option`（字符串）—— 取决于 type：
  - `permission`：`ask` | `auto` | `full`
  - `plan`：`agree` | `skip` | `add`
  - `planmode`：`continue` | `deny`
  - `ask`：`esc`（跳过）| `<index>`（选项）| `<text>`（自由文本）

**响应 200** `{ok: true}`

---

## 用量

### `GET /api/usage` 与 `POST /api/usage` 与 `POST /api/usage-trigger`

获取当前的 `mmx quota show` 快照。`POST /api/usage-trigger`
还会从 CLI 触发一次全新的抓取。`GET /api/usage` 与
`POST /api/usage` 在缓存较新时返回缓存值。

**响应 200**
```json
{
  "ok": true,
  "remaining": 91,
  "resetAt": 1234567890,
  "weeklyResetAt": 1234567890,
  "fetchedAt": 1234567890,
  "source": "mmx"
}
```

### `GET /api/usage-real`

从 `mavis` 运行时数据库获取每轮上下文用量。这是右侧面板中
"已用 N / 占比 N%" 的权威数据来源。

**响应 200**
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

重新抓取配额 + 每轮上下文。webui 在用户点击用量弹层中的
"刷新"按钮时调用此端点。

**响应 200** `{ok: true}`

---

## 协议（acp 垫片）

这些端点封装了 webui *可以*调用的 acp 协议方法。mcode 0.1.5
未实现的方法会返回 501，并带有 `{code: 'unsupported'}`。

### `POST /api/protocol/set-mode`

调用 `session/set_mode`。**当前返回 501**（mcode 0.1.5）。

### `POST /api/protocol/set-config-option`

调用 `session/set_config_option`。**当前返回 501**。

### `POST /api/protocol/cancel`

调用 `session/cancel`。**当前返回 501**（回退为对子进程
发送 SIGTERM）。

### `POST /api/protocol/load-session`

调用 `session/load`。在 0.1.5 中可用。

**请求体** `{sessionId: "mvs_…", cwd: "C:\\…"}`

### `POST /api/protocol/activate-session`

调用 `session/activate`。**当前返回 501**。

### `GET /api/protocol/list-sessions`

调用 `session/list`。在 0.1.5 中可用。

### `GET /api/protocol/capabilities`

返回 webui 已知的 acp 方法列表及其支持状态。webui 用它
来决定启用哪些 UI 控件。

**响应 200**
```json
{
  "ok": true,
  "agentInfo": { "name": "mcode", "title": "mcode", "version": "0.1.5" },
  "supported": ["session/new", "session/list", "session/load", "session/prompt", "session/close"],
  "unsupported": ["session/set_mode", "session/set_config_option", "session/cancel", …]
}
```

---

## 调试（受门禁控制）

### `POST /api/debug/inject`

向某个 CID 的 SSE 通道注入一个伪造事件。用于在没有真实
mcode 子进程的情况下测试 UI。

**请求体**
```json
{ "cid": "uuid", "type": "delta", "text": "hello" }
```

**响应 200** `{ok: true}`

**门禁**：此端点仅在服务器环境中设置了 `DEBUG_INJECT=1`
时才可用。每次被调用时服务器都会记录一条警告。生产部署
应保持该环境变量未设置。

### `GET /api/debug/state`

返回完整的按 CID 状态，包括内部标志位。同样受
`DEBUG_INJECT` 门禁控制。

---

## 静态文件

### `GET /`

返回 `public/index.html`。

### `GET /<file>`

若 `public/` 中存在该文件则返回之。由 `serveStatic` 提供。
缓存头：`public, max-age=3600`。HTML/JS/CSS 路径
内嵌了 `?v=N` 缓存破除查询串；当你希望客户端重新抓取时，
在 `index.html` 中递增它。

---

## 错误响应

所有错误均遵循以下结构之一：

```json
{ "ok": false, "error": "human-readable message" }
```

```json
{ "ok": false, "code": "unsupported", "error": "mcode 0.1.5 acp does not implement session/set_mode" }
```

```json
{ "ok": false, "error": "LAN 访问已关闭。在本机打开设置开启。" }
```

HTTP 状态码与成因相对应（400 / 401 / 403 / 404 / 409 / 413 / 500 / 501）。
