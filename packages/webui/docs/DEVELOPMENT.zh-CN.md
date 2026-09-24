# 开发指南

> 简体中文 | [English](DEVELOPMENT.md)

> 如何在本代码库上工作。目标读者：已经克隆了本仓库，
> 想要添加功能、修复 bug，或对代码库有足够理解以便
> 审阅 PR 的人。

## 环境准备

要求：
- Node 22.19+ 或 24+（项目在 `package.json` 的 `engines` 中强制要求）
- 已安装 mcode 0.1.4+ 且在 `PATH` 上（或通过 `MCODE_CMD` 指向）
- 关于 SQLite（用于会话清理）：`better-sqlite3` 是惰性加载的，
  所以安装时并不需要它，只有在运行时命中清理端点时才需要。
  `SQLITE3_BIN` 环境变量指向一个预编译二进制文件，以便你在
  需要时手动读取数据库。

零 npm 安装。克隆后运行：
```bash
cd packages/webui
node server.js
# → http://127.0.0.1:18090（或下一个空闲端口，见下文）
```

`packages/webui/server.js` 是源码模式下的引导文件：它注册 `tsx`
加载器和一个把每个 `@mavis/*` 解析到工作区 TypeScript 源码的解析器，
然后委派给 `server/bootstrap.js`。发布归档运行的是
`dist/webui/server.js`（`bootstrap.js` 的 esbuild bundle）；两个
入口共享同一份启动代码。

如果想要调试会话（详细 SSE、无缓存、可注入事件）：
```powershell
$env:DEBUG_INJECT = '1'
node server.js
```

## 代码结构（摘自 ARCHITECTURE.md）

- `server.js` — 仅做引导（注册 workspace 导入解析器，
  然后委派给 `server/bootstrap.js`）。不要在这里添加功能。
- `server/router.js` — 声明式路由表。在这里添加你的路由。
- `server/routes/*.js` — 每个 URL 族一个文件。每个文件导出
  `async function handleXxx(req, res, ctx, pathname)`。
- `server/lib/*.js` — 纯模块。每个模块只关注一件事。
- `webapp/` — Next.js 14（React 18 + Tailwind）前端。App Router
  在 `webapp/app/`、组件在 `webapp/components/`、非视觉逻辑
  在 `webapp/lib/`、设计令牌在 `webapp/styles/`，静态导出
  写入 `webapp/out/`。
- `public/trajectory/` — 独立轨迹工作室（自带后端、CSP、
  令牌策略）。由路由器挂载到 `/trajectory/`。

## 添加新的 HTTP 端点

1. 创建 `server/routes/foo.js`：

   ```js
   // server/routes/foo.js
   import { pushStateFor, getClient } from '../lib/state-bus.js'
   import { fail, ok } from '../lib/util.js'  // if you have one

   export async function handleFoo(req, res, ctx, pathname) {
     const cid = ctx.cid
     if (!cid) return fail(res, 400, 'cid required')

     const body = await readJsonBody(req)
     if (!body) return fail(res, 400, 'invalid JSON')

     // do the work…

     // if it mutates state:
     pushStateFor(cid, { /* delta */ })
     // for one-off SSE messages, see `pushOnlineCount` / `broadcastTokenRotated`

     return ok(res, { /* response */ })
   }
   ```

2. 在 `server/router.js` 中接线：

   ```js
   import * as fooRoute from './routes/foo.js'
   …
   { method: 'POST', match: (p) => p === '/api/foo', handler: fooRoute.handleFoo },
   ```

3. 如果 webui 要调用它，在 `webapp/lib/api.ts` 中添加一个辅助函数：

   ```ts
   export async function apiFoo(payload: unknown): Promise<…> {
     const r = await fetch('/api/foo' + API_SUFFIX, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', ...HEADERS },
       body: JSON.stringify(payload),
     })
     return r.json()
   }
   ```

4. **不要在路由处理器中直接写入 `clientState.state`**。
   使用 `pushStateFor(cid, …)`，这样变更会通过 SSE
   通道广播，客户端才是事实来源。

## 添加新的 SSE 事件类型

1. 在 `docs/ARCHITECTURE.md § 5`（SSE 事件模式）中定义事件结构。
2. 在传输层（`mcode-acp.js` 或 `mcode-exec.js`）中，将
   原始 mcode 事件翻译为你的规范化事件：
   ```js
   yield { type: 'foo', … }
   ```
3. 传输层通过 `pushStateFor(cid, …)`（状态快照）或
   `broadcastTokenRotated(token)`（一次性事件）推送事件，
   它们会进入 SSE 通道。
4. 在 `webapp/lib/sse.ts` 的 SSE 消息处理器中处理该事件，
   并更新类型化的 store（`store.foo`）。
5. 如果该事件需要 UI，添加一个 `renderFoo()` 渲染函数（或接入
   既有组件），并从页面的渲染路径中调用它。

## 添加新的 UI 面板

1. 在 `webapp/components/` 下新增一个面板组件（若是顶层新
   表面，在 `webapp/app/page.tsx` 注册；若是嵌套在 shell 右侧
   抽屉里，直接内联进 `webapp/components/shell.tsx`）。
2. 把 i18n 键加入 `webapp/lib/i18n.ts` 的两张表（使用一致的
   前缀：`panel.foo.title`、`panel.foo.empty`）。
3. 在组件内部：
   - 通过类型化的上下文 hook（`webapp/lib/store.tsx` 的
     `useSessionContext`）读取 state，并订阅相关分片。
   - 用从 `webapp/styles/tokens.css` 派生的 Tailwind 类来渲染。
4. 若组件需要专门的样式，把它们加到
   `webapp/styles/official-utilities.css`（或在组件内用
   Tailwind 的 `@apply` 作用域）。

## 添加斜杠命令（webui 侧）

这些是 webui 自行处理、不转发给 mcode 的命令
（用于 `/clear`、`/exec` 之类的功能）。

1. 在 `server/lib/slash.js` 中添加一个条目：
   ```js
   { cmd: '/foo', handler: handleFoo, hidden: false }
   ```
2. `handleFoo` 接收 `(content, ctx)`，返回以下两者之一：
   - `null`（未处理，转发给 mcode）
   - `{ handled: true, response: '…' }`（已处理，作为
     合成消息发送给用户）
3. webui 会把 `response` 显示为仿佛来自 mcode 的消息。

## 添加由 mcode 翻译的斜杠命令

如果你想要一个映射到 mcode 命令的斜杠命令，你不需要
添加代码——mcode 通过 `session/commands` 返回命令列表，
webui 已经会渲染它。只需确保 mcode 知道该命令；
webui 会在连接时获取它。

## 在没有 mcode 的情况下测试

1. 在 `node server.js` 之前设置 `$env:DEBUG_INJECT = '1'`。
2. 打开 `http://127.0.0.1:18090/?debug=1`（或者直接查看右侧
   面板——调试面板始终可见）。
3. 在浏览器控制台中：
   ```js
   await fetch('/api/debug/inject' + API_SUFFIX, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ type: 'delta', text: 'hello from test' })
   })
   ```
4. 注入的事件会出现在右侧面板和 SSE
   流中。

你也可以在控制台调用 `__DBG.log('whatever')`——它会显示
在右下角的调试面板中。

## 数据库检查

webui 侧的会话存储是 `WEBUI_DATA_DIR`（默认 `~/.mcode-webui`，可由
`MCODE_WEBUI_DATA_DIR` 覆盖）下的纯 JSON：
```bash
cat "$HOME/.mcode-webui/sessions.json" | jq .
```

mcode 侧的会话存储是运行时数据目录（默认 `~/.minimax`，可由
`MINIMAX_DATA_DIR` 或 `MAVIS_DATA_DIR` 覆盖；`config.js` 解析优先级）
下的 SQLite：
```bash
sqlite3 "$HOME/.minimax/v2/sqlite/runtime-state.sqlite" ".tables"
sqlite3 "$HOME/.minimax/v2/sqlite/runtime-state.sqlite" \
  "SELECT id, title, cwd FROM local_runtime_sessions ORDER BY updated_at DESC LIMIT 10"
```

## 常见任务

### 提升缓存破除版本号（cache-bust）
Next 的静态导出对 `_next/static/<hash>/…` 下的每一个 chunk 都做内容寻址
（参见 ARCHITECTURE.md §7 的缓存策略），因此运行时从不依赖手动的 `?v=N`
提升——每次编辑后哈希都会变。旧版 vanilla-JS SPA 的 `?v=N` 查询串缓存破除
不再适用；前端改动后唯一要做的就是重新构建（`pnpm run webui:build`）并
重新导出。

### 修改默认端口
18090 只是默认值，不是被钉住的值：它被占用时服务器会往后找下一个空闲
端口，并打印实际绑定的端口。设置 `PORT`（或给 `mcode-web` 传 `--port`）
则是把端口钉住 —— 被占用的钉住端口会以 EADDRINUSE 退出而不是自动后移，
这样 docker 端口发布和健康检查仍然按配置值寻址。

```bash
# 默认端口：18090，被占用时换下一个空闲端口
node server.js

# 钉在 7891 —— 不会移动
PORT=7891 node server.js
```

### 启用局域网共享
两种选择：
- Web UI：左下角的 "局域网访问" 按钮
- API：`POST /api/settings {lanBroadcast: true}`

### 调试卡住的 mcode 子进程
webui 为每个 CID 保留一个子进程。如果它卡住了：
```powershell
# find the cid
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*acp*" } |
  Select-Object ProcessId, CommandLine

# kill it (replace PID)
Stop-Process -Id 12345 -Force
```

webui 会在下一次发送时启动一个新的子进程。

### 把自己锁在门外后重新启用局域网
`/api/settings` 端点在设计上豁免局域网守卫。
从局域网上的任何机器，即使 `lanBroadcast: false`：
```bash
curl -X POST http://192.168.1.50:18090/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"lanBroadcast": true}'
```

## 风格指南

- **服务器**：不使用分号、单引号、2 空格缩进、ESM。
  - 使用 `import` 而非 `require`。
  - 顶层 `await` 在脚本中可以，在模块中不行——如有需要，
    用 `async function main()` 包起来。
- **客户端**（`webapp/`）：同样的约定。前端是 Next.js 14 /
  React 18 / Tailwind 的 App Router 工程；新页面和组件放在
  `webapp/app/`、`webapp/components/`、`webapp/lib/` 下。逐文件
  的说明见 `webapp/README.md`。
- **注释**：解释*为什么*，而不是*是什么*。如果代码的行为
  与名字一致，就不需要注释。如果需要变通方案，注释中
  应引用上游 issue。webui 已彻底移除旧的 `public/app/*.js`
  vanilla-JS 前端；不要重新引入。
- **i18n**：任何用户可见的字符串都要经过类型化的
  `t(MessageKey)` 查询，定义见 `webapp/lib/i18n.ts`。英文与
  中文两张表始终保持同步；不要在组件里写死的字符串字面量。
- **CSS**：Next 导出使用基于 `webapp/styles/tokens.css` 设计
  令牌的 Tailwind 工具类。用 `<html>` 上的 `data-theme` 属性
  （`webapp/lib/theme.ts` 的 `applyTheme`）切换浅色与深色
  令牌表。

## 代码审阅清单

提交 PR 之前：

- [ ] `pnpm --filter @mavis/webui test` 通过（服务端单元 + 路由 + 工具）
- [ ] `pnpm --filter @mavis/webui webapp:typecheck` 通过
- [ ] `pnpm --filter @mavis/webui check` 通过（文档对齐关）
- [ ] 没有新的硬编码用户可见字符串（一切经由 `t(MessageKey)`）
- [ ] 没有直接写入 `clientState.state`（使用 `pushStateFor`）
- [ ] 如果是新端点，已在 `docs/API.md` 中记录（`check-docs-alignment`
      会强制要求该路径已在 `server/router.js` 中注册）
- [ ] 如果是新事件类型，已在 `docs/ARCHITECTURE.md § 5` 中记录
- [ ] 如果是新 UI 面板，`zh` 和 `en` 的 i18n 键都已存在
- [ ] 改动前端后已重新构建（`pnpm --filter @mavis/webui webapp:build`）
      再测试 bundle 形态
- [ ] 未经讨论不新增 npm 依赖；适用 `docs/ARCHITECTURE.md § 7.1`
      的分层依赖策略

## 仓库卫生

- 不要提交 `.server.err`、`.server.log`、`node_modules` 等。
  `.gitignore` 已覆盖这些。
- 不要把探针脚本提交到根目录。`probes/` 目录是一次性
  诊断脚本的临时空间；用完后清理干净。
- 提交信息：祈使语气、现在时（"add X"，而不是
  "added X"）。如有相关 issue，请在提交信息中引用。
