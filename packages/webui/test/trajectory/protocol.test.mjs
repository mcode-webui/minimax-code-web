import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection } from './tools/fixture.mjs';

/**
 * The protocol surface, against the real process.
 *
 * `store.test.mjs` exercises `handleRpcMessage` as a function, which is the right
 * level for the folding logic but not for the contract: it cannot catch a server
 * that never answers, answers twice, or keeps the host's pipe open after it should
 * have exited. Those are exactly the failures a client experiences, so this suite
 * spawns `server/main.mjs` the way mcode does — stdio, newline-delimited JSON-RPC —
 * and drives it as a client.
 *
 * Every wait is bounded. A server that stops answering has to fail the suite rather
 * than hang it, or the evidence for "the protocol works" would be a timeout.
 */

const SERVER = path.join(import.meta.dirname, '..', '..', 'server', 'trajectory', 'main.mjs');
const CALL_TIMEOUT_MS = 10_000;

/** A credential planted in the fixture; it must never appear in a response. */
// Built at runtime so a repository-wide static credential scan never sees a
// full token literal; the value itself is a full-length synthetic GitHub token.
const SECRET = `ghp_${'q'.repeat(32)}`;

async function makeFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-protocol-'));
  const projection = await createFixtureProjection(dataDir);
  const now = 1_700_000_000_000;

  projection.session({ id: 'sess-protocol', title: 'Protocol fixture', updatedAtMs: now });
  projection.session({
    id: 'sess-child', title: 'Child task', agent: 'explore', updatedAtMs: now - 500, parent: 'sess-protocol',
  });
  projection.row({
    sessionId: 'sess-protocol', msgId: 'm1', role: 'user', turnId: 'turn-1', createdAtMs: now - 900,
    data: { msg_id: 'm1', role: 'user', source: 'api', msg_type: 1, turn_id: 'turn-1', msg_content: 'hello' },
  });
  projection.row({
    sessionId: 'sess-protocol', msgId: 'm2', role: 'assistant', turnId: 'turn-1', createdAtMs: now - 800,
    data: {
      msg_id: 'm2', role: 'assistant', source: 'api', msg_type: 2, turn_id: 'turn-1',
      msg_content: `used a credential ${SECRET}`,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, request_duration_ms: 100 },
      tool_calls: [{
        tool_call_id: 'call-1', tool_name: 'bash',
        tool_call_args: { command: `export TOKEN=${SECRET}` },
        tool_call_result_data: 'ok', tool_call_status: 2,
      }],
    },
  });
  projection.task({
    taskId: 'task-1', sessionId: 'sess-protocol', createdAtMs: now - 850, endedAtMs: now - 700,
    record: { description: `curl --token ${SECRET}`, toolCallId: 'call-1' },
  });
  projection.close();
  return dataDir;
}

/** A client that speaks to the spawned server the way mcode does. */
function createClient(dataDir) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MINIMAX_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const notifications = [];
  let stderr = '';
  let stdout = '';
  let exit = null;
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }); });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === undefined || message.id === null) { notifications.push(message); continue; }
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id, method, params) => {
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} did not answer within ${CALL_TIMEOUT_MS}ms`)),
        CALL_TIMEOUT_MS,
      );
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return answer;
  };

  return {
    child,
    send,
    request,
    exited,
    get exit() { return exit; },
    get stderr() { return stderr; },
    get stdout() { return stdout; },
    get notifications() { return notifications; },
    async close() {
      child.stdin.end();
      await exited;
    },
    async kill() {
      if (exit) return exit;
      child.kill('SIGKILL');
      return exited;
    },
  };
}

/** Spawn, run `body`, and always reap the process. */
async function withClient(t, body) {
  const dataDir = await makeFixture();
  const client = createClient(dataDir);
  t.after(async () => {
    await client.kill();
    await rm(dataDir, { recursive: true, force: true });
  });
  await body(client, dataDir);
}

/* ------------------------------------------------------------------ tests -- */

test('initialize answers with the negotiated protocol version and server identity', async (t) => {
  await withClient(t, async (client) => {
    const response = await client.request(1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.equal(response.result.serverInfo.name, 'mcode-trajectory-studio');
    assert.match(response.result.serverInfo.version, /^\d+\.\d+\.\d+$/u);
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
    assert.match(response.result.instructions, /read-only/iu);
  });
});

test('a protocol version the server does not implement is not echoed back', async (t) => {
  await withClient(t, async (client) => {
    // Echoing whatever the client asked for would claim support for behaviour that
    // was never implemented.
    const older = await client.request(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(older.result.protocolVersion, '2024-11-05');

    const future = await client.request(2, 'initialize', { protocolVersion: '2099-01-01' });
    assert.equal(future.result.protocolVersion, '2025-06-18', 'an unimplemented version was echoed back');

    const missing = await client.request(3, 'initialize', {});
    assert.equal(missing.result.protocolVersion, '2025-06-18');
  });
});

test('tools/list declares seven bounded tools and marks only the panel as a side effect', async (t) => {
  await withClient(t, async (client) => {
    await client.request(1, 'initialize', {});
    const { result } = await client.request(2, 'tools/list');
    const names = result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'trajectory_list', 'trajectory_summary', 'trajectory_get',
      'trajectory_search', 'trajectory_tasks', 'trajectory_task_output', 'trajectory_studio',
    ]);
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} accepts unknown arguments`);
      assert.ok(tool.description.length > 20, `${tool.name} has no description`);
      assert.equal(tool.annotations.openWorldHint, false, `${tool.name} claims an open world`);
      // Starting the panel opens a listener, so it must not claim to be read-only:
      // a client that trusts the hint would skip its confirmation prompt.
      assert.equal(tool.annotations.readOnlyHint, tool.name !== 'trajectory_studio');
    }
  });
});

test('a tool call reads the fixture the host pointed the server at', async (t) => {
  await withClient(t, async (client) => {
    await client.request(1, 'initialize', {});
    const listed = await client.request(2, 'tools/call', { name: 'trajectory_list', arguments: { limit: 10 } });
    assert.equal(listed.result.isError, undefined);
    assert.equal(listed.result.structuredContent.sqlite, true, 'the fixture projection was not opened');
    assert.deepEqual(
      listed.result.structuredContent.sessions.map((session) => session.sessionId),
      ['sess-protocol', 'sess-child'],
    );
    // The response is also readable as text, which is what many clients show.
    assert.match(listed.result.content[0].text, /sess-protocol/u);

    const summary = await client.request(3, 'tools/call', {
      name: 'trajectory_summary', arguments: { sessionId: 'sess-protocol' },
    });
    assert.equal(summary.result.structuredContent.turns, 1);
    assert.equal(summary.result.structuredContent.ttftMs, null, 'TTFT is not persisted and must not be estimated');
    assert.ok(summary.result.structuredContent.llmMs > 0, 'the measured request duration was not folded');
  });
});

test('full detail over the wire is redacted and still carries the payload', async (t) => {
  await withClient(t, async (client) => {
    await client.request(1, 'initialize', {});
    const { result } = await client.request(2, 'tools/call', {
      name: 'trajectory_get',
      arguments: { sessionId: 'sess-protocol', detailLevel: 'full', limit: 50 },
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SECRET), false, 'a credential crossed the wire');
    assert.match(serialized, /\[redacted\]/u, 'nothing was redacted at all');
    // The rest of the record has to survive, or the redactor is destroying the point.
    assert.match(serialized, /used a credential/u);
    assert.match(serialized, /sess-protocol/u);
  });
});

test('an unknown tool is an error result, not a dropped request', async (t) => {
  await withClient(t, async (client) => {
    await client.request(1, 'initialize', {});
    const { result } = await client.request(2, 'tools/call', { name: 'not_a_tool', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unknown_tool/u);
  });
});

test('an unknown method is a JSON-RPC error that names it', async (t) => {
  await withClient(t, async (client) => {
    const response = await client.request(1, 'tools/nonexistent');
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /tools\/nonexistent/u);
  });
});

test('a notification is not answered', async (t) => {
  await withClient(t, async (client) => {
    await client.request(1, 'initialize', {});
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Followed by a request, so the assertion is about ordering rather than a sleep:
    // if the notification had been answered, it would answer before this one.
    const { result } = await client.request(2, 'ping');
    assert.deepEqual(result, {});
    assert.deepEqual(client.notifications, [], `a notification was answered: ${JSON.stringify(client.notifications)}`);
  });
});

test('closing stdin ends the process, panel running or not', async (t) => {
  // mcode stops the Plugin by closing the MCP pipe. A listener left behind would
  // keep the process alive and leak a port on every session, so the lifecycle is
  // part of the contract rather than an implementation detail.
  await withClient(t, async (client) => {
    await client.request(1, 'initialize', {});
    const started = await client.request(2, 'tools/call', { name: 'trajectory_studio', arguments: {} });
    const content = started.result.structuredContent;
    assert.equal(content.boundTo, '127.0.0.1');
    assert.match(content.url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{32,}$/u, content.url);
    const token = /#t=([A-Za-z0-9_-]+)$/u.exec(content.url)[1];

    // The listener really is serving: an unauthenticated call is refused and an
    // authenticated one is not.
    const refused = await fetch(`http://127.0.0.1:${content.port}/api/meta`, { signal: AbortSignal.timeout(5000) });
    assert.equal(refused.status, 403);
    const accepted = await fetch(`http://127.0.0.1:${content.port}/api/meta`, {
      headers: { 'x-trajectory-token': token },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(accepted.status, 200);

    client.child.stdin.end();
    const exit = await client.exited;
    assert.equal(exit.code, 0, `the server exited with ${JSON.stringify(exit)}`);
  });
});

test('--doctor reports the resolved paths and exits zero', async (t) => {
  const dataDir = await makeFixture();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [SERVER, '--doctor'], {
    env: { ...process.env, MINIMAX_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exit = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  assert.equal(exit, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.node, process.version);
  assert.equal(report.dataDir, dataDir);
  assert.equal(report.sqliteAvailable, true);
  assert.equal(report.sessionsVisible, 2);
  assert.equal(report.latestSession.sessionId, 'sess-protocol');
  // The doctor output is the diagnostic surface a user pastes into an issue, so it
  // has to name the data source it actually opened and state the supported range.
  assert.ok(report.sqlitePath.startsWith(dataDir), report.sqlitePath);
  assert.ok(report.nodeFloor);
  assert.ok(report.nodeVerifiedRange);
});
