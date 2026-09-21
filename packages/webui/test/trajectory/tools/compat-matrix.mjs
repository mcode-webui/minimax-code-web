#!/usr/bin/env node
/**
 * Assert that this Node release behaves the way the manifest claims it does.
 *
 * The compatibility statement in the manifests has two numbers — a floor and a
 * verified range — and a reader has to be able to check both rather than trust
 * them. This script is what makes them checkable: it runs the Plugin suite under
 * whatever Node executes it and fails unless the outcome matches the documented
 * behaviour *for that release*. Wire it into CI if you like, or run it by hand.
 *
 * What it asserts, and why each one is the right assertion:
 *
 *   fail === 0                       A supported release may not fail anything.
 *   skipped === 0                    Inside the verified range the bundled SQLite
 *                                    has FTS5, so nothing may be skipped.
 *   skipped === 1, and it names FTS5 Outside the range (and above the floor) the
 *                                    only permitted skip is the search test that
 *                                    cannot run without FTS5 — and an unrelated
 *                                    skip must not hide behind that allowance.
 *
 * Usage:
 *   node tools/compat-matrix.mjs            # assert the current runtime
 *   node tools/compat-matrix.mjs --list     # print the measured table, no assertion
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { NODE_FLOOR_TEXT, VERIFIED_RANGE_TEXT, isNodeSupported, isWithinVerifiedRange, nodeFloorMessage } from '../../../server/trajectory/node-version.mjs';
import { fixtureHasFts5 } from './fixture.mjs';

const PLUGIN = path.join(import.meta.dirname, '..', '..', '..');

/** Run the suite under `process.execPath` and read the TAP summary. */
function runSuite() {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
    cwd: PLUGIN,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const count = (label) => {
    const match = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output);
    return match ? Number(match[1]) : null;
  };
  const skipped = [...output.matchAll(/^ok \d+ - (.+?)(?: # SKIP ?(.*))?$/gmu)]
    .filter((match) => match[2] !== undefined)
    .map((match) => ({ name: match[1].trim(), reason: (match[2] ?? '').trim() }));
  return {
    status: result.status,
    tests: count('tests'),
    pass: count('pass'),
    fail: count('fail'),
    skippedCount: count('skipped'),
    skipped,
    output,
  };
}

/** The SQLite version the runtime bundles, for the record. */
function bundledSqliteVersion() {
  const db = new DatabaseSync(':memory:');
  try {
    return db.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    db.close();
  }
}

function main() {
  const listOnly = process.argv.includes('--list');
  const node = process.versions.node;

  if (!isNodeSupported(node)) {
    process.stderr.write(nodeFloorMessage(node));
    process.exitCode = 1;
    return;
  }

  const verified = isWithinVerifiedRange(node);
  const fts5 = fixtureHasFts5();
  const expectedSkips = fts5 ? 0 : 1;
  const suite = runSuite();

  process.stdout.write([
    `node            ${node}`,
    `bundled sqlite  ${bundledSqliteVersion()}`,
    `fts5            ${fts5 ? 'present' : 'absent'}`,
    `verified range  ${verified ? 'yes' : 'no'} (${VERIFIED_RANGE_TEXT}, floor ${NODE_FLOOR_TEXT})`,
    `suite           tests=${suite.tests} pass=${suite.pass} fail=${suite.fail} skipped=${suite.skippedCount}`,
    `expected        fail=0 skipped=${expectedSkips}`,
    ...(suite.skipped.length ? [`skipped tests   ${suite.skipped.map((s) => `${s.name} — ${s.reason}`).join('; ')}`] : []),
    '',
  ].join('\n'));

  if (listOnly) return;

  const problems = [];
  if (suite.fail !== 0) problems.push(`${suite.fail} test(s) failed on a supported release`);
  if (suite.skippedCount !== expectedSkips) {
    problems.push(`expected ${expectedSkips} skip(s) with FTS5 ${fts5 ? 'present' : 'absent'}, saw ${suite.skippedCount}`);
  }
  for (const skip of suite.skipped) {
    // The single permitted skip is the search test, and only because FTS5 is missing.
    if (fts5) problems.push(`"${skip.name}" was skipped even though FTS5 is present`);
    else if (!/fts5/iu.test(`${skip.name} ${skip.reason}`)) {
      problems.push(`"${skip.name}" was skipped for a reason unrelated to FTS5: ${skip.reason}`);
    }
  }
  if (verified && !fts5) {
    problems.push(
      `Node ${node} is inside the verified range (${VERIFIED_RANGE_TEXT}) but its SQLite has no FTS5; ` +
      'the range in the manifests is therefore wrong, not the runtime',
    );
  }
  if (suite.tests === null) problems.push('the suite produced no TAP summary, so nothing was verified');

  if (problems.length) {
    process.stderr.write(`\ncompatibility assertion failed on Node ${node}:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.stderr.write(`\n--- suite output (tail) ---\n${suite.output.split('\n').slice(-40).join('\n')}\n`);
    process.exitCode = 1;
  }
}

main();
