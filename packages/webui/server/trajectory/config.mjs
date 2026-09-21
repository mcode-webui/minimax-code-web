/**
 * Configuration: where the data lives, and every bound the rest of the server
 * enforces. Leaf module — imports nothing, so anything may import it.
 */

import path from 'node:path';

/**
 * The user's home directory, resolved the way the runtime resolves it.
 *
 * Windows commonly sets only USERPROFILE, so falling back to it is what keeps
 * home-relative paths (and home-prefix redaction) working on every platform.
 */
export function resolveHomeDir(env = process.env, override) {
  const value = override || env.HOME || env.USERPROFILE || '';
  return String(value).trim() ? path.resolve(String(value).trim()) : null;
}

/** Resolve the runtime data directory, in the order the runtime itself uses. */
export function resolveDataDir(env = process.env, homeDir) {
  const fromEnv = env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const home = resolveHomeDir(env, homeDir);
  if (!home) throw new Error('cannot resolve data directory: set MINIMAX_DATA_DIR or HOME');
  return path.join(home, '.minimax');
}

/**
 * Where the runtime may keep its data inside the data directory.
 *
 * The first entry is the layout every known build uses and is what the Plugin
 * writes its diagnostics against. The rest exist so a build that lays its files
 * out differently is still readable instead of silently degrading: nothing here is
 * discovered by scanning the tree, because the data directory also holds tens of
 * thousands of unrelated task directories.
 */
const SQLITE_RELATIVE = [
  ['v2', 'sqlite', 'runtime-state.sqlite'],
  ['sqlite', 'runtime-state.sqlite'],
  ['v2', 'runtime-state.sqlite'],
  ['runtime-state.sqlite'],
  ['v3', 'sqlite', 'runtime-state.sqlite'],
];

const SESSIONS_RELATIVE = [
  ['v2', 'sessions'],
  ['sessions'],
  ['v3', 'sessions'],
];

export function sqliteCandidates(dataDir) {
  return SQLITE_RELATIVE.map((parts) => path.join(dataDir, ...parts));
}

export function sessionsCandidates(dataDir) {
  return SESSIONS_RELATIVE.map((parts) => path.join(dataDir, ...parts));
}

/** The canonical projection path (first candidate). */
export function sqlitePath(dataDir) {
  return sqliteCandidates(dataDir)[0];
}

/** The canonical session-artifact root (first candidate). */
export function sessionsRoot(dataDir) {
  return sessionsCandidates(dataDir)[0];
}

/** Background-task output root. A single layout across every known build. */
export function backgroundTasksRoot(dataDir) {
  return path.join(dataDir, 'background-tasks');
}

/** Folding limits. */
export const LIMITS = Object.freeze({
  sessions: { min: 1, max: 500, default: 20 },
  events: { min: 1, max: 1000, default: 200 },
  tasks: { min: 1, max: 2000, default: 200 },
  search: { min: 1, max: 200, default: 20 },
  timeline: 6000,
  taskOutputBytes: { min: 256, max: 256 * 1024, default: 16 * 1024 },
  jsonlLineBytes: 2 * 1024 * 1024,
});

/** Per-session folded totals kept warm; browsing revisits sessions constantly. */
export const CACHE_ENTRIES = 96;

/**
 * Ceiling for a single string in a swept outbound payload.
 *
 * Deliberately the largest bound any surface already applies, so the egress sweep
 * can only ever redact. A smaller ceiling here would silently re-truncate content
 * whose own limit is larger — the task-output tail, for instance.
 */
export const EGRESS_STRING_LIMIT = LIMITS.taskOutputBytes.max;

/** Records fetched per MCP page and per web request. */
export const DETAIL_LEVELS = Object.freeze(['summary', 'full']);

/** `tool_call_status` 2 is the runtime's success code. */
export const TOOL_STATUS_OK = 2;

/** Input provenance, used to separate a person's words from injected context. */
export const INPUT_KINDS = Object.freeze(['human', 'injected', 'unknown']);

export function clamp(value, { min, max, default: fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
