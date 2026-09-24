# @mavis/webui-react

MiniMax Code Web UI 的 **React + Ant Design** 重写版：1:1 复刻 `packages/webui/public` 的 vanilla 单页 UI，
并按 **高内聚低耦合 / 热插拔易迭代** 的分层重构，解决原实现的两大痛点：模块化不足、会话隔离显示不可靠。

## 为什么重写

| 痛点 | 原实现 | 本实现 |
| --- | --- | --- |
| 模块化 | 单页 + 全局可变 `state`，`render.js` / `events.js` / `state.js` 三方循环 import | 四层单向依赖，模块之间只通过 `contracts/` 的接口咬合 |
| 会话隔离显示 | 所有会话共享一份 `chat` / `model` / `context`，切会话互相串扰 | 每个 `SessionId` 一份 `SessionSlice`，消息/流式/上下文/模型选择互不串扰 |
| 供应商 / 模型 / 思考强度 | 模型按钮被 `hidden`（`session/set_config_option` 未实现） | 三段式选择器，按会话独立保存，经 `ModelServicePort` 可热插拔换供应商 |

## 分层

依赖方向严格单向，**只有 `features/` 允许同时看见 core 与 ui**：

```
  ui/        哑组件（props 进 / 事件出，零业务、零 IO、零 antd 之外的依赖）
     │
     ▼
  features/  咬合枢纽：把端口翻译成快照 + 动作（app-controller.ts）
     │
     ▼
  core/      端口实现（transport / services / store），零 UI 依赖
     │
     ▼
  contracts/ 唯一咬合面：protocol.ts（线上格式）+ domain.ts（领域对象）+ ports.ts（接口）
```

| 目录 | 职责 | 换掉它需要动什么 |
| --- | --- | --- |
| `src/contracts/` | 线上格式、领域对象、端口接口 | 改契约 = 改 API，其他层随之编译报错提示 |
| `src/core/transport/` | HTTP / WebSocket / token / cid | 只换这两个文件（例如换成 fetch mock 或 SSE） |
| `src/core/services/` | 每个领域服务一个文件，实现对应 Port | 换供应商 = 换 `model-service.ts`，其余无感 |
| `src/core/store/` | 极简可观察 store（零依赖） | 可整体换成 zustand / Redux，签名已对齐 |
| `src/ui/` | 哑组件 + 同目录同名 `.css` | 换 antd 大版本或换视觉，只动这层 |
| `src/features/` | 编排：`app-controller.ts` + React 绑定 | 业务变更只动这层 |

## 热插拔

所有端口经组装根注入，不许自己 `new`：

```ts
import { createRegistry, replacePort } from './core/registry';

const registry = createRegistry();                    // 生产：默认实现
const testRegistry = createRegistry({ http: fakeHttp }); // 测试：注入 fake
replacePort('models', myProviderService);             // 运行期：换供应商
```

## 会话隔离

`contracts/domain.ts` 的 `SessionSlice` 是隔离的结构保证：

```ts
interface SessionSlice {
  id: SessionId;
  messages: ChatMessage[];   // 每会话独立消息流
  inflightId: string | null; // 每会话独立的流式缓冲
  running: boolean;
  selection: ModelSelection; // 每会话独立的 供应商/模型/思考强度
  context: ContextUsage | null;
  workspace: WorkspaceInfo | null;
  todos: TodoItem[];
  goal: GoalState | null;
  attachments: Attachment[];
}
```

`SessionServicePort.slice(id)` 按 id 取（必要时创建）切片；`subscribe(id, fn)` 只订阅该会话。
控制器切换会话时**不清理**旧切片，回来时内容原样还在。

## 供应商 / 模型 / 思考强度

`ui/composer/ModelPicker.tsx` 是三段式选择器（供应商 → 模型 → 思考强度五档 off/low/medium/high/max），
数据全部经 `ModelServicePort`，因此换供应商实现只需 `replacePort('models', ...)`。
每个 `SessionSlice.selection` 独立保存，切会话后选择随之切换。

## 开发

```bash
pnpm install
pnpm --filter @mavis/webui-react dev      # http://127.0.0.1:5180/react/，代理到 127.0.0.1:18090
pnpm --filter @mavis/webui-react test     # vitest（jsdom）
pnpm --filter @mavis/webui-react build    # 产物到 ../webui/public/react/，由现有 webui server 直接托管
```

dev 代理目标可用 `WEBUI_TARGET` 覆盖。构建产物落在 `packages/webui/public/react/`，
现有 webui server 的静态托管无需任何改动即可提供新 UI。

## 测试

| 测试 | 验证什么 |
| --- | --- |
| `test/domain.test.ts` | 分组排序、模型 id 拆分、切片构造、不可信 wire 归一化 |
| `test/app-controller.test.ts` | **会话隔离**（切换不串扰、按会话独立保存选择）、**热插拔**（换供应商实现不动其他端口） |
