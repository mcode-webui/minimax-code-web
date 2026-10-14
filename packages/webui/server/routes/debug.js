// webui/server/routes/debug.js
// POST /api/debug/inject, GET /api/debug/state (DEBUG_INJECT=1 gated)

import { pushStateFor } from "../lib/state-bus.js";
import { readJson } from "../lib/read-json.js";


// POST /api/debug/inject — mock state 字段给浏览器测 UI 渲染
export async function handleDebugInject(req, res, ctx) {
  if (process.env.DEBUG_INJECT !== "1") {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: false,
        error: "DEBUG_INJECT not enabled (set DEBUG_INJECT=1 env to use)",
      }),
    );
  }
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const applied = {};
  // PB-14 batch D: the `goal` injection key is GONE. It filled the retired
  // webui-local `cs.goal` slot, whose only writer was `/goal <text>` before
  // batch C — a field no component ever read. Keeping the key would let a
  // debug payload invent a goal the engine never saw, which is the one thing
  // this route must not do: `threadGoal` arrives from the engine's
  // `thread_goal.*` events and deliberately has no injection path.
  if (Array.isArray(payload.todo)) {
    cs.todo = payload.todo;
    applied.todoCount = cs.todo.length;
  }
  if (payload.ask && typeof payload.ask === "object") {
    cs.ask = { ...cs.ask, ...payload.ask };
    applied.ask = true;
  }
  if (payload.plan && typeof payload.plan === "object") {
    cs.plan = { ...cs.plan, ...payload.plan };
    applied.plan = true;
  }
  if (payload.enterPlanMode && typeof payload.enterPlanMode === "object") {
    cs.enterPlanMode = { ...cs.enterPlanMode, ...payload.enterPlanMode };
    applied.enterPlanMode = true;
  }
  if (Array.isArray(payload.appendChat)) {
    cs.chat = [...(cs.chat || []), ...payload.appendChat];
    applied.appendedChatLines = payload.appendChat.length;
  }
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ ok: true, applied, cid }));
}

// GET /api/debug/state
export function handleDebugState(_req, res, ctx) {
  if (process.env.DEBUG_INJECT !== "1") {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ ok: false, error: "DEBUG_INJECT not enabled" }),
    );
  }
  const cs = ctx.cs;
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(
    JSON.stringify({
      ok: true,
      // PB-14 batch D: `goal` is gone from the readback for the same reason
      // it is gone from the injection — the slot no longer exists. `threadGoal`
      // is deliberately NOT echoed here either: this route reports what a
      // debug payload wrote, and the engine's goal is not writable here.
      todoCount: (cs.todo || []).length,
      ask: cs.ask,
      plan: cs.plan,
      enterPlanMode: cs.enterPlanMode,
      chatLast5: (cs.chat || []).slice(-5),
    }),
  );
}
