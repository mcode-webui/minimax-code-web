# 能力清单

> 简体中文 | [English](CAPABILITIES.md)

> 本文档是本 webui 能做什么、不能做什么的唯一事实来源。每一行都包含
> 一个状态（✅ 可用 · ⚠ 部分可用 · ❌ 受阻）、原因，以及在代码中
> 应该查看的位置。

webui 受三项约束限制：
1. 引擎的 acp 通过 JSON-RPC 暴露的能力（引擎在 `initialize` 应答的
   `agentInfo` 载荷中上报其版本，详见 `/api/protocol/capabilities`）。
2. Node `http` / `child_process` API 能做的事。
3. 浏览器 `WebSocket` 与 `fetch` 能做的事。

超出这三者范围的功能要么是 ❌ 受阻（没有变通办法），要么是
⚠ 部分可用（存在变通办法，但有注意事项）。

## 0. 能力索引

`package.json#mcodeWebui.capabilities` 中声明的 13 项能力
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
| 带流式增量（delta）的多轮对话 | ✅ | `mcode-acp.js` 读取换行分隔的 JSON；`state-bus.pushStateFor` 广播 `delta` 事件 |
| 多行助手回复 | ✅ | `parseChatLines` 将每轮的 delta 片段拼接起来 |
| 工具调用（Bash、Read、Write、Edit、…） | ✅ | 从 acp `tool_call` 事件转发而来 |
| 已完成工具输出的自动折叠 | ✅ | 纯 CSS 实现，无逻辑 |
| 长聊天列表虚拟化（≥ 200 条消息） | ✅ | `webapp/lib/transcript.ts` 虚拟窗口分支（N ≥ 200），带滚动/缩放 rAF 处理器；由 `webapp/test/transcript.test.ts` 覆盖。 |
| Markdown 渲染（标题、列表、代码） | ✅ | `lib/marked.min.js` 本地内置（不走 CDN） |
| 代码块语法高亮 | ✅ | highlight.js（本地副本） |
| 运行中取消 | ✅ | acp `session/cancel` 以 notification 形式发送，并钉在该 cid 的活动子进程上（`/api/protocol/cancel` → `server/lib/mcode-rpc.js#cancelSession`）。只有当 notification 无法投递时，才会走硬杀兜底（`/api/stop` → SIGTERM/SIGKILL）。acp 会话在排空前可能还会再发出几个事件。 |
| 回退 / 分叉某条消息 | ⚠ | 引擎已实现 `session/fork` 和 `session/resume`（`MCODE_ACP_CAPABILITIES.fork / .resume = true`），但目前 webui 还没有路由暴露它们——参见 [§13](CAPABILITIES.zh-CN.md#13-要启用--行-mcode-需要增加什么)。 |
| 编辑已发送的消息并重新发送 | ❌ | acp 协议未暴露 |
| 重新生成最后一条助手回复 | ❌ | acp 没有丢弃某一轮的方法 |
| 流式输出中间思维链（`<thinking>`） | ⚠ | 如果 delta 中存在则会渲染，但引擎将其作为纯文本发出——没有结构化分离 |

## 2. 计划模式

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 进入计划模式（`/plan` 斜杠命令） | ✅ | webui 给提示词加上 `Plan: ` 前缀；mcode acp 以结构化计划事件响应 |
| 带选项的计划审阅弹窗 | ✅ | Next shell 在 `webapp/components/modals.tsx` 渲染计划弹窗；用户选择经由 `/api/answer` 传递 |
| 含三个或更多选项的计划 | ✅ | 服务器返回 `options` 数组；客户端渲染 N 个按钮 |
| "Add context to revise" 计划选项 | ✅ | 弹窗在用户选择"revise"选项时显示自由文本的"add context"字段 |
| 仍在流式输出时的计划摘要预览 | ⚠ | mcode acp 只在最终定稿时才发出 `plan_summary`。webui 只在计划事件到达后才显示弹窗。 |
| 跳过计划直接进入执行 | ✅ | 计划弹窗上的 "Skip" 按钮 |

## 3. 权限提示

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 会话级权限模式（`ask`/`auto`/`read`/`full`） | ✅ | 类型化的 `state.permissions`；webui 通过 `/api/permissions {mode}` 发送 `setConfigOption {configId:'permissionMode'}`，该路由经由 cid 的活动子进程调用 `session/set_config_option`。同时，该路由会把所选标签回写到 `cs.permissions`，让 UI 不必等待下一次 SSE state 推送就能即时刷新。 |
| 单工具权限提示弹窗 | ✅ | 当 acp 发出 `permission` 事件时，`webapp/components/modals.tsx` 打开权限弹窗 |
| 批准 / 拒绝 / 始终允许此工具 | ✅ | 三个选项：`ask`、`auto`、`full`；经由 `/api/answer` 发送 |
| 为会话剩余时间预先授权某个工具 | ⚠ | 仅限单次调用——目前还没有按工具划分的白名单 |
| 自定义规则（例如 "Bash 在 /tmp 上自动放行，其余询问"） | ❌ | acp 协议没有规则语言 |

## 4. Ask-user 工具

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 带 2-4 个选项的弹窗问题 | ✅ | `webapp/components/modals.tsx` 根据 acp 的 `ask` 事件构建弹窗 |
| 多选（复选框） | ✅ | acp `multiSelect: true` → webapp 渲染复选框 |
| 自由文本 "Other" 输入 | ✅ | 每个问题都有 "Other" 字段；通过 `/api/send {isAskAnswer:true}` 发送 |
| 跳过 / 关闭某个提问 | ✅ | 关闭按钮将问题 id 存入会话级关闭集合，使其在同一会话中不再出现 |
| 重新显示已关闭的问题 | ✅ | 关闭集合按会话 + CID 隔离；新会话或新 CID 重新开始，同一问题可以再次询问 |
| 重复提示同一个问题 | ⚠ | 一旦问题 id 在当前会话中被关闭，webui 会静默丢弃它。清空该集合是一个手动操作（新会话或新 CID）。 |
| 嵌套问题（一个提问包含子问题） | ⚠ | 协议支持 `questions` 数组；webui 将它们渲染为依次排队的多个独立弹窗，而不是在单个弹窗中嵌套。 |
| 可选 / 必填标志 | ❌ | 引擎未暴露可选标志——每个问题都按必填处理 |

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
| 通过选择器切换工作区 | ⚠ | Next 前端没有接线。`POST /api/workspace` 与 `webapp/lib/api.ts#setWorkspace` 都存在，但没有任何组件调用后者。原来位于项目列表上方的侧边栏徽标只是打开工作区面板 —— 与工具栏的「工作区」按钮重复 —— 所以被移除，而不是给同一个房间留第二扇门。 |
| 可视化目录树浏览器（Windows 盘符根目录） | ✅ | `/api/workspace/browse` 列出子项；Next shell 在 `webapp/components/panels.tsx` 渲染目录树 |
| 最近使用的工作区（最近 5 个） | ✅ | typed store 的 recents 分片，由工作区变更时填充 |
| 重新加载时恢复上次的工作区 | ✅ | typed store 把最近的工作区持久化到 `localStorage`，下次加载时回放 |
| 在一次聊天期间锁定工作区 | ❌ | 服务器没有可设置的锁 —— 这一行描述的是已移除徽标自身的隐藏规则，现在没有任何实现 |
| 按工作区显示 git 状态（分支、是否脏） | ⚠ | 尽力而为；服务器在工作区变更时 shell 执行一次 `git status`。错误被静默吞掉 → 徽标显示 "—"。 |
| 目录浏览器中的符号链接解析 | ❌ | `fs.readdir(..., {withFileTypes:true})` 将符号链接返回为 `Dirent`；webui 将它们显示为文件。尚无跟随符号链接的选项。 |
| WSL 路径支持 | ❌ | `/api/workspace/browse` 使用 `path.join`，在 Windows 上能识别 `\\`，但不会转换 WSL 的 `\\wsl$\…` 路径 |

## 7. 会话

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 会话列表（侧边栏） | ✅ | 合并自 `state.sessions`（webui JSON）+ `state.mcodeSessions`（mcode sqlite） |
| 按工作区分组会话 | ✅ | `webapp/components/session-tree.tsx` 中的会话树按 `workspace` 分组 |
| 点击切换会话 | ✅ | 点击会话行会触发 `/api/sessions/switch` |
| 通过按钮新建聊天 | ✅ | 如果尚未设置工作区，会先打开工作区选择器 |
| 从侧边栏删除会话 | ✅ | 二次确认：`session-delete` 按钮 → 5 秒确认条 |
| 同时删除 mcode sqlite 中的会话 | ✅ | `/api/sessions/:id` DELETE 处理器调用 `deleteMcodeSessionFromDb`（位于 `server/lib/mcode-session-delete.js`，从原来的 `db.js` 抽出） |
| 清理孤立的 mcode 会话 | ✅ | `/api/sessions/cleanup-orphans` 列出未被任何 webui 会话引用的 mcode 会话，然后删除它们（范围：`orphans` 或 `all`） |
| 恢复在 TUI 中打开的 mcode 会话 | ❌ | acp 会话只有一个所有者；webui 在检测到外部所有者时显示只读横幅 |
| 跨工作区会话搜索 | ✅ | 侧边栏搜索输入调用 `GET /api/sessions/search`，它跨所有工作区聚合有标题的匹配项（不区分大小写的模糊匹配 + 按工作区去重）。由 B03 门禁控制。 |
| 将会话导出为 Markdown / JSON | ✅ | `GET /api/sessions/:id/export?format=md|json[&download=true]`（v2.0.0，lease C06）读取 `$WEBUI_DATA_DIR/sessions.json`（主）+ `runtime-state.sqlite`（尽力而为的次选）。由 B03 授权门禁控制。`server/routes/export.js` + `test/routes/export.check.mjs`。 |

## 8. 令牌用量与配额

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 每轮上下文窗口（已用百分比） | ✅ | SSE `delta` 事件累积进 `state.context`；每轮百分比在 `server/lib/context-percent.js` 中计算 |
| 缓存读取比率 | ✅ | 从 acp `cache_read_input_tokens` 解析 |
| tok/s（当前流速度） | ✅ | 基于 `delta` 事件在滚动 2 秒窗口内计算 |
| `mavis` 运行时数据库每轮上下文（最近一轮） | ✅ | `server/lib/mavis-usage.js` 读取 `local_runtime_token_usage` |
| Token Plan 配额（5 小时 + 每周） | ✅ | 由引擎读取并通过 ACP 的 `mcode/account/status` 上报；`server/lib/usage.js` 做投影映射，`webapp/components/shell.tsx` 渲染弹层。webui 自己不再保存 Subscription Key |
| 距重置时间（5 小时 + 每周） | ✅ | Next shell 渲染双语倒计时（"n小时m分" / "n天m小时"） |
| 预测配额耗尽时间 | ✅ | `GET /api/usage/forecast` 返回基于滚动 5 小时/每周重置差值的线性 + 稳健（huber）外推（v2.0.0，lease C07）。`server/lib/quota-forecast.js` + `test/lib/quota-forecast.test.js`。UI 显示倒计时。 |

## 9. 附件

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 点击上传按钮 | ✅ | `webapp/components/composer.tsx` 渲染带样式的上传按钮 |
| 拖放到聊天区域 | ✅ | 拖放事件绑定在聊天面板 |
| 从剪贴板粘贴图片（Ctrl+V） | ✅ | composer 在 `paste` 事件中读取 `clipboardData.files` |
| 以 `@file` 形式注入文件路径 | ✅ | `server/routes/upload.js` 保存到 `MCODE_WEBUI_UPLOAD_DIR`；客户端将 `@/absolute/path` 注入提示词 |
| 发送前图片预览 | ⚠ | 仅文件名，无内联缩略图。mcode acp 接受 `@file` 并自行决定渲染方式。 |
| 多文件附加（一次拖放 ≥ 2 个） | ✅ | 遍历 `dataTransfer.files` |
| 删除单条消息的附件（×） | ✅ | 每个附件 chip 都带移除控件 |
| 断线后恢复上传 | ❌ | 上传是同步的（一次性 POST）；不支持分块上传 |

## 10. UI / UX

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 双语 UI（zh-CN / en） | ✅ | `webapp/lib/i18n.ts`（`en`/`zh-CN` 表）；类型化的 `t(MessageKey)` 查找 |
| 浅色 / 深色主题 | ✅ | `webapp/lib/theme.ts` 的 `applyTheme()` 切换 `<html>` 上的 `data-theme` 属性；`prefers-color-scheme` 作为初始值 |
| 移动端响应式（< 900 px） | ✅ | Tailwind 响应式工具类；侧边栏 + 右侧面板采用抽屉布局 |
| < 600 px 时单列布局 | ✅ | `flex-direction: column` |
| 页内调试日志面板 | ✅ | 右下角黑色面板；可复制 / 清空；30 行环形缓冲 |
| Toast 通知 | ✅ | 由 `webapp/components/action-error-banner.tsx` 渲染的 3 秒自动消失 toast |
| 键盘快捷键（Ctrl+K 聚焦、Esc 关闭、…） | ✅ | `webapp/components/shell.tsx` 中的全局 keydown 处理器 |
| 斜杠命令键盘导航（↑↓ Enter Tab） | ✅ | composer 的斜杠浮层使用 keydown 监听器 |
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
| 零 npm 安装 | ✅ | 只有两个运行时依赖（HTTP 层的 `hono` 与 `@hono/node-server`，以及工作区路径约定的 `@mavis/shared`），其余是 Node 标准库。`pnpm install` 属于工作区通用引导的一部分，并非 webui 专属安装步骤。 |
| 通过 `PORT` 环境变量配置端口 | ✅ | `server/lib/config.js#PORT`（默认 `18090`；空闲时往后走；被钉住的端口保持原位）。 |
| 通过 `HOST` 环境变量配置主机 | ✅ | `server/lib/config.js#resolveBindHost`（env > 持久化的 `lanBind` > 回环）。 |
| 通过 `MCODE_MODEL` 环境变量配置默认模型 | ✅ | `server/lib/config.js#DEFAULT_MODEL`。 |
| 未捕获异常汇（`$WEBUI_DATA_DIR/.server.err`） | ✅ | `server/lib/config.js` 中的 `installGlobalErrorHandlers`。 |
| SIGTERM / SIGINT 时优雅退出 | ✅ | `server/bootstrap.js` 将信号转发给子进程并关闭监听器 |
| systemd / Windows 服务清单 | ❌ | 超出范围；用户应使用 `pm2`、`nssm` 或在终端中运行 |
| 代码热重载 | ❌ | 重启服务器 |
| 健康检查端点 | ✅ | `GET /api/health` 返回 `{ok:true, port, defaultModel, defaultWorkspace, mcodeCmd, mcodeVersion, maxConcurrent}` |
| 只追加事件审计日志（`events.ndjson`） | ✅ | `server/lib/events.js` ——NDJSON 追加写入，带 SHA-256 哈希链、单调递增 `seq`、200ms 延迟写入。写入点：settings.js / sessions.js / upload.js / slash.js / mcode-session-delete.js / export.js / alerts.js（动态）。测试：`test/lib/events.test.js` + `test/lib/events-hash.test.js`。路径：`$WEBUI_DATA_DIR/events.ndjson`。 |
| 独立的异常告警 SSE 通道 | ✅ | `server/lib/alerts.js` + `GET /api/alerts` SSE + 前端铃铛图标 + 未读计数。3 个级别（info/warn/error），100 条环形缓冲，60 秒去重窗口。 |
| 按请求的授权门禁 | ✅ | `server/lib/authorize.js` ——`authorize(action, ctx, opts)` Promise，默认 5 分钟超时（失败即拒绝），8 个动作的白名单（`session.delete`、`sessions.cleanup-orphans`、`session.cleanup-all`、`session.export`、`session.search`、`token.reset`、`slash.clear`、`startup.cleanup`）。测试：`test/lib/authorize.check.mjs`。 |
| SBOM + 本地 CVE 门禁 | ✅ | `pnpm --filter @mavis/webui sbom` → CycloneDX 1.5（`scripts/gen-sbom.mjs`）+ `pnpm audit --omit=dev` + 仓库根目录 `docs/verification.md` 矩阵。webui 本身没有插件级 CI 工作流；唯一的强制项是 `pnpm --filter @mavis/webui check`（文档对齐关）以及 monorepo 的 `pnpm verify`。 |
| `token.first_run` SSE 事件 | ✅ | `server/lib/state-bus.js#pushTokenFirstRun` 在首次启动时向所有 `sseByCid` 广播 `{event: "token.first_run", data: {token, persistPath}}`。由 `auth.js#isFirstRun()` + 持久化的 `tokenAcknowledged` 标志防重放。 |

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
