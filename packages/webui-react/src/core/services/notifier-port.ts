/**
 * core/services/notifier-port.ts —— NotifierPort 的默认实现（console + 极简事件发射器）
 * 【职责】core 在不感知 antd 的前提下发出 toast / confirm 诉求：默认打印 console，
 *   并把事件广播给订阅者；confirm 可被订阅者接管答复（返回 boolean 即生效）。
 * 【接缝】实现 contracts/ports.ts 的 NotifierPort；ui 层稍后用 antd message/modal
 *   实现同一个 NotifierPort 并经 replacePort('notifier', …) 热插拔注入 ——
 *   因此默认实现必须能独立工作（无 UI 也能跑通全部 core 流程）。
 */
import type { NotifierPort } from '../../contracts/ports';

export type NotifierLevel = 'info' | 'success' | 'warn' | 'error';

export type NotifierEvent =
  | { kind: 'toast'; message: string; level: NotifierLevel }
  | { kind: 'confirm'; title: string; body: string };

/**
 * 事件监听者：返回 boolean（或 Promise<boolean>）可接管 confirm 的答复，
 * 第一个非 undefined 的布尔答复生效；其余返回值忽略。
 */
export type NotifierListener = (event: NotifierEvent) => unknown;

export interface ObservableNotifierPort extends NotifierPort {
  /** 订阅通知事件；返回退订函数。 */
  on(listener: NotifierListener): () => void;
}

export interface NotifierPortOptions {
  /** 无人接管 confirm 时的默认答复（无 UI 环境下让流程可继续）。 */
  confirmDefault?: boolean;
  /** 无人接管时的输出（默认 console）。 */
  log?: (event: NotifierEvent) => void;
}

function defaultLog(event: NotifierEvent): void {
  if (event.kind === 'toast') {
    const prefix = '[webui:' + event.level + ']';
    if (event.level === 'error') console.error(prefix, event.message);
    else if (event.level === 'warn') console.warn(prefix, event.message);
    else console.log(prefix, event.message);
  } else {
    console.log('[webui:confirm]', event.title, event.body);
  }
}

export function createNotifierPort(options: NotifierPortOptions = {}): ObservableNotifierPort {
  const confirmDefault = options.confirmDefault ?? true;
  const log = options.log ?? defaultLog;
  const listeners = new Set<NotifierListener>();

  function publish(event: NotifierEvent): unknown[] {
    const results: unknown[] = [];
    for (const l of [...listeners]) {
      try {
        results.push(l(event));
      } catch {
        // 监听方异常不影响通知本身
      }
    }
    return results;
  }

  return {
    toast(message: string, kind?: 'info' | 'success' | 'warn' | 'error'): void {
      const event: NotifierEvent = { kind: 'toast', message, level: kind ?? 'info' };
      log(event);
      publish(event);
    },
    async confirm(title: string, body: string): Promise<boolean> {
      const event: NotifierEvent = { kind: 'confirm', title, body };
      log(event);
      for (const r of publish(event)) {
        const v = await r;
        if (typeof v === 'boolean') return v; // 第一个接管者说了算
      }
      return confirmDefault;
    },
    on(listener: NotifierListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
