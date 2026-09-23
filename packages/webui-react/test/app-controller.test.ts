/**
 * app-controller 测试 —— 直接验证本次两项核心诉求：
 *   1) 会话隔离显示：切换会话不得把消息/流式/模型选择串到别的会话；
 *   2) 热插拔：换供应商实现只需替换端口，控制器零改动。
 *
 * 全部用 fake Registry，完全离线、可重复。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAppController } from '../src/features/app-controller';
import type { Registry } from '../src/contracts/ports';
import type { SessionSlice, SessionSummary } from '../src/contracts/domain';

function fakeRegistry(seed: SessionSummary[] = []): Registry {
  const slices = new Map<string, SessionSlice>();
  const subs = new Map<string, Set<() => void>>();
  const sessions = [...seed];
  const noop = () => { /* noop */ };
  const unsub = () => { /* noop */ };

  const ensure = (id: string): SessionSlice => {
    let s = slices.get(id);
    if (!s) {
      s = {
        id,
        summary: null,
        messages: [],
        inflightId: null,
        running: false,
        selection: { provider: 'minimax_api', model: 'minimax_api/MiniMax-M3', thinking: 'medium' },
        context: null,
        workspace: null,
        todos: [],
        goal: null,
        attachments: [],
      };
      slices.set(id, s);
    }
    return s;
  };

  const emit = (id: string) => {
    const set = subs.get(id);
    if (set) for (const l of set) l();
  };

  return {
    clock: { now: () => 1000 },
    // 整体断言：这是一个 stub，返回值由被测代码按需收窄。
    http: {
      get: async () => ({}),
      post: async () => ({}),
      del: async () => ({}),
      upload: async () => ({ id: 'a', name: 'n', path: '/p', size: 0, status: 'done' as const }),
    } as unknown as Registry['http'],
    stream: { connect: noop, close: noop, send: noop, onFrame: () => unsub, status: () => 'open' as const },
    kv: { get: () => null, set: noop, remove: noop },
    notifier: { toast: noop, confirm: async () => true },
    sessions: {
      list: async () => sessions,
      create: async () => { const id = 's' + (sessions.length + 1); sessions.push({ id, title: 'T' + id, workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 1 }); return id; },
      switchTo: async () => { /* noop */ },
      rename: async () => { /* noop */ },
      remove: async () => { /* noop */ },
      slice: (id: string) => ensure(id),
      subscribe: (id: string, l: () => void) => {
        let set = subs.get(id);
        if (!set) { set = new Set(); subs.set(id, set); }
        set.add(l);
        return () => { set!.delete(l); };
      },
    },
    chat: { send: async () => { /* noop */ }, stop: async () => { /* noop */ }, command: async () => { /* noop */ } },
    models: {
      providers: async () => [{ id: 'minimax_api', label: 'MiniMax' }],
      models: async () => [{ id: 'minimax_api/MiniMax-M3', label: 'MiniMax-M3', provider: 'minimax_api' }],
      current: (id: string) => ensure(id).selection,
      setProvider: async (id: string, p: string) => { ensure(id).selection = { ...ensure(id).selection, provider: p }; emit(id); return ensure(id).selection; },
      setModel: async (id: string, m: string) => { ensure(id).selection = { ...ensure(id).selection, model: m }; emit(id); return ensure(id).selection; },
      setThinking: async (id: string, e) => { ensure(id).selection = { ...ensure(id).selection, thinking: e }; emit(id); return ensure(id).selection; },
    },
    workspace: { current: () => null, use: async () => ({ dir: '/w' }), reset: async () => ({ dir: null }), browse: async () => [], recents: () => [], addRecent: () => { /* noop */ } },
    settings: { get: async () => ({}), update: async () => ({}), resetToken: async () => ({ token: 't' }), acknowledgeToken: async () => { /* noop */ } },
    usage: { quota: async () => ({ fiveHourPercent: 50, weeklyPercent: 50, fetchedAt: 1 }), refresh: async () => { /* noop */ }, context: async () => null },
    alerts: { snapshot: async () => [], list: () => [], unread: () => 0, markRead: noop, clear: noop, subscribe: () => unsub },
    auth: { pending: () => [], decide: async () => { /* noop */ }, subscribe: () => unsub },
    upload: { upload: async () => ({ id: 'a', name: 'n', path: '/p', size: 0, status: 'done' as const }) },
  };
}

describe('会话隔离显示', () => {
  it('切换会话不把消息/模型选择串到别的会话', async () => {
    const reg = fakeRegistry([
      { id: 's1', title: 'one', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 2 },
      { id: 's2', title: 'two', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 1 },
    ]);
    const c = createAppController(reg);

    await c.actions.selectSession('s1');
    reg.sessions.slice('s1').messages.push({ id: 'm1', role: 'user', ts: 1, blocks: [] });
    await c.actions.setThinking('high');
    expect(c.snapshot().slice?.selection.thinking).toBe('high');

    // 切到 s2 —— s2 必须是干净的
    await c.actions.selectSession('s2');
    expect(c.snapshot().slice?.id).toBe('s2');
    expect(c.snapshot().slice?.messages).toHaveLength(0);
    expect(c.snapshot().slice?.selection.thinking).toBe('medium');

    // 切回 s1 —— s1 的内容必须原样还在
    await c.actions.selectSession('s1');
    expect(c.snapshot().slice?.messages).toHaveLength(1);
    expect(c.snapshot().slice?.selection.thinking).toBe('high');
  });

  it('每个会话独立保存供应商/模型/思考强度', async () => {
    const reg = fakeRegistry([
      { id: 's1', title: 'one', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 2 },
      { id: 's2', title: 'two', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 1 },
    ]);
    const c = createAppController(reg);
    await c.actions.selectSession('s1');
    await c.actions.setProvider('anthropic');
    await c.actions.selectSession('s2');
    await c.actions.setModel('openai/gpt-5');
    await c.actions.setThinking('max');

    expect(reg.sessions.slice('s1').selection.provider).toBe('anthropic');
    expect(reg.sessions.slice('s2').selection.model).toBe('openai/gpt-5');
    expect(reg.sessions.slice('s2').selection.thinking).toBe('max');
    expect(reg.sessions.slice('s1').selection.thinking).toBe('medium');
  });
});

describe('热插拔', () => {
  it('换成另一套 models 端口实现即可换供应商，其余端口不受影响', async () => {
    const reg = fakeRegistry([{ id: 's1', title: 'one', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 1 }]);
    const c = createAppController(reg);
    await c.actions.selectSession('s1');

    // 拔掉旧的 models 实现，插一个自定义供应商的实现
    const swapped: Registry['models'] = {
      providers: async () => [{ id: 'acme', label: 'Acme' }],
      models: async () => [{ id: 'acme/big', label: 'big', provider: 'acme' }],
      current: () => reg.sessions.slice('s1').selection,
      setProvider: async (id, p) => { reg.sessions.slice(id).selection = { ...reg.sessions.slice(id).selection, provider: p }; return reg.sessions.slice(id).selection; },
      setModel: async (id, m) => { reg.sessions.slice(id).selection = { ...reg.sessions.slice(id).selection, model: m }; return reg.sessions.slice(id).selection; },
      setThinking: async (id, e) => { reg.sessions.slice(id).selection = { ...reg.sessions.slice(id).selection, thinking: e }; return reg.sessions.slice(id).selection; },
    };
    const swappedReg: Registry = { ...reg, models: swapped };
    const c2 = createAppController(swappedReg);
    await c2.actions.selectSession('s1');
    await c2.actions.setProvider('acme');

    expect(c2.snapshot().slice?.selection.provider).toBe('acme');
    // 其余端口仍然是原来那套（未被牵连）
    expect(swappedReg.http).toBe(reg.http);
    expect(swappedReg.sessions).toBe(reg.sessions);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 集成缺口回归：会话隔离草稿 / 搜索过滤 / 斜杠命令路由
// ════════════════════════════════════════════════════════════════════════════

describe('会话隔离 · 输入草稿（缺口 #2）', () => {
  it('两个会话草稿互相隔离、来回切换各自保留；新建会话草稿为空', async () => {
    const reg = fakeRegistry([
      { id: 's1', title: 'one', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 2 },
      { id: 's2', title: 'two', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 1 },
    ]);
    const c = createAppController(reg);

    await c.actions.selectSession('s1');
    c.actions.setDraft('A 的草稿');
    await c.actions.selectSession('s2');
    c.actions.setDraft('B 的草稿');

    // 来回切换：各自保留、互不覆盖
    await c.actions.selectSession('s1');
    expect(c.snapshot().draft).toBe('A 的草稿');
    await c.actions.selectSession('s2');
    expect(c.snapshot().draft).toBe('B 的草稿');
    expect(c.snapshot().draft).not.toBe('A 的草稿');

    // 新增会话草稿为空
    await c.actions.newChat();
    expect(c.snapshot().draft).toBe('');
  });
});

describe('搜索过滤（缺口 #3）', () => {
  it("setSearchQuery('关键') 只留 title/workspace 命中的会话；清空恢复全部", async () => {
    const reg = fakeRegistry([
      { id: 's1', title: '关键讨论', workspace: '/alpha', mcodeSessionId: null, titleCustom: false, updatedAt: 3 },
      { id: 's2', title: '普通讨论', workspace: '/关键目录', mcodeSessionId: null, titleCustom: false, updatedAt: 2 },
      { id: 's3', title: '别的', workspace: '/beta', mcodeSessionId: null, titleCustom: false, updatedAt: 1 },
    ]);
    const c = createAppController(reg);
    await c.actions.refreshSessions();

    c.actions.setSearchQuery('关键');
    const hit = c.snapshot().filteredGroups.flatMap((g) => g.sessions.map((x) => x.id)).sort();
    expect(hit).toEqual(['s1', 's2']);

    c.actions.setSearchQuery('');
    const all = c.snapshot().filteredGroups.flatMap((g) => g.sessions.map((x) => x.id)).sort();
    expect(all).toEqual(['s1', 's2', 's3']);
  });
});

describe('斜杠命令路由（缺口 #6）', () => {
  it("send('/compact') 走 chat.command，不走 chat.send", async () => {
    const reg = fakeRegistry([
      { id: 's1', title: 'one', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 1 },
    ]);
    const send = vi.fn(async (_id: string, _content: string, _refs?: string[]): Promise<void> => { /* noop */ });
    const command = vi.fn(async (_id: string, _cmd: string): Promise<void> => { /* noop */ });
    reg.chat = { send, stop: async () => { /* noop */ }, command };
    const c = createAppController(reg);
    await c.actions.selectSession('s1');

    await c.actions.send('/compact');
    expect(command).toHaveBeenCalledWith('s1', '/compact');
    expect(send).not.toHaveBeenCalled();
  });

  it("send('普通文本') 走 chat.send，不走 chat.command", async () => {
    const reg = fakeRegistry([
      { id: 's1', title: 'one', workspace: '/w', mcodeSessionId: null, titleCustom: false, updatedAt: 1 },
    ]);
    const send = vi.fn(async (_id: string, _content: string, _refs?: string[]): Promise<void> => { /* noop */ });
    const command = vi.fn(async (_id: string, _cmd: string): Promise<void> => { /* noop */ });
    reg.chat = { send, stop: async () => { /* noop */ }, command };
    const c = createAppController(reg);
    await c.actions.selectSession('s1');

    await c.actions.send('普通文本');
    expect(send).toHaveBeenCalledWith('s1', '普通文本', expect.any(Array));
    expect(command).not.toHaveBeenCalled();
  });
});
