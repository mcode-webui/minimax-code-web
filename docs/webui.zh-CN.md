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

slice 27 把同一姿态延伸到写入侧：`POST /api/fs/write` 走完全相同的
containment 闸门、套用完全相同的凭据判断（默认拒绝；`confirm:true`
放行写入并输出 `endpoint:"write"` 的 `credential.override` 审计行），
并在写盘前比对调用方携带的（修改时间、大小）基线——磁盘已变则
`409 {code:"conflict"}`，外部修改不会被静默覆盖。写入本身是对围栏
内路径的裸 `writeFileSync`：无 shell、无 exec、无命令拼接。

## 传输选择（ACP、exec 或 runtime）

发出的每条消息由三种传输之一送达引擎：长驻的 ACP 子进程（`mcode acp`）、一次性的 exec 子进程（`mcode exec`），或——S2 新增的——**进程内 runtime 宿主**（`packages/webui/server/lib/runtime-host.js`），它拥有与 TUI 同一份 `CliService`。选择发生在服务端、按回合进行，页面上**没有任何提示**。本节记录当前源码的实际行为，不是长期不变的契约。

三种传输是什么：

- **ACP**（默认）：与 TUI 相同的协议通道（`mcode acp` 子进程）。工具调用过程、会话标题、思考等级等事件都从这条通道回传。
- **exec**：一次性 `mcode exec` 命令行子进程。回合结束进程即退出，只有思考与正文文本回传。
- **runtime**（S2 起提供）：进程内 runtime 宿主。它没有子进程边界，与 `mcode` CLI 共用同一份 SQLite；S3 已把目录类流量（会话列表/标题）接到它上面，S4-S6 逐步接其余路由，S7 才把默认值翻过来。开关设为 `runtime` 只影响目录类流量——活跃回合今天仍走 ACP。

S2（runtime-first 改造第二步）新增了一个开关与 `MCODE_USE_ACP` 并存：

| 环境变量 | 缺省值 | 可选值 | 含义 |
| --- | --- | --- | --- |
| `MCODE_USE_ACP` | 未设 | `0` → exec 逃生阀（压倒其他所有）；`1` → 无效；未设 → 无效 | 旧开关，仅作逃生阀；见下表。 |
| `MCODE_WEBUI_TRANSPORT` | `acp` | `acp`（与今天一致）、`exec`（无路由消费，是 no-op；今天走 exec 仍要靠 `MCODE_USE_ACP=0`）、`runtime`（S2 起的进程内宿主；S3+ 接目录类流量） | 选择引擎传输。缺省下每个响应都与 `main` 字段级一致；显式 `runtime` 把目录类流量（list/title）切到进程内宿主。 |

判定优先级（按顺序）：

1. `MCODE_USE_ACP=0` ⇒ `exec`，无视 `MCODE_WEBUI_TRANSPORT`。旧逃生阀优先级最高。
2. `MCODE_WEBUI_TRANSPORT=exec` ⇒ no-op。当前没有任何生产路由消费这个值；今天要走 exec 仍要靠 `MCODE_USE_ACP=0`。**先把契约写在这里**，避免后续切片接线时漂移。
3. `MCODE_WEBUI_TRANSPORT=runtime` ⇒ **目录类流量**走 runtime（S3+）；活跃回合今天仍走 ACP（S4 接）。**单次调用遇错回退 ACP**——runtime 宿主挂了不会让侧栏黑屏。
4. `MCODE_WEBUI_TRANSPORT=acp`（缺省）⇒ ACP。权限模式静默改道仍然生效。
5. 未知取值（例如拼错）⇒ 回落到 `acp`，并在 stderr 打印一行告警。**永远不会因为传输开关未知而拒绝启动。**

| 条件 | 实际走的传输 | 判定位置 |
| --- | --- | --- |
| 服务端环境变量 `MCODE_USE_ACP=0` | exec | `server/routes/chat.js#handleSend` |
| `MCODE_WEBUI_TRANSPORT=exec` | （no-op——与缺省 `acp` 等价；今天要走 exec 仍要靠 `MCODE_USE_ACP=0`） | `server/lib/config.js#MCODE_WEBUI_TRANSPORT`（路由尚未读这个值） |
| 会话权限模式不是 Full access（Ask / Auto / Read） | exec（在 ACP 入口内部静默改道） | `server/lib/mcode-acp.js#runMcodeAcp` 首个分支 |
| `MCODE_WEBUI_TRANSPORT=runtime`（S3+） | runtime 接目录类流量（会话列表/标题）；活跃回合今天仍走 ACP，S4 接 | `server/lib/acp-client.js#listAllMcodeSessions` / `#getMcodeSessionTitle`（runtime 宿主失败时回退 ACP） |
| 其余情况（出厂默认：权限 Full access，见 `server/lib/state-bus.js` 初始状态） | ACP | 同上 |

S2 不变量（后续切片必须继续守住）：

- **缺省 `MCODE_WEBUI_TRANSPORT=acp` 与 `main` 字段级一致。** 现有任一端点的响应都不能偏移；进程内不能多出新的子进程。每次提交都用完整 webui node:test 套件在无 env 覆盖的情况下跑一遍来验证。
- **S2 只建宿主骨架。** `createCatalogueHost` 与 `createTurnHost` 从 `server/lib/runtime-host.js` 导出。**S3 已把目录类路径（list/title）接进 `acp-client.js`**；S4 接活跃回合，S5 接模型，S6 接交互与账户。S7 才把缺省翻为 `runtime`。
- **目录宿主回传运行时的 application 句柄，且句柄只在进程内。** `createCatalogueHost` 回传 `adapter`、`cliService`、`apiHost`、`controller`、`application`、`applications` 与 `close`。`application` 是进程本地产品门面（`events` / `models` / `skills` / `plugins` / `permissions` 等）；`applications` 是功能应用树。回合 diff 只在后者上：`applications.session.diff` 提供 `getTurnDiff` / `revertTurnDiff` / `reapplyTurnDiff`，而进程本地门面**根本没有 diff 成员**——从 `application` 上读 diff 恒为 `undefined`。两个句柄都留在服务端进程内：今天没有任何路由对外提供它们；后续把 diff 接成端点的切片必须自行鉴权并收窄面，而不是把整棵树原样转发。
- **目录类流量由 `MCODE_WEBUI_TRANSPORT=runtime` 选择性接管。** 该开关点亮列表/标题走 catalogue 宿主；单次调用遇错（boot 失败、`adapter.listSessions`/`adapter.getSession` 抛错）就回退 ACP——单点 runtime 故障不会让侧栏黑屏。`mcodeSessionsCache` 两条路径共用，一次填充后任何一侧都能读到，所以目录里看到的会话列表不依赖某条特定路径。
- **目录投影镜像 ACP 适配器 `toAcpSessionInfo` 的规则集**（`server/lib/catalogue-sessions.js`；规则出处 `packages/tui/src/acp/agent.ts`，判定谓词在 `packages/tui/src/runtime/delegation.ts`）：内部子代理会话（worker `purpose` 前缀 `local-task:` / `local-background-task:` / `team-plan:`、`sessionKind: "task"`、或内置子代理 `agentName`——`explore` / `worker` / `verifier`）与 cwd 缺失或非绝对路径的会话不会出现在侧栏，与 ACP 侧的丢弃行为一致；空标题与无时间戳直接省略键——线上形状永远不会出现 `title: null`。`catalogue-via-runtime.test.js` 用独立再推导的期望页做逐字段对拍锁死这些规则；其零子进程探针为相对基线——窗口开启前已存在的后代算环境噪声，而窗口内真实发生的 spawn 仍会被断言抓住。
- **R1 缓解（进程隔离丧失）落在回合宿主里。** 任何对 `adapter.sendMessage` 的调用都被包在边界内——runtime 侧抛出转为流式 error 帧，**永远不会冒泡出回合**。`packages/webui/test/server/runtime-host.test.js` 用一处删掉内层 try/catch 的变异验证这条边界——边界没了测试就红。
- **R2 缓解（取消语义）落在 `createTurnHost#abortSession`。** 它在最多 5 秒内等待流归位，然后返回 `{success:true, elapsedMs}`；**不依赖子进程 kill**，因为已经没有子进程。超时上限保证即便 runtime 卡死也不会拖累优雅停机。
- **R8 缓解（宿主卡死）落在 `createCatalogueHost#close`。** 它把 `apiHost.close()` 与 5 秒超时赛跑——任一依赖链卡死都不会拖累 webui 的优雅停机。

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

**没有 `/exec` 命令。** 不存在通过聊天命令切换传输的入口；webui 按钮命令集是 `new` / `clear` / `status` / `sessions` / `review` / `help` / `usage` / `stop`（`server/lib/interaction/command-registry.js#CMD_BUTTON_COMMANDS`），且它是这份命令集的唯一声明处。`server/lib/acp-client.js` 的命令缓存直接用它填充 `webui` 组，所以 `/help` 与输入框的斜杠命令面板列出的命令，与 `POST /api/cmd` 实际接受的完全一致，`/review` 也在内（此前 `acp-client.js` 里另有一份手写清单漏了 `/review`，导致 `/help` 与面板和 400 分支给出的命令表对不上；该副本已删除，`packages/webui/test/lib/command-list-drift.check.mjs` 钉住了这个关系，不会再漂移）。切换传输只有上表的两个开关：环境变量与权限模式。

权限模式接口与警告语义见 [`packages/webui/docs/API.md`](../packages/webui/docs/API.md) 的 `POST /api/permissions` 一节；面向贡献者的契约细节（判定代码位置、不变量）见 [`webui.md`](webui.md) 的 Transport selection 一节。

## 引擎能力声明（engine-abstraction 批次 B1）

webui 服务端新增了一个内部引擎层 `packages/webui/server/engine/`，它的第一件事是**能力声明**：webui 实际接入的每一个引擎面，都以「代码评审管住的模块常量」形式声明自己在 14 个能力键上支持到什么程度；部分支持（`partial`）必须**枚举缺哪些子项**。设计结论与每个取值的取证矩阵在工作文档 `doc/engine-abstraction-design.md`；代码里的声明才是运行时真源。

为什么用声明而不是「调一下试试」：一项能力缺失必须是**调用之前就能读到的事实**，而不是调用中途撞上的异常；更绝不能是静默的空实现——返回空列表或 `{ok:true}` 等于告诉用户「成功了一无所获」，这是本仓库 #110 修掉的假成功失败模式，本层在结构上杜绝它。

14 个能力键（键 ↔ 设计矩阵行）：`sessionCrud`（会话 CRUD）、`streamingSend`（流式发送）、`interrupt`（中断）、`toolSkillInvocation`（工具/技能调用）、`turnDiff`（回合级 diff 查询）、`turnRewindRedo`（回合撤销/重做）、`plugins`（插件管理）、`mcp`（MCP）、`subagents`（子 agent）、`usageStats`（用量统计）、`authCredentials`（认证/凭据）、`updateCheck`（更新检查）、`fileReadWrite`（文件读写）、`gitOperations`（Git 操作）。

三档语义（规则在 `server/engine/capabilities.js`）：

| 档位 | 含义 | 前端呈现原则（后续 UI 批次执行） |
| --- | --- | --- |
| `full` | 面完整 | 正常渲染 |
| `partial` | 必须附 `missing` 子项清单与 `reason` | 控件可用，缺失子项对应的次级操作隐藏/禁用并带说明 |
| `none` | 必须附 `reason`，区分「接口无」（面上根本没有该方法）与「实现无」（上层有、该面未开窗） | 入口整体不渲染，不留永远失败的按钮 |

两个已接入面的当前声明（取值逐格照取证矩阵誊录，并在 `26043e9b` 基线上对着实际方法面复核——adapter 91 个方法、CliService 94 个方法加 `applications.session.diff` 门面）：

| 键 | local-runtime-v2 | tui-runtime-adapter |
| --- | --- | --- |
| sessionCrud | full | full |
| streamingSend | full | full |
| interrupt | full | full |
| toolSkillInvocation | full | full |
| turnDiff | full | none（adapter 实现无） |
| turnRewindRedo | full | partial——缺 `reapplyTurnDiff` |
| plugins | full | partial——缺 `previewGithubPlugin`、`importGithubPlugin`、`listEnabledPlugins` |
| mcp | full | full |
| subagents | partial——缺 `getDelegationSnapshot`、`stopDelegation`（在 adapter 上下文，不在 CliService 面） | full |
| usageStats | full | full |
| authCredentials | full | full |
| updateCheck | none（接口无） | none（实现无） |
| fileReadWrite | partial——缺 `file-write` | partial——缺 `file-write` |
| gitOperations | partial——缺 `git-diff`、`git-commit`、`git-branch` | partial——缺 `git-diff`、`git-commit`、`git-branch` |

### `GET /api/engine-capabilities`

只读、声明直出（不起 host、不探测）。返回一个面的声明，附「哪些能力不可用」的汇总——后续能力驱动的 UI 以此渲染，**代码里不出现按引擎名单隐藏功能的逻辑**：

```
GET  /api/engine-capabilities[?provider=<id>]
200  { ok, provider, transport, capabilities: { <键>: {level, missing?, reason?} × 14 },
       unavailable: { none: [键…], partial: [{key, missing}…] } }
404  { ok: false, code: "unknown_engine_provider", knownProviders: [...] }   // 调用方写错了 id
```

默认返回 `local-runtime-v2`（M4 把 ACP/exec 包成 provider 之前唯一注册的 host 面）。`?provider=` 写错答 404——它不可能与保留给「引擎缺能力」的 501 混淆。

### 调了未声明的能力 → 501

`server/engine/errors.js` 定义 `EngineCapabilityNotSupportedError`（结构化字段：`capability` / `provider` / `missing` / `reason`）。`assertEngineCapability` 在能力为 `none`、或 `partial` 命中缺失子项时抛它。两个 HTTP 层（Hono 层 `app.js#invokeHandler` 与旧分发器 `router.js`，与既有 413 请求体上限映射同一处集中处理）统一转成：

```
501 { ok: false, code: "engine_capability_not_supported", capability, provider, missing?, reason?, error }
```

用 501 而非 400/404/500：请求本身没写错，是**引擎面缺这个功能**——与 `routes/protocol.js` 既有的 `unsupported` → 501 同款。前端把 `engine_capability_not_supported` 当作**预期降级**（按上表三档隐藏入口），不弹错误提示。

### 迁移状态与边界

- **本批只做迁移第一步 M1**：host 构造（`createCatalogueHost`）原样移入 `engine/providers/local-runtime-v2.js`，`runtime-host.js` 转发导出，既有引用方零改动；没有任何现有路由行为变化，`GET /api/engine-capabilities` 是纯新增端点。
- **M2 已做（声明与实现的快照校验）**：`packages/webui/test/lib/engine/capability-snapshot.test.js` 在隔离的临时数据目录上起**真实** catalogue host（`MINIMAX_DATA_DIR` 与全部 `MCODE_WEBUI_*` 路径在 provider import 前钉死），审计两个 provider 的每个 `full`/`partial` 键——`full` 要求跟踪的方法在声明的 surface（`adapter` / `cliService` / `applications.session.diff`）上全部存在；`partial` 要求存在的部分在、方法名形态的 `missing` 项真的不存在、kebab-case 子能力（`file-write`、`git-diff`）没有覆盖方法；`none` 不做方法校验。方法跟踪表是对真实 surface 的反射取证（adapter 91 个 / CliService 94 个方法），不是抄设计矩阵；同文件的变异测试钉住改档位、删方法、子能力长出方法各自必然红。注册表驱动的守卫（`engine/index.js#listEngineProviderIds`）拒绝任何携带 14 键契约之外键的 provider 声明，拼错无法静默通过。
- **启动只读探测（设计稿 §2.3 第 2 步）本批刻意不做**：尚无路由消费探测结果，而接探测要动 M1 明确不动的 catalogue host 生命周期；随第一个需要它的 A 批路由一起落。
- **新 provider 准入规则**（由 `packages/webui/test/lib/engine/capabilities.test.js` 快照测试钉住）：14 键全声明；`partial` 必须枚举 `missing` 与 `reason`；声明档位被测试钉死——不经重新审计改档位，CI 直接红；调未声明能力一律答结构化 501，绝不给空实现。

## 客户端能力协商，以及引擎反向发来的请求

ACP 握手是双向的，两个方向都由同一份 `initialize` 载荷决定。这一节说明 webui 声明了哪些能力、为什么清单这么短，以及引擎发来的请求在 webui 没有应答界面时会怎样。

### webui 声明了什么

`packages/webui/acp.mjs` 把能力放在 **`clientCapabilities`** 字段下——这才是引擎读取的 ACP v1 `InitializeRequest` 字段（`packages/tui/src/acp/agent.ts:434`）。取值是导出的常量 `CLIENT_CAPABILITIES`，目前只有一项：

| 声明的能力 | 它打开的引擎行为 | webui 真的消费吗 |
| --- | --- | --- |
| `plan: {}` | `plan_update` 会话更新（开关在 `agent.ts:1328`，发送在 `agent.ts:1356`） | **消费**——`streamAcpPrompt` 写入 `cs.plan`（`server/lib/mcode-acp.js:1138`），计划弹窗渲染它 |
| `elicitation.form` | `elicitation/create` 请求通道（`acp/interactions.ts:607`） | 不消费——没有表单界面 |
| `auth.terminal` | initialize 响应里的 `authMethods`（`agent.ts:455`） | 不消费——没有终端可以跑 `mcode login` |
| `_meta['minimax-code/extensions']` | goal / queue / delegation / 当前会话通知（`acp/extensions.ts:277`） | 不消费——没有代码订阅这些方法名 |

能力是对「我会应答」的承诺，所以清单只放 webui 真的消费的那一项。没声明的三项并非零成本：`elicitation.form` 会让引擎发来 `elicitation/create` 请求，而本客户端只能拒绝，随后引擎会直接关掉那份运行时问卷（`acp/interactions.ts:647`）——一份用户在 TUI 里本来能答的问卷就这样消失了。扩展 `_meta` 则是纯粹的成本而无消费方：这些通知以顶层 ACP 方法的形式到达，而 webui 唯一处理的 `goal_update` 是 `session/update` 的子类型（`acp.mjs:305`），是另一条通道。

字段名写错是静默失败，不是报错。引擎侧是 `params.clientCapabilities ?? {}`，意味着载荷放在任何别的键名下都等于什么都没协商，所有以能力为开关的投影全部保持关闭，且不会有任何错误提示。这就是本树的原状：webui 发的是 `capabilities: { mcpCapabilities: … }`——这个键根本不是 ACP v1 `ClientCapabilities` 类型的字段，里面的成员类型里也没有声明——于是计划投影从未运行过。

### 来自引擎的请求

引擎在同一条管道上发自己的请求：`session/request_permission`、`elicitation/create`、`fs/read_text_file`、`fs/write_text_file`、`terminal/*`。`McodeAcpClient#_dispatch` 会逐一应答。带 `id`、带 `method`、且既无 `result` 也无 `error` 的消息就是请求。JSON-RPC 的 id 是分方向编号的，引擎的请求可能复用了 webui 自己 outbound 调用用过的 id，两个编号空间不能混淆。

在没有安装 `clientRequest` 处理器的情况下（就是当前状态），应答是一个 JSON-RPC 错误：`-32601`，并在消息里带上方法名。这里**沉默并不是安全的默认值**：

- 引擎只用取消信号等待这些请求（`acp/interactions.ts:562`）。一个没人应答的请求会占住一个交互调度槽位直到连接结束；待处理队列一旦溢出，整条 ACP 连接会被关闭（`interactions.ts:242`，`MAX_PENDING_INTERACTIONS`）。结果是传输直接死掉，而不是降级。
- 拒绝一个请求正是引擎自己的处理结果，不是新引入的行为。抛错的请求会得到 `decision = 'deny'`（`interactions.ts:581`）；答不出来的问卷会被 fail-closed 地关闭（`interactions.ts:647`）。

用错误而不是伪造一个「已取消」结果，是为了明说本客户端压根没考虑过这个问题，同时把方法名带进引擎的日志。每次拒绝还会在 webui 侧打印 `[acp] declined unhandled client request: <method>`，这样「引擎在问本客户端做不到的事」是看得见的，而不是靠推测。

留给真实交互界面的接缝是构造函数选项 `clientRequest`：`(method, params) => result | Promise<result>`。它的 resolved 值成为 JSON-RPC 的 `result`；抛错或 reject 变成错误响应，携带抛出的 `message` 与（若有）`code`，否则为 `-32603`。webui 目前没有安装任何处理器——把一次决定真正送到浏览器是另一件事，诚实的现状是 webui 没有可提供的交互界面。

### 这次拿到了什么、没拿到什么

`plan: {}` 打开的是**通知**，不是提问。计划评审只有一个 `approve` 选项，而运行时把 `allowOther: true` 固定在每一步上，所以引擎会走问卷通道 fail-closed 地了结它，而不会把它变成一次权限请求——这正是「声明 `plan`」对一个什么都答不了的客户端仍然安全的原因。权限请求通道是另一个开关，webui 从不打开它。

有两个后果**不在**本次范围内，但接手的下一位必须知道：

- 收到 `plan_update` 不等于能对它做决定。webui 的计划弹窗没有一条能到达引擎的决定通道，载荷映射也是另一个问题：引擎把正文嵌在 `update.plan = { type, planId, content }` 里，顶层一个字段都不放。
- 问卷与权限两个界面仍然是黑的。webui 会拒绝自己答不了的问题，这稳定且诚实，但不等于「有能力回答」。

## 思考等级（哪些模型能调、调了会发生什么）

输入框旁的思考等级控件只在模型声明了可调档位时出现；模型没给档位就不挂控件——挂一个点了没反应的控件比不挂更糟。当前各家的真实情况：

| 模型 | 控件形态 | 调了会发生什么 |
| --- | --- | --- |
| `MiniMax-M3` | 两档：关闭 / 开启 | 切到哪档，下个回合就以该档发送：引擎侧对应「不思考 / 思考」两个变体，消息发出前即生效 |
| `MiniMax-M3.1-Flash-Preview` | 六档深度：default / low / medium / high / xhigh / max | 深度随请求下发；思考本身不可关闭（引擎标定 forced_on），但深浅可调 |
| `MiniMax-M2.7` / `MiniMax-M2.7-highspeed` | 无控件 | 引擎侧思考恒开、无可调维度，如实不显示 |
| 第三方供应商里声明了 effort 档位的模型（如 zai-pro、nousresearch 下的多数模型） | 该模型声明的档位，原样列出 | 深度随请求下发 |

为什么 M3 只有开/关，不是低/中/高：这不是 UI 偷懒。引擎给 M3 的配置就是两个变体——「不思考」与「思考」（自适应），没有中间档。控件如实展示两档；编造四档选择器会让用户以为在调深度，实际引擎根本不区分。等引擎给 M3 开出真正的深度档位，`/api/models` 会原样带出来，控件自动跟着变。

初始状态是「默认」：M3 的引擎默认是思考开启，M3.1-Flash 的默认深度是 default，用户不主动选就一直沿用，不会替用户做选择。

等级在界面上有四处可见、两处可编辑：① 模型选择器级联里当前模型行上的等级徽标；② 输入框旁模型名后的等级后缀；③ 输入框旁的思考等级控件（编辑入口，位置未变）；④ 模型选择器里的两个详情区——面板底部详情区把**当前模型**的等级行展示为只读徽标，级联打开时旁边并排的设置列把**聚焦模型**的等级渲染为**可编辑的自适应控件**（第二个编辑入口）。

自适应控件的形态由模型的档位决定，只做前端形态、不做任何语义推导：

| 档位形状 | 控件形态 | 「归位引擎默认」入口 |
| --- | --- | --- |
| 恰为 `["off","on"]`（如 MiniMax-M3） | 一个开关（开=on、关=off） | 开关无归位项；用输入框旁控件的「默认」 |
| 其他任何多档（如 low/medium/high/max） | 单选组，**首项恒为「默认」**（提交空串） | 单选组首项 |

在设置列里改等级会**立即提交且菜单不关闭**，可以连续调；提交走的还是 `{thinking}` 这条请求，与输入框旁的控件完全同一条通道。聚焦的行不是当前模型时，设置列进入预览态：控件照常展示但禁用并标注「预览」——等级记录属于当前模型，替一个还没选中的模型提交没有契约意义。一条防错规则如实说明：当前模型记录的等级如果不被它自己支持（跨模型切换残留），控件不高亮任何一项，也不假装「引擎默认」被选中。

两点边界如实说明：

- 跨设备/多标签同步时，控件状态可能短暂显示引擎的原始值（形如 `MiniMax-M3 · thinking`），这是引擎会话回传的真实状态。本地刚做的选择有约 4 秒的优先期（期间不被引擎回传覆盖），优先期过后才同步跨端变更，通常数秒内恢复。
- 回合正在运行时切换档位，对当前回合不生效，下个回合按新档位执行（与模型切换同一语义）。

还有一条给运维的规则：如果操作者在供应商配置里手工写了与内置模型同名的条目，以操作者的条目为准，档位也只显示操作者写明的那些——内置的自动识别不再叠加。

这两处「例外」（供应商分组 + 思考等级的多处显示）背后是 `packages/webui/webapp/lib/model-groups.ts` 里导出的纯函数——`groupModelsByProvider`（按供应商归并，无 provider 的条目落到同一个「其他」桶）、`providerIdOfModel`、`isGroupDisabled`、`thinkingLevelsForModel`（判定某模型有没有可调档位）、`thinkingLevelKey`、`chipLevelSuffix`（等级后缀的陈旧残留守卫）、`modalityBadgeKey`、`providerLabel`——`components/composer.tsx` 直接 import 这个模块，不再在组件内联重推一遍规则，`webapp/test/composer-models.test.ts` 测的就是这些产品函数本身。此前该测试文件把分组逻辑抄了一份在自己的文件里，导致分组改坏测试照样全绿，红线⑤形同虚设；此次只是把同一段代码连同具名入参搬到 lib，**用户可见行为零变化**。调用点仍由 `webapp/test/composer-thinking-tripwire.test.ts` 钉住，「导出了但组件不再调用」这种半吊子提取也会失败。

接口契约（字段、两条下发通道、下发顺序——**先模型后档位**，顺序反了档位会被引擎拒掉、表现为"改了没生效"——与会话启动时的重放规则）见 [`webui.md`](webui.md) 的 Thinking levels 一节。

## 切换会话会带工作区一起切（webui-parity ticket 39）

切换到另一个会话时，当前工作区会跟到目标会话上次所在的工作区。文件树（slice 01）在新目录下重新取根；旧项目在 `sessionStorage` 里的 `webui:files-tree:<workspaceDir>` 展开态保留不动，所以切回去仍是同一份展开。

### 契约

`POST /api/sessions/switch`（`routes/sessions.js#handleSwitchSession`）按以下顺序解析工作区：

1. **目标会话存的 `workspace`**——即该会话上一次被打开时所在的工作区。该字段在旧的实现里被污染过，所以这里读出来就是用户上次看到的样子。
2. **`DEFAULT_WORKSPACE`**（环境变量 `MCODE_WORKSPACE` > mcode TUI 的 `cwd.json` > `homedir()`），当存的值为空字符串时。空值是老会话、或被 ticket 39 标记为 ② 污染过的记录会出现的形状。
3. **解析得到的路径无法通过 `assertWorkspacePath` 围栏**时（例如会话记录的工作区落在用户后续收窄的 `MCODE_WEBUI_WORKSPACE_ROOTS` 之外），**400 拒绝**，不让用户带着非法工作区进入路径。

选定的路径走的是工作区选择器（`/api/workspace`）、`browseWorkspace`（`/api/workspace/browse`）、新建会话 POST、`/api/fs/*` 共用的同一道 `assertWorkspacePath` 围栏——拒绝切到越界路径，与选择器拒绝落在越界位置是同一条边界。

切换**永远不会**用前一个 `cs.workspace.dir` 覆盖目标会话存的 `workspace`。那是旧代码的行为（ticket 39 的 ② 污染路径）：在项目 A 首次打开某个 `mvs_` 会话时，新建的壳记录被印上 A 的路径，于是按项目分组的会话表里把 A 的目录复制给了每一个从 A 打开的会话。修复后，新建壳的 `workspace: ""`，由后续的「读目标，缺失则 DEFAULT_WORKSPACE」逻辑接管。

切换**不会**更新 `cs.lastUsedWorkspace`。侧栏"最近"排序（slice 07）只由 `handleSend` 写——切换是浏览，不是创作；旧版"点哪个会话哪个就置顶"的用户反馈已经把那条契约钉死了。

### Mid-run 安全

回合正在跑的时候切换会话**不会**打断这个回合。回合的所有权和流缓冲以 `(cid, mcodeSessionId)` 为键存在 `lib/state-bus.js#runChatByCid`，与工作区无关。引擎子进程持有回合开始时的 cwd，新的 `cs.workspace.dir` 只是"接下来要在哪个工作区里看"。终态时（`routes/chat.js` finalize drain）的行为保持不变——仍在查看就写进 `cs.chat`，已切走就走 `appendChatToSession(owningSid, lines)`。

### 同一标签页内的跨会话并行

一个标签页可以同时跑两个会话。`POST /api/send` 取的回合占用以
`(cid, 会话)` 为键，不再只按 `cid`。

`cid` 是**浏览器标签页**级标识——`localStorage['webui_cid']` 只生成一次，
并且有意跨会话切换保持不变，好让一个标签页始终只持有一份客户端状态、
一条 SSE 通道、一套合并/修订簿记和一条 `mcode acp` 传输连接。这些保持标签页
级是有意为之。回合占用不在此列：只按 `cid` 加锁时，一个会话里的长回合会把
同一标签页内其他**所有**会话的发送一并用 `409 cid-busy` 拒掉，直到它结束。

| 情形 | 结果 |
| --- | --- |
| 会话 B 的回合在跑，同时往会话 A 发送（同一标签页） | `200`，并行执行 |
| 同一会话在其回合运行中再次发送 | `409 cid-busy`——防重复执行守卫（#126 D-2） |
| 另一个标签页/客户端已在跑同一个引擎会话 | `409 session-busy` |
| 全服活动回合数超过 `MCODE_MAX_CONCURRENT` | `409 at-capacity` |

会话键是 webui 记录 id，其中 `null` 是一等键：它代表该标签页尚未落盘的草稿，
而草稿本身就是一个会话，且一个标签页至多有一个。`handleSend` 在该记录尚不存在
时就先占用（全新会话此时还没有 id），并在几条语句之后创建它——中间没有
`await`，所以占用会由 `moveRunSession` 重新指向新 id；否则往该会话的第二次
发送会找到一个空闲键，从而起一个重复回合。

「会话是一等键」带来两条需要在别处依赖的后果，值得写明：

- **首回合的记录 id 会在回合运行中改变。** 草稿会在回合中途被提升为引擎身份
  （`bindDraftToMcodeSid`），`cs.sessionId` 随之改变，于是占用时的那个键不再
  与当前视图匹配。因此每个回答「这个会话是不是正在流式输出的那个」的查找，
  都会回退到引擎会话 id——它是不变的。这也是为什么在回填落地之后，往一个
  首回合会话的重复发送得到的是 `session-busy` 而不是 `cid-busy`：两者都拒绝。
- **`MAX_CONCURRENT` 计的是回合数，不是忙碌客户端数。** 一个标签页跑两个会话
  会占用两个名额，因为这本来就是两个引擎子进程——这正是该上限要约束的资源。

保持标签页级的部分，以及在两个活动回合下为何依然正确：

| 关注点 | 键 | 仍然正确的原因 |
| --- | --- | --- |
| 客户端状态、SSE 通道、快照修订、推送合并 | `cid` | 一个标签页一份投影本就是契约；快照内部由 `snapshotViewFields` 按会话收窄 |
| 流式行缓冲（`runChatByCid`） | `(cid, engineSessionId)` | 本来就是按会话的。`createRunChat` 只替换调用方自己那个回合的键——原先整标签页替换会抹掉兄弟会话正在写的行 |
| 运行指示器 / 「思考中」状态 | 当前查看的会话 | `viewOwnsLiveRun` 解析的是所查看会话的回合，兄弟会话的回合既不会点亮也不会熄灭本视图的指示器 |
| 引擎子进程、`/api/stop`、会话 RPC | `(cid, engineSessionId)` | 每个回合一个子进程。`/api/stop` 与 `session/cancel` / `session/set_config_option` 都指向**当前查看**会话的子进程；按标签页查找会信号到错误的回合 |

### 用户能看到什么

- **侧效**：文件树面板在新工作区下重新取根；旧工作区的展开/过滤/显示隐藏项仍存在 `sessionStorage` 里，新工作区从它自己存过的展开态（若从未打开则为空）开始。
- **失败形态**：越界的工作区返回 `400`，带围栏的明确文案（`工作区越界: <path> 不在任何允许根内。允许根: …`）。`cs.workspace.dir` 不会被改，前一个工作区继续生效。
- **历史上被污染过的会话**（修复之前被打上过错误工作区路径的记录）：新规则会原样读出存的值。用户看到的是被污染过的目录的文件树，需要打开工作区选择器重选一次预期目录；那一次重选会把存的值改写成 canonical realpath。

### 改动落在哪里（给后续维护者）

- `routes/sessions.js#handleSwitchSession` 新增 `_resolveSwitchWorkspace(target, currentWs)`，在 target 解析完成、`resetContext` 之前写入 `cs.workspace = { dir: switchWs.dir, branch: null, tree: null }`。
- `routes/sessions.js#handleSwitchSession` 不再向 `ensureOverlayForMcodeSid` 传 `workspace: ws`——新建壳的 `workspace: ""`，由读路径在首次 `mvs_` 接触时回退到 `DEFAULT_WORKSPACE`。
- 响应负载多了 `session.workspace` 和 `session.workspaceFallback`；尾部 `pushStateFor(cid)` 推 SSE 时原样带上新的 `cs.workspace.dir`，`FilesPanel` 通过 `useSessionContext()` 订阅自然重新渲染，前端**不**需要为了这次修复改动任何接线。
- `routes/sessions.js#_eventsAppend("session.switch", …)` 写入 `workspace` 和 `workspaceFallback`，事后追查"为什么文件树跳了"时可以从审计链里直接定位。

## 左侧边栏（webui-parity ticket 47）

左侧边栏对照参照实现做了三块对齐：折叠行为、导航项、会话列表。用户看到的变化与不变化如下。

### 折叠行为

- **折叠宽度 64px**（原 52px），折叠/展开是 180ms 的宽度过渡。折叠后侧栏背景转为透明，只剩一条图标轨——**不是**参照里折叠后整条清空的空竖条；图标轨可用性更高（新建/搜索/插件与头像菜单都还在），是保留的现有能力。
- **折叠开关移到了侧栏之外**：一个浮在界面上层的 32px 按钮，展开时贴侧栏左上角，折叠后浮在图标轨右侧。它的读屏标签随状态在「展开导航栏 / 收起导航栏」之间切换（中英两语都切）。
- **折叠时主内容有左补偿**：会话顶栏的标题行在折叠时保持大约原来的水平位置（`pl-[142px]`），不会因为侧栏收窄而向左跳一截。
- 三项既有能力**保留未动**：拖拽调宽（240–400px）、视口窄于 980px 时自动折叠、折叠偏好持久化（沿用既有的 `webui:ui-state` 键，未新增键）。

### 导航项

侧栏导航是「新建会话 / 搜索 / 插件」三项。参照里另有「定时 / 网站 / 远程」三项，它们在参照中是不可点击的占位（inert）；本仓库的既定决策是不渲染没有落点的占位控件，这三项**不出现**在界面上，属于产品拍板项（见 HANDOVER 融合清单）。当前所在界面对应的导航项有**激活态高亮**：树列正在显示「搜索」或「插件」表面时对应行高亮；没有会话选中（首页）且没有别的表面占屏时，「新建会话」高亮。

### 会话列表

- **选中态与悬停态可区分**：选中行用 `bg_interaction_tertiary_selected`，悬停用 `bg_interaction_tertiary_hover`——此前两处都写悬停令牌，「我在哪个会话」的信号是丢失的。如实说明边界：这两个令牌在**浅色主题下上游定义为同一个值**（都映射 `--opacity_black_1_4`，见 `tokens.css`），视觉区分只在**深色主题**成立（悬停 `opacity_white_0_4`、选中 `opacity_white_0_8`）；浅色下的同色是上游设计令牌的现状，不是本工单引入的回归。
- 「项目」小节头是 28px 高的纯文本行（不可交互）；此前它渲染了一个没有点击行为的按钮，读屏用户会聚焦到一个点不动的控件，已移除。
- 空态是带圆角与背景的卡片面；错误态带 `role="alert"` 并把失败原因（网络错误 / HTTP 状态等）直接透出，而不是只有一句通用文案。
- 项目/目录/子代理的展开收起有 180ms 高度 + 140ms 透明度过渡；系统开启「减弱动态效果」时过渡关闭，内容照常显示。
- 会话行与子代理行是 `?session=<id>` 的深链（`<a>`）：普通左键行为不变；中键 / Ctrl+点击在新标签打开的 URL，冷加载恢复机制（「重开不乱」）本来就会认。
- **揭示机制保持每目录 6 条**（「更多 (N)」逐目录展开），没有引入参照的全局 Load more——每目录揭示更省界面空间且已上线。

### 参照有、本轮未实现（如实说明）

参照实现的右键上下文菜单（置顶 / 归档 / 复制为新会话 / 删除）、置顶与归档的本地 overlay 排序、Agent Team 徽标与工作区目录副行、「最近任务」小节——**本轮均未实现**。前两项依赖服务端契约（置顶、归档、复制均无端点），需要与后续工单统一排期；后两项在参照自己的壳里也没有渲染点。后续 agent 不应把它们误判为「已实现但坏了」。

## 会话标题栏的版本标识（webui-parity 89）

会话标题栏这一行的右端有一个版本标识：**分支名、commit 短编号、这次提交距今多久**。它的用处是不开终端就能回答「我现在看的是哪个检出」——当构建表现异常而手上有不止一个检出时，这正是要问的问题。

| 状态 | 渲染结果 |
| --- | --- |
| 至少有一次提交的仓库 | `分支 + 短编号 + 相对提交时间` |
| 不是仓库的目录 | **什么都不渲染**，整个元素不在 DOM 里 |
| unborn HEAD 的仓库（`git init` 后没有提交） | 什么都不渲染——没有可指名的提交 |
| detached HEAD | 只显示短编号，不用占位词假装有分支 |
| 请求失败或尚未返回 | 什么都不渲染 |

「不渲染」的那些情况才是契约本身，不是事后补丁：一个空壳胶囊是一个看起来能用、实际什么都不说的控件。所以 `resolveVersionBadge` 返回 `null`，组件渲染出空字符串，`webapp/test/toolbar-version-badge.test.ts` 双向钉住了渲染结果。

**放在哪。** 标识落在标题行的最右端（`ml-auto`），与它所限定的会话标题分居一行两端，并且在该行 `pr-20` 预留位**之前**，所以 `fixed right-4` 的启动器按钮组永远不会压到它。正在运行时它排在运行状态指示之后。窄屏下只有相对时间有专门规则（`hidden lg:inline`）：分支名和短编号才是标识一个构建的东西，所以留下它们、时间让位；过长的分支名截断，而不是把标题栏撑宽。

**点击复制短编号。** 它是一个真的 `<button>`，带 `aria-label` 和一闪而过的「已复制」提示，不是装饰性文字。剪贴板被拒绝时不显示提示，而不是给一个用户会照着信的假确认。

**数据与代价。** 工作区变化时读一次 `GET /api/git/status`——和右栏 Git 面板读的是同一个端点，不是第二份真相源。它**不轮询**：大仓库上一次 `git status` 是一次真实的索引刷新，版本身份是在用户提交或切分支时变化的而不是按时间表变化，Git 面板也已经定下了「工作区变化 + 显式刷新」的先例。相对时间那半完全不需要重新请求——它挂在标题栏本来就有的 1 秒计时器上，而那个计时器本来就在为耗时计时付费。Git 面板打开时会有两个请求同时在飞；这是被接受的，而不是为了一个自己并不渲染的面板把面板状态提升到壳之上的 provider 里。

## 上下文窗口（模型选择器里能调什么、切了之后发生什么）

模型选择器里的设置详情有**两级**。面板底部有一个详情区，**恒显示当前模型**的设置（等级徽标 + 上下文窗口单选组）；打开某个供应商的级联时，浮层变成参照式的**两列**：左列是该供应商的模型行，右列是一个**跟随聚焦行**的设置列——鼠标悬停或键盘聚焦到某个模型行时，设置列立即切到那个模型，不必点选；级联刚打开、还没有聚焦任何行时，设置列回退显示当前模型。两处详情读同一份草稿镜像（见下），在任何一处点窗口档位，两处的高亮同步移动。

当前模型声明了至少两个上下文窗口档位时，详情区显示一排「上下文窗口」单选按钮；没声明或只有一个档位的模型不渲染这组控件。当前只有 `MiniMax-M3` 和 `MiniMax-M3.1-Flash-Preview` 有档位（512K / 1M），其余模型一概没有。档位标签是紧凑的 token 数（512K、1M）；引擎标注为「更高用量」的档位（1M）会带「用量较高」提示，如实告知成本差异。两列浮层整体限制在视口内（高度不超过「视口高 − 16px」），超出时左列和设置列各自内部滚动——短视口下设置列的等级控件不会被级联遮住。

聚焦的行不是当前模型时，设置列进入**预览态**：窗口与等级选项照常展示（先看清这个模型能调什么），但控件禁用并标注「预览」——设置记录属于当前模型，替一个还没选中的模型提交档位没有契约意义；要调整，先把模型选中。设置列还有两条空态文案：没有可描述对象时（既无聚焦行也无当前模型）显示「选择一个模型查看设置」；目标模型既无窗口档位也无思考等级时，**先显示模型名、再显示「这个模型没有可调设置。」**——详情区是 `aria-live="polite"` 播报区，光播报一句文案会让屏幕阅读器用户不知道说的是哪个模型。聚焦行切换时屏幕阅读器会播报。

当前选中的档位按两条规则高亮：用户点过的选择优先；没点过时高亮引擎报告的当前生效窗口（`/api/models` 的 `contextLimit`），不会替用户虚构一个选中态。哪里能点什么：**上下文窗口档位在设置列和面板底部详情区都能点**，点的瞬间立即提交且菜单不关闭，可以连续调整；**等级只能在设置列（或输入框旁的控件）点**——面板底部详情区里的等级是只读徽标。提交走同一条 `/api/set-model` 请求，本批未改任何请求字段。

菜单打开期间，前端还维护一份**草稿镜像**：每次提交先写进本地镜像再等服务器确认，所以点完的瞬间高亮就移动，服务端往返或目录刷新（`/api/models` 重拉）期间也不会闪回旧值；关闭菜单即清空镜像，重新打开时从服务端持久化的状态读起。

### 模型选择器的关闭语义（实测）

- 点击菜单外部（`pointerdown`）→ 关闭整个菜单。
- 点击模型行 → 选中该模型并关闭整个菜单。
- 在设置列改设置（点等级、窗口档位）→ 立即提交，**菜单不关闭**，可连续调；面板底部详情区的窗口档位同样可点击提交，等级在那里是只读徽标。
- 触发按钮上按 `↓` / `→` → 打开菜单并把焦点移到第一行（`↑` 移到最后一行）；之后在供应商行上按 `→` 进入级联并聚焦首个模型，级联内 `↑`/`↓` 循环、`Home`/`End` 跳首尾——整条链路纯键盘可达。
- 级联子菜单打开时按 `←` → 只关级联、焦点还原到供应商行，菜单保持打开；按 `Escape` → 关闭整个菜单（级联随之关闭，焦点回到触发按钮）。

边界如实说明——在 webui 里切换档位，选择会被记录并立即反映在选择器上，但**当前引擎还不会按这个选择执行**：引擎的 ACP 配置通道没有承载上下文窗口的参数位（模型选择的编码格式里没有这一段，已对照随引擎发布的 0.5.5 产物与源码双重确认）；引擎自己的模型选择接口虽然支持该参数，但只对 TUI/运行时客户端开放。随档位一同下发的模型切换本身照常即时生效。把这个参数接进引擎侧执行是引擎侧工单的工作，webui 侧已经把「校验 → 记录 → 回读」的接缝留好。与思考等级相同：切换到一个不声明当前档位的模型时，该档位会在同一次请求里被清除（引擎默认兜底）。

接口契约见 [`webui.md`](webui.md) 的 Context window 一节。

## 文件树（已发布的 UI）

下方每个已发布的文件树、面板与列都给出组件文件锚点与一个
`data-testid`，可在源码中检索。

| 表面 | 组件 | 锚点 `data-testid` |
| --- | --- | --- |
| 侧栏（rail） | `components/shell.tsx` | `sidebar-scroll-viewport` |
| 侧栏折叠开关（侧栏外浮层，工单 47） | `components/shell.tsx` | `sidebar-collapse-toggle` |
| 侧栏会话树 | `components/session-tree.tsx` | `sidebar-session-row` |
| 会话树项目小节头（纯文本，工单 47） | `components/session-tree.tsx#SectionHeader` | `sidebar-section-header` |
| 会话树错误态（`role="alert"`，工单 47） | `components/session-tree.tsx` | `sidebar-tree-error` |
| 侧栏用户菜单（设置 / 升级 / 每日签到 / 用量 / 反馈与帮助 / 退出登录 + 底部用户卡，工单 55c 起全行集） | `components/shell.tsx#SidebarFooter` | `sidebar-user-menu` |
| 项目右键菜单（工单 55c） | `components/session-tree.tsx#ProjectNode` | `project-context-menu` |
| 主页快捷能力胶囊（工单 55c） | `components/chat.tsx#HomeState` | `home-quick-capabilities` |
| 侧栏 inbox（告警浮层） | `components/inbox.tsx` | `inbox-flyout` |
| 顶栏（带模型选择器） | `components/toolbar.tsx` | `toolbar-session-status` |
| 顶栏版本标识（分支 + 短编号 + 提交时间，webui-parity 89） | `components/version-badge.tsx` | `toolbar-version-badge` |
| 录入区与拖放浮层 | `components/composer.tsx` | `composer-drop-overlay`、`composer-send-button` |
| 对话（≥ 200 条时虚拟滚动） | `components/chat.tsx` + `chat-virtual-list.tsx` | `chat-virtual-top-spacer` |
| 轮次耗时条（工单 46 PR3 起复合文案与输出速度） | `components/activity-group.tsx#TurnProcessDisclosure` | `turn-process-disclosure` |
| 轮次条展开箭头（工单 61 还原，驱动该回合的活动组） | `components/activity-group.tsx#TurnProcessDisclosure` | `turn-process-trigger`、`turn-process-chevron` |
| 流式指示短语轮换（工单 61 还原） | `components/loading-states.tsx#ActivityPulse` + `lib/thinking-phrases.ts` | `activity-indicator-label` |
| 活动组（可折叠的工具轮次，工单 46 起在 `activity-group.tsx`） | `components/activity-group.tsx` | `activity-group-header` |
| 思维链块（思考过程折叠行，工单 46 PR2） | `components/activity-group.tsx` | `thinking-block` |
| 工具卡片（单次工具调用，工单 46 PR3） | `components/activity-group.tsx#ToolCard` | `tool-card` |
| 文件预览（右预览列主体） | `components/file-preview.tsx` + `file-preview-pane.tsx` | `file-preview` |
| 文件树列（列 4） | `components/workspace-tree-column.tsx` + `panels.tsx#FilesPanel` | `files-tree-root` |
| 文件树搜索（服务端，slice 19a；slice 19b 联调） | `components/panels.tsx` | `files-tree-filter` |
| 侧栏树列「搜索」表面（slice 19b） | `components/workspace-tree-column.tsx#SearchSurface` | `tree-surface-search-input` |
| 代码预览（slice 22 IDE 级：行号槽 + 按语言懒加载高亮 + 字节保真复制） | `components/code-view.tsx` | `code-view`（内嵌于 `file-preview`） |
| 三态外观选择器（slice 18；工单 37 起挂在设置页「通用」内） | `components/appearance-card-picker.tsx` | `appearance-card-picker` |
| Git 面板（slice 03） | `components/panels.tsx#GitPanel` | `git-panel` |
| 浏览器面板（slice 04，沙箱化 iframe over `/api/fs/raw`） | `components/browser-panel.tsx` | `browser-panel` |
| 工作区选择器（模态） | `components/workspace-picker.tsx` | `workspace-picker` |
| Provider 配置 | `components/provider-management.tsx` | `providers-panel` |
| 添加模型弹窗 + 已获取模型弹窗（工单 54；验收第二轮拆为独立文件以便渲染级测试；工单 56 视觉对齐） | `components/add-model-dialog.tsx#AddModelDialog` / `#FetchedModelsDialog`（受控面 `#AddModelDialogForm` / `#FetchedModelsDialogBody`，纯函数 `#collectDialogErrors` / `#defaultChecked`） | `provider-dialog`（字段 `provider-dialog-provider-select` / `-api-key` / `-api-key-reveal` / `-model-add` / `-autofetch` / `-models-empty` / `-cancel` / `-save` / `-footer` / `-errors`；条目 `provider-dialog-entry-{n}` 含 `-name` / `-context` / `-max-output` / `-thinking` / `-attachment-{mod}` / `-test` / `-test-result` / `-reset` / `-remove`）/ `fetched-models-dialog`（`fetched-models-title` / `-item-{id}` / `-select-all` / `-cancel` / `-add`） |
| 上下文窗口 | `components/context-meter.tsx` | `context-meter` |
| 设置模态 | `components/panels.tsx#SettingsModal` | `settings-modal` |
| 设置页「用量与模型」节的分段页签（工单 53） | `components/panels.tsx#UsageModelsSection` | `usage-models-segment`（页签 `usage-models-tab-token-plan` / `usage-models-tab-custom-models`） |
| 设置页「用量与模型」节的套餐卡 / 用量卡 / 积分卡 / 发票卡（工单 37 起，工单 53 重构） | `components/panels.tsx#PlanCard` / `#UsageCard` / `#CreditsCard` / `#InvoiceCard` | `settings-plan-card` / `settings-usage-card`（进度条 `usage-bar-fiveHour` / `-weekly` / `-video`）/ `settings-credits-card` / `settings-invoice-card`（`invoice-apply-link`） |
| 错误边界（全局 + 路由级） | `app/error.tsx` + `app/global-error.tsx` | `global-error-page` |

## 四列工作区（当前主线，slice 17 + slice 21）

在侧栏右侧，外壳渲染一个最多容纳三列**可见列**的 flex 行：`conversation | preview | tree`。侧栏由 `AppShell` 自己拥有，在该行之外渲染，并在行内宽度里视为 0（`workspace-tabs-state.ts:738-744`）。

### 列宽 — 真值表

下表每一格都来自 `COLUMN_SPECS`（`packages/webui/webapp/lib/workspace-tabs-state.ts:412-456`）。这是改"列宽数字"的唯一地方：`DEFAULT_COLUMN_LAYOUT`（`workspace-tabs-state.ts:479-506`）会自动跟上；`clampWidth`（`workspace-tabs-state.ts:511-515`）和 `computeColumnLayout`（`workspace-tabs-state.ts:724-854`）在每次渲染都会读它。

| 列 | 角色 | 默认 | 最小 | 最大 | 流动方式 |
| --- | --- | --- | --- | --- | --- |
| `sidebar` | AppShell 自身的 chrome，在列行之外 | 240 | 220 | 400 | 固定 |
| `conversation` | 弹性，吃掉剩余空间，**实际列宽不会被 2400 截断** | 720 | 280 | 2400 | 流式 |
| `preview` | 按需 — 查看面（`file:<path>`、`browser`） | 400 | 320 | 720 | 固定 |
| `tree` | 按需 — 导航面（`files`、`git`、`tasks`、`search`、`plugins`） | 340 | 320 | 600 | 固定 |

**`conversation.maxWidth = 2400` 只约束手动拖拽分隔条时写入存储的值**（`workspace-tabs-state.ts:511-528`）——布局算法明确忽略它，让 `conversation` 在固定列吃完各自上限后吃光剩余像素（算法注释见 `workspace-tabs-state.ts:438-443`、`:702-720`，实现见 `:805-823`）。**视觉上的真正约束是聊天内容里的居中阅读宽度 960 px**（`components/chat.tsx:38-52`、应用在 `:255` 与 `composer.tsx:532`）：这是一条 CSS 硬上限（`mx-auto max-w-[960px]`），只要列宽达到 960，内容就停在 960 并居中显示，左右均分剩余留白。

### 调一个数字会发生什么

- **改 `defaultWidth`**：影响首次进入工作区时的初始宽度（持久化里没存值的场景）。已经存过值的用户不会被影响——他们存的是上一次拖拽的结果。
- **改 `minWidth`**：用户在分隔条上拖窄时，能被钳到的下限变小。同时影响 `computeColumnLayout` 在溢出时折这一列的下限（`workspace-tabs-state.ts:863-866`）。
- **改 `maxWidth`**：拖拽上限变化；**对 `preview` 与 `tree`，还意味着"列能吃多少剩余像素"的天花板变化**（`workspace-tabs-state.ts:868-870`）。**对 `conversation`，用户拖拽写入值的上限变化，但增长路径不受影响——它始终吃光剩余**。这是唯一一个 `maxWidth` 与"看到的列宽上限"不一致的列，原因写在 `:438-443`。
- **改 `flow`**：把 `conversation` 改成 `fixed` 会让布局回到溢出折叠路径，且 `preview`/`tree` 的剩余像素不再流向 `conversation`——请不要这样做，算法里没有按 `flow === "fluid"` 分支处理，是按列 id 硬编码的（`workspace-tabs-state.ts:805-823`）。

### 空闲态：用户实际看到的列宽

两个按需列（`preview` 与 `tree`）首次进入时都收起（`workspace-tabs-state.ts:494-504`）。空闲态下，`conversation` 吃光视口减去侧栏的所有剩余像素——这是**算式结果**，不是配置里的常量，更不是上限：

| 视口 | 侧栏 | `conversation`（空闲态） | 计算 |
| --- | --- | --- | --- |
| 1280 px | 240 | **1040** | `1280 − 240` |
| 1920 px | 240 | **1680** | `1920 − 240` |
| 2560 px | 240 | **2320** | `2560 − 240` |

只要用户不打开按需列，以上算式在任意视口下都成立——视口再宽，列就再宽。**这意味着**：若发现"空闲态对话区变窄了"，要么是侧栏被拖宽了（受 400 上限钳位，`workspace-tabs-state.ts:416`），要么是某个固定列没有收起。空闲态**不会**被 `conversation.maxWidth` 卡住。

### 至少一个固定列打开时：剩余像素给谁

`computeColumnLayout`（`workspace-tabs-state.ts:724-854`）在固定列未到上限时按 **`tree` 先吃、再 `preview`** 的顺序吃剩余像素，每个都受各自 `maxWidth` 约束（`workspace-tabs-state.ts:793-815`）。剩余像素没有的话，`conversation` 停在它的存储宽度（默认 720）。

举例：1920 视口（容器 = `1920 − 侧栏 240 = 1680`，与空闲态表和"只开 preview"算例同一口径，`workspace-tabs-state.test.ts:1028`）下两个固定列都在默认宽度（`preview` 400、`tree` 340、`conversation` 720，存储总宽 1460）：

- 容器剩余像素 = `1680 − 1460 = 220`
- `tree` 从 340 增长到 **560**（吃掉 220 px；由于剩余像素不够，没达到自己的 600 上限）
- `preview` 留在 **400**（剩余像素已经耗尽）
- `conversation` 停在默认的 **720** —— 没有剩余像素流向它

只开 `preview` 不开 `tree` 时（容器 1680，存储总宽 1120，剩余像素 560）：

- `preview` 从 400 长到自己的上限 **720**（吃掉 320 px）
- `conversation` 拿剩下的 240 px 加在自己的默认 720 上 → **960**（与 `workspace-tabs-state.test.ts:1077` 锁定值一致）

### 边界

- sidebar=240 + preview=320 + tree=320 + conversation=280 = 1160 px 整行。视口 = 1160 px 时 `conversation` 刚好被压到自己的最小值 280；视口再窄 1 px 就已经压破 280（例如视口 1159 → conversation 279），更窄的窄屏上 `conversation` 继续被压到 0，渲染器隐藏整列——这是 `workspace-tabs-state.ts:762-781` 的最后防线。
- 用户拖 `conversation` 分隔条时，写入值会被 `clampToConversation`（`workspace-tabs-state.ts:856-861`）钳到 `[280, 2400]`。如果拖到的值让整行溢出，算法会按"先折 `preview` → 再折 `tree` → 再折 `conversation`"的顺序消化溢出（`workspace-tabs-state.ts:747-781`）。
- 双击分隔条重置该列到 `defaultWidth`（`workspace-tabs-state.ts:533-536`）。**不会**重置其他列；不会影响收起/展开状态。

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
与自身服务端搜索相同的展开 + 高亮。**插件面板与插件后端同批交付
（68 号工单）。** `PluginsSurface`
（`webapp/components/plugins-surface.tsx`）已挂载到两个列宿主
（`panels.tsx:354`、`workspace-tree-column.tsx:645`），下文「插件
接口」一节的那十个 `/api/plugins/*` 端点，今天是由用户能真正打开
的界面调用的。其中 `plugins` 域是真数据——已安装列表、本地市场、
GitHub 导入——在「已安装」视图里，每张卡片带启用开关与一个需要
确认的卸载动作。`skills`、`apps`、`mcp`、`agents` 四个域尚无管理
端点，因此渲染一张说明缺哪项能力的 `pending` 卡，而不是塞一份
编造的列表。

表面种类统一通过 `openSurfaceTab("…")` 触发；右栏种类
（`PanelKind`）是单独收紧的并集：`"workspace" | "files" | "git" |
"plugins" | "browser"`。原先发布的 `search`、`alerts`、`progress`
已**从 `PanelKind` 并集中移除**（见
`packages/webui/webapp/lib/persist.ts#PanelKind`）；`alerts` 通过独立
的铃铛图标 `InboxFlyout` 组件进入，`progress` 没有实际的入口点。

列间分隔条宽 8 px，支持拖拽改宽（夹在 `[minWidth, maxWidth]` 内）
和双击重置。

### 插件接口（60 号工单阶段①）

本节描述的是**那块面板背后的契约**：十个端点、入参，以及调用方必须
处理的各态。用户在 `plugins` 域里实际拿到的是「市场」与「已安装」
两个视图、两个视图都有的一行关键词框、只出现在市场侧的分类下拉与
来源切换、一个刷新按钮，以及分两步走的 GitHub 导入（先预览 URL，
再确认导入）。只有 `plugins` 域会发起请求；四个 pending 域一次请求
都不发。真正决定这些能用到多少的是两条数据事实：本地市场、已安装
列表与 GitHub 导入是真数据，而官方市场在本地版不可达。

`webapp/lib/api.ts` 为每个端点暴露一个类型化函数：

| func_name | 端点 | `api.ts` 函数 | 入参 |
|---|---|---|---|
| `plugins.list.installed` | `GET /api/plugins/installed` | `listInstalledPlugins` | `keyword?` `limit?` `cursor?` |
| `plugins.list.marketplace` | `GET /api/plugins/marketplace` | `listMarketplacePlugins` | `source`（必填）+ 上述参数，另加 `category?` `skillLimit?` `skillCursor?` |
| `plugins.list.enabled` | `GET /api/plugins/enabled` | `listEnabledPlugins` | —— |
| `plugins.refresh.all` | `POST /api/plugins/refresh` | `refreshPlugins` | —— |
| `plugins.enable.by_name` | `POST /api/plugins/enable` | `enablePlugin` | `pluginName` `source?` |
| `plugins.disable.by_name` | `POST /api/plugins/disable` | `disablePlugin` | `pluginName` `source?` |
| `plugins.install.by_name` | `POST /api/plugins/install` | `installPlugin` | `pluginName` `source?` |
| `plugins.uninstall.by_name` | `POST /api/plugins/uninstall` | `uninstallPlugin` | `pluginName` `source?` |
| `plugins.import.preview_url` | `POST /api/plugins/import/preview` | `previewGithubPlugin` | `url` |
| `plugins.import.from_url` | `POST /api/plugins/import` | `importGithubPlugin` | `source`（`repositoryUrl` `commitSha` `subPath?`） |

调用方需要处理的各态，按契约定义。「渲染」一列是已交付面板的实际
做法，只有一行例外：`plugins.refresh.all` 从未被调用——面板上的刷新
按钮是重拉列表，而不是向该端点发请求。

| func_name | empty | loading | error | success |
|---|---|---|---|---|
| `plugins.list.installed` | `{ok:true, plugins:[], hasMore:false}` | 由消费方自理 | 200 `{ok:false, code}` | 一页数据，官方 + 本地合并 |
| `plugins.list.marketplace` | `{ok:true, plugins:[]}` | 由消费方自理 | `source=2` → 如实报错；`source=1` → 设计上的 notLocal 态 | 插件行，本地源另带 `marketplaceSkills` |
| `plugins.list.enabled` | `{ok:true, plugins:[]}` | —— | 200 `{ok:false, code}` | `{plugins:[{name, displayName?}]}` |
| `plugins.refresh.all` | —— | 刷新按钮 spinner | 透传运行时原 code | `{ok:true}`，随后重拉已安装列表 |
| `plugins.enable.by_name` | —— | 行内 spinner | `PLUGIN_NOT_FOUND` / `PLUGIN_AUTH_REQUIRED` / `PLUGIN_AUTH_SYNC_TIMEOUT` | `{ok:true, sourceKind, installExists, enabled:true}` |
| `plugins.disable.by_name` | —— | 行内 spinner | 同上三个 code | `{ok:true, sourceKind, installExists, enabled:false}` |
| `plugins.install.by_name` | —— | 按钮 spinner | `PLUGIN_AUTH_REQUIRED`；本地包为 `LOCAL_PLUGIN_INSTALL_UNSUPPORTED` | `{ok:true, sourceKind, installExists:true, enabled:true}` |
| `plugins.uninstall.by_name` | 目标不存在 → `{ok:true, installExists:false}` | 确认框 → spinner | 同上三个 code | `{ok:true, sourceKind, installExists:false, enabled:false}` |
| `plugins.import.preview_url` | —— | 对话框加载 | URL 非法 / `PLUGIN_NO_SUPPORTED_CAPABILITY` / 公网不可达 | `{source, plugin:{summary,…}, diagnostics, packageSizeBytes, canImport}` |
| `plugins.import.from_url` | —— | 按钮 spinner | `PLUGIN_ALREADY_EXISTS` / `PLUGIN_IMPORT_INVALID` | `{plugin:{summary}}`，导入即启用 |

**本地版唯一提供不了的端点，说清楚。** 官方市场需要云端账号，而本地版的
云端基址不可解析，于是 `source=1` 应答 `{ok:false,
code:"NETWORK_ERROR"}`。面板把它当作**设计好的状态** ——
渲染 `plugins.market.official.notLocal.*` 文案而不是红色错误 ——
并且在**发出请求之前**就短路（`mayRequestMarketplace`）：一次要等
30 秒超时才失败的请求，会让设计好的状态看起来像事故。官方源上安装 /
启停 / 卸载被拒时同理保持静默。其余全是真数据：已安装列表、
本地市场（独立技能 + 本地包投影），以及两个 GitHub 导入端点 ——
它们直接抓公网仓库，不经 registry。本地包**不能**安装（运行时答
`LOCAL_PLUGIN_INSTALL_UNSUPPORTED`），所以 `canInstall` 只对市场视图里
的官方行为真，本地卡片不渲染安装按钮，而不是给一个注定失败的操作
入口。

**写新调用前要知道的几条线上约定。** `source` 入参是数字
（`1` 官方 / `2` 本地）；出参里运行时的数字原样透传，路由另在页面、
每个插件行与每个变更应答上补一个不依赖协议的字符串 `sourceKind`
（`"official"` / `"local"`）。消费方分支判断必须用 `sourceKind` 而非
数字 `source` —— 这就是 webapp 不必依赖 `@mavis/protocol` 的原因。
市场列表**必填** `source`
—— 运行时把缺省读成「官方」，默默取默认值会让每个请求都打向不可达
的 registry。运行时失败是 200 + `ok:false` + 可分支的 `code`；请求被
拒则是 400，而 webapp 的封装把任何非 2xx 变成一个带服务端消息文本的
抛出异常 —— 也就是说 400 上的 `code` 读不回来，消费方必须在筛选条件
变化时重置过期游标，而不是去解析失败响应。游标与签发它的筛选条件
绑定：换了 keyword 再复用旧游标是
400 `PLUGIN_CURSOR_INVALID`。鉴权走共享门禁链；只读
模式下所有 POST 返回 403 —— 这是策略使然的不可用，不是故障。

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

## 设置页（工单 37 / 48）

入口在侧栏底部头像的用户菜单里。设置是一个全屏模态：左侧是分组导航（带搜索），右侧是内容列——通用页限宽 840px，其余页签 760px（工单 48 对齐桌面参照；此前统一 704px 是误把参照用量页的宽度当成了整页宽度）。本节说明每个分组里能改什么、影响什么、改了什么时候生效。

**导航结构与可用性**

四个分组共 10 个页签，每个都带桌面参照的 18×18 线性图标。「状态」一列写的是用户实际能拿到什么：**渲染出来但无法操作**的控制件叫「诚实占位」——那是设计如此，不是没做。真正没做的只有「工作树」一个。

| 分组 | 页签 | 状态 |
| --- | --- | --- |
| 偏好 | 通用 | 已实装 |
| 偏好 | 语音 | 已实装，控制件为诚实占位——麦克风下拉禁用且只有「本地版不适用」一个选项，两条听写快捷键显示「未设置」（浏览器里既没有设备枚举也没有听写输入） |
| 偏好 | 快捷键 | 已实装，只读——顶部「浏览器环境不适用」横幅下照抄桌面版 10 条默认键位，✕ / ↺ 操作件渲染但禁用 |
| 偏好 | 个性化 | 已实装——「自定义指令」与「关于你」真存 `localStorage`；两个记忆开关关闭且禁用、行内标注「本地版不适用」，「管理」按钮打开「记忆摘要」弹窗且恒为空态 |
| 管理 | 用量与模型 | 已实装；三来源是**视图切换器**——不切换实际使用的模型来源 |
| 管理 | 连接 | 已实装 |
| 管理 | 账户 | 诚实占位——「账户信息」显示「本地模式，未登录」，「退出登录」禁用（本地版未接入账户服务） |
| 编码 | 代码审查 | 已实装——「自定义审查准则」真存 `localStorage`；「审查方式」是禁用单选下拉，显示「子会话」 |
| 编码 | 工作树 | **未实装**——页签是一行文案「本地版暂不支持工作树管理」 |
| 归档 | 已归档任务 | 页签渲染空态「暂无已归档任务」；列表与其操作需要目前不存在的归档会话契约 |

**设置页没有「浏览器」页签。** 浏览器能力是工作区的一列标签页（`workspaceTabs.tab.browser`），在工作区标签里挂载 `BrowserPanel`，不是设置分区；`settings.tab.browser` 这个文案键没有任何调用点。本文早期版本曾在「偏好」组下列出「浏览器」页签，那是错的。

**通用页有哪些分区**

通用页自上而下（工单 48 起按桌面参照分区，每区有小标题、卡片、行间分隔线；设置行为横排两栏——左标题加说明、右控件）：

| 分区 | 状态 | 说明 |
| --- | --- | --- |
| 模式 | 禁用摆设 | 桌面版两张模式卡（适用于编程开发 / 适用于日常工作）按同款形态渲染，两张都是 `disabled`，编程卡预选中——本地没有模式切换 |
| 应用 | 可用 | 外观三选一卡片、语言切换。桌面版此处另有 5 个开关（菜单栏图标、开机自启、桌面通知、提前灰度、加速索引），本服务端无对应能力，**照常渲染但禁用** |
| 链接打开位置 | 禁用摆设 | 两行（网页链接、本地链接），下拉均为禁用的单选 |
| 文件 | 可用 | 两个开关，读写浏览器本地存储，见下表 |
| 会话管理 | 可用 | 一个开关，读写本地存储，**目前仅记录偏好**，尚无界面读取它 |
| Agent 控制权限 | 禁用摆设 | 「自动打开浏览器面板」开关渲染为关闭且禁用（无对应能力） |
| 偏好设置 | 可用 | 「跟进消息行为」单选（排队 / 立即发送），读写本地存储，**目前仅记录偏好**，尚未影响实际发送行为（编写器归工单 49）；水印与数据授权两行渲染为禁用 |
| 关于 | 混合 | 上传日志与检查更新是禁用按钮；本机地址与局域网地址是从 `/api/settings` 取值的真实只读行 |
| 页底数据目录（dataDir） | 未实现 | 桌面版在通用页底部显示应用数据目录；`/api/settings` 契约没有该字段且本轮服务端只读，无法取到真值，如实留空不做 |

应用分区里外观与语言的生效方式不变：点击立即生效；外观写入本地存储（`webui:ui:v1` 信封），刷新后保持；跟随系统时操作系统明暗切换页面实时跟随，无需刷新。

**本地存储的开关（工单 48）**

四个键与桌面参照同名同格式（裸字符串，非 JSON），因此同一浏览器配置在两个客户端之间偏好一致：

| 键 | 默认 | 影响行为吗 |
| --- | --- | --- |
| `file_open_in_new_tab` | `true`（本客户端默认开；桌面参照默认关） | **是**。开启时保持本客户端一贯的「每文件一个预览标签页」；关闭后打开新文件会**替换当前激活的文件标签页**。本客户端的标签条没有「固定」概念，故以「当前激活的文件标签页」为复用目标，与桌面「复用未固定标签页」语义近似但不相同 |
| `file_line_wrap` | `true` | **是**。开启时超宽行自动折行；关闭时横向滚动。覆盖两类表面：代码文件预览（工单 48）与 markdown 代码块——聊天消息、活动组、markdown 文件预览（工单 52）；语言标签不随代码行折行。对之后打开的预览/之后挂载的消息生效（已打开的不重排）；文件预览折行后行号与第二视觉行不对齐，是已知取舍 |
| `webui-context-window-usage` | `false` | 否。仅记录偏好，尚无界面读取 |
| `webui-follow-up-behavior` | `queue`（可选 `steer`） | 否。仅记录偏好，尚未影响实际发送行为 |

**搜索与排版细节（工单 48）**

- 搜索同时匹配**翻译后文案**与**内部 key**：输入 `custom-instructions` 能筛出「个性化」，输入 `usage` 能筛出「用量与模型」（本客户端部分页签 id 与参照 key 不同名，导航里带了别名映射）。
- 内容区顶部有当前页签的标题（`<h2>`），切换页签时标题跟随。
- 切页有 180ms 的横向淡入动画；系统开启「减弱动态效果」时动画关闭、内容照常显示。
- 搜索框是带边框的 36px 容器：前置搜索图标 + 输入框 + 有输入时出现的「清空设置搜索」按钮；返回按钮带「返回应用」文案。

**参照有、当前未实现（如实登记）**

以下能力桌面版设置页有、本客户端**没有实现**，避免误判为漏改：

| 能力 | 说明 |
| --- | --- |
| 账户页 | 页签按桌面形态渲染，但本地没有 `getAccountStatus` / `signOut` 类后端契约，账户行显示「本地模式，未登录」、退出登录禁用 |
| 已归档任务页 | 页签渲染空态；列表、恢复与删除需归档会话契约 |
| 用量与模型的三来源切换 | 分段页签已按桌面形态落地（工单 53），但它是**视图切换器**——不切换实际使用的模型来源；真实的 Token Plan / MiniMax API / 自定义模型来源切换与来源徽标仍需模型路由契约 |
| MiniMax API Key 面板 | 输入 + 测试连通性 + 保存并使用 |
| 自定义模型拖拽排序、逐模型启停、预设选择器 | 需 provider 契约扩展；添加已弹窗化（工单 54），编辑仍在列表 + 编辑器面 |
| 搜索关键词高亮 | 参照自己也没接线（定义了组件与动画但无调用点） |
| 通用页 dataDir 底注 | 见上表 |

**用量与模型**

页头 h2 下方是桌面的分段页签：「Token Plan 使用中 ⌄」（选中态浅灰胶囊，绿色「使用中」徽标与下拉箭头按桌面形态渲染；下拉按工单 53 拍板省略——本地版没有可切换的计划来源）｜竖线｜「自定义模型」。默认落在 Token Plan 视图；唯一的例外是模型选择器「新增供应商」深链（`autoAddProvider`）直接落在自定义模型视图，否则新增流程会在不可见面板里触发。

Token Plan 视图是桌面的五区块（页签 + 四卡）：

| 区块 | 数据策略 |
| --- | --- |
| 当前套餐卡（ⓘ + 两行 + 管理⌄） | 本地无云端账户数据源：套餐名与积分数值显示「本地版不适用」，到期行不渲染（不造假日期）；「升级」（黑底主按钮）/「管理 ⌄」/「去充值」渲染桌面同款形态但禁用 |
| 用量卡（三条进度条纵排） | 5 小时限额与周限额是唯一真实数据源（引擎经 ACP 上报，`POST /api/usage`；页面每 2 分钟自动读一次，手动刷新计入预测采样），有数据时印桌面格式「X% / 100%」/「X%」+ 相对时间重置文案（如「43分后重置」）；引擎未上报时该条显示「暂无用量数据」而非 0%；视频限额本地无数据源，固定显示「本地版不适用」 |
| 积分行（ⓘ + 蓝色开关） | 本地无积分体系：开关渲染桌面同款蓝色 iOS 形态但置灰（checked + disabled），文案照桌面，行内标注「本地版不适用」 |
| 发票行 | 唯一完全真实的外链：「申请 ↗」新标签打开 MiniMax 开放平台 |

自定义模型视图是原有供应商面板（API Key、协议、模型清单、连接测试、预设一键启用），`data-testid` 全部不改名；工单 54 把**添加**流程重做成桌面同款弹窗（见下节），列表 + 编辑器保留为编辑路径。

**添加模型弹窗（工单 54，53b）**

未配置任何供应商时，页签中央显示「暂未添加自定义模型」与「+ 添加模型」按钮；有供应商后按钮移到列表下方。模型选择器的「新增供应商」深链也落在同一弹窗。弹窗内：

| 区域 | 契约 |
| --- | --- |
| 提供商下拉（「请选择提供商」） | 选项 = `GET /api/providers/presets` 目录 + 「+ 其他（自定义）」：选预设自动填 id / 显示名 / 端点 / 认证类型并预填「API 格式」，选「其他」展开自定义字段（ID、显示名、认证类型、端点）。DeepSeek / Zhipu AI（智谱）/ Moonshot AI (China) 用桌面拼写，其余本地预设保留目录名；目录接口 404 时退化为仅「其他」 |
| API 格式 | 桌面版的**第二个**字段，**所有**供应商都渲染，不再只出现在「其他（自定义）」分支里。它就是既有的线上 `protocol` 字段、套用桌面文案（`OpenAI Completions` / `Anthropic Messages` / `Gemini`），后端不新增任何格式。选预设时按该预设自身的协议预填，之后仍可改。原本留在自定义分支里的那个协议下拉被**删除**而非并存——两个控件绑同一个值，正是预设分支与自定义分支对「最终存了什么」各说各话的根源 |
| 自定义 Headers | (名称, 值) 行列表，带「＋ 添加 Header」与逐行移除；内部用**列表**而非对象承载，半填的行才不会在编辑中丢失。空名丢弃、名称去空格而值不去、重复名后者胜——三条规则集中在 `headerPairsToRecord` 一处裁决，弹窗、PUT 请求体与服务端不可能各说各话。零行时渲染显式占位而非塌缩。折叠结果写入 PUT 请求体的 `auth.headers`，并由 `GET /api/providers` 的 `auth.headers` 回读 |
| API Key（密码框 + 眼睛） | 眼睛切换仅在这里安全：值就是刚输入的明文，不是脱敏占位——编辑器侧的保留密钥约定（masked 占位、空值哨兵）不变 |
| 模型条目（「模型 01…」 + 检测 + ↻ 重置 + 🗑 删除） | 五字段：模型名称→ `id`；上下文窗口→ `contextLimit`；最大输出 Token → **禁用并标注「本地版不适用」**（`/api/providers` PUT 契约没有该字段，可输入会在保存时静默丢失）；推理等级→ `thinkingLevels`（选项来自 `THINKING_LEVELS`，low/medium/high 契约冻结；桌面占位中的「max」示例故意不照抄）；支持的附件 → 图片/PDF/视频/音频 四复选框，映射 `image`/`file`/`video`/`audio`（`file` 自本轮起入选 `MODALITIES`；`text` 不受复选框控制、原样保留） |
| 「＋ 添加」/「自动获取」 | 添加追加空白条目；自动获取打开「已获取模型」勾选弹窗，列表是**所选预设的内置目录**并注明非按 Key 实时拉取——本地后端没有模型列表代理。未选预设时弹窗如实说明能力缺失，不造数据。「全选（n/N）」+取消/添加同桌面；勾选条目带目录元数据落入表单。两按钮各带 tooltip 说明分工（手动填写 vs 目录选择、自动获取仅读列表不保存配置）；条目为空时模型区渲染虚线占位「暂无模型：点击＋添加手动填写，或自动获取从所选预设目录中选择」，不再塌缩成空白 |
| 跳过连通检测 / 连通检测 | 桌面版的**表单级**检测，位于 footer 栏左侧。复用既有 `POST /api/providers/test` 契约，用表单当前值（协议、Key、端点**以及自定义 Headers**——探针必须发出真正会被发出的那个请求）得出一个结论，显示为「可达 · Nms」/「不可达：错误」。它与模型条目卡上的逐条「检测」是**不同粒度**——那条问「这个模型 id 答不答话」，这条问「这个供应商通不通」——所以两者并存。任一被探测的输入变化（提供商、API 格式、Key、端点、认证类型、任一 Header 行）都会清空结论：结论若能熬过编辑，那它就是对上游永远不会收到的那个请求的放行。Header 值在这条路径上会重新走一遍同样的校验，因为 test 端点直接取请求体的 `auth`，不经过 PUT 的归一化 |
| 取消 / 保存 | 保存前校验（已选提供商、id 唯一、逐条 `validateModelRow`），追加进面板列表后走**原有** `draftToWire` + `api.putProviders({version: 2})` 保存路径（请求体零改动）；失败时弹窗不关、已输入内容保留。按钮对位于独立 footer 区（上分割线 + 16px 留白），h-9 控件高度，主按钮黑底带 token 阴影。保存在**表单级检测通过前保持禁用**，与参照仓 footer 及参照截图里那枚灰掉的「保存」一致；「跳过连通检测」是连不上端点时的出口，旁边一行文字说明当前被哪一个卡住。禁用但写明原因、且有两个控件可以解除的按钮，不是死按钮 |

**工单 54 的不变量**：服务端契约零改动（`/api/providers` PUT 请求体、`/api/set-model` 与全部端点不动，变更只在前端 + 测试 + 文档）；面板/编辑器侧的全部既有 `data-testid` 在源码中保留（面板源码 pin 36 条 + 空态 2 条 = 38 条，与基线一致；`webapp/test/add-model-dialog.test.ts` 钉死清单）；预设目录、thinkingLevels 编辑语义、供应商分组与思考等级显示例外不变；深链仍落自定义模型视图，改为直接打开弹窗。旧的列表草稿式 `addProvider` 路径与编辑器失去调用方的自动聚焦参数一并删除，行为由弹窗收敛。

**验收第二轮（同工单）**：弹窗组件拆到 `components/add-model-dialog.tsx` 并导出受控面，测试升级为渲染级（`renderToStaticMarkup`，53a F-7 同款）——眼睛往返、校验错误块、取消重置落地面、勾选弹窗全选语义与 n/N 计数、零勾选/自定义供应商禁用态均由渲染标记 + 纯函数钉死（11 项回退行为的变异抽查全部转红）；PUT 请求体红线从调用点字面量升级为 `draftToWire` 的封闭键集断言（`provider-management.test.ts`）。一处表述更正：自定义供应商下「自动获取」链接**不是禁用**——可点开，弹窗内如实说明能力缺失，「添加」按钮禁用。

**工单 56 —— 弹窗视觉与交互对齐官方**（用户反馈：丑、交互逻辑布局不一致；对照 `design-ref/screenshots/byok-custom-model-official.png`）：

- **布局**：弹窗垂直居中（antd `centered`，两个弹窗一致）；卡片圆角 `--radius_12`、浮起阴影由 `--opacity_black_1_8`/`1_15` 透明度梯度组合（无字面量 rgba）；「取消/保存」移入独立 footer（上分割线 `border_default` + 16px 留白），按钮 h-9 控件高度、主按钮黑底带 `--shadow_default`；「模型」标题行的标签与操作按钮改为紧邻排列（原 `justify-between` 中间大空白造成视觉断裂）。表单体钳高 `90vh` 并内部滚动、footer 不随内容滚动——实机验证轮发现自定义分支全展开（5 个供应商字段 + 条目卡）时内容高 884px 超出 633px 视口，antd 遮罩不提供滚动，「取消/保存」落屏外不可达，钳制后 footer 在任意视口恒可见。
- **模型区空态**：无条目时渲染虚线占位提示（`provider-dialog-models-empty`），说明两条添加路径；「＋添加」「自动获取」各带 tooltip 区分分工。
- **连通检测（模型条目旁「检测」按钮）**：官方语义为「用当前填写信息检查对应模型能否响应」。本地实现复用服务端既有 `POST /api/providers/test` 契约（协议白名单 → 本地 Key 格式校验 → 按 baseURL 真实探测），无新增路由；探测请求由弹窗 shell 以当前表单值组装（预设分支用预设协议/端点，自定义分支用自定义字段），4 秒超时，结果显示「可达 · Nms」（成功色）/「不可达：错误」（错误色）。**粒度诚实标注**：该探测是接口级（baseURL + Key），不针对条目的模型 ID——按钮 tooltip 与本文档均如实说明，不冒充官方的模型级检测。按钮可用性镜像服务端本地校验：byok 预设需先填写 API Key，coding-plan 预设（claude-code / codex / opencode-go）无需 Key 即可检测。检测结果随输入即时失效：编辑/重置条目清除该条结果，删除条目后其余结果下标对齐，共享探测输入（提供商选择、协议、接口地址、认证类型、API Key）任一变化清除全部结果。本工单一并修复探测目标 bug：`testProvider` 此前读取并校验了 body 的 baseURL 却未下发（探测全部打到协议默认地址），现按路由注释既有承诺作为探测目标（`/api/providers` PUT 契约不动）。
- **自动获取语义核对（对照官方「读取列表供选择添加；不会保存配置」）**：本地行为一致——勾选结果只落入弹窗草稿，保存仅由「保存」按钮触发；与官方的差异是列表来源（本地为预设内置目录而非按 Key 实时拉取），勾选弹窗内已有诚实标注，行为无需改动。

**工单 85 —— 弹窗缺失的三个桌面字段**（`API 格式`、`自定义 Headers`、footer 的 `连通检测` / `跳过连通检测`）

新增入口**本来就已经是弹窗**——这部分是空操作，没有重复造。真正缺的是下面三项；56 号工单的模型条目「检测」与**页内编辑**流程两者都未动。

`自定义 Headers` 是三者中唯一需要改契约的，值得细读：

| 层 | 做了什么 |
| --- | --- |
| 弹窗 | (名称, 值) 行列表，由 `headerPairsToRecord` 折叠（丢弃空名、名称去空格、值不去、重复名后者胜） |
| `PUT /api/providers` | 新增**可选**字段 `providers[].auth.headers: Record<string,string>`。不带该字段的请求体与本工单之前逐字节相同；存量记录读入后为 `{}`——是加法，不是迁移 |
| `GET /api/providers` | `auth.headers` **原样、不脱敏**回传 |
| `engine-provider-sync` | 拷进引擎的 `options.headers`，空则省略。这是承重的一环：`local-runtime-v2` 本来就会把 `options.headers` 合并进该供应商的每次上游请求（`catalog/provider-views.ts:218`），所以运行时零改动 |
| `POST /api/providers/test` | 把 Headers 带进探针请求；该路由的 `auth` 直接取自请求体、不经 PUT 归一化，因此会再走一遍同一套校验 |

**为什么 Headers 不脱敏，而 API Key 脱敏。** API Key 脱敏，是因为它由服务端代为注入，运营者从不需要把它读回来。自定义 Header 是运营者自己敲的路由/租户配置，必须能读回来改；脱敏会造出一个只写不读的字段。运营者若把某个 Header **值**当成机密，在这里没有表达方式——诚实的说法是：这个字段不是放凭证的地方。API Key 仍是唯一脱敏字段。

**校验是拒绝，不是清洗。** 名称须符合 RFC 9110 token 语法，值不得含 CR / LF / NUL；任一条不合规则整份 PUT 被拒，错误里点名是哪个供应商、哪个 Header。静默删字符会让运营者以为这个 Header 生效了，而上游从未完整收到过。上限：20 条、名称 128 字符、值 4096 字符。

**探针的不对称，明说。** 连通检测把运营者的 Headers **先**展开，协议自身必需的 `Content-Type` / `anthropic-version` / `Accept` 后写覆盖之。探针回答的是「能否连上这个供应商」，不是「精确复现我的 Header」；让一个手滑的 `Content-Type` 把探针搞坏，等于让它回答了运营者没问的问题。生产请求路径没有这层限制。

**仍不做**（有意留给下一批）：桌面版「模型 01」嵌套子卡（模型名称 / 上下文窗口 / 最大输出 Token）是**只有截图**的形态——参照仓对应位置是一个「模型名称」textarea，也就是说桌面版比参照仓更新，没有第二处来源可对照核验。重建模型条目结构比本批大，本轮不动。

**工单 53 的不变量**：服务端契约零改动（变更面：`panels.tsx` / `usage-models-cards.tsx` / `icons.tsx` / `i18n.ts` + 两个测试文件）；h2 页头、切页动画与页宽 760 不变；`SETTINGS_NAV`、`SettingsSection` 联合类型、深度链接入口（`initialSection`、`autoAddProvider`）不变；本轮落地时还是占位的 8 个页签保持占位形态——设置模态移植壳（58）与其四个子页（55a）后来给其中大部分填上了内容，见上文导航表。删除了失去消费者的 `usage.used` / `usage.reset` 文案键（旧标签式「已用 X%」「重置时间」被桌面格式取代）。

**验收修复（2026-09-29 第二轮）**：用量条轨道改用 `bg-border_default`——原先照搬 context-meter 的 `bg-bg_grouped_tertiary_elevated` 在浅色主题下与卡片同为 `--gray_75`，三条进度条完全不可见（桌面参照恰是浅色主题）；发票「申请 ↗」改为与「去充值」/「管理 ⌄」同款的白底灰描边；整点重置文案省略分钟位（「1小时后重置」而非「1小时0分后重置」，键 `usage.duration.hour`）。四张纯展示卡拆到 `components/usage-models-cards.tsx`，`webapp/test/usage-models-cards.test.ts` 用 `renderToStaticMarkup` 断言渲染结果（占位文案、禁用态、轨道 token、外链、重置文案边界）——轨道 token 断言做过红绿验证：注入旧 token 时测试失败。

**工单 48 的不变量（本轮没有改的东西）**：服务端契约零改动（`server/routes/settings.js`、`server/routes/providers.js`、`server/lib/settings.js` 未动，全部变更都在前端）；`SETTINGS_NAV` 四组划分与三值 `SettingsSection` 联合类型未变；深度链接入口（`initialSection`、`autoAddProvider`）未变——模型选择器的「新增供应商」与用户菜单的「用量」仍然落到原来的位置；本轮落地时还是占位的 8 个页签，其内容由后来的设置模态移植壳（58）补齐。`SettingsPanel` 内部不可达的 `if (!section)` 分支已删除、`section` 参数改为必填（可达页签都能解析出 section，该分支本来就不可能渲染）。

**用户菜单的「用量」行**

原来悬停会弹出一个配额浮层；现在改为点击后直接跳到设置页的「用量与模型」节，浮层组件与其文案键已移除。配额数据不再有两处入口。

## 主界面三元素：用户菜单 / 项目右键菜单 / 主页快捷胶囊（工单 55c）

用户要求把桌面版主界面截图全部照抄。本工单覆盖其中三个元素，对齐原则沿用 53 的 A1 拍板：**有本地数据源的真做，没有的渲染桌面同款形态 + 「本地版不适用」诚实占位，不造假数据。**

**用户菜单**（侧栏底部头像，参照 ref-01）现在渲染桌面全行集：设置（带 `Ctrl+,` 徽标，浏览器里真实绑定）/ 升级 / 每日签到 / 用量 / 反馈与帮助 / 退出登录，底部多了一张用户卡（头像、显示名、套餐徽章、铃铛）。真做与占位的分界：

| 行 | 状态 | 依据 |
| --- | --- | --- |
| 设置 | 可用 | 打开既有设置模态；`Ctrl+,` 是本次新增的真实快捷键 |
| 用量 | 可用 | 跳设置页「用量与模型」节（沿用 2026-09-28 拍板） |
| 升级 / 反馈与帮助 | 占位禁用 | 云端账号计费与产品支持页，本地版没有这条路，悬停标注「本地版不适用」 |
| 每日签到 / 退出登录 | 占位禁用 | 引擎契约未落地（沿用既有处理），悬停标注「暂不支持」 |
| 用户卡 | 真做 | 引擎上报账号身份时显示真名与套餐徽章，否则显示「本地用户」占位、不渲染徽章；铃铛打开既有站内信浮层，未读红点同步 |

桌面菜单顶部的 UID 行不渲染：本地版没有账号 id 可印，空着或造假都违反本菜单其余部分遵循的诚实原则。

**项目右键菜单**（侧栏项目行右键，参照 ref-26）五项对齐桌面：重命名项目 / 置顶项目 / 在文件夹中显示 / 归档对话 / 移除（红）。

- 重命名与置顶是真做的。项目名与置顶状态存在浏览器本地（`webui:project-custom:v1`，见持久化键一节）——mcode 的运行时数据库里项目不是实体、没有可写入口，所以覆盖层放在唯一消费者所在处，与会话标题 `titleCustom` 的思路一致。置顶的项目排到列表最上，项目名旁常驻图钉标记。
- 在文件夹中显示是占位禁用：浏览器打不开操作系统的文件管理器。
- 归档对话是占位禁用：mcode 数据库虽有 `archived` 字段，但写别的进程的数据库不在本片范围，且已归档任务页（工单 55b）未落地前没有取消归档的入口——归档会变成不可逆的数据消失。
- 移除是真做的红色危险项：确认弹窗写明真实删除总数（主会话与子代理会话全量，不是侧栏角标的主会话数——不可逆确认不得少报）与不可恢复，并预告删除将逐个进行、期间会出现 N 次授权确认（服务端对每个单会话删除分别走 `authorize("session.delete")`，没有批量授权契约）；确认后弹窗内实时显示「正在删除 i/N」，逐个走既有的单会话删除端点，失败即停并报告。仅当全部删除成功时才清掉该项目的重命名/置顶记录（部分失败时存活项目保留其自定义），清理经组件状态与 localStorage 同步进行。

**主页快捷能力胶囊**（参照 ref-28）在主页输入框与项目行下方渲染桌面的五颗：视频生成（H3 徽标）/ Vibe Coding / 设计视觉 / 产品运营 / 询问 MCode。这些技能依赖云端运行时，本地版没有，所以点击后弹出「本地版不适用」的短暂提示（toast），胶囊本身不发送任何请求——形态照抄桌面，能力边界用一句话说清，不假装能启动。

回归钉在 `webapp/test/shell-elements-parity.test.ts`，分三层：全部 55c 文案键的双语覆盖（zh 逐字对照参照截图）；静态源码 tripwire（菜单行集、可用/禁用分界、危险色、批量删除接线——含确认弹窗必须引用真实删除集而非角标主会话数——以及胶囊点击接线与胶囊区不发请求）；以及 `lib/cap-toast.ts` 的**行为级**测试——toast 状态机特意拆成零依赖模块，点击→替换→按时戳消失的契约在 node:test 下直接跑，无需渲染 harness（质检 M6 轮：掏空点击处理函数体曾让所有源码断言全绿）。每层都做过针对各自目标变异的红绿验证。



## Markdown 里的 Mermaid 图（slice 23）

助手回复和 Markdown 文件预览共用一套渲染管线
（`webapp/lib/markdown.ts`，`marked` 是工作区既有依赖，不走 CDN）。在
代码围栏的语言位置写 `mermaid`，围栏内容就会被画成图，而不是显示为
代码块：

````markdown
```mermaid
flowchart LR
  需求 --> 开发 --> 验收
```
````

**你会得到什么**

- 只要围栏语言是 `mermaid` 就出图，大小写不敏感；围栏后跟的
  `{...}` 参数不影响识别（`webapp/lib/markdown.ts:133-136`）。
- 中文标签正常显示：节点和边上的文字走 PingFang SC / Microsoft
  YaHei / Noto Sans CJK SC 字体栈，不会画成方块
  （`components/mermaid-block.tsx:109`）。
- 图跟随界面浅色/深色主题，切换主题时已渲染的图会重新画
  （`components/markdown-html.tsx:52-66`）。
- 图按列宽缩放；特别宽的图在卡片内横向滚动，不撑破版面
  （`webapp/styles/mermaid.css:62-80`）。

**图坏了会怎样**

- **语法写错**：出错的那张图显示"Mermaid 渲染失败"卡片——错误原因
  加原始源码。源码可以原样选中复制，复制回来的内容和当初写的逐字节
  一致，包括 `-->|标签|` 这类箭头语法
  （`components/mermaid-block.tsx:285-307`、
  `components/markdown-html.tsx:183-230`）。文档其余部分照常渲染，
  一张图坏了不会让整篇白屏。
- **图表库加载失败**（如断网）：同样落入失败卡片，源码仍可复制，
  其余内容不受影响。

**限制**

- **首次遇到图需要加载**：图表库有几 MB，页面里第一张图出现时才从
  服务端加载（没有任何 mermaid 图的页面完全不请求它，
  `components/mermaid-block.tsx:54-66`）；**图表库文件**带一年期 immutable
  强缓存（`server/lib/static.js:64-66`），之后的页面加载直接用浏览
  器缓存，不重复下载。
- **不进目录大纲**：图不产生标题。围栏渲染为 `<pre>`/`<div>` 占位
  元素而不是 `h1`-`h6`（`webapp/lib/mermaid-renderer.ts:44-57`），
  因此图永远不会出现在按标题组织的大纲里——预览面板的目录
  （见下节）只从渲染后的 `h1`-`h6` 提取条目，占位元素天然不满足。

依赖：`mermaid` 11.12.1（MIT），已登记于 `release/dependency-licenses.json`。

### 代码块的换行与滚动条（工单 52）

所有 markdown 代码块——聊天消息、活动组、markdown 文件预览——都经同一
个宿主组件（`components/markdown-html.tsx`）渲染，用解析器产出的外壳
（`lib/markdown.ts`：`.codeblock-shell` > `.codeblock-toolbar` +
`pre.codeblock-pre` > `code.codeblock-code`，滚动容器是 `code` 元素）。
契约如下：

| 方面 | 契约 | 依据 |
| --- | --- | --- |
| 换行 | `file_line_wrap` 开关（沿用工单 48 的键，不新增键）扩展到 markdown 代码块：开启时代码行在列边缘折行（`white-space: pre-wrap; overflow-wrap: anywhere`）并隐藏横向滚动条；关闭时保持单行横向滚动。语言标签在滚动容器外的工具栏里，永不折行。每次宿主挂载读一次——与工单 48 的文件预览同语义：切换开关后新挂载的块生效，屏幕上已有的不重排 | `components/markdown-html.tsx`、`webapp/styles/markdown-overrides.css` |
| 滚动条可见 | 滚动模式下静止态滚动条可见：浅灰 thumb（8 % 透明度 token，随主题翻转）配透明轨道，悬停加深为 `--utility_scrollbar`（15 %）——上游样式把静止态 thumb 画成全透明、还把聊天内容里的 webkit 横向滚动条压成 `height:0`，用户不知道存在滚动条，只能看到被裁切的代码 | `webapp/styles/markdown-overrides.css` |
| 滚动容器是被块化的 `<code>` | 解析器产出的是裸 inline `<code>`（与上游标记不同，没有 `.shiki` 包装），而 `overflow` 在 inline 盒上被忽略——上游对该元素声明的 `overflow:auto` 在本客户端从未形成滚动容器，这是「既滚不动也看不见滚条」报障的另一半根因。覆盖层将其块化（`display: block`）后上游滚动声明才生效；删掉这一行，所有滚动条规则都是死样式。哨兵测试同时拒绝覆盖表里出现任何裸 `code`/`pre` 选择器——一旦出现会误伤正文里的行内代码（`code.inline-code`） | `webapp/styles/markdown-overrides.css`、`webapp/test/markdown-code-wrap.test.ts` |
| 已知限制——超长代码块溢出 45vh 外壳 | `.codeblock-shell` 给自己设了 `max-height: 45vh`，但内部的 `<pre>` 保持默认 `min-height: auto`、拒绝收缩到内容高度以下，于是超长代码块会撑破外壳，纵向滚动发生在外层预览/消息容器上。这是既有行为（滚动模式下同样存在，早于工单 52）；换行只是让块更容易撞上（折行后视觉行数更多）。修法是给 `.codeblock-pre` 设 `min-height: 0`——本工单刻意未动，记录为后续工单 | `styles/official-utilities.css`（`.codeblock-shell`）、上游标记 |

覆盖层放在 webui 自有的 `webapp/styles/markdown-overrides.css`，在
`styles/official-utilities.css` 之后加载（`app/layout.tsx`）；上游共享
样式表本体保持逐字节不变，桌面版与它共用。同选择器规则靠源顺序取胜，
因此导入顺序是承重结构。

## Markdown 里的数学公式（KaTeX）

助手回复和 Markdown 文件预览现在能渲染数学公式，与 Mermaid 图走同一条
渲染管线。三种写法会被当作公式，其余出现的美元符号一律按普通文本处理：

| 写法 | 示例 | 效果 |
| --- | --- | --- |
| 行内公式 | `$E=mc^2$` | 段落内排版成公式，随正文流动 |
| 块级公式 | `$$\frac{a}{b}$$` | 居中独立成块显示 |
| 代码块 | 语言位置写 `math` 的代码围栏 | 同块级公式，与 `mermaid` 围栏走同一个分发注册表，互不影响 |

**你会得到什么**

- 上述三种写法都排版成真正的数学公式（分数、根号、求和号、矩阵等），
  渲染引擎是 KaTeX（`webapp/lib/math-renderer.ts`）。
- 公式跟随界面浅色/深色主题，两种主题下对比度都正常——公式就是普通
  继承文字色的内容，切换主题不需要重画。
- 排版字体（KaTeX 字体）随应用自带，不依赖系统装没装数学字体。

**什么不会误伤**

- `成本 $5 and $10`、`$HOME`、没写闭合 `$` 的片段——都按普通文本原样
  显示。单个 `$` 只有在存在闭合 `$`、内容不跨行、且不以数字开头时才
  被当作公式。

**公式写错了会怎样**

- 该公式**降级为代码样式显示原始写法**（行内公式显示为行内代码，`math`
  代码块显示为普通代码块），原文一个字符都不丢，页面照常渲染，不会
  白屏（`webapp/lib/markdown.ts` 的降级路径）。
- 公式里无法夹带链接：`\href` 之类的可信功能默认关闭，只会显示成红色
  警示文字，不会变成可点的 URL。

**限制**

- 公式排版样式与字体文件随应用打包（样式表约 24 KB，按需加载字体重
  量很小）；JS 渲染库进入前端主包（gzip 约 90 KB），不像 Mermaid 那样
  懒加载——行内公式可能出现在句子中间，同步渲染是正确性前提。这是
  记录在案的成本，若前端体积预算吃紧再评估懒加载方案。
- 升级 KaTeX 版本时需要同步更新两处：`webapp/public/fonts/katex/` 下的
  字体文件与 `webapp/styles/katex.css`（由 `katex/dist/katex.min.css` 改写
  字体路径生成，方法记录在英文文档同节）。

依赖：`katex` 0.18.7（MIT），已登记于 `release/dependency-licenses.json`。

## 文件预览工具栏与 Markdown 大纲（slice 27）

预览组件顶栏新增三个控件，Markdown 预览增加大纲面板。这也是
webui 第一次开放**写文件**的路径，因此下面的边界是产品决策，
不是实现细节。

**工具栏能做什么**

| 控件 | 作用 | 什么时候会用到 |
| --- | --- | --- |
| ↻ 刷新 | 从磁盘重新读取当前文件并重新渲染，滚动位置保留 | 你在编辑器里改了文件，切回面板点一下就看到新内容 |
| 预览/编辑 | 把文本类预览（Markdown、代码）切换成编辑器，编辑器内容就是磁盘上的字节；再点切回预览 | 想在网页里顺手改一个字、补一段话 |
| ✓ 保存 | 把编辑内容写回磁盘文件，成功后提示"已保存 HH:MM"并按保存后的内容重新渲染 | 改完了，明确保存；**没有自动保存**，写盘只在你点这一下时发生 |

**坏了会怎样（每种失败都有交代）**

- **刷新时文件已删除/改名**：面板不空白——保留最后一次读到的
  内容，顶部出现一条提示，写明"刷新失败：无法解析路径 …"和
  "文件可能已被删除、移动或路径已变化"。
- **保存失败**（磁盘满、权限不足等）：编辑内容**原样保留**在
  编辑器里，并显示失败原因（如 `EACCES: permission denied`）。
  你不会因为一次失败的保存丢掉刚打的字。
- **文件在你打开之后被别人改了**：保存时出现**冲突提示卡**
  （"文件在磁盘上已被修改"，附磁盘版本的时间和字节数），
  保存被拒绝，磁盘上的外部修改**不会被覆盖**。卡片给两个明确
  出路：覆盖磁盘版本，或载入磁盘版本（后者丢弃你的编辑，卡片
  上写清楚了）。检测依据是打开文件时记录的修改时间与大小，
  保存前服务端逐一比对，不一致即拒绝。

**凭据形状的文件默认只读**

`.env`、`id_rsa`、`*.pem`、`credentials*` 这类文件名，在网页里
**默认不能编辑**：点"编辑"先出一张确认卡，说明文件形状和拒绝
原因，你点"仍要编辑"才进入编辑态，保存时再带确认标志。原因和
slice 16 的预览守卫一致：服务会向局域网广播地址，能在网页里改
`.env` 的能力，等于把局域网里任何人都变成本机配置的写入者。
确认路径会在服务端留一条 `credential.override` 审计日志
（含时间、路径、原因），运维可以 grep 追溯。

**写路径的边界（服务端强制，前端只是呈现）**

- 写入目标和读取走**同一套**工作区围栏（允许根 + 符号链接解析），
  越界一律 403；没有新增任何逃逸面。
- 保存端点只做一件事：把请求体里的文本写进围栏内的那一个文件。
  全程无 shell、无命令拼接。
- 写入上限与读取一致（512 KiB）；只能编辑已存在的文件，不能借
  保存新建文件。
- 保存请求携带打开时记录的（修改时间、大小）基线；磁盘已变则
  409 冲突，不写盘。

**Markdown 大纲**

- Markdown 预览的右侧出现"大纲"面板：按标题层级列出 `h1`-`h6`，
  点击平滑滚动到对应标题（滚动位置照常随标签页持久化），滚动时
  当前章节高亮。
- 面板吸附在预览可视区内（高度上限取预览可视高度，条目再多也
  不会超出悬浮的窗格），滚动时始终可见，高亮跟得住。
- 大纲条目从**渲染后的页面 DOM** 提取——列出的一定是页面上真
  实渲染的标题，而不是对源码的第二次解析（两种解析各走各路就
  会出现"大纲和正文对不上"）。
- 没有标题的文档不显示大纲面板（不留空壳）；Mermaid 图不是
  章节，永远不进大纲；浅色/深色主题下都可读。
- 预览列特别窄（内容宽度低于约 300px）时大纲自动隐藏，避免把
  正文挤得没法读；预览列自身的最小宽度（320px）下大纲仍可见。

## 会话渲染：思维链块、活动组与工具卡片（工单 46）

助手回合里的「过程」由两个原生 `<details>` 折叠面承担。组件在
`components/activity-group.tsx`（从 `chat.tsx` 抽出，动机与 U8 抽出
loading-states 相同：让 SSR 渲染测试可以脱离 `chat.tsx` 的 `@/` 别名
依赖图直接加载组件）。数据全部来自既有会话行解码
（`webapp/lib/transcript.ts` 的 `groupActivity` 输出），本工单不改
服务端传输。

**活动组**（一段连续的 thinking/tool 步骤，摘要行如「思考 1 次， 执行
1 条命令」）：

- 摘要行本身是一个 `<summary>`：整行点击即折叠/展开（键盘可达），
  取代原先「文本按钮 + 独立箭头按钮」两处触发。
- **`file-edit` 这一项计的是去重后的文件数，不是编辑调用次数。** 其余
  各类目计的都是调用次数，因为其余句子本来就是调用句（「执行 1 条
  命令」）。而「已编辑 N 个文件」的主语是文件：模型把同一个文件改了
  5 次，就不该读成 5 个文件——这个数字过去与本回合的已编辑文件卡
  （同一句话，数据来自 `collectEditedFiles`）对不上。现在两侧统一走
  同一个去重键 `editedFileKey`（`webapp/lib/transcript.ts`，折叠分隔
  符、不折叠大小写），同一个回合的活动组摘要与汇总卡不可能再给出不同
  的 N。没点名任何路径的编辑调用不产生 `file-edit` 这一行，而不是虚
  报一个文件。调用次数并没有丢：它是摘要里的 `tools`，回合过程条以
  「用了 N 次工具」呈现。
- 展开体左侧有一条 1px 时间轴竖线（`.timeline-spine`，
  `border_light` 色，参数照参照实现）。
- 组内存在状态未落定的工具（还没有 `[completed]`/`[failed]` 行，或
  显式 `[in_progress]`）时，组带 `data-active="true"` 并强制展开：
  流式中点击折叠会被立刻拉回，回合结束才允许收起。判定函数
  `isActivityGroupActive` 是导出的纯函数。
- **`data-active` 的可达性（如实说明）**：协议级探测（真实引擎会话，
  120ms 采样，含 `sleep 15` 与持续输出 15 秒的长工具）显示，当前
  ACP 传输下工具的 `→ name` 头行与 `  [completed]` 状态行**同一帧落
  盘**——引擎在工具完成时才发出携带 update 的 `tool_call` 通知，中
  间没有渐进的 `tool_update`；且服务端 `applyToolUpdate`
  （`mcode-acp.js`）对不带 status 字段的更新默认写 `[completed]`。
  因此「运行中的工具块」这一中间态**在当前引擎传输下不会出现**，
  `data-active` 强制展开是为引擎将来发出工具开始事件 / 非终态中间
  更新时预留的能力：解码契约（无状态行 = 运行中）与前端判定、弹回
  逻辑均已就绪并有单测钉住，引擎一旦发送即生效。SSE 的快照合并窗
  口（默认 16ms）不是遮蔽原因。
- 默认展开规则照参照编排（`AssistantBody` 的
  `expandProcessByDefault` + `renderActivityParts`）：组内同时有思考
  和工具时默认展开；纯工具组默认收起；混合组内嵌套的思维链行默认
  收起，纯思考组的思维链行默认展开。
- **组体不限高、不内嵌滚动条（工单 61 还原）**：组体此前带
  `max-h-[230px] overflow-y-auto`，长工具轮会在一个本身就在滚动的页面
  里再套一条滚动条，把自己的步骤从中间切断。参照样式表给
  `.activity-group-items` 的是 `gap: 0` 加每行 28px 最小高度，没有
  `max-height`；本仓现在一致：零行距由组件上的 `gap-0` 承担，28px 行高
  下限写在 `app/globals.css` 的 `.activity-group-items > *`（`@layer`
  之外，Tailwind 清理不到手写规则）。去掉限高不带来渲染成本——收起的
  `<details>` 本来就把展开体留在 DOM 里，行数从来不是当初加限高的理由。
  桌面版在组内唯一保留的滚动容器是工具详情的 `pre`，限高 180px（照参照
  `.webui-tool-detail-section pre`），本仓原先是 320px。

**思维链块**（一段思考过程）：

- 摘要行 = 图标 + 状态文案 + 已耗秒数 + 箭头。流式期间显示
  「推理中...」，秒数每秒跳动；回合结束变为「已完成推理」+ 定格的
  总秒数。
- 展开体经既有 Markdown 管线渲染（`lib/markdown.ts`，KaTeX 与
  mermaid 的语言渲染器随组件注册），不再是纯文本。
- 展开体高度超过 224px 时自动截断（`.is-clamped` + 底部渐变遮罩），
  并出现「展开 / 收起」按钮切换。
- 流式期间强制展开；回合结束自动收起（用户手动展开过的除外）。

**秒数的数据边界（如实说明）**：会话行编码不携带每段思维链的时间
戳，秒数从快照 `running.startedAt`（轮次开始时刻）起算——与参照实现
喂给 `WebuiThinkingBlock` 的 `processingStartedAtMs` 同语义。因此流式
期间的秒数读作「本轮已进行时间」；回合结束的定格值是该段思维链结束
时本轮已进行的时间，**不是**引擎度量的「该段思考净时长」（引擎未提
供该数据）。冷加载的历史会话没有锚点，摘要行不显示秒数，也不伪造。

秒数显示还依赖「该段思维链作为尾部块的流式窗口在 SSE 快照帧中曝
光」，两个已实测确认的边界：

1. **流式窗口被吞**：极短的思维链段、或与轮次结束同一帧落盘的段，
   其「尾部块是思维链」的状态可能从未单独出现在任何一帧快照里，
   该段定格后没有秒数（显示「已完成推理」不带数字）。数据在传输
   层已被帧合并，渲染层无法事后补算。
2. **行重挂载（已修的主要根因）**：流式中工具头行只在完成时落盘、
   正文行穿插其间，活动组的边界每帧重切；思维链行原先以「组内位
   置」为 React 键，组一重切键就变，行被重挂载、秒数状态恰在回合
   结束瞬间丢失（实测复现：流式中 1s→4s 正常跳动，finalize 后清
   零）。修复：`assignActivityBlockKeys`（`activity-group.tsx` 导出
   的纯函数）改为按解码出生序分配全局稳定键，修复后同类场景秒数
   保留。罕见的行序重排（如正文行迟到追加导致的块位移）仍可能丢
   个别段的秒数。

流式判定的依据是「尾部单元是活动组且其最后一个块是思维链」
（`chat.tsx` 的 `streamingActivityIndex`）——会话行没有思维链级的
流式标记（`▍` 光标只标在尾部 assistant 块上），这是渲染层能拿到的
最诚实信号。

### 流式期间尾部内容必须可见（webui-parity 工单 88）

**不变式：回合流式输出期间，转录的尾部始终在滚动容器的可视区内。**
引擎吐出的每一个 token 都应当在不滚动的前提下读到。回合先追加一个块，
再逐 token 把它撑大，于是读者下方的 DOM 在长、`scrollTop` 却不动；没有
任何东西钉住这个偏移，答案就被排在折叠线以下，读者整个回合只能盯着
「思考中」。在未修复的版本上实测：一个 15 秒的回合里 `scrollTop` 始终
为 0，而 `scrollHeight` 从 688 涨到 1196。

这与虚拟化无关。低于 `VIRTUAL_LIST_THRESHOLD`（200 个单元）时窗口是
`useVirtual: false`，每个单元都在 DOM 里；实测那个回合峰值只有 8 个
单元。尾部一直渲染着，只是落在屏幕外。

| 关切点 | 决策 | 被否掉的方案 |
| --- | --- | --- |
| 偏移归谁管 | 只有三方：尾部跟随、读者本人、滚动位置持久化还原。浏览器自带的滚动锚定（scroll anchoring）在滚动容器上被**关掉**（`app/globals.css` 的 `.chat-scroll`），因为它是隐式的第四方——转录在视口上方增长时它自行把 `scrollTop` 从 55 挪到 125，而跟随会把这读成「读者离开了」 | 保留锚定。尾部增长的转录需要的是钉住而不是锚定；留着它，跟随就无法归因任何一次位移 |
| 跟随何时关闭 | 当容器偏离跟随自己上一次钉下的位置时（`isAwayFromPin`，2 px 容差）。内容追加在读者**下方**，所以单是增长永远不会改变 `scrollTop` | 在 scroll 事件回调里做「是否靠近底部」判定。scroll 事件是异步派发的，等回调跑起来时下一个 SSE 帧可能已经把转录撑大了，于是对根本没离开的读者也答「否」。这个版本上线过，实测每个回合约 20 秒后跟随自己关掉，已替换 |
| 跟随何时恢复 | 读者自己滚回尾部，或点「跳到最新」按钮（该按钮调 `followNow()`——它自己的滚动会立刻改掉「恢复」本该读的那个位置） | 每次提交都从度量重新推导——那样分不清「读者动了」和「转录长了」 |
| 读者已上翻 | 原地不动，直到回合结束；按钮继续可用。实测：连续流式输出 40 秒、157 次采样，漂移 0 px | 照样跟随，理由是「读者终究会想要答案」。把正在读历史的读者拽走是同一个毛病的另一半 |
| 回合进行中 | 持久化位置的还原被 `sessionRunning` 门控关掉。`initialScrollTop` 每帧都从存储重读，于是还原会被跟随自己写下去的值重新武装，在每次钉住后一帧把容器拽回去 | 两边都写。同一个偏移有两个主人就是缺陷本身，不是修复 |
| 动画 | 直接跳，不用平滑滚动——平滑滚动追的是一个随每个 token 移动的目标，会落后于流式输出，并在回合结束时过冲 | 钉住时用 `behavior: "smooth"` |
| 虚拟化 | 不动。两者正交：每次提交在 layout effect 里写一个数，都在绘制之前 | 超过 200 个单元就关掉虚拟化以保证尾部被渲染。尾部一直都被渲染 |

对已结束的会话，还原逻辑不受影响——那正是它存在的场景。留在尾部的会话
重开仍在尾部，停在历史中段的会话重开仍在中段。

### 工具卡片（工单 46 PR3）

单次工具调用渲染为一张原生 `<details>` 卡片（`ToolCard`），结构照
参照实现的 `WebuiToolRow`：

- **人话标签**：摘要行显示中文人话工具名（`bash` → 终端、`read` →
  读取文件、`edit` → 编辑文件、`grep` → 搜索 …），映射表是
  `webapp/lib/tool-projection.ts` 的 `toolCallLabel`——参照桌面文案的
  双语移植（中文列照抄参照，英文列为对应直译；界面双语同权）。
  未收录的工具名回落到「工具 / Tool」，与参照的回落一致；参照表中
  带 `{{name}}` 模板占位的条目（如 `read_skill_file`）未收录——本
  渲染层没有替换站点，收录会显示原始占位符。
- **状态五档归一**：`normalizeToolStatus` 把 wire 状态行归一成
  等待中 / 运行中 / 已完成 / 失败 / 已取消（加 `unknown`），中文文案
  与参照一致；参照桌面的数字状态码 1/2/3/4/5 分别映射
  running/completed/error/pending/pending，一并保留（当前 wire 只写
  字符串状态）。与参照的一处刻意差异：**没有状态行视为运行中**
  （参照记为 unknown），因为 wire 先写 `→ name` 头行、状态行只在
  调用落定时补写——「没有状态」在本传输下就是在跑，与
  `isActivityGroupActive` 同一口径。已完成的调用不显示状态徽标
  （参照行为，收尾的行保持干净）。
- **展开体三段**：输入 / 结果 / 错误。入参摘要按编排拍板从摘要行
  移入「输入」段；失败调用的输出行渲染为标红的「错误」段（wire
  把失败文本写在普通输出行里，没有独立的 error 字段），失败且无
  输出时兜底显示「执行失败」。任一段超过 2000 字符截断加 `...`
  （`clampDetailText`）。运行中尚无产出的调用显示「运行中…」。
- **read 类资源路径**：`read` / `read_file` 的资源路径提到摘要行
  常驻显示（文件名 + 悬停 title 全路径，`toolSummaryResourcePath`）。
  解析优先从入参取（参照推导），入参缺失时回退到解码器收集进
  `toolPaths` 的 `@ path` 行。实机验证引擎的 read 调用头行携带
  JSON 参数（`→ read  {"path": …}`，键名 `path`），真实流量走第一
  优先级分支，摘要行路径正常显示（实机 3/3 张 read 卡均显示、
  title 为完整绝对路径）。也存在头行不带参数的 read 形态，该形态
  下若 `@ path` 位置行与工具体之间隔着空行与「N more lines」截断
  标记，会被解码器按既有 orphan 规则丢弃（该规则同时挡掉混在其
  中的下一个工具状态行，语义正确，不改），摘要行路径随之缺失
  ——这是数据源形态差异，不是渲染缺陷。其余工具不提路径。
- **图标**：16×16 SVG 目录（`components/tool-icon.tsx`），替换
  unicode 字形占位；path 照参照 `WebuiToolIcon` 目录逐个转录，本
  wire 图标词表（`SummaryIconType`）与参照 category 不完全同名，
  个别条目取最接近的参照图形（`plugin` → 参照 combine、
  `file-edit`/`edit` → 参照 code、`agent` → 参照 bot、
  `skill` → 参照 task），无参照对应的 `summary` / `alert` 以同风格
  （viewBox 16、stroke 1.25、圆角连接）自绘。失败状态下图标与状态
  徽标转错误色。
- **合法性修复（质检登记）**：旧卡片的头部是 `<button>`，其内部又
  嵌着子代理徽标 `<button>`——非法 HTML；改为 `<details>/<summary>`
  后嵌套消失（`<summary>` 允许交互后代）。孤儿属性
  `data-message-collapse-trigger`（全仓无消费者）删除。

**工具级耗时不加**：参照的工具行摘要只有「名字 · 状态」，没有单个
工具的耗时——耗时在轮次条与思维链块上。此为编排拍板，非遗漏。

### 轮次耗时条（工单 46 PR3）

回合进行中，transcript 尾部渲染一条耗时条（`TurnProcessDisclosure`
，自 `chat.tsx` 挪入 `activity-group.tsx` 并按参照 `WebuiTurnProcess`
重建）：

- 摘要行是复合文案「思考 N 次，用了 M 次工具，共执行 X 分 Y 秒」
  （运行中为「…已执行 N 秒」）；计数为零的分段省略；超过 1 分钟的
  时长显示「X 分 Y 秒」，不足 1 分钟显示「N 秒」。计数口径与活动组
  一致（思考数相邻合并），统计范围是上一个用户消息到本回合结束
  之间的全部块（`webapp/lib/turn-stats.ts`，正扫/倒扫两个入口共用
  同一口径）。
- 终态在右侧显示输出速度「N token/s」。**该数字是估算**：wire
  会话行不携带每回合 token 数（ACP `usage` 事件只在服务端累计会话
  总量，本工单红线禁止改四个 server 文件），故按参照在无
  `usage.outputTokens` 时的同一回退公式 `回答字符数 / 秒数` 计算。
  中英文等表意文字的字符/ token 比不同，读作数量级参考而非精确值。
- 运行中在 transcript 尾部显示「已执行 N 秒」，每秒跳动；跳动从
  effect 里驱动，SSR 与 hydration 首帧固定渲染 0 秒（服务端与客户
  端标记一致，不闪不跳变）。
- **终态耗时条是瞬态（如实说明）**：回合结束时「已执行 …」短暂
  转为「共执行 X 分 Y 秒」并在右侧追加输出速度「N token/s」，但
  该终态只在约一个 SSE 快照窗口内可见（实测约 150ms 量级即消
  失），会话流结束后的状态重建与刷新后都不再出现。根因在服务端
  既有链路：finalize 把 `§§ processed_duration` 标记写进内存
  `cs.chat`（SSE 短暂送达前端），但标记不随会话状态持久化/重建
  下发，前端解码因此拿不到 `processedDuration`。本工单红线禁改
  四个 server 文件，修复（落盘该标记或改走结构化字段）需另立
  工单；在此之前终态耗时条按瞬态对待。
- 摘要行下方有一条 0.5px 分隔线；`turn-process-disclosure` testid 保留。

#### 轮次条上的展开箭头（工单 61 还原）

终态轮次条恢复桌面版的 `>` 展开箭头（`turn-process-chevron`）。旧版
把它拿掉的理由是「无内容可展开」——本仓把思维/工具步骤平铺成活动组，
不在耗时条的折叠体里，于是箭头无处可指。这个前提在工单 61 改掉了：
箭头改为**状态协调**，驱动该回合的活动组，不重排 DOM。

- **什么条件下出现**：该回合有思维或工具调用。判定是导出的纯函数
  `hasExpandableTurnContent(stats)`，即摘要行已经在打印的那两个计数；
  与参照 `WebuiTurnProcess` 的 `hasExpandableContent` 同一口径（参照在
  `AssistantBody.tsx` 由该回合的 thinking 文本 / 工具 / 活动段算出）。
  纯问答回合（既没有思维也没有工具）没有可展开内容，只渲染纯摘要行，
  不出现箭头——这是桌面版的规则，也是桌面版 02 号截图里那条带箭头
  的回合本身有过程内容的原因。
- **运行中的回合不出现箭头**。参照的 `forceExpanded` / `disabled` 两个
  模式同样「抑制切换、保持详情展开」；本仓这边还有一个更硬的理由：持有
  运行中工具的活动组被 `data-active` 强制展开、不能收起，此时的箭头是
  一个按不动的控件。
- **展开的是什么**：该回合的思维与工具步骤，即活动组本身。回合的回答
  文本不在其中——参照用 `collapsedContent` 把回答留在折叠体之外，本仓
  的回答本来就不在活动组内。
- **协调键是回合序号，不是单元序号**。活动组在流式期间每帧重切，单元
  序号会漂、回合序号只在出现新用户消息时前进；用单元序号会让箭头在工具
  头行落盘的那一刻与它驱动的组脱钩。序号由 `webapp/lib/turn-stats.ts` 的
  纯函数 `computeTurnLayout` 给出，意图保存在 `Chat` 的一个
  `Map<回合序号, 展开态>` 里。
- **未点击过时各组保持自己的默认展开态**（混合组展开、纯工具组收起），
  箭头的 `aria-expanded` 读 `computeTurnLayout#defaultExpandedByTurn`
  （该回合有任一组默认展开即为 true），第一次点击取反，因此第一次点击
  一定看得见变化。点击之后该回合各组作为一个整体联动。
- `data-active` 强制展开规则与活动组自身的折叠语义都不因此改变：
  收起意图不会盖过强制展开。

## 「已编辑 N 个文件」汇总卡（工单 77 + 83）

回合的最后一块是这张卡（桌面版 `06-browser-tree-tasks-review.jpg`
里的那张）。工单 77 把它挂在转录尾部，数据源是编辑类工具点名的文件
路径，并在本文档里记录了桌面版的行数统计与撤销按钮「不可达」。**两者
在工单 83 变得可达**，本节现在描述卡片拿到它们之后的行为。

表头那句文案仍复用 `activity.editedFiles` 键；工单 83 只为新增的
能力（撤销、重做、失败文案）新增了键。活动组摘要和这张卡说的是同一
句话，就该是同一个键；既然是同一句话，就该是同一个数字——活动组摘要
也按同一个 `editedFileKey` 计去重文件数（见上文活动组一节）。

### 数据从哪来

两个来源，权威性有严格先后，且**从不合并**：

| 来源 | 是什么 | 能证明什么 |
|---|---|---|
| **引擎记录** | 带该回合 `assistantMessageId` 的 `GET /api/turn-diff` | 真实的逐文件 `+N` / `-N`、真实的文件清单（含参数里没写路径的工具改的文件），以及引擎自己的 `canUndo` / `canReapply` |
| **转录扫描** | `collectEditedFilesByTurn`（`webapp/lib/edited-files.ts`），按布局回合序号分组 | 只有 `file-edit` 工具点名的文件路径。没有行数，没有门控 |

引擎清单**取代**扫描，而不是与之合并。合并会让两个来源命名不同的
同一文件被数两次，计数随后落在错误的行上。没有记录时——回合坐标
上线之前录的会话、legacy 转录回读、`exec` 传输——扫描就是全部，卡片
也就是工单 77 交付的那张。

### 回合坐标

引擎把一回合的记录存在该回合**最后一条助手消息**的 msg_id 下
（`local-runtime-v2/.../turn-outcome.ts` 读的是最后一条 agent
*message* 应答；线上一个回合不止一个 id，每个消息段一个）。ACP
传输早就把这个 id 送到了服务端，此前被丢掉。

- **实时路径**：`acp.mjs#prompt` 留住最后一个 `agent_message_chunk`
  的 `messageId`；`mcode-acp.js#finalize` 在它本来就写的
  `§§ processed_duration=Nms` 旁边写下 `§§ turn_msg=<id>`。`§§`
  这一族是服务端回合元数据的既有约定——这是第三次复用，不是新语法。
- **回读路径**：`server/lib/transcript.js` 的 v2 探针现在 SELECT
  消息表本来就有的 `turn_id` 与 `msg_id` 两列，用每个回合最后一条
  助手行合成同一款标记。切走再切回，老会话就拿到了坐标，不必向引擎
  要任何东西。

`decodeTranscript` 吞掉标记，把 id 挂在该回合**最后**一个助手块上。
没有标记的转录解码结果与之前逐块相同——早于标记的每个会话都得继续
正常渲染，而假设标记一定存在的解码器会把它们全部解崩。

### 桌面版每个元素对应什么

| 桌面版元素 | 我们的对应 | 说明 |
|---|---|---|
| 头部图标 | **有** | `pencil` 图标，沿用 `icons.tsx` 既有图标集。 |
| 「已编辑 N 个文件」 | **有** | N 是**去重后的文件数**。有记录时是引擎自己的文件数；没有时是扫描能点名的数量。 |
| 绿色 `+N` / 红色 `-N` | **有记录时有** | 引擎自己的逐回合计数，表头求和。**没有记录时不画**——画 `+0 -0` 等于宣称「这个文件没变」，那是另一句且为假的话。某一边为 0 时也不画 `+0` / `-0`。 |
| 「撤销」按钮 | **有，由 `canUndo` 门控** | 调 `POST /api/turn-diff/revert`，真的会改写工作区文件。 |
| 「重做」按钮 | **有，由 `canReapply` 门控** | 调 `POST /api/turn-diff/reapply`。与撤销独立出现：已撤销的回合给重做、不给撤销。 |
| 「Review」按钮 | **没有（以文件行替代）** | 点文件行走既有的 `onOpenFile` 链路开文件预览（红线 4）。 |
| 文件行：类型图标 + 文件名 | **有** | `file` 图标 + 路径末段；完整路径挂在 `title` 与 `data-file-path` 上。 |
| 文件行右侧增删数 | **有记录时有** | 是该文件自己的计数，不是把表头总数重复一遍。 |
| 折叠（先 3 行 + 展开） | **有** | 纯客户端状态机 `reduceEditedFilesCardState`，超过 3 行才出现切换。 |

两个按钮在不能动作时是**不画**，不是灰掉。只有最新回合的 diff 能改
——引擎会在用户点击之前就回 `canUndo:false`，真点了也回 409
`TURN_DIFF_CONFLICT`——所以一个禁用的按钮等于承诺一件引擎已经拒绝
的事。卡片从不从转录反推「这是不是最后一回合」；整套坐标方案存在的
理由就是这个推断做不安全。

### 一次成功撤销要刷新什么

撤销改写的是浏览器正在显示的文件，因此有五步，按此顺序：

1. 服务端的会话树缓存（`invalidateSessionTree()`）；
2. 一次 `session-tree-changed` 广播（侧边栏）；
3. 一次 `workspace-files-changed` 广播——新的命名 SSE 帧，无载荷，
   是 webui 唯一能得知「磁盘上的文件在自己脚下变了」的信号；
4. 收到该帧后，文件树重读所有已展开的目录，git 面板重读 status 与
   branches；
5. 同一帧触发，文件预览走刷新通道重读当前文件——保留滚动位置；文件
   已删时给具名提示条而不是空白面板；**有未保存草稿则不动**，因为那份
   草稿的基线正是后续保存要冲突校验的对象。

### 契约要点

- 折叠状态**不进 `localStorage`**：刷新后回到折叠态。这是派生状态而非用户偏好，红线 3 不受影响。
- **坐标、扫描、记录**都从**完整** `units` 派生，一律不取虚拟窗口 `visibleUnits`——否则回合滑出窗口时它的数字会在用户眼皮底下变样。卡片本身是列表子项：在 `visibleUnits` 循环里、挂在**该回合**最后一个单元之后。超过 `VIRTUAL_LIST_THRESHOLD`（200 个单元）后，某回合的卡会随滚动窗口出现与消失，和该回合的消息本身一样。这是卡片唯一一处受窗口影响的地方，且是有意的取舍——把卡钉在窗口外，它就渲染在读者看不见的位置上。未虚拟化的转录（≤ 200 个单元，绝大多数会话）无条件渲染每个回合的卡。
- 每个回合的卡挂在**该回合**最后一个单元后，所以三个回合读起来就是三张卡。工单 77 那张挂在转录尾部的全会话单卡已经没有了：转录列的最后一个元素现在是消息操作行。
- 未接 `onOpenFile` 时文件行降级为纯文本，**不退化成点了没反应的按钮**。
- 路由只透出 `applications.session.diff`，不多给一个成员——同一棵 `applications` 树上还有能删会话的 `session.lifecycle`。
- `previewState` 协议里有定义，这条链路上恒为 `undefined`，任何地方都不渲染它。

## 加载态：会话骨架屏与流式活动指示（工单 U8）

会话界面有两类等待，各自有明确的呈现方式，都不是一个孤零零的转圈：

| 在等什么 | 用户看到什么 | 代码位置 |
| --- | --- | --- |
| 第一份会话快照（页面冷启动、引擎启动中） | `TranscriptSkeleton` —— 按真实消息行布局铺的 shimmer 骨架：右对齐的用户气泡、通栏的助手正文行、带缩进输出行的工具摘要行；下方保留连接状态文案（正在连接引擎 / 连接已断开） | `app/page.tsx` 的 `!state` 分支；组件在 `webapp/components/loading-states.tsx` |
| 当前一轮的输出（`running.active`） | transcript 尾部的 `ActivityPulse` —— 桌面端同款三点加载动画，旁边多一条 shimmer 条，位置就是下一行输出将要落下的地方；标签先显示引擎报的阶段文案（思考中 / 工作中 / …），随后按桌面版的加权短语表轮换 | `components/chat.tsx` 的 `ThinkingIndicator`，开关由导出的纯函数 `isSessionActivityActive` 决定 |

改这两处时值得保持的约定：

- 骨架条的底色就是用户气泡的 token（`--bg_grouped_tertiary`），扫光用
  15% 黑色叠加 token，两主题全部来自 token 层，占位条与它所代替的消息行
  同一色系，不存在按主题写死颜色。
- `prefers-reduced-motion: reduce` 下，`app/globals.css` 对每个动画类
  （`.mavis-skeleton-bar`、`.mavis-loading .mavis-dot`）显式关闭动画，
  不只依赖通用的时长覆盖；dots 的规则带 `!important`，因为
  `styles/official-utilities.css` 在 `globals.css` 之后加载，且以同特异性
  重定义了 `.mavis-dot-a/b/c` 的 `animation-name`，普通声明会在级联中
  落败，dots 只能靠时长覆盖假装静止。关掉动效后文案仍然可见。
- 会话**切换**不出现骨架屏：`POST /api/sessions/switch` 在响应前就备好
  完整 transcript，下一份 SSE 快照整体替换旧内容。骨架唯一的触发条件
  是"快照缺失"，也就是冷启动那条路径。
- 两个组件的渲染测试与 reduced-motion 的静态断言在
  `webapp/test/loading-skeleton.test.ts`（走 `renderToStaticMarkup`；
  本测试套件没有 DOM 环境）。
- **流式标签的短语轮换（工单 61 还原）**：桌面版不在整个回合期间把一个
  静态标签钉在屏幕上。参照 `ActivityIndicator.tsx` 的排期与抽签照搬：
  首次换词前等 2000–3000ms（随机取值），之后每 3500ms 换一次；短语分
  三个加权桶抽取——basic 0.75 / specific 0.15 / motion 0.1——桶内均匀，
  且抽签前先滤掉上一句，不出现连续重复。表在
  `webapp/lib/thinking-phrases.ts`（按 `Locale` 索引，两种语言各自成表，
  结构相同；独立模块而非塞进 `lib/i18n.ts` 的扁平字典，理由与
  `lib/i18n-agent-team.ts` 相同）。抽签与排期是导出的纯函数
  `pickWeightedPhrase` / `computeThinkingPhraseStartDelay`，定时器只存在于
  `ActivityPulse` 这一个叶子组件里。
- **减弱动态效果下短语继续轮换，这是有意的取舍**：换词是一次性文本替换，
  没有位移、没有缩放、没有持续运动，前庭障碍的触发条件不存在；桌面版做
  的是同一取舍——`prefers-reduced-motion` 分支停掉 lottie 播放，文案照
  旧跳动。停掉轮换反而会把 G5 要修的「长回合标签僵住」再装回来。指示器
  里会动的那一半（三点与 shimmer）仍由上一条的 `globals.css` 显式规则
  关闭，减弱动效的用户看到的是一个静止的指示器配一个仍在换词的标签。
- **对流式渲染无副作用**：轮换的状态挂在 `ActivityPulse` 自身，换词触发
  的重渲染只覆盖那一个 `<span>`（`activity-indicator-label`），transcript
  正文、markdown 与流式光标都不在更新路径里。effect 的依赖只有短语表
  （按 locale 从模块级常量取，对象身份稳定），不依赖每渲染新建的闭包，也
  不依赖 `label`（阶段文案随引擎变化，重启计时器就会让节奏被重置）。定时
  器是链式 `setTimeout` 而非 `setInterval`，清理时清空；组件随回合结束而
  卸载，不留悬垂定时器。effect 不在服务端运行，故 SSR 与 hydration 的
  首帧都是阶段文案，没有首帧跳变。
- **流式光标是闪，不是呼吸（工单 61 还原，G6）**：流式助手块尾部的光标字符
  用 `.stream-cursor` 绘制，是方波——`stream-cursor-blink 1.1s steps(1, end)
  infinite`，只有两档不透明度，一个周期里亮 60%、暗 40%。它替掉的是 Tailwind
  通用类的 `animate-pulse`（`pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite`，
  配 `@keyframes pulse { 50% { opacity: .5 } }`）：那是两半缓动对称的呼吸，没有
  瞬时边沿也没有熄灭态，读作「在加载」而不是「光标在此」。四个参数是有意选
  的：`steps(1, end)` 在整个区间内保持当前档位、到区间末尾跳变，这才让它读作
  「闪」；1.1s 的周期比短语轮换的 3.5s 快，且与它不成整数比（3.5 / 1.1 =
  3.18），两个节奏不会锁成一个更慢的复合节拍；暗档取 0.2 而非 0，是因为这
  个字符贴在正文末尾、不像终端块状光标那样有自己的一格，一旦归零，正文会像
  掉了最后一个字符半秒钟；`60.01%` 这一档的存在只为让暗值有明确起点，使 60%
  → 100% 之间是跳变而不是渐变。
  节奏**刻意不**与 token 到达同步：光标那个 `<span>` 在整个回合里被 React
  复用为同一个元素，动画自由运行；要做到「每推一帧闪一下」就得按 token 重挂
  载，而那会在动画走到暗档之前就重启——恰好在节奏最该被看见的时候变成常亮
  字符——并且每个 token 多一次 DOM 节点抖动，毫无收益。
  `prefers-reduced-motion` 下由 `globals.css` 那段共用块里的显式规则关闭（与
  其余动画类同一处），光标渲染为静止的实心字符：这个字符是「下一个 token 落在
  哪里」的唯一载体，减弱动效的用户若连光标都看不见，插入点就丢了。由
  `webapp/test/stream-cursor.test.ts` 钉住。
- 与工单 46 的边界：流式期间「推理中... + 跳动秒数」显示在尾部活动
  组内思维链块的摘要行上，「已执行 N 秒」耗时条显示在 transcript
  尾部（见上一节「会话渲染」）；上表的 `ActivityPulse`（三点 +
  shimmer + 阶段文案 + 轮换短语）同样只出现在 transcript 尾部、位于耗
  时条之下。三者位置不同、职责不同，互不替代。

## 持久化键（客户端 `localStorage` / `sessionStorage`）

| 键 | 通道 | 归属 | 引入 ticket | 数据形态 |
| --- | --- | --- | --- | --- |
| `webui:ui:v1:<cid>` | `localStorage` | `webapp/lib/persist.ts#uiStateKey` | slice 07（重启状态） | `{version:1, cid, state:{panel, panelTab, sidebarCollapsed, lastSessionId, appearance}}` ——`appearance`（slice 18）是三态外观选择器的选择（`"light" \| "dark" \| "system"`），`applyAppearance` 走这个 envelope 写入 |
| `webui:scroll:v1:<cid>:<sessionId>` | `localStorage` | `webapp/lib/persist.ts#scrollKey` | slice 07 | `{version:1, cid, sessionId, scrollTop, savedAt}` |
| `webui:workspace-tabs:v1:<cid>` | `localStorage` | `webapp/lib/persist.ts#workspaceTabsKey` | slice 15（工作区列） | 由 `WORKSPACE_TABS_VERSION` 区分版本的 payload，见 `lib/workspace-tabs-state.ts` |
| `webui:open-file:path` | `localStorage` | `webapp/lib/open-file.ts#STORAGE_KEY` | slice 12（文件预览） | 纯路径字符串或缺失 |
| `webui:files-tree:<workspaceDir>` | `sessionStorage` | `webapp/components/panels.tsx`（slice 01） | slice 01（文件树） | `{version:1, workspace, expanded[], filter, showHidden}` |
| `file_open_in_new_tab` | `localStorage` | `webapp/lib/settings-local.ts` | 工单 48（设置通用页） | 纯 `"true"\|"false"` 字符串；**有意不带 `webui:` 前缀**——与桌面参照同名同格式，同一浏览器配置在两个客户端共享该偏好。本客户端默认 `"true"`（参照为 `"false"`）；读取方 `app/page.tsx#openFileTab` |
| `file_line_wrap` | `localStorage` | `webapp/lib/settings-local.ts` | 工单 48 + 52 | 纯 `"true"\|"false"` 字符串，参照共享命名；默认 `"true"`；每次挂载读取方为 `components/code-view.tsx`（代码文件预览）与 `components/markdown-html.tsx`（markdown 代码块：聊天、活动组、文件预览） |
| `webui-context-window-usage` | `localStorage` | `webapp/lib/settings-local.ts` | 工单 48 | 纯 `"true"\|"false"` 字符串，参照共享命名；默认 `"false"`；仅记录偏好，尚无读取方 |
| `webui-follow-up-behavior` | `localStorage` | `webapp/lib/settings-local.ts` | 工单 48 | 纯 `"queue"\|"steer"` 字符串（其他值读取为 `"queue"`），参照共享命名；仅记录偏好，尚无读取方 |
| `webui:project-custom:v1` | `localStorage` | `webapp/lib/project-custom.ts` | 工单 55c（项目右键菜单） | `{version:1, titles:{<项目key>:<自定义名>}, pinned:[<项目key>]}`。**不按 cid 命名空间**（有意）：重命名与置顶描述的是项目本身而非某个浏览器会话，同一浏览器的所有标签页共享。写入尽力而为，失败静默；项目被完整移除（全部会话删除成功）时同步清除其条目 |

除工单 48 的四个参照共享键（`file_open_in_new_tab` / `file_line_wrap` /
`webui-context-window-usage` / `webui-follow-up-behavior`，有意用桌面参照的裸键名）外，
所有键共享 `webui:` 前缀，写入均为尽力 + 防抖（`ui`、`workspace-tabs`
为 150 ms 防抖；其他立即写）。一次失败的写入不会破坏内存状态；
我们关心的是 `app/global-error.tsx` 捕获的硬崩溃，而非这里的配额
错误。会话内每个 sessionId 单独存储滚动位置 —— 按会话恢复滚动位置
是有意为之的契约。

一条时序不变式守着这一切（webui-parity 106）：页面根组件**绝不在渲染期读
这些键**。预渲染的服务端 HTML 与客户端首次（hydration）渲染必须逐字节
一致，渲染期读存储会在 `state === null` 骨架屏第一次改形时炸出不一致。
`app/page.tsx` 首帧用共享的 DEFAULT 常量渲染，挂载后的一个 effect 统一
套用存储值；三处写回镜像都加闸在该恢复之后，默认值首帧不可能覆盖存储
payload。用户看到的东西不变：恢复落地时骨架屏仍亮着，第一份快照到达时
保存过的布局已经就位。

## 斜杠命令走哪个端点（webui-parity ticket 65）

输入框里以 `/` 开头的一行**不等于**命令。两个端点都能消费斜杠输入，
但实现的命令集不同，composer 在发出请求之前就要在两者之间做判断。

| 输入 | 端点 | 原因 |
| --- | --- | --- |
| `/new` `/clear` `/status` `/sessions` `/review` `/help` `/usage` `/stop` —— 裸命令，不带参数 | `POST /api/cmd` | 按钮命令集；`/api/cmd` 只认这八个 |
| `/goal <内容>`、`/goal-done`、`/goal-blocked` | `POST /api/send` | 手输的 webui 命令，由 `handleLocalSlash` 实现；`/goal` 需要参数，`/api/cmd` 没有对应实现 |
| `/compact` 及其它引擎命令 | `POST /api/send` | `handleLocalSlash` 的 `default` 分支把原文转交 mcode —— 引擎命令本来就是这么走的 |
| 任何未被认领的命令 | `POST /api/send` | 同样转交引擎，由引擎在对话流里回答 |
| `/clear now`（认领的命令带了参数） | `POST /api/send` | `handleCmdCommand` 匹配斜杠后的整段文本，带参数就是另一个字符串；`handleLocalSlash` 会解析命令名并走同一道授权门 |

`/api/send` 这一侧的命令集并不是与按钮集不相交的一份清单。
`server/lib/interaction/command-registry.js` 声明了
`SEND_SLASH_COMMANDS`（`goal` / `goal-done` / `goal-blocked` / `clear` /
`new` / `status` / `review` / `help` / `usage`，共 9 个），其中 6 个
（`clear` / `new` / `status` / `review` / `help` / `usage`）同时也是按钮
命令。`handleLocalSlash` 消费它们，`/api/cmd` 的 400 分支因此先问
`isSendSlashCommand(name)`，对这 6 个把 `suggestion` 写成「请作为普通
消息发送」。路由本身仍然优先把裸命令送到 `/api/cmd`，
`SEND_SLASH_COMMANDS` 不参与路由判断。

判断函数是 `routeSlashInput`（`webapp/lib/slash-routing.ts`），由
`composer.tsx#submit` 调用。它比对的那份清单在服务端只声明一次：
`server/lib/interaction/command-registry.js` 的
`CMD_BUTTON_COMMANDS`（`/api/cmd` 的 400 分支与 `/help` 的兜底列表都读它）。
浏览器侧保留一份镜像——打包产物不能 import 服务端模块——由
`webapp/test/slash-routing.test.ts` 把镜像与服务端注册表、以及从
`interaction/commands.js` 两个分发器里解析出的 `case` 标签三方对比。
只在一边加命令，门禁就会红。

### 斜杠命令面板：回车与 Tab 的语义

当输入框里只有一个以 `/` 开头、且至少匹配到一条命令的词时，面板打开。
各按键的含义如下，且**不随候选条数变化**：

| 按键 | 效果 |
| --- | --- |
| `Enter` | **发送**输入框里的内容，面板开着也照发 |
| `Tab` | 把高亮候选补进输入框，不发送 |
| `↑` / `↓` | 移动高亮（循环） |
| 点击某一行 | 补全该行 |
| `Esc` | 清空草稿，面板开着也一样 |

候选条数被**刻意排除**在这套语义之外。`availableCommands` 把每条命令
报了两遍——引擎自己的 `mcode` 组与 webui 按钮命令组——同一个名字因此可能
出现多次，一个完整敲出的 `/status` 到 composer 手里就是两条一模一样的候选。
于是「候选有歧义时 Enter 负责补全」这条规则恰好在最没有歧义的命令上生效，
吞掉了本该用来执行命令的那次回车：输入框里的文字留着，命令没跑，再按一次
回车就把一个光秃秃的单词当普通消息发了出去。判断落在
`shouldCompleteSlashWord`（`webapp/lib/slash-routing.ts`），它只接收按键。
去重是在**送到屏幕上之前**做的，不参与上面这个判断：两个缺陷彼此独立，
谁也不是谁的前提条件。

与它共用同一段 keydown 处理、并且一并修掉的还有第二个缺陷：
`availableCommands` 里是**裸名**（`name: "status"`），把候选原样写回输入框
得到的是 `status ` —— 开头的斜杠没了，发出去的是一条消息而不是一条命令。
`completeSlashWord` 会补回恰好一个斜杠，并先剥掉名字里已有的斜杠，
因此输入框不可能出现 `//`。

面板里的行来自 `flattenAvailableCommands`（`webapp/lib/slash-routing.ts`）：
把 `availableCommands` 字典拍平，并**按首次出现去重**。`mcode` 组（ACP
引擎命令）与 `webui` 组各有一个 `help`，而面板行以 name 为 key——
不去重时同一个 key 渲染两行，React 会在控制台报
"Encountered two children with the same key"，用户也会看到两条一模一样的
`help`。重复项对用户是同一个斜杠命令（输入后走 `routeSlashInput`
路由，与点哪一行无关），因此面板每个名字只显示一次。
`webapp/test/slash-commands.test.ts` 钉住去重规则，测试直接 import
composer 实际调用的那个函数。

| 方案 | 前缀有歧义时按 Enter | 否决理由 |
| --- | --- | --- |
| Enter 一律发送（本次采用） | 执行 `/co`，引擎报错，用户立刻看见 | — |
| 除非方向键动过高亮，否则 Enter 发送 | 执行高亮那条 | 同一个键变成两义，取决于用户未必设置过的状态（鼠标悬停也会移动高亮），且失败是静默的：跑掉的是用户没输入的那条命令 |
| Enter 一律补全 | 补入第一条候选 | 就是本次上报的缺陷；不打方向键就永远够不到自己敲出来的命令 |

面板不替代发送按钮，发送按钮也不替代面板。composer 的提示行把这两条绑定
直接写了出来：`Enter 发送,Tab 插入`。

### `POST /api/cmd` 的四种回答

响应写在**分发之后**，因此它描述的是命令本身，而不是“收到了请求”。

| 状态码 | 响应体 | 含义 |
| --- | --- | --- |
| `200` | `{ok:true, cmd}` | 分发器认领了该命令并已执行 |
| `400` | `{ok:false, error, reason:"unknown_command", cmd, knownCommands[], suggestion}` | 无人认领；未发生任何状态变更 |
| `4xx` | 通用请求门禁在处理器之前拒绝 | `Origin` 不可信、token 无效（`403`）、限流（`429`） |
| `5xx` | 授权、审计或命令体自身失败 | 写前审计按设计 fail-closed |

`authorize("slash.clear")` 授权被拒**不是**错误状态：
`handleCmdCommand` 追加 `● 已取消 /<cmd> (授权未通过: <decidedBy>)`
到转录后仍回 `200 {ok:true, cmd}`，且未发生任何状态变更。
因此 `200` 不能证明命令真的做了事——要读转录才知道。

`error` 是直接显示在 composer 错误条上的中文提示；`reason` 是机器可读
的判定位；`suggestion` 是修复办法——`/goal` 这类 send 路径命令会提示
“作为普通消息发送”，其余情况列出本端点真正接受的命令。
`knownCommands` 把接受集一并下发，客户端不必自己硬编码一份。

本路由的早期版本在分发之前就写下 `200 {ok:true}`，于是任何输入都是
成功——`/goal <内容>` 清空了输入框，却什么也没发生。

被拒的命令不会改动任何状态：不写对话行、不设目标、不建会话。composer
把被拒的原文回填（排在请求期间新输入的内容之后）并展示错误条；转到
`/api/send` 后被引擎拒绝的命令，则通过异常通道的错误提醒呈现。

### 一条转录行归谁所有

`/api/cmd` 的输出和引擎的输出都是转录行，但来源不同。

| 种类 | 谁写的 | 在引擎 runtime DB 里？ | 轮询后还在吗？ |
| --- | --- | --- | --- |
| 引擎回合（`› ping`、`● pong`、工具块） | 引擎，流式写进 `cs.chat` | 在 | 在，并从 DB 刷新 |
| `/api/cmd` 回显（`› /help`、`● 可用命令：…`、`● 当前 model=…`、`● 变更概览 …`） | `interaction/commands.js` 写进 `cs.chat` | **不在——引擎从没见过它** | 在，而且只有它能让它留下 |
| 别的客户端跑的回合（桌面版、TUI） | 引擎，属于另一个 cid | 在 | 在，会被拉进来——这正是轮询的目的 |

每四秒跑一次的轮询（`lib/transcript-sync.js`，`MCODE_WEBUI_TRANSCRIPT_SYNC_MS=0`
可关闭）重读引擎侧视图，好让「在别的窗口里被驱动的会话」在当前标签页
跟上来。它是**合并**，不是替换：`mergeEngineTranscript`
（`lib/transcript.js`）把引擎读到的内容与已展示的行并行走一遍，引擎不
知道的行原地保留，引擎多出来的部分追加到末尾。

服务端写的注解行——`§§ processed_duration=Nms`、`§§ turn_msg=<id>`、
`##tc:<id>`——是唯一不能按普通行处理的引擎行：位置就是它们的全部意义，
解码器把每一行解析到它上方的块上。聊天记录早于某个标记落盘的标签页手里
没有这一行，于是合并在引擎放它的那个游标处补上，绝不追加到末尾。两个
后果都在聊天里看得见：别的客户端跑出来的回合保住**自己**的回合坐标，而
不是把它交给用户随后执行的东西——这正是「已编辑 N 个文件」卡片读本回合
变更与读引擎最新回合之间的差别；标记上线之前录下的转录会就地补上注解，
而不是在自己的副本后面再放一遍——追加到末尾恰恰会把整段对话复制一份，
一次带注解、一次不带。

被否掉的方案：直接赋值覆盖 `cs.chat`。只有一行，也确实曾经这么上线。
后果是 `/help` 与 `/status` 返回 `200`、清空输入框、渲染出输出、约四秒后
消失——而 `persistCurrentChat` 把这次删除一并落盘，刷新也回不来。隔离
实例实测：t+200 毫秒时回显还在线上，下一个轮询周期就没了。另一版方案是
在内存里记一份「本地行」台账，也被否：它活不过它本该保护的那次刷新，
而用户注意到的恰恰就是刷新之后没有回显。

合并成立的前提是引擎**只追加**、从不改写已发出的行。改写会表现为旧行与
新行并存而不是被替换；切换路径的回填规则（`routes/sessions.js`）本来就
依赖同一个前提。

## 发送确认：「未确认」不等于「失败」

`POST /api/send` 在 `handleSend` 开头就写下 `200 {ok:true}`，之后才跑回合。
所以确认回执报告的是**收到**，浏览器给它加的期限
（`SEND_ACK_TIMEOUT_MS`，`webapp/lib/api.ts` 里 30 秒）报告的是**往返**。
两者都没说引擎是否接下了这条提示——代理卡住或事件循环繁忙时，引擎可能
正在执行，而浏览器还在等。

把这件事报成失败，是在对一个可能已经发生的副作用下结论；而 composer 对
「失败」的反应是把原文放回输入框，于是误报变成重复执行。实测中一条
`sleep 35` 之所以跑了两遍，就是因为第一次的确认慢了、用户又按了一次回车。

| | 旧 | 新 |
| --- | --- | --- |
| 错误形态 | `Error("no response within 30000ms")`，靠文案匹配 | `SendUnconfirmedError`，靠 `unconfirmed` 标志位匹配（`isSendUnconfirmed`） |
| 期限 | 30 秒 | 30 秒——**不变**；调长只是把同一个假阴性推到更晚 |
| 判定 | 无，期限本身就是结论 | `probeSend` 查 `GET /api/state`，上限 3 次读、约 2.7 秒 |
| 草稿回填 | 一律回填 | 只有服务器明确查不到这条消息时才回填 |
| 错误条 | `消息发送失败: no response within 30000ms`，红色 | 三选一，三条都不宣称失败 |

`probeSend`（`webapp/lib/send-confirmation.ts`）把若干次读归约为三种答案之一：

| 答案 | 依据 | 草稿 | 文案说的是 |
| --- | --- | --- | --- |
| `accepted` | 该 cid 有回合在跑，或提示词的 `›` 回显已在转录里 | **不回填** | 已发出但一直没确认，引擎此刻在跑这条消息——请勿重复发送 |
| `rejected` | 服务器答了，且没有这条消息的记录 | 回填 | 未送达，服务器没有记录；原文已放回输入框 |
| `unreachable` | 一次都没读到 | 回填 | 状态未知，可能已经在执行——发送前请先查看会话历史 |

整套设计的关键在 `accepted`：一条引擎可能已经在跑的消息，绝不能以
「一次回车就能重发」的形态回到输入框。`unreachable` 虽然答案未知，仍然
回填草稿——让用户输入的内容消失是更严重的缺陷，而文案里带着「先查历史」
这句指引，回填才是安全的。该错误条同时改用次要文字色，不再是错误红。

上面三种答案定的是错误条**何时显示**；**何时消失**是另一件事
（webui-parity 106）。`running.active` 亮着时，灰条在履行职责；这个标志
落下——它警告的那个回合结束了——灰条随之消失
（`webapp/lib/composer-draft.ts#unconfirmedPatchOnTurnEnd`，composer 里
一个盯 running 下降沿的 effect 负责套用）：此前 `sleep 35` 跑完后，灰条
会一直挂在输入框下直到下次发送或刷新。真正的 `rejected` 拒绝保持原有的
消失路径；显示判定一字未动。

错误条还是**有归属**的，不是广播。草稿存储按会话分键，catch 分支把红条
写进**发起发送的那个会话**的键下——用户在会话 A 发送失败后已经切到
会话 B，B 的输入框永远不会因此变红；回到 A 时才看到这条失败。旧行为
（模块级共享桶，再到 #141 的切换即清）要么把红条串到别的会话，要么把
用户正要回去看的那个会话自己的红条销毁掉。

给 `POST /api/send` 加一个客户端生成的幂等键，可以让重复执行从「不太可能」
变成「结构上不可能」。本次没做：那是请求契约变更，还需要服务端带明确时间窗
的去重存储。留作独立一单，不塞进这次修复。

**怎么验证它真的好了。** 在一个已经有引擎回合的会话里发 `/help`，把标签页
放着：十秒后输出还在，刷新之后还在。对着一个「回合正在跑」的服务器制造一次
确认超时：错误条会说引擎正在执行这条消息，且输入框是空的。等这个回合跑完：
灰色错误条自己消失。

## 输入区的状态按会话隔离（webui-parity 106）

用户停在输入区的一切——正在打的文字、附件 chips、发送失败红条——都存在
当前会话的键下（`webapp/lib/composer-draft.ts`，以 `state.sessionId` 为键
的 `Map`；`""` 是首页无会话的桶）。切换会话就是换一个盒子：会话 B 永远
不会显示会话 A 的草稿或红条，来回切换两边的状态都不丢。质检 s28 截图
拍到的正是这个存储的共享桶版本：会话 2 的视图同时挂着会话 1 的草稿、
409 红条和模型 chip。

按会话存储、而不是「切换时清空」，是权衡后的决定：清空 effect（#141 的
过渡修法）在用户**切回来**时同样触发，恰恰毁掉他们回来要看的那份草稿和
没读完的红条。按会话分键保住了旧全局行为里好的那一半（来回跳会话什么都不
丢），又去掉了串扰。草稿不落 `localStorage`——它们是本次页面访问的工作
状态；持久化面仍归 `lib/persist.ts` 的契约管。

模型选择器 chip 的**值**一直读服务端快照，本就不需要隔离；它的本地 UI
状态（打开的级联、预览中的行、按模型记的草稿镜像）在会话键变化时重置，
会话 A 的菜单状态不会在会话 B 的视图里残留。至于在一个会话视图里做的
模型选择会不会落进另一个会话的引擎配置，那是服务端
`applyConfigOptionUpdate` 的事，不在本单前端范围内。

**怎么验证它真的好了。** 在会话 A 打一段草稿，切到会话 B：B 的输入框是
空的，chip 跟着 B 的服务端模型走。切回 A：草稿和没读完的红条原样都在。


## 端点清单（依据当前源码）

下表覆盖全部已注册的 `/api/*` 路由。`OWNED_ROUTES`（Hono，62 条）
是直观的清单；旧派发器仅保留两条 SSE（`/api/events`、`/api/alerts`）
以及静态与 trajectory 挂载。

`/api/events` 上除状态快照外还有命名帧——`needs_authorization`、
`authorization_decided`、`token.first_run`、`auth.token_rotated`、
`providers.updated`、`session-tree-changed`、`heartbeat`。
`session-tree-changed`（Agent Team）不带载荷（`data: {}`）：子代理记录
落库时触发，让侧边栏去重新拉 `GET /api/session-tree`，并且刻意绕过推送
合并器，稀疏的树变更不会被丢。父会话的子代理列表随状态快照以
`recentSubagents[]`（`{toolCallId, sessionId, agentName, status,
createdAtMs, updatedAtMs}`）下发，按 `toolCallId` 幂等、上限 32 条、
5 分钟 TTL；聊天卡片按 `toolCallId`（即 `##tc:` 标记）而非工具名把
`→ task` 行对到对应条目。

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
| `POST` | `/api/send` | `routes/chat.js#handleSend` | 火即弃；`200 {ok}`；`400 content required`；`409 {reason:"cid-busy"\|"session-busy"\|"at-capacity", running?, limit?}`；占用按会话计，同一标签页的第二个会话不会被阻塞——见「同一标签页内的跨会话并行」；空闲看门狗在连续静默 `MCODE_WEBUI_PROMPT_IDLE_TIMEOUT`（默认 120 秒）后中止该回合 |
| `POST` | `/api/stop` | `routes/chat.js#handleStop` | `200 {ok, wasRunning, cancelled, hardKilled, note}` |
| `POST` | `/api/cmd` | `routes/chat.js#handleCmd` | 只接受那八个按钮命令；被认领 → `200 {ok, cmd}`，未被认领 → `400 {ok:false, reason:"unknown_command", knownCommands, suggestion}` —— 见[斜杠命令](#斜杠命令走哪个端点webui-parity-ticket-65) |
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
| `GET` | `/api/fs/read-file` | `routes/fs.js#handleFsReadFile` | `?path=&confirm=1`；`200`（成功体携带 `mtime`——`POST /api/fs/write` 冲突检测的基线）；凭据形路径（未带 `confirm=1`） → `403 {code:"credential"}`；超过 fs-util `DEFAULT_FILE_READ_MAX = 512 KiB` → `413`；二进制 / 非常规文件 → `415` |
| `GET` | `/api/fs/raw` | `routes/fs.js#rawStreamToWebResponse` | `?path=&download=1&confirm=1`；20 MiB 上限的流式响应；同样的凭据守门；按扩展名映射 mime，含 `.html/.htm`、`.svg`、`.png/.jpg/.gif/.webp`、`.js/.mjs/.css/.json` |
| `POST` | `/api/fs/mkdir` | `routes/fs.js#handleFsMkdir` | `{path}`；父目录必须在允许根内；containment 失败 → `403` |
| `POST` | `/api/fs/write` | `routes/fs.js#handleFsWrite` | `{path, content, expectedMtime?, expectedSize?, confirm?}`——预览编辑器的保存端点（slice 27）。`200 {ok, path, size, mtime}`（返回新基线）；`400 {code:"missing-path"\|"missing-content"\|"invalid-content"\|"not-a-regular-file"}`；containment → `403`；凭据形路径未确认 → `403 {code:"credential", credentialReason}`；文件消失 → `404 {code:"not-found"}`（TOCTOU 兜底——缺失路径通常先被共享闸门拦下，与读取行为一致）；基线过期 → `409 {code:"conflict", diskMtime, diskSize}`（不写盘）；超上限 → `413 {code:"too-large"}`（写入上限与读取同为 512 KiB）。实现是对围栏内路径的裸 `writeFileSync`——全程无 shell。凭据形路径带 `confirm:true` 时输出 `endpoint:"write"` 的 `credential.override` 审计行。 |
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
| `GET` | `/api/models` | `routes/model.js#handleGetModels` | 引擎模型 + webui 标签/限额投影；`thinkingLevels` 取自引擎两种思考 schema（档位原样、可开关内建为 `["off","on"]`）。响应含 `groups`（按供应商分组，供选择器分节）、`current`（当前模型 id，无则 `null`）、`currentThinking`（当前思考等级）、`models`（扁平列表）与 `source`（目录来源）——字段全表见 [`webui.md`](webui.md) |
| `POST` | `/api/set-model` | `routes/model.js#handleSetModel` | `{model, thinking?}`；仅当 `model` 为空**且**未传 `thinking` 时 → `400`（缺参数，不是"未知模型"——不存在的模型名照样记录下发，接口不校验名字）；effort 模型下发 model+`thinkingEffort`，变体模型把开/关档折进一次模型选择 |
| `POST` | `/api/permissions` | `routes/model.js#handleSetPermissions` | `{mode}`；映射到引擎 `WEBUI_TO_MCODE_PERMISSION` |
| `GET` | `/api/permissions-modes` | `routes/model.js#handleListPermissionModes` | 引擎当前的 `availableModes` |
| `POST` | `/api/answer` | `routes/model.js#handleAnswer` | **已移除的能力，仅留墓碑路由。** 恒为 `410 {ok:false, removed:true, error}`。它过去返回 `200 {ok:true, deprecated:true}` 却从未触达引擎，而四个按钮都在调它——点击看着成功，提问其实一直挂着。`webapp/lib/api.ts` 刻意不为它导出任何客户端；在拿到真正能触达引擎的通道前不要补回来。详见「阻断式弹窗：各自到底能应答什么」 |
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

## 阻断式弹窗：各自到底能应答什么

`components/modals.tsx` 渲染三个阻断式弹窗。其中两个的决定引擎收得到，另一个收不到 —— 那个不装样子，而是直说。这个区分是契约，不是界面偏好：**一个把决定发往引擎从不读取之处的按钮，会让点击"成功"而提问一直挂着**，比干脆不显示该按钮更糟。

| 弹窗 | 应答通道 | 引擎收得到吗 |
| --- | --- | --- |
| ask_user 提问 | `POST /api/send {content, isAskAnswer:true}` | 收得到。`routes/chat.js` 读 `isAskAnswer` 并转发该字符串；选项、自由文本、跳过三者都走它。 |
| 授权确认 | `POST /api/auth/decision {requestId, approve}` | 收得到 —— 但这是 webui 自己的 `authorize()` 动作门禁，不是引擎的工具权限询问。 |
| 计划审阅 | 无 | **收不到。** 该弹窗只读，不渲染任何决定按钮。 |

### 为什么计划决定没有通道

计划审阅不是 ACP 消息，它是一次运行时问卷：

1. `local-runtime-v2` 以 `questionnaire.ask` + `mode:'plan'` 打开它，只有一步、一个选项 `approve`（`packages/local-runtime-v2/src/service/plan/application.ts:278`）。
2. ACP 桥接**单向**投影为 `plan_update` 通知（`packages/tui/src/acp/agent.ts:1356`），没有任何东西把答案送回去。
3. TUI 走 local-runtime 通道应答 —— `runtime.replyQuestionnaire`（`packages/tui/src/tui/controller/interaction/interaction-flow.ts:938`）—— 本包不实现这个运行时。
4. 兜底路径是引擎主动发来的 `session/requestPermission` **请求**（`packages/tui/src/acp/interactions.ts:680`）。`acp.mjs#_dispatch` 把它 emit 出去却无人应答，因此这条路也走不通。引擎侧 `app.onRequest(acp.methods.agent.*)` 的全部方法只有 `initialize`、`authenticate`、`session.new/list/fork/load/resume/close/setMode/setConfigOption/prompt` —— 没有任何"计划决定"方法可调。

所以弹窗只展示计划正文，并说明这次审阅需要在别处应答。它**可关闭**：在没有可用按钮的前提下，不能关的弹窗就是陷阱。关掉它并不会应答这次审阅 —— 无论关不关，本轮在引擎侧都处于暂停。

### `plan_update` 的载荷

唯一产出方是 `agent.ts:1356`，发的是 `{sessionUpdate:'plan_update', plan:{type:'markdown', planId, content}}`。`server/lib/mcode-acp.js` 的投影读的正是这个形状。它此前读的是 update **顶层**的 `planId` / `title` / `summary` / `options`，而引擎一个都不放在那里 —— 于是 `plan.active` 为真而标题为空、正文为空、无选项。`options` 恒为空，留在类型里只是为了让消费方不会读到 `undefined`；审阅里那个 `approve` 选项在问卷那一侧。

### 将来要接上计划决定时的做法

两件事必须**按序**一起落地：

1. **先让 ACP 客户端能应答反向请求。** `acp.mjs#_dispatch` 目前会丢弃所有"请求而非响应"的消息，需要一个按 JSON-RPC id 索引的应答注册表；否则引擎的 `session/requestPermission` 会一直挂着，直到投影超时并以「关闭问卷」收场。
2. **然后才修 `initialize`。** `acp.mjs#start` 现在发的是 `capabilities: {mcpCapabilities: …}`，而引擎读的是 `params.clientCapabilities`（`agent.ts:434`），所以 webui 实际上一个客户端能力都没协商上。后果比计划本身更大：`plan_update` 投影以 `clientCapabilities.plan` 为开关，因此**今天根本不会触发**；本可应答多选问卷的 elicitation 路径也因同一原因不可用。只改字段名会开始向 webui 发送它答不了的问卷。

在那之前，`POST /api/answer` 保持 `410` 墓碑，`webapp/lib/api.ts` 不为它导出任何客户端。

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
