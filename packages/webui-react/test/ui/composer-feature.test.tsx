/**
 * composer-feature 测试 —— 缺口 #1：附件按钮驱动隐藏文件选择框并上传。
 * ============================================================================
 * 点附件按钮触发隐藏 input 的 click（spy）；选文件后调 actions.uploadFiles。
 * 容器契约：ComposerFeature({ controller }) 渲染 <input type="file" hidden> +
 * Composer，onAttachClick → fileRef.current.click()，input onChange → uploadFiles。
 * ============================================================================
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RegistryProvider } from '../../src/features/registry-context';
import { ComposerFeature } from '../../src/features/composer-feature';
import { makeHarness } from '../fakes';

function renderComposer(h: ReturnType<typeof makeHarness>) {
  return render(
    <RegistryProvider value={h.reg}>
      <ComposerFeature controller={h.controller} />
    </RegistryProvider>,
  );
}

describe('附件上传（缺口 #1）', () => {
  it('点附件按钮触发隐藏文件选择框的 click', () => {
    const h = makeHarness();
    const { container } = renderComposer(h);
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const clickSpy = vi.spyOn(fileInput as HTMLInputElement, 'click').mockImplementation(() => { /* noop */ });

    fireEvent.click(screen.getByRole('button', { name: '附件 (Ctrl+V 粘贴)' }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('选文件后调 uploadFiles', async () => {
    const h = makeHarness();
    const uploadFiles = vi.spyOn(h.controller.actions, 'uploadFiles').mockImplementation(async () => { /* noop */ });
    const { container } = renderComposer(h);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    const arg = uploadFiles.mock.calls[0][0];
    expect(arg).toHaveLength(1);
    expect(arg[0].name).toBe('a.txt');
  });
});
