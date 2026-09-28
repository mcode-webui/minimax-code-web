# Web UI

> 简体中文 | [English](webui.md)

Web UI（`packages/webui`）是 MiniMax Code 的浏览器前端。它使用与 TUI 相同的引擎 —— CLI 的 ACP 服务器（`mcode acp`，基于 stdio 的 JSON-RPC 2.0）—— 因此终端、浏览器和桌面客户端都运行在同一个运行时之上。每条消息默认走 ACP 传输；两种情况下会改走一次性的 `mcode exec` 命令行（见下文「传输选择」一节）。它不是一个插件：它随仓库一起发布，并由 CLI 启动。

本文描述**当前已发布的 webui 实际行为，依据源码核对**。每一处断言都给出可定位的文件或测试。功能不完整或仅为占位的，本文档会明确标注。下文记录的形态与边界来自 `packages/webui/{server,webapp}` 的当前文件版本；各项引入时间均在下文标注。

## 启动

```bash
mcode-web                     # http://127.0.0.1:18090
mcode web                     # equivalent — `web` and `webui` both resolve
mcode webui --port 8123 --host 127.0.0.1
mcode webui --token "$(openssl rand -hex 16)" --host 0.0.0.0   # LAN, token-gated
pnpm mcode-web                # from a source checkout (built)
node packages/webui/server.js # direct, from a checkout
```

该命令解析 webui 包（已安装的 `dist/webui/` 或源码 `packages/webui/`），把服务器作为子进程启动，并通过 `MCODE_WEBUI_SELF_ENTRY` 将其指回正在运行的 CLI。然后 webui 会为每个活动的浏览器标签页生成一个 `node <cli> acp`。

不传 `--port` 时服务器从 18090 启动，若 18090 被占用就换下一个空闲端口，并打印实际绑定的地址 —— 启动器打开的就是这个地址。显式指定的 `--port`（或 `PORT`）会被钉住：不会自动后移，端口被占用时以 EADDRINUSE 退出（参见 `packages/webui/server/lib/config.js#PORT` 与 `packages/webui/server.js` 启动器）。

## 运行开发构建

开发版 Web UI 可以与已安装的官方 mcode 并行运行而不冲突：
开发版 webui 总是生成本检出版本自己的 `dist/cli.js` 作为其
引擎（探测顺序：`MCODE_CMD` > `MCODE_WEBUI_SELF_ENTRY` > 仓库
`dist/cli.js` > `~/.minimax-code` > PATH），并共享主机的
`~/.minimax` 会话和 `~/.mcode-webui` 状态。

从本仓库的检出中：

```bash
corepack pnpm install && corepack pnpm build   # once, and after engine changes
node dist/cli.js webui                         # dev Web UI on 127.0.0.1:18090
node dist/cli.js webui --port 8123             # keep the installed one free
```

### 一键开发启动器（前后端 + 热重载）

当你迭代 `packages/webui/webapp/` 里的 Next.js 前端时，需要 Node 后端（18090，提供 `/api/*`）与 Next 开发服务器（18091，带 HMR，会把 `/api/*` 代理到 18090）同时跑。`pnpm run webui:dev` 一个 shell 同时拉起两边，给它们的输出加前缀让你能分清谁在说话，并在 Ctrl+C 时一并清理：

```bash
pnpm run webui:dev        # http://127.0.0.1:18091/  ← 在浏览器中打开这个
```

它只是 `node scripts/dev-webui.mjs` 的薄包装，不引入额外依赖。如果 18090 被占，先停掉官方 `mcode` 运行时（`pkill -f "dist/cli.js webui"`），或者给 `mcode webui` 传 `--port 28090` 并 `export MCODE_WEBUI_ORIGIN=http://127.0.0.1:28090`，让开发代理指向正确的后端。

### 日常 webui 命令（对齐 Next 原生能力）

| 命令                       | 作用                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `pnpm run webui:dev`      | 同时启动后端（`:18090`）与 Next dev（`:18091`，带 HMR）；Ctrl+C 一起清理。                |
| `pnpm run webui:build`    | `next build` 构建 webapp（产物在 `packages/webui/webapp/out/`，即静态导出目录）。          |
| `pnpm run webui:start`    | 通过 `node packages/webui/server.js` 在 `:18090` 服务已构建好的 webui（不带 HMR）。       |
| `pnpm run webui:typecheck`| 对 webapp 的 TS 源码跑 `tsc --noEmit`。                                                   |
| `pnpm run webui:test`     | 跑全部 webui 单元测试——后端 `test:webui` + 前端 `test:webapp`。                          |

故意省略了 `next start`：webui 以 `next export` 静态构建并由后端直接服务这些文件，没有 Next server runtime 需要启动。ESLint 暂未集成进 webapp——待 `.eslintrc` 落位后再用 `npx next lint` 即可。

### Docker

仓库的 Docker 设置在**干净环境**中运行当前分支：不挂载任何
主机 home 目录，因此主机的模型/工具/会话永远不会泄漏进来
（容器状态也永远不会泄漏出去）。模型凭证来自环境变量 ——
每位协作者使用自己的密钥测试：

```bash
MINIMAX_CN_API_KEY=...  docker compose up webui   # MiniMax cn region
MINIMAX_API_KEY=...     docker compose up webui   # MiniMax global region
# open http://localhost:18080/?token=dev-token
docker compose down                                # reset to factory state
```

镜像以非 root 的 `user`（uid 1000）运行，并在 `/home/user` 拥有一个真实的 home（Desktop/Documents/Downloads/Pictures/Music/Videos/projects + XDG 配置），因此目录选择器的常见文件夹关键字表现与桌面一致。`docker/entrypoint.sh` 会播种一份全新的容器内 `~/.minimax/config.yaml`
（`minimaxModelSource: minimax_api_key` + 密钥 + 默认模型为
`minimax_api/MiniMax-M3`）；`MAVIS_REGION` 根据你设置了哪个变量推导，
也可以显式覆盖。因为从容器视角看主机浏览器是非本地客户端，
所以每个 URL 都携带 `?token=…`（`WEBUI_TOKEN`，默认 `dev-token`）；
端口是 `WEBUI_PORT`（默认 18080）。两个密钥变量都没设置的容器
也能正常启动，但在提供其一之前聊天没有模型凭证。

针对挂载源码的交互式开发（同样的环境变量密钥流程）：

```bash
docker compose run --rm -p 18080:18080 dev
# inside the container:
pnpm install --no-frozen-lockfile && pnpm build
node dist/cli.js webui --host 0.0.0.0 --no-open   # PORT defaults to 18080
```

## 安全姿态

- 默认绑定回环；局域网暴露需要 `--host`/`HOST` 环境变量或持久化的 `lanBind` 设置。
- 受信源 CORS + 浏览器 Origin/CSRF 门禁，即使对回环请求也生效。
- 非本地请求使用令牌认证（`?token=` / `Authorization: Bearer`）；本地请求绕过。
- 非本地会话为只读模式；逐请求的 `authorize()` 门禁，失败即关闭并审计；速率限制；工作区隔离；上传大小有界；无遥测。
- **凭据形态的文件默认拒绝预览**（slice 16）。文件名命中 `.env` / `.env.*`、`*.pem` / `*.key`、`id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa`、`known_hosts`、`authorized_keys`、`.npmrc`、`.pypirc`、`.netrc`、`.pgpass`、`credentials*`，以及备份后缀集（`.bak` / `.old` / `.orig` / `.backup` / `.save` / `.swp`）时，`GET /api/fs/read-file` 返回 HTTP `403 {code: "credential"}`。Webapp 在拒绝态展示「仍要打开？」二次确认；用户确认后用 `?confirm=1` 重发请求拿到明文。唯一的判断函数位于 `packages/webui/server/lib/credential-file.js`，并在 `packages/webui/webapp/lib/credential-file.ts` 字面镜像；测试套件 `packages/webui/webapp/test/credential-file.test.ts` 同时驱动两侧，使它们无法漂移。文件树、`/api/fs/search` 与 OS 默认打开/定位不受此门禁影响（它们都是树形显示、搜索或 OS 调用，不读取明文）—— 搜索只会给命中打 `credential: true` 标记，永不下发内容。该判断函数基于文件名，**因此无法防御硬链接别名攻击**（两个指向同一 inode 的不同名字，例如 `config.txt → .env`——内核无法从 inode 还原"主"名字）。它能覆盖符号链接（由 `realpathSync` 解析），但不能覆盖硬链接——担心硬链接别名的运维必须保持工作区目录整洁。

正式的披露文档是 [`packages/webui/references/SECURITY-NOTES.md`](../packages/webui/references/SECURITY-NOTES.md)。

## 传输选择（ACP 还是 exec）

发出的每条消息都由两种传输之一送达引擎。选择发生在服务端、按回合进行，页面上**没有任何提示**。本节记录当前源码的实际行为，不是长期不变的契约。

两种传输是什么：

- **ACP**（默认）：与 TUI 相同的协议通道（`mcode acp` 子进程）。工具调用过程、会话标题、思考等级等事件都从这条通道回传。
- **exec**：一次性 `mcode exec` 命令行子进程。回合结束进程即退出，只有思考与正文文本回传。

谁决定走哪条：

| 条件 | 实际走的传输 | 判定位置 |
| --- | --- | --- |
| 服务端环境变量 `MCODE_USE_ACP=0` | exec | `server/routes/chat.js#handleSend` |
| 会话权限模式不是 Full access（Ask / Auto / Read） | exec（在 ACP 入口内部静默改道） | `server/lib/mcode-acp.js#runMcodeAcp` 首个分支 |
| 其余情况（出厂默认：权限 Full access，见 `server/lib/state-bus.js` 初始状态） | ACP | 同上 |

出厂默认权限是 Full access，所以不碰任何开关时所有回合都走 ACP。两个条件若同时成立也不冲突——它们都指向 exec；环境变量先判（`chat.js` 的三元），权限判定只在其后进入 `runMcodeAcp` 时发生。

什么时候会遇到 exec：

1. **运维主动设置了 `MCODE_USE_ACP=0`。** 这是 ACP 协议回归时的逃生阀：设置后所有回合都走 exec。想回到 ACP，去掉该变量并重启 webui 即可。整个代码库只有一处读取它（`chat.js#handleSend`）。
2. **在输入框的权限选择器里选了 Ask 或 Auto**（`POST /api/permissions` 另接受 `read`，UI 只提供 Ask / Auto / Full access 三项）。从下一条消息起，该会话的回合全部静默改走 exec。选回 **Full access** 即恢复 ACP。

exec 上权限模式本身并非失效：它仍以 `--permission` 启动参数传给引擎（Ask→`ask`、Auto→`auto`、Read→`read`、其余 `full`，见 `mcode-exec.js` 的模式映射），会话经 `--session` 续接，已记录的模型经 `--model` 传递。失效的是下面这批回合级能力。

exec 回合的代价——以下都是当前真实存在的行为，选择权限模式前需要知道：

| 能力 | ACP 回合 | exec 回合 |
| --- | --- | --- |
| 工具调用过程（`→` 工具行） | 可见 | 不可见，只有思考与正文文本 |
| 思考等级（模型选择器里的档位） | 经 ACP 配置通道同步给引擎 | 不传送，引擎用自身默认 |
| 会话标题自动回写 | 有 | 无 |
| 回合进行中改模型 / 权限 | 即时生效 | 无法送达已启动的子进程，下一回合才生效；接口带 `no_acp_session` 警告 |
| 引擎侧向用户提问（工具授权、问卷） | 弹窗交互 | 无通道：stdin 在消息发出后即关闭，提问类错误以回合告警收场，提示改用输入框直接发问 |

也就是说：为了更安全选 Ask，换来的当前实际结果是工具过程完全黑箱、且引擎侧的提问根本送不到浏览器。这是已知的真实缺陷，本文如实记录；它需要传输层改造才能根治，不会因为本文档的修订而消失。

怎么确认某回合走了哪条路：

- 回合进行期间看进程：`mcode … acp` 子进程是 ACP 回合，`mcode … exec --input - …` 是 exec 回合。
- 行为特征：回复里没有任何 `→` 工具行、会话标题一直是初始名——大概率在 exec 上。

**没有 `/exec` 命令。** 不存在通过聊天命令切换传输的入口；webui 本地命令只有 `new` / `clear` / `status` / `sessions` / `usage` / `help` / `stop`（`server/lib/acp-client.js#WEBUI_LOCAL_COMMANDS`）。切换传输只有上表的两个开关：环境变量与权限模式。

权限模式接口与警告语义见 [`packages/webui/docs/API.md`](../packages/webui/docs/API.md) 的 `POST /api/permissions` 一节；面向贡献者的契约细节（判定代码位置、不变量）见 [`webui.md`](webui.md) 的 Transport selection 一节。

## 文件树（已发布的 UI）

下方每个已发布的文件树、面板与列都给出组件文件锚点与一个
`data-testid`，可在源码中检索。

| 表面 | 组件 | 锚点 `data-testid` |
| --- | --- | --- |
| 侧栏（rail） | `components/shell.tsx` | `sidebar-scroll-viewport` |
| 侧栏会话树 | `components/session-tree.tsx` | `sidebar-session-row` |
| 侧栏上下文/用量弹出层 | `components/shell.tsx` | `sidebar-user-usage-popover` |
| 侧栏 inbox（告警浮层） | `components/inbox.tsx` | `inbox-flyout` |
| 顶栏（带模型选择器） | `components/toolbar.tsx` | `toolbar-session-status` |
| 录入区与拖放浮层 | `components/composer.tsx` | `composer-drop-overlay`、`composer-send-button` |
| 对话（≥ 200 条时虚拟滚动） | `components/chat.tsx` + `chat-virtual-list.tsx` | `chat-virtual-top-spacer` |
| 轮次总结/折叠面板 | `components/chat.tsx` | `turn-process-disclosure` |
| 活动组（可折叠的工具轮次） | `components/chat.tsx` | `activity-group-header` |
| 文件预览（右预览列主体） | `components/file-preview.tsx` + `file-preview-pane.tsx` | `file-preview` |
| 文件树列（列 4） | `components/workspace-tree-column.tsx` + `panels.tsx#FilesPanel` | `files-tree-root` |
| 文件树搜索（服务端，slice 19a；slice 19b 联调） | `components/panels.tsx` | `files-tree-filter` |
| 侧栏树列「搜索」表面（slice 19b） | `components/workspace-tree-column.tsx#SearchSurface` | `tree-surface-search-input` |
| 代码预览（slice 22 IDE 级：行号槽 + 按语言懒加载高亮 + 字节保真复制） | `components/code-view.tsx` | `code-view`（内嵌于 `file-preview`） |
| 三态外观选择器（slice 18） | `components/appearance-card-picker.tsx` | `appearance-card-picker` |
| Git 面板（slice 03） | `components/panels.tsx#GitPanel` | `git-panel` |
| 浏览器面板（slice 04，沙箱化 iframe over `/api/fs/raw`） | `components/browser-panel.tsx` | `browser-panel` |
| 工作区选择器（模态） | `components/workspace-picker.tsx` | `workspace-picker` |
| Provider 配置 | `components/provider-management.tsx` | `providers-panel` |
| 上下文窗口 | `components/context-meter.tsx` | `context-meter` |
| 设置模态 | `components/panels.tsx#SettingsModal` | `settings-modal` |
| 错误边界（全局 + 路由级） | `app/error.tsx` + `app/global-error.tsx` | `global-error-page` |

## 四列工作区（当前主线，slice 17 + slice 21）

在侧栏右侧，外壳渲染一个最多容纳三列**可见列**的 flex 行：`conversation | preview | tree`（侧栏由 `AppShell` 拥有，在该行之外，在行内宽度视为 0）。

| 列 | 角色 | 默认 / 最小 / 最大宽度 | 由谁挂载 |
| --- | --- | --- | --- |
| `conversation` | 弹性（吸收剩余空间，空闲时撑满） | 720 / **280** / **768** px（空闲态上限解除） | `components/chat.tsx` |
| `preview` | 按需 — 查看面（`file:<path>`、`browser`） | 400 / 320 / 720 px | `components/file-preview-pane.tsx`、`browser-panel.tsx` |
| `tree` | 按需 — 导航面（`files`、`git`、`tasks`、`search`、`plugins`） | 340 / 320 / 600 px | `components/workspace-tree-column.tsx` |

**slice 21 起 `preview` 与 `tree` 两列均为按需列**：每列在至少有
一个匹配角色的标签页打开时出现，在该角色最后一个标签页关闭时
**自动收起**。反序列化器会把陈旧的"列已开但空"载荷规范化为收起，
从而陈旧的磁盘写入无法在 hydration 时召出一个空列。持久化层 +
页面级 reducer 包装器每次都通过
`syncColumnVisibility(tabStrip, layout)`（位于
`packages/webui/webapp/lib/workspace-tabs-state.ts`）从标签页列表
重新派生每列的可见性。**空闲不占宽度**：两个按需列都关闭时，
`conversation` 列独占全部剩余空间。在 1280 视口下（240 px AppShell
chrome）`conversation` 列实测 **1040 px**；1920 视口下为 **1680 px**。
两个数值均由
`packages/webui/webapp/test/workspace-tabs-state.test.ts#computeColumnLayout — slice 21 idle state`
锁定。只要至少有一个固定列可见，`conversation` 就保持在 768 px
上限（slice 17 的"反死区"防御保留不变 —— 新增的空闲放宽只在
两个固定列都折叠时才生效）。

每列持有自己的 `activeId`（`previewActiveId`、`treeActiveId`），因此
打开一个 tree 表面不会夺走 preview 列的焦点，反之亦然。表面字典
（`SurfaceTabKind`）共六个取值 —— tree 一侧 `files | git | tasks |
search | plugins`，preview 一侧 `browser | file:<path>`，其定义位于
`lib/workspace-tabs-state.ts#SURFACE_TAB_KINDS`。**侧栏的「搜索」
入口自 slice 19b 起已可用** —— `workspace-tree-column.tsx` 中的
`SearchSurface` 把一个 200 ms 防抖请求接到 `GET /api/fs/search`
（`api.searchFs`），复用文件树筛选器相同的 `searchFootSegments`
页脚（扫描数 / 命中数 / 跳过数 / 截断 / 预算），并通过共享的
`fs-tree-reveal` 通道把点击行为接成"展开到命中"——文件树面板应用
与自身服务端搜索相同的展开 + 高亮。**「插件」入口仍是占位**
（`PluginsSurface`），因为引擎尚未发布插件安装协议；该表面渲染
一个 i18n "敬请期待"卡片而非静默空操作。

表面种类统一通过 `openSurfaceTab("…")` 触发；右栏种类
（`PanelKind`）是单独收紧的并集：`"workspace" | "files" | "git" |
"plugins" | "browser"`。原先发布的 `search`、`alerts`、`progress`
已**从 `PanelKind` 并集中移除**（见
`packages/webui/webapp/lib/persist.ts#PanelKind`）；`alerts` 通过独立
的铃铛图标 `InboxFlyout` 组件进入，`progress` 没有实际的入口点。

列间分隔条宽 8 px，支持拖拽改宽（夹在 `[minWidth, maxWidth]` 内）
和双击重置。

### 代码预览（slice 22，IDE 级）

文件预览标签页使用 `components/code-view.tsx`（`data-testid`
`file-preview`）。它在 slice 02 的纯 `<pre>` 视图之上叠加了三层
slice 22 增强：

- **行号槽**，与代码行对齐且独立于横向滚动——用户在一行长
  代码上向右滚动时，行号不会移动。`splitHighlightedLines`
  （`webapp/lib/code-highlight.ts`）遍历 highlight.js 的 HTML 输出，
  平衡跨行 `<span>`，使每行都是 hover 稳定且复制可靠的。
- **按语言懒加载语法高亮**。只加载打开文件对应的那一种语法
  —— `loadHljsLanguage` 是一串字面量 `import("highlight.js/lib/languages/<name>.js")`
  分支，让 webpack 把每种语法单独拆 chunk（若改用 Record 驱动的
  动态 import，会把全部 191 种语法打进同一 chunk）。未识别或未
  加载的语言回退为纯等宽视图（契约是全的：坏输入不得崩溃）。
  字节上限为 **32 KiB**，行数上限为 **1500 行**；更大的文件在
  高亮步骤前被截断，使巨型文件也不会卡住 tab，同时 UI 渲染一个
  诚实的 `truncated` 提示。映射表位于 `LANGUAGE_TO_HLJS`——
  `html` 是 `xml` 的别名，`jsonc` 共用 `json`，`toml` / `plain`
  故意没有条目（调用方按纯等宽处理）。
- **字节保真复制**。复制路径会还原尾部换行（`endsWithNewline`
  在 highlight → split → copy 全链路被追踪，使剪贴板里的文本与
  文件字节互为往返 ——`cp file.js file.js.bak; 在面板里复制; 粘回去`），
  且绝不让行号槽混入复制文本。

## 持久化键（客户端 `localStorage` / `sessionStorage`）

| 键 | 通道 | 归属 | 引入 ticket | 数据形态 |
| --- | --- | --- | --- | --- |
| `webui:ui:v1:<cid>` | `localStorage` | `webapp/lib/persist.ts#uiStateKey` | slice 07（重启状态） | `{version:1, cid, state:{panel, panelTab, sidebarCollapsed, lastSessionId, appearance}}` ——`appearance`（slice 18）是三态外观选择器的选择（`"light" \| "dark" \| "system"`），`applyAppearance` 走这个 envelope 写入 |
| `webui:scroll:v1:<cid>:<sessionId>` | `localStorage` | `webapp/lib/persist.ts#scrollKey` | slice 07 | `{version:1, cid, sessionId, scrollTop, savedAt}` |
| `webui:workspace-tabs:v1:<cid>` | `localStorage` | `webapp/lib/persist.ts#workspaceTabsKey` | slice 15（工作区列） | 由 `WORKSPACE_TABS_VERSION` 区分版本的 payload，见 `lib/workspace-tabs-state.ts` |
| `webui:open-file:path` | `localStorage` | `webapp/lib/open-file.ts#STORAGE_KEY` | slice 12（文件预览） | 纯路径字符串或缺失 |
| `webui:files-tree:<workspaceDir>` | `sessionStorage` | `webapp/components/panels.tsx`（slice 01） | slice 01（文件树） | `{version:1, workspace, expanded[], filter, showHidden}` |

所有键共享 `webui:` 前缀，写入均为尽力 + 防抖（`ui`、`workspace-tabs`
为 150 ms 防抖；其他立即写）。一次失败的写入不会破坏内存状态；
我们关心的是 `app/global-error.tsx` 捕获的硬崩溃，而非这里的配额
错误。会话内每个 sessionId 单独存储滚动位置 —— 按会话恢复滚动位置
是有意为之的契约。

## 端点清单（依据当前源码）

下表覆盖全部已注册的 `/api/*` 路由。`OWNED_ROUTES`（Hono，60 条）
是直观的清单；旧派发器仅保留两条 SSE（`/api/events`、`/api/alerts`）
以及静态与 trajectory 挂载。

### Hono 直接持有（`server/app.js` 的 `OWNED_ROUTES`）

| 方法 | 路径 | 处理文件 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | `routes/health.js` | `200` `{ok, port, defaultModel, defaultWorkspace, mcodeCmd, mcodeVersion, maxConcurrent}` |
| `GET` | `/api/account` | `routes/account.js` | `200` 引擎投射的账户卡；引擎未应答时 `{ok:false, reason:"no_client"\|"rpc_error"\|"account_unavailable"}` |
| `GET` | `/api/state` | `routes/state.js` | 完整 `state` 投影（快照） |
| `GET` | `/api/sessions` | `routes/sessions.js#handleListSessions` | webui + mcode 合并的会话列表 |
| `POST` | `/api/sessions` | `routes/sessions.js#handleNewSession` | 新建 webui 会话记录 |
| `POST` | `/api/sessions/switch` | `routes/sessions.js#handleSwitchSession` | 切换当前会话 |
| `POST` | `/api/sessions/rename` | `routes/sessions.js#handleRenameSession` | 重命名（B03 authorize 守门） |
| `GET` | `/api/sessions/search` | `routes/sessions.js#handleSearchSessions` | 跨工作区模糊搜索（B03 守门） |
| `POST` | `/api/sessions/cleanup-orphans` | `routes/sessions.js#handleCleanupOrphans` | 清理 webui 未引用的 mcode 会话（`scope=orphans\|all`） |
| `DELETE` | `/api/sessions/:id` | `routes/sessions.js#handleDeleteSession` | B03 守门；同时删除 webui 与 mcode sqlite 记录 |
| `GET` | `/api/session-tree` | `routes/sessions.js#handleSessionTree` | 侧栏树投影 |
| `GET` | `/api/acp-sessions` | `routes/sessions.js#handleAcpSessions` | mcode acp 会话列表 |
| `GET` | `/api/acp-session-title` | `routes/sessions.js#handleAcpSessionTitle` | `?sid=…` 标题助手 |
| `GET` | `/api/sessions/:id/export` | `routes/export.js` | `?format=md\|json[&download=true]`；非法 format → `400`；authorize 拒绝 → `403`；找不到 → `404` |
| `POST` | `/api/send` | `routes/chat.js#handleSend` | 火即弃；`200 {ok}`；`400 content required`；`409 {reason:"cid-busy"\|"session-busy"\|"at-capacity", running?, limit?}` |
| `POST` | `/api/stop` | `routes/chat.js#handleStop` | `200 {ok, wasRunning, cancelled, hardKilled, note}` |
| `POST` | `/api/cmd` | `routes/chat.js#handleCmd` | webui 按钮命令 |
| `POST` | `/api/usage` | `routes/usage.js#handleUsage` | 记录 + 投影 |
| `POST` | `/api/usage-trigger` | `routes/usage.js#handleUsage` | 老客户端别名 |
| `GET` | `/api/usage-real` | `routes/usage.js#handleUsageReal` | 真实 token 快照 |
| `POST` | `/api/refresh` | `routes/usage.js#handleRefresh` | 强制刷新 |
| `GET` | `/api/usage/forecast` | `routes/usage.js#handleForecast` | 线性 + Huber 耗尽时间外推 |
| `POST` | `/api/workspace` | `routes/workspace.js#handleWorkspace` | `{ok, error}` |
| `GET` | `/api/workspace/browse` | `routes/workspace.js#handleWorkspaceBrowse` | `?path=<abs>`；错误路径 → `400` |
| `GET` | `/api/workspace/tree` | `routes/workspace.js#handleWorkspaceTree` | 完整工作区 → 会话树 |
| `GET` | `/api/workspace/resolve` | `routes/workspace.js#handleWorkspaceResolve` | `?name=<folder>` → 候选绝对路径 |
| `GET` | `/api/workspace/recent` | `routes/workspace.js#handleWorkspaceRecent` | `?search=&limit=`（limit 上限 20） |
| `GET` | `/api/fs/read` | `routes/fs.js#handleFsRead` | `?path=&showHidden=1`；containment 守门；缺参 → `400` |
| `GET` | `/api/fs/read-file` | `routes/fs.js#handleFsReadFile` | `?path=&confirm=1`；`200`；凭据形路径（未带 `confirm=1`） → `403 {code:"credential"}`；超过 fs-util `DEFAULT_FILE_READ_MAX = 512 KiB` → `413`；二进制 / 非常规文件 → `415` |
| `GET` | `/api/fs/raw` | `routes/fs.js#rawStreamToWebResponse` | `?path=&download=1&confirm=1`；20 MiB 上限的流式响应；同样的凭据守门；按扩展名映射 mime，含 `.html/.htm`、`.svg`、`.png/.jpg/.gif/.webp`、`.js/.mjs/.css/.json` |
| `POST` | `/api/fs/mkdir` | `routes/fs.js#handleFsMkdir` | `{path}`；父目录必须在允许根内；containment 失败 → `403` |
| `POST` | `/api/fs/open-default` | `routes/fs.js#handleFsOpenDefault` | `{path}`；`400 {code:"missing-path"}` / `403 {code:"out-of-bounds"}` / `400 {code:"not-a-regular-file"}` / `503 {code:"no-opener"}` / `502 {code:"spawn-failed"}` |
| `POST` | `/api/fs/reveal` | `routes/fs.js#handleFsReveal` | `{path}`；`code` → status 映射与 `open-default` 相同 |
| `GET` | `/api/fs/search` | `routes/fs.js#handleFsSearch` | `?root=&q=&depth=&maxNodes=&wallMs=&limit=&includeHidden=1`；`400 {code:"missing-root"\|"missing-q"\|"not-a-directory"\|"stat-failed"}`；成功时返回 `{ok, root, q, matches:[{path,name,type,ancestors,credential?,credentialReason?}], scanned:{dirs,files,total}, skipped:{node_modules,n,.git,n,credential,n,huge,n,optional:{dist,build,…}}, truncated, truncatedReason: null\|"depth"\|"nodes"\|"wallClock"\|"matches", elapsedMs, budgets}`。默认预算 `maxDepth=8 / maxNodes=5000 / wallMs=1500 / maxMatches=200`；绝对上限 `16 / 50_000 / 5_000 / 1_000`（`packages/webui/server/lib/fs-search.js`）；`node_modules` 与 `.git` 不可被覆盖。 |
| `GET` | `/api/git/status` | `routes/git.js#handleGitStatus` | `?dir=`；`400 {error:"missing dir"}` |
| `GET` | `/api/git/branches` | `routes/git.js#handleGitBranches` | `?dir=`；前导 `* ` → `current` 标志 |
| `GET` | `/api/git/diff` | `routes/git.js#handleGitDiff` | `?dir=&file=`；未跟踪文件回退到 `--no-index`；`400 {error:"missing dir/file"}` |
| `POST` | `/api/git/checkout` | `routes/git.js#handleGitCheckout` | `{dir, branch}`；分支允许名单 `^[A-Za-z0-9._/-]+$` + 前导 dash 守卫；`400`；超过上限 → `413 {code:"BODY_TOO_LARGE"}` |
| `GET` | `/api/settings` | `routes/settings.js#handleGetSettings` | 完整 settings 投影 |
| `POST` | `/api/settings` | `routes/settings.js#handlePostSettings` | 事件日志写失败 → `500 {error:"audit write failed"}`；handler 内 B03 authorize 守门 |
| `POST` | `/api/auth/decision` | `lib/authorize.js#handleAuthDecision` | `{requestId, approve}`；`200` 已决；`404` 无该挂起请求；`400` 非法 body；请求处理后通过删除已决条目实现幂等 |
| `POST` | `/api/upload` | `routes/upload.js` | 必须是 `multipart/form-data`；否则 `400`；`413 {code:"UPLOAD_REQ_TOO_LARGE"\|"UPLOAD_FILE_TOO_LARGE"\|"UPLOAD_QUOTA_EXCEEDED"}`；`400 {code:"UPLOAD_MALFORMED"\|"UPLOAD_ABORTED"}`；先写 `upload.create.intent` 后写 `upload.create`，全部 fail-closed；`200 {ok, path, name, size}` |
| `GET` | `/api/models` | `routes/model.js#handleGetModels` | 引擎模型 + webui 标签/限额投影 |
| `POST` | `/api/set-model` | `routes/model.js#handleSetModel` | `{model}`；未知 → `400` |
| `POST` | `/api/permissions` | `routes/model.js#handleSetPermissions` | `{mode}`；映射到引擎 `WEBUI_TO_MCODE_PERMISSION` |
| `GET` | `/api/permissions-modes` | `routes/model.js#handleListPermissionModes` | 引擎当前的 `availableModes` |
| `POST` | `/api/answer` | `routes/model.js#handleAnswer` | ask-user 模态答案 |
| `GET` | `/api/providers` | `routes/providers.js#handleGetProviders` | 掩码后的目录 |
| `PUT` | `/api/providers` | `routes/providers.js#handlePutProviders` | 整体替换；校验失败 `400`；写失败 `500` |
| `POST` | `/api/providers/test` | `routes/providers.js#handleTestProvider` | `{provider}`；结构化 code → status |
| `GET` | `/api/providers/presets` | `routes/providers.js#handleGetPresets` | 画廊 |
| `POST` | `/api/providers/preset/:id/enable` | `routes/providers.js#handleEnablePreset` | 一键启用 |
| `POST` | `/api/debug/inject` | `routes/debug.js#handleDebugInject` | `DEBUG_INJECT=1` 守门 |
| `GET` | `/api/debug/state` | `routes/debug.js#handleDebugState` | 同上 |
| `POST` | `/api/protocol/set-mode` | `routes/protocol.js#handleSetMode` | 会话中途切换 mode |
| `POST` | `/api/protocol/set-config-option` | `routes/protocol.js#handleSetConfigOption` | `configId:'permissionMode'` 即为权限 mode 切换 |
| `POST` | `/api/protocol/cancel` | `routes/protocol.js#handleCancel` | acp `session/cancel` 通知 |
| `POST` | `/api/protocol/load-session` | `routes/protocol.js#handleLoadSession` | `?cwd=`，缺省取当前 |
| `POST` | `/api/protocol/activate-session` | `routes/protocol.js#handleActivateSession` | 一个 acp 客户端跟踪一个活动会话 |
| `GET` | `/api/protocol/list-sessions` | `routes/protocol.js#handleListSessions` | `?cwd=` 过滤 |
| `GET` | `/api/protocol/capabilities` | `routes/protocol.js#handleCapabilities` | `{mcodeVersion, mcodeName?, mcodeTitle?, capabilities: MCODE_ACP_CAPABILITIES, notes}` |

### 旧派发器（`server/router.js`）

| 方法 | 路径 | 仍保留在此的原因 |
| --- | --- | --- |
| `GET` | `/api/events` | SSE 通道：响应写入器由 `lib/state-bus.js` 跨帧持有（Hono 流式变体留待 P2） |
| `GET` | `/api/alerts` | 独立异常 SSE 通道（铃铛图标 + 审计日志） |
| `GET` | `/trajectory`、`/trajectory/...` | 独立面板；SPA 回退到 `/trajectory/` |
| `GET` | `/`、`/index.html` | `serveIndex` / `auth-gate.html` |
| `GET` | `*.<ext>` | 静态（webapp/out） |
| `OPTIONS` | `*` | 204 短路（CORS 预检） |

Hono 仍然为所有实际请求持有 `/api/health` 与 `/api/settings`；旧派发器里的副本仅为让门禁测试（`checks/router-origin-gate.check.mjs`）有路径可以断言。

### `authorize()` 动作白名单（`lib/authorize.js#AUTHORIZE_ACTIONS`）

任何跨过破坏性边界的 HTTP 请求都会进入每个 cid 的 authorize 往返（默认
5 分钟超时，失败即关闭）：

- `session.delete` — `DELETE /api/sessions/:id`
- `sessions.cleanup-orphans`
- `session.cleanup-all`（扩展钩子）
- `session.export` — `GET /api/sessions/:id/export`
- `session.search` — `GET /api/sessions/search`
- `token.reset`
- `slash.clear` — 对话流上的 `/clear` 和 `/new`
- `startup.cleanup` — 启动时的孤儿清理

白名单是唯一可信源 —— 不在列表里的无法走模态门禁。

## 架构

运行时拓扑、请求生命周期和 SSE 契约见 [`packages/webui/docs/ARCHITECTURE.md`](../packages/webui/docs/ARCHITECTURE.md)。简言之：`packages/webui/server.js` 注册 workspace 导入解析器，并委派给 `server/bootstrap.js`；`server/router.js` 应用门禁链（CORS → origin/CSRF → LAN → token → rate limit → read-only）并分发到 `server/routes/*`；`server/lib/*` 存放单一职责模块；`acp.mjs` 是生成引擎的 ACP 客户端；`webapp/out/`（Next 静态导出）是 UI，`public/trajectory/` 与 `public/auth-gate.html`（从导出根提供）是仅存的旧版资源。

HTTP 层一分为二：旧派发器保留流式 / SSE 与 auth-gate / SPA 回退，其余路由统一注册到 Hono 应用（`server/app.js`）。`OWNED_ROUTES` 是可供 grep 的字面清单，`ownsRequest(method, pathname)` 在运行时根据 Hono 路由表决定派发归属。

## 轨迹工作室

`server/trajectory/`（从 mcode-trajectory-studio 插件迁移而来）通过运行时 SQLite 投影以只读方式检查本地会话，并以 `messages.jsonl` 作为回退，提供轮次/时长/令牌/压缩/子代理视图。它挂载在 `/trajectory/`，位于 webui 的门禁之后，也可以独立运行：

```bash
node packages/webui/server/trajectory/main.mjs --serve   # loopback panel
node packages/webui/server/trajectory/main.mjs --doctor  # data-source diagnostics
node packages/webui/server/trajectory/main.mjs --stdio   # MCP over stdio (7 tools)
```

七个 MCP 工具定义在 `packages/webui/server/trajectory/mcp.mjs`：
`trajectory_list`、`trajectory_summary`、`trajectory_get`、
`trajectory_search`、`trajectory_tasks`、`trajectory_task_output`、
`trajectory_studio`。服务器名 `mcode-trajectory-studio`，版本
`0.1.1`，支持的协议版本由新到旧依次为 `2025-06-18`、`2025-03-26`、
`2024-11-05`。

## 开发与测试

```bash
pnpm --filter @mavis/webui test      # full node:test suite (unit + mocked + integration + matrix + trajectory)
pnpm test:webui                      # same, from the repository root (CI gate)
node packages/webui/scripts/check-docs-alignment.mjs
```

该包有三个运行时依赖（HTTP 层的 `hono` + `@hono/node-server`，以及工作区路径约定的 `@mavis/shared`），需要 Node 22.19+（轨迹工作室另外需要 `node:sqlite`，下限 22.13）。

## 起源

该包把社区 mcode-webui 插件（v1.0.0 → v2.0.0，MiniMax-Code-Plugins PRs #16/#23/#31/#55）和 mcode-trajectory-studio 插件（PR #56）迁移进了产品。完整的人员与历史记录见 [co-builders.md](../co-builders.md)。
