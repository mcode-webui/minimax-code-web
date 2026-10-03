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

## 状态与 SSE

### `GET /api/state`

返回此 CID 当前的 `state` 对象。完整结构参见
[ARCHITECTURE.md §4](ARCHITECTURE.md)。

**响应 200**
```json
{ "ok": true, "version": "0.5.2", "running": {"active": false}, … }
```

### `GET /api/events`

此 CID 的服务端推送事件（Server-Sent Events）流。连接会无限期保持
打开。事件列表见
[ARCHITECTURE.md §5](ARCHITECTURE.md)。

**响应 200**（`Content-Type: text/event-stream`）
```
event: state
data: {"version":"0.5.2","running":{"active":false},…}

event: delta
data: {"text":"hello","isPartial":true}

event: exec
data: {"status":"ok","durationMs":12345}
```

连接会一直持有，直到客户端关闭（`EventSource.close()`）
或服务器关闭。服务器端不会自动重连；
webui 会以指数退避方式处理重连。

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
并通过 SSE 流式返回结果。

**请求体**
```json
{
  "content": "refactor the workspace picker to use a tree",
  "attachments": ["@/home/you/.mcode-webui/uploads/1790228071891-8d8ec6.txt"],
  "isAskAnswer": false
}
```

- `content`（字符串）—— 用户消息。除非 `attachments` 非空，否则为**必填**：
  composer 会在「只有附件、没有文字」时也让 Send 可点，所以只带一个文件也是
  合法的一轮。
- `attachments`（字符串数组，可选）—— 已上传的文件，取值来自
  `POST /api/upload` 的返回。允许单个前导 `@` 并会剥掉（桌面端的 mention
  约定，composer 就是这么发的）。每个路径必须**落在 `UPLOAD_DIR` 之内且确实
  是文件**，否则拒绝——引用文本会当作用户输入喂给模型，不校验就等于允许调用
  方指名主机上的任意文件。重复项会去重，每轮上限 16 条
  （`MAX_ATTACHMENTS_PER_TURN`）。被拒绝与被丢弃的条数会计数并推到告警通道，
  而不是静默忽略。
- `isAskAnswer`（布尔值，可选）—— 为 `true` 时，内容是对一个进行中的
  `ask_user` 提问的回答，服务端不会向转录追加 `›` 行。由询问弹窗自动设置。

**附件如何抵达引擎。** 以 ACP 的 `resource_link` 内容块发送——
`[{type:"text",…}, {type:"resource_link", name, uri}, …]`——因为引擎自己的
`promptToText`（`packages/tui/src/acp/agent.ts`）只接受 `text` 与
`resource_link`，其余一律报「Prompt content type X is not supported in ACP
P0」。桌面端自己的 `resource` / `image` 块在这里**不合法**。在
`mcode exec` 传输上（没有内容块通道），改为把引擎使用的同一句措辞写入
stdin。

**响应 200** 立即返回 `{ok: true}`。实际响应通过 `/api/events` 流式推送。

**错误**
- `content` 为空**且**没有附件通过校验时返回 400
- 已有回合在飞时返回 409——`reason` 为 `"cid-busy"`（本客户端正忙）、
  `"session-busy"`（另一个客户端正在跑这个会话）或 `"at-capacity"`
  （服务端已达 `MAX_CONCURRENT`，即 `/api/health` 里报的 `maxConcurrent`）

**409 对这条消息是终态，而且它不是失败。** 这个回合不会交给引擎，`›` 行
不会写入，落库记录里也不会有任何东西——被拒的发送不可能被半途应用，也不可能
出现「引擎跑了、转录却丢了」的情形。这里没有发送队列，契约就是「被拒，回合
结束后再发」。

`error` 是面向用户的句子（composer 逐字渲染它），`reason` 是稳定的机读键；
按 `reason` 分支。`cid-busy` 与 `session-busy` 的句子说明「本会话正在跑一个
回合，这条消息未送达」，而不是复述内部 detail——后者写的是「另一个窗口」，
对「同一个标签页隔一会儿再发一次」这个常见情形是错的。

### `POST /api/stop`

取消当前运行。先尝试通过 acp 调用 `session/cancel`
（取消通知会投递到当前 CID 的活动子进程；若通知无法送达，
服务器回退到对子进程发送 SIGTERM，2 秒后升级为 SIGKILL）。

**请求体** `{}`

**响应 200**
```json
{ "ok": true, "wasRunning": true, "cancelled": true, "hardKilled": false, "note": "gentle cancel" }
```

- `wasRunning` —— 该 CID 是否真有活动子进程在背后支撑。
- `cancelled` —— `session/cancel` 通知是否已送达。仅在
  `wasRunning` 且本轮走的是 **ACP** 传输层时才有意义；exec
  传输层没有引擎会话可通知，因此它会回答
  `cancelled:false` 并附带硬杀说明。
- `hardKilled` —— SIGTERM / SIGKILL 级联是否触发。
- `note` —— `"gentle cancel"` 或 `"hard kill (session/cancel could not
  be delivered)"`。这是要读的字段；本响应里**没有**
  `killEndpoint`、`warning` 或 `code`。

本条目早期版本描述的 `{warning, code, killEndpoint}` 字段在本
响应中并不存在；硬杀级联走的正是这条路由本身 —— 客户端若
需要硬杀，请再次调用 `POST /api/stop`。

### `POST /api/cmd`

执行一条 webui **按钮命令**。接受集声明在
`server/lib/interaction/command-registry.js#CMD_BUTTON_COMMANDS`：
`new`、`clear`、`status`、`sessions`、`review`、`help`、`usage`、`stop`。
命令必须是裸的 `/name` 形式——这些命令体不接受参数，分发器匹配的是
斜杠后的整段文本。

本端点**不会**把命令转交 mcode。引擎命令（`/compact` 之类）与手输的
webui 命令（`/goal <内容>`、`/goal-done`、`/goal-blocked`）属于
`POST /api/send`：那里的 `handleLocalSlash` 消费 webui 命令，其余原文
转交引擎。

响应写在分发之后，因此它报告的是命令的结果，而不是“收到了请求”。

**请求体**
```json
{ "cmd": "/clear" }
```

**响应 200** —— 分发器认领了该命令并已执行：
```json
{ "ok": true, "cmd": "/clear" }
```

**响应 400** —— 无人认领；未发生任何状态变更：
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

- `error` —— webui composer 错误条直接显示的字符串。它是面向用户的
  产品文案，与对话界面其余部分一致，使用中文；**不要**拿它做解析。
- `reason` —— 机器可读的判定位。`unknown_command` 是本路由自身产生的
  唯一 reason。`authorize("slash.clear")` 授权被拒**不会**让请求失败：
  `handleCmdCommand` 追加 `● 已取消 /<cmd> (授权未通过: <decidedBy>)`
  到转录后返回 `handled:true`，因此应答仍是 `200 {ok:true, cmd}`，
  且未发生任何状态变更。授权、写前审计（按设计 fail-closed）或命令体
  **自身抛错**才会变成 `5xx`；通用请求门禁会在处理器之前以 `403`
  （`Origin` 不可信、token 无效）或 `429`（限流）拒绝。
- `knownCommands` —— 接受集一并下发，客户端不必自己维护一份清单。
- `suggestion` —— 对 `/goal` 这类 send 路径命令，正文会明确说“请作为
  普通消息发送”，而不是笼统地报未知。

本端点早期版本写的是“服务器将命令发送给 mcode”——路由从来不是这样，
而且响应写在分发之前，于是一条无人认领的命令会得到 `200 {ok:true}`，
输入就此丢失。

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

**响应 200** `{ok: true, session: <完整会话记录>}`

返回的是整条记录而非仅一个 id —— 客户端可直接据此渲染新行，
无需再发一次请求。记录字段：`id`、`title`、`workspace`、
`mcodeSessionId`、`chat`、`createdAt`、`updatedAt`，以及
（一旦设置过的）`titleCustom`。

### `POST /api/sessions/switch`

切换到已有会话。加载其聊天历史，并（若已关联）
重新挂接到对应的 mcode 会话。

**请求体**
```json
{ "id": "uuid" }
```

`id` 接受 webui uuid 或 `mvs_…` 形式的引擎 id。

**响应 200**
```json
{
  "ok": true,
  "session": { "id": "uuid", "mcodeSessionId": "mvs_…", "title": "…", "chat": ["› …", "● …"] }
}
```

`chat` 在此处一并返回，是因为切换是一次客户端必须即时渲染的
导航动作，不能等到下一次 SSE 推送到达。

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

删除没有任何 webui 会话引用的 mcode 会话。**没有请求体，
也没有 `scope` 参数** —— 本路由只删孤儿，永远不会动当前
活动会话。

`?dryRun=true` 在不产生任何副作用的情况下给出预览，也不经授权
闸门（既然没碰任何东西）。真实路径由
`authorize("sessions.cleanup-orphans")` 闸门控制，并带有审计
（删除前追加 `sessions.cleanup-orphans.intent`，删除后追加 `.done`）。

**请求体** —— 无。查询参数：`?dryRun=true`

**响应 200**（预览）
```json
{ "ok": true, "dryRun": true, "count": 18, "ids": ["mvs_5103ca…", "mvs_88c796…"] }
```

**响应 200**（执行）
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

**响应 200**（无事可做）`{ok: true, dryRun: false, deleted: 0, ids: []}`
—— 在授权闸门之前返回，因为根本没东西需要授权。

**响应 403** `{ok: false, error: "authorize declined", decidedBy, decidedAt}`

若 `.done` 审计追加失败，路由会返回 5xx，即使删除已经发生：
—— 操作员必须看到的是审计上的缺口，而不是一个沉默的 200。

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
聊天渲染为 Markdown。

`format=json` → `application/json`：
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

对话内容在 **`messages`** 下，而非 `chat` —— 它是一份合并后的、
带 `role` 标签的列表（webui 转写 + 引擎行），与会话存储里
`chat` 字符串数组的形态不同。`_meta.mcode_unavailable` 报告引擎
侧能否读到；若为 `true`，`mcode_unavailable_reason` 字段说明原因。

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

**响应 200**
```json
{
  "ok": true,
  "workspace": { "dir": "C:\\path\\to\\project", "branch": null, "tree": null },
  "tuiCwd": "/home/you/projects/foo",
  "defaultWorkspace": "C:\\Users\\you\\.mcode-webui\\webui"
}
```

当前工作区嵌套在 `workspace` 下，并非被摊平到顶层。`branch`
和 `tree` 都是 `null` —— 服务器并不会为 git 拉起 shell；早先
版本声称的 `"main"` / `"clean"` 实际从未测量过。

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

### `GET /api/fs/read-file?path=<file>`

以文本读取单个常规文件的内容。驱动右栏文件预览（slice 02 ——
`webapp/components/file-preview.tsx`）。边界与 `/api/fs/read` 相同；
门禁先跑，因此越界路径在文件被 stat 之前就已被拒。

超过 **512 KiB** 的文件返回 `413`，而不是静默截断 —— 调用方
（webapp 预览）渲染一个「过大」状态，并把用户指向真正的编辑器。
响应体仍带探测出的 `mime` / `language`，让 UI 不用二次往返就能
路由到正确的渲染器。

二进制探测扫描前 4 KiB 找 NUL 字节。命中则返回
`ok:false, error:"binary file not supported"` 与 415 状态；webapp
渲染「无法预览」占位。错误路径同样带 `mime` / `language`，让 UI
能提示原因（例如 `.png` 的「图片，请用 raw 端点」）。

**响应 200**
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

`encoding` 成功时为 `"utf-8"`（BOM 已剥离）；`language` 取
`markdown` / `typescript` / `javascript` / `json` / `yaml` / `css` /
`html` / `python` / `go` / `rust` / `bash` / `sql` / `dockerfile` /
`plain` 之一（仅供参考 —— 渲染器可以不理会）。`mtime` 是读取那一刻
的 `stat().mtimeMs`（slice 27）：预览编辑器把它与 `size` 一起记为
冲突检测基线，保存时一并回传 —— 若期间磁盘已变，
`POST /api/fs/write` 返回 `409`。

**错误** —— 400：缺 `path`；403：越界；403 `{code:"credential"}`：
文件名命中凭据形态（除非 `?confirm=1`）；413：超 512 KiB；415：
二进制文件或非常规文件（目录 / 设备 / socket）；500：stat 失败
（请求途中文件消失）。

**凭据判据只看文件名 —— 不覆盖硬链接别名。**
`classifyCredential`（`server/lib/credential-file.js`，在
`webapp/lib/credential-file.ts` 逐字镜像）比对的是请求路径的
**basename** 与凭据形态表。因此该防护覆盖符号链接（读取前由
`realpathSync` 解析），但不覆盖硬链接 —— 共享 inode 的两个名字
（`config.txt → .env`）按 basename 无法区分，因为内核不会仅从
inode 暴露「主名」。在意硬链接别名的运维必须保持工作区树整洁。
`/api/fs/raw` 以流式形式复用同一判据，`/api/fs/search` 再次应用
它（命中标记 `credential: true`，但绝不裁剪内容）。

### `GET /api/fs/raw?path=<file>`

以字节流原样返回文件。供预览里的 `<img>` 与下载动作使用
（slice 02）。边界与 `/api/fs/read` 相同；硬上限 **20 MiB**
（与 pr-22 参照一致）。

`Content-Type` 由扩展名映射，未知扩展名回落到
`application/octet-stream`。`Cache-Control: no-store` —— 本地文件
没有不可变哈希，缓存不能谎报新鲜度。

**响应 200** —— 二进制流。映射表：

| 扩展名 | Content-Type |
|---|---|
| `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.ico` / `.pdf` | 如所列 |
| `.svg` | `image/svg+xml` |
| `.html` / `.htm` / `.css` / `.js` / `.mjs` / `.json` / `.md` / `.txt` | `text/...; charset=utf-8` |
| `.woff2` | `font/woff2` |
| （其他一切） | `application/octet-stream` |

**错误** —— 400：缺 `path`；403：越界；404：不存在；400：不是
常规文件；413：超 20 MiB。

---

### `POST /api/fs/write` —— 保存预览编辑器的缓冲（slice 27）

预览工具栏的保存按钮落在这里。这是文件预览打开的**唯一**写入面，
下面每一条边界都在服务端强制 —— webapp 只是结构化应答的呈现层。

**请求体**
```json
{
  "path": "C:\\Users\\you\\README.md",
  "content": "# Title\n\nedited in the preview panel\n",
  "expectedMtime": 1790609123912.887,
  "expectedSize": 2400,
  "confirm": false
}
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `path` | 是 | 绝对路径（或 `~/...`）；与其余每个 `/api/fs/*` 路由走**同一条** `safePath` → `assertWorkspacePath` 门禁 —— 解析 realpath、感知符号链接、越界即 403 |
| `content` | 是 | 完整文件体的 UTF-8 字符串；非字符串 = 400 `invalid-content` |
| `expectedMtime` | 否 | 打开文件时 `GET /api/fs/read-file` 返回的 `mtime` |
| `expectedSize` | 否 | 同一次读取返回的 `size` |
| `confirm` | 否 | `true` = 用户已通过凭据确认卡（见下） |

**冲突检测。** 两个基线字段中只要有任一存在、且与实时 stat 不再
一致，路由就返回 `409` 并且**什么都不写** —— 外部编辑必须以一个
由用户裁决的冲突呈现，绝不静默覆盖。完全没有基线字段的请求体是
显式覆盖形态；面板只在用户回答了冲突卡（「覆盖磁盘版本」）之后
才发这种请求。

**凭据守卫（对齐 slice 16）。** 命中凭据形态的 basename
（`.env` / `*.pem` / `id_rsa` / `credentials*` 等 —— 与读路由
同一个 `classifyCredential` 判据）默认拒绝，返回
`403 {code:"credential", credentialReason}`，文件不被触碰。
`confirm:true` 既放行写入，也发出与读覆盖相同的
`credential.override` stderr 审计行，只是 `endpoint:"write"`。
理由：服务端会广播局域网 URL，而一个可在网页上编辑的 `.env`
会让每个局域网对端都成为本机配置的作者。

**受控写入。** handler 是在已过门禁的路径上直接
`writeFileSync(path, content, 'utf8')` —— 这条路径上没有 shell、
没有 exec、没有任何命令插值。编辑器只编辑**已存在**的文件；
不存在「从网页新建文件」的通路。

**响应 200** —— 下一次保存应当据以做冲突检测的新基线：
```json
{
  "ok": true,
  "path": "C:\\Users\\you\\README.md",
  "size": 40,
  "mtime": 1790609400000.5
}
```

`path` 是**经 realpath 归一的绝对形态**（共享门禁在做任何别的事
之前先解析符号链接 —— 也就是每个 `/api/fs/*` 路由都返回的
slice-16 形态；在 macOS 上，写 `/var/folders/…` 会应答
`/private/var/folders/…`）。

**错误** —— 400 `missing-path` / `missing-content` /
`invalid-content` / `not-a-regular-file`；403：越界（共享门禁；
路径不存在通常就在这里以 realpath 错误失败 —— 读路由记录的是
同一行为）；403 `credential`（未确认的凭据形态）；404
`not-found`（门禁与 stat 之间文件消失 —— TOCTOU 守卫）；409
`conflict`（响应体带 `{diskMtime, diskSize}`）；413 `too-large`
（内容超 `WRITE_MAX_BYTES`，即读路径的 512 KiB —— 你无法保存
一个当初根本读不下来的东西）；413 `BODY_TOO_LARGE`（JSON 请求体
超共享读取器的 1 MiB 上限）；500 `write-failed`（`writeFileSync`
本身抛出，例如 `EACCES`；磁盘文件未被触碰）。

**凭据判据只看文件名 —— 不覆盖硬链接别名**，与
`GET /api/fs/read-file` 一节记录的一致。

---

### `POST /api/fs/open-default` —— 用系统默认应用打开（slice 14）

把 `path` 交给平台默认的打开器（`open` / `xdg-open` / `cmd` /
`Start-Process`）。边界门禁与 `/api/fs/read` 相同，即
`assertWorkspacePath` + 逐节点 realpath 检查；这个路由的职责只是
JSON 解码请求体，并把 helper 的结构化 code 映射成 HTTP 状态。

**请求体**
```json
{ "path": "/home/you/repo/README.md" }
```

**响应 200** `{ ok: true }`

**错误**（取自 `routes/fs.js#codeToStatus`）：
- `400 {code:"missing-path"}` —— 请求体没有 `path`
- `403 {code:"out-of-bounds"}` —— 边界门禁拒绝
- `400 {code:"not-a-regular-file"}` —— 目录 / 不存在 / 符号链接逃逸
- `503 {code:"no-opener"}` —— 宿主机 `PATH` 上没有 GUI 二进制；
  UI 收到该应答就禁用按钮，使一次点击永远不会静默无效
- `502 {code:"spawn-failed"}` —— 二进制在探测与 exec 之间 ENOENT

### `POST /api/fs/reveal` —— 在文件管理器中定位（slice 14）

与 `/api/fs/open-default` 同一套线上模型；macOS / Windows 选中
文件所在行，Linux 打开父目录（freedesktop 下不存在可移植的
「选中」命令）。

**请求体**
```json
{ "path": "/home/you/repo/README.md" }
```

**响应 200** `{ ok: true }`

**错误** —— 与 `open-default` 完全相同的 code → 状态映射。

---

### `GET /api/fs/search?root=<dir>&q=<glob>[&depth=&maxNodes=&wallMs=&limit=&includeHidden=1]`

按 basename glob 做有界的工作区全量搜索（slice 19a）。已发布的
文件树筛选器只对**已展开**的节点匹配名字，因此三层目录深处的
一个 `package.json` 在用户手动展开每层中间目录之前不会出现任何
结果。这个端点在其余 `/api/fs/*` 路由所用的同一条
`assertWorkspacePath` 门禁之后遍历工作区，并带硬性预算，使恶意
或病态的请求无法把服务端钉死。

用户在筛选框输入且内存中的树没有命中时，面板就调用它。每次调用
是一次往返，返回 `root` 之下的全部命中；面板沿着返回的
`ancestors` 链「展开到命中」。

**查询参数** —— `root` 与 `q` 必填；其余参数都可选且有绝对上限
（超范围的值被钳位，而不是被拒）：

| 参数 | 默认 | 上限 | 说明 |
|---|---|---|---|
| `root` | — | — | 绝对路径或 `~/...`。过 `assertWorkspacePath`；越界 = 403。必须指向一个目录。 |
| `q` | — | — | glob；`*` 任意长串、`?` 单字符、大小写不敏感、锚定匹配。空 = 400。 |
| `depth` | 8 | 16 | 从 `root` 出发的最大目录深度。超出 → `truncated: true, truncatedReason: "depth"`。 |
| `maxNodes` | 5000 | 50000 | 访问过的条目数（文件 + 目录）。超出 → `"nodes"`。 |
| `wallMs` | 1500 | 5000 | 墙钟上限（毫秒）。超出 → `"wallClock"`。 |
| `limit` | 200 | 1000 | 返回的最大命中数。（别名 `maxMatches` 同样接受。）超出 → `"matches"`。 |
| `includeHidden` | 0 | — | `1` 包含 dotfile 条目；默认与文件树「默认隐藏」的行为一致。 |

遍历器默认跳过这些目录（`node_modules` / `.git` 不可覆盖；
构建 / 缓存集合可在服务端用 `includeDirs` 选项重新纳入）：

| 跳过原因 | 默认开？ | 说明 |
|---|---|---|
| `node_modules` | 是（不可覆盖） | 每个 JS 项目的经典搜索陷坑 |
| `.git` | 是（不可覆盖） | 隐私面；绝不是用户的本意 |
| `dist` / `build` / `.next` / `.cache` / `.parcel-cache` / `.turbo` / `.nx` / `coverage` / `.svn` / `.hg` / `.idea` / `.vscode` | 是（服务端可覆盖） | 构建产物与 VCS 元数据，每一个都是已知的遍历陷阱 |
| 巨型目录（readdir 条目 > 10 000） | 是 | 按单目录条目数计，不是按字节 |
| 命中凭据形态的名字 | 标记，从不省略 | 见下方「凭据决策」 |

**响应 200**
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

`ancestors` 是 `root`（不含）到命中（不含）之间的路径片段；顶层命中
对应 `[]`，客户端可以直接用 `path`。遍历器**从不**返回文件内容 ——
`matches[i]` 就是 `path / name / type / ancestors`，加上可选的
`credential` 标记，没有别的。没有 `size` 采样，没有 `mtime` 采样，
没有预览元数据。

**截断是诚实的。** `truncated: true` 是遍历器明确的「我没走完」
信号。原因是锁定的几种：`"depth" | "nodes" | "wallClock" |
"matches"`。UI 显示 `searched N, skipped M, truncated by <reason>`，
让用户知道当前显示的列表是部分的。

**凭据决策 —— 标记，从不省略，从不读取。**
`classifyCredential`（`lib/credential-file.js` 里的 slice-16
判据）是唯一事实来源。命中凭据形态的结果会带着
`credential: true` 与一个稳定的 `credentialReason`（`dotenv` /
`key-file` / `ssh-key` / `credentials` / `ssh-meta` 之一）被**纳入**
结果，同时 `skipped.credential` 递增。理由：

  - 用户有权知道这个文件存在（与 `/api/fs/read` 一致，后者让
    凭据在树列表中保持可见）。
  - 该路径是 realpath 形态；用户主动点击命中后落到
    `/api/fs/read-file`，其 slice-16 门禁会以右栏已在讲的同一个
    `code: "credential"` 应答默认拒绝。
  - 省略命中会让 `q=*.env`（或 `q=.env`）的搜索返回零行 ——
    这在主动误导，因为工作区**确实**包含这些文件。
  - 响应从不携带内容（也不带 size / mtime / 任何预览元数据），
    因此即便用户就是冲着凭据而来，搜索本身也不会成为凭据泄露。

**错误** —— 400：缺 `root` / `q`，或 `root` 不是目录；403：越界
（与其他 `/api/fs/*` 路由同一条消息）；门禁先跑，因此畸形的
`root` 在遍历器启动之前就被拒。

---

## Git

git 端点驱动右栏 Git 面板（slice 03 ——
`webapp/components/panels.tsx#GitPanel`）与 `/review` 斜杠命令。
它们与 fs 端点（`/api/fs/*`）共享同一条边界：候选 `dir` 会经过
`resolve()` 并解析符号链接（`realpath`），且必须落在某个允许
工作区根之内（默认主目录 + 默认工作区 + tmp；
`MCODE_WEBUI_WORKSPACE_ROOTS` 会**完全替换**默认集合）。越界
目录以 `{ok:false, error:"…不在允许根内…"}` 应答 —— 面板把它
显示为空状态，而不是红色 toast。

安全不变量（由 `test/routes/git.test.js` 锁定）：

* `git` 经 `execFile` 以 `['-C', dir, ...args]` 调用 —— 无 shell，
  无元字符攻击面。
* `gitCheckout` 把分支名匹配 `^[A-Za-z0-9._/-]+$`，并额外拒绝以
  `-` 开头的名字（一个叫 `--upload-pack=…` 的分支，否则会被 git
  二进制本身重新解释成 `git checkout` 的选项）。
* `gitDiff` 总是把用户给的文件名放在 `--` token 之后，因此
  `--output=/etc/x` 这样的文件名无法被重新解释成 `git diff` 的
  选项。同一个输入还会被显式的 `startsWith('-')` 守卫先行拒绝。

### `GET /api/git/status?dir=<workspace>`

面板头部与会话标题栏版本标识用的工作区状态。`dir` 必填。

`status --porcelain=v1 -b` 给出确定性输出：一行头部
（`## <branch>[...<upstream>] [ahead N, behind M]`），随后是逐
文件条目。路由解析两半；detached HEAD 或没有 upstream 的分支
只是得到 `null` upstream 与 0 ahead/behind，不算错误。下面两个
HEAD 身份字段由第二次 `git log -1` 提供，它与上面这次查询并发
执行、且跑在同一个已过闸的 `dir` 上，因此整条路由的墙钟耗时
仍是一次 git 往返。

**响应 200**
```json
{
  "ok": true,
  "isRepo": true,
  "branch": "feat/git-panel",
  "upstream": "origin/feat/git-panel",
  "ahead": 0,
  "behind": 0,
  "headSha": "0e99b45",
  "headCommittedAt": "2026-10-01T09:12:33+08:00",
  "files": [
    { "x": "M", "y": " ", "path": "README.md", "origPath": null, "staged": true },
    { "x": "?", "y": "?", "path": "untracked.txt", "origPath": null, "staged": false }
  ]
}
```

`x` / `y` 是原始 porcelain 状态码（见 `git status --help` 的
"porcelain v1 format" 一节）；`staged` 为 `x !== ' ' && x !== '?'`
（索引位置上包含 `M`、`A`、`D`、`R`、`C`）。重命名同时带
`origPath`（改名前路径）与 `path`（改名后路径）。
`isRepo:false` 是对非 git 目录的无错应答。

| 字段 | 含义 |
| --- | --- |
| `headSha` | `git log -1 --format=%h` —— 按 **git 自己的** 缩写长度给出的短编号（默认 7 位，7 位会歧义时更长）。消费方不得写死 7。 |
| `headCommittedAt` | `git log -1 --format=%cI` —— HEAD 的**提交者**时间，严格 ISO 8601。取提交者时间而非作者时间：rebase、amend、cherry-pick 都会把提交者时间推后而作者时间停在最初那次写入，用作者时间会把刚 rebase 过的分支显示成几个月前。 |

unborn HEAD（`git init` 后还没有任何提交）的仓库返回
`ok:true, isRepo:true` 加 `headSha: null` 与 `headCommittedAt: null`
—— 工作区是一个健康的仓库，只是还没有可指名的提交。根本不是
仓库的目录两个字段都不出现，被越权门拒绝的 `dir` 同样不出现，
所以标题栏的版本标识可以把「缺失」与「为 null」当成同一个
「什么都不渲染」。

detached HEAD 仍然返回 `headSha`；此时 `branch` 为 `null`，标识
只显示短编号。

**错误** —— 400：缺 `dir`；请求体是 `{ok:false, error}`，而 HTTP
状态**保持 200**（面板读 `ok` 而不是 HTTP 码，所以非 git 目录
是一个正常状态）。

### `GET /api/git/branches?dir=<workspace>`

本地分支列表加一个 `current` 标记。面板把这个列表渲染成分支
切换器 —— `gitCheckout` 要求被选中的名字也匹配同一集合，因此
切换器永远不会给出一个它无法兑现的选项。

**响应 200**
```json
{
  "ok": true,
  "branches": [
    { "name": "feat/git-panel", "current": true },
    { "name": "main", "current": false }
  ]
}
```

**错误** —— 400：缺 `dir`；git 失败时 `{ok:false, error}`。

### `GET /api/git/diff?dir=<workspace>&file=<path>`

对 `HEAD` 的单文件 diff。未跟踪文件（porcelain 里的 `?`）回落到
`git diff --no-index -- /dev/null <file>`，它生成一份合成的
全新增 diff，于是面板也能预览它们。只要输入文件存在，该回落就
返回 `{ok:true, diff}`（永不报错）；`ok:false` 只留给门禁拒绝或
`git` 调用失败。

**响应 200**
```json
{ "ok": true, "diff": "diff --git a/README.md b/README.md\n…" }
```

**错误** —— 400：缺 `dir` / `file`；边界校验失败或路径非法时
`{ok:false, error}`。软失败路径的 HTTP 状态**保持 200**；面板读
`ok`。

### `POST /api/git/checkout`

切到本地分支。**破坏性** —— 面板在发出请求前用确认框守住这个
按钮。服务端纵深防御：分支名匹配 `^[A-Za-z0-9._/-]+$`，且以 `-`
开头即拒绝，因此伪造的客户端也塞不进选项。

**请求体**
```json
{ "dir": "C:\\Users\\you\\projects\\foo", "branch": "feat/git-panel" }
```

**响应 200** 成功时 `{ok:true}`；门禁 / 白名单拒绝或 `git` 失败时
`{ok:false, error}`。HTTP 状态**保持 200**；面板读 `ok`。

**错误** —— 400：缺 `dir` / `branch`，或 JSON 非法；
`{ok:false, error:"非法分支名"}` 表示白名单拒绝；`git` 失败时
`{ok:false, error}`。

---

## 插件

插件管理（60 号工单阶段①），由 `server/routes/plugins.js` 提供。
每个 handler 都经 catalogue host 打到 `local-runtime-v2` 的
plugin-system；host 在第一次插件调用时懒起，路由自身不持有任何
插件状态。门禁链（CORS → origin/CSRF → 局域网 → token → 限流 →
只读）与 `/api/git/*` 完全一致，从 `app.js` 继承，**没有第二条
鉴权路径**。调用方是 `plugins-surface.tsx`，经
`webapp/lib/api.ts` 发请求。

整组端点有两种应答约定：

- **运行时**失败是 HTTP 200 + `{ok:false, error, code}`，前端按
  `code` 分支；用非 2xx 状态码会把一种预期状态误报成传输故障。
  catalogue host 起不来时，每个端点都应答
  `{ok:false, error:"runtime unavailable", code:"RUNTIME_UNAVAILABLE"}`。
- **请求被拒**是 HTTP 错误：入参缺失或非法为 400
  `{ok:false, code:"invalidBody"}`；三个 facade 校验码
  （`INVALID_PLUGIN_SOURCE`、`PLUGIN_LIMIT_INVALID`、
  `PLUGIN_CURSOR_INVALID`）也是 400，且保留原 code；只读模式下所有
  POST 为 403（门禁 5 的正确行为，不是缺陷）；body 超过 1 MiB 为 413。

`source` 表示插件来源，线上是数字：`1` = 官方（云端 registry），
`2` = 本地（本机上的包）。`GET /api/plugins/marketplace` **必填**
`source` —— 运行时把缺省读成「官方」，若默默取默认值，所有请求都会
打向本地版不可达的 registry。

**响应里**的数字 `source` 按运行时原样透传，路由另外在页面、每个
插件行与每个变更应答上打一个不依赖协议的字符串 `sourceKind` ——
`"official"` 或 `"local"`。webapp 分支判断用 `sourceKind`，这就是
它不必依赖 `@mavis/protocol`（`@mavis/webui` 本来就没有这个依赖）
的原因。`source` 既不是 1 也不是 2 的元素会拿到
`sourceKind:"unknown"`。

阶段①只覆盖 plugins 域。`skills` / `mcp` / `apps` / `agents` 尚无
端点，这四个页签渲染阶段性占位，明说其管理界面在后续阶段开放。
界面现状记录在 [docs/webui.zh-CN.md](../../../docs/webui.zh-CN.md)。

| func_name | 端点 | 面板用途 |
|---|---|---|
| `plugins.list.installed` | `GET /api/plugins/installed` | 已安装列表 |
| `plugins.list.marketplace` | `GET /api/plugins/marketplace` | 市场，每次调用一个来源 |
| `plugins.list.enabled` | `GET /api/plugins/enabled` | 当前轮次可用的插件 |
| `plugins.refresh.all` | `POST /api/plugins/refresh` | 对账按钮 |
| `plugins.enable.by_name` | `POST /api/plugins/enable` | 卡片开关：启用 |
| `plugins.disable.by_name` | `POST /api/plugins/disable` | 卡片开关：停用 |
| `plugins.install.by_name` | `POST /api/plugins/install` | 官方安装 |
| `plugins.uninstall.by_name` | `POST /api/plugins/uninstall` | 删除，先弹确认 |
| `plugins.import.preview_url` | `POST /api/plugins/import/preview` | 导入对话框试算 |
| `plugins.import.from_url` | `POST /api/plugins/import` | 导入对话框提交 |

**哪些是真数据、哪些是占位。** 已安装列表、本地市场（`source=2`）
与两个 GitHub 导入端点都是**真数据** —— 导入链直接抓公网仓库，
不经云端 registry。官方市场（`source=1`）与官方安装 / 启停 / 卸载
动作是本阶段**唯一**的诚实占位：本地版的云端基址不可解析，官方列表
应答 `{ok:false}`，面板渲染 `plugins.market.official.notLocal.*`
文案而不是错误弹窗。四个非插件页签渲染各自的阶段性占位
（`plugins.area.<domain>.pending.*`）。

### `GET /api/plugins/installed?keyword=&limit=&cursor=`

**func_name** `plugins.list.installed`。已安装插件，官方与本地两段
合并，取一页。`keyword` 按名字过滤；`limit` 默认 50、上限 200；
`cursor` 是 `nextCursor` 给出的不透明前向游标。

**响应 200**
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

空态是 `{ok:true, plugins:[], hasMore:false}` —— 没装插件是一个
答案，不是错误。`hasMore:true` 时带 `nextCursor`。请求在途期间面板
显示骨架行。

**错误** —— 入参非法 400：`limit` 非正整数或 `category` 非整数是
`code:"invalidBody"`；对别的 `keyword` 签发的游标复用后是 400 +
`code:"PLUGIN_CURSOR_INVALID"`（面板丢弃游标重新起列表）。运行时
失败是 200 + 自己的 `code`。注意 webapp 的封装把任何非 2xx 变成
一个带服务端 `error` 文本的抛出异常，所以面板的防线是「筛选变化就
重置游标」，而不是在失败之后去解析 code。

### `GET /api/plugins/marketplace?source=&keyword=&limit=&cursor=&category=&skillLimit=&skillCursor=`

**func_name** `plugins.list.marketplace`。`source` 必填（见上文
「插件」）。`category` 是数字分类 id（0 other … 10 education）；
`skillLimit` / `skillCursor` 给独立技能分段翻页。

**响应 200**
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

市场摘要自身不带 `source` —— 整页**就是**一个来源 —— 所以路由按请求
的 source 给每一行打 `sourceKind`。空态是 `{ok:true, source,
sourceKind, plugins:[], hasMore:false}`。`marketplaceSkills` 是本地
分支投影出的独立技能，与插件行并列返回（`source=2` 才有），是否与
插件卡混排由面板决定。官方分支还可能带 `cursorResetRequired:true`，
表示 registry 拒收该游标，调用方应从第一页重来。

**错误** —— `source` 缺失或不是 `1`/`2`、`limit` 非正整数、
`category` 非整数均为 400（`code:"invalidBody"`）；本地版里
`source=1` 应答 `ok:false`（云端基址不可达），面板为其渲染
notLocal 占位；`source=2` 的失败按普通错误处理。

### `GET /api/plugins/enabled`

**func_name** `plugins.list.enabled`。当前运行时快照里处于启用
状态的插件 —— 比已安装列表窄，后者还含被停用的条目。

**响应 200**
```json
{ "ok": true, "plugins": [{ "name": "acme-notes", "displayName": "Acme Notes" }] }
```

空态是 `{ok:true, plugins:[]}`。

**错误** —— 运行时不可达时 200 `{ok:false, error, code}`；无入参，
不会有 400。

### `POST /api/plugins/refresh`

**func_name** `plugins.refresh.all`。对两个来源做安装态对账。无入参；
请求体被读空后忽略。

**响应 200** `{ok:true}` —— 应答不含数据，调用方随后重拉
`GET /api/plugins/installed`。在途期间面板在刷新按钮上显示
spinner。

**错误** —— 200 `{ok:false, error, code}`，透传运行时原 code；
只读模式 403。

### `POST /api/plugins/enable`

启用插件。**func_name** `plugins.enable.by_name`。

### `POST /api/plugins/disable`

停用插件；其回合 hook 随之失活，而正在该插件上跑的会话不受打断。
**func_name** `plugins.disable.by_name`。

### `POST /api/plugins/install`

安装插件。本地版只有官方源可安装 —— 对本地包会得到
`LOCAL_PLUGIN_INSTALL_UNSUPPORTED`，面板因此不渲染该按钮。
**func_name** `plugins.install.by_name`。

### `POST /api/plugins/uninstall`

卸载插件。**破坏性** —— 面板先弹确认框；目标不存在时是幂等
成功而非失败。**func_name** `plugins.uninstall.by_name`。

这四个端点共用一份 body 与一种应答形态。

**请求体**
```json
{ "pluginName": "acme-notes", "source": 2 }
```

`source` 可选；缺省时按原样透传，而运行时把缺省读成「官方」—— 所以
知道插件来自哪一侧的调用方应该传它。`pluginName` 缺失或空白、
`source` 既不是 1 也不是 2，均为 400 `invalidBody`。卸载一个不存在的
目标是**幂等**成功，不是失败。

**响应 200**
```json
{ "ok": true, "source": 2, "sourceKind": "local", "installExists": true, "enabled": false }
```

`installExists` 表示插件是否在盘上；`enabled` 是操作后的状态。
调用期间面板显示行内 spinner。

**错误** —— `PLUGIN_NOT_FOUND`、`PLUGIN_AUTH_REQUIRED`、
`PLUGIN_AUTH_SYNC_TIMEOUT` 以 `code` 出现在 200 应答里；路由读不懂
的 body 是 400 `invalidBody`；只读模式 403。官方变更动作是本表面的
另一半占位：本地版里 `PLUGIN_AUTH_REQUIRED` 是它们的预期答案，面板
保持静默而不弹提示。

### `POST /api/plugins/import/preview`

**func_name** `plugins.import.preview_url`。解析一个 GitHub 链接并
报告导入会带来什么，不实际安装。它直接抓公网仓库 —— 不需要云端
账号，不经 registry。

**请求体**
```json
{ "url": "https://github.com/acme/mcode-plugin" }
```

**响应 200**
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

`source` 是提交导入时要用的钉死坐标；`canImport:false` 配
`diagnostics` 也是一个合法答案，对话框展示诊断而不是报错。抓取
期间面板显示加载态。

**错误** —— body 非法 400；URL 非法、公网不可达、
`PLUGIN_NO_SUPPORTED_CAPABILITY`、`PLUGIN_IMPORT_UNAVAILABLE`
均为 200 `{ok:false, error, code}`。

### `POST /api/plugins/import`

**func_name** `plugins.import.from_url`。安装试算解析出的插件，
应答带插件摘要，且已是启用态。

**请求体**
```json
{
  "source": {
    "repositoryUrl": "https://github.com/acme/mcode-plugin",
    "commitSha": "0f1e2d3",
    "subPath": "packages/notes"
  }
}
```

`subPath` 可选，用于在 monorepo 中定位某一个插件。

**响应 200**
```json
{ "ok": true, "plugin": { "name": "acme-notes", "displayName": "Acme Notes", "enabled": true, "capabilities": { "appCount": 0, "mcpServerCount": 0, "skillCount": 2 } } }
```

**错误** —— 插件已导入为 `PLUGIN_ALREADY_EXISTS`，坐标不可用为
`PLUGIN_IMPORT_INVALID`，两者都在 200 应答里；只读模式 403。

---

## 回合改动

运行时按回合记录该回合改动的文件——带真实的增删行数，并且能把工作区
还原回去。这三个端点把这份记录透出来。它们存在的原因是转录本身答不了
这个问题：转录只带工具提到的文件路径，永远不带行数，也永远不带引擎关于
「这一回合现在还能不能改」的判断。

| func_name | 端点 | 卡片用途 |
|---|---|---|
| `sessions.diff.get_turn` | `GET /api/turn-diff` | 读回合的计数与门控 |
| `sessions.diff.revert_turn` | `POST /api/turn-diff/revert` | 撤销按钮 |
| `sessions.diff.reapply_turn` | `POST /api/turn-diff/reapply` | 重做按钮 |

### 回合坐标

三个请求都带 `assistantMessageId`——该回合**最后一条助手消息**的
msg_id，也正是运行时落库这条记录时用的值。webapp 从转录里拿到它：服务端
在回合结算时写一行 `§§ turn_msg=<id>` 标记（`server/lib/mcode-acp.js#finalize`），
转录回读则用运行时自带的 `turn_id` / `msg_id` 两列合成同一行
（`server/lib/transcript.js`）。

`assistantMessageId` 在三个端点上都是**必填**，而它的缺失不算客户端错误——
那是「本回合没有坐标」的情形，应答 `{"ok":true,"turnDiff":null}` 且
**不调用引擎**。原因在引擎自己的选择器
（`local-runtime/src/turns/diff-api.ts:209-220`）：不给 id 时它会退化成
`latestForSession`，于是一个丢了坐标的请求会答出**别的回合**的计数，撤销
按钮就会去改那个回合的文件。没有坐标的回合渲染纯路径卡。

路由只触及运行时 `applications` 树里的一个成员 `applications.session.diff`。
同一棵树上还有 `session.lifecycle`，它能删会话；把这一层放宽成「整个
applications 句柄」等于把删会话的能力交给一个 diff 端点。

### `GET /api/turn-diff?sessionId=&assistantMessageId=`

**func_name** `sessions.diff.get_turn`。`sessionId` 是**引擎**的会话 id
（`mvs_` + 32 位十六进制），即 `state.mcodeSessionId` 上的那个。

**响应 200**
```json
{
  "ok": true,
  "turnDiff": {
    "fileChanges": [
      { "file": "webui-turn.txt", "additions": 2, "deletions": 0, "status": "added" }
    ],
    "sourceMessageId": "ed8b9ddd-9bb0-4b06-a8fc-e863036830e3",
    "changeSetId": "cs_ffc8873c6",
    "status": "active",
    "undoable": true,
    "canUndo": false,
    "canReapply": false
  }
}
```

`canUndo` / `canReapply` 是引擎自己的答案，卡片必须据此画两个按钮，不得
自行判断。只有**最新**回合的 diff 能改；引擎会在用户点击之前就用
`canUndo:false` 说出来，真点了也回 409。

`additions` / `deletions` 是**该回合**的前后行数差，不是工作区相对 HEAD 的
diff。`previewState` 协议里有定义，但这条链路恒为 `undefined`——不要渲染它。

**应答**

- `200 {"ok":true,"turnDiff":null}` —— 请求没带坐标，或该 id 没有记录
  （没动过文件的回合根本不落库）。
- `400 {"ok":false,"code":"invalidRequest","error":"sessionId must look like mvs_<32 hex> …"}` —— `sessionId` 形状不对。
- `404` —— 引擎不认识这个会话。
- `200 {"ok":false,"code":"RUNTIME_UNAVAILABLE"}` —— 运行时应用起不来。

### `POST /api/turn-diff/revert`

**func_name** `sessions.diff.revert_turn`。body 为
`{ "sessionId", "assistantMessageId" }`。

把工作区文件还原到该回合之前的内容：引擎先逐个校验文件与当时捕获的快照
一致，再写回或删除。**这是真的写文件。** 回合之后被改过的文件会被拒绝，
而不是被覆盖。

**响应 200** `{"ok":true,"turnDiff":{…}}`——撤销后的记录；`status` 为
`reverted`，`canReapply` 变为 true。

**错误** —— 回合不是最新回合（`Only the latest turn diff can be changed`）
或文件已与快照不符，均为 409 `TURN_DIFF_CONFLICT`；未知会话 404；
`sessionId` 形状不对 400；只读模式 403。客户端原样显示引擎的消息——只有
那句话能说明是这两种拒绝中的哪一种。

### `POST /api/turn-diff/reapply`

**func_name** `sessions.diff.reapply_turn`。body 与坐标规则同上。把该回合的
改动在撤销之后重新放回去。

**响应 200** `{"ok":true,"turnDiff":{…}}`，`status:"active"`、
`canUndo:true`。错误集与 revert 相同。

### 一次成功变更要刷新什么

撤销或重做改的是浏览器正在显示的文件，因此服务端做两步，客户端靠同一帧
做剩下三步：

| 步骤 | 谁 | 做什么 |
|---|---|---|
| 会话树缓存 | 服务端 | `invalidateSessionTree()`——缓存的树与磁盘不再一致 |
| 广播 | 服务端 | 依次发 `session-tree-changed` 与 `workspace-files-changed` 两帧 SSE |
| 文件树 | 客户端 | 监听 `workspaceRevision`，重读所有已展开的目录 |
| 文件预览 | 客户端 | 走刷新通道重读当前文件（保留滚动位置；有未保存草稿则不动） |
| git 面板 | 客户端 | 重读 status 与 branches |

`workspace-files-changed` 是一个新的无载荷命名 SSE 帧。它是 webui 唯一能
得知「磁盘上的文件在自己脚下变了」的信号：转录没变，回合流里也没有任何一帧
在说这件事。

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

返回模型清单，来源是**引擎会话自身的配置项** —— 既非内置
列表，也不是从引擎二进制里解析的。`listModels` 是按会话
的，因此在尚无会话时无可报告内容。

**响应 200**
```json
{
  "ok": true,
  "current": "minimax_api/MiniMax-M3",
  "source": "acp-session-config",
  "models": [
    { "id": "minimax_api/MiniMax-M3", "name": "MiniMax-M3" }
  ]
}
```

- `models[]` 条目形态为 `{id, name}` —— `id` 是引擎配置项
  的值，`name` 是它的展示标签。本字段不存在 `label` 或 `provider`。
- `current` 是该选项的 `currentValue`；当会话尚未上报时
  为 `null`。本字段从不基于猜测回填：早先版本会把默认
  模型反写进 `cs.model`，正是在后续提示符要用的状态里塞进
  一个臆造的名字。

若列表为空，响应会附 `reason: "no_session_config"`。此时
`current` 字段为 `null`；任何东西都不会被反写。

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

`warning` 区分与 [`POST /api/permissions`](#post-apipermissions) 同样的三种情况 —— `no_acp_session`（当前走 exec 传输层 —— 结构性问题，从下一轮生效）与 `no_client`（预期走 ACP 但尚无已注册的客户端）。

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
- 无论如何都会把变更记入 `cs.permissions`，这正是决定使用
  哪种传输层、以及为下一条提示词提供 `mode` 值的地方。

**警告** —— `mcodeSynced: false` 伴随着一条说明具体情况的
`warning`，因为这并非同一种问题：

- `no mcode session yet — applies to the next one` —— 该 CID
  还没有创建任何引擎会话。
- `no_acp_session`："这一轮走的是 exec 传输层，它没有可更新的
  引擎会话 —— 变更从下一轮起生效。"引擎传输层由权限模式决定
  （`runMcodeAcp` 在模式不为 Full access 时一律走 exec），
  而一次性 `mcode exec` CLI 没有可以寻址的持久会话。这是
  结构性的问题，不是服务故障。
- `no_client` —— 预期走 ACP 但目前还没有已注册的客户端。

**缺失或为空的 `mode` 并不是 400。** 路由读取的是
`(payload.mode || "full")`，因此缺失的 `mode` 会被解析为
"Full access" 而非报错。请始终显式传入 `mode`，不要依赖默认值。

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
    { "value": "default",          "label": "Ask" },
    { "value": "bypassPermissions","label": "Full access" },
    { "value": "auto",             "label": "Auto" },
    { "value": "off",              "label": "…" },
    { "value": "read",             "label": "Read" },
    { "value": "full",             "label": "…" }
  ]
}
```

`webui[]` 是 UI 提供的精选四项。`mcode[]` 是引擎完整的
`PERMISSION_MODES` 列表 —— 共六个值，额外包含 `off` 与 `full`，
而这两者不会出现在 `webui[]` 投影里。标签由 `mcodePermissionToWebui`
提供；`off` 和 `full` 在 webui 中没有别名，因此其标签就是该
映射给出的结果。

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

**响应 200**
```json
{ "ok": true, "deprecated": true, "note": "use /api/send for new flow" }
```

本路由是**遗留的空操作（no-op）**：它仅记录调用日志，不采取
任何动作即作答。回应请走 `POST /api/send`，载荷为
`{content, isAskAnswer: true}`。`deprecated: true` 永远都会出现 —— 仅检查
`ok` 的客户端会一直调用一个什么都不做的端点。

### `GET /api/providers`

返回合并后的 v2 provider 目录，其中每个 `apiKey` 都是掩码形态
（`apiKeyMasked`）—— 明文凭据在任何响应路径里都不会被返回。
响应还会报出服务端对每一层实际读取了哪些文件路径，便于运维确认
现网配置来自哪个文件。

分层解析顺序：`MCODE_WEBUI_MODELS_CONFIG` 环境变量 → cwd 下的
`models.json` → 引擎的 `<引擎数据目录>/config.yaml` 里的
`custom_provider` 节点（PUT 的写入目标）。同 id 的 provider 做深
合并；模型按 id 去重，高层胜出。

env 与 cwd 两层由部署方拥有，任何 handler 都不写。第三层过去是
webui 自己的文件（`~/.mcode-webui/providers.json`），现在是引擎
自己的 provider 存储；那个文件已**废弃**，详见下文 `PUT /api/providers`
一节。

**响应 200**
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

- `auth.apiKeyMasked` 是本接口族**唯一**返回的 apiKey 形态。测试
  与 `scripts/check-docs-alignment.mjs` 一起把这条规则钉死：无论
  密钥来自哪一层，明文 key 都绝不允许出现在任何
  `/api/providers*` 响应中。
- `sources.user` 与 `userPath` 仍然指向**已废弃**的
  `~/.mcode-webui/providers.json`。字段没变，取值也没变：两者的
  文档语义都是「服务端解析了哪些文件」，运维排查 provider 缺失时
  仍然需要知道该看哪里。变的是答案——该文件只在迁移完成前被读取，
  此后不再被写入。真正的目录在引擎存储里，`GET /api/models` 也
  是从那里读的。
- `MCODE_WEBUI_MODELS_CONFIG` 未设置时 `sources.env` 为 `null`；
  此时 `sources.cwd` 也从层级集合中省略（环境变量覆盖的就是 cwd
  那个文件）。

### `PUT /api/providers`

校验并持久化一份 v2 provider 配置到**引擎的 provider 存储**——
`<引擎数据目录>/config.yaml` 的 `custom_provider` 节点，文件权限
`0600`。env / cwd 两层由部署方拥有，本 handler 不写；已废弃的
`~/.mcode-webui/providers.json` 同样不写。
env / cwd 两层归部署方所有，永远不在这里被写。

handler 通过 rename 原子写入（磁盘上不会出现半写文件），下一次
调用时重载层级集合，并以掩码载荷广播一个 SSE 具名事件
`providers.updated`，让每个已连接客户端无需轮询就刷新自己的
目录。`/api/models` 在下一次请求时即可看到变更 —— 无需重启。

**请求体**
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

**响应 200**
```json
{
  "ok": true,
  "providers": [ /* 掩码视图，形态与 GET 相同 */ ],
  "path": "/home/you/.minimax/config.yaml",
  "engineSync": { "ok": true, "written": true, "keys": ["openai_compat"] }
}
```

- `path` 是本 handler 实际写入的文件：引擎的 `config.yaml`。它
  过去是 `~/.mcode-webui/providers.json`。
- `engineSync` 报告这次存储写入本身。`written: false` 表示文档
  内容不会变化——空转的 PUT 不会去重设运维刚手工编辑过的文件权限。
  只要存储接受了写入，它就是 `ok: true`。

**能力门控。** 两个写端点（`PUT /api/providers` 与
`POST /api/providers/preset/:id/enable`）声明 `authCredentials`
能力，并对自己的子项（`updateUserModelProvider` /
`createUserModelProvider`）做**硬**门控。声明缺失该子项的 provider
会得到 `501 {ok:false, code:"engine_capability_not_supported", …}`，
而不是确认一份引擎永远不会读取的配置。在默认的 `acp` 传输下尚未
注册任何 provider，门控报告 `unregistered-transport`，写入照常进行。
三个读端点声明同一能力，做**软**门控——只报告降级，继续服务。

**存量迁移。** 引擎存储里没有迁移标记时，已废弃的
`providers.json` 仍然是权威来源：webui 会在每次读取时尝试把它
无损折叠进存储，成功后写入标记，该文件此后再不被读取。迁移失败
（引擎配置无法解析、写入失败）时存储保持原样，旧格式继续可读，
下一次读取会重试。目录字段逐项等价由
`packages/webui/test/lib/engine/provider-migration.test.js` 钉死。

- `400 BAD_BODY` —— provider 形态非法、协议未知，或校验失败
  （每条错误都带一条可读的 `error` 文本，指出出问题的字段）。
- `500 WRITE_FAILED` —— 存储拒绝或未能完成写入。两种成因，其
  中第二种才是重点：无法解析的 `config.yaml` 会被**拒绝，绝不覆盖**，
  因为覆盖会连带毁掉存储并不拥有的全部引擎配置。两种情况下前一份
  文档都保持完整，随后的 `GET` 返回客户端原本就有的目录，运维可以
  直接重试。

### `POST /api/providers/test`

按协议跑一次最小连通性探测。**本地 key 格式校验发生在任何网络
调用之前** —— 畸形 key 直接得到 `400 INVALID_KEY`，不发任何
请求。探测成功返回 `{ok:true, latencyMs, detail}`；网络失败返回
`502 PROBE_FAILED` 并带上游状态码（不返回响应体 —— 配错的代理
可能在上游错误消息里回显凭据）。

**请求体**
```json
{
  "protocol": "openai",
  "auth": { "type": "byok", "apiKey": "sk-realkey...", "baseURL": "https://api.openai.com" }
}
```

**响应 200**（探测成功）
```json
{ "ok": true, "protocol": "openai", "code": "OK", "latencyMs": 187, "detail": "HTTP 200" }
```

**响应 400**（key 畸形 —— 未发生任何网络调用）
```json
{ "ok": false, "protocol": "openai", "code": "INVALID_KEY", "error": "auth.apiKey is too short (< 8 chars)" }
```

**响应 502**（上游拒绝了请求）
```json
{ "ok": false, "protocol": "openai", "code": "PROBE_FAILED", "error": "HTTP 401", "latencyMs": 412 }
```

- 协议白名单：`openai`（`GET /v1/models`）、`anthropic`
  （`POST /v1/messages`，模型 `claude-3-5-sonnet-20241022`、
  `max_tokens:1`）、`gemini`（`GET /v1beta/models?key=...`）。
  其余一律返回 `400 BAD_PROTOCOL`，不发网络请求。
- key 只发往请求体里的那个 `baseURL`（缺省时用协议默认值）。
  明文 key 在任何响应路径上都不会离开服务端。

### `GET /api/providers/presets`

内置预设 provider 画廊（02 号工单）。响应列出全部策展模板
（当前 **11** 个 —— 智谱 / Kimi / 百炼 / 火山 / mimo / minimax /
opencode go / OpenRouter / Claude Code / Codex / DeepSeek），以及
每一个在启用时会写入用户级文件的元数据。`enabled` 标记与
`enabledIds` 数组标出那些 id 已出现在已配置目录中的模板，于是 UI
无需二次往返就能渲染「已启用」/「启用」按钮。

模板永不携带密钥材料：`apiKey` / `apiKeyMasked` / `hasKey` 在
画廊载荷中**有意缺席**。用户在启用预设之后再填凭据。

预设的 `auth.type`（`byok` 或 `coding-plan`）在这一层目前只是
**装饰性的**：没有任何代码路径据此分支，一个已启用但 key 为空的
预设被引擎消费的方式与一条 byok 记录完全相同。该标签会被保留在
持久化记录上，好让未来的订阅鉴权行为（按 provider 的 key 流程、
自动刷新、分层配额）有一个稳定的挂载点；它**今天不改变**任何
行为。

**响应 200**
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

把一个预设一键物化进用户级目录。handler 解析模板、把它合并进
现有目录、通过与 PUT 相同的 `writeProvidersConfig` 流水线写盘
（原子 rename、完整 v2 校验门），并广播标准的 `providers.updated`
SSE 事件，让每个已连接客户端刷新目录。下一次 `/api/models` 读取
即可看到新条目，无需重启（用户级文件每次调用都会重读）。

幂等：对同一个 id 的第二次调用返回 `200` 与
`alreadyEnabled: true` 以及既有的掩码记录，而不是覆盖用户之后对
`apiKey` / `baseURL` 的修改。与某个预设同 id 的**自定义** provider
**不会**被覆盖 —— handler 在同一套幂等契约下返回既有记录。

持久化记录的 `apiKey` 起始为空；用户通过自定义 provider 界面的
同一个表单填写。

**响应 200**（新启用）
```json
{
  "ok": true,
  "alreadyEnabled": false,
  "provider": { /* 掩码视图，形态与 GET 相同 */ },
  "path": "/home/you/.mcode-webui/providers.json"
}
```

**响应 200**（幂等 —— 预设已配置）
```json
{
  "ok": true,
  "alreadyEnabled": true,
  "provider": { /* 既有的掩码记录 */ }
}
```

- `400 UNKNOWN_PRESET` —— `:id` 不是已知模板。
- `500 WRITE_FAILED` —— 存储拒绝或未能完成写入。两种成因，其
  中第二种才是重点：无法解析的 `config.yaml` 会被**拒绝，绝不覆盖**，
  因为覆盖会连带毁掉存储并不拥有的全部引擎配置。两种情况下前一份
  文档都保持完整，随后的 `GET` 返回客户端原本就有的目录，运维可以
  直接重试。

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

- `contextUsed = totalInput + totalOutput + totalReasoning` —— 缓存
  计数器是 input 的子集，不构成额外的上下文。
- `modelLimit` 来自模型的配置，模型未知时为 `null`。
- 数据库或会话记录缺失时为 `found: false`（附 `dbExists`）—— 见下方 404 形态。

### `POST /api/refresh`

把调用方当前的状态推给它自己的 SSE 客户端。用量弹层的刷新按钮会先调用它，随后
再调 `POST /api/usage` —— 真正重新从引擎读取配额的是后者。

**响应 200** `{ok: true}`

### `GET /api/usage/forecast`

预测配额耗尽时间。读取 `$WEBUI_DATA_DIR/usage-history.ndjson`
并对 5 小时与每周窗口做外推。尽力而为：历史文件缺失或为空
时仍然返回 `200`，以便 UI 渲染"数据收集中…"占位，而不是抛错。

**响应 200**
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

**响应 200**（数据还不够）—— 数值字段仍然出现但为 `null`，不会坍缩：
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

`reason` 取值为 `"no_history"`（文件缺失或为空）或
`"insufficient_samples"`（少于 3 个样本）。`hoursUntilExhaustion*`
始终是一个未来时刻 —— 模型会把已耗尽的情形夹到"不会耗尽"，
而不是给出一个负值。

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

返回引擎的 `agentInfo`（取自 `initialize` 应答）与
**engine-capabilities 视图**：当前引擎 provider 声明的 14 键能力面，
也就是 `GET /api/engine-capabilities` 所服务的同一份声明。webui 用它来
决定启用哪些 UI 控件。

**这个字段的契约在 M3 批次 B4 变更过。** `capabilities` 过去承载
`MCODE_ACP_CAPABILITIES`——一张手工维护的扁平 `{方法: 布尔}` 表，描述
ACP JSON-RPC 面（`set_mode`、`set_config_option`、`cancel`、`activate`、
`fork`、`resume`、`delete`、`load`、`close`、`list`、`new`、
`prompt`）。这 12 个键**已经没有了**：读 `capabilities.set_mode` 的消费方
现在拿到 `undefined`，会响亮地失败。顶替它们回答的是另一个问题
——**「引擎到底有没有这项能力」**——用 14 个矩阵键，每项形如
`{level, missing?, reason?}`。ACP wire 表仍从
`server/lib/mcode-rpc.js` 导出，且仍是对**引擎** ACP 面的真实陈述；
它只是不再随这个端点返回。

声明在响应里只出现一次，就在 `capabilities` 下；三个兄弟键说明它从哪来
以及该拿它的缺口怎么办。

**响应 200**
```json
{
  "ok": true,
  "mcodeVersion": "0.5.2",
  "mcodeName": "mcode",
  "mcodeTitle": "mcode",
  "capabilities": {
    "sessionCrud": { "level": "full" },
    "streamingSend": { "level": "full" },
    "interrupt": { "level": "full" },
    "toolSkillInvocation": { "level": "full" },
    "turnDiff": { "level": "full" },
    "turnRewindRedo": { "level": "full" },
    "plugins": { "level": "full" },
    "mcp": { "level": "full" },
    "subagents": {
      "level": "partial",
      "missing": ["getDelegationSnapshot", "stopDelegation"],
      "reason": "delegation snapshot/stop live on the TuiRuntimeAdapter access-context, not on the v2 CliService surface (design §1.3 v2)"
    },
    "usageStats": { "level": "full" },
    "authCredentials": { "level": "full" },
    "updateCheck": {
      "level": "none",
      "reason": "interface-absent: no update-check method anywhere in local-runtime-v2 (design §1.3 v2)"
    },
    "fileReadWrite": {
      "level": "partial",
      "missing": ["file-write"],
      "reason": "workspace read browsing only; no write API — writes go through in-turn tools (design §1.3 v2)"
    },
    "gitOperations": {
      "level": "partial",
      "missing": ["git-diff", "git-commit", "git-branch"],
      "reason": "read-only metadata + review link; change mutation is outside this package (same discipline as v1's read-only Git facade)"
    }
  },
  "capabilitiesProvider": "local-runtime-v2",
  "capabilitiesProviderFor": "transport",
  "capabilitiesUnavailable": {
    "none": ["updateCheck"],
    "partial": [
      { "key": "subagents", "missing": ["getDelegationSnapshot", "stopDelegation"] },
      { "key": "fileReadWrite", "missing": ["file-write"] },
      { "key": "gitOperations", "missing": ["git-diff", "git-commit", "git-branch"] }
    ]
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

`capabilitiesProvider` 是应答了的那份声明所属的 provider，
`capabilitiesProviderFor` 说明它是**怎么**被选中的。消费方应当对后者
分支：

- `"transport"`——当前 `MCODE_WEBUI_TRANSPORT` 自己的已注册 provider
  应答的。
- `"default"`——尚无任何 provider 声明该传输（M4 引入），由默认
  provider 的声明顶替。这份视图仍是一份真实且经评审的声明，但它未必
  是已连接引擎的那份；把它当成后者报出去就是撒谎。

`capabilitiesUnavailable` 是能力驱动型 UI 据以渲染的降级摘要：`none`
的键意味着隐藏整个入口，`partial` 的键意味着恰好隐藏或禁用列出的那些
子动作。它是唯一一个并非声明本身的字段，消费方不该被迫从一个有三级
两可选字段的分类法里重新推导它。

---

## 授权决策

服务器侧授权闸门（`server/lib/authorize.js`）会在执行破坏性
操作前向用户申请确认（`session.delete`、
`sessions.cleanup-orphans`、`session.cleanup-all`、`session.export`、
`session.search`、`token.reset`、`slash.clear`、`startup.cleanup`）。
所有待决请求都通过下面这一个端点暴露 —— 客户端 UI 弹出
授权框，用户点允许 / 拒绝，决策经此端点回写。操作白名单
与默认 5 分钟超时见 [CAPABILITIES.md §13](CAPABILITIES.md)。

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

覆盖某个 CID 内存中的若干状态切片，用于在没有真实引擎的情况下
演练 UI。每个字段都是可选的；传入了就替换，未传入则保持原状。
**这不是**一个原始 SSE 事件注入器 —— 它修改的是状态，然后由
正常推送路径把它广播出去。

**请求体**（CID 取自 `?cid=` 查询参数，而非请求体）
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

## 引擎能力

### `GET /api/engine-capabilities?provider=`

只读、声明直出：返回某个 provider 在 14 个引擎能力键上的支持档位，
附前端能力驱动渲染所用的 `unavailable` 汇总。不起 host、不探测。
`?provider=` 缺省为 `local-runtime-v2`；另一个已注册面是
`tui-runtime-adapter`。

**Response 200**
```json
{
  "ok": true,
  "provider": "local-runtime-v2",
  "transport": "runtime",
  "capabilities": {
    "sessionCrud": { "level": "full" },
    "plugins": { "level": "partial", "missing": ["…"], "reason": "…" },
    "updateCheck": { "level": "none", "reason": "interface-absent: …" }
  },
  "unavailable": { "none": ["updateCheck"], "partial": [{ "key": "plugins", "missing": ["…"] }] }
}
```
（`capabilities` 实际含全部 14 键；此处示例 3 个。）

**错误** —— `?provider=` 写错答 `404 {"ok":false,"code":"unknown_engine_provider","knownProviders":[…]}`（调用方的错，绝不会是 501）。未来任何按能力门控的路由，调到未声明能力答 `501 {"ok":false,"code":"engine_capability_not_supported","capability","provider","missing"?,"reason"?}`——这是预期降级、不是服务端故障；按「隐藏入口」处理，不弹错误提示。

契约细节（14 键总表、两个 provider 的档位、迁移状态）见
[`docs/webui.zh-CN.md`](../../../docs/webui.zh-CN.md) 的
「引擎能力声明」一节。

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
