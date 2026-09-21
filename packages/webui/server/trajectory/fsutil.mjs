/**
 * Filesystem helpers. Leaf module over `node:fs` plus the path candidates from
 * `config`, so path layout decisions live in exactly one place.
 *
 * This module also owns the containment rule for every file the Plugin reads:
 * after canonicalization, a path has to stay inside the approved data directory.
 * A lexical prefix check cannot express that, because a symlink anywhere along
 * the traversed path keeps the string inside the root while the kernel resolves
 * the file outside it. `containedRealPath` and `openContainedRead` are the only
 * sanctioned way to reach a file, and both canonicalize before they decide.
 */

import { constants as FS, existsSync } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { sessionsCandidates } from './config.mjs';

/**
 * Windows does not define `O_NOFOLLOW`. Declaring the fallback here keeps the
 * platform difference out of every call site; on Windows containment still holds
 * because the path opened is the one `realpath` produced.
 */
export const NO_FOLLOW = FS.O_NOFOLLOW ?? 0;

/** readdir that yields an empty list for a missing or unreadable directory. */
export async function safeReadDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Canonicalize a path that has to exist. Returns null when it does not resolve. */
export async function realPath(target) {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * Canonicalize `target` and confirm it is `root` or sits beneath it.
 *
 * Both sides are canonicalized, so a data directory that is itself reached
 * through a symlink (`~/.minimax` → `/mnt/data/.minimax`) is not mistaken for an
 * escape, while a link planted inside the data directory is still caught.
 *
 * @returns {Promise<string|null>} the canonical path, or null when it escapes,
 *   does not exist, or cannot be resolved.
 */
export async function containedRealPath(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string' || !root) return null;
  const base = await realPath(root);
  if (!base) return null;
  const resolved = await realPath(target);
  if (!resolved) return null;
  if (resolved === base) return resolved;
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

/**
 * Open a file strictly read-only, refusing anything that canonicalizes outside
 * `root` and refusing a symlink at the final component.
 *
 * The canonical path is what gets opened and the size comes back from `fstat`, so
 * the containment decision and the read describe the same inode: there is no
 * window in which the path can be swapped after it was checked. `O_NOFOLLOW`
 * closes the remaining race between `realpath` and `open`.
 *
 * @returns {Promise<{handle: object, size: number, realPath: string}|null}> the
 *   open handle, or null when the path is outside the root, is not a regular
 *   file, is a symlink, or does not exist. Callers own the handle.
 */
export async function openContainedRead(root, target) {
  const resolved = await containedRealPath(root, target);
  if (!resolved) return null;
  let handle;
  try {
    handle = await open(resolved, FS.O_RDONLY | NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, size: info.size, realPath: resolved };
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

/**
 * Find the session-artifact root on this machine.
 *
 * Canonical first; a hit elsewhere means a differently laid-out build, which the
 * caller records rather than hides.
 *
 * @returns {{dir: string, discovered: boolean, found: boolean}}
 */
export function resolveSessionsRoot(dataDir) {
  const candidates = sessionsCandidates(dataDir);
  for (const [index, dir] of candidates.entries()) {
    if (existsSync(dir)) return { dir, discovered: index > 0, found: true };
  }
  return { dir: candidates[0], discovered: false, found: false };
}
