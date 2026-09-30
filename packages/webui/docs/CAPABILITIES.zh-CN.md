# 能力清单

> 简体中文 | [English](CAPABILITIES.md)

> 本文档是本 webui 能做什么、不能做什么的唯一事实来源。每一行都包含
> 一个状态（✅ 可用 · ⚠ 部分可用 · ❌ 受阻）、原因，以及在代码中
> 应该查看的位置。

webui 受三项约束限制：
1. 引擎的 acp 通过 JSON-RPC 暴露的能力（引擎在 `initialize` 应答的
   `agentInfo` 载荷中上报其版本，详见 `/api/protocol/capabilities`）。
2. Node `http` / `child_process` API 能做的事。
3. 浏览器 `EventSource` 与 `fetch` 能做的事。

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
| `git-panel` | §12 Git 面板 |
| `mobile-responsive` | §10 UI / UX |
| `bounded-workspace-search` | §6 工作区 |
| `credential-file-preview-guard` | §11 网络与访问控制 |
| `four-column-shell` | §10 UI / UX |
| `on-demand-columns` | §10 UI / UX |
| `three-state-appearance` | §10 UI / UX |
| `ide-grade-code-preview` | §10 UI / UX |
| `preview-toolbar-edit-save` | §10 UI / UX |

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
| Markdown 渲染（标题、列表、代码） | ✅ | `webapp/lib/markdown.ts` 包裹工作区的 `marked` 包（`packages/tui` 已依赖它；不走 CDN） |
| 代码块语法高亮 | ✅ | `marked` 的 code 渲染器（`webapp/lib/markdown.ts`）+ `webapp/styles/official-utilities.css` 的 CSS 类 |
| Markdown 内 Mermaid 图渲染（slice 23） | ✅ | 代码围栏语言写 `mermaid` 即渲染为图，而非代码块。围栏语言经"语言→渲染器"注册表分发（`webapp/lib/markdown.ts` 的 `registerLanguageRenderer`，107-113 行）；mermaid 在模块导入时自注册（`webapp/lib/mermaid-renderer.ts:64-71`），其他语言的渲染器可经同一接缝接入——markdown 主流程不针对语言名写分支。图表库在页面首张图出现时才动态加载（`components/mermaid-block.tsx:62-66`），该文件带一年 immutable 强缓存（`server/lib/static.js:66`）；没有 mermaid 围栏的页面完全不加载。图跟随浅色/深色主题（`components/markdown-html.tsx:52-66` 监听 `<html>` class；`components/mermaid-block.tsx:156-166、223-229` 按主题重新初始化）。语法错误时渲染可读的失败卡片——错误信息 + 可复制的原始源码（`components/mermaid-block.tsx:285-307`）——文档其余部分照常渲染。限制：图按列宽缩放、超宽时在卡片内横向滚动（`webapp/styles/mermaid.css:62-80`）；中文标签经字体栈正常显示（`components/mermaid-block.tsx:109`）；图不产生标题，因此不会进入任何按标题组织的大纲（围栏只产出 `<pre>`/`<div>` 占位对，不产出 `h1`-`h6`，见 `lib/mermaid-renderer.ts:44-57`）。依赖 `mermaid` 11.12.1（MIT）已登记于 `release/dependency-licenses.json`。 |
| Markdown 数学公式（KaTeX，行内 `$…$`、块级 `$$…$$`、```` ```math ```` 代码块） | ✅ | 与 Mermaid 同一条管线：行内经 marked 扩展 `webuiMath` 识别 `$…$`/`$$…$$`，`math` 代码块经语言→渲染器注册表分发（`webapp/lib/math-renderer.ts`，导入时自注册），两类围栏互不干扰。单个 `$` 仅在存在同 行闭合定界符、内容不以数字开头时才视为公式——`成本 $5 and $10`、`$HOME`、未闭合的 `$` 均按普通文本显示。公式无法解析时降级为原始写法的代码样式（行内降级 `<code class="inline-code">`，代码块降级为普通代码块），页面绝不白屏。KaTeX 以 `output: "html"` 运行（只产出 `span`/`svg`/`path`，清洗白名单按固定属性集放行；`<math>`/MathML 仍为整体丢弃标签），`trust: false`（`\href` 只显示红色警示文字，不会成为链接）。内联 `style` 仅在 `span` 上保留且值须通过 `isSafeStyleValue` 校验——禁止括号（杜绝 `url()`/`expression()`），`position`/`background`/`behavior` 直接拒绝；`components/markdown-html.tsx` 将 style 属性解析为 React 样式对象（`parseInlineStyle`，React 不接受字符串 style）。样式表 vendored 于 `webapp/styles/katex.css`（源自 `katex/dist/katex.min.css`，`@font-face` 指向 `/fonts/katex/…`），由 `app/layout.tsx` 加载；字体（60 个文件 + MIT 许可声明）vendored 于 `webapp/public/fonts/katex/`。公式为继承文字色的内容，深浅主题均正常、无需重渲染。已知成本：`katex` JS 随前端主包加载，不像 mermaid 懒加载（数学管线是同步 `renderToString`）。依赖 `katex` 0.18.7（MIT）已登记于 `release/dependency-licenses.json`。测试：`webapp/test/markdown-math.test.ts`。 |
| 运行中取消 | ✅ | acp `session/cancel` 以 notification 形式发送，并钉在该 cid 的活动子进程上（`/api/protocol/cancel` → `server/lib/mcode-rpc.js#cancelSession`）。只有当 notification 无法投递时，才会走硬杀兜底（`/api/stop` → SIGTERM/SIGKILL）。acp 会话在排空前可能还会再发出几个事件。 |
| 回退 / 分叉某条消息 | ⚠ | 引擎已实现 `session/fork` 和 `session/resume`（`MCODE_ACP_CAPABILITIES.fork / .resume = true`），但目前 webui 还没有路由暴露它们——参见 [§14](CAPABILITIES.zh-CN.md#14-要启用--行mcode-需要增加什么)。 |
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
| 本地（webui 侧）命令 | ✅ | `CMD_BUTTON_COMMANDS`（`server/lib/interaction/command-registry.js`）——`POST /api/cmd` 接受什么的唯一声明处，`/help` 兜底与 400 分支都读它：`new`、`clear`、`status`、`sessions`、`review`、`help`、`usage`、`stop`。`/clear` 只清空聊天 UI，不触碰 mcode；`/review` 输出一份 staged / unstaged / untracked 概览（见 §12）。不存在 `/exec` 命令——传输按回合由环境变量（`MCODE_USE_ACP=0`）或权限模式（非 Full access）决定，与斜杠命令无关。`server/lib/acp-client.js#WEBUI_LOCAL_COMMANDS` 是另一份 7 条目的数组，供 `/help` 列表使用，**没有**跟着补上 `/review`；契约是注册表，不是那份数组。 |
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
| 有界的工作区搜索（slice 19a/19b） | ✅ | `GET /api/fs/search`（`server/lib/fs-search.js#searchWorkspace`）。与其它 `/api/fs/*` 同一道围栏；深度/节点/耗时/匹配数有预算，超限返回 `truncated:true` + `truncatedReason` 而非静默。`node_modules`、`.git` 不可覆盖跳过；凭据命中以 `credential:true` 标记、不省略也不返回内容（只给路径与类型）。文件树过滤先查已加载内存树、零命中才发请求，因此未加载目录也能搜到。 |

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
| 会话骨架屏 + 流式活动指示（工单 U8） | ✅ | 冷启动 `!state` 分支渲染 `TranscriptSkeleton`（按真实消息行形状铺 shimmer 占位条，`webapp/components/loading-states.tsx`）；流式尾部的活动指示（`ActivityPulse`）在 `running.active` 期间显示三点加载动画加一条 shimmer 条；`prefers-reduced-motion: reduce` 下所有动画类显式静止（`webapp/app/globals.css`）。测试：`webapp/test/loading-skeleton.test.ts`。 |
| 自定义 CSS 主题 | ❌ | 没有主题加载器；需要一套 CSS 变量系统 |
| 用户自定义热键 | ❌ | 快捷键是硬编码的 |
| 四列布局（侧栏 · 对话 · 预览 · 树）（slice 17 + 21） | ✅ | `webapp/components/workspace-columns.tsx`。对话列在有固定列可见时于 `[280,768]` px 弹性；两个按需列都折叠时吃满剩余。预览与树列按需出现、最后一个同角色标签关闭即自动收起（`syncColumnVisibility`）。面按 `columnRoleForKind` 分流：`file:<path>`/浏览器在预览列，`files`/`git`/`tasks`/`搜索`/`plugins` 在树列。原先发布的 `search`、`alerts`、`progress` 已从 `PanelKind` 并集移除（`webapp/lib/persist.ts#PanelKind`）。侧栏树列的「搜索」面**自 slice 19b 起已可用**（`webapp/components/workspace-tree-column.tsx#SearchSurface`）。插件面**自 68 号工单起已可用**（`webapp/components/plugins-surface.tsx`，挂载于 `panels.tsx:354` 与 `workspace-tree-column.tsx:645`）：`plugins` 域列出已安装插件、本地市场与 GitHub 导入，每张卡片带启用开关与需要确认的卸载。面内还剩两处占位，两处都是诚实的：`skills`/`apps`/`mcp`/`agents` 四域渲染一张 `pending` 卡并写明缺哪项后端能力（不塞示例行）；官方市场渲染 `common.notLocal` 态——面板在发请求**之前**就短路，因为一次要等 30 秒超时才失败的请求看起来会像事故。 |

## 11. 网络与访问控制

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| HTTP 服务器 | ✅ | Node `http.createServer` |
| 带开关的局域网共享 | ✅ | 运行时状态存于 `settings.lanBroadcastEnabled`；对非本地 IP 默认关闭 |
| 局域网关闭时的友好 403 页面 | ✅ | `settings.js` 中的 `LAN_REJECT_HTML` 模板；v1.0.1：单个双语页面（zh + en 上下堆叠），动态 `PORT`（之前硬编码为 `7890`，在 v0.5 默认端口变更后失效） |
| 令牌认证（`?token=` 或 `Authorization: Bearer`） | ✅ | `server.js` 校验 `req.url` 与 `req.headers.authorization`；一旦设置，每个请求都必须携带令牌 |
| **令牌认证：默认开启（v1.0.1）** | ✅ | 首次启动且未设置 `TOKEN` 环境变量时自动生成一个 32 位十六进制令牌，持久化到 `~/.mcode-webui/settings.json`（权限 0600，通过 `.tmp` + rename 原子写入）。**v2.0.0（lease C08）**：令牌不再以 14 行 ASCII 方框打印到 stdout；改为向所有已连接标签页广播一个 `token.first_run` SSE 事件，并向 stdout 打印一行中性的 `token persisted to: <path>`（由 `MCODE_WEBUI_TOKEN_STDOUT=1` 门禁控制）。设置卡片会一直显示令牌，直到操作者点击 "我已保存 / I have saved it"。`MCODE_WEBUI_SETTINGS_PATH` 环境变量可覆盖文件位置。`TOKEN` 环境变量仍然优先（逃生通道）。 |
| **令牌认证：重置 + 实时广播（v1.0.1）** | ✅ | "重置 token" 按钮生成新的 32 位十六进制值，持久化，并广播携带新令牌的 `auth.token_rotated` SSE 事件。每个已连接客户端**就地**更新其 `localStorage` 和当前 `HEADERS.Authorization` 对象——后续 `fetch()` 调用自动使用新令牌，无需重新加载。崩溃安全：先写磁盘，仅在成功后才提交内存状态。 |
| **令牌认证：确认状态机（v1.0.1）** | ✅ | 点击 "我已保存" 后，服务器记录 `tokenAcknowledged=true`，并在后续的 `GET /api/settings` 响应与 SSE 状态推送中不再包含 `currentToken`。UI 将令牌值/掩码行替换为 `✓ 已保存 — 查看请点"重置" / Saved — click "Reset" to view again` 占位符。重置会触发新一轮轮换。跨重启持久化。 |
| **令牌认证：设置持久化（v1.0.1）** | ✅ | 令牌 + readOnly + tokenEnabled + tokenAcknowledged + tokenRotatedAt + allowedInterfaces（空操作占位）全部持久化到 `~/.mcode-webui/settings.json`。`lanBroadcast` 仍只保存在内存中（有意为之——重启后重新启用局域网，避免管理员把自己锁在门外）。 |
| 只读模式（v1.0.1） | ✅ | 开启后，非本地的对 `/api/*` 的 `POST` / `DELETE` 返回 `403 {"error": "read-only mode"}`。`GET` / `HEAD` / `OPTIONS` 豁免。本地请求始终豁免。`/api/settings` 豁免（逃生通道）。已持久化。开启时顶栏显示红色脉动的 "只读 / READ ONLY" 徽标。 |
| 按 cid 划分的 SSE 通道 | ✅ | 每个浏览器标签页一个 EventSource；每个 cid 一个 mcode 子进程 |
| HTTPS | ⚠ | v2.0.0（lease C03）——HTTPS 本身需要反向代理；已在 `docs/HTTPS-REVERSE-PROXY.md`（387 行，含 nginx / caddy / Traefik 2 配置及 SSE 长连接注意事项）中**完整记录**。webui 无代码改动。 |
| mTLS / 客户端证书 | ❌ | 同上；文档见 `docs/HTTPS-REVERSE-PROXY.md` |
| 速率限制 | ✅ | v2.0.0（lease C03）：`server/lib/rate-limit.js`（252 行）——按 IP 的令牌桶，默认 60 次/分钟 + 100 突发容量 + 令牌持有者 2× 倍率。路由器门禁 4 在超限时返回 429。`lib-rate-limit.test.js`（339 行，21 个单元测试）。 |
| 凭据文件预览守卫（slice 16） | ✅ | 按文件名匹配 `.env`/`.env.*`/`*.pem`/`*.key`/`id_*` SSH 密钥/`known_hosts`/`authorized_keys`/`.npmrc`/`.pypirc`/`.netrc`/`.pgpass`/`credentials*` 及备份后缀集，`GET /api/fs/read-file` 默认 `403 {code:"credential"}`，加 `?confirm=1` 才放行。谓词（`server/lib/credential-file.js`）与 `webapp/lib/credential-file.ts` 逐字镜像、同夹具测试防漂移；`GET /api/fs/search` 复用同谓词、命中以 `credential:true` 标记但不返回内容；slice 27 扩到写侧（`POST /api/fs/write` 同样默认拒绝）。按名匹配因此**不防硬链接别名**（同 inode 的另一名字绕过），符号链接已用 `realpathSync` 解析。 |

## 12. Git 面板

| 功能 | 状态 | 原因 / 位置 |
|---|---|---|
| 工作区状态（`git status --porcelain=v1 -b`） | ✅ | `GET /api/git/status` —— `server/lib/git.js#gitStatus`。返回当前分支 + 上游分支 + 领先/落后提交数，以及每个文件的 `{x, y, path, origPath, staged}`。非 git 目录应答 `{ok:false, isRepo:false}`，面板据此渲染空状态，而不是弹一条红色 toast。 |
| 本地分支列表 + 当前分支标记 | ✅ | `GET /api/git/branches` —— `server/lib/git.js#gitBranches`。执行 `branch --list --format=%(refname:short)`；行首的 `* `（`--list` 默认标记当前分支的记号）转成 `current` 标志。 |
| 单文件与 HEAD 的差异 | ✅ | `GET /api/git/diff?dir=&file=` —— `server/lib/git.js#gitDiff`。先试 `git diff HEAD -- <file>`；未跟踪文件在 HEAD 中没有条目、这条路查不出差异，于是回退到 `git diff --no-index -- /dev/null <file>` 合成一份全新增差异。`--` 分隔符是选项注入的边界：用户提供的路径永远在它之后，因此只能被当作路径，不能被当作 git 选项。 |
| 切换分支（破坏性操作，客户端二次确认） | ✅ | `POST /api/git/checkout {dir, branch}` —— `server/lib/git.js#gitCheckout`。分支名须匹配 `^[A-Za-z0-9._/-]+$` 且不得以 `-` 开头（否则 git 会把它读成自己的选项）；围栏强制把 `dir` 约束在允许的根目录内；`execFile` 让 `git` 的每个 argv 元素保持字面量。 |
| 右侧面板的 Git 面（`GitPanel`） | ✅ | `webapp/components/panels.tsx#GitPanel`（slice 03）。当前分支 + 变更文件列表，点击文件可预览差异；带确认提示的分支切换器；非 git 或超出允许根的目录显示空状态。围栏在服务端执行，面板只读响应里的 `ok`：`ok:false` 走空状态，不弹红色 toast。 |
| `/review` 斜杠命令（对齐 TUI） | ✅ | `server/lib/interaction/commands.js#bodyReview` + `handleLocalSlash` / `handleCmdCommand`。向聊天中发出一条 `staged / unstaged / untracked` 三段概览，数据来自与 Git 面板共用的 `gitStatus` 辅助函数——两处看到的是同一份状态。 |
| 与 `/api/fs/*` 共用的围栏 | ✅ | `assertWorkspacePath`（`server/lib/workspace.js`）。每个 git 入口都把请求的 `dir` 交由它校验；越界时应答 `{ok:false, error:"…不在任何允许根内…"}`，面板读 `ok` 字段而非 HTTP 状态码。与文件系统路由同一道围栏，因此绕过其中一个也就绕过了另一个——不存在只在 git 侧收紧的路径。 |
| execFile，不走 shell | ✅ | `lib/git.js` 中的 `run(dir, args)` 使用 `execFile('git', ['-C', dir, ...args], …)`，每个 argv 元素都是子进程的字面量参数。不经过 shell，就没有元字符攻击面。 |
| 本地分支白名单（正则 + 前导连字符防护） | ✅ | `gitCheckout` 中的 `BRANCH_RE` 与 `branch.startsWith('-')`。面板只列出服务端 `/api/git/branches` 返回的分支；服务端白名单是纵深防御——即使请求被伪造绕过前端，服务端仍会拒绝。 |

## 13. 运维

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

## 14. 要启用 ❌ 行，mcode 需要增加什么

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

这些是向上游提出的需求。历史目标 / 计划 / 状态清单与 mcode 团队的
回应留在一份内部文档里，而它不属于本公开投影，因此上面这份列表就是
此处能读到的全部。
