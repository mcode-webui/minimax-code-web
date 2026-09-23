// webui/server/lib/embed-consumer.js
// mcode-embed 传输的聊天行归约器 —— 传输接缝的消费侧（技术方案 §5.1）。
//
// 职责：消费 runMcodeEmbed 的 NormalizedEvent 流，把增量落成 cs.chat 行
// （▲ 思考 / ● 正文 / → 工具标记），回合收尾时清理流式光标、记账用量、
// 复位 running 并推送状态。与 streamAcpPrompt（mcode-acp.js）/ collectExecResult
// （mcode-exec.js）职责对位；生成器自身已累积并 finalize 结果 r，本模块只做
// 呈现层归约，不重复计算 r。
//
// 范围说明（决策记录 14）：收尾记账镜像 streamAcpPrompt 的真实值/估算两条
// 分支；mavis 真值覆盖层与工具输出全文渲染为后续共享归约器提取轮次。

import { streamUpdateLine } from "./sessions.js";
import { pushStateFor } from "./state-bus.js";

/**
 * 归约一轮 embed 事件流并返回生成器的结果 r。
 *
 * @param {AsyncGenerator<object, object>} gen runMcodeEmbed(...) 生成器
 * @param {object} opts
 * @param {object} opts.cs   per-cid 状态（写 chat/running/context/usage）
 * @param {string} opts.cid  客户端标识（状态推送路由）
 * @param {string} [opts.label] 回合标签（running.prompt）
 * @returns {Promise<object>} 与 runMcodeAcp 同形的收尾结果 r
 */
export async function collectEmbedResult(gen, { cs, cid, label = "prompt" }) {
  const t0 = Date.now();
  cs.running = {
    active: true,
    prompt: label,
    pid: null,
    startedAt: t0,
    model: (cs.model && cs.model.name) || null,
    sessionId: cs.mcodeSessionId || null,
    lastDeltaAt: t0,
    tps: 0,
  };
  cs.context.thinkingStatus = "Running";
  pushStateFor(cid);

  let thinking = "";
  let answer = "";
  // 手写迭代：for-await 会丢弃生成器 return 值，而 r 正是返回值
  const it = gen[Symbol.asyncIterator]();
  for (;;) {
    const step = await it.next();
    if (step.done) {
      return finalize(cs, cid, step.value, { thinking, answer, t0 });
    }
    const ev = step.value;
    cs.running.lastDeltaAt = Date.now();
    if (ev && ev.kind === "thought" && typeof ev.text === "string") {
      thinking += ev.text;
      streamUpdateLine(cs.chat, "▲", thinking.replace(/\n+/g, " ").trim());
    } else if (ev && ev.kind === "message" && typeof ev.text === "string") {
      answer += ev.text;
      streamUpdateLine(cs.chat, "●", answer.replace(/\n+/g, " ").trim());
    } else if (ev && ev.kind === "tool_call") {
      // 工具标记行（输出全文渲染属后续共享归约器范围）
      const u = ev.update || {};
      cs.chat = [...cs.chat, `→ ${u.title || u.name || "tool"}`];
    }
  }
}

// 收尾：清理流式光标 + 用量记账 + 状态复位（镜像 streamAcpPrompt 要点）
function finalize(cs, cid, r, { thinking, answer, t0 }) {
  if (Array.isArray(cs.chat)) {
    cs.chat = cs.chat.map((line) =>
      typeof line === "string" && line.endsWith(" ▍") ? line.slice(0, -2) : line,
    );
  }
  const usage = r && r.usage;
  if (usage) {
    cs.context.tokens = (cs.context.tokens || 0) + (usage.totalTokens || 0);
    cs.context.used = cs.context.tokens;
    cs.context.percent = cs.context.limit
      ? Math.round((cs.context.tokens / cs.context.limit) * 100)
      : 0;
    cs.context.lastUsageAt = Date.now();
    cs.usage.sessionInput = (cs.usage.sessionInput || 0) + (usage.inputTokens || 0);
    cs.usage.sessionOutput =
      (cs.usage.sessionOutput || 0) + (usage.outputTokens || 0);
    cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
    cs.context.estimated = false;
  } else if (answer || thinking) {
    // 无 usage 时按 text/3 粗估（streamAcpPrompt 同款估算规则）
    const estOut = Math.ceil(((thinking || "") + (answer || "")).length / 3);
    const lastUser = [...(cs.chat || [])]
      .reverse()
      .find((l) => typeof l === "string" && l.startsWith("› "));
    const estIn = Math.ceil((lastUser ? lastUser.length : 0) / 3);
    const estTotal = estOut + estIn;
    cs.context.tokens = (cs.context.tokens || 0) + estTotal;
    cs.context.used = cs.context.tokens;
    cs.context.estimated = true;
    cs.context.percent = cs.context.limit
      ? Math.round((cs.context.tokens / cs.context.limit) * 100)
      : 0;
    cs.context.lastUsageAt = Date.now();
    cs.usage.sessionInput = (cs.usage.sessionInput || 0) + estIn;
    cs.usage.sessionOutput = (cs.usage.sessionOutput || 0) + estOut;
    cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
  }
  if (r && r.sessionId) cs.mcodeSessionId = r.sessionId;
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
  pushStateFor(cid);
  return r;
}