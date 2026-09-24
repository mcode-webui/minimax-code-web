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
  constructor({ mcodeCmd = 'mcode', cwd = DEFAULT_CWD, debug = false } = {}) {
    super()
    this.mcodeCmd = mcodeCmd
    this.cwd = cwd
    this.debug = debug
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
  }

  get alive() {
    return this._alive && this.child !== null && this.started === true
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
    this.child.stderr.on('data', (c) => {
      if (this.debug) process.stderr.write('[acp stderr] ' + c)
    })
    this.capabilities = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'mcode-webui', version: '0.1.0' },
      capabilities: { mcpCapabilities: { http: false, sse: false } },
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

  request(method, params) {
    if (!this.child) return Promise.reject(new Error('acp not started'))
    const id = ++this.nextId
    const msg = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      try {
        this.child.stdin.write(JSON.stringify(msg) + '\n')
      } catch (e) {
        this.pending.delete(id)
        reject(new Error(`acp write failed: ${e.message}`))
      }
    })
  }

  notify(method, params) {
    if (!this.child) throw new Error('acp not started')
    const msg = { jsonrpc: '2.0', method, params }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
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
      const result = { thinking: '', answer: '', messageIds: new Set(), stopReason: null }
      const onUpdate = (u) => {
        if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') {
          result.thinking += u.content.text
          if (u.messageId) result.messageIds.add(u.messageId)
          try { onChunk?.({ kind: 'thought', text: u.content.text }) } catch {}
        } else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
          result.answer += u.content.text
          if (u.messageId) result.messageIds.add(u.messageId)
          try { onChunk?.({ kind: 'message', text: u.content.text }) } catch {}
        } else if (u.sessionUpdate === 'tool_call') {
          // payload: {toolCallId, title, name, status, rawInput, ...}
          try { onChunk?.({ kind: 'tool_call', update: u }) } catch {}
        } else if (u.sessionUpdate === 'tool_call_update') {
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
