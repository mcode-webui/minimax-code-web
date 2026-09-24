// 覆盖契约点：ui/chat —— BlockView 按 block.kind 分发到七种块视图（text/thinking/tool-call/tool-result/plan/ask-user/error）、
// 未知 kind 走 JSON 兜底不崩（向前兼容）、MessageItem/BlockView 块级 memo 生效（长列表流式重渲染只重算变化块）。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage, MessageBlock, TextBlock } from '../../src/contracts/domain';
import { BlockView } from '../../src/ui/chat/blocks';
import { MessageItem } from '../../src/ui/chat/MessageItem';
import { MessageList } from '../../src/ui/chat/MessageList';
import {
  askUserBlock,
  chatMessage,
  errorBlock,
  planBlock,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolResultBlock,
} from './fixtures';

describe('BlockView 按 kind 分发', () => {
  it('text → Markdown 文本渲染', () => {
    render(<BlockView block={textBlock({ text: '你好 **世界**' })} />);
    expect(screen.getByText('世界')).toBeInTheDocument();
    expect(screen.getByText('世界').tagName).toBe('STRONG');
  });

  it('thinking → 默认折叠，点开后 5 行预览，可展开全文', () => {
    render(<BlockView block={thinkingBlock({ text: '推理内容', done: true })} />);
    expect(screen.getByText('思考过程')).toBeInTheDocument();
    // 默认折叠：正文不可见
    expect(screen.queryByText('推理内容')).not.toBeInTheDocument();
    // 点标题 → 5 行预览（capped）
    fireEvent.click(screen.getByText('思考过程'));
    const body = screen.getByText('推理内容');
    expect(body).toHaveClass('blk-thinking-capped');
    // 展开全部 → 全文（去掉 cap）；收起 → 回预览
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    expect(screen.getByText('推理内容')).not.toHaveClass('blk-thinking-capped');
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.getByText('推理内容')).toHaveClass('blk-thinking-capped');
    // 再点标题 → 回折叠
    fireEvent.click(screen.getByText('思考过程'));
    expect(screen.queryByText('推理内容')).not.toBeInTheDocument();
  });

  it('tool-call → 工具名 + 状态徽标', () => {
    render(<BlockView block={toolCallBlock({ toolName: 'bash', status: 'running' })} />);
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('tool-result → 输出块 + done 状态', () => {
    render(<BlockView block={toolResultBlock({ text: '命令输出', ok: true })} />);
    expect(screen.getByText('result')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByText('命令输出')).toBeInTheDocument();
  });

  it('plan → 标题 + 步骤 + 状态', () => {
    render(<BlockView block={planBlock({ title: '施工计划', steps: ['甲', '乙'], status: 'pending' })} />);
    expect(screen.getByText('施工计划')).toBeInTheDocument();
    expect(screen.getByText('甲')).toBeInTheDocument();
    expect(screen.getByText('乙')).toBeInTheDocument();
    expect(screen.getByText('待确认')).toBeInTheDocument();
  });

  it('ask-user → 问题 + 选项，点击选项上抛 onAskToggleOption', () => {
    const onToggleOption = vi.fn();
    render(
      <BlockView
        block={askUserBlock({ question: '选哪个？' })}
        onAskToggleOption={onToggleOption}
        onAskConfirm={() => {}}
      />,
    );
    expect(screen.getByText('需要你回答')).toBeInTheDocument();
    expect(screen.getByText('选哪个？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /甲/ }));
    expect(onToggleOption).toHaveBeenCalledWith('o1');
  });

  it('error → 错误文本', () => {
    render(<BlockView block={errorBlock({ text: '炸了' })} />);
    expect(screen.getByText('错误')).toBeInTheDocument();
    expect(screen.getByText('炸了')).toBeInTheDocument();
  });
});

describe('未知块兜底（向前兼容）', () => {
  it('未登记的 kind 渲染 JSON 兜底而不崩', () => {
    const future = { id: 'b-x', kind: 'future-kind', data: 42 } as unknown as MessageBlock;
    expect(() => render(<BlockView block={future} />)).not.toThrow();
    expect(screen.getByText('未知消息块')).toBeInTheDocument();
    expect(screen.getByText(/future-kind/)).toBeInTheDocument();
  });
});

describe('块级 memo 生效（长列表性能契约）', () => {
  /** 读计数的 text 块：TextBlockView 渲染时读 block.text，用于探测块是否被重渲染。 */
  function trackedTextBlock(counter: { reads: number }): TextBlock {
    return {
      id: 'tb',
      kind: 'text',
      get text() {
        counter.reads += 1;
        return '追踪内容';
      },
    };
  }

  /** 读计数的 message：MessageItem 渲染时读 message.blocks。 */
  function trackedMessage(counter: { reads: number }): ChatMessage {
    return {
      id: 'tm',
      role: 'assistant',
      ts: 1,
      get blocks() {
        counter.reads += 1;
        return [textBlock()];
      },
    };
  }

  it('MessageItem 是 memo 组件，同 props 引用不重渲染', () => {
    const counter = { reads: 0 };
    const message = trackedMessage(counter);
    const { rerender } = render(<MessageList messages={[message]} streaming={false} />);
    expect(counter.reads).toBe(1);

    // 父级（MessageList）因 streaming 变化重渲染，message 引用不变 → memo 跳过 MessageItem
    rerender(<MessageList messages={[message]} streaming={true} />);
    expect(counter.reads).toBe(1);

    // 对照：换了 message 引用必然重渲染
    rerender(<MessageList messages={[trackedMessage(counter)]} streaming={true} />);
    expect(counter.reads).toBe(2);
  });

  it('BlockView 是 memo 组件，父级重渲染且 block 引用不变时跳过', () => {
    const counter = { reads: 0 };
    const block = trackedTextBlock(counter);
    const message: ChatMessage = { id: 'm', role: 'assistant', ts: 1, blocks: [block] };
    const { rerender } = render(<MessageItem message={message} logoSrc="/a.png" />);
    expect(counter.reads).toBe(1);

    // MessageItem 因 logoSrc 变化重渲染，block 引用不变 → memo 跳过 BlockView
    rerender(<MessageItem message={message} logoSrc="/b.png" />);
    expect(counter.reads).toBe(1);
  });

  it('50 条消息长列表全部渲染', () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      chatMessage({ id: 'm' + String(i), blocks: [textBlock({ id: 'b' + String(i), text: '第' + String(i) + '条' })] }),
    );
    const { container } = render(<MessageList messages={messages} streaming={false} />);
    expect(container.querySelectorAll('[data-message-id]')).toHaveLength(50);
  });
});

describe('MessageList 空态与流式指示', () => {
  it('空消息且非流式显示欢迎空态', () => {
    render(<MessageList messages={[]} streaming={false} />);
    expect(screen.getByText('还没有消息 — 在下方输入开始对话')).toBeInTheDocument();
  });

  it('streaming 显示“思考中”状态条', () => {
    render(<MessageList messages={[]} streaming={true} />);
    expect(screen.getByRole('status')).toHaveTextContent('思考中');
  });
});
