# 能力清单

> 简体中文 | [English](CAPABILITIES.md)

> 本文档是本 webui 能做什么、不能做什么的唯一事实来源。每一行都包含
> 一个状态（✅ 可用 · ⚠ 部分可用 · ❌ 受阻）、原因，以及在代码中
> 应该查看的位置。

webui 受三项约束限制：
1. mcode 0.1.5 acp 通过 JSON-RPC 暴露的能力。
2. Node `http` / `child_process` API 能做的事。
3. 浏览器 `WebSocket` 与 `fetch` 能做的事。

超出这三者范围的功能要么是 ❌ 受阻（没有变通办法），要么是
⚠ 部分可用（存在变通办法，但有注意事项）。

## 0. 能力索引

`plugin.json#extensions.capabilities` 中声明的 13 项能力
在下文中交叉引用。每一行链接到本文档中按状态逐项
拆解该功能的章节。

| 能力 | 详述于 |
|---|---|
| `chat-streaming` | §1 核心聊天 |
| `tool-execution` | §1 核心聊天 |
| `plan-mode` | §2 计划模式 |
| `ask-user-tool` | §4 Ask-user 工具 |
| `permission-prompts` | §3 权限提示 |
| `workspace-switching` | §6 工作区 |
| `session-management` | §7 会话 |
| `file-attachments` | §9 附件 |
| `quota-usage` | §8 令牌用量与配额 |
| `bilingual-ui` | §10 UI / UX |
| `lan-sharing` | §11 网络与访问控制 |
| `token-auth` | §11 网络与访问控制 |
| `mobile-responsive` | §10 UI / UX |

CI 会对上述每一个名称是否出现在本文档中进行断言
（见 `scripts/check-docs-alignment.mjs`）；上表是
满足该检查的唯一索引。

## 1. 核心聊天

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 带流式增量（delta）的多轮对话 | ✅ | `mcode-acp.js` 读取换行分隔的 JSON；`state-bus.pushEvent` 广播 `delta` 事件 |
| 多行助手回复 | ✅ | `parseChatLines` 将每轮的 delta 片段拼接起来 |
| 工具调用（Bash、Read、Write、Edit、…） | ✅ | 从 acp `tool_call` 事件转发而来 |
| 已完成工具输出的自动折叠 | ✅ | 纯 CSS 实现，无逻辑 |
| 长聊天列表虚拟化（≥ 200 条消息） | ✅ | v2.0.0 lease C04：`public/app/chat-virtual-list.js`（216 行，纯逻辑辅助模块）+ `render.js` 虚拟窗口分支（N ≥ 200），带滚动/缩放 rAF 处理器。`chat-virtual-list.test.js`（315 行，25 个单元测试）。 |
| Markdown 渲染（标题、列表、代码） | ✅ | `lib/marked.min.js` 本地内置（不走 CDN） |
| 代码块语法高亮 | ✅ | highlight.js（本地副本） |
| 运行中取消 | ⚠ | acp `session/cancel` 在 0.1.5 中返回 "Method not found"。webui 的 `/api/protocol/cancel` 退化为对子进程发送 SIGTERM。acp 会话在终止前可能还会再发出几个事件。 |
| 回退 / 分叉某条消息 | ❌ | mcode acp 0.1.5 不支持 |
| 编辑已发送的消息并重新发送 | ❌ | acp 协议未暴露 |
| 重新生成最后一条助手回复 | ❌ | acp 没有丢弃某一轮的方法 |
| 流式输出中间思维链（`<thinking>`） | ⚠ | 如果 delta 中存在则会渲染，但 mcode 0.1.5 将其作为纯文本发出——没有结构化分离 |

## 2. 计划模式

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 进入计划模式（`/plan` 斜杠命令） | ✅ | webui 给提示词加上 `Plan: ` 前缀；mcode acp 以结构化计划事件响应 |
| 带选项的计划审阅弹窗 | ✅ | `renderPlan()` 构建弹窗；用户选择经由 `/api/answer` 传递 |
| 含三个或更多选项的计划 | ✅ | 服务器返回 `options` 数组；客户端渲染 N 个按钮 |
| "Add context to revise" 计划选项 | ✅ | `plan-add-context` 文本域仅在用户选择索引为 2 的选项时显示 |
| 仍在流式输出时的计划摘要预览 | ⚠ | mcode acp 只在最终定稿时才发出 `plan_summary`。webui 只在计划事件到达后才显示弹窗。 |
| 跳过计划直接进入执行 | ✅ | 弹窗中索引为 1 的选项 |

## 3. 权限提示

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 会话级权限模式（`ask`/`auto`/`full`） | ✅ | `state.permissions`；webui 仅通过 `/api/protocol/set-mode` 端点发送 `setMode`，而 mcode 0.1.5 对其返回 "Method not found"。显示的模式是 mcode 最近一次的已知值。 |
| 单工具权限提示弹窗 | ✅ | 当 acp 发出 `permission` 事件时，`checkModals()` 打开 `#perm-modal` |
| 批准 / 拒绝 / 始终允许此工具 | ✅ | 三个选项：`ask`、`auto`、`full`；经由 `/api/answer` 发送 |
| 为会话剩余时间预先授权某个工具 | ⚠ | 与模式设置相同；仅限单次调用——mcode 0.1.5 没有按工具划分的白名单 |
| 自定义规则（例如 "Bash 在 /tmp 上自动放行，其余询问"） | ❌ | mcode acp 没有规则语言 |

## 4. Ask-user 工具

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 带 2-4 个选项的弹窗问题 | ✅ | `bindAskModal()` 根据 acp 的 `ask` 事件构建弹窗 |
| 多选（复选框） | ✅ | acp `multiSelect: true` → webui 渲染复选框 |
| 自由文本 "Other" 输入 | ✅ | 每个问题都有 "Other" 字段；通过 `/api/send {isAskAnswer:true}` 发送 |
| 跳过 / 关闭某个提问 | ✅ | 关闭按钮将问题 id 存入 `DISMISSED_QUESTIONS`，使其在同一会话中不再出现 |
| 重新显示已关闭的问题 | ✅ | 双击品牌 logo 以清空 `presentedKeys` |
| 重复提示同一个问题 | ⚠ | 一旦问题 id 进入 `DISMISSED_QUESTIONS`，webui 会静默丢弃它。清空该集合是一个手动操作。 |
| 嵌套问题（一个提问包含子问题） | ⚠ | 协议支持 `questions` 数组；webui 将它们渲染为依次排队的多个独立弹窗，而不是在单个弹窗中嵌套。 |
| 可选 / 必填标志 | ❌ | mcode 0.1.5 未暴露可选标志——每个问题都按必填处理 |

## 5. 斜杠命令

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 内置命令列表（`/help`、`/compact`、`/model`、…） | ✅ | mcode acp `session/commands` 在连接时获取；缓存在 `mcodeCommandsCache` 中 |
| 输入 `/` 时命令自动补全 | ✅ | `filterSlash()` 构建浮层；匹配 `cmd` 与 `description_*` |
| 本地（webui 侧）命令 | ✅ | `/exec` 将传输层切换为 mcode exec；`/clear` 只清空聊天 UI，不触碰 mcode |
| 隐藏 / 实验性命令 | ⚠ | acp `commands` 列表返回 mcode 所知的全部命令。webui 尚无 `hidden` 标志。 |

## 6. 工作区

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 通过选择器切换工作区 | ✅ | `submitWorkspaceChange` 向 `/api/workspace` 发起 POST |
| 可视化目录树浏览器（Windows 盘符根目录） | ✅ | `/api/workspace/browse` 列出子项；`renderTreeNodes` 构建树 |
| 最近使用的工作区（最近 5 个） | ✅ | `localStorage.webui_workspace_recents_v1` |
| 重新加载时恢复上次的工作区 | ✅ | `localStorage.webui_workspace_last_v1` → 初始化时服务器先 `detect` 再 `change` |
| 在一次聊天期间锁定工作区 | ✅ | 一旦开始聊天，工作区徽标即隐藏；新建聊天会重新打开选择器 |
| 按工作区显示 git 状态（分支、是否脏） | ⚠ | 尽力而为；服务器在工作区变更时 shell 执行一次 `git status`。错误被静默吞掉 → 徽标显示 "—"。 |
| 目录浏览器中的符号链接解析 | ❌ | `fs.readdir(..., {withFileTypes:true})` 将符号链接返回为 `Dirent`；webui 将它们显示为文件。尚无跟随符号链接的选项。 |
| WSL 路径支持 | ❌ | `/api/workspace/browse` 使用 `path.join`，在 Windows 上能识别 `\\`，但不会转换 WSL 的 `\\wsl$\…` 路径 |

## 7. 会话

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 会话列表（侧边栏） | ✅ | 合并自 `state.sessions`（webui JSON）+ `state.mcodeSessions`（mcode sqlite） |
| 按工作区分组会话 | ✅ | `renderSessions()` 按 `workspace` 字段分组 |
| 点击切换会话 | ✅ | `setActiveSession(id)` 调用 `/api/sessions/switch` |
| 通过按钮新建聊天 | ✅ | 如果尚未设置工作区，会先打开工作区选择器 |
| 从侧边栏删除会话 | ✅ | 二次确认：`session-delete` 按钮 → 5 秒确认条 |
| 同时删除 mcode sqlite 中的会话 | ✅ | `/api/sessions/:id` DELETE 处理器调用 `deleteMcodeSessionFromDb`（在一个事务中处理 8 张表） |
| 清理孤立的 mcode 会话 | ✅ | `/api/sessions/cleanup-orphans` 列出未被任何 webui 会话引用的 mcode 会话，然后删除它们（范围：`orphans` 或 `all`） |
| 恢复在 TUI 中打开的 mcode 会话 | ❌ | acp 会话只有一个所有者；webui 在检测到外部所有者时显示只读横幅 |
| 跨工作区会话搜索 | ✅ | 侧边栏搜索输入调用 `GET /api/sessions/search`，它跨所有工作区聚合有标题的匹配项（不区分大小写的模糊匹配 + 按工作区去重）。由 B03 门禁控制。 |
| 将会话导出为 Markdown / JSON | ✅ | `GET /api/sessions/:id/export?format=md|json[&download=true]`（v2.0.0，lease C06）读取 `.webui-sessions.json`（主）+ `runtime-state.sqlite`（尽力而为的次选）。由 B03 授权门禁控制。`routes/export.js`（489 行）+ `routes-export.test.js`。 |

## 8. 令牌用量与配额

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 每轮上下文窗口（已用百分比） | ✅ | webui 累积 `delta` 事件；每轮数值在 `renderContext` 中计算 |
| 缓存读取比率 | ✅ | 从 acp `cache_read_input_tokens` 解析 |
| tok/s（当前流速度） | ✅ | 基于 `delta` 事件在滚动 2 秒窗口内计算 |
| `mavis` 运行时数据库每轮上下文（最近一轮） | ✅ | `mavis-usage.js` 读取 `local_runtime_token_usage`；每轮计算在 `lastTurnContextTokens` 中 |
| 解析 `mmx quota show` | ✅ | `usage.js` 包装该 CLI；每 2 分钟刷新一次（静默）并支持手动点击刷新 |
| 距重置时间（5 小时 + 每周） | ✅ | `formatResetTime()` 显示 `n小时m分` / `n天m小时` |
| 预测配额耗尽时间 | ✅ | `GET /api/usage/forecast` 返回基于滚动 5 小时/每周重置差值的线性 + 稳健（huber）外推（v2.0.0，lease C07）。`server/lib/quota-forecast.js`（354 行）+ `lib-quota-forecast.test.js`。UI 显示 `formatForecastTime()` 倒计时。 |

## 9. 附件

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 点击上传按钮 | ✅ | 由附件按钮打开的隐藏 `<input type=file>` |
| 拖放到聊天区域 | ✅ | `chatArea.addEventListener('drop', …)` |
| 从剪贴板粘贴图片（Ctrl+V） | ✅ | `textarea.addEventListener('paste', …)` 读取 `clipboardData.files` |
| 以 `@file` 形式注入文件路径 | ✅ | `upload.js` 保存到 `MCODE_WEBUI_UPLOAD_DIR`；客户端将 `@/absolute/path` 注入提示词 |
| 发送前图片预览 | ⚠ | 仅文件名，无内联缩略图。mcode acp 接受 `@file` 并自行决定渲染方式。 |
| 多文件附加（一次拖放 ≥ 2 个） | ✅ | 遍历 `dataTransfer.files` |
| 删除单条消息的附件（×） | ✅ | `removeAttachment(idx)` |
| 断线后恢复上传 | ❌ | 上传是同步的（一次性 POST）；不支持分块上传 |

## 10. UI / UX

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 双语 UI（zh-CN / en） | ✅ | `I18N.zh` / `I18N.en` 表；`t(key)` 查找 |
| 浅色 / 深色主题 | ✅ | `<html>` 上的 `data-theme`；`prefers-color-scheme` 作为初始值 |
| 移动端响应式（< 900 px） | ✅ | CSS 媒体查询；侧边栏 + 右侧面板采用抽屉布局 |
| < 600 px 时单列布局 | ✅ | `flex-direction: column` |
| 页内调试日志面板 | ✅ | 右下角黑色面板；可复制 / 清空；30 行环形缓冲 |
| Toast 通知 | ✅ | `#toast-root`，3 秒自动消失 |
| 键盘快捷键（Ctrl+K 聚焦、Esc 关闭、…） | ✅ | `attachEvents()` 中的全局 keydown 处理器 |
| 斜杠命令键盘导航（↑↓ Enter Tab） | ✅ | `slashInput.addEventListener('keydown', …)` |
| 尊重操作系统偏好的深色模式 | ✅ | 启动时的 `prefers-color-scheme` 媒体查询 |
| 自定义 CSS 主题 | ❌ | 没有主题加载器；需要一套 CSS 变量系统 |
| 用户自定义热键 | ❌ | 快捷键是硬编码的 |

## 11. 网络与访问控制

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| HTTP 服务器 | ✅ | Node `http.createServer` |
| 带开关的局域网共享 | ✅ | 运行时状态存于 `settings.lanBroadcastEnabled`；对非本地 IP 默认关闭 |
| 局域网关闭时的友好 403 页面 | ✅ | `settings.js` 中的 `LAN_REJECT_HTML` 模板；v1.0.1：单个双语页面（zh + en 上下堆叠），动态 `PORT`（之前硬编码为 `7890`，在 v0.5 默认端口变更后失效） |
| 令牌认证（`?token=` 或 `Authorization: Bearer`） | ✅ | `server.js` 校验 `req.url` 与 `req.headers.authorization`；一旦设置，每个请求都必须携带令牌 |
| **令牌认证：默认开启（v1.0.1）** | ✅ | 首次启动且未设置 `TOKEN` 环境变量时自动生成一个 32 位十六进制令牌，持久化到 `~/.mcode-webui/settings.json`（权限 0600，通过 `.tmp` + rename 原子写入）。**v2.0.0（lease C08）**：令牌不再以 14 行 ASCII 方框打印到 stdout；改为通过 WebSocket 事件流（`/api/stream`）向所有已连接标签页广播一个 `token.first_run` 控制事件，并向 stdout 打印一行中性的 `token persisted to: <path>`（由 `MCODE_WEBUI_TOKEN_STDOUT=1` 门禁控制）。设置卡片会一直显示令牌，直到操作者点击 "我已保存 / I have saved it"。`MCODE_WEBUI_SETTINGS_PATH` 环境变量可覆盖文件位置。`TOKEN` 环境变量仍然优先（逃生通道）。 |
| **令牌认证：重置 + 实时广播（v1.0.1）** | ✅ | "重置 token" 按钮生成新的 32 位十六进制值，持久化，并通过 WebSocket 事件流（`/api/stream`）广播携带新令牌的 `auth.token_rotated` 控制事件。每个已连接客户端**就地**更新其 `localStorage` 和当前 `HEADERS.Authorization` 对象——后续 `fetch()` 调用自动使用新令牌，无需重新加载。崩溃安全：先写磁盘，仅在成功后才提交内存状态。 |
| **令牌认证：确认状态机（v1.0.1）** | ✅ | 点击 "我已保存" 后，服务器记录 `tokenAcknowledged=true`，并在后续的 `GET /api/settings` 响应与事件流状态快照中不再包含 `currentToken`。UI 将令牌值/掩码行替换为 `✓ 已保存 — 查看请点"重置" / Saved — click "Reset" to view again` 占位符。重置会触发新一轮轮换。跨重启持久化。 |
| **令牌认证：设置持久化（v1.0.1）** | ✅ | 令牌 + readOnly + tokenEnabled + tokenAcknowledged + tokenRotatedAt + allowedInterfaces（空操作占位）全部持久化到 `~/.mcode-webui/settings.json`。`lanBroadcast` 仍只保存在内存中（有意为之——重启后重新启用局域网，避免管理员把自己锁在门外）。 |
| 只读模式（v1.0.1） | ✅ | 开启后，非本地的对 `/api/*` 的 `POST` / `DELETE` 返回 `403 {"error": "read-only mode"}`。`GET` / `HEAD` / `OPTIONS` 豁免。本地请求始终豁免。`/api/settings` 豁免（逃生通道）。已持久化。开启时顶栏显示红色脉动的 "只读 / READ ONLY" 徽标。 |
| 按 cid 划分的 WebSocket 事件流 | ✅ | 每个浏览器标签页一个 `GET /api/stream` 连接；每个 cid 一个 mcode 子进程 |
| HTTPS | ⚠ | v2.0.0（lease C03）——HTTPS 本身需要反向代理；已在 `docs/HTTPS-REVERSE-PROXY.md`（387 行，含 nginx / caddy / Traefik 2 配置及 WebSocket 升级与长连接注意事项）中**完整记录**。webui 无代码改动。 |
| mTLS / 客户端证书 | ❌ | 同上；文档见 `docs/HTTPS-REVERSE-PROXY.md` |
| 速率限制 | ✅ | v2.0.0（lease C03）：`server/lib/rate-limit.js`（252 行）——按 IP 的令牌桶，默认 60 次/分钟 + 100 突发容量 + 令牌持有者 2× 倍率。路由器门禁 4 在超限时返回 429。`lib-rate-limit.test.js`（339 行，21 个单元测试）。 |

## 12. 运维

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 零 npm 安装 | ✅ | 仅使用 Node 标准库 |
| 通过 `PORT` 环境变量配置端口 | ✅ | `config.js:34` |
| 通过 `HOST` 环境变量配置主机 | ✅ | `config.js:36` |
| 通过 `MCODE_MODEL` 环境变量配置默认模型 | ✅ | `config.js:37` |
| 未捕获异常汇（`.server.err`） | ✅ | `installGlobalErrorHandlers` |
| SIGTERM / SIGINT 时优雅退出 | ✅ | `mcode-acp.js` 将信号转发给子进程 |
| systemd / Windows 服务清单 | ❌ | 超出范围；用户应使用 `pm2`、`nssm` 或在终端中运行 |
| 代码热重载 | ❌ | 重启服务器 |
| 健康检查端点 | ✅ | `GET /api/health` 返回 `{ok:true, port, defaultModel, defaultWorkspace, mcodeCmd, mcodeVersion, maxConcurrent}` |
| 只追加事件审计日志（events.ndjson） | ✅ | v2.0.0（lease B01）：`server/lib/events.js`（494 行）——NDJSON 追加写入，带 SHA-256 哈希链、单调递增 `seq`、200ms 延迟写入。已接入 7 个写入点：settings.js / sessions.js / upload.js / slash.js / db.js / export.js / alerts.js（动态）。`lib-events.test.js` + `lib-events-hash.test.js`。`~/.mcode-webui/events.ndjson`（可通过 `MCODE_WEBUI_EVENTS_PATH` 覆盖）。 |
| 独立的异常告警 REST 快照通道 | ✅ | v2.0.0（lease B02）：`server/lib/alerts.js`（203 行）+ `GET /api/alerts` REST 快照（实时 `alerts.append` / `alerts.update` 控制帧经 `/api/stream` 下发）+ 前端铃铛图标 + 未读计数。3 个级别（info/warn/error），100 条环形缓冲，60 秒去重窗口。`lib-alerts.test.js`（17 个）+ `routes-alerts.test.js`（7 个）。 |
| 按请求的授权门禁 | ✅ | v2.0.0（lease B03）：`server/lib/authorize.js`（354 行）——`authorize(action, ctx, opts)` Promise，默认 5 分钟超时（失败即拒绝），8 个动作的白名单（`session.delete`、`sessions.cleanup-orphans`、`session.cleanup-all`、`session.export`、`session.search`、`token.reset`、`slash.clear`、`startup.cleanup`）。7 个包装点。`lib-authorize.test.js`（20 个单元测试）。 |
| SBOM + CVE 门禁（本地；插件无自有 CI） | ✅ | 2026-09-20 修订（webui-rigor-fix）：插件级的 `.github/workflows/ci.yml` 已删除——GitHub 只从仓库根目录读取工作流，因此它从未触发过；唯一的 CI 是 marketplace 根目录的 `validate` 任务（ubuntu / Node 22，`npm ci` → `npm run check`，见 `docs/CI.md`）。SBOM + CVE 作为**本地**门禁运行：`scripts/gen-sbom.mjs` CycloneDX 1.5 + `sbom.cdx.json`（115 个组件）+ `npm audit --omit=dev` + `.cve-ignore.json`；跨 Node/操作系统覆盖是 `docs/CI.md` 中的手动矩阵操作步骤。 |
| `token.first_run` 控制事件 | ✅ | v2.0.0（lease C08）：`server/lib/state-bus.js#pushTokenFirstRun` 在首次启动时通过 WebSocket 事件流（`/api/stream`）向所有已连接标签页下发 `control` 帧（`{type: "control", name: "token.first_run", data: {token, persistPath}}`）。由 `auth.js#isFirstRun()` + 持久化的 `tokenAcknowledged` 标志防重放。 |

## 13. 要启用 ❌ 行，mcode 需要增加什么

- `set_mode` / `set_config_option` → 在 UI 中实现会话中途切换权限模式
- `cancel` → 真正的运行中取消，而不仅仅是 SIGTERM
- `fork` / `resume` / `rewind` → 回退 / 重新生成 UI
- 带结构化规则的 `request_permission` → 按工具白名单
- `session/message.delete` → "编辑并重新发送"
- `session/export` → 导出为 MD/JSON
- `tool_call.input.thumbnail` → 内联图片预览
- 带使用速率的配额指标 → 预测配额耗尽时间
- ask 问题上的可选标志 → 可选问题
- 用于 WSL 符号链接的路径前缀解析器 → WSL 路径支持

这些是向上游提出的需求。历史清单及 mcode 团队的回应
见 [docs/acp-goal-plan-status.md](acp-goal-plan-status.md)。
