// webui/test/lib-capability.test.js
// ACP 能力协商（server/lib/capability.js）三层策略单测 + mcode-rpc 接线冒烟。
// 注意：mcode-rpc 相关断言只走「不触发 client spawn」的路径（旧回退早退）。

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_UNSUPPORTED,
  createCapabilityRegistry,
  resolveDeclaredCapabilities,
  probeParamsFor,
  syncActiveCapabilities,
  getActiveRegistry,
  UI_METHOD_KEYS,
} from "../server/lib/capability.js";

const MODERN_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} },
  },
  _meta: {
    "minimax-code/extensions": {
      version: 1,
      methods: ["session/activate", "mcode/session/steer"],
      notifications: ["mcode/session/queue_update"],
    },
  },
};
const LEGACY_INITIALIZE = { protocolVersion: 1, agentCapabilities: {} };

describe("resolveDeclaredCapabilities", () => {
  it("现代引擎样本：声明清单解析（session 四键 + 扩展方法）", () => {
    const d = resolveDeclaredCapabilities(MODERN_INITIALIZE);
    assert.equal(d.declared, true);
    assert.equal(d.session["session/list"], true);
    assert.equal(d.session["session/fork"], true);
    assert.equal(d.session["session/resume"], true);
    assert.equal(d.session["session/close"], true);
    assert.deepEqual(d.extensionMethods, ["session/activate", "mcode/session/steer"]);
  });

  it("0.1.5 样本：两者皆缺 → declared=false", () => {
    const d = resolveDeclaredCapabilities(LEGACY_INITIALIZE);
    assert.equal(d.declared, false);
    assert.equal(d.session["session/fork"], false);
    assert.deepEqual(d.extensionMethods, []);
  });

  it("空 / 非对象输入安全降级", () => {
    assert.equal(resolveDeclaredCapabilities(undefined).declared, false);
    assert.equal(resolveDeclaredCapabilities(null).declared, false);
  });
});

describe("createCapabilityRegistry — 三层策略", () => {
  it("声明清单：session 能力与扩展方法直接采信", () => {
    const r = createCapabilityRegistry({ initializeResult: MODERN_INITIALIZE });
    assert.equal(r.classify("session/list"), "supported");
    assert.equal(r.classify("session/fork"), "supported");
    assert.equal(r.classify("session/activate"), "supported");
    assert.equal(r.classify("mcode/session/steer"), "supported");
  });

  it("声明模式下未声明方法 → unknown（惰性探测候选）", () => {
    const r = createCapabilityRegistry({ initializeResult: MODERN_INITIALIZE });
    assert.equal(r.classify("session/set_mode"), "unknown");
    assert.equal(r.classify("session/delete"), "unknown");
  });

  it("旧引擎回退：LEGACY_UNSUPPORTED 预置（cancel 除外），核心方法支持", () => {
    const r = createCapabilityRegistry({ initializeResult: LEGACY_INITIALIZE });
    for (const m of LEGACY_UNSUPPORTED) {
      if (m === "session/cancel") continue;
      assert.equal(r.classify(m), "unsupported", m);
    }
    assert.equal(r.classify("session/load"), "supported");
    assert.equal(r.classify("session/close"), "supported");
    assert.equal(r.classify("session/list"), "supported");
    assert.equal(r.classify("session/new"), "supported");
    assert.equal(r.classify("session/prompt"), "supported");
  });

  it("session/cancel：声明条件式（契约修正 19）", () => {
    const legacy = createCapabilityRegistry({ initializeResult: LEGACY_INITIALIZE });
    const modern = createCapabilityRegistry({ initializeResult: MODERN_INITIALIZE });
    // 未声明 → unsupported 短路（守护 no mcode spawn）
    assert.equal(legacy.classify("session/cancel"), "unsupported");
    // 引擎 initialize 声明该方法 → supported（notify 语义）
    const declared = createCapabilityRegistry({
      initializeResult: {
        _meta: { "minimax-code/extensions": { methods: ["session/cancel"] } },
      },
    });
    assert.equal(declared.classify("session/cancel"), "supported");
  });
});

describe("惰性探测分类（recordProbeResult）", () => {
  const cases = [
    { name: "数值 -32601 → unsupported 且缓存", err: { data: { code: -32601, message: "x" } }, want: "unsupported" },
    { name: "字符串 -32601 → unsupported", err: { data: { code: "-32601" } }, want: "unsupported" },
    { name: "message 含 Method not found → unsupported", err: { message: "Method not found: session/set_mode" }, want: "unsupported" },
    { name: "invalidParams(-32602) → supported（方法存在）", err: { data: { code: -32602 } }, want: "supported" },
    { name: "resourceNotFound(-32000) → supported", err: { data: { code: -32000 } }, want: "supported" },
    { name: "成功（null）→ supported", err: null, want: "supported" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const r = createCapabilityRegistry({ initializeResult: MODERN_INITIALIZE });
      assert.equal(r.classify("session/set_mode"), "unknown");
      r.recordProbeResult("session/set_mode", c.err);
      assert.equal(r.classify("session/set_mode"), c.want);
    });
  }

  it("unknown → 探测 → 缓存路径（snapshot 反映）", () => {
    const r = createCapabilityRegistry({ initializeResult: MODERN_INITIALIZE });
    r.recordProbeResult("session/delete", { data: { code: -32601 } });
    assert.equal(r.classify("session/delete"), "unsupported");
    assert.ok(r.snapshot().unsupported.includes("session/delete"));
    // 已缓存：再次 classify 不再是 unknown
    assert.notEqual(r.classify("session/delete"), "unknown");
  });
});

describe("probeParamsFor", () => {
  it("缺必填字段的无副作用探测参数", () => {
    assert.deepEqual(probeParamsFor("session/set_mode"), { sessionId: "" });
    assert.deepEqual(probeParamsFor("session/set_config_option"), { sessionId: "" });
    assert.deepEqual(probeParamsFor("other/method"), {});
  });
});

describe("snapshot 形状", () => {
  it("三键数组且方法归类互斥", () => {
    const r = createCapabilityRegistry({ initializeResult: MODERN_INITIALIZE });
    const s = r.snapshot();
    for (const key of ["supported", "unsupported", "unknown"]) {
      assert.ok(Array.isArray(s[key]), `${key} 应为数组`);
    }
    const all = [...s.supported, ...s.unsupported, ...s.unknown];
    assert.equal(new Set(all).size, all.length, "无重复");
  });
});

describe("mcode-rpc 接线冒烟（不触发 client spawn）", () => {
  it("UI 映射 12 键形状稳定", () => {
    assert.equal(Object.keys(UI_METHOD_KEYS).length, 12);
  });

  it("旧引擎注册表下 setMode 早退 unsupported（前端 501 语义）", async () => {
    syncActiveCapabilities(LEGACY_INITIALIZE);
    const { setMode, MCODE_ACP_CAPABILITIES } = await import("../server/lib/mcode-rpc.js");
    const r = await setMode("mvs_test", "plan_mode");
    assert.equal(r.ok, false);
    assert.equal(r.code, "unsupported");
    // 旧引擎 UI 映射值（形状不变；cancel 修正为 false——契约修正 19：
    //   未声明即 unsupported 短路，守护 no mcode spawn）
    assert.equal(MCODE_ACP_CAPABILITIES.set_mode, false);
    assert.equal(MCODE_ACP_CAPABILITIES.set_config_option, false);
    assert.equal(MCODE_ACP_CAPABILITIES.fork, false);
    assert.equal(MCODE_ACP_CAPABILITIES.cancel, false);
    assert.equal(MCODE_ACP_CAPABILITIES.load, true);
    assert.equal(MCODE_ACP_CAPABILITIES.prompt, true);
  });

  it("播种现代引擎声明后 UI 映射实时刷新", async () => {
    syncActiveCapabilities(MODERN_INITIALIZE);
    const { MCODE_ACP_CAPABILITIES } = await import("../server/lib/mcode-rpc.js");
    assert.equal(MCODE_ACP_CAPABILITIES.fork, true);
    assert.equal(MCODE_ACP_CAPABILITIES.resume, true);
    assert.equal(MCODE_ACP_CAPABILITIES.activate, true);
    assert.equal(getActiveRegistry().classify("session/activate"), "supported");
  });
});