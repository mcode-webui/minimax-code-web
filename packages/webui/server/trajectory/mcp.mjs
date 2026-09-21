/**
 * MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Implemented against the protocol directly so the Plugin stays dependency-free:
 * no node_modules is shipped and nothing needs a build step.
 */

import { createInterface } from 'node:readline';

import { redactPayload, redactPath, redactText } from './redact.mjs';
import { EGRESS_STRING_LIMIT } from './config.mjs';
import { SESSION_KINDS } from './store.mjs';

export const SERVER_NAME = 'mcode-trajectory-studio';
export const SERVER_VERSION = '0.1.1';

/**
 * Protocol versions this server implements, newest first.
 *
 * The initialize response must name a version the server actually supports. Echoing
 * whatever the client asked for would claim support for versions whose behaviour was
 * never implemented — and the two differ in ways that matter here, since JSON-RPC
 * batching exists in 2024-11-05 but was removed in 2025-06-18.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function negotiateProtocolVersion(requested) {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

const DETAIL_LEVELS = ['summary', 'full'];

/**
 * Every tool that only reads. Declaring that lets a client skip its own
 * confirmation prompts for calls that cannot mutate anything.
 */
const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // Reading local session data is a closed-world operation: no outbound requests.
  openWorldHint: false,
});

/**
 * `trajectory_studio` is not read-only, and claiming it was is a real hazard: a
 * client that trusts `readOnlyHint` skips its confirmation prompt, and this call
 * opens a listening socket and publishes a capability URL. It reads nothing that
 * the other tools do not, but starting a listener is a side effect on the
 * environment.
 *
 * It is idempotent — a second call while the panel runs returns the same URL and
 * the same capability, rather than invalidating the page the caller already opened.
 */
const STUDIO = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

export const TOOLS = [
  {
    name: 'trajectory_list',
    annotations: READ_ONLY,
    description:
      'List recent local MiniMax Code sessions from the runtime SQLite projection, with non-content metadata only (no message text). Use this first to find a session ID, then call trajectory_summary or trajectory_get.',
    inputSchema: obj({
      limit: int('Maximum sessions to return.', { minimum: 1, maximum: 200, default: 20 }),
      agent: str('Filter by agent name, for example "mavis", "explore", "worker", "verifier".'),
      kind: str('Filter by session kind.', { enum: SESSION_KINDS }),
      sinceMs: int('Only sessions updated at or after this epoch-millisecond timestamp.', { minimum: 0 }),
      includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
    }),
  },
  {
    name: 'trajectory_summary',
    annotations: READ_ONLY,
    description:
      'Return per-session trajectory statistics for one MiniMax Code session: turns, steps, LLM/tool/decode wall-clock milliseconds, token totals, tool-call and failure counts, compactions, sub-agent tasks, assets, and the trigger-source breakdown. Equivalent to the dsh sessionStats projection. Omit sessionId to use the most recently updated session.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
    }),
  },
  {
    name: 'trajectory_get',
    annotations: READ_ONLY,
    description:
      'Return a page of trajectory records for one session, in insert order. Summary mode returns timing, token usage, roles, turn IDs and tool-call names only. Full mode additionally returns message text, thinking, tool arguments and tool results, redacted and length-bounded; request it only after explicit user consent.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      offset: int('Zero-based record offset.', { minimum: 0, default: 0 }),
      limit: int('Maximum records to return.', { minimum: 1, maximum: 1000, default: 200 }),
      turnId: str('Restrict to one turn ID.'),
      detailLevel: str('Use summary by default.', { enum: DETAIL_LEVELS, default: 'summary' }),
    }),
  },
  {
    name: 'trajectory_search',
    annotations: READ_ONLY,
    description:
      'Full-text search across local session titles, agent names, statuses and workspace paths using the runtime FTS5 index.',
    inputSchema: obj({
      query: str('Search text. Multi-character queries are matched as a phrase.', { minLength: 1, maxLength: 200 }),
      limit: int('Maximum sessions to return.', { minimum: 1, maximum: 200, default: 20 }),
    }, ['query']),
  },
  {
    name: 'trajectory_tasks',
    annotations: READ_ONLY,
    description:
      'List the background tasks and sub-agent dispatches owned by one session, with status, wall-clock duration, the command or objective, the sub-agent name, and the child session ID when a sub-agent ran. This is the nested-tool view for a trajectory.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      limit: int('Maximum tasks to return.', { minimum: 1, maximum: 2000, default: 200 }),
      kind: str('Restrict to one task kind, for example "bash" or "subagent".'),
    }),
  },
  {
    name: 'trajectory_task_output',
    annotations: READ_ONLY,
    description:
      'Read the tail of the captured output for one background task, bounded to the last 16 KiB by default. Use it to explain why a task failed without opening the session directory by hand.',
    inputSchema: obj({
      taskId: str('Exact task ID, as returned by trajectory_tasks.', { minLength: 1 }),
      maxBytes: int('Maximum bytes of trailing output to return.', { minimum: 256, maximum: 262144, default: 16384 }),
    }, ['taskId']),
  },
  {
    name: 'trajectory_studio',
    annotations: STUDIO,
    description:
      'Start (or reuse) the local Trajectory Studio web panel bound to 127.0.0.1 and return its URL. ' +
      'Open that URL with the host built-in browser, verbatim: the fragment carries a per-process ' +
      'capability token that every API route requires, so a URL with the fragment stripped will not ' +
      'load any data. Do not log or share the URL. The panel reads local session data only; starting ' +
      'it opens a loopback listener.',
    inputSchema: obj({
      sessionId: str('Session to focus when the panel opens.'),
      port: int('Preferred TCP port. Omit to reuse the running panel or pick a free one.', { minimum: 1024, maximum: 65535 }),
      stop: { type: 'boolean', description: 'Stop the running panel instead of starting it. Default false.' },
    }),
  },
];

export function createHandler({ store, studio, homeDir }) {
  const warnings = [];
  return { call: (name, args) => callTool({ store, studio, homeDir, warnings }, name, args), warnings };
}

async function resolveSessionId(store, sessionId) {
  if (sessionId) return sessionId;
  const [latest] = store.listSessions({ limit: 1 });
  return latest?.sessionId ?? null;
}

async function callTool(ctx, name, args = {}) {
  const { store, studio, homeDir, warnings } = ctx;
  const detailLevel = DETAIL_LEVELS.includes(args.detailLevel) ? args.detailLevel : 'summary';
  const options = { maxLength: 20000 };

  switch (name) {
    case 'trajectory_list': {
      const sessions = store.listSessions({
        limit: args.limit ?? 20,
        agent: args.agent,
        kind: args.kind,
        sinceMs: args.sinceMs,
        includeArchived: Boolean(args.includeArchived),
      }).map((session) => ({
        ...session,
        workspaceDir: redactPath(session.workspaceDir, { homeDir }),
      }));
      return {
        dataDir: store.dataDir,
        sqlite: Boolean(store.db),
        returned: sessions.length,
        sessions,
        warnings: [...store.warnings, ...warnings],
      };
    }

    case 'trajectory_summary': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      const stats = store.getStats(sessionId);
      if (!stats) throw new Error(`session_not_found:${sessionId}`);
      return { ...stats, workspaceDir: redactPath(stats.workspaceDir, { homeDir }) };
    }

    case 'trajectory_get': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      let page = store.getEvents({
        sessionId,
        offset: args.offset ?? 0,
        limit: args.limit ?? 200,
        turnId: args.turnId,
        detailLevel,
      });
      if (page.events.length === 0 && page.source !== 'sqlite') {
        page = await store.readJsonlEvents({ sessionId, detailLevel });
        page = { ...page, total: page.events.length, nextOffset: null };
      }
      const events = detailLevel === 'full'
        ? page.events.map((event) => redactPayload(event, options))
        : page.events;
      return {
        sessionId,
        detailLevel,
        source: page.source,
        offset: args.offset ?? 0,
        returned: events.length,
        total: page.total,
        nextOffset: page.nextOffset,
        events,
      };
    }

    case 'trajectory_search': {
      const sessions = store.searchSessions({ query: args.query, limit: args.limit ?? 20 })
        .map((session) => ({ ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir }) }));
      // An empty result on a runtime whose SQLite lacks FTS5 looks identical to a
      // query that matched nothing, so say which one it is.
      return {
        query: args.query,
        returned: sessions.length,
        ftsAvailable: store.hasFts,
        ...(store.hasFts ? {} : { note: 'full-text search is unavailable on this Node runtime (bundled SQLite without FTS5)' }),
        sessions,
      };
    }

    case 'trajectory_tasks': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      const tasks = store.listBackgroundTasks(sessionId, { limit: args.limit ?? 200, kind: args.kind });
      return {
        sessionId,
        returned: tasks.length,
        totalMs: tasks.reduce((sum, task) => sum + (task.durationMs ?? 0), 0),
        failed: tasks.filter((task) => task.status === 'failed').length,
        subagents: tasks.filter((task) => task.kind === 'subagent').length,
        tasks,
      };
    }

    case 'trajectory_task_output': {
      const output = await store.readTaskOutput(args.taskId, { maxBytes: args.maxBytes ?? 16384 });
      return { ...output, text: redactText(output.text, { maxLength: 64000 }) };
    }

    case 'trajectory_studio': {
      if (!studio) throw new Error('studio_unavailable');
      if (args.stop) return { stopped: await studio.stop() };
      const started = await studio.start({ sessionId: args.sessionId, port: args.port });
      return {
        url: started.url,
        port: started.port,
        reused: started.reused,
        sessionId: started.sessionId ?? null,
        boundTo: started.boundTo,
        capabilityRequired: true,
        note: 'Open the URL exactly as returned, including the #t= fragment. It is this process\'s capability for the panel; do not log it or share it.',
      };
    }

    default:
      throw new Error(`unknown_tool:${String(name)}`);
  }
}

/* ------------------------------------------------------------- transport -- */

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function handleRpcMessage(handler, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Read-only trajectory inspection for local MiniMax Code sessions. Prefer summary detail; request full detail only with explicit user consent.',
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    return handler.call(name, args).then(
      (value) => {
        // One sweep on the way out, on top of the redaction each read already does,
        // so a field added to a result later cannot leave unredacted. The ceiling is
        // the largest per-field bound any tool applies, so this can only redact.
        const safe = redactPayload(value, { maxLength: EGRESS_STRING_LIMIT });
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
          structuredContent: safe,
        });
      },
      (error) => rpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      }),
    );
  }
  return rpcError(id, -32601, `Method not found: ${String(method)}`);
}

/** Serve MCP over stdio until stdin closes. */
export async function serveStdio(handler, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // Notifications carry no id and must not be answered.
    if (message.id === undefined) {
      handleRpcMessage(handler, message);
      continue;
    }
    const response = await handleRpcMessage(handler, message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
