/**
 * 快照稳定性回归测试 —— 锁住 useSyncExternalStore 的硬性契约。
 * ============================================================================
 * 缺陷背景：snapshot() 最初每次调用都新建对象，而 useSyncExternalStore 要求
 * getSnapshot 在状态未变时返回**同一个引用**。结果 React 每次渲染都判定
 * 「状态变了」→ 无限重渲染 → 线上崩在 React #185
 * (Maximum update depth exceeded)。jsdom 组件测试没挂载 App.tsx 所以漏掉了，
 * 这里直接在控制器层锁住语义。
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { createAppController } from '../src/features/app-controller';
import type { Registry } from '../src/contracts/ports';

function inertRegistry(): Registry {
  const noop = () => {};
  const unsub = () => {};
  return {
    clock: { now: () => 0 },
    http: { get: async () => ({}), post: async () => ({}), del: async () => ({}), upload: async () => ({}) } as unknown as Registry['http'],
    stream: { connect: noop, close: noop, send: noop, onFrame: () => unsub, status: () => 'open' as const },
    kv: { get: () => null, set: noop, remove: noop },
    notifier: { toast: noop, confirm: async () => true },
    sessions: { list: async () => [], create: async () => 's1', switchTo: async () => {}, rename: async () => {}, remove: async () => {}, slice: () => ({ id: 's1', summary: null, messages: [], inflightId: null, running: false, selection: { provider: 'p', model: 'p/m', thinking: 'low' as const }, context: null, workspace: null, todos: [], goal: null, plan: null, attachments: [] }), subscribe: () => unsub },
    chat: { send: async () => {}, stop: async () => {}, command: async () => {} },
    models: { providers: async () => [], models: async () => [], current: () => ({ provider: 'p', model: 'p/m', thinking: 'low' as const }), setProvider: async (_id, p) => ({ provider: p, model: 'p/m', thinking: 'low' as const }), setModel: async (_id, m) => ({ provider: 'p', model: m, thinking: 'low' as const }), setThinking: async (_id, e) => ({ provider: 'p', model: 'p/m', thinking: e }) },
    workspace: { current: () => null, use: async () => ({ dir: null }), reset: async () => ({ dir: null }), browse: async () => [], recents: () => [], addRecent: noop },
    settings: { get: async () => ({}), update: async () => ({}), resetToken: async () => ({ token: 't' }), acknowledgeToken: async () => {} },
    usage: { quota: async () => ({ fiveHourPercent: null, weeklyPercent: null, fetchedAt: null }), refresh: async () => {}, context: async () => null },
    alerts: { snapshot: async () => [], list: () => [], unread: () => 0, markRead: noop, clear: noop, subscribe: () => unsub },
    auth: { pending: () => [], decide: async () => {}, subscribe: () => unsub },
    upload: { upload: async () => ({ id: 'a', name: 'n', path: '/p', size: 0, status: 'done' as const }) },
    interact: {
      answerPlan: async () => {},
      answerPlanMode: async () => {},
      permissionModes: async () => ({ webui: [], mcode: [] }),
      setPermissionMode: async () => {},
    },
  } as Registry;
}

describe('AppSnapshot 引用稳定性（useSyncExternalStore 契约）', () => {
  it('状态未变时 snapshot() 必须返回同一个引用（否则无限重渲染）', () => {
    const c = createAppController(inertRegistry());
    const a = c.snapshot();
    const b = c.snapshot();
    const d = c.snapshot();
    expect(b).toBe(a);
    expect(d).toBe(a);
  });

  it('动作触发后才换新引用 —— 订阅者据此重渲染', async () => {
    const c = createAppController(inertRegistry());
    const before = c.snapshot();
    c.actions.setLeftOpen(true);
    const after = c.snapshot();
    expect(after).not.toBe(before);
    expect(after.leftOpen).toBe(true);
  });

  it('快照内部的会话切片也不跨会话共享（隔离前提）', async () => {
    const c = createAppController(inertRegistry());
    await c.actions.selectSession('s1');
    const s1 = c.snapshot().slice;
    expect(s1?.id).toBe('s1');
    c.actions.setDraft('草稿只属于 s1');
    expect(c.snapshot().draft).toBe('草稿只属于 s1');
  });
});
