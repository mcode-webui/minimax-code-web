# 排查指南

> 简体中文 | [English](TROUBLESHOOTING.md)

> 常见故障及其修复方法，按症状组织。每个条目都包含你可能看到的
> 报错信息、根因，以及经过验证的修复方法。

如果这里的修复方法不起作用，请启用页面内调试日志（webui 右下角）
并查看右侧面板中的 SSE 事件。你也可以重新构建前端
（`pnpm run webui:build`）并重新跑
`pnpm --filter @mavis/webui webapp:typecheck`，让 App Router
代码中的任何 TypeScript 错误暴露出来。

---

## 页面加载了但 UI 是空白

**症状**：HTML 已加载，没有红色报错块，但侧边栏为空，
右侧面板处处显示 "—"。

**根因**：init() 的 promise 链静默失败，或者
`/api/stream` WebSocket 连接从未打开。

**修复**：
1. 打开开发者工具（F12）→ Console → 查看右下角调试面板中的
   `__DBG.log` 条目。
2. 如果你看到 `init: start` 但没有 `init: state loaded`，说明
   `/api/state` 请求失败了。检查 network 标签页。
3. 如果你看到 `init done` 但 UI 仍为空，说明
   `/api/stream` WebSocket 连接失败了。重新加载页面，webui 会重新连接。

## `⚠ webui JS 初始化失败: TypeError: Cannot read properties of null (reading 'addEventListener')`

**症状**：浏览器中出现整页红色报错块，包含此消息，
堆栈跟踪以某个组件或 `init` 回调结尾。

**根因**：组件引用了一个在 layout 编辑中已被移除（或重命名）的节点；
或者浏览器加载了上一次导出的 `_next/static` chunk，而新 layout 已经
不再对应它。

**修复**：
1. **强制刷新**页面（Ctrl+Shift+R）。当问题是中间代理缓存的旧导出时，
   这通常就能解决。
2. 如果强制刷新没用，用 `pnpm run webui:build` 重新构建导出，
   并重启服务器，让 `dist/webui/webapp/out/` 反映新的 layout。
   不再有手动的 `?v=N` 缓存破除——每个 `_next/static/<hash>/…` URL
   上的哈希本身就是缓存破除。
3. 如果问题是节点被重命名或移除，报错信息中会包含文件和行号。
   恢复该节点，或移除该行上对它的引用。

## `Failed to load resource: net::ERR_CONNECTION_REFUSED` 指向 `127.0.0.1:18090`

**症状**：开发者工具显示 `/api/stream` WebSocket 或
`/api/state` 请求失败，提示 "connection refused"。UI 显示 "init fail" 或卡在
"loading…"。

**根因**：服务器没有运行，或者运行在不同的端口上。

**修复**：
1. 检查服务器是否在运行：`curl http://127.0.0.1:18090/api/health`
   应返回 JSON。
2. 如果没有运行，启动它：`cd packages/webui && node server.js`。
3. 如果运行在不同端口，设置 `$env:PORT = <port>` 并重启。
   然后更新浏览器中的 URL。

## `/api/sessions` 返回 `{ok: true, count: 0}` 但 UI 显示了会话

**症状**：API 调用正常并返回会话，但 webui 的会话列表为空。

**根因**：webui 缓存了一份较早的空列表。这通常会在下一份
事件流 `state` 快照时自行恢复，但如果一直存在：

**修复**：强制刷新页面。

## 侧边栏中缺少会话

**症状**：你在 TUI 中有 mcode 会话，但它们没有出现在
webui 的会话列表中。

**根因**：webui 的 `state.mcodeSessions` 为空，因为
`acp-sessions` 查询失败了或尚未运行。webui 在初始化时通过
`GET /api/acp-sessions` 查询 mcode sqlite。

**修复**：
1. 检查 `curl 'http://127.0.0.1:18090/api/acp-sessions?cid=<your-cid>'`
   —— 应返回会话列表。
2. 如果为空，说明 mcode 数据库为空或路径不对。
   检查 `$env:USERPROFILE\.minimax\v2\sqlite\runtime-state.sqlite`
   是否存在。
3. 如果 API 返回了会话但 UI 为空，强制刷新。

## 计划模式弹窗无法关闭

**症状**：点击 "Skip" 或按 Esc 无法关闭计划弹窗。

**根因**：点击处理器调用了 `hidePlan()`，但来自 mcode 的
事件流更新还没有到达，所以下一次渲染又把它打开了。

**修复**：
1. 等 2-3 秒让事件流确认到达。
2. 如果还是关不掉，再点一次 "Skip" —— 有时第一次点击被
   焦点环消耗掉了，第二次点击才会命中按钮。
3. 如果弹窗真的卡死了，说明底层 mcode 状态卡住了。
   发送任意用户消息 —— 计划上下文会被取代，
   弹窗就会关闭。

## 询问用户的弹窗在关闭后又重新出现

**症状**：你点击了询问用户弹窗上的 "Skip"，然后它在
下一条消息时又弹了出来。

**根因**：webui 把已关闭的问题 id 存储在
`DISMISSED_QUESTIONS`（localStorage）中。如果你清空了
localStorage 或使用了不同的 CID，关闭记录就会丢失。

**修复**：
- 如果问题在同一会话中重新出现：不要清空 localStorage。
  如果确实需要，双击左上角的品牌 logo 来清除
  `presentedKeys`（这等同于清空 `DISMISSED_QUESTIONS`）。
- 如果问题在新会话中重新出现：这是设计使然。
  新会话 = 新状态。

## `favicon.ico` 报 `Failed to load resource: 404`

**症状**：开发者工具显示 favicon.ico 404。不影响功能。

**根因**：没有提供 favicon。

**修复**：这只是外观问题，忽略即可。Next 导出已经从 `webapp/public/`
提供了 `favicon_v2.ico` 和 `favicon_v2.png`；旧的 `/favicon.ico`
不再被服务。

## 事件流连接每 30-60 秒断开一次

**症状**：右侧面板冻结几秒，然后追上来。开发者工具显示
`/api/stream` WebSocket 反复关闭并重新打开（Network → WS 标签页）。

**根因**：中间代理（nginx、cloudflare）在 webui 每 30 秒一次的
ping 之间关闭了连接，或者它丢弃了 `Upgrade` / `Connection` 头，
导致握手根本无法保持。

**修复**：
- 设置更长的代理超时：nginx 中使用 `proxy_read_timeout 3600s;`，
  并确认代理转发了 `Upgrade` / `Connection`
  （见 `docs/HTTPS-REVERSE-PROXY.md` §3）。
- 连接关闭后，SPA 会在 `onclose` 约 3 秒后重连并从 `lastSeq`
  续传，所以一次断开最多损失几秒的追赶。
- 或者把 webui 部署在不经代理的路径后面。本地开发时
  这不是问题。

## 控制台出现 "mcode acp exited (code=null signal=SIGTERM)"

**症状**：助手在回复中途停止。聊天界面显示
"agent stopped" 提示。

**根因**：acp 子进程被杀掉了。最常见的原因是手动点击了
`/stop`。"code=null signal=SIGTERM" 这条消息来自 acp-exit 的
`child.on('exit')` 监听器，只是信息性提示。

**修复**：在 `/stop` 之后这是正常的。如果没有 `/stop`
也出现这种情况，请检查服务器控制台中的实际退出原因。

## 会话中途取消并没有真正停止模型

**症状**：点击 ⏹ 按钮发送了取消请求，但模型继续响应了
好几秒。

**根因**：`POST /api/stop` 会经由该 cid 的活动子进程发出 acp
`session/cancel` notification。引擎可能要花一点时间才能
把正在进行的工具调用排空；如果该 notification 无法投递
（因为该 cid 下没有注册活动子进程），路由会退化为对子进程
发送 SIGTERM，并在 2 秒后升级为 SIGKILL。无论走哪条路径，
提示词都会一直吐出 token，直到引擎完成收尾。

**修复**：等 2-3 秒。模型很快会停止输出令牌。
如果没有停止，说明子进程卡住了 —— 参见下文
"卡住的 mcode 子进程"。

## 卡住的 mcode 子进程

**症状**：webui 显示 "running" 但没有事件到达。
`/api/stop` 端点也不起作用。

**根因**：acp 子进程死锁了（mcode 的一个 bug），或者
正在等待 stdin 而我们没有给它喂数据。

**修复**：
1. 打开开发者工具 → Network → 过滤 `/api/stream`，找到该
   WebSocket 连接。如果它仍然开着（状态 101），问题在 mcode 一侧。
2. 找到 mcode 子进程：`Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*acp*" }`
3. 杀掉它：`Stop-Process -Id <PID> -Force`
4. webui 会在下一条消息时生成一个全新的子进程。

## 右侧面板出现 "Cannot set properties of null"

**症状**：红色报错提示，右侧面板显示 "—"。

**根因**：某个渲染函数正在读取当前状态对象中不存在的
字段。这通常发生在来自 mcode 的状态更新缺少 webui
期望的字段时。

**修复**：强制刷新以重新获取完整状态。webui 对已知
可选字段默认采用安全渲染（`if (state.foo) …`），
所以这种情况应该很少见。

## 权限模式下拉框显示 "—" 或不更新

**症状**：右侧面板中的模式徽章卡在 "—"
或显示错误的值。

**根因**：mcode 的权限状态没有反映到
`state.permissions` 中。webui 从事件流 `state` 快照中读取它。

**修复**：
1. 检查 `curl 'http://127.0.0.1:18090/api/state?cid=<cid>' | jq .permissions`
2. 如果为空，说明 mcode 还没有上报当前权限模式。
   发送任意消息 —— 下一个 SSE 事件就会包含它。
3. 如果 webui 显示错误的值，再发一条提示词并观察 SSE
   state 来确认实际是否生效——`state.permissions` 会在
   每次 `POST /api/permissions` 成功响应后被改写。若响应里
   出现 `mcodeSynced: false` 加 `warning` 字段，说明路由
   接受了请求，但引擎拒绝了 `session/set_config_option`
   调用（具体 acp 错误请到服务器日志里查看）。

## "Cannot read properties of undefined (reading 'listSessions')"

**症状**：切换会话时右侧面板出现红色报错。

**根因**：引用了一个已被重命名的旧 mcode-rpc 函数的
过期引用。如果你看到这个，说明 webui 是从过期缓存加载的。

**修复**：强制刷新。如果问题持续，检查 network 标签页中
`/_next/static/chunks/main-app-<hash>.js`（或 `/_next/static/` 下任意
chunk）的响应 —— 它应该包含 webui 版本（`@mavis/webui/package.json`）。
Next 导出对每个 chunk 都做内容寻址，所以 chunk 过期通常意味着
`webapp/out/` 没跟着重建。

## 服务器无法启动："cannot listen on 127.0.0.1:18090 — EADDRINUSE"

**症状**：`node server.js` 打印
`[webui] cannot listen on 127.0.0.1:18090 — EADDRINUSE` 并以 1 退出。

**根因**：端口被"钉住"了 —— 设置了 `PORT`，或传了 `mcode-web --port`
—— 而另一个进程已经在监听该端口。通常是没有清理干净的旧 webui 进程。

被钉住的端口不会自动后移：docker 端口发布、容器健康检查以及部署脚本
都按配置值寻址，无法发现回退。**默认**端口（未做任何配置）的行为不同
—— 它会往后找下一个空闲端口，并打印
`[webui] port 18090 is already in use — trying 18091`。

**修复**：
1. 找到冲突的进程：
   ```powershell
   Get-NetTCPConnection -State Listen -LocalPort 18090
   ```
2. 杀掉它：`Stop-Process -Id <PID> -Force`
3. 或者使用不同的端口：`$env:PORT = 7891; node server.js`
4. 或者不再钉住端口：取消 `PORT`，并且运行 `mcode-web` 时不带
   `--port`，由服务器自己取下一个空闲端口。

## 令牌认证：401 Unauthorized

**症状**：每个 API 调用都返回 401。

**根因**：服务器设置了 `$env:TOKEN` 运行，但客户端没有
发送它。或者令牌不匹配。

**修复**：
1. 检查 `curl http://127.0.0.1:18090/api/health` —— 不带认证
   应该也能工作（health 是豁免的）。
2. 检查 webui 使用的 URL：应该附加了 `?token=…`，
   或者请求应带有 `Authorization: Bearer …`。
3. webui 会从 URL 查询字符串自动注入令牌。请确保你打开的
   是 `http://127.0.0.1:18090/?token=…`，而不是
   `http://127.0.0.1:18090/`。

## 服务器启动了但没有生成 mcode 子进程

**症状**：`/api/health` 返回 200，但发送消息没有任何反应。

**根因**：mcode 二进制文件不在预期路径。默认的探测链（见
`server/lib/config.js#MCODE_CMD`）是：`$MCODE_CMD` 环境变量 >
`MCODE_WEBUI_SELF_ENTRY` > 仓库中 `<packages/webui>/../../dist/cli.js`
> `~/.minimax-code/mcode.cmd` > `PATH` 中的 `mcode`。

**修复**：
1. 验证路径：`Test-Path %USERPROFILE%\.minimax-code\mcode.cmd`
2. 如果它在别处，设置 `$env:MCODE_CMD = 'C:\path\to\mcode.cmd'`
3. 重启服务器。

## Webui 卡顿 / 输入延迟

**症状**：按键要 100ms 以上才出现在输入框中。

**根因**：通常是聊天正在渲染很长的历史记录。
`renderChat` 函数在每次状态更新时都会重新渲染整个聊天。
长聊天（>500 条消息）会触及上限。

**修复**：
1. 开一个新聊天：旧聊天仍在历史记录中，但不在活动视图中。
2. webui 对工具调用有懒渲染；如果问题持续，说明
   `state.chatHistory` 正在被修改。查看页面内调试日志。
3. 对于非常长的历史记录，可以考虑实现虚拟化滚动
   （目前不在范围内）。
