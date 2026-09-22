# MiniMax Code Web UI

> 简体中文 | [English](README.md)

> **MiniMax Code 智能体运行时的浏览器前端。**
> 通过 HTTP/SSE 流式传输 `mcode acp` / `mcode exec` 会话。零 npm
> 依赖；运行于 Node 22.19+。

Web UI 是本仓库的一等组成部分 —— 驱动 TUI（`mcode acp`，基于 stdio 的
Agent Client Protocol）的同一个引擎同时驱动浏览器前端，与终端 UI
和桌面客户端并存。

它源自社区 **mcode-webui** 插件（由 Wzdhehe 及贡献者开发；插件
v1.0.0 → v2.0.0，MiniMax-Code-Plugins PR #16/#23/#31/#55，外加
PR #56 的轨迹工作室），并作为 `packages/webui` 迁移入产品。完整
的人员与历史记录请参见仓库根目录的
[`co-builders.md`](../../co-builders.md)。

## 快速开始

```bash
# 从已构建的检出（或已安装的 mcode CLI）：
mcode webui                     # http://127.0.0.1:18090
mcode webui --port 8123 --host 127.0.0.1

# 直接启动（开发）：
node packages/webui/server.js
```

服务器默认绑定回环地址。局域网暴露需显式选择开启
（`--host` / `HOST` 环境变量，或持久化的 `lanBind` 设置）。首次
启动时会生成一个令牌并通过 SSE 发送给浏览器；非本地请求必须携带
`?token=<value>` 或 `Authorization: Bearer <value>`。

在非回环网络上推荐的做法：

```bash
export TOKEN="$(openssl rand -hex 16)"
mcode webui --host 0.0.0.0
# 打开 http://<lan-ip>:18090/?token=$TOKEN
```

## 目录内容

| 文件 | 说明 |
|------|------|
| `server.js` | HTTP + SSE 服务器引导 |
| `server/` | 路由器、路由模块与纯函数库（`server/lib/`） |
| `acp.mjs` | `mcode acp` JSON-RPC 客户端（通过 stdio 派生引擎） |
| `public/` | 静态前端 SPA |
| `server/trajectory/` | 会话轨迹工作室（只读 SQLite 检视） |
| `references/SECURITY-NOTES.md` | **权威安全披露**（在回环之外暴露前必读） |
| `docs/` | ARCHITECTURE、API、CAPABILITIES、DEVELOPMENT、TROUBLESHOOTING、CHANGELOG |
| `test/` | `node:test` 测试套件 |
| `checks/` | 打桩单元检查（`t.mock.module`；需要 module-mocks 标志） |
| `scripts/` | 文档对齐检查器、SBOM 生成器、测试数据库夹具构建器 |
| `package.json` | 包元数据 + 清单（`mcodeWebui.capabilities`） |

## 截图

针对运行中的 v2.0.0 服务器真实截取 —— 参见
[`docs/screenshots/`](docs/screenshots/)。

| # | 展示内容 |
|---|---|
| 1 | **启动** —— 首次启动时的空聊天视图 |
| 2 | **流式聊天中** —— 历史已恢复，SSE 增量正在传输，tok/s 仪表 |
| 3 | **设置面板** —— 外观 / 语言 / 局域网访问开关 |
| 4 | **聊天输入** —— 已输入提示词，发送/停止控件，`/` 与 `@file` 提示 |
| 5 | **发送后 + 工具调用** —— 助手流式输出，工具调用块自动折叠 |

## 能力

本包暴露 13 项能力，声明于
[`package.json`](package.json) 的 `mcodeWebui.capabilities` 下，并在
[`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) 中有完整详细描述。下列
名称为规范标识符 —— 请保持稳定；外部注册表与 IDE 集成按这些字符串匹配。

| 能力 | 一句话说明 |
|---|---|
| `chat-streaming` | 来自 `mcode acp` 的 SSE 增量逐令牌渲染 |
| `tool-execution` | 从 acp `tool_call` 事件转发的 Bash / Read / Write / Edit |
| `plan-mode` | 计划审阅模态框，含 `agree` / `skip` / `add context` 选项 |
| `ask-user-tool` | 2–4 个选项的提问模态框，带 `Other` 自由文本回退 |
| `permission-prompts` | 工具调用的 `ask` / `auto` / `full` 审批模态框 |
| `workspace-switching` | 工作区选择器 + 最近列表 + 上次使用恢复 |
| `session-management` | WebUI 会话的列出 / 创建 / 切换 / 删除 |
| `file-attachments` | 拖拽 / 点击 / 粘贴上传 + `@path` 注入 |
| `quota-usage` | `mmx quota show` + 每轮上下文窗口显示 |
| `bilingual-ui` | 通过 `t(key)` 查找表实现 zh-CN / en 语言切换 |
| `lan-sharing` | 默认回环；局域网暴露需显式选择开启（`HOST` 环境变量 / `lanBind` 设置）+ 运行时开/关切换 |
| `token-auth` | 非本地请求使用 `?token=` / `Authorization: Bearer` |
| `mobile-responsive` | <900px 时为抽屉式，<600px 时为单列 |

CI 会断言这些名称中的每一个都在本 README 和
[`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) 中被提及（参见
`scripts/check-docs-alignment.mjs`）。

## 轨迹工作室

`server/trajectory/` 是迁移而来的 **mcode-trajectory-studio**（PR #56，
作者 weekbin）：一个针对本地 MiniMax Code 会话的只读检视器，由运行时
SQLite 投影（`~/.minimax/v2/sqlite/runtime-state.sqlite`）支撑，并以
`messages.jsonl` 作为回退。它提供轮次 / 时长 / 工具参数 / 令牌 /
压缩 / 子智能体视图，展示时已做脱敏处理。

```bash
node packages/webui/server/trajectory/main.mjs --doctor   # 数据源诊断
node packages/webui/server/trajectory/main.mjs --serve    # 独立面板（回环）
node packages/webui/server/trajectory/main.mjs            # 基于 stdio 的 MCP（7 个工具）
```

当 webui 服务器运行时，工作室也会挂载在 `/trajectory/` 下，
位于 webui 自身的来源/令牌/只读门禁之后。

Node 版本要求：工作室需要 `node:sqlite`，因此低于 Node
**22.13** 的版本无法运行它；已验证的范围（捆绑的 SQLite 始终附带
FTS5）为 **>=22.19 <23 || >=24 <27**，与运行时自身的引擎范围一致。
在该范围之外 —— 例如 Node 23.x —— FTS5 搜索可能不可用，面板
会降级为顺序扫描。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 运行时拓扑、请求生命周期、模块契约
- [`docs/API.md`](docs/API.md) —— HTTP/SSE 接口面
- [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) —— 能力深入解析
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) —— 开发工作流、测试
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) —— 常见故障
- [`docs/HTTPS-REVERSE-PROXY.md`](docs/HTTPS-REVERSE-PROXY.md) —— TLS 终止方案
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) —— 插件时代的发布历史

## 安全

在绑定到回环之外的任何地址之前，请阅读
[`references/SECURITY-NOTES.md`](references/SECURITY-NOTES.md)。要点：
默认绑定回环、可信来源 CORS、逐请求 `authorize()` 门禁（失败关闭的
审计）、独立的异常 SSE 通道、工作区围栏、受限上传、速率限制、无遥测。

## 许可证

MIT，作为 MiniMax Code 仓库的一部分。插件时代的项目采用相同的 MIT
许可证，并署名 Wzdhehe 及贡献者 —— 该记录保存于
[`co-builders.md`](../../co-builders.md)。
