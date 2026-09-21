/**
 * The JSONL fallback.
 *
 * The projection indexes sessions as they are written, so a very recent session
 * may not be present yet. For those, the Plugin falls back to the session's own
 * `messages.jsonl` artifact — folded into the same event shape as SQLite, minus
 * every timing field the artifact never recorded.
 *
 * Every path here is reached through `fsutil`, which canonicalizes before it
 * decides: a session directory or a `messages.jsonl` reached through a symlink is
 * refused rather than read, because the lexical path alone cannot prove the file
 * is inside the approved data directory.
 */

import path from 'node:path';

import { num, parseJson } from './json.mjs';
import { containedRealPath, openContainedRead, safeReadDir } from './fsutil.mjs';
import { LIMITS } from './config.mjs';

/**
 * Locate a session's artifact directory by ID suffix, without leaving the root.
 *
 * Every level is filtered to real directories first: a dirent reports a symlink as
 * neither a file nor a directory, so a linked directory never matches. The
 * surviving candidate is then canonicalized and has to stay inside the data
 * directory, because a link anywhere above it would otherwise resolve a
 * `messages.jsonl` outside the approved area. Only the canonical path is
 * returned, so a caller cannot re-derive the lexical one.
 *
 * @returns {Promise<string|null>} canonical session directory, or null.
 */
export async function findSessionDir(store, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  const root = store.sessionsRoot;
  let years;
  try {
    years = await safeReadDir(root);
  } catch {
    return null;
  }
  const dirsIn = async (dir) => (await safeReadDir(dir)).filter((entry) => entry.isDirectory());
  for (const year of years.filter((entry) => entry.isDirectory())) {
    const yearPath = path.join(root, year.name);
    for (const month of await dirsIn(yearPath)) {
      const monthPath = path.join(yearPath, month.name);
      for (const day of await dirsIn(monthPath)) {
        const dayPath = path.join(monthPath, day.name);
        for (const session of await dirsIn(dayPath)) {
          if (!session.name.endsWith(sessionId)) continue;
          const dir = await containedRealPath(store.dataDir, path.join(dayPath, session.name));
          if (dir) return dir;
        }
      }
    }
  }
  return null;
}

/** Fold a `messages.jsonl` artifact into the same event shape as SQLite. */
export async function readJsonlEvents(store, { sessionId, limit = 1000, detailLevel = 'summary' } = {}) {
  const dir = await findSessionDir(store, sessionId);
  if (!dir) return { events: [], source: 'unavailable' };
  // The descriptor that containment approved is the one the stream reads, so the
  // path cannot be re-pointed at another inode between the check and the read.
  const opened = await openContainedRead(store.dataDir, path.join(dir, 'messages.jsonl'));
  if (!opened) return { events: [], source: 'unavailable' };
  // `autoClose` hands the descriptor to the stream, so destroying it — on success
  // and on a mid-stream error alike — is what releases the handle.
  const stream = opened.handle.createReadStream({ encoding: 'utf8' });
  try {
    return { events: await foldJsonl(stream, { limit, detailLevel }), source: 'jsonl' };
  } finally {
    stream.destroy();
  }
}

/** Project one artifact stream into the SQLite-shaped event list. */
async function foldJsonl(stream, { limit, detailLevel }) {
  const events = [];
  let turnCursor = null;
  let index = 0;
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim() || Buffer.byteLength(line) > LIMITS.jsonlLineBytes) continue;
      if (events.length >= limit) continue;
      const record = parseJson(line);
      if (!record) continue;
      const message = record.message && typeof record.message === 'object' ? record.message : {};
      const parts = Array.isArray(message.content) ? message.content : [];
      const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('');
      const thinking = parts.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join('');
      const toolUses = parts.filter((part) => part?.type === 'toolCall');
      const usage = message.usage && typeof message.usage === 'object' ? message.usage : null;
      if (record.turn_id) turnCursor = record.turn_id;
      const event = {
        index: index++,
        source: 'jsonl',
        msgId: record.message_id ?? null,
        turnId: record.turn_id ?? turnCursor,
        role: message.role ?? null,
        sourceKind: null,
        kind: null,
        finishReason: message.stopReason ?? null,
        createdAtMs: num(message.timestamp),
        thinkingDurationMs: null,
        requestDurationMs: null,
        inputKind: message.role === 'user' ? 'human' : 'unknown',
        originType: null,
        goalId: null,
        usage: usage ? {
          inputTokens: num(usage.input),
          outputTokens: num(usage.output),
          cacheReadTokens: num(usage.cacheRead),
          totalTokens: num(usage.totalTokens),
          contextWindowTokens: null,
        } : null,
        contextUsage: null,
        toolCallCount: toolUses.length || (message.toolName ? 1 : 0),
        failureCount: message.isError ? 1 : 0,
        hasThinking: thinking.length > 0,
        contentLength: text.length,
        model: message.model ?? null,
      };
      const callNames = toolUses.length
        ? toolUses.map((call) => ({ name: call.name ?? null, id: call.id ?? null }))
        : (message.toolName ? [{ name: message.toolName, id: message.toolCallId ?? null }] : []);
      event.toolCalls = callNames.length
        ? callNames.map((call, position) => {
            const projected = {
              ...call,
              status: message.isError && position === 0 ? 3 : (message.toolName ? 2 : null),
              ok: !(message.isError && position === 0),
              durationMs: null,
              taskId: null,
              taskStatus: null,
              agentName: null,
              childSessionId: null,
              hasOutput: false,
            };
            if (detailLevel === 'full') {
              projected.args = toolUses[position]?.arguments ?? null;
              projected.result = position === 0 && message.content ? message.content : null;
              projected.description = null;
            }
            return projected;
          })
        : null;
      if (detailLevel === 'full') {
        event.content = text || null;
        event.thinking = thinking || null;
      }
      events.push(event);
    }
  }
  return events;
}

/** Read a session's `manifest.json`, if the artifact directory has one. */
export async function readManifest(store, sessionDir) {
  const opened = await openContainedRead(store.dataDir, path.join(sessionDir, 'manifest.json'));
  if (!opened) return null;
  try {
    return parseJson(await opened.handle.readFile('utf8'));
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}
