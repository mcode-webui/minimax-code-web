// 覆盖契约点：ui/composer —— ModelPicker 三段式（供应商/模型/思考强度五档）点击各段分别回调
// onSelectProvider / onSelectModel / onSelectThinking 且当前项有选中态；自定义输入回车提交、取消/关闭上抛；
// Composer 输入受控、Enter 发送 / Shift+Enter 不发送、running 时变停止按钮。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ModelSelection } from '../../src/contracts/domain';
import { ModelPicker } from '../../src/ui/composer/ModelPicker';
import { Composer } from '../../src/ui/composer/Composer';
import { modelOption, providerOption } from './fixtures';

const SELECTION: ModelSelection = {
  provider: 'minimax_api',
  model: 'minimax_api/MiniMax-M3',
  thinking: 'medium',
};

function renderPicker(over: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  return render(
    <ModelPicker
      open={true}
      providers={[providerOption(), providerOption({ id: 'openai', label: 'OpenAI' })]}
      models={[
        modelOption(),
        modelOption({ id: 'openai/gpt-5', label: 'GPT-5', provider: 'openai', contextLimit: 200_000 }),
      ]}
      selection={SELECTION}
      onSelectProvider={vi.fn()}
      onSelectModel={vi.fn()}
      onSelectThinking={vi.fn()}
      onSubmitCustom={vi.fn()}
      onClose={vi.fn()}
      {...over}
    />,
  );
}

describe('ModelPicker 三段式 —— ① 供应商段', () => {
  it('渲染供应商列表，当前供应商有选中态（current + ✓）', () => {
    renderPicker();
    const current = screen.getByRole('button', { name: 'MiniMax' });
    expect(current).toHaveClass('current');
    expect(current).toHaveTextContent('✓');
    const other = screen.getByRole('button', { name: 'OpenAI' });
    expect(other).not.toHaveClass('current');
  });

  it('点供应商回调 onSelectProvider(id)，不误触发模型/思考回调', () => {
    const onSelectProvider = vi.fn();
    const onSelectModel = vi.fn();
    const onSelectThinking = vi.fn();
    renderPicker({ onSelectProvider, onSelectModel, onSelectThinking });
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    expect(onSelectProvider).toHaveBeenCalledWith('openai');
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(onSelectThinking).not.toHaveBeenCalled();
  });
});

describe('ModelPicker 三段式 —— ② 模型段', () => {
  it('渲染模型列表，当前模型有选中态', () => {
    renderPicker();
    const current = screen.getByRole('button', { name: /^MiniMax-M3/ });
    expect(current).toHaveClass('current');
    expect(current).toHaveTextContent('✓');
    expect(screen.getByRole('button', { name: /^GPT-5/ })).not.toHaveClass('current');
  });

  it('点模型回调 onSelectModel(全限定 id)', () => {
    const onSelectModel = vi.fn();
    const onSelectProvider = vi.fn();
    renderPicker({ onSelectModel, onSelectProvider });
    fireEvent.click(screen.getByRole('button', { name: /^GPT-5/ }));
    expect(onSelectModel).toHaveBeenCalledWith('openai/gpt-5');
    expect(onSelectProvider).not.toHaveBeenCalled();
  });
});

describe('ModelPicker 三段式 —— ③ 思考强度五档', () => {
  it('五档齐备（关/低/中/高/极高），当前档 aria-checked', () => {
    renderPicker();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(5);
    const checked = screen.getByRole('radio', { name: '中', checked: true });
    expect(checked).toHaveClass('current');
  });

  it('点档位回调 onSelectThinking(五档枚举值)，不触发其它段回调', () => {
    const onSelectThinking = vi.fn();
    const onSelectProvider = vi.fn();
    const onSelectModel = vi.fn();
    renderPicker({ onSelectThinking, onSelectProvider, onSelectModel });
    fireEvent.click(screen.getByRole('radio', { name: '高' }));
    expect(onSelectThinking).toHaveBeenCalledWith('high');
    fireEvent.click(screen.getByRole('radio', { name: '极高' }));
    expect(onSelectThinking).toHaveBeenCalledWith('max');
    expect(onSelectProvider).not.toHaveBeenCalled();
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it('点击段之间互不串扰：三段各自回调独立', () => {
    const onSelectProvider = vi.fn();
    const onSelectModel = vi.fn();
    const onSelectThinking = vi.fn();
    renderPicker({ onSelectProvider, onSelectModel, onSelectThinking });
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    fireEvent.click(screen.getByRole('button', { name: /^MiniMax-M3/ }));
    fireEvent.click(screen.getByRole('radio', { name: '低' }));
    expect(onSelectProvider).toHaveBeenCalledTimes(1);
    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(onSelectThinking).toHaveBeenCalledTimes(1);
    expect(onSelectThinking).toHaveBeenCalledWith('low');
  });
});

describe('ModelPicker 自定义输入与关闭', () => {
  it('自定义输入回车提交原文', () => {
    const onSubmitCustom = vi.fn();
    renderPicker({ onSubmitCustom });
    const input = screen.getByPlaceholderText('provider/model[#variant]');
    fireEvent.change(input, { target: { value: 'acme/big#v1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitCustom).toHaveBeenCalledWith('acme/big#v1');
  });

  it('取消按钮与输入框 Esc 都上抛 onClose', () => {
    const onClose = vi.fn();
    renderPicker({ onClose });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByPlaceholderText('provider/model[#variant]'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('open=false 时不渲染', () => {
    const { container } = renderPicker({ open: false });
    expect(container.innerHTML).toBe('');
  });
});

function renderComposer(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  return render(
    <Composer
      value=""
      onChange={vi.fn()}
      onSend={vi.fn()}
      running={false}
      onStop={vi.fn()}
      attachments={[]}
      onRemoveAttachment={vi.fn()}
      onAttachClick={vi.fn()}
      mode="ask"
      onModeClick={vi.fn()}
      modelLabel="MiniMax-M3"
      onModelClick={vi.fn()}
      {...over}
    />,
  );
}

describe('Composer 输入受控与发送', () => {
  it('textarea 受控：输入只上抛 onChange', () => {
    const onChange = vi.fn();
    renderComposer({ value: '你好', onChange });
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('你好');
    fireEvent.change(textarea, { target: { value: '你好呀' } });
    expect(onChange).toHaveBeenCalledWith('你好呀');
  });

  it('Enter 发送、Shift+Enter 不发送；空内容不发送', () => {
    const onSend = vi.fn();
    const { rerender } = renderComposer({ value: '内容', onSend });
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    rerender(
      <Composer
        value=""
        onChange={vi.fn()}
        onSend={onSend}
        running={false}
        onStop={vi.fn()}
        attachments={[]}
        onRemoveAttachment={vi.fn()}
        onAttachClick={vi.fn()}
        mode="ask"
        onModeClick={vi.fn()}
        modelLabel="MiniMax-M3"
        onModelClick={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('running 时发送键变停止键并上抛 onStop', () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    renderComposer({ value: '', running: true, onStop, onSend });
    fireEvent.click(screen.getByTitle('停止'));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});
