#!/usr/bin/env node
// mcode-web — dedicated Web UI launcher.
//
// Equivalent to `mcode webui`, but with an unambiguous name that users reach
// for naturally (`pnpm mcode web` is otherwise read as a TUI prompt). Built
// to dist/mcode-web.js and wired as the `pnpm mcode-web` script.

import { parseArgs } from 'node:util';

import { runTuiWebuiCommand } from './run-webui-command.js';

const usage = `Usage: mcode-web [--port <number>] [--host <address>] [--token <value>] [--no-open]
Starts the MiniMax Code Web UI (same as 'mcode webui' / 'mcode web').
Without --port the server starts on 18090 and moves to the next free port when
18090 is taken; an explicit --port is pinned and never moves.`;

let values: ReturnType<typeof parseArgs<{ port: string; host: string; token: string; open: boolean; 'no-open': boolean }>>['values'];
try {
  ({ values } = parseArgs({
    allowPositionals: false,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      token: { type: 'string' },
      open: { type: 'boolean', default: true },
      // node:util parseArgs does not auto-negate booleans; declare the
      // negated spelling explicitly so --no-open works as written.
      'no-open': { type: 'boolean' },
    },
  }));
} catch (error) {
  process.stderr.write(`mcode-web: ${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
  process.exit(1);
}

const open = values['no-open'] === true ? false : values.open;

const port = values.port === undefined ? undefined : Number(values.port);
if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535)) {
  process.stderr.write(`mcode-web: expected a port between 0 and 65535, got "${values.port}"\n${usage}\n`);
  process.exit(1);
}

await runTuiWebuiCommand({
  port,
  host: values.host,
  token: values.token,
  open,
});
