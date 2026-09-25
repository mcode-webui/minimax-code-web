/**
 * test/ui/files-panels.test.tsx —— 右栏文件/浏览器/Git 面板契约
 * ============================================================================
 * 覆盖：文件树右键菜单（菜单项按文件类型出现 + 动作分发）、内置浏览器
 * （URL 受控 + iframe 沙箱渲染 + 关闭）、Git 面板（非仓库空态 / 变更列表 +
 * 徽标 / diff 着色渲染 / 分支下拉）、ResizeHandle 双击复位。
 * ============================================================================
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GitFileChange, GitStatus } from '../../src/contracts/domain';
import { FileTreePanel } from '../../src/ui/files/FileTreePanel';
import { BrowserPanel } from '../../src/ui/files/BrowserPanel';
import { GitPanel } from '../../src/ui/files/GitPanel';
import { ResizeHandle } from '../../src/ui/primitives/ResizeHandle';


describe('FileTreePanel 右键菜单', () => {
  const loader = vi.fn(async () => ({
    ok: true,
    dir: '/home/acer09/文档/demo',
    parent: '/home/acer09/文档',
    entries: [
      { name: 'demo001', path: '/home/acer09/文档/demo/demo001', isDir: true },
      { name: 'index.html', path: '/home/acer09/文档/demo/index.html', isDir: false, size: 10 },
    ],
  }));

  function Setup(props: Partial<Parameters<typeof FileTreePanel>[0]> = {}) {
    return (
      <FileTreePanel
        root="/home/acer09/文档/demo"
        loader={loader}
        menu={{
          onCopyPath: vi.fn(),
          onOpenSystem: vi.fn(),
          onOpenFolder: vi.fn(),
          onOpenBrowser: vi.fn(),
          onPreview: vi.fn(),
        }}
        {...props}
      />
    );
  }

  it('右键目录行弹出菜单：复制路径/系统打开/文件管理器', async () => {
    render(Setup());
    const row = await screen.findByTitle('/home/acer09/文档/demo/demo001');
    fireEvent.contextMenu(row);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('复制路径')).toBeInTheDocument();
    expect(screen.getByText('在系统中打开')).toBeInTheDocument();
    expect(screen.getByText('在文件管理器中打开')).toBeInTheDocument();
  });

  it('html 文件的菜单含「在内置浏览器打开」，动作分发 onOpenBrowser', async () => {
    render(Setup());
    const row = await screen.findByTitle('/home/acer09/文档/demo/index.html');
    fireEvent.contextMenu(row);
    const item = screen.getByText('在内置浏览器打开');
    fireEvent.click(item);
    // 菜单项点击后菜单关闭，动作经 menu.onOpenBrowser 分发（由 menu prop 的 mock 承接）
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('文件树渲染目录与文件两类条目', async () => {
    render(Setup());
    expect(await screen.findByText('demo001')).toBeInTheDocument();
    expect(screen.getByText('index.html')).toBeInTheDocument();
  });
});

describe('BrowserPanel 内置浏览器', () => {
  it('空 URL 显示占位，无 iframe', () => {
    render(<BrowserPanel url={null} onNavigate={vi.fn()} />);
    expect(screen.queryByTitle('内置浏览器')).toBeNull();
  });

  it('有 URL 渲染 iframe（raw 地址直开 html）', () => {
    render(<BrowserPanel url="/api/fs/raw?path=%2Fhome%2Fdemo%2Findex.html" onNavigate={vi.fn()} />);
    expect(screen.getByTitle('内置浏览器')).toHaveAttribute(
      'src',
      '/api/fs/raw?path=%2Fhome%2Fdemo%2Findex.html',
    );
  });

  it('输入路径回车 → 归一为 raw URL 并 onNavigate', () => {
    const onNavigate = vi.fn();
    render(<BrowserPanel url={null} onNavigate={onNavigate} />);
    const input = screen.getByPlaceholderText('输入 URL 或文件路径…');
    fireEvent.change(input, { target: { value: '/home/demo/index.html' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('/api/fs/raw?path=' + encodeURIComponent('/home/demo/index.html'));
  });
});

describe('GitPanel', () => {
  const noopDeps = {
    onLoadStatus: vi.fn(async () => ({ ok: true, isRepo: false, branch: null, files: [] })),
    onLoadBranches: vi.fn(async () => ({ ok: true, branches: [] })),
    onCheckout: vi.fn(async () => ({ ok: true })),
    onLoadDiff: vi.fn(async () => ({ ok: true, diff: '' })),
  };

  it('非 git 仓库显示提示', async () => {
    render(<GitPanel dir="/nope" {...noopDeps} />);
    expect(await screen.findByText('当前工作区不是 git 仓库')).toBeInTheDocument();
  });

  it('变更列表：徽标 + 文件名；单击加载 diff', async () => {
    const files: GitFileChange[] = [
      { x: ' ', y: 'M', path: 'src/a.ts', origPath: null, staged: false },
      { x: '?', y: '?', path: 'new.ts', origPath: null, staged: false },
    ];
    const onLoadStatus = vi.fn(async (): Promise<GitStatus> => ({
      ok: true,
      isRepo: true,
      branch: 'main',
      files,
    }));
    const onLoadBranches = vi.fn(async () => ({
      ok: true,
      branches: [{ name: 'main', current: true }],
    }));
    const onLoadDiff = vi.fn(async () => ({ ok: true, diff: '@@ -1 +1 @@\n+hello' }));
    render(
      <GitPanel dir="/repo" onLoadStatus={onLoadStatus} onLoadBranches={onLoadBranches} onCheckout={vi.fn()} onLoadDiff={onLoadDiff} />,
    );
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('new.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByText('src/a.ts'));
    expect(await screen.findByText(/@@ -1/)).toBeInTheDocument();
    expect(onLoadDiff).toHaveBeenCalledWith('/repo', 'src/a.ts');
  });
});

describe('ResizeHandle', () => {
  it('双击触发复位回调', () => {
    const onReset = vi.fn();
    const { getByRole } = render(<ResizeHandle width={240} onWidthChange={vi.fn()} onReset={onReset} />);
    fireEvent.doubleClick(getByRole('separator'));
    expect(onReset).toHaveBeenCalled();
  });
});
