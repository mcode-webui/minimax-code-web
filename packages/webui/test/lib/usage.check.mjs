// webui/test/lib/usage.check.mjs
// Unit tests for server/lib/usage.js.
//
// The quota figures come from the engine's `mcode/account/status` ACP
// projection (packages/tui/src/acp/extensions.ts), so what is under test is
// "engine projection → cs.usage → popover payload". ENGINE_QUOTA_FIXTURE is a
// verbatim capture of that projection from a live engine, so a change to its
// shape fails here instead of silently emptying the popover.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setupMocks,
  absPath,
  registerRpcMock,
  registerSessionsStore,
} from "../helpers/_setup.js";

let applyAccountQuota, quotaSnapshot, runUsageQuery;
let makeClientState, pushStateFor, clients, sseByCid;

before(async (t) => {
  await setupMocks(t);
  const usageMod = await import(absPath("lib/usage.js"));
  applyAccountQuota = usageMod.applyAccountQuota;
  quotaSnapshot = usageMod.quotaSnapshot;
  runUsageQuery = usageMod.runUsageQuery;
  const sbMod = await import(absPath("lib/state-bus.js"));
  makeClientState = sbMod.makeClientState;
  pushStateFor = sbMod.pushStateFor;
  clients = sbMod.clients;
  sseByCid = sbMod.sseByCid;
});

beforeEach(() => {
  clients.clear();
  sseByCid.clear();
  registerSessionsStore({ initial: [] });
  registerRpcMock({ getAccountStatus: async () => ({ ok: false, code: "no_client" }) });
});

function fakeSse() {
  const writes = [];
  return { writes, write: (chunk) => writes.push(chunk) };
}

// `mcode/account/status` as a live engine answered it. The engine omits
// `identity.email` on purpose (see projectAccountStatus) and omits
// `tokenPlanQuota.video` when the account has no video quota.
const ENGINE_QUOTA_FIXTURE = {
  status: "ready",
  authMode: "api-key",
  modelSource: "byok",
  managedTokenPresent: true,
  identity: { name: "MiniMax802592" },
  tokenPlanQuotaState: "available",
  tokenPlan: {
    tier: "Ultra Plan",
    expiresAtMs: 1814140800000,
    creditBalance: "18509.925",
  },
  quota: {
    fiveHour: { remainingPercent: 99, resetAtMs: 1790164800000, unlimited: false },
    weekly: { remainingPercent: 86, resetAtMs: 1790524800000, unlimited: false },
  },
  warnings: [],
};

describe("applyAccountQuota — 引擎投影映射到 cs.usage", () => {
  test("真实引擎载荷: plan / 5h / weekly / 重置时间都被提取", () => {
    const cs = { usage: {} };
    applyAccountQuota(ENGINE_QUOTA_FIXTURE, cs);
    assert.equal(cs.usage.plan, "Ultra Plan");
    assert.equal(cs.usage.fiveHourPercent, 99);
    assert.equal(cs.usage.weekly, "86%");
    assert.equal(cs.usage.hidden, false);
  });

  test("resetAtMs (ms) 转为 unix 秒给 fiveHourReset / weeklyReset", () => {
    const cs = { usage: {} };
    applyAccountQuota(ENGINE_QUOTA_FIXTURE, cs);
    assert.equal(cs.usage.fiveHourReset, 1790164800);
    assert.equal(cs.usage.weeklyReset, 1790524800);
  });

  test("plan 附属字段保留引擎的类型 (不做二次解释)", () => {
    const cs = { usage: {} };
    applyAccountQuota(ENGINE_QUOTA_FIXTURE, cs);
    assert.equal(cs.usage.planExpiresAtMs, 1814140800000);
    // creditBalance 是引擎给的字符串, 不 parseFloat 成数字
    assert.equal(cs.usage.creditBalance, "18509.925");
  });

  test("unlimited 窗口不留数字 (跟引擎 chrome.ts quotaAlertWindow 一致)", () => {
    const cs = { usage: {} };
    applyAccountQuota(
      {
        tokenPlanQuotaState: "available",
        quota: {
          fiveHour: { unlimited: true, remainingPercent: 100, resetAtMs: 1790164800000 },
          weekly: { unlimited: false, remainingPercent: 86, resetAtMs: 1790524800000 },
        },
      },
      cs,
    );
    assert.equal(cs.usage.fiveHourPercent, null, "unlimited 窗口没有 '剩余百分比' 可言");
    // reset 仍然是真的: 窗口本身存在, 只是不限额
    assert.equal(cs.usage.fiveHourReset, 1790164800);
    assert.equal(cs.usage.weekly, "86%");
  });

  test("remainingPercent 缺失 / 非有限数 → null, 不抛", () => {
    const cs = { usage: {} };
    applyAccountQuota(
      {
        tokenPlanQuotaState: "available",
        quota: {
          fiveHour: { unlimited: false },
          weekly: { unlimited: false, remainingPercent: Number.NaN },
        },
      },
      cs,
    );
    assert.equal(cs.usage.fiveHourPercent, null);
    assert.equal(cs.usage.weekly, null);
  });

  test("tokenPlanQuotaState !== 'available' → hidden, 数字为 null", () => {
    for (const state of ["not-subscribed", "unavailable"]) {
      const cs = { usage: {} };
      applyAccountQuota({ tokenPlanQuotaState: state }, cs);
      assert.equal(cs.usage.hidden, true, `${state} 不应被当作有 quota 读数`);
      assert.equal(cs.usage.fiveHourPercent, null);
      assert.equal(cs.usage.weekly, null);
      assert.equal(cs.usage.plan, null);
    }
  });

  test("空载荷 / null → 全 null + hidden, 不抛", () => {
    for (const payload of [null, undefined, {}, { quota: "garbage" }]) {
      const cs = { usage: {} };
      applyAccountQuota(payload, cs);
      assert.equal(cs.usage.plan, null);
      assert.equal(cs.usage.planExpiresAtMs, null);
      assert.equal(cs.usage.creditBalance, null);
      assert.equal(cs.usage.fiveHourPercent, null);
      assert.equal(cs.usage.fiveHourReset, null);
      assert.equal(cs.usage.weekly, null);
      assert.equal(cs.usage.weeklyReset, null);
      assert.equal(cs.usage.hidden, true);
    }
  });

  test("creditBalance 非字符串 → null (不从对象强行取值)", () => {
    const cs = { usage: {} };
    applyAccountQuota(
      { tokenPlanQuotaState: "available", tokenPlan: { creditBalance: 42 } },
      cs,
    );
    assert.equal(cs.usage.creditBalance, null);
  });

  test("回归: 不清零 session* 字段 (老 parser 每次调用都把会话累计量清零)", () => {
    const cs = {
      usage: {
        sessionInput: 1200,
        sessionOutput: 340,
        sessionTotal: 1540,
      },
    };
    applyAccountQuota(ENGINE_QUOTA_FIXTURE, cs);
    // session* 属于聊天流程 (mcode-acp.js 按轮累加), 本模块不拥有它们
    assert.equal(cs.usage.sessionInput, 1200);
    assert.equal(cs.usage.sessionOutput, 340);
    assert.equal(cs.usage.sessionTotal, 1540);
  });
});

describe("quotaSnapshot — 悬浮卡读的响应体形状", () => {
  test("有读数时带 remaining / resetAt / weeklyResetAt / weeklyRemaining", () => {
    const cs = { usage: {} };
    applyAccountQuota(ENGINE_QUOTA_FIXTURE, cs);
    cs.usage.fetchedAt = 1790000000000;
    const snap = quotaSnapshot(cs);
    assert.equal(snap.ok, true);
    assert.equal(snap.source, "acp");
    assert.equal(snap.remaining, 99);
    assert.equal(snap.resetAt, 1790164800);
    assert.equal(snap.weeklyResetAt, 1790524800);
    assert.equal(snap.weeklyRemaining, 86);
    assert.equal(snap.fetchedAt, 1790000000000);
  });

  test("无读数时省略数字键 (前端据此显示 unavailable, 而不是 0%)", () => {
    const cs = { usage: {} };
    applyAccountQuota({ tokenPlanQuotaState: "not-subscribed" }, cs);
    const snap = quotaSnapshot(cs);
    assert.equal(snap.ok, true);
    assert.equal("remaining" in snap, false, "0% 和 '没有读数' 必须可区分");
    assert.equal("resetAt" in snap, false);
    assert.equal("weeklyResetAt" in snap, false);
    assert.equal("weeklyRemaining" in snap, false);
  });
});

describe("runUsageQuery — 数据源是引擎的 ACP 扩展方法", () => {
  test("成功: 返回悬浮卡载荷 + 填充 cs.usage + SSE 推送带上新值", async () => {
    registerRpcMock({
      getAccountStatus: async () => ({ ok: true, data: ENGINE_QUOTA_FIXTURE }),
    });
    const cid = "usage-1";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());

    const payload = await runUsageQuery(clients.get(cid), cid);

    assert.equal(payload.ok, true);
    assert.equal(payload.remaining, 99);
    const pushed = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.equal(pushed.usage.fiveHourPercent, 99);
    assert.equal(pushed.usage.weekly, "86%");
    assert.equal(pushed.usage.plan, "Ultra Plan");
    assert.equal(pushed.usage.error, null);
  });

  test("会话 id 透传给引擎 (引擎按会话读 token plan)", async () => {
    const seen = [];
    registerRpcMock({
      getAccountStatus: async (sid) => {
        seen.push(sid);
        return { ok: true, data: ENGINE_QUOTA_FIXTURE };
      },
    });
    const cid = "usage-2";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());
    const cs = clients.get(cid);
    cs.mcodeSessionId = "sess-abc";
    await runUsageQuery(cs, cid);
    assert.deepEqual(seen, ["sess-abc"]);
  });

  test("没有会话时也发起请求 (账号卡片/悬浮卡在会话存在前就可见)", async () => {
    const seen = [];
    registerRpcMock({
      getAccountStatus: async (sid) => {
        seen.push(sid);
        return { ok: true, data: ENGINE_QUOTA_FIXTURE };
      },
    });
    const cid = "usage-3";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());
    await runUsageQuery(clients.get(cid), cid);
    // makeClientState() 的 mcodeSessionId 是 null; mcode-rpc 对 falsy 值会发
    // 空 params, 所以线上不会出现 "sessionId: null"
    assert.deepEqual(seen, [null]);
  });

  test("RPC 失败: 返回 ok:false + error, 不抛, 状态仍被推送", async () => {
    registerRpcMock({
      getAccountStatus: async () => ({ ok: false, error: "no_client", code: "no_client" }),
    });
    const cid = "usage-4";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());

    const payload = await runUsageQuery(clients.get(cid), cid);

    assert.equal(payload.ok, false);
    assert.equal(payload.error, "no_client");
    assert.equal(payload.source, "acp");
    const pushed = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.equal(pushed.usage.error, "no_client");
    assert.equal(pushed.usage.hidden, true, "失败时不留半真的读数给预测历史");
  });
});
