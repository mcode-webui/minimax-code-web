// webui/server/lib/mcode-exec.js
// Spawn mcode exec subprocess (mcode.cmd exec --input - --output-format stream-json)
// + parse stream-json events + accumulate result.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  MCODE_CMD,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
  PROMPT_IDLE_TIMEOUT_MS,
} from "./config.js";
import { createIdleWatchdog } from "./idle-watchdog.js";
import { pushAlert } from "./alerts.js";
import { streamUpdateLine } from "./chat-line.js";
import { computeContextPercent } from "./sessions.js";
import { setActiveChild, clearActiveChild, pushStateFor } from "./state-bus.js";

// ============================================================
// v2 security fix (PR #55 / CodeQL js/shell-command-injection):
// the old implementation spawned a Windows shell trampoline
// (`/c <MCODE_CMD> exec ...`) on every platform, handing an
// environment/PATH-resolved string to a full shell — an injection
// surface. The trampoline is removed entirely: we resolve the mcode
// entry ourselves (zero deps, sync) and spawn it directly.
// Resolution rules, fail-closed at every step:
//   1. MCODE_CMD containing a path separator is taken as a direct
//      path (config.js supplies absolute repo/home-layout values).
//   2. A bare name is probed against PATH. On win32 PATHEXT
//      extensions are probed too; shim file names are matched
//      case-insensitively — PATHEXT casing is not guaranteed and a
//      case-sensitive filesystem (Linux CI) must not miss the shim.
//   3. A .cmd/.bat shim is never executed through a shell. We use
//      the sibling node_modules/@minimax-ai/code/cli.js and run it
//      under the current Node binary (process.execPath).
//   4. Anything unresolvable throws. There is no shell fallback.
// ============================================================

const CODE_ENTRY = ["node_modules", "@minimax-ai", "code", "cli.js"];

// Case-insensitive file probe. existsSync covers case-insensitive
// filesystems (win32, default macOS); the directory-listing fallback
// covers case-sensitive ones (Linux) where probed casing may differ
// from the file on disk. Returns the on-disk path or null.
function probeFile(p) {
  if (existsSync(p)) return p;
  try {
    const dir = dirname(p);
    const want = p.toLowerCase();
    for (const name of readdirSync(dir)) {
      const hit = join(dir, name);
      if (hit.toLowerCase() === want) return hit;
    }
  } catch {}
  return null;
}

// Resolve MCODE_CMD to a directly spawnable { command, args } prefix:
//   - shim on disk  -> { command: process.execPath, args: [cliEntry] }
//   - plain binary  -> { command: <absolute path>, args: [] }
// Throws (fail-closed) when nothing resolves — never falls back to a
// shell. `env`/`platform` are injectable for unit tests.
export function resolveMcodeSpawn(
  cmd = MCODE_CMD,
  { env = process.env, platform = process.platform } = {},
) {
  if (typeof cmd !== "string" || !cmd) {
    throw new Error(
      "[mcode-exec] MCODE_CMD is empty; set it to the mcode CLI path (fail-closed, no shell fallback).",
    );
  }
  const win = platform === "win32";
  const direct = /[\\/]/.test(cmd);
  const dirs = direct
    ? [""]
    : String(env.PATH ?? env.Path ?? "")
        .split(win ? ";" : delimiter)
        .filter(Boolean);
  // An extensionless bare name on win32 only resolves through PATHEXT;
  // a name already carrying an extension (mcode.cmd / pwsh.exe) is
  // probed as-is. POSIX keeps the bare name as the only form.
  const dotted = /\.[a-z0-9]+$/i.test(cmd);
  const exts =
    win && !dotted && !direct
      ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  let found = null;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = resolve(direct ? cmd + ext : join(dir, cmd + ext));
      const hit = probeFile(candidate);
      if (hit) {
        found = hit;
        break outer;
      }
    }
  }
  if (!found) {
    throw new Error(
      `[mcode-exec] cannot resolve mcode CLI "${cmd}" (no match on PATH); ` +
        `set MCODE_CMD to the mcode launcher path or its cli.js entry ` +
        `(fail-closed, no shell fallback).`,
    );
  }
  // A .cmd/.bat shim cannot be spawned directly by Node and must not be
  // handed to a shell — run its sibling cli.js under this Node instead.
  if (/\.(cmd|bat)$/i.test(found)) {
    const entry = resolve(dirname(found), ...CODE_ENTRY);
    if (!existsSync(entry)) {
      throw new Error(
        `[mcode-exec] mcode shim "${found}" resolved, but sibling entry ` +
          `"${entry}" is missing; reinstall the mcode CLI or point ` +
          `MCODE_CMD at its cli.js (fail-closed, no shell fallback).`,
      );
    }
    return { command: process.execPath, args: [entry] };
  }
  // v2.1 (in-product): a .js/.mjs entry (e.g. dist/cli.js from this repo,
  // or MCODE_WEBUI_SELF_ENTRY injected by `mcode webui`) runs under the
  // current Node — it is not a native executable.
  if (/\.(js|mjs)$/i.test(found)) {
    return { command: process.execPath, args: [found] };
  }
  return { command: found, args: [] };
}

// Assemble the mcode exec argv (everything after the resolved binary /
// entry). Exported for unit tests; flags and order mirror the pre-v2
// spawn argv minus the removed `/c <MCODE_CMD>` shell prefix.
export function buildExecArgs({
  workspace = "",
  model = DEFAULT_MODEL,
  timeout = DEFAULT_TIMEOUT,
  maxSteps = DEFAULT_MAX_STEPS,
  permission = "full",
  sessionId = null,
} = {}) {
  const args = [
    "exec",
    "--input",
    "-",
    "--input-format",
    "text",
    "--cwd",
    workspace,
    "--permission",
    permission,
    "--timeout",
    timeout,
    "--output-format",
    "stream-json",
    "--max-steps",
    String(maxSteps),
    "--model",
    model,
  ];
  if (sessionId) args.push("--session", sessionId);
  return args;
}

export function runMcodeExec(prompt, opts = {}) {
  const workspace =
    opts.workspace ||
    (opts.cs && opts.cs.workspace && opts.cs.workspace.dir) ||
    "";
  const model = opts.model || DEFAULT_MODEL;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS;
  const label = opts.label || "prompt";
  // 续接已有 session（多轮对话上下文）— 由 collectExecResult 写回的 mcode exec.sessionId
  const sessionId = opts.sessionId || null;
  const cs = opts.cs; // v0.5.ai: per-cid state
  const cid = opts.cid;

  // v0.5.bx-19: webui 端 permission 模式同步到 mcode — 之前硬编码 'full' 导致 "始终询问" 不生效
  //   webui 'Ask' → mcode 'ask' / 'Auto' → 'auto' / 'Read' → 'read' / 'Full access' → 'full'
  const webuiMode = (cs && cs.permissions) || "Full access";
  const mcodePermission =
    webuiMode === "Ask"
      ? "ask"
      : webuiMode === "Auto"
        ? "auto"
        : webuiMode === "Read"
          ? "read"
          : "full";

  // v2 security fix (PR #55): resolve the CLI ourselves and spawn it
  // directly — the old Windows-shell `/c` trampoline is gone. A missing
  // CLI throws here (fail-closed) instead of reaching a shell.
  const resolved = resolveMcodeSpawn(MCODE_CMD);
  const args = [
    ...resolved.args,
    ...buildExecArgs({
      workspace,
      model,
      timeout,
      maxSteps,
      permission: mcodePermission,
      sessionId,
    }),
  ];
  const child = spawn(resolved.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.write(prompt, "utf8");
  child.stdin.end();
  // v0.5.ai: per-cid child tracker（/api/stop 按 cid 找 child）。
  // 按引擎会话分桶：一个标签页可并行跑两个会话，各自一个子进程，
  // /api/stop 只应命中当前查看会话的那一个。
  setActiveChild(cid, child, sessionId || null);
  return { child, args, label, model, workspace, sessionId, cs, cid };
}

// ---------------------------------------------------------------------------
// THE WIRE (D1)
// ---------------------------------------------------------------------------
//
// `mcode exec --output-format stream-json` writes EXACTLY the projected
// `ExecEvent` union (packages/tui/src/headless/events.ts:27-48), one JSON
// object per line, and nothing else:
//
//   - `output.ts:34-36` refuses `stream-json` outright when no
//     `ExecEventProjector` was supplied, so there is no unprojected path;
//   - `runner.ts:218-232` always supplies one for this format;
//   - the encoder's `result()` leg, for `stream-json`, goes through
//     `projector.complete()` (output.ts:47-53) rather than writing the
//     `ExecResult` itself — `exec.result` is the `json` format's line
//     (contract.ts:42), so it is a PAYLOAD the wire carries inside
//     `exec.completed`, never a line the wire writes.
//
// The three names this parser used to branch on — `delta`, `message`,
// `exec.result` — are the SUPERVISOR's internal `TuiStreamEvent` names
// (packages/tui/src/runtime/stream-events.ts, consumed by
// `ExecEventProjector.project`). They never reach stdout. The two name
// families have an empty intersection, which is why the exec transport
// produced no streaming delta, no session id, no usage and no terminal
// status: every turn on this transport ended with `status: "unknown"` and
// an empty answer, whatever the agent had actually said.
//
// The switch below is therefore keyed on the WIRE's names. Every one of
// them is listed in `EXEC_INTERFACE.consumedEvents`
// (server/engine/providers/exec.capabilities.js), and
// `test/lib/engine/capability-snapshot.test.js` keeps that list and this
// switch equal by reading both.
//
// `exec.started`, `session.started`, `session.resumed` and `turn.started`
// carry no payload beyond `ExecEventBase` and fall into `default`. The one
// thing every line does carry is `sessionId` (events.ts:12-17), which is
// adopted below the switch for exactly that reason.
// ---------------------------------------------------------------------------

// The `ExecItem.type` → the webui streaming marker. `tool_call` has no
// marker and is not rendered: the exec transport's tool surface is
// produced but invisible, which EXEC_CAPABILITIES.toolSkillInvocation
// records. Naming the mapping in one place keeps the two switch arms
// (delta and completed) from disagreeing.
const ITEM_STREAM_MARKER = Object.freeze({
  reasoning: "▲",
  agent_message: "●",
});

// collectExecResult: 解析 stream-json + 累加 result。
// 完成后会 pushStateFor(cid)，调用方不需要再 push。
export function collectExecResult(childPromise) {
  // Wraps runMcodeExec and accumulates a result object
  return new Promise((resolve) => {
    const r = {
      answer: null,
      thinking: null,
      status: "unknown",
      error: null,
      usage: null,
      sessionId: null,
      durationMs: null,
      tps: null,
    };
    let buf = "";
    const t0 = Date.now();
    const { child, label, model, cs, cid, sessionId } = childPromise;
    // Per-item streaming state. `streamItem` is the item whose text the
    // current `▲`/`●` line is accumulating, so a new item (or a switch
    // between reasoning and answer) starts a fresh line instead of
    // gluing two unrelated texts together — the same reset mcode-acp's
    // `lastChunkKind` performs. `streamedItemIds` records which items
    // already delivered their text as deltas, so the authoritative
    // `item.completed` copy of that same text is not appended twice.
    let streamItem = null;
    const streamedItemIds = new Set();
    cs.running = {
      active: true,
      prompt: label,
      pid: child.pid,
      startedAt: t0,
      model,
      sessionId: null,
      lastDeltaAt: t0,
      tps: 0,
    };
    cs.context.thinkingStatus = label === "/usage" ? "Loading" : "Running";
    pushStateFor(cid);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (!m || typeof m !== "object") continue;
          adoptSessionId(m);
          switch (m.type) {
            case "item.started":
            case "item.updated":
              consumeItemText(m.item, m.item && m.item.contentDelta);
              break;
            case "item.completed":
              // The authoritative full text. Adopted only for an item
              // that never streamed — a turn whose whole message arrived
              // in one `message` event emits no delta, and dropping it
              // would leave `answer` empty for a turn that did produce
              // output.
              if (m.item && !streamedItemIds.has(m.item.id)) {
                consumeItemText(m.item, m.item.content);
              }
              break;
            case "turn.completed":
              if (m.usage) r.usage = m.usage;
              if (typeof m.durationMs === "number") r.durationMs = m.durationMs;
              break;
            case "turn.failed":
              r.status = m.status || "failed";
              if (m.error) r.error = m.error;
              if (typeof m.durationMs === "number") r.durationMs = m.durationMs;
              break;
            case "exec.completed":
              finishFromResult(m.result);
              break;
            default:
              // exec.started / session.started / session.resumed /
              // turn.started — `ExecEventBase` only; `sessionId` was
              // already adopted above.
              break;
          }
        } catch {}
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {}); // swallow; usage stats can land here

    // `ExecEventBase.sessionId` (events.ts:12-17) is on EVERY line, so the
    // engine session this run entered is known from the first event —
    // which is what lets the turn be continued next time, and what the
    // old parser could never learn (it read `sessionId` off an
    // `exec.result` line the wire never wrote).
    function adoptSessionId(m) {
      if (typeof m.sessionId === "string" && m.sessionId) r.sessionId = m.sessionId;
    }

    // Fold one chunk of an item's text into the accumulator and the
    // streaming line. `text` is `item.contentDelta` on the started/
    // updated arms and `item.content` on the completed arm; both are
    // "append this much text to this item".
    function consumeItemText(item, text) {
      if (!item || typeof text !== "string" || !text) return;
      const marker = ITEM_STREAM_MARKER[item.type];
      if (!marker) return; // tool_call — produced, not rendered
      if (item.id !== undefined) streamedItemIds.add(item.id);
      if (item.type === "reasoning") r.thinking = (r.thinking || "") + text;
      else r.answer = (r.answer || "") + text;
      if (streamItem && streamItem.id === item.id && streamItem.marker === marker) {
        streamItem.text += text;
      } else {
        streamItem = { id: item.id, marker, text };
      }
      streamUpdateLine(cs.chat, marker, streamItem.text.replace(/\n+/g, " ").trim());
      noteStreamActivity();
    }

    // The idle watchdog's clock and the front-end's tps readout both
    // move on every text chunk — the exec transport's equivalent of the
    // acp runner's per-event `lastDeltaAt` refresh.
    function noteStreamActivity() {
      const now = Date.now();
      if (cs.running.lastDeltaAt) {
        const dt = (now - cs.running.lastDeltaAt) / 1000;
        if (dt > 0) cs.running.tps = Math.round(1 / dt);
      }
      cs.running.lastDeltaAt = now;
      cs.context.tps = cs.running.tps;
      pushStateFor(cid);
    }

    // `exec.completed` is the terminal wire event and carries the whole
    // `ExecResult` (contract.ts:39-55) under `result` — including the
    // `exec.result` payload shape the old parser was reaching for, and
    // the final `output` for a turn that produced text without ever
    // streaming a delta.
    function finishFromResult(result) {
      if (result && typeof result === "object") {
        if (typeof result.sessionId === "string" && result.sessionId) {
          r.sessionId = result.sessionId;
        }
        if (result.status) r.status = result.status;
        if (result.error) r.error = result.error;
        if (typeof result.durationMs === "number") r.durationMs = result.durationMs;
        if (!r.usage && result.usage) r.usage = result.usage;
        if (!r.answer && typeof result.output === "string") r.answer = result.output;
      }
      finalize();
    }

    // v2.3: idle watchdog (see mcode-acp.js) — stream lines refresh
    //   cs.running.lastDeltaAt; only a silent stream trips this.
    const idleSeconds = Math.round(PROMPT_IDLE_TIMEOUT_MS / 1000);
    const safetyTimeout = createIdleWatchdog({
      idleMs: PROMPT_IDLE_TIMEOUT_MS,
      activityAt: () => cs.running.lastDeltaAt || t0,
      onTimeout: () => {
        if (r.status === "unknown") {
          r.status = "timeout";
          r.error = {
            message: `mcode exec stream inactive for ${idleSeconds}s (no output)`,
          };
          pushAlert({
            level: "warn",
            msg: `[mcode-exec.timeout] stream inactive for ${idleSeconds}s`,
            src: "mcode-exec",
            cid: cid || null,
            sessionId: sid || null,
            data: { phase: "stream" },
          });
          try {
            child.kill("SIGTERM");
          } catch {}
          finalize();
        }
      },
    });

    function finalize() {
      if (r._finalized) return;
      r._finalized = true;
      safetyTimeout.stop();
      const dt = Date.now() - t0;
      r.durationMs = r.durationMs || dt;
      // v2.4 (SPEC §B 尾项 — turn_process.processed_duration):
      //   mirror the mcode-acp.js path: append a `§§ processed_duration=Nms`
      //   marker so the webui renderer can attach it to the matching assistant
      //   turn. See mcode-acp.js for the marker grammar rationale.
      if (
        typeof r.durationMs === "number" &&
        r.durationMs > 0 &&
        Array.isArray(cs.chat)
      ) {
        cs.chat = [
          ...cs.chat,
          `§§ processed_duration=${Math.round(r.durationMs)}ms`,
        ];
      }
      // Strip the streaming cursor ▍ from every line — streamUpdateLine
      // adds it on every push, and finalize must clear it or the exec
      // transport's answer line stays marked as streaming forever. Same
      // rule mcode-acp's finalize applies.
      if (Array.isArray(cs.chat)) {
        for (let i = 0; i < cs.chat.length; i += 1) {
          const line = cs.chat[i];
          if (typeof line === "string" && line.endsWith(" ▍")) {
            cs.chat[i] = line.slice(0, -2);
          }
        }
      }
      if (r._stopped) r.status = "stopped";
      // Scoped to this turn's engine session — a sibling conversation's
      // child in the same tab survives.
      clearActiveChild(cid, sessionId || null);
      cs.running = {
        active: false,
        prompt: null,
        pid: null,
        startedAt: null,
        model: null,
        sessionId: null,
        lastDeltaAt: null,
        tps: 0,
      };
      cs.context.thinkingStatus = "Idle";
      cs.context.tps = 0;
      if (r.usage) {
        cs.context.tokens =
          (cs.context.tokens || 0) + (r.usage.totalTokens || 0);
        cs.context.used = cs.context.tokens;
        cs.context.percent = computeContextPercent(
          cs.context.tokens,
          cs.context.limit,
        );
        cs.context.estimated = false;
        cs.context.lastUsageAt = Date.now();
        cs.usage.sessionInput =
          (cs.usage.sessionInput || 0) + (r.usage.inputTokens || 0);
        cs.usage.sessionOutput =
          (cs.usage.sessionOutput || 0) + (r.usage.outputTokens || 0);
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
      } else if (r.answer || r.thinking) {
        // The engine sends no usage and no usage_update: estimate the tokens from the
        // thinking + answer length instead.
        //   估算系数: ~3 字符/token (中英文混合经验值, GPT tokenizer ~4 字符/token, 中文偏密 ~1.5 字符/token)
        //   注意: input 算 user prompt + 上文, 我们没访问 — 只能估 output (thinking+answer) + 累加 user input
        //   A real usage value takes the branch above, so this estimate goes unused.
        const outText = (r.thinking || "") + (r.answer || "");
        const estOutTokens = Math.ceil(outText.length / 3);
        // 估算 user input 长度 — 我们能从 cs.chat 知道上一次 user prompt 长度
        const lastUserLine = [...(cs.chat || [])]
          .reverse()
          .find((l) => typeof l === "string" && l.startsWith("› "));
        const userLen = lastUserLine ? lastUserLine.length : 0;
        const estInTokens = Math.ceil(userLen / 3);
        const estTotal = estOutTokens + estInTokens;
        cs.context.tokens = (cs.context.tokens || 0) + estTotal;
        cs.context.used = cs.context.tokens;
        cs.context.estimated = true;
        cs.context.percent = computeContextPercent(
          cs.context.tokens,
          cs.context.limit,
        );
        cs.context.lastUsageAt = Date.now();
        cs.usage.sessionInput = (cs.usage.sessionInput || 0) + estInTokens;
        cs.usage.sessionOutput = (cs.usage.sessionOutput || 0) + estOutTokens;
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
        if (process.env.MCODE_USAGE_DEBUG) {
          console.log(
            `[usage.estimate] outLen=${outText.length} estOut=${estOutTokens} userLen=${userLen} estIn=${estInTokens} total=${estTotal} (no usage reported; estimated)`,
          );
        }
      }
      if (r.sessionId) cs.mcodeSessionId = r.sessionId;
      pushStateFor(cid);
      resolve(r);
      try {
        child.kill();
      } catch {}
    }

    child.stdout.on("end", finalize);
    child.on("exit", finalize);
    child.on("error", (e) => {
      r.status = "error";
      r.error = { message: e.message };
      finalize();
    });
  });
}
