// webui/server/lib/interaction/commands.js
// Slash command registry + dispatcher. Mirrors BORROW-dsh-deepseek-
// harness-2026-08-28 § 3 ("interaction/commands"). Owns the inline
// handlers used by /api/send (handleLocalSlash) and /api/cmd
// (handleCmdCommand); each handler mutates `cs` and routes through
// state-bus.pushStateFor (no direct SSE writes).
//
// Why a single file: the dispatcher stays small (one switch) and the
// bodies are private functions — external callers only need the two
// exported entry points. The commands module is the ONLY place that
// references loadSessions/saveSessions/persistCurrentChat/resetContext
// for slash purposes; future seaming (Borrow 3 hook seam) can
// intercept here without scattering changes across routes.

import { randomUUID } from "node:crypto";
import {
  loadSessions,
  saveSessions,
  persistCurrentChat,
  resetContext,
} from "../sessions.js";
import { ensureMcodeCommands } from "../acp-client.js";
import { CMD_BUTTON_COMMANDS } from "./command-registry.js";
import { runUsageQuery } from "../usage.js";
import { pushStateFor, getActiveChild } from "../state-bus.js";
import { gitStatus } from "../git.js";

// 列出 webui 支持的 slash 命令前缀（字母数字 + 连字符 + 下划线）
const SLASH_REGEX = /^\/([a-zA-Z][\w-]*)\b\s*(.*)/;

export function matchSlash(content) {
  const m = content.match(SLASH_REGEX);
  if (!m) return null;
  return { cmd: m[1], rest: m[2] || "" };
}

// webui-local commands shown in /help. This array is the fallback when
// ensureMcodeCommands() hasn't returned yet (first /help race).
// Both entries of that choice are the SAME set today: the live path
// (lib/acp-client.js fills the cache's `webui` group) and this fallback
// read CMD_BUTTON_COMMANDS, so /help cannot describe a command set
// that differs from the one POST /api/cmd accepts.
const LOCAL_HELP_FALLBACK = CMD_BUTTON_COMMANDS;

// ----- private body functions: each takes (cs, cid, rest) -----

function bodyClear(cs, cid) {
  cs.chat = [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  cs.mcodeSessionId = null;
  cs.sessionTitle = "Untitled";
  resetContext(cs);
  persistCurrentChat(cs);
  pushStateFor(cid);
  return { handled: true, continueMcode: false };
}

function bodyNew(cs, cid) {
  const all = loadSessions();
  const id = randomUUID();
  const item = {
    id,
    title: "New session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chat: [],
  };
  all.unshift(item);
  saveSessions(all);
  cs.sessionId = id;
  cs.sessionTitle = item.title;
  cs.chat = [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  cs.mcodeSessionId = null;
  resetContext(cs);
  pushStateFor(cid);
  return { handled: true, continueMcode: false };
}

function bodyStatus(cs, cid) {
  const t = `● 当前 model=${cs.model.name}\n  workspace=${cs.workspace.dir}\n  权限=${cs.permissions}`;
  cs.chat = [...(cs.chat || []), `› /status`, t];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true, continueMcode: false };
}

async function bodyHelp(cs, cid) {
  const cmds = await ensureMcodeCommands();
  const webui = (cmds && Array.isArray(cmds.webui) && cmds.webui.length > 0)
    ? cmds.webui
    : LOCAL_HELP_FALLBACK;
  const lines = ["● 可用命令："];
  for (const c of webui) lines.push(`  /${c.name} — ${c.desc}`);
  if (Array.isArray(cmds.mcode) && cmds.mcode.length > 0) {
    for (const c of cmds.mcode) {
      if (typeof c === "string") lines.push(`  /${c}`);
      else if (c && c.name)
        lines.push(
          `  /${c.name}${c.description ? " — " + c.description : ""}`,
        );
    }
  } else if (cmds.source && cmds.source.startsWith("error")) {
    lines.push(`  (mcode 命令拉取失败：${cmds.source.slice(7)})`);
  } else {
    lines.push(`  (mcode 命令待拉取…)`);
  }
  cs.chat = [...(cs.chat || []), `› /help`, lines.join("\n")];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true, continueMcode: false };
}

function bodySessions(cs, cid) {
  const all = loadSessions();
  const t =
    `● 最近 ${all.length} 个会话：\n` +
    all
      .slice(0, 8)
      .map((s, i) => `  ${i + 1}. ${s.title} (${s.id.substring(0, 8)}…)`)
      .join("\n");
  cs.chat = [...(cs.chat || []), `› /sessions`, t];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true, continueMcode: false };
}

async function bodyUsage(cs, cid) {
  await runUsageQuery(cs, cid);
  return { handled: true, continueMcode: false };
}

async function bodyStop(cs, cid) {
  // Scoped to the viewed session: a tab running two conversations has two
  // children, and /stop must not kill the other turn.
  const child = getActiveChild(cid, cs && cs.mcodeSessionId);
  const wasRunning = !!child;
  if (child) {
    try {
      child.kill();
    } catch {}
  }
  const t = wasRunning ? `● 已发送停止信号` : `● 没有正在运行的任务`;
  cs.chat = [...(cs.chat || []), `› /stop`, t];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true };
}

// `/review` — TUI parity: print a `staged / unstaged / untracked`
// overview of the current workspace into the chat. Sourced from the
// same `gitStatus` helper the right-panel Git panel uses (so a
// non-git or out-of-containment workspace renders the same empty
// state the panel does, not a red toast).
async function bodyReview(cs, cid) {
  const dir = (cs && cs.workspace && cs.workspace.dir) || "";
  const lines = [`› /review`];
  if (!dir) {
    lines.push(`● 没有工作区，无法审查变更`);
  } else {
    const status = await gitStatus(dir);
    if (!status.ok && !status.isRepo) {
      lines.push(`● ${dir} 不是 git 仓库`);
    } else if (!status.ok) {
      lines.push(`● 读取 git 状态失败：${status.error || "未知错误"}`);
    } else {
      const files = Array.isArray(status.files) ? status.files : [];
      const branchLabel = status.upstream
        ? `${status.branch}…${status.upstream}`
        : status.branch || "(no branch)";
      const tracking =
        status.ahead || status.behind
          ? ` (ahead ${status.ahead}, behind ${status.behind})`
          : "";
      lines.push(`● 变更概览 — ${branchLabel}${tracking}`);
      const staged = files.filter((f) => f.staged);
      // git porcelain semantics: x === ' ' means "unstaged only",
      // x === '?' means "untracked" — keep the two buckets separate
      // so the report matches what `git status -s` would print.
      const unstagedOnly = files.filter((f) => !f.staged && f.x === " ");
      const untracked = files.filter((f) => f.x === "?" && f.y === "?");
      // `staged` may include entries whose unstaged half is also
      // non-space (e.g. `MM` for staged-and-modified). Show those
      // under "staged" — that's what `git diff --cached` would emit.
      const stagedBucket = staged.filter((f) => f.x !== " ");
      const formatOne = (f) => {
        const tag = `${f.x}${f.y}`;
        const path = f.origPath ? `${f.origPath} → ${f.path}` : f.path;
        return `  ${tag}  ${path}`;
      };
      const renderBucket = (label, items) => {
        if (items.length === 0) {
          lines.push(`  ${label}: 无`);
          return;
        }
        lines.push(`  ${label}: ${items.length}`);
        for (const f of items) lines.push(formatOne(f));
      };
      renderBucket("staged", stagedBucket);
      renderBucket("unstaged", unstagedOnly);
      renderBucket("untracked", untracked);
      if (stagedBucket.length + unstagedOnly.length + untracked.length === 0) {
        lines.push(`● 工作区干净 — 无 staged/unstaged/untracked 变更`);
      }
    }
  }
  cs.chat = [...(cs.chat || []), lines.join("\n")];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true, continueMcode: false };
}

// ----- public dispatchers -----

// handleLocalSlash: /api/send path (user typed /cmd in chat input).
// Returns { handled, continueMcode, rewriteContent? }. If handled and
// continueMcode=false, caller returns immediately. If handled and
// continueMcode=true with rewriteContent, caller forwards the rewritten
// content to mcode. If not handled, caller falls through to mcode.
//
// PB-14 batch C — `/goal`, `/goal-done` and `/goal-blocked` ARE NOT HERE,
// and their absence is the point. They used to be: `bodyGoal` recorded
// `{active, text, status, duration}` in the per-cid `cs.goal` slot, rewrote
// the chat line so `/goal xxx` displayed as `xxx`, and returned
// `continueMcode: true` — which handed the objective to the engine as an
// ordinary message. The engine therefore never learned a goal existed; the
// slot was read by no webapp component; and the user got a chat line that
// said a goal had been set. Batch C replaced it with the real command
// (composer → `POST /api/goal` → the engine's `createGoal`) and this
// handler's copies are gone with it.
//
// What a `/goal` line does now: the composer claims it when the engine has
// the feature enabled, and otherwise lets it fall through to the `default`
// branch, which forwards it to mcode untouched. Both answers are honest,
// and neither is "webui recorded something the engine never saw". The
// `cs.goal` slot itself stays in `state-bus.js` for one release — batch D
// removes it along with the debug injection that can still fill it.
export async function handleLocalSlash(content, cs, cid) {
  const m = matchSlash(content);
  if (!m) return false;
  const { cmd, rest } = m;
  switch (cmd) {
    case "clear":
      return bodyClear(cs, cid);
    case "new":
      return bodyNew(cs, cid);
    case "status":
      return bodyStatus(cs, cid);
    case "review":
      return await bodyReview(cs, cid);
    case "help":
      return await bodyHelp(cs, cid);
    case "usage":
      return await bodyUsage(cs, cid);
    default:
      return { handled: false, continueMcode: true };
  }
}

// handleCmdCommand: /api/cmd path (button-driven; cmd includes leading /).
// Returns { handled: true } for matched cmds, { handled: false } otherwise.
// /new has extra guards not present in the text-typed path (running check
// + noop-empty for repeated clicks).
export async function handleCmdCommand(cmd, cs, cid) {
  if (typeof cmd !== "string" || cmd.length === 0)
    return { handled: false };
  const name = cmd.startsWith("/") ? cmd.slice(1) : cmd;

  if (name === "new") {
    if (cs.running && cs.running.active) {
      cs.chat = [
        ...(cs.chat || []),
        `! [warn] AI 还在回复中，先停止当前任务再新建会话`,
      ];
      pushStateFor(cid);
      return { handled: true };
    }
    const isEmpty = !cs.chat || cs.chat.length === 0;
    const isDefaultTitle =
      !cs.sessionTitle ||
      cs.sessionTitle === "Untitled" ||
      cs.sessionTitle === "New session";
    if (cs.sessionId && isEmpty && isDefaultTitle) {
      pushStateFor(cid);
      return { handled: true };
    }
    return bodyNew(cs, cid);
  }

  switch (name) {
    case "status":
      return bodyStatus(cs, cid);
    case "review":
      return await bodyReview(cs, cid);
    case "clear":
      return bodyClear(cs, cid);
    case "sessions":
      return bodySessions(cs, cid);
    case "help":
      return await bodyHelp(cs, cid);
    case "usage":
      return await bodyUsage(cs, cid);
    case "stop":
      return await bodyStop(cs, cid);
    default:
      return { handled: false };
  }
}