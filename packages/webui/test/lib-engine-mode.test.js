// webui/test/lib-engine-mode.test.js
// 引擎传输开关（config.js）：默认旧行为、env 生效。
// （浏览器下行通道开关 MCODE_WEBUI_TRANSPORT 已随决策 20 移除 —— SSE 删除后
//   /api/stream 始终启用，无开关可测。）

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MCODE_ENGINE } from "../server/lib/config.js";

describe("引擎开关", () => {
  it("默认值即旧行为：acp", () => {
    assert.equal(MCODE_ENGINE, "acp");
  });

  it("env=embed 生效（cache-bust 模块实例）", async () => {
    process.env.MCODE_ENGINE = "embed";
    try {
      const m = await import("../server/lib/config.js?bust=switches");
      assert.equal(m.MCODE_ENGINE, "embed");
    } finally {
      delete process.env.MCODE_ENGINE;
    }
  });
});
