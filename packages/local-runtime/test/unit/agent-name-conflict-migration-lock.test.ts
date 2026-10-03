import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import lockfile from 'proper-lockfile';
import {
  AGENT_NAME_CONFLICT_MIGRATION_LOCK_RETRIES,
  AGENT_NAME_CONFLICT_MIGRATION_LOCK_STALE_MS,
  withAgentNameConflictMigrationLock,
} from '../../src/persistence/migration/agent-name-conflict-migration.js';

// The lease that gates `mcode acp` startup. `proper-lockfile` represents it as
// a bare directory (`<dataDir>.lock`): mkdir acquires, rmdir releases, and a
// live holder heartbeats the directory mtime every `stale / 2`. A process
// killed between the two leaves the directory behind, and an abandoned lease is
// indistinguishable from a live one except by that mtime.
//
// These tests pin the two properties the outage depended on. An abandoned lease
// must become reapable on a timescale a process launch can wait out, AND a
// lease that really is held must still be respected. Both halves matter: a fix
// that only shortened the window would trade a startup outage for two
// processes inside one critical section.

const cleanups: Array<() => Promise<void | void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-name-conflict-lock-'));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  cleanups.push(async () => {
    await rm(`${dir}.lock`, { recursive: true, force: true });
  });
  return dir;
}

/** Create the lease directory and age its mtime to `ageMs` in the past. */
async function plantAgedLease(dataDir: string, ageMs: number): Promise<void> {
  const leaseDir = `${dataDir}.lock`;
  await mkdir(leaseDir, { recursive: true });
  const when = new Date(Date.now() - ageMs);
  await utimes(leaseDir, when, when);
}

/**
 * An abandoned lease of a fixed, real-world age.
 *
 * The age is ABSOLUTE and deliberately not derived from the stale constant.
 * A fixture aged by `STALE + margin` is reaped instantly under any value of
 * the constant, so it passes whatever the constant is — it cannot fail, and a
 * test that cannot fail is decoration. Five minutes is the shape of the outage
 * this pins: a lease orphaned 15+ minutes earlier by a killed process, still
 * blocking every engine launch.
 */
const ABANDONED_LEASE_AGE_MS = 5 * 60_000;

describe('agent name conflict migration lease', () => {
  it('takes over an abandoned lease promptly instead of burning the whole retry budget', async () => {
    const dataDir = await makeDataDir();
    await plantAgedLease(dataDir, ABANDONED_LEASE_AGE_MS);

    const startedAt = Date.now();
    await expect(withAgentNameConflictMigrationLock(dataDir, () => 'reaped')).resolves.toBe(
      'reaped',
    );

    // Fast, not merely eventually correct. Before the fix a 30-minute stale
    // window made this wait out the whole ~55s retry budget and then throw,
    // because the budget could not outlast the window — which is what killed
    // every engine launch.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('still leaves a lease that is genuinely held alone', async () => {
    const dataDir = await makeDataDir();
    // A real holder, taken with the same library the migration uses, so the
    // lease directory is a genuine one and its mtime is a live heartbeat —
    // which is the ONLY thing that separates a held lease from an abandoned
    // one. This is the half that guards against over-correcting: if the stale
    // window were shortened to the point of reaping a beating lease, the
    // takeover would trade a startup outage for two processes inside one
    // critical section.
    const release = await lockfile.lock(dataDir, {
      stale: AGENT_NAME_CONFLICT_MIGRATION_LOCK_STALE_MS,
    });

    let entered = false;
    const acquisition = withAgentNameConflictMigrationLock(dataDir, () => {
      entered = true;
    });
    // Long enough to prove it is waiting rather than barging in.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(entered).toBe(false);

    // Once the holder releases, the waiter proceeds on its own.
    await release();
    await acquisition;
    expect(entered).toBe(true);
  });

  it('keeps the retry budget long enough to outlast the stale window', async () => {
    // The invariant behind both tests: a waiter must be able to survive one
    // abandoned-lease expiry and then acquire, rather than dying at the moment
    // the lease becomes reapable. With 120 retries at this backoff shape the
    // wait was ~55s against a 30-minute window, so it could only ever lose.
    const { retries, factor, minTimeout, maxTimeout } =
      AGENT_NAME_CONFLICT_MIGRATION_LOCK_RETRIES;
    let total = 0;
    let delay = minTimeout;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      total += delay;
      delay = Math.min(delay * factor, maxTimeout);
    }

    expect(total).toBeGreaterThan(AGENT_NAME_CONFLICT_MIGRATION_LOCK_STALE_MS);
  });
});
