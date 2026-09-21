import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTaskOutput } from '../../server/trajectory/tasks.mjs';
import { findSessionDir, readJsonlEvents } from '../../server/trajectory/jsonl.mjs';
import { openStore } from '../../server/trajectory/store.mjs';

/**
 * Containment canaries.
 *
 * Every file this Plugin reads has to resolve, after canonicalization, to
 * somewhere inside the approved data directory. A lexical `startsWith` check is
 * not enough: a symlink planted anywhere along the traversed path keeps the
 * string inside the root while the kernel resolves it outside. The earlier
 * revision was exploitable exactly that way — a symlinked task directory and a
 * symlinked session directory both read a file outside the data directory — so
 * each of those shapes is pinned here as a canary.
 *
 * Every case therefore asserts two things: the canary never appears in the
 * result, and the read is reported as unavailable. A positive control runs
 * alongside each escape shape, because "refuse everything" would otherwise make
 * the whole file pass.
 */

// Unique strings so a leak cannot be confused with fixture noise, and so the
// assertion can search the whole serialized result rather than one field.
const CANARY_OUTPUT = 'CANARY-OUTSIDE-OUTPUT-LOG-7f31';
const CANARY_MESSAGES = 'CANARY-OUTSIDE-MESSAGES-JSONL-7f31';

const approx = { detailLevel: 'full' };

async function makeFixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'trajectory-containment-'));
  const dataDir = path.join(base, 'data');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(dataDir, 'background-tasks'), { recursive: true });
  await mkdir(path.join(dataDir, 'v2', 'sessions', '2026', '01', '02'), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(path.join(outside, 'output.log'), `${CANARY_OUTPUT}\n`, 'utf8');
  await writeFile(
    path.join(outside, 'messages.jsonl'),
    `${JSON.stringify({
      message_id: 'outside-1',
      turn_id: 'outside-turn',
      message: { role: 'user', content: [{ type: 'text', text: CANARY_MESSAGES }] },
    })}\n`,
    'utf8',
  );

  const taskDir = (name) => path.join(dataDir, 'background-tasks', name);
  const dayDir = path.join(dataDir, 'v2', 'sessions', '2026', '01', '02');
  const sessionDir = (name) => path.join(dayDir, name);

  return { base, dataDir, outside, taskDir, dayDir, sessionDir };
}

function storeFor(dataDir) {
  return openStore({ dataDir });
}

/** Assert a task-output read refused, without naming how. */
function assertRefused(output) {
  assert.equal(output.available, false, `task output was readable: ${JSON.stringify(output)}`);
  assert.equal(JSON.stringify(output).includes(CANARY_OUTPUT), false, 'canary leaked into the task result');
}

/** Assert a JSONL read refused, without naming how. */
function assertRefusedEvents(result) {
  assert.equal(result.source, 'unavailable', `jsonl source was ${result.source}`);
  assert.equal(result.events.length, 0, 'events were returned from outside the root');
  assert.equal(JSON.stringify(result).includes(CANARY_MESSAGES), false, 'canary leaked into the events');
}

/* ------------------------------------------------------- task output.log -- */

test('a symlinked task directory cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(f.outside, f.taskDir('escape-dir'));
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'escape-dir'));
});

test('a two-hop symlinked task directory cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(f.outside, f.taskDir('hop-2'));
  await symlink(f.taskDir('hop-2'), f.taskDir('hop-1'));
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'hop-1'));
});

test('a task directory symlinked by relative path cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(path.relative(path.join(f.dataDir, 'background-tasks'), f.outside), f.taskDir('rel'));
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'rel'));
});

test('a symlinked output.log cannot escape the data directory', async () => {
  const f = await makeFixture();
  await mkdir(f.taskDir('link-file'), { recursive: true });
  await symlink(path.join(f.outside, 'output.log'), path.join(f.taskDir('link-file'), 'output.log'));
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'link-file'));
});

test('a symlinked task root cannot escape the data directory', async () => {
  const f = await makeFixture();
  // Replace the whole approved root with a link to the outside directory, so the
  // lexical path stays inside the data directory while the kernel resolves it
  // outside. Canonicalizing only the leaf would still let this through.
  await mkdir(path.join(f.outside, 'redirected'), { recursive: true });
  await writeFile(path.join(f.outside, 'redirected', 'output.log'), `${CANARY_OUTPUT}\n`, 'utf8');
  await rm(path.join(f.dataDir, 'background-tasks'), { recursive: true, force: true });
  await symlink(path.join(f.outside, 'redirected'), path.join(f.dataDir, 'background-tasks'), 'dir');
  const root = path.join(f.dataDir, 'background-tasks');
  assert.ok(root.startsWith(f.dataDir), 'sanity: the root is lexically inside the data directory');
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'redirected'));
});

test('the positive control still reads a task directory inside the data directory', async () => {
  const f = await makeFixture();
  await mkdir(f.taskDir('legit'), { recursive: true });
  await writeFile(path.join(f.taskDir('legit'), 'output.log'), 'legitimate output\n', 'utf8');
  const output = await readTaskOutput(storeFor(f.dataDir), 'legit');
  assert.equal(output.available, true, JSON.stringify(output));
  assert.equal(output.text, 'legitimate output\n');
});

/* ---------------------------------------------------------- messages.jsonl */

test('a symlinked session directory cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(f.outside, f.sessionDir('20260102-aaaa1111'));
  const store = storeFor(f.dataDir);
  const found = await findSessionDir(store, 'aaaa1111');
  assert.equal(found, null, `findSessionDir returned ${found}`);
  assertRefusedEvents(await readJsonlEvents(store, { sessionId: 'aaaa1111', ...approx }));
});

test('a two-hop symlinked session directory cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(f.outside, f.sessionDir('20260102-hop2bbbb'));
  await symlink(f.sessionDir('20260102-hop2bbbb'), f.sessionDir('20260102-hop1bbbb'));
  const store = storeFor(f.dataDir);
  assert.equal(await findSessionDir(store, 'hop1bbbb'), null);
  assertRefusedEvents(await readJsonlEvents(store, { sessionId: 'hop1bbbb', ...approx }));
});

test('a symlinked messages.jsonl cannot escape the data directory', async () => {
  const f = await makeFixture();
  await mkdir(f.sessionDir('20260102-filecccc'), { recursive: true });
  await symlink(
    path.join(f.outside, 'messages.jsonl'),
    path.join(f.sessionDir('20260102-filecccc'), 'messages.jsonl'),
  );
  const store = storeFor(f.dataDir);
  assertRefusedEvents(await readJsonlEvents(store, { sessionId: 'filecccc', ...approx }));
});

test('a session directory reached through a symlinked day cannot escape the data directory', async () => {
  const f = await makeFixture();
  const month = path.join(f.dataDir, 'v2', 'sessions', '2026', '02');
  await writeFile(path.join(f.outside, 'messages.jsonl'), `${JSON.stringify({
    message_id: 'x',
    message: { role: 'user', content: [{ type: 'text', text: CANARY_MESSAGES }] },
  })}\n`);
  await symlink(f.outside, path.join(f.outside, 'day'));
  await mkdir(month, { recursive: true });
  await symlink(path.join(f.outside, 'day'), path.join(month, '03'));
  const store = storeFor(f.dataDir);
  assert.equal(await findSessionDir(store, 'whatever'), null);
});

test('the positive control still reads a messages.jsonl inside the data directory', async () => {
  const f = await makeFixture();
  const dir = f.sessionDir('20260102-legitddd');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), `${JSON.stringify({
    message_id: 'inside-1',
    turn_id: 't1',
    message: { role: 'user', content: [{ type: 'text', text: 'legitimate message body' }] },
  })}\n`, 'utf8');
  const store = storeFor(f.dataDir);
  // `findSessionDir` returns the canonical directory — that is the whole point of
  // the containment check — so the expectation has to be canonical too. On macOS
  // `/var` resolves to `/private/var`, and on Windows a short `RUNNER~1` temp path
  // resolves to its long form; comparing against the raw temporary path passes only
  // on a host where canonicalizing is the identity.
  assert.equal(await findSessionDir(store, 'legitddd'), await realpath(dir));
  const result = await readJsonlEvents(store, { sessionId: 'legitddd', ...approx });
  assert.equal(result.source, 'jsonl');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].content, 'legitimate message body');
});
