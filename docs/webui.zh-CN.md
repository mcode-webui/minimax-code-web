# Web UI

> 简体中文 | [English](webui.md)

Web UI（`packages/webui`）是 MiniMax Code 的浏览器前端。它使用与 TUI 相同的引擎 —— CLI 的 ACP 服务器（`mcode acp`，基于 stdio 的 JSON-RPC 2.0）—— 因此终端、浏览器和桌面客户端都运行在同一个运行时之上。它不是一个插件：它随仓库一起发布，并由 CLI 启动。

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

不传 `--port` 时服务器从 18090 启动，若 18090 被占用就换下一个空闲端口，并打印实际绑定的地址 —— 启动器打开的就是这个地址。显式指定的 `--port`（或 `PORT`）会被钉住：不会自动后移，端口被占用时以 EADDRINUSE 退出。

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

正式的披露文档是 [`packages/webui/references/SECURITY-NOTES.md`](../packages/webui/references/SECURITY-NOTES.md)。

## 架构

运行时拓扑、请求生命周期和 SSE 契约见 [`packages/webui/docs/ARCHITECTURE.md`](../packages/webui/docs/ARCHITECTURE.md)。简言之：`packages/webui/server.js` 注册 workspace 导入解析器，并委派给 `server/bootstrap.js`；`server/router.js` 应用门禁链（CORS → origin/CSRF → LAN → token → rate limit → read-only）并分发到 `server/routes/*`；`server/lib/*` 存放单一职责模块；`acp.mjs` 是生成引擎的 ACP 客户端；`webapp/out/`（Next 静态导出）是 UI，`public/trajectory/` 与 `public/auth-gate.html`（从导出根提供）是仅存的旧版资源。

## 轨迹工作室

`server/trajectory/`（从 mcode-trajectory-studio 插件迁移而来）通过运行时 SQLite 投影以只读方式检查本地会话，并以 `messages.jsonl` 作为回退，提供轮次/时长/令牌/压缩/子代理视图。它挂载在 `/trajectory/`，位于 webui 的门禁之后，也可以独立运行：

```bash
node packages/webui/server/trajectory/main.mjs --serve   # loopback panel
node packages/webui/server/trajectory/main.mjs --doctor  # data-source diagnostics
node packages/webui/server/trajectory/main.mjs           # MCP over stdio (7 tools)
```

## 开发与测试

```bash
pnpm --filter @mavis/webui test      # full node:test suite (unit + mocked + integration + matrix + trajectory)
pnpm test:webui                      # same, from the repository root (CI gate)
node packages/webui/scripts/check-docs-alignment.mjs
```

该包有三个运行时依赖（HTTP 层的 `hono` + `@hono/node-server`，以及工作区路径约定的 `@mavis/shared`），需要 Node 22.19+（轨迹工作室另外需要 `node:sqlite`，下限 22.13）。

## 起源

该包把社区 mcode-webui 插件（v1.0.0 → v2.0.0，MiniMax-Code-Plugins PRs #16/#23/#31/#55）和 mcode-trajectory-studio 插件（PR #56）迁移进了产品。完整的人员与历史记录见 [co-builders.md](../co-builders.md)。
