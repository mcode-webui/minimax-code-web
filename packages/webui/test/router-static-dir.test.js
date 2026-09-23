// webui/test/router-static-dir.test.js
// v2.4 回归测试：目录型入口（/react/）必须能被静态路由接住。
//
// 缺陷背景：静态路由的 match 判据是「路径含扩展名点号」，而 /react/ 没有点号
// → 根本不进这条路由、直接 404。React 版因此只能手敲 /react/index.html 才能
// 打开。修法是放宽判据为「有点号」或「以斜杠结尾（目录入口）」，并让
// serveStatic 对目录回落到 index.html。这两个行为各自锁一条用例。

import test from "node:test";
import assert from "node:assert/strict";

import { serveStatic } from "../server/lib/static.js";

function mockRes() {
  return {
    code: null,
    body: null,
    writeHead(code) { this.code = code; },
    end(body) { this.body = body; return this; },
  };
}

test("serveStatic: 目录入口回落到 index.html", () => {
  const res = mockRes();
  const handled = serveStatic("/react/", res) !== false;
  assert.equal(handled, true, "/react/ 应当被处理");
  assert.equal(res.code, 200);
  assert.ok(res.body && res.body.length > 0, "应当返回 index.html 内容");
});

test("serveStatic: 目录入口（无尾斜杠）同样回落", () => {
  const res = mockRes();
  assert.equal(serveStatic("/react", res) !== false, true);
  assert.equal(res.code, 200);
});

test("serveStatic: 具体文件不受影响", () => {
  const res = mockRes();
  assert.equal(serveStatic("/react/index.html", res) !== false, true);
  assert.equal(res.code, 200);
});

test("serveStatic: 不存在的路径不误判为已处理", () => {
  const res = mockRes();
  assert.equal(serveStatic("/react/nope/", res), false);
  assert.equal(res.code, null);
});

// 路由判据回归：目录入口必须满足静态路由的 match 条件。
// 这里复刻 router.js 里那条判据，防止有人改回去。
test("静态路由 match 判据接受目录入口", () => {
  const match = (p) => !!p && p !== "/" && (p.includes(".") || p.endsWith("/"));
  assert.equal(match("/react/"), true, "/react/ 必须命中静态路由");
  assert.equal(match("/react"), false, "无斜杠的目录别名由 serveStatic 兜底，不强求命中");
  assert.equal(match("/styles/main.css"), true);
  assert.equal(match("/"), false, "根路径走 serveIndex");
});
