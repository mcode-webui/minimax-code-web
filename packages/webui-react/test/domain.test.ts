/**
 * 领域纯函数测试 —— 分组排序、模型 id 拆分、空切片构造、不可信 wire 归一化。
 */
import { describe, expect, it } from 'vitest';
import { emptySessionSlice, groupSessionsByWorkspace, splitModelId } from '../src/contracts/domain';
import { normalizeWireAlert, isServerFrame, isErrResponse } from '../src/contracts/protocol';

describe('groupSessionsByWorkspace', () => {
  it('按工作区分组，组内按更新时间倒序', () => {
    const groups = groupSessionsByWorkspace([
      { id: 'a', title: 'A', workspace: '/w1', mcodeSessionId: null, titleCustom: false, updatedAt: 1 },
      { id: 'b', title: 'B', workspace: '/w1', mcodeSessionId: null, titleCustom: false, updatedAt: 3 },
      { id: 'c', title: 'C', workspace: '/w2', mcodeSessionId: null, titleCustom: false, updatedAt: 2 },
    ]);
    expect(groups).toHaveLength(2);
    const w1 = groups.find((g) => g.key === '/w1');
    expect(w1?.sessions.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('无工作区会话归入空串分组并显示占位标签', () => {
    const groups = groupSessionsByWorkspace([
      { id: 'x', title: 'X', workspace: null, mcodeSessionId: null, titleCustom: false, updatedAt: 1 },
    ]);
    expect(groups[0].key).toBe('');
    expect(groups[0].label).not.toBe('');
  });

  it('空列表返回空数组', () => {
    expect(groupSessionsByWorkspace([])).toEqual([]);
  });
});

describe('splitModelId', () => {
  it('取 / 前的供应商段', () => {
    expect(splitModelId('openai/gpt-5')).toBe('openai');
  });
  it('无 / 时回落到默认供应商', () => {
    expect(splitModelId('MiniMax-M3')).toBe('minimax_api');
    expect(splitModelId('MiniMax-M3', 'anthropic')).toBe('anthropic');
  });
});

describe('emptySessionSlice', () => {
  it('构造出的切片互不影响（会话隔离的结构前提）', () => {
    const sel = { provider: 'p', model: 'p/m', thinking: 'low' as const };
    const s1 = emptySessionSlice('1', sel);
    const s2 = emptySessionSlice('2', sel);
    s1.messages.push({ id: 'm', role: 'user', ts: 0, blocks: [] });
    expect(s2.messages).toHaveLength(0);
    expect(s1.selection).not.toBe(s2.selection);
  });
});

describe('wire 归一化（不可信数据容错）', () => {
  it('normalizeWireAlert 对畸形字段兜底', () => {
    const a = normalizeWireAlert({ id: 123, level: 'nope', msg: null });
    expect(a.id).toBe('123');
    expect(a.level).toBe('info');
    expect(typeof a.msg).toBe('string');
  });
  it('normalizeWireAlert 对空输入给出空 id（调用方跳过）', () => {
    expect(normalizeWireAlert(null).id).toBe('');
  });
  it('isServerFrame / isErrResponse 判别正确', () => {
    expect(isServerFrame({ v: 1, type: 'hello', payload: {} })).toBe(true);
    expect(isServerFrame({ v: 2, type: 'hello', payload: {} })).toBe(false);
    expect(isErrResponse({ ok: false, error: 'x' })).toBe(true);
    expect(isErrResponse({ ok: true })).toBe(false);
  });
});
