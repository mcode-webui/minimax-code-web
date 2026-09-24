# HTTP API 参考

> 简体中文 | [English](API.md)

> 完整枚举所有端点。除非另有说明，REST 均为 JSON；SSE
> 端点有两个：`/api/events`（聊天/状态）与 `/api/alerts`
> （异常/审计）。

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
  "mcodeVersion": "0.5.2",
  "maxConcurrent": 3
}
```

`mcodeVersion` 来自引擎自身（取自 ACP `initialize` 应答）。
在尚无客户端挂接之前为 `"unknown"` —— 本端点不会硬编码一个固定常量。

### `GET /api/account`

账号卡片数据：展示名、套餐档位、剩余配额。按需拉取而非塞进
SSE 状态快照 —— 后者会向包括局域网客户端在内的全部订阅者广播，
账号数据不该走这条通道。凭据由引擎持有，webui 仅转投影
（见 `server/lib/mcode-rpc.js#getAccountStatus`）。

**响应 200**（引擎已应答）
```json
{ "ok": true, "name": "weekbin", "planTier": "max", "remaining": 86, "weeklyRemaining": 92, "resetAt": 1790164800, "weeklyResetAt": 1790524800 }
```

**响应 200**（引擎不可用 —— 软失败）
```json
{ "ok": false, "reason": "no_client" }
```

`reason` 取值为 `no_client` / `rpc_error` / `account_unavailable`
之一 —— 卡片渲染空态，本路由绝不臆造一个名字或套餐档位。

---

## 状态与事件流

### `GET /api/state`

返回此 CID 当前的 `state` 对象。完整结构参见
[ARCHITECTURE.md §4](ARCHITECTURE.md)。

**响应 200**
```json
{ "ok": true, "version": "0.5.2", "running": {"active": false}, … }
```

### `GET /api/alerts`

异常 / 系统信号环形缓冲的 REST 快照（至多 100 条，旧 → 新）。
实时更新不由本端点下发 —— 它们以 `alerts.append` /
`alerts.update` 控制帧经 WebSocket 事件流（`GET /api/stream`）
下发；客户端把这些帧并入本快照，并按 `alert.id` 去重。

**响应 200**（`Content-Type: text/event-stream`）
```
event: state
data: {"version":"0.5.2","running":{"active":false},…}

event: delta
data: {"text":"hello","isPartial":true}

event: exec
data: {"status":"ok","durationMs":12345}
```

### `GET /api/stream`

WebSocket 事件流端点（技术方案 `docs/drafts/arch_net_solution_0922.md` §7.2）。本端点始终启用 —— 传输开关已删除 —— 升级执行与全部 `/api/*` 路由相同的门链（origin / LAN / token）；不带 `Upgrade` 头的普通 `GET` 返回 426，成功的 RFC 6455 握手建立连接。服务端 → 客户端帧为 WS text JSON：`hello`（`{v:1, type:"hello", payload:{cid, resumeSupported, latestSeq, heartbeatMs, ringCapacity}}` —— `cid` 回显该流绑定的客户端 id）、带 `seq`/`ts` 的 `state.snapshot` 与 `control` 事件帧、`error` 帧。发行版 SPA 即通过本端点接收状态快照与控制事件：首连基线经 `GET /api/state` 获取，告警快照经 `GET /api/alerts` 获取。客户端 → 服务端仅接受 JSON text 帧（`resume`/`ping`/`pong`/`close`），二进制帧以 1002 关闭。断线恢复：`{v:1, type:"resume", payload:{lastSeq}}` 按 seq 严格递增重放缓冲事件；环形缓冲欠载时以最近 `state.snapshot` 为基线。心跳为 WS ping 控制帧（默认 30 秒，连续 2 次无 pong 以 1001 关闭）；入站帧令牌桶配额为稳态 20 帧/秒、突发 40，超出以 1013 关闭。

### `GET /api/alerts`

独立的异常/系统信号 SSE 通道。聊天/状态流是按 CID 的；
`/api/alerts` 是全局的。顶栏铃铛图标与审计日志订阅此通道。
具体线协议见 `server/routes/alerts.js`。

**响应 200**（`Content-Type: text/event-stream`）
```
data: {"kind":"snapshot","alerts":[{…}, …]}

data: {"kind":"append","alert":{…}}
data: {"kind":"update","alert":{…}}

event: heartbeat
data: {"ts":1730000000000}
```

- 连接建立时下发一次 `snapshot`，带上 100 条环形缓冲区的
  当前内容。
- `append` / `update` 携带单条告警（id、level、message、source、
  dedupKey、count、firstSeenAt、lastSeenAt）。
- 每 30 秒一条 `heartbeat` —— 防止代理把通道闲置超时。

---

## 聊天

### `POST /api/send`

发送一条用户消息。为此 CID 启动（或复用）mcode 子进程，
并通过 WebSocket 事件流（`GET /api/stream`）流式返回结果。

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

**响应 200** 立即返回 `{ok: true}`。实际响应经
WebSocket 事件流（`/api/stream`）流式下发。

**错误**
- 若 `state.running.active === true`（已在运行）返回 409
- 若 `content` 为空返回 400

### `POST /api/stop`

取消当前运行。先尝试通过 acp 调用 `session/cancel`
（取消通知会投递到当前 CID 的活动子进程；若通知无法送达，
服务器回退到对子进程发送 SIGTERM，2 秒后升级为 SIGKILL）。

**请求体** `{}`

**响应 200** `{ok: true, cancelled: true, killEndpoint: "/api/stop"}`

通知未抵达引擎时，路由返回
`{ok: true, cancelled: false, warning, code, killEndpoint: "/api/stop"}` ——
调用方可再次 `POST /api/stop` 触发硬杀级联。

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

### `GET /api/session-tree?refresh=1`

侧边栏树：工作区及其下嵌套的会话。缓存 15 秒
（`server/routes/sessions.js` 中的 `CACHE_TTL_MS`）。写操作
（`POST /api/sessions`、`/api/sessions/rename`、
`DELETE /api/sessions/:id`）会自动失效缓存；与失效抢跑的
客户端可传 `?refresh=1` 强制重读。

**响应 200**
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

跨工作区模糊标题搜索，按工作区去重（每区最佳匹配胜出）。
`limit` 被夹到 `[1, 100]`。空 `q` 设计上返回
`{ok: true, results: []}` —— 搜索是查询，不是 list-all
端点。受按请求授权闸门控制（action 为 `session.search`）。

**响应 200**
```json
{
  "ok": true,
  "results": [
    { "id": "uuid", "title": "refactor the workspace picker", "workspace": "C:\\…", "updatedAt": 1730000000000, "matchScore": 100 }
  ]
}
```

**响应 403** `{ok: false, error: "authorize declined", decidedBy, decidedAt}`

### `GET /api/sessions/:id/export?format=md|json&download=true|false`

将会话聊天导出为 Markdown 或 JSON。读取
`$WEBUI_DATA_DIR/sessions.json`（主） + `runtime-state.sqlite`
（尽力而为的副源）。受按请求授权闸门控制
（action 为 `session.export`）。默认 `format` 为 `md`；
`download=true` 会附上 `Content-Disposition`，让浏览器直接保存。

**响应 200** —— `format=md` → `text/markdown; charset=utf-8` 响应体，
聊天渲染为 Markdown；`format=json` → `application/json`
响应体，含完整会话记录（id、title、workspace、mcodeSessionId、
chat、createdAt、updatedAt）。

**错误** —— 400：缺 `id` / 不支持的 format（响应体带 `allowed` 列表）；
403：授权被拒；404：id 未知。

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

### `GET /api/workspace/tree`

工作区 → 会话树，供侧边栏工作区下拉与"切换工作区"弹层使用。
按 `workspace` 目录对 webui 会话存储分组；排序为
`current` 在前，随后按 `lastActiveAt` 倒序。当前活跃工作区
即便没有任何会话也会排在最前（开新聊天时最常被选中）。

**响应 200**
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

把一个文件夹名（`<input webkitdirectory>` 唯一能给到浏览器的
就是名字）解析成跨常见根（主目录、默认工作区、tmp）的绝对
路径候选。用户从中确认匹配的那一个。服务器与浏览器同机，
按名字查找就够了，无需授权弹窗。

**响应 200**
```json
{ "ok": true, "candidates": ["C:\\path\\to\\folder", "/home/you/folder"] }
```

### `GET /api/workspace/recent?search=&limit=5`

最近用过的工作区，可按目录子串过滤。`limit` 被夹到 `[1, 20]`，
默认 5。响应里的 `tmpDir` 字段供"无需工作区"按钮使用。

**响应 200**
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

拉起系统原生的文件夹选择器（`zenity` / `kdialog` / `osascript` /
PowerShell `FolderBrowser`），返回所选路径。本路由绝不抛错 ——
用户取消时返回 `200 {ok: true, path: null}`；启动失败时返回
`200 {ok: false, error}`。

**响应 200**（用户已选择）
```json
{ "ok": true, "path": "C:\\path\\to\\folder" }
```

**响应 200**（用户取消）
```json
{ "ok": true, "path": null }
```

---

## 文件系统

fs 端点是给工作区选择面板用的读/写原语。它们与
`POST /api/workspace` / `GET /api/workspace/browse` 共享同一条
边界：候选路径会经过 `resolve()` 并解析符号链接（`realpath`），
且必须落在某个允许根之内（默认主目录 + 默认工作区 + tmp；
`MCODE_WEBUI_WORKSPACE_ROOTS` 会**完全替换**默认集合）。

### `GET /api/fs/read?path=<dir>&showHidden=0|1`

列出允许根内的某个目录。`path` 必填；`showHidden=1` 包含
dotfile。符号链接当文件返回时是 `Dirent` 项（webui 视为
文件展示；暂不跟随符号链接 —— 见
[CAPABILITIES.md §6](CAPABILITIES.md)）。

**响应 200**（形态由 `readDirectory()` 决定）
```json
{ "ok": true, "path": "C:\\Users\\you\\Documents", "entries": [{ "name": "…", "path": "C:\\…", "isDir": true }] }
```

**错误** —— 400：缺 `path`；403：越界。

### `POST /api/fs/mkdir`

在允许根内创建一个目录。目标可以尚未存在 —— 路由会先校验
**父目录**在边界之内，再执行创建。

**请求体**
```json
{ "path": "C:\\Users\\you\\Documents\\new-folder" }
```

**响应 200** `{ok: true, path: "C:\\…\\new-folder"}`

**错误** —— 400：JSON 非法；403：父目录越界；409：已存在。

---

## 设置

### `GET /api/settings`

返回完整的设置快照。**此端点豁免于局域网防护** —— 它是远程
用户在把自己锁在门外之后重新开启局域网访问的途径。同一快照
也会在状态变化时经 WebSocket 事件流推送
（见 [ARCHITECTURE.md §5 事件模式](./ARCHITECTURE.md#5-event-schema-websocket-event-stream)）。

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
  "resetToken": true,              // 🆕 v1.0.1 — generate new token + broadcast auth.token_rotated over the event stream
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
  "path": "C:\\…\\.mcode-webui\\uploads\\screenshot.png",
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

更改当前 CID 的模型。立即写入 `cs.model`，让撰写器即时反映；
若当前存在 mcode 会话，还会在该 CID 的活动子进程上调用
`session/set_config_option {configId:'model'}`。没有会话时，
该改动会保留给下一个会话。

**请求体**
```json
{ "model": "minimax_api/MiniMax-M3" }
```

**响应 200**（引擎已接受）
```json
{ "ok": true, "model": "minimax_api/MiniMax-M3", "mcodeSynced": true }
```

尚无 `mcodeSessionId` 时：`{ok: true, model: "...", mcodeSynced: false, warning: "no mcode session yet — recorded for the next one"}`。

### `POST /api/permissions`

更改会话级权限模式。会话进行中的路由走
`session/set_config_option {configId:'permissionMode'}`（见
[§协议](#协议acp-垫片)）。本路由还会把新的模式标签写回
本地的 `cs.permissions`，让 UI 立即更新。

**请求体**
```json
{ "mode": "ask" }
```

- `mode`（字符串）—— 取值为 `ask`、`auto`、`read`、`full` 之一。
  webui 在内部把这些别名映射到引擎的 `permissionMode` 值；
  客户端应发送短别名，而不是引擎的原始值。

**响应 200**（典型 —— 引擎接受了改动）
```json
{ "ok": true, "permissions": "Ask", "mcodeSynced": true }
```

- `permissions` 是显示标签（`Ask` / `Auto` / `Read` /
  `Full access`）。
- `mcodeSynced: true` 表示引擎的 `session/set_config_option`
  调用落到了活动子进程上。
- 尚无 `mcodeSessionId`（本 CID 还未创建会话）时，响应
  还会带 `warning: "no mcode session yet — applies to
  the next one"` 与 `mcodeSynced: false`。

**错误** —— 400：缺 / 空 `mode`；引擎拒绝（404/501/…）
会映射为 `{ok: false, error, code}` 并保留对应 HTTP 状态，
同时 `mcodeSynced: false`。

### `GET /api/permissions-modes`

列出可用的权限模式。响应同时携带 webui 的展示标签和引擎
原始的 `permissionMode` 值，客户端无需自行换算即可渲染
下拉。

**响应 200**
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

### `POST /api/usage` 与 `POST /api/usage-trigger`

读取账号的 Token Plan 配额。两个路由都分发到 `usageRoute.handleUsage`。

数字来自引擎：账号凭据由 mcode 持有，它通过 ACP 扩展方法
`mcode/account/status` 上报套餐档位与各窗口的剩余百分比；webui 自己不再保存
Subscription Key（见 `server/lib/usage.js`）。

`remaining` 与 `weeklyRemaining` 是百分比，且只在引擎确实给出读数时出现 ——
响应体里没有这两个字段表示"没有仪表盘可画"，而不是 0%。`resetAt` 与
`weeklyResetAt` 是 unix 秒。`ok: false` 加 `error` 表示问不到引擎（没有 ACP
客户端，或方法失败）；HTTP 状态仍是 200，因为请求本身成功了。

（本条目早期版本曾写有 `GET /api/usage`，该路由从未接线；标题现在只列路由表里
真实注册的两个 POST。）

**响应 200**
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

把调用方当前的状态推给它自己的 SSE 客户端。用量弹层的刷新按钮会先调用它，随后
再调 `POST /api/usage` —— 真正重新从引擎读取配额的是后者。

**响应 200** `{ok: true}`

### `GET /api/usage/forecast`

预测配额耗尽时间。读取
`$WEBUI_DATA_DIR/usage-history.ndjson` 并执行线性 + 稳健
（Huber）外推；UI 渲染中英双语的倒计时。尽力而为：
历史文件缺失或为空时返回 `200 {ok: true,
forecast: { reason: "no_history" }}`，让 UI 能渲染
"数据收集中…"占位，而不是抛错。

**响应 200**
```json
{
  "ok": true,
  "forecast": {
    "fiveHour": { "etaIso": "2025-10-29T18:00:00.000Z", "method": "linear", "remainingPct": 86, "samples": 12 },
    "weekly":   { "etaIso": "2025-11-02T03:30:00.000Z", "method": "huber", "remainingPct": 92, "samples": 12 }
  }
}
```

数据还不够时，`forecast` 会坍缩为 `{ reason: "no_history" }` 或 `{ reason: "insufficient_samples" }`。

---

## 协议（acp 垫片）

这些端点封装了 webui 可以调用的 acp 协议方法。每条路由
都通过 `server/lib/mcode-rpc.js` 分发，并把通知钉在该 CID
的活动子进程（按提示词粒度的 `McodeAcpClient`，而非单例）上。
引擎的拒绝模式（`unsupported`、`no_client`、`not_found`、
`policy`）分别映射为 `501 / 503 / 404 / 409`；其余一律是
`502` 或 `500`。

### `POST /api/protocol/set-mode`

调用 `session/set_mode {sessionId, modeId}`。webui 用此做
plan / goal 模式切换；权限模式切换走
`session/set_config_option`（见
[§POST /api/permissions](#post-apipermissions)）。

**请求体** `{sessionId: "mvs_…", mode: "plan_mode" | "goal_mode" | "default" | …}`

**响应 200** `{ok: true, mode: "plan_mode", data: <acp reply>}`

### `POST /api/protocol/set-config-option`

调用 `session/set_config_option {sessionId, configId, value}`。
通用配置项路由：今天真正调用它的有 `permissionMode` 与
`model` 两个。

**请求体** `{sessionId: "mvs_…", key: "permissionMode", value: "default"}`

**响应 200** `{ok: true, key: "permissionMode", value: "default", data: <acp reply>}`

当 `key === "permissionMode"` 时，本路由还会把 webui 标签
写回本地 `cs.permissions`，让 UI 不用等下一次 SSE 状态推送
就能立即更新。

### `POST /api/protocol/cancel`

调用 `session/cancel {sessionId}`。本路由只发送通知；
通知失败时返回 `200 { ok: true, cancelled: false, warning,
code, killEndpoint: "/api/stop" }`。温和版→SIGKILL 的级联
流程由 `POST /api/stop` 实现 —— 需要硬杀时请显式调用它。

**请求体** `{sessionId: "mvs_…"}`

**响应 200**（通知已接受）`{ok: true, cancelled: true, data: <acp reply>}`

### `POST /api/protocol/load-session`

调用 `session/load`。把一个 mcode 会话载入 webui，不切换
当前活跃 webui 会话。传 `createWebuiEntry: true` 可一并追加
一条侧边栏条目。

**请求体**
```json
{
  "sessionId": "mvs_…",
  "cwd": "C:\\…",
  "createWebuiEntry": false
}
```

**响应 200**
```json
{ "ok": true, "sessionId": "mvs_…", "webuiEntry": null }
```

当 `createWebuiEntry: true` 且尚无 webui 会话引用该
`mcodeSessionId` 时，`webuiEntry` 就是新建的侧边栏条目
（id、mcodeSessionId、title "Mcode session"、createdAt、updatedAt）。

### `POST /api/protocol/activate-session`

调用 `session/activate`。把当前 CID 切到指定 mcode 会话；
重置本地上下文，下一次提示词从新会话起步。

**请求** `{sessionId: "mvs_…"}`

**响应 200**
```json
{ "ok": true, "activeSessionId": "mvs_…", "data": <acp reply> }
```

### `GET /api/protocol/list-sessions?cwd=…`

调用 `session/list`。列出全部 mcode 会话；传入 `cwd` 时
响应按该工作区过滤（路径已规范化：大小写不敏感、忽略尾部斜杠、
`\` 与 `/` 等价）。

**响应 200**
```json
{ "ok": true, "sessions": [<mcode session rows>], "cwd": "C:\\…" }
```

### `GET /api/protocol/capabilities`

返回引擎的 `agentInfo`（取自 `initialize` 应答）以及 webui
已知的 capability 表（`server/lib/mcode-rpc.js` 里的
`MCODE_ACP_CAPABILITIES`）。webui 用它来决定启用哪些 UI 控件。

**响应 200**
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

`mcodeVersion` 在尚无客户端挂接（还没收到 `initialize` 应答）
时为 `"unknown"`；本端点不会臆造一个版本号。

---

## 授权决策

服务器侧授权闸门（`server/lib/authorize.js`）会在执行破坏性
操作前向用户申请确认（`session.delete`、
`sessions.cleanup-orphans`、`session.cleanup-all`、`session.export`、
`session.search`、`token.reset`、`slash.clear`、`startup.cleanup`）。
所有待决请求都通过下面这一个端点暴露 —— 客户端 UI 弹出
授权框，用户点允许 / 拒绝，决策经此端点回写。操作白名单
与默认 5 分钟超时见 [CAPABILITIES.md §12](CAPABILITIES.md)。

### `POST /api/auth/decision`

**请求体**
```json
{ "requestId": "auth-…", "approve": true }
```

**响应 200**（已处理）`{ok: true, approved: true, decidedBy: "user", decidedAt: 1730000000000}`

**错误**
- 400：`requestId` 缺失或为空
- 404 `{ok: false, error: "no pending request with that id"}`
  （已处理、已过期、或从未存在）
- 410 `{ok: false, error: "already decided"}` **不会**返回 ——
  本路由把"已处理"与"无此请求"一视同仁，统一返回 404，这是
  有意为之：重放决策不应泄露该请求是否曾经存在。

---

## 调试（受门禁控制）

### `POST /api/debug/inject`

向某个 CID 的事件流注入一个伪造事件。用于在没有真实
mcode 子进程的情况下测试 UI。

**请求体**
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

`appendChat` 必须是**聊天行组成的数组**。传单个字符串会被静默忽略——响应仍然是
`ok: true` 且 `applied` 为空，所以要看 `applied.appendedChatLines`。其余字段按
各自的形状处理（`todo` 整体替换；`goal` / `ask` / `plan` / `enterPlanMode`
浅合并进已有对象）。

**响应 200** `{"ok": true, "applied": {…}, "cid": "…"}`——`applied` 会列出真正
被消费的字段，这正是区分「什么都没做」和「写入了」的地方。

**门禁**：此端点仅在服务器环境中设置了 `DEBUG_INJECT=1`
时才可用。每次被调用时服务器都会记录一条警告。生产部署
应保持该环境变量未设置。

### `GET /api/debug/state`

返回完整的按 CID 状态，包括内部标志位。同样受
`DEBUG_INJECT` 门禁控制。

---

## 静态文件

### `GET /`

返回 `webapp/out/index.html`（Next 静态导出的入口）。
由 `serveIndex` 提供。主 UI **没有** `public/` 回退——旧的
`/app/*.js`、`/styles/*.css`、`/lib/marked.min.js`、`/brand-logo.png`
都已经不可访问（vanilla-JS SPA 整体移除；见 `test/lib/static.test.js`）。

### `GET /<file>`

仅从 `webapp/out/` 返回文件，由 `serveStatic` 提供。`public/trajectory/`
下的轨迹工作室由它自己的处理器（独立后端、CSP、令牌策略）挂载到
`/trajectory/`，**不**经过这个静态根。缓存头：

- HTML：`no-cache`（每次重新校验）
- `_next/static/*`（内容哈希）：`public, max-age=31536000, immutable`
- 其他：`public, max-age=3600`

不再有手动的 `?v=N` 缓存破除——`_next/static/<hash>/…` 下的每个
chunk URL 都做内容寻址，rebuild 时自动失效。

---

## 错误响应

所有错误均遵循以下结构之一：

```json
{ "ok": false, "error": "human-readable message" }
```

```json
{ "ok": false, "code": "unsupported", "error": "session/set_mode not implemented by this engine" }
```

```json
{ "ok": false, "error": "LAN 访问已关闭。在本机打开设置开启。" }
```

HTTP 状态码与成因相对应（400 / 401 / 403 / 404 / 409 / 413 / 500 / 501）。
