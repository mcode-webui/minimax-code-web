# 把 Web UI 迁到 antd v5

> 状态：进行中。Phase 0（依赖边界）、Phase 0.1（账号菜单面板，按桌面端自身的结构重做）、
> Phase 2（composer 的两个选择器）与 Phase 3a（阻塞型提示弹窗）已完成并验证；下面的阶段
> 是其余工作的既定顺序。

## 为什么

桌面端就是 **antd v5**（紧凑界面用 antd-mobile），外面套一层 `mavis-*` 皮肤——这是实测结论，不是推测：`DESKTOP-ARCHITECTURE.md` §2 记录了从其 renderer chunk 中提取的 283 个 `.ant-*` 类以及 JS 里的 `cssinjs` / `colorPrimary` 标记；`DESIGN.md` 把桌面端自己的类名映射到组件上（`mavis-button` → antd `Button`、`mavis-dropdown` → antd `Dropdown`、`mavis-modal-wrap` → antd `Modal`、`mavis-select` → antd `Select` …）。

而本前端把 antd 的**行为**手写了一遍。至今发现的交互缺陷全部落在这一半：

- 账号二级菜单在指针刚移向面板的同一帧就被关闭；
- 用量悬浮卡是 portal，于是它内部的 mousedown 先把账号菜单关掉、按钮在 click 派发前就卸载了；
- 二级菜单 flyout 从错误的一边计算位置，展开到屏幕外。

这些都不是样式缺口，而是 hover / portal / 焦点 / 定位这些 antd 本来就拥有的语义，被手写重推、再逐个写坏。接上桌面端已在用的库，等于整类消除，而不是逐个再修一遍。

## 不变量

迁移期间以下不变：

1. **每个 `data-testid` 继续可用**（当前 66 个）。它们是测试断言的行为契约；换组件时改名会静默丢掉覆盖。
2. **HTTP/SSE 契约不动。** `webapp/lib/api.ts` 与服务端路由不在范围内。
3. **布局继续用 Tailwind**，antd 只作组件层。这正是桌面端的分工。
4. **不写全局 `.ant-*` 覆盖。** 主题走 `ConfigProvider` token，其次组件级 `classNames` / `styles`——antd 的优先级顺序。

## 版本：antd v5，不是 v6

`packages/webui` 把 `next 14.2.35`、`react 18.3.1`、`react-dom 18.3.1`、`tailwindcss 3.4.19` 精确钉在**桌面端实测的同版本**上，这是有意为之。已移植的 token 层与已移植的皮肤都是 v5 形状，React 18.3.1 也在 v5 支持区间内（不需要 React 19 的 patch）。v6 会把外观带离桌面端，而这正是本次迁移唯一的目的。

## Provider

`app/layout.tsx` 按此顺序加：

- `<AntdRegistry>`（来自 `@ant-design/nextjs-registry`）包住整棵树；
- 一个根 `<ConfigProvider theme={…}>`。

registry 不是可选项：应用是 `output: "export"`（由 `server.js` 服务的静态导出），而 v5 的样式是 CSS-in-JS——不做样式顺序注册，导出产物可能带着错误的层叠顺序水合。

**不设 `hashPriority`，这一条是关键。** antd 默认会把生成的 hash 类包进 `:where()`，桌面端运行时的输出因此是

```
:where(.css-hash).ant-dropdown .ant-dropdown-menu .ant-dropdown-menu-item
```

——有效特异性 3 个类。桌面端的 `mavis-*` 皮肤规则正好比它多一个类，于是无需 `!important` 就能赢。把优先级调高会去掉 `:where()`，antd 的规则变成 4 个类：与皮肤打平，改由文档顺序决定，而 antd 的样式表最后插入——antd 赢，皮肤静默失效。这一条是在**运行中的桌面端**上实测的；提取出的样式表对此什么也没说，因为那些文件是皮肤和 Tailwind，不是 antd 生成的 CSS。

## 主题

`webapp/lib/antd-theme.ts` 是桌面端自己的 `ConfigProvider` 主题对象，逐字转录自已发布的 `app.asar`（`out/_next/static/chunks/app/(pages)/(mavis)/layout-*.js`，MiniMax Code 3.0.67）。它不是重建的产物。

承重的那个决定：**它的 token 是 `var(--token)` 引用，不是十六进制字面量。** antd v5 的 cssinjs 会把 token 的值原样写进生成的声明，所以 `colorBorder: "var(--border_default)"` 产出 `border-color: var(--border_default)`。这让主题完全不需要明暗分支：

- `styles/tokens.css` 把每个被引用的变量定义了两遍——`:root` 一遍、`.dark` 一遍；
- `app/layout.tsx` 在首帧前跑一段阻塞脚本，把 `light` / `dark` 挂到 `<html>` 上，`lib/theme.ts` 之后再翻这个 class；
- 于是切换主题时，antd 的每个面都通过与 `mavis-*` 皮肤、Tailwind 工具类**同一条**层叠重新求值。

这里刻意**没有** `theme.darkAlgorithm`，也没有客户端的 `isDark` 状态。桌面端两者都没有——提取出的 bundle 里任何地方都不含 `darkAlgorithm` / `defaultAlgorithm` / `compactAlgorithm` 引用——而加上去只会把明暗决策在 JS 里重复一份、还要自带首帧防闪逻辑，毫无收益。

有两个全局 token 被钉死，因为 antd 本来会在 JS 里从 `colorPrimary` 推导它们（`colorPrimaryHover`、`colorPrimaryBorderHover`）；桌面端把两者都钉到 `var(--border_heavy)`，这里照做。`colorPrimary` 这个 **seed** 保持不动，正如桌面端不动它——改 seed 会重新着色桌面端刻意保留原样的推导色阶。

组件 token 覆盖 `Segmented`、`Switch`、`Form`、`Radio`、`Input`、`Select`、`Popover`。实测效果，全程不涉及任何手写 CSS：

| 面 | antd 规则 | 求值结果（亮 → 暗） |
| --- | --- | --- |
| `Switch`（未选中） | `background: var(--bg_interaction_tertiary_press)` | `rgba(10,10,10,.08)` → `rgba(255,255,255,.07)` |
| `Switch`（选中） | `background: var(--icon_interaction_accent_accent)` | `#0094fc` → `#0077d9` |
| `Input` 边框 | `border-color: var(--border_default)` | `#0a0a0a14` → `#ffffff12` |
| `Input` hover/focus | `border-color: var(--border_heavy)` | 跟随 token 层 |
| `Popover` 表面 | `background-color: var(--bg_grouped_secondary_elevated)` | 跟随 token 层 |

Switch 的几何尺寸同样来自这份主题（`trackHeight: 16`、`trackMinWidth: 28`、`handleSize: 12`），而不是本地覆盖：桌面端**根本没有** `.mavis-switch` 这个类。本前端早先版本自己加过一个（36×20 轨道、灰阶填充），那是**错的**——它悄悄覆盖掉了桌面端的强调色开关。该文件已删除；`styles/mavis-dropdown.css` 是唯一一份移植皮肤，存在的理由是桌面端 bundle 里的那些规则挂在本前端必须复现的类名之下。

## 皮肤

`webapp/styles/official-utilities.css` 是桌面端自己的工具层——语义字号阶梯、markdown 呈现，以及**皮肤覆盖**。它不是 antd 的基础 CSS，也不是让 antd 组件长得对的原因：

- 它提到 `.ant-*` 类的规则有 91 条，其中 86 条挂在某个 `.mavis-*` 祖先下（`mavis-checkbox`、`mavis-select-popup` …），另外 5 条挂在 `.stock-auth-modal-wrap` 下。文件里**没有**一条裸 `.ant-*` 规则。
- 它完全没有 `mavis-user-dropdown` / `mavis-user-menu-*` 规则，所以它是一份**局部**提取：某个面的皮肤只有在某个已移植界面需要它之后才会出现在里面。

`.mavis-input` 与 `.mavis-segmented` 就在这个文件里，且与桌面端自身规则逐字节一致（已对照提取出的 bundle 核验过），所以组件只要带上类名即可。`.mavis-dropdown` 则必须移植：桌面端把它放在本前端不得不复现的类名下，而规则不在工具层里。

由此有两条结论值得写明，因为本文件的早先版本两条都说错了：

1. 那些 `.ant-*` 块只在我们复现了祖先类名的地方才作用于我们的组件。它们是皮肤，不是层叠，因此删掉其中一条本身并不会改变组件的渲染结果。
2. 当某个面确实需要桌面端的皮肤时，做法是**移植**：把规则抄进组件旁边的文件，并让 JSX 带上桌面端同款类名。`styles/mavis-dropdown.css` 是第一份——账号菜单的面板、行与用量悬浮卡，外加 composer 选择器需要的 `mavis-dropdown-custom-content` 包装（正是它让 antd 的 `Dropdown` 不再画自己的卡片，好让里面的面板自己画）。其来源 chunk 与实测数值都记在文件头。

## 组件映射

| 面 | 现状 | 目标 |
| --- | --- | --- |
| 账号菜单（触发器 + 行） | 绝对定位 `div` + `MenuRow` | `Dropdown` + `Menu` — 已完成（Phase 0 / 0.1） |
| 用量悬浮卡 | 手写 portal + hover 区域 | `Popover`（hover） — 已完成（Phase 0 / 0.1） |
| 二级菜单（联系我们 / 了解更多） | 手写 flyout | `Menu` 子菜单——当前已移除，有真实目标时再以 `Menu` 加回 |
| composer 权限 / 模型选择器 | 手写下拉 + `Menu` | `Dropdown` — 已完成（Phase 2） |
| 附件按钮 | 直接开文件选择框 | **未转换** — 见 Phase 2 |
| 权限 / ask / plan 弹窗 | 手写 dialog | `Modal` — 已完成（Phase 3a） |
| 右侧拓展区 | 手写面板 | `Drawer` |
| 上下文计量 | 手写进度条 | `Progress` |
| 设置卡片控件 | 手写输入 | `Input`、`Checkbox`、`Switch` |
| 会话树 | 手写嵌套列表 | `Tree`（或虚拟列表） |
| 告警 / 站内信行 | 手写列表 | `List` |
| 轻提示 | `ActionErrorBanner` | `message` / `notification` |

## 阶段

每个阶段是一个可评审单元：替换手写代码、保留 testid、该面需要皮肤就移植皮肤、验证。

- **Phase 0 — 证明边界（已完成）**：加依赖与 registry、挂 provider、把账号菜单整面换成 antd。验证结果：静态导出构建通过；浏览器控制台 0 报错/告警（无样式错序、无水合问题）；菜单渲染出 5 个 item（2 项 disabled、1 项是分隔线）；Escape 与外部点击都由 antd 正确关闭；用量悬浮卡 hover 展开、在视口内、两行配额齐全。**自己那 30 行外部点击监听器与 80 行 hover/定位代码被删除。**

  两条值得留存的实现说明：`MenuProps` 不接受任意属性，所以 `sidebar-user-menu` 这个 testid 是用 `popupRender` 挂上去的；antd 不会给 `div` 子节点写 `aria-expanded`，所以触发器仍然自己设置它（以及 `aria-haspopup`）。

- **Phase 0.1 — 面板要用桌面端本身，而不是近似（已完成）**：行结构搬到桌面端的骨架上——antd 拥有那个 `li`（padding 归零、8px 圆角、hover、focus、disabled），行自己带 `.matrix-menu-item`、提供内边距的 `p-1.5`、18px 的 `mavis-user-menu-icon` 盒子，以及 `matrix-menu-item` 的 flex 形态。分隔线改成「disabled item 包住桌面端那根细线」，而不是 antd 自己的 `type: "divider"`；用量行改成按桌面端 placement 与延迟配置的 `Popover`；悬浮卡的两行改成桌面端的双行形态（标签 + 已用百分比，下面一行重置时间），并**删掉了手写进度条**——桌面端根本不画进度条。全部数值都是对着**运行中的客户端**核的，不是对着截图：面板 244 宽 / 4px 内边距 / 12px 圆角 / `0 0 10px 0` 阴影，item 高 32px、padding 与 margin 均为 0、圆角 8px，行内边距 6px，图标盒子 18px，分隔线高 8px、内边距 `0 8px`，悬浮卡宽 222、inner 内边距 4px、圆角 12px、阴影 `0 0 20px 0`。

- **Phase 1 — 账号区域收尾**：联系我们 / 了解更多在有真实目标时以 `Menu` 子菜单加回；子菜单的皮肤已经移植好了。
- **Phase 2 — composer 的两个选择器（已完成）**：两个选择器都搬到 `Dropdown` 上，它们共用的那套约 90 行手写弹层被删除——portal、fixed 定位、视口夹取、外部点击与 Escape 监听、滚动/改变尺寸时重定位，全都是在重推库本来就拥有的东西。计划里写的是 `Select`，但桌面端用的是 `Dropdown`：它的 composer 弹层是 `mavis-dropdown-custom-content`——一个透明的 antd 包装，里面那层面板自己画外观——而且它的行是普通按钮而不是 `Menu` item。所以面板按自定义内容移植，只有外壳来自 antd。

  在运行中的客户端上核对：触发器 124×32、内边距 `0 8px`、gap 4px、圆角 10px、字号 14/20；菜单展开时箭头翻转向上（桌面端两种状态都实测过）；包装层解析结果为透明、无边框、无阴影、`overflow: visible`；面板宽 160、内边距 4px、圆角 12px、抬升背景、1px `--border_default` 细线与 `0 0 20px 0` 阴影；行高 28px、内边距 `4px 8px`、gap 8px、圆角 8px；选中行的勾固定占 14px 尾槽。面板需要而 `icons.tsx` 里没有的三个字形，按客户端自身的路径补齐（`permissionAsk`、`permissionAuto`、`checkSmall`，以及 `chevronUp`）。

  **附件按钮保持原样**，这是决定而非遗漏。它在桌面端确实是 antd 下拉的触发器，但它打开的是七个条目的产品面——添加文件或图片、技能（含技能列表）、插件（含插件列表）、目标模式、计划模式、电脑操控、浏览器操控。本服务端一个都背不了，所以转换触发器等于「用一次多余的点击，换一个七个条目里只有一条可用的菜单」，然后称之为对齐。写在这里，免得下一个人把它当 bug 重新发现一遍。它的**几何**已对齐（`w-8 h-8`，32px），因为那是可实测的。
- **Phase 3a — 阻塞型提示弹窗（已完成）**：plan / ask / 授权三个弹窗搬到 `Modal` 上，套桌面端那套**已经逐字移植进** `official-utilities.css` 的确认弹窗皮肤。用真实渲染核对：遮罩 `rgba(0,0,0,.25)`（`#00000040`）内边距 10px；面板 520×240、圆角 20px、无边框、阴影 `rgba(10,10,10,.5) 0 0 48px -12px`；无关闭按钮、无 footer；meta 槽显示 `1/2`。「不可关闭」是按行为验的，不是看代码：按 Escape 不关，真实点击背景也不关。

  过程中有两处**只有渲染才能发现**的修正，都值得留下：

  1. **antd 自己的面是浅色的。** 标题栏渲染成一条白底白字，压在桌面端的深色面板上——因为标题栏用的是 antd 的 `colorBgElevated`，而桌面端的主题对象并没有配置 `Modal`。（桌面端不需要配置：它自己的 `mavis-confirm-modal-compact` 皮肤已经带上 `background: var(--bg_grouped_secondary_elevated)`，标题栏由同一份文件覆盖。）本前端已移植该皮肤，所以等价的修法是本地的 `styles={{ header: { background: "transparent" } }}`。之后做 token 化**并没有**改变这一点：主题没点名的 token 仍然是 antd 默认值，而 `Modal` 不在桌面端主题化的组件之列。将来若某个面需要桌面端自身没有主题化的深色 antd 表面，那属于一处必须如实记录的分歧，而不是可以用 `darkAlgorithm` 盖过去的东西。
  2. **Tailwind 工具类打不过 antd。** `bg-transparent` 没生效：它只有 1 个类，而 antd 的规则是 `:where(.css-hash).ant-modal .ant-modal-header`——因为 `hashPriority` 是低，所以有效特异性是 2 个类。这正是让移植皮肤取胜的同一条层叠事实，只是换了一面：要覆盖就用 `styles`、或 antd 没自己上色的槽位 `classNames`、或组件 token，永远不要用工具类。

  怎么渲染出来的，对下一阶段很重要：这些提示由引擎驱动，所以用了 `POST /api/debug/inject`（`DEBUG_INJECT=1`，文档写明用途是"注入 state 给浏览器测 UI 渲染"）把 `state.ask` 灌进真实 store、渲染真实组件。这是所有引擎驱动界面的可达验证路径。
- **Phase 3 — 会话周边的面。已完成，且其中一条前提是错的。** 设置里的 `Input` / `Switch` / `Segmented` 已完成：它们吃桌面端自己的主题 token，而 `Input` 与 `Segmented` 还吃桌面端自己的 `.mavis-*` 规则（逐字节一致，已对照 bundle 核验）。本前端自己写的 `Switch` 皮肤已删除——见「主题」一节。
  `Drawer` 那一半没能通过对照 bundle 的检验。桌面端**没有** antd `Drawer`：整个提取出的 `out/_next/static` 里 `ant-drawer` 与 `rc-drawer` 出现次数为零，任何样式表里也没有 `.mavis-drawer` 规则。它有的是一个自制的可拖拽面板——`file-panel-sidebar`、`file-panel-sidebar-drag-handle`、`file-panel-sidebar-toggle`——外加自己的 `Drawer` **状态机**枚举（`Did(Close|Open)|Will(Close|Open)`），那是动效原语，不是 antd。所以从来就没有组件可移植；「换 `Drawer`」是读参考资料之前就写下的计划项。`panels.tsx` 现有的 `<aside>` 加宽度过渡更贴近桌面端，保持不变。
- **Phase 4 — 列表。部分完成，且部分不该做。** 告警列表的空态已迁到 antd `Empty`（完成）。会话树与面板表格**不应**迁到 antd `Tree` / `Table`，理由只有 bundle 才说得清：桌面端的文件树是虚拟化的——`changed-files-tree-virtual-canvas` / `changed-files-tree-virtual-row` 跑在 `changed-files-tree-scroll` 视口上。antd `Tree` 同样不虚拟化，所以迁过去既丢掉桌面端的结构、又丢掉它的伸缩行为。面板表格同理：桌面端的右侧区是带标签页的文件面板（`file-panel-add-tab-menu`、`file-panel-sidebar`），不是表格。
  这里暴露出的真正缺口是**虚拟化**，而不是「改用 antd」：`session-tree.tsx` 会即时渲染每一个项目、目录、会话与子代理。`chat-virtual-list.tsx` 已经是转录的同类实现，所以模式在仓库里现成；把它接到侧栏树上是真有收益的实活，而不是一次组件库迁移。
- **右侧区的标签页集合——以及两个根本打不开的面。** 一次界面走查发现：`PanelKind` 声明了 6 种，`RightPanel` 也把 6 种都渲染了，但只有 4 种可达：应用里每一处 `openPanel(...)` 传的都是 `workspace`、`files`、`search` 或 `plugins`，而铃铛打开的是 inbox 悬浮卡、不是 `alerts` 面板。于是 `alerts` 与 `progress` 是发布产物里的死面。
  它们同时也没有可移植的对应物。桌面端的右侧区是一个带标签页的**文件**面板，其注册表恰好四项——`changes`、`terminal`、`browser`、`files`，每项都按 capability 门控（从 bundle 的标签列表里提取）。那里既没有进度标签，也没有告警标签。`ProgressPanel` 早先的注释声称上游把它渲染为「右侧边缘的 `进度` 标签页」；那是读参考资料之前写的，是假的。注释现在如实写出，并说明桌面端右侧区实际包含什么。
  选择保留而不是删除：其内容由本应用已有的 state 组装，接上一个入口只是一行改动。但它们不是移植过来的面，且 `ProgressPanel` 展示的是「近期告警 + 当前运行」，而不是上游的时间线——它类似的活动流位于回合检视器的 `activity-group-*` 区域，而 webui 没有那个入口。

## 依赖流程

1. `pnpm --filter @mavis/webui add -D antd@5.29.3 @ant-design/nextjs-registry@1.3.0`（放 devDependencies：webapp 编译进静态导出，服务端运行时不 import 它们）。
2. 重生成 `release/dependency-licenses.json`（其 `generatedFrom` 为 `pnpm licenses list --json`），并在 `THIRD_PARTY_NOTICES.md` 记一笔。lockfile 是公开的，它记录的每个依赖都会被发布。
3. 关卡：`pnpm verify`。`check:webui-bundle` 守的是**服务端** bundle，会拒绝未声明的 external，所以 antd 必须留在它外面。

## 风险

- **体积。** antd 带来 `rc-*` 树、`@ant-design/cssinjs` 与 `dayjs`。逐阶段实测：`/` 65.3 kB → **139 kB**（Phase 0）→ 140 kB（0.1）→ 141 kB（Phase 2）→ **157 kB**（Phase 3a，First Load JS 258 → 274 kB）。Phase 2 那部分主要是字形（权限面板那只手是单条约 3 kB 的路径）；Phase 3a 的 16 kB 是 `Modal` 及其背后的 `rc-dialog` / `rc-motion`。为对齐而接受，但每阶段都要复测——一个弹窗外壳值 16 kB，在 Phase 3 的 `Drawer` 与 `Progress` 落地之前值得先知道。
- **层叠是一场三方竞争。** antd 生成的 CSS、桌面端移植的皮肤、Tailwind 都指向这些元素。皮肤靠「多一个类」取胜——而这只在 `hashPriority` 保持默认时成立。改掉它皮肤会静默失效且不报错，所以上面那条实测值是被记录下来的，而不是被假定的。
- **水合。** v5 + App Router 的经典坑是样式顺序。registry 解决它；每个阶段仍必须检查控制台。
- **外观漂移。** 桌面端的 `mavis-*` 类是皮肤，所以某个组件换完之后长得不一样时，修法按顺序是：组件 token、`classNames` 属性，或者——当桌面端把差异表达成皮肤而不是 token 时——把那个面的 `mavis-*` 规则移植到组件旁边。永远不是全局 `.ant-*` 覆盖。
