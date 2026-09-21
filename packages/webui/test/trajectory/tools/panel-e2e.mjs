#!/usr/bin/env node
/**
 * Panel end-to-end harness: seed a hostile session, serve the panel, print the URL.
 *
 * This is not part of `node --test`. It exists to produce the evidence a unit test
 * cannot: that a payload which *would* execute if the client ever built markup from
 * a string does not execute in a real browser, and that a credential planted in a
 * title, a task command and a tool argument reaches the page already redacted.
 *
 * Usage:
 *   node tools/panel-e2e.mjs [--port 7421] [--keep]
 *
 * Then open the printed URL in a browser and check:
 *   window.__XSS === undefined
 *   document.querySelectorAll('img').length === 0
 *   document.body.textContent.includes('<img src=x onerror=')
 *
 * `--keep` leaves the fixture directory behind for inspection.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { bootstrap } from '../../../server/trajectory/main.mjs';
import { createFixtureProjection, FIXTURE_WORKSPACE } from './fixture.mjs';

/**
 * The payloads. None of them matches a credential pattern, so redaction leaves them
 * intact — which is what makes this a render test rather than a redaction test.
 */
const IMG_PAYLOAD = '<img src=x onerror="window.__XSS=1">';
const SCRIPT_PAYLOAD = '"><script>window.__XSS=2</script>';
const SVG_PAYLOAD = '<svg onload="window.__XSS=3">';

/** A credential, to prove the pipeline scrubs it before the page sees it. */
// Built at runtime so a repository-wide static credential scan never sees a
// full token literal; the value itself is a full-length synthetic GitHub token.
const SECRET = `ghp_${'z'.repeat(32)}`;

function parseArgs(argv) {
  const args = { port: 7421, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') args.port = Number.parseInt(argv[++index] ?? '', 10);
    else if (argv[index] === '--keep') args.keep = true;
  }
  return args;
}

async function seed(dataDir) {
  const projection = await createFixtureProjection(dataDir);
  const now = 1_700_000_000_000;
  // The newest session is the one the panel selects on load, so every payload
  // renders without anyone having to click anything.
  projection.session({
    id: 'sess-render-e2e',
    title: `XSS canary with a credential ${SECRET} in the title`,
    updatedAtMs: now,
    workspaceDir: FIXTURE_WORKSPACE,
  });
  projection.row({
    sessionId: 'sess-render-e2e', msgId: 'e2e-1', role: 'user', turnId: 'turn-1', createdAtMs: now - 900,
    data: {
      msg_id: 'e2e-1', role: 'user', source: 'api', msg_type: 1, turn_id: 'turn-1',
      msg_content: `Please render this literally: ${IMG_PAYLOAD}`,
    },
  });
  projection.row({
    sessionId: 'sess-render-e2e', msgId: 'e2e-2', role: 'assistant', turnId: 'turn-1', createdAtMs: now - 800,
    data: {
      msg_id: 'e2e-2', role: 'assistant', source: 'api', msg_type: 2, turn_id: 'turn-1',
      msg_content: `Handled ${SVG_PAYLOAD}`,
      thinking_content: `thinking about ${IMG_PAYLOAD}`,
      finish_reason: 'toolUse',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, request_duration_ms: 100 },
      tool_calls: [{
        tool_call_id: 'call-1',
        tool_name: 'bash',
        tool_call_args: { command: `printf '${SCRIPT_PAYLOAD}'`, token: SECRET },
        tool_call_result_data: `exit 0 ${IMG_PAYLOAD}`,
        tool_call_status: 2,
      }],
    },
  });
  projection.task({
    taskId: 'task-e2e', sessionId: 'sess-render-e2e', status: 'failed',
    createdAtMs: now - 850, endedAtMs: now - 700,
    record: {
      description: `curl -H 'Authorization: Bearer ${SECRET}' https://example.invalid ${IMG_PAYLOAD}`,
      toolCallId: 'call-1',
      metadata: { command: `curl --token ${SECRET} ${IMG_PAYLOAD}` },
    },
  });
  projection.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-e2e-'));
  await seed(dataDir);

  const context = bootstrap({ env: { ...process.env, MINIMAX_DATA_DIR: dataDir } });
  const started = await context.studio.start({ port: args.port });

  process.stdout.write([
    'Trajectory Studio E2E fixture',
    `  data dir : ${dataDir}`,
    `  sqlite   : ${context.store.sqliteFile} (available: ${Boolean(context.store.db)}, fts: ${context.store.hasFts})`,
    `  sessions : ${context.store.listSessions({ limit: 5 }).length}`,
    `  panel    : ${started.url}`,
    '',
    'Expected in the browser console:',
    '  window.__XSS === undefined',
    "  document.querySelectorAll('img').length === 0",
    '',
    'This harness holds the fixture until SIGINT. Run it under a tool that drives a',
    'browser, then stop it.',
    '',
  ].join('\n'));

  const shutdown = async () => {
    await context.studio.stop();
    context.store.close();
    if (!args.keep) await rm(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
