/**
 * 热插拔回归测试 —— 锁住 replacePort 的「原地改」语义。
 * ============================================================================
 * 缺陷背景：replacePort 最初是 current = { ...old, [key]: impl }（换新对象）。
 * 而 app-controller 在模块级就持有了 registry 引用，于是 replacePort 之后旧持有者
 * 仍在用旧端口 —— "热插拔"是假的。本测试锁住：已持有的引用必须看到替换结果。
 * ============================================================================
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createRegistry, getRegistry, replacePort, resetRegistry, setRegistry } from '../src/core/registry';
import type { NotifierPort, Registry } from '../src/contracts/ports';

const silent: NotifierPort = { toast: () => {}, confirm: async () => true };

function stubRegistry(): Registry {
  // 只覆盖 notifier，其余端口由 createRegistry 的默认实现补齐；本测试只关心引用语义。
  return createRegistry({ notifier: silent });
}

describe('replacePort 热插拔语义', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('已持有的 registry 引用能看到替换结果（原地改，不换对象）', () => {
    setRegistry(stubRegistry());
    const held = getRegistry(); // 模拟模块级捕获
    const before = held.notifier;

    const custom: NotifierPort = {
      toast: () => {},
      confirm: async () => false,
    };
    replacePort('notifier', custom);

    // 关键断言：同一个对象，且字段已换 —— 旧持有者无感地用上新实现。
    expect(getRegistry()).toBe(held);
    expect(held.notifier).toBe(custom);
    expect(held.notifier).not.toBe(before);
  });

  it('只替换目标端口，其余端口引用不变（低耦合）', () => {
    setRegistry(stubRegistry());
    const held = getRegistry();
    const httpBefore = held.http;
    const modelsBefore = held.models;

    replacePort('notifier', { toast: () => {}, confirm: async () => true });

    expect(held.http).toBe(httpBefore);
    expect(held.models).toBe(modelsBefore);
  });

  it('createRegistry 的覆盖项优先于默认实现', () => {
    const custom: NotifierPort = { toast: () => {}, confirm: async () => false };
    const reg = createRegistry({ notifier: custom });
    expect(reg.notifier).toBe(custom);
  });
});
