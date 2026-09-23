// webui/test/lib-engine-mode.test.js
// 引擎传输 / 浏览器下行通道双开关（config.js）：默认旧行为、env 生效。

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MCODE_ENGINE, MCODE_WEBUI_TRANSPORT } from "../server/lib/config.js";

describe("引擎与通道开关", () => {
  it("默认值即旧行为：acp / sse", () => {
    assert.equal(MCODE_ENGINE, "acp");
    assert.equal(MCODE_WEBUI_TRANSPORT, "sse");
  });

  it("env=embed / ws 生效（cache-bust 模块实例）", async () => {
    process.env.MCODE_ENGINE = "embed";
    process.env.MCODE_WEBUI_TRANSPORT = "ws";
    try {
      const m = await import("../server/lib/config.js?bust=switches");
      assert.equal(m.MCODE_ENGINE, "embed");
      assert.equal(m.MCODE_WEBUI_TRANSPORT, "ws");
    } finally {
      delete process.env.MCODE_ENGINE;
      delete process.env.MCODE_WEBUI_TRANSPORT;
    }
  });
});