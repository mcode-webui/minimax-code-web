// Locale parity for the worktree discovery codes, against a real `git`.
//
// The discovery used to recognise "not a repository" by matching Git's
// English diagnostic, so on a host whose Git speaks the user's language every
// plain folder degraded to the generic `workspace_unavailable` bucket. These
// cases run the real subprocess under a fixed locale and assert the discovery
// code, never the wording — a Git build without the requested catalogue simply
// stays in English and the expectation still holds.

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listWorkspaceGitWorktrees } from '../../src/files/worktrees.js';

const execFile = promisify(execFileCallback);

const LOCALES = ['zh_CN.utf8', 'en_US.UTF-8'];

let fixture: string;
let plainFolder: string;
let repository: string;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'mcode-worktree-locale-'));
  plainFolder = join(fixture, 'plain-folder');
  repository = join(fixture, 'repository');
  await mkdir(plainFolder, { recursive: true });
  await mkdir(repository, { recursive: true });
  await git(repository, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  await git(repository, [
    '-c',
    'user.name=P21',
    '-c',
    'user.email=p21@example.test',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'initial',
  ]);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile('git', args, { cwd, encoding: 'utf-8' });
}

/**
 * `git` translates its diagnostics from `LC_ALL`/`LANG`/`LC_MESSAGES`; the
 * discovery inherits this process's environment, so pinning the variables here
 * is what fixes the subprocess locale. Restoration is unconditional: another
 * case in this file must not inherit the previous locale.
 */
async function withLocale<T>(locale: string, run: () => Promise<T>): Promise<T> {
  const saved = ['LANG', 'LC_ALL', 'LC_MESSAGES'].map((key) => [key, process.env[key]] as const);
  process.env.LANG = locale;
  process.env.LC_ALL = locale;
  delete process.env.LC_MESSAGES;
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('listWorkspaceGitWorktrees locale parity', () => {
  it.each(LOCALES)('reports a plain folder as not_git_repository under %s', async (locale) => {
    const result = await withLocale(locale, () => listWorkspaceGitWorktrees(plainFolder));

    expect(result.success).toBe(false);
    expect(result.code).toBe('not_git_repository');
    expect(result.error).toBeTruthy();
  });

  it.each(LOCALES)('lists the worktrees of a repository under %s', async (locale) => {
    const result = await withLocale(locale, () => listWorkspaceGitWorktrees(repository));

    expect(result.success).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]).toMatchObject({ branch: 'main', isMain: true, isActive: true });
  });

  it('produces the same codes regardless of the locale in force', async () => {
    const perLocale = [];
    for (const locale of LOCALES) {
      perLocale.push(
        (await withLocale(locale, () => listWorkspaceGitWorktrees(plainFolder))).code,
        (await withLocale(locale, () => listWorkspaceGitWorktrees(repository))).code,
      );
    }
    expect(perLocale).toEqual(['not_git_repository', undefined, 'not_git_repository', undefined]);
  });
});
