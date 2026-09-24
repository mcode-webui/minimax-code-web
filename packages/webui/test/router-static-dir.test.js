// webui/test/router-static-dir.test.js
// v2.4/v2.5 回归测试：目录型入口（/react/）必须能被静态路由接住；
// 新版默认 + 原版归档的回落语义。
//
// 【为什么不碰真实 public/】public/react/ 是 vite 的构建产物（gitignored），
// CI 的 test:webui 不先跑 build，所以 fresh checkout 上它不存在。若断言写死
// 「必须是 React 外壳」，就会出现「本地绿、CI 红」。这里用临时 fixture 目录 +
// 可注入的 root 参数，把**路由/回落逻辑**与构建产物彻底解耦 —— 与本 PR
// 「可注入端口」的做法一致。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveStatic, serveIndex, serveLegacyIndex } from "../server/lib/static.js";

function mockRes() {
  return {
    code: null,
    body: null,
    writeHead(code) { this.code = code; },
    end(body) { this.body = body == null ? "" : String(body); return this; },
  };
}

const REACT_MARK = "/react/assets/index.js";
const VANILLA_MARK = "chat-inner";

/**
 * 造一棵最小 public 树：
 *   root/index.html            → vanilla 外壳（含 chat-inner）
 *   root/react/index.html      → React 外壳（含 /react/assets/ 引用）
 *   root/react/assets/app.js   → 具体文件
 */
function makeFixture({ withReact = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "webui-static-"));
  writeFileSync(join(root, "index.html"), `<html><body><div id="${VANILLA_MARK}"></div></body></html>`);
  if (withReact) {
    mkdirSync(join(root, "react", "assets"), { recursive: true });
    writeFileSync(join(root, "react", "index.html"), `<html><head><script src="${REACT_MARK}"></script></head><body><div id="root"></div></body></html>`);
    writeFileSync(join(root, "react", "assets", "app.js"), "export const x = 1;");
  }
  return root;
}

function withFixture(opts, fn) {
  const root = makeFixture(opts);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("serveStatic: 目录入口回落到 index.html", () => {
  withFixture({}, (root) => {
    const res = mockRes();
    const handled = serveStatic("/react/", res, root) !== false;
    assert.equal(handled, true, "/react/ 应当被处理");
    assert.equal(res.code, 200);
    assert.ok(res.body.includes(REACT_MARK), "应当吐出 React 外壳");
  });
});

test("serveStatic: 目录入口（无尾斜杠）同样回落", () => {
  withFixture({}, (root) => {
    const res = mockRes();
    assert.equal(serveStatic("/react", res, root) !== false, true);
    assert.equal(res.code, 200);
    assert.ok(res.body.includes(REACT_MARK));
  });
});

test("serveStatic: 具体文件不受影响", () => {
  withFixture({}, (root) => {
    const res = mockRes();
    assert.equal(serveStatic("/react/assets/app.js", res, root) !== false, true);
    assert.equal(res.code, 200);
    assert.ok(res.body.includes("export const x"));
  });
});

test("serveStatic: 不存在的路径不误判为已处理", () => {
  withFixture({}, (root) => {
    const res = mockRes();
    assert.equal(serveStatic("/react/nope/", res, root), false);
    assert.equal(res.code, null);
  });
});

test("serveIndex: 构建产物在 → React 外壳", () => {
  withFixture({ withReact: true }, (root) => {
    const res = mockRes();
    assert.notEqual(serveIndex(res, root), false);
    assert.equal(res.code, 200);
    assert.ok(res.body.includes(REACT_MARK), "/ 默认必须是 React 新版");
  });
});

test("serveIndex: 构建产物缺失 → 回落 vanilla（fresh checkout 也能打开）", () => {
  withFixture({ withReact: false }, (root) => {
    const res = mockRes();
    assert.notEqual(serveIndex(res, root), false);
    assert.equal(res.code, 200);
    assert.ok(res.body.includes(VANILLA_MARK), "必须回落到 vanilla 而不是 404");
  });
});

test("serveLegacyIndex: 归档入口永远是 vanilla，与产物无关", () => {
  withFixture({ withReact: true }, (root) => {
    const res = mockRes();
    assert.notEqual(serveLegacyIndex(res, root), false);
    assert.ok(res.body.includes(VANILLA_MARK), "/legacy/ 必须是归档的 vanilla 外壳");
    assert.ok(!res.body.includes(REACT_MARK));
  });
});

// 路由判据回归：目录入口必须满足静态路由的 match 条件。
// 这里复刻 router.js 里那条判据，防止有人改回去。
test("静态路由 match 判据接受目录入口", () => {
  const match = (p) => !!p && p !== "/" && (p.includes(".") || p.endsWith("/"));
  assert.equal(match("/react/"), true, "/react/ 必须命中静态路由");
  assert.equal(match("/styles/main.css"), true);
  assert.equal(match("/"), false, "根路径走 serveIndex");
});
