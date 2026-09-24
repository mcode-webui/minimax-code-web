/**
 * test/ui/fixtures.ts —— ui 组件测试共用的数据夹具（仅依赖 contracts/domain 类型）。
 * 每个工厂都接受 Partial 覆盖，保证测试只写出与被测行为相关的字段。
 */
import type {
  AskUserBlock,
  ChatMessage,
  ErrorBlock,
  ModelOption,
  PlanBlock,
  ProviderOption,
  SessionSummary,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultBlock,
} from '../../src/contracts/domain';

export function sessionSummary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    title: '会话一',
    workspace: '/w1',
    mcodeSessionId: null,
    titleCustom: false,
    updatedAt: 1,
    ...over,
  };
}

export function providerOption(over: Partial<ProviderOption> = {}): ProviderOption {
  return { id: 'minimax_api', label: 'MiniMax', ...over };
}

export function modelOption(over: Partial<ModelOption> = {}): ModelOption {
  return { id: 'minimax_api/MiniMax-M3', label: 'MiniMax-M3', provider: 'minimax_api', ...over };
}

export function textBlock(over: Partial<TextBlock> = {}): TextBlock {
  return { id: 'b-text', kind: 'text', text: '你好', ...over };
}

export function thinkingBlock(over: Partial<ThinkingBlock> = {}): ThinkingBlock {
  return { id: 'b-think', kind: 'thinking', text: '思考中', ...over };
}

export function toolCallBlock(over: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return { id: 'b-tc', kind: 'tool-call', toolName: 'bash', status: 'running', ...over };
}

export function toolResultBlock(over: Partial<ToolResultBlock> = {}): ToolResultBlock {
  return { id: 'b-tr', kind: 'tool-result', ok: true, text: '输出', ...over };
}

export function planBlock(over: Partial<PlanBlock> = {}): PlanBlock {
  return { id: 'b-plan', kind: 'plan', title: '计划', steps: ['一步', '二步'], status: 'pending', ...over };
}

export function askUserBlock(over: Partial<AskUserBlock> = {}): AskUserBlock {
  return {
    id: 'b-ask',
    kind: 'ask-user',
    question: '选哪个？',
    options: [{ id: 'o1', label: '甲' }, { id: 'o2', label: '乙' }],
    multiSelect: false,
    ...over,
  };
}

export function errorBlock(over: Partial<ErrorBlock> = {}): ErrorBlock {
  return { id: 'b-err', kind: 'error', text: '炸了', ...over };
}

export function chatMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'assistant', blocks: [textBlock()], ts: 1, ...over };
}
