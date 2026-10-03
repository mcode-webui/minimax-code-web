// acp.mjs — mcode acp JSON-RPC client (Node stdio, zero deps)
//
// Spawns `mcode acp` (Agent Client Protocol server) and exposes:
//   - request(method, params)  → Promise<result>
//   - notify(method, params)   → fire-and-forget
//   - on(event, handler)       → subscribe to server notifications
//   - newSession(cwd)          → {sessionId}
//   - loadSession(sid, cwd)    → {} (attach to any TUI session, 0.1.3+)
//   - listSessions()           → {sessions: [{sessionId, cwd, title, updatedAt}], nextCursor}
//   - prompt(sid, text, cbs)   → full lifecycle: init → stream chunks → stopReason
//   - stop()                   → kill subprocess
//
// The engine also sends requests in the other direction (permission
// prompts, elicitation forms, terminal and file operations). Every one is
// answered — see `_answerClientRequest` and `CLIENT_CAPABILITIES` below.
//
// Event types from mcode 0.1.3 (verified via probe):
//   - session/update {sessionUpdate: "available_commands_update"} → list of slash cmds
//   - session/update {sessionUpdate: "agent_thought_chunk"} → {messageId, content: {type, text}}
//   - session/update {sessionUpdate: "agent_message_chunk"} → {messageId, content: {type, text}}
//   - prompt response: {stopReason: "end_turn" | "max_tokens" | "refusal" | ...}

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WEBUI_ROOT } from './server/lib/layout.js'

const DEFAULT_CWD = process.cwd()

// JSON-RPC error code for "the recipient does not implement this method"
// (JSON-RPC 2.0 §5.1). Used to decline engine→client requests.
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INTERNAL_ERROR = -32603

// Bounded tail of the engine subprocess's stderr.
//
// The engine reports its OWN failures on stderr — a failed migration, a
// lock it could not take, a config it refused to parse — and the crash
// alert is raised by the webui, not by the engine. Without a tail the
// whole diagnostic dies with the pipe: the operator sees only
// `mcode acp exited (code=1)` and cannot tell a lock contention from a
// missing binary. Both bounds are needed: bytes alone let one long
// stack trace push the real message out of the window, and lines alone
// let one pathological line carry megabytes.
const STDERR_TAIL_MAX_BYTES = 2048
const STDERR_TAIL_MAX_LINES = 20
const STDERR_TRUNCATION_MARKER = '[acp stderr truncated, showing the tail]'

/**
 * The capabilities this client advertises in `initialize`.
 *
 * The engine reads them off `clientCapabilities` — the ACP v1
 * `InitializeRequest` field (`packages/tui/src/acp/agent.ts:434`).
 * Sending them under any other name negotiates nothing, and the engine
 * prices each capability by what it switches on:
 *
 * | Capability | Switches on | webui consumes it? |
 * | --- | --- | --- |
 * | `plan` | the `plan_update` projection (`agent.ts:1328` → `agent.ts:1356`) | yes — `streamAcpPrompt` writes `cs.plan` (`server/lib/mcode-acp.js:1138`), the plan modal reads it |
 * | `elicitation.form` | the `elicitation/create` request path (`acp/interactions.ts:607`) | no — there is no form UI to put a questionnaire on |
 * | `auth.terminal` | `authMethods` in the initialize response (`agent.ts:455`) | no — there is no terminal to run `mcode login` in |
 * | `_meta['minimax-code/extensions']` | the goal / queue / delegation notifications (`acp/extensions.ts:277`) | no — no handler subscribes to those method names |
 *
 * A capability is a promise to answer, so this list carries only what
 * the webui really consumes. Advertising the other three would buy
 * traffic the webui drops on the floor, and the engine's fail-closed
 * handling of an unanswered `elicitation/create` dismisses the Runtime
 * questionnaire outright (`acp/interactions.ts:647`).
 */
export const CLIENT_CAPABILITIES = Object.freeze({ plan: {} })

// esbuild inlines every workspace module into the webui entry, so
// `import.meta.url` math is the entry's URL for every module here.
// WEBUI_ROOT is the single source of truth that pins the layout
// (packages/webui/ in source, dist/webui/ in the bundle), so the
// repo-cli path resolves to <repo>/dist/cli.js in either layout.
function resolveMcodeCmd() {
  if (process.env.MCODE_CMD) return process.env.MCODE_CMD
  const self = process.env.MCODE_WEBUI_SELF_ENTRY
  if (self && existsSync(self)) return self
  // <WEBUI_ROOT>/../../dist/cli.js — webui lives at packages/webui/ (source)
  // or dist/webui/ (bundled), so two levels up always lands on the repo root.
  const repoCli = resolve(WEBUI_ROOT, '..', '..', 'dist', 'cli.js')
  if (existsSync(repoCli)) return repoCli
  if (process.platform === 'win32') {
    const p = join(homedir(), '.minimax-code', 'mcode.cmd')
    if (existsSync(p)) return p
  }
  return 'mcode'
}

export class McodeAcpClient extends EventEmitter {
  constructor({ mcodeCmd = 'mcode', cwd = DEFAULT_CWD, debug = false, clientRequest = null } = {}) {
    super()
    this.mcodeCmd = mcodeCmd
    this.cwd = cwd
    this.debug = debug
    this.clientRequest = clientRequest
    this.child = null
    this.buf = ''
    this.nextId = 0
    this.pending = new Map()  // id → {resolve, reject, method}
    this.capabilities = null
    this.started = false
    // `_alive` (not `alive`) because every existing caller gates on it as a
    // truth signal for "this client still owns a usable subprocess". The
    // process-level exit handler below flips it back to false, so a stale
    // singleton (the previous PR's bug: `_mcodeAcpSingleton.alive` always
    // undefined) is now actually detected and replaced on the next call.
    this._alive = false
    // Bounded stderr tail (see STDERR_TAIL_MAX_BYTES). Reset per
    // `start()` because each start is a different subprocess.
    this._stderrTail = ''
    this._stderrTruncated = false
  }

  get alive() {
    return this._alive && this.child !== null && this.started === true
  }

  /**
   * The engine subprocess's stderr, bounded to the last ~2KB / ~20 lines,
   * prefixed with a truncation marker when anything was dropped.
   *
   * `''` when the engine wrote nothing to stderr — a caller reporting a
   * crash omits the field rather than attaching an empty string, so the
   * alert it builds keeps the shape it had before this existed.
   */
  get stderrTail() {
    if (!this._stderrTail) return ''
    const lines = this._stderrTail.split('\n')
    const kept = lines.slice(-STDERR_TAIL_MAX_LINES).join('\n')
    return this._stderrTruncated ? STDERR_TRUNCATION_MARKER + '\n' + kept : kept
  }

  async start() {
    if (this.started) return this.capabilities
    // Windows .cmd shim handling: Node 22+ rejects `spawn('mcode.cmd', { shell:false })`
    // with EINVAL (no direct CreateProcess for .cmd). spawn(cmd.exe, ['/c', mcode.cmd])
    // works because cmd.exe execs the shim without printing the Windows banner that
    // shell:true or '/c mcode' would emit into stdout and corrupt the JSON parse.
    // On Linux/macOS, plain `spawn('mcode')` walks PATH. .js/.mjs entries run under
    // process.execPath on every platform.
    const resolved = resolveMcodeCmd()
    // A new subprocess gets a new tail: a stale line from a previous
    // process would misattribute its failure to this one.
    this._stderrTail = ''
    this._stderrTruncated = false
    let cmd, args
    if (/\.(js|mjs)$/i.test(resolved)) {
      cmd = process.execPath
      args = [resolved, 'acp']
    } else if (process.platform === 'win32') {
      cmd = 'cmd.exe'
      args = ['/c', resolved, 'acp']
    } else {
      cmd = resolved
      args = ['acp']
    }
    this.child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    // Node 24 does NOT emit 'exit' on spawn failure (ENOENT when mcode is
    // not installed) — only 'error' + 'close'. If pending requests were
    // rejected only in 'exit', request('initialize') would hang forever,
    // taking the whole /api/state await chain with it. Hook all three
    // signals; _rejectAllPending is idempotent (cleared map → no-op).
    this.child.on('error', (e) => {
      this._rejectAllPending(new Error(`mcode acp child error: ${e.message}`))
      // Bare emit('error') with no listener throws Unhandled 'error'
      // event in Node's EventEmitter — embedders without a global handler
      // would crash the process. Only re-emit when someone is listening.
      if (this.listenerCount('error') > 0) this.emit('error', e)
      else console.error(`[acp] mcode acp child error: ${e.message}`)
    })
    this.child.on('exit', (code, signal) => {
      this._alive = false
      this.started = false
      this.emit('exit', { code, signal })
      this._rejectAllPending(new Error(`mcode acp exited (code=${code} signal=${signal})`))
    })
    this.child.on('close', (code, signal) => {
      // 'close' fires after every child termination, including the
      // ENOENT spawn-failure path that skips 'exit'.
      this._alive = false
      this.started = false
      this._rejectAllPending(new Error(`mcode acp closed (code=${code} signal=${signal})`))
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this._onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (c) => this._onStderr(c))
    this.capabilities = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'mcode-webui', version: '0.1.0' },
      clientCapabilities: CLIENT_CAPABILITIES,
    })
    this.started = true
    this._alive = true
    return this.capabilities
  }

  get cmd() {
    return process.platform === 'win32' ? resolveMcodeCmd() : 'mcode'
  }

  // Reject every pending request. Idempotent (calling on an already-
  // cleared map is a no-op). Called from every child-death signal so
  // awaiting callers always settle, never hang.
  _rejectAllPending(err) {
    for (const [, p] of this.pending) {
      p.reject(err)
    }
    this.pending.clear()
  }

  // Record the engine's stderr for the crash alert, and mirror it live
  // in debug mode (the dev-loop behavior this handler had before the
  // tail existed — unchanged). The tail is kept regardless of `debug`:
  // in production nobody is reading the server's own stderr, which is
  // precisely why the engine's message has to travel inside the alert.
  _onStderr(chunk) {
    if (this.debug) process.stderr.write('[acp stderr] ' + chunk)
    const next = this._stderrTail + chunk
    if (next.length > STDERR_TAIL_MAX_BYTES) {
      this._stderrTail = next.slice(-STDERR_TAIL_MAX_BYTES)
      this._stderrTruncated = true
    } else {
      this._stderrTail = next
    }
  }

  _onData(chunk) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      this._dispatch(line)
    }
  }

  _dispatch(line) {
    let msg
    try { msg = JSON.parse(line) } catch (e) {
      if (this.debug) process.stderr.write('[acp] non-json line: ' + line + '\n')
      return
    }
    if (typeof msg.id !== 'undefined' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'acp error'), { data: msg.error }))
        else p.resolve(msg.result)
      }
      return
    }
    if (msg.method) {
      // A message carrying an id, a method and neither a result nor an
      // error is a REQUEST from the engine, not a notification. JSON-RPC
      // ids are per-direction, so `msg.id` may repeat an id this client
      // used for its own outbound call — the two spaces never meet, and
      // answering with the engine's own id is exactly what it waits for.
      if (msg.id !== undefined && msg.id !== null) {
        this._answerClientRequest(msg)
        return
      }
      this.emit('notification', msg)
      if (msg.method === 'session/update' && msg.params?.update) {
        const u = msg.params.update
        this.emit('sessionUpdate', u)
        if (u.sessionUpdate) this.emit(u.sessionUpdate, u)
      } else {
        this.emit(msg.method, msg.params)
      }
    }
  }

  /**
   * Answer one engine→client request.
   *
   * `clientRequest(method, params)` is the policy seam: return the JSON-RPC
   * result, or a promise for it. With no handler installed every request is
   * declined, and that is deliberate rather than a placeholder:
   *
   *   - Silence is not neutral. The engine awaits these requests with only
   *     a cancellation signal (`packages/tui/src/acp/interactions.ts:562`),
   *     so an unanswered one holds an interaction-scheduler slot for the
   *     life of the connection, and the pending queue overflowing closes
   *     the whole ACP connection (`interactions.ts:242`).
   *   - Declining is the engine's own outcome, not a new one: a request that
   *     throws resolves to `decision = 'deny'`
   *     (`interactions.ts:581`) and a questionnaire that cannot be answered
   *     is dismissed fail-closed (`interactions.ts:647`).
   *
   * A JSON-RPC error — rather than a synthetic "cancelled" result — says
   * plainly that this client never considered the question, and carries the
   * method name into the engine's log.
   */
  _answerClientRequest(msg) {
    if (!this.clientRequest) {
      console.warn(`[acp] declined unhandled client request: ${msg.method}`)
      this._writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `mcode-webui handles no client requests; ${msg.method} is not implemented`,
        },
      })
      return
    }
    let answer
    try {
      answer = this.clientRequest(msg.method, msg.params)
    } catch (error) {
      this._writeClientRequestError(msg.id, error)
      return
    }
    Promise.resolve(answer).then(
      (result) => this._writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: result === undefined ? null : result,
      }),
      (error) => this._writeClientRequestError(msg.id, error),
    )
  }

  _writeClientRequestError(id, error) {
    const code = Number.isInteger(error?.code) ? error.code : JSON_RPC_INTERNAL_ERROR
    const message = error instanceof Error ? error.message : String(error)
    this._writeMessage({ jsonrpc: '2.0', id, error: { code, message } })
  }

  // Single choke point for every line written to the engine. Answering a
  // request must never throw into `_dispatch` — an exception there would
  // abandon the rest of the chunk's messages — so a dead child degrades to
  // "the line was not sent" and the pending request still settles through
  // `_rejectAllPending`.
  _writeMessage(msg) {
    if (!this.child) return false
    try {
      this.child.stdin.write(JSON.stringify(msg) + '\n')
      return true
    } catch (e) {
      if (this.debug) process.stderr.write(`[acp] write failed: ${e.message}\n`)
      return false
    }
  }

  request(method, params) {
    if (!this.child) return Promise.reject(new Error('acp not started'))
    const id = ++this.nextId
    const msg = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      if (!this._writeMessage(msg)) {
        this.pending.delete(id)
        reject(new Error(`acp write failed: ${this.mcodeCmd} is not accepting input`))
      }
    })
  }

  notify(method, params) {
    if (!this.child) throw new Error('acp not started')
    return this._writeMessage({ jsonrpc: '2.0', method, params })
  }

  async newSession(cwd = this.cwd) {
    return await this.request('session/new', { cwd, mcpServers: [] })
  }

  async loadSession(sessionId, cwd = this.cwd) {
    return await this.request('session/load', { sessionId, cwd, mcpServers: [] })
  }

  async listSessions(cursor) {
    return await this.request('session/list', cursor ? { cursor } : {})
  }

  // onChunk callback shape:
  //   { kind: 'thought' | 'message' | 'tool_call' | 'tool_update' |
  //           'usage' | 'plan_update' | 'plan_removed' | 'mode_update' |
  //           'goal_update' | 'config_option_update' |
  //           'session_info_update' | 'other' | 'done',
  //     text?, update?, stopReason?, usage? }
  //   tool_call / tool_update / usage / plan_update / mode_update /
  //   goal_update / config_option_update / session_info_update pass
  //   the raw session/update payload as `update`. done carries
  //   stopReason + usage aggregated from the response.
  async prompt(sessionId, promptOrBlocks, onChunk) {
    // NOTE: listeners are added per-prompt and removed when the
    // response settles. Concurrent prompts on the same client will
    // cross-talk on sessionUpdate — callers must serialize.
    //
    // `promptOrBlocks` is either the plain text (the common case) or a
    // pre-built ACP content-block array. Blocks exist for attachments:
    // the engine's `promptToText` (packages/tui/src/acp/agent.ts) accepts
    // exactly `text` and `resource_link` and rejects anything else with
    // "not supported in ACP P0" — so an uploaded file has to arrive as a
    // `resource_link`, not as extra prose bolted onto the text and not as a
    // `resource` / `image` block the engine would reject.
    const blocks = Array.isArray(promptOrBlocks)
      ? promptOrBlocks
      : [{ type: 'text', text: promptOrBlocks }]
    return await new Promise((resolve, reject) => {
      // qa (OOM hardening): 不再累积 result.events — 每个 session/update
      //   （含截图工具的 base64 rawOutput）都被 push 进数组且无任何消费者，
      //   自迭代长任务把堆撑到 GB 级直到 heap OOM。thinking/answer 累积
      //   保留（finalize 有消费者）。
      // session-isolation/07: thinking/answer are PER-SEGMENT, not
      //   turn-long. The discriminator mirrors streamAcpPrompt's
      //   lastChunkKind (session-isolation/06): chunks of the same kind
      //   append (streaming growth), a kind change resets — so
      //   result.answer / result.thinking carry the LAST segment when
      //   the prompt settles, the same value the live `●` / `▲` lines
      //   hold. The old turn-long concatenation leaked into the [send]
      //   result log, the ● finalize rewrite, the no-usage token
      //   estimate and the empty-turn note.
      const result = { thinking: '', answer: '', messageIds: new Set(), lastAssistantMessageId: null, stopReason: null, lastChunkKind: null }
      const onUpdate = (u) => {
        if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') {
          if (result.lastChunkKind !== 'thought') result.thinking = ''
          result.thinking += u.content.text
          result.lastChunkKind = 'thought'
          if (u.messageId) result.messageIds.add(u.messageId)
          try { onChunk?.({ kind: 'thought', text: u.content.text }) } catch {}
        } else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
          if (result.lastChunkKind !== 'message') result.answer = ''
          result.answer += u.content.text
          result.lastChunkKind = 'message'
          if (u.messageId) result.messageIds.add(u.messageId)
          // webui-parity 83 (turn coordinate): the engine persists a turn's
          // diff record under the msg_id of the LAST assistant *message* of
          // that turn (turn-outcome.ts#readAssistantMessageId reads only
          // AgentMessage / AgentMessageChunk — never a thought). A turn
          // carries more than one messageId on the wire (one per message
          // segment), so "any chunk" would select the wrong record; this
          // field keeps the last one and nothing else consumes it yet.
          if (u.messageId) result.lastAssistantMessageId = u.messageId
          try { onChunk?.({ kind: 'message', text: u.content.text }) } catch {}
        } else if (u.sessionUpdate === 'tool_call') {
          // session-isolation/07 (acceptance alignment): ONLY
          // chat-line-breaking tool events reset the per-segment
          // accumulator — the same rule as streamAcpPrompt's
          // lastChunkKind (server/lib/mcode-acp.js; keep the two in
          // sync). Non-rendering events (usage_update, plan_update,
          // session_info_update, mode/goal/config updates) can
          // interleave MID-segment and must NOT reset: an early reset
          // would truncate result.answer before streamAcpPrompt's
          // settle merge consumes it.
          result.lastChunkKind = 'tool_call'
          // payload: {toolCallId, title, name, status, rawInput, ...}
          try { onChunk?.({ kind: 'tool_call', update: u }) } catch {}
        } else if (u.sessionUpdate === 'tool_call_update') {
          result.lastChunkKind = 'tool_call_update'
          try { onChunk?.({ kind: 'tool_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'usage_update') {
          // payload: {used, size, cost} — cumulative values for the
          // current session. Overwrite cs.context with these (do not
          // add to prior counters).
          try { onChunk?.({ kind: 'usage', update: u }) } catch {}
        } else if (u.sessionUpdate === 'plan_update') {
          // payload: {sessionId, planId, title, summary, options:[{label,description}]}
          try { onChunk?.({ kind: 'plan_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'plan_removed') {
          try { onChunk?.({ kind: 'plan_removed', update: u }) } catch {}
        } else if (u.sessionUpdate === 'current_mode_update') {
          try { onChunk?.({ kind: 'mode_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'goal_update') {
          try { onChunk?.({ kind: 'goal_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'config_option_update') {
          // payload: {sessionId, key, value, ...} — dispatcher in the
          // upper layer picks the field by `key`.
          try { onChunk?.({ kind: 'config_option_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'session_info_update') {
          try { onChunk?.({ kind: 'session_info_update', update: u }) } catch {}
        } else {
          try { onChunk?.({ kind: 'other', update: u }) } catch {}
        }
      }
      this.on('sessionUpdate', onUpdate)
      this.request('session/prompt', {
        sessionId,
        prompt: blocks,
      }).then((r) => {
        result.stopReason = r?.stopReason || 'end_turn'
        // mcode acp 0.1.3 returns usage on the session/prompt response,
        // not as a separate usage_update event. Schema (Gcm convention):
        //   totalTokens, inputTokens, outputTokens, thoughtTokens,
        //   cachedReadTokens, cachedWriteTokens.
        if (r && r.usage) result.usage = r.usage
        if (process.env.MCODE_ACP_DEBUG) {
          console.log('[acp.prompt.response]', JSON.stringify({
            stopReason: r?.stopReason,
            hasUsage: !!r?.usage,
            usageKeys: r?.usage ? Object.keys(r.usage) : null,
            usage: r?.usage,
            respKeys: r ? Object.keys(r) : null,
            fullResp: r,
          }).slice(0, 2000))
        }
        this.off('sessionUpdate', onUpdate)
        try { onChunk?.({ kind: 'done', stopReason: result.stopReason, usage: result.usage }) } catch {}
        resolve(result)
      }).catch((e) => {
        this.off('sessionUpdate', onUpdate)
        reject(e)
      })
    })
  }

  stop() {
    if (this.child) {
      try { this.child.kill() } catch {}
      this.child = null
    }
    this.started = false
  }

  // Alias for child_process.child.kill() so /api/stop can call either.
  kill() { this.stop() }
}
