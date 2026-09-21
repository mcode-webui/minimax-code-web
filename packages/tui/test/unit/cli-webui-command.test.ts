import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveTuiWebuiLayout,
  runTuiWebuiCommand,
} from '../../src/cli/run-webui-command.js';

function makeWebuiTree(root: string): string {
  const webui = path.join(root, 'webui');
  mkdirSync(path.join(webui), { recursive: true });
  writeFileSync(path.join(webui, 'server.js'), '// stub\n');
  return webui;
}

describe('resolveTuiWebuiLayout', () => {
  it('prefers MCODE_WEBUI_DIR when it contains server.js', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'webui-layout-'));
    const webui = makeWebuiTree(root);
    const layout = resolveTuiWebuiLayout(undefined, { MCODE_WEBUI_DIR: webui } as NodeJS.ProcessEnv, root);
    expect(layout.webuiDir).toBe(webui);
    expect(layout.cliEntry).toBeUndefined();
  });

  it('finds the sibling webui/ next to a JS CLI entry', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'webui-layout-'));
    const webui = makeWebuiTree(root);
    const entry = path.join(root, 'cli.js');
    writeFileSync(entry, '// cli\n');
    const layout = resolveTuiWebuiLayout(entry, {} as NodeJS.ProcessEnv, root);
    expect(layout.webuiDir).toBe(webui);
    expect(layout.cliEntry).toBe(entry);
  });

  it('rejects a TS entry as the self CLI reference', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'webui-layout-'));
    makeWebuiTree(root);
    const entry = path.join(root, 'index.ts');
    writeFileSync(entry, '// ts\n');
    const layout = resolveTuiWebuiLayout(entry, {} as NodeJS.ProcessEnv, root);
    expect(layout.cliEntry).toBeUndefined();
  });

  it('throws with guidance when no webui tree exists', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'webui-layout-'));
    expect(() => resolveTuiWebuiLayout(undefined, {} as NodeJS.ProcessEnv, root)).toThrow(/pnpm build|MCODE_WEBUI_DIR/u);
  });
});

describe('runTuiWebuiCommand', () => {
  function fakeProcess() {
    return {
      argv: ['node', '/x/cli.js'],
      env: {} as Record<string, string | undefined>,
      once: vi.fn(),
      off: vi.fn(),
      exit: vi.fn(),
    };
  }

  function fakeChild() {
    const listeners: Record<string, unknown[]> = {};
    return {
      on(event: string, listener: unknown) {
        (listeners[event] ??= []).push(listener);
      },
      once(event: string, listener: unknown) {
        (listeners[`once:${event}`] ??= []).push(listener);
      },
      kill: vi.fn(),
      __emit(event: string, ...args: unknown[]) {
        for (const listener of (listeners[`once:${event}`] ?? []) as ((...a: unknown[]) => void)[])
          listener(...args);
      },
    };
  }

  it('spawns server.js with engine and bind env, and opens the browser once listening', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'webui-run-'));
    const webui = makeWebuiTree(root);
    const processRef = fakeProcess();
    const child = fakeChild();
    const spawnChild = vi.fn(() => child);
    const openTarget = vi.fn(async () => undefined);

    const done = runTuiWebuiCommand(
      { port: 8123, host: '127.0.0.1', open: true },
      {
        processRef: processRef as never,
        spawnChild: spawnChild as never,
        openTarget,
        resolveWebuiLayout: (() => ({ webuiDir: webui, cliEntry: '/x/cli.js' })) as never,
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(spawnChild).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnChild.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(command).toBe(process.execPath);
    expect(args[0]?.endsWith('server.js')).toBe(true);
    expect(options.env.PORT).toBe('8123');
    expect(options.env.HOST).toBe('127.0.0.1');
    expect(options.env.MCODE_WEBUI_SELF_ENTRY).toBe('/x/cli.js');

    child.__emit('exit', 0);
    await done;
    expect(openTarget).not.toHaveBeenCalled();
  });

  it('exits with the child exit code when the server fails', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'webui-run-'));
    const webui = makeWebuiTree(root);
    const processRef = fakeProcess();
    const child = fakeChild();
    const done = runTuiWebuiCommand(
      {},
      {
        processRef: processRef as never,
        spawnChild: vi.fn(() => child) as never,
        openTarget: vi.fn(async () => undefined),
        resolveWebuiLayout: (() => ({ webuiDir: webui, cliEntry: undefined })) as never,
      },
    );
    child.__emit('exit', 3);
    await done;
    expect(processRef.exit).toHaveBeenCalledWith(3);
  });
});
