// Discovery-code classification for `listWorkspaceGitWorktrees`, driven by a
// stubbed `git` so the assertions hold on hosts whose Git prints English only.
//
// Why the stub instead of a real repository: the regression this file pins is
// that the classification read Git's human-readable diagnostic. That text is
// translated by Git, so a real-subprocess test only reproduces it on a host
// carrying the matching catalogue. Here the stub returns exactly what a
// localized Git returns, and the code under test must classify it from the
// exit status alone.

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitRunResult } from '../../src/files/git-process.js';

const gitStub = vi.fn<(args: string[], workspace: string) => Promise<GitRunResult>>();

vi.mock('../../src/files/git-process.js', () => ({
  git: (args: string[], workspace: string) => gitStub(args, workspace),
}));

const { listWorkspaceGitWorktrees } = await import('../../src/files/worktrees.js');

const NOT_A_REPO_ZH = 'fatal: 不是 git 仓库（或者任何父目录）：.git';
const NOT_A_REPO_EN = 'fatal: not a git repository (or any of the parent directories): .git';
const NO_WORK_TREE_ZH = 'fatal: 该操作必须在一个工作区中运行';

let workspace: string;

beforeEach(async () => {
  gitStub.mockReset();
  workspace = await mkdtemp(join(tmpdir(), 'mcode-worktree-code-'));
  await mkdir(join(workspace, 'plain-folder'), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Answer the two `rev-parse` probes the discovery performs. */
function stubRevParse(options: {
  toplevel: GitRunResult;
  gitDir: GitRunResult;
}): void {
  gitStub.mockImplementation(async (args) =>
    args.includes('--git-dir') ? options.gitDir : options.toplevel,
  );
}

function failed(code: number, stderr: string): GitRunResult {
  return { code, stdout: '', stderr };
}

describe('listWorkspaceGitWorktrees discovery code', () => {
  it.each([
    ['zh_CN', NOT_A_REPO_ZH],
    ['en_US', NOT_A_REPO_EN],
  ])('classifies a plain folder as not_git_repository under %s diagnostics', async (_tag, stderr) => {
    stubRevParse({
      toplevel: failed(128, stderr),
      gitDir: failed(128, stderr),
    });

    const result = await listWorkspaceGitWorktrees(join(workspace, 'plain-folder'));

    expect(result.success).toBe(false);
    expect(result.code).toBe('not_git_repository');
    expect(result.error).toBe(stderr);
  });

  it('keeps a repository without a work tree out of the not-a-repository bucket', async () => {
    // A bare repository answers `--git-dir` successfully while
    // `--show-toplevel` fails; that is a repository this listing cannot walk,
    // not a folder that was never one.
    stubRevParse({
      toplevel: failed(128, NO_WORK_TREE_ZH),
      gitDir: { code: 0, stdout: '.\n', stderr: '' },
    });

    const result = await listWorkspaceGitWorktrees(workspace);

    expect(result.success).toBe(false);
    expect(result.code).toBe('workspace_unavailable');
  });

  it('falls back to the generic bucket when git could not run at all', async () => {
    // No binary, unusable cwd: neither probe produced a Git verdict, so the
    // discovery must not claim the folder was never a repository.
    gitStub.mockImplementation(async () => ({
      code: 1,
      stdout: '',
      stderr: 'spawn git ENOENT',
      spawnError: 'ENOENT',
    }));

    const result = await listWorkspaceGitWorktrees(workspace);

    expect(result.success).toBe(false);
    expect(result.code).toBe('workspace_unavailable');
  });

  it('still lists the worktrees of a healthy repository', async () => {
    gitStub.mockImplementation(async (args) => {
      if (args.includes('--show-toplevel')) return { code: 0, stdout: `${workspace}\n`, stderr: '' };
      if (args.includes('worktree')) {
        return {
          code: 0,
          stdout: `worktree ${workspace}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n`,
          stderr: '',
        };
      }
      return failed(1, 'unexpected call');
    });

    const result = await listWorkspaceGitWorktrees(workspace);

    expect(result.success).toBe(true);
    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]).toMatchObject({ branch: 'main', isMain: true });
  });
});
