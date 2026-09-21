import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openTuiExternalTarget } from '../host/open-external.js';

/**
 * `mcode webui` — start the browser frontend (packages/webui).
 *
 * The webui is a first-class product surface: the same engine that powers the
 * TUI (`mcode acp` over stdio) drives the browser UI. This command resolves
 * the webui package on disk, spawns its server as a child process, and points
 * it back at the running CLI via MCODE_WEBUI_SELF_ENTRY so the webui spawns
 * `node <this cli> acp` for chat sessions.
 *
 * Process model: the webui server runs as a child, keeping its own global
 * error handlers and signal cleanup intact. SIGINT/SIGTERM are forwarded; the
 * command exits with the child's exit code.
 */

export interface TuiWebuiCliOptions {
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  readonly open?: boolean;
}

export interface TuiWebuiProcess {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): unknown;
}

export interface TuiWebuiChild {
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): unknown;
}

export interface RunTuiWebuiDependencies {
  readonly processRef?: TuiWebuiProcess;
  readonly spawnChild?: (command: string, args: readonly string[], options: object) => TuiWebuiChild;
  readonly openTarget?: (target: string) => Promise<void>;
  readonly resolveWebuiLayout?: typeof resolveTuiWebuiLayout;
}

export interface TuiWebuiLayout {
  /** Directory of the webui package (contains server.js). */
  readonly webuiDir: string;
  /** Absolute path of this CLI's JS entry, when known — handed to the webui. */
  readonly cliEntry: string | undefined;
}

const LISTENING_PATTERN = /\[webui\] listening on (http:\/\/\S+)/;

/**
 * Locate the webui package and this CLI's own entry.
 *
 * Order: the MCODE_WEBUI_DIR override, the installed layout (a `webui/`
 * sibling of the CLI entry, produced by the build), then the repository
 * source layout (`packages/webui` next to `packages/tui`).
 */
export function resolveTuiWebuiLayout(
  cliEntryArgv: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  moduleDirectory = dirname(fileURLToPath(import.meta.url)),
): TuiWebuiLayout {
  const candidates: string[] = [];
  if (env.MCODE_WEBUI_DIR) candidates.push(env.MCODE_WEBUI_DIR);

  const entry = cliEntryArgv ? resolve(cliEntryArgv) : undefined;
  if (entry) {
    const entryDir = dirname(entry);
    candidates.push(join(entryDir, 'webui')); // installed: dist/cli.js + dist/webui/
    candidates.push(join(entryDir, '..', '..', 'webui')); // source: dist/cli.js → packages/
    candidates.push(join(entryDir, '..', '..', '..', 'webui')); // tsx: packages/tui/src/… → packages/
  }
  candidates.push(join(moduleDirectory, '..', '..', 'webui')); // this module: packages/tui/src/cli → packages/

  const webuiDir = candidates.find((dir) => existsSync(join(dir, 'server.js')));
  if (!webuiDir) {
    throw new Error(
      'Web UI files were not found. Build the repository first (pnpm build), ' +
        'or point MCODE_WEBUI_DIR at the webui package directory.',
    );
  }

  // Only a JS entry can be re-spawned by the webui under plain `node` — and it
  // must be an entry that understands subcommands, because the webui spawns
  // `<self> acp` for chat sessions. A dedicated launcher entry such as
  // dist/mcode-web.js rejects the positional 'acp' and exits 1, killing every
  // conversation at startup — hand the sibling cli.js to the webui instead.
  let cliEntry: string | undefined;
  if (entry && /\.(js|mjs)$/iu.test(entry) && existsSync(entry)) {
    if (/cli\.c?js$/iu.test(entry)) cliEntry = entry;
    else {
      const sibling = join(dirname(entry), 'cli.js');
      if (existsSync(sibling)) cliEntry = sibling;
    }
  }
  if (!cliEntry) {
    // Launcher entry without a sibling CLI, or a tsx-style dev launch
    // (a .ts entry): fall back to the built bundle.
    const built = join(moduleDirectory, '..', '..', '..', 'dist', 'cli.js');
    if (existsSync(built)) cliEntry = built;
  }
  return { webuiDir, cliEntry };
}

export async function runTuiWebuiCommand(
  options: TuiWebuiCliOptions,
  dependencies: RunTuiWebuiDependencies = {},
): Promise<void> {
  const processRef = dependencies.processRef ?? process;
  const spawnChild = dependencies.spawnChild ?? defaultSpawnChild;
  const openTarget =
    dependencies.openTarget ?? ((target: string) => openTuiExternalTarget(target, process.cwd()));
  const resolveLayout = dependencies.resolveWebuiLayout ?? resolveTuiWebuiLayout;

  const layout = resolveLayout(processRef.argv[1], processRef.env);
  const serverEntry = join(layout.webuiDir, 'server.js');

  const childEnv: NodeJS.ProcessEnv = { ...processRef.env };
  if (options.port !== undefined) childEnv.PORT = String(options.port);
  if (options.host !== undefined) childEnv.HOST = options.host;
  if (options.token !== undefined) childEnv.TOKEN = options.token;
  if (layout.cliEntry) childEnv.MCODE_WEBUI_SELF_ENTRY = layout.cliEntry;

  const child = spawnChild(process.execPath, [serverEntry], {
    cwd: layout.webuiDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });

  let settled = false;
  let url: string | undefined;
  let stdoutTail = '';
  const forward = (chunk: string): void => {
    stdoutTail = `${stdoutTail}${chunk}`.slice(-8192);
    process.stdout.write(chunk);
    const match = LISTENING_PATTERN.exec(stdoutTail);
    if (match && !url) {
      url = match[1];
      if (options.open !== false) {
        let target = url.replace('//0.0.0.0:', '//127.0.0.1:');
        if (options.token) target = `${target}?token=${encodeURIComponent(options.token)}`;
        void openTarget(target).catch(() => undefined);
      }
    }
  };

  const piped = child as unknown as {
    stdout?: {
      setEncoding(encoding: string): void;
      on(event: 'data', listener: (chunk: Buffer) => void): void;
    };
  };
  if (piped.stdout) {
    piped.stdout.setEncoding('utf8');
    piped.stdout.on('data', (chunk) => forward(String(chunk)));
  }

  const exitCode = await new Promise<number | null>((resolveExit) => {
    const onSignal = (): void => {
      child.kill('SIGINT');
    };
    processRef.once('SIGINT', onSignal);
    processRef.once('SIGTERM', onSignal);
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      processRef.off('SIGINT', onSignal);
      processRef.off('SIGTERM', onSignal);
      resolveExit(code);
    });
  });

  if (exitCode !== null && exitCode !== 0) processRef.exit(exitCode);
}

function defaultSpawnChild(
  command: string,
  args: readonly string[],
  options: object,
): TuiWebuiChild {
  return spawn(command, args, options as never) as unknown as TuiWebuiChild;
}
