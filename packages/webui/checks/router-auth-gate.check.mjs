// webui/checks/router-auth-gate.check.mjs
// v2.3: the token gate page for GET / and /index.html. Behavioral pins
// through the REAL handleRequest:
//
//   - non-local request + token auth on + no token      → auth-gate.html
//   - non-local + invalid token                          → auth-gate.html
//   - non-local + valid token (?token=)                  → index.html
//   - non-local + valid token (Bearer)                   → index.html
//   - loopback (local) without token                     → index.html (bypass)
//   - token auth OFF + non-local without token           → index.html
//
// Without this gate the app shell loaded and every /api/* then 401'd with
// no guidance (surfaced to users as "加载目录失败: 401" in the picker).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const PORT = 8124;
const GATE_TOKEN = "gate-test-token";

let _tmpSettings;
let _tmpEvents;
before(async () => {
  process.env.PORT = String(PORT);
  _tmpSettings = mkdtempSync(join(tmpdir(), "webui-authgate-settings-"));
  _tmpEvents = mkdtempSync(join(tmpdir(), "webui-authgate-events-"));
  process.env.MCODE_WEBUI_SETTINGS_PATH = join(_tmpSettings, "settings.json");
  process.env.MCODE_WEBUI_EVENTS_PATH = join(_tmpEvents, "events.ndjson");
  process.env.TOKEN = GATE_TOKEN;
  delete process.env.HOST;
});
after(async () => {
  delete process.env.PORT;
  delete process.env.TOKEN;
  for (const d of [_tmpSettings, _tmpEvents]) {
    if (d) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
});

const router = await import(absPath("router.js"));
const settingsLib = await import(absPath("lib/settings.js"));
settingsLib.init({});

function fakeReq({ method = "GET", url = "/", remoteAddress = "192.0.2.9", headers: extra = {} }) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = { host: `192.0.2.9:${PORT}`, ...extra };
  req.socket = { remoteAddress };
  return req;
}

function fakeRes() {
  const res = {
    _headers: {},
    _status: null,
    _body: "",
    headersSent: false,
    setHeader(k, v) {
      this._headers[String(k).toLowerCase()] = v;
    },
    getHeader(k) {
      return this._headers[String(k).toLowerCase()];
    },
    writeHead(status, headers = {}) {
      this._status = status;
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
      this.headersSent = true;
    },
    write(chunk) {
      this._body += chunk;
    },
    end(chunk) {
      if (chunk !== undefined) this._body += chunk;
      this.headersSent = true;
    },
  };
  return res;
}

async function get(path, opts = {}) {
  const res = fakeRes();
  await router.handleRequest(fakeReq({ url: path, ...opts }), res);
  return res;
}

import { existsSync } from "node:fs";
import { PUBLIC_DIR } from "../server/lib/static.js";

const isGate = (res) => res._body.includes("auth-gate") || res._body.includes("webui_token");
// 「到达了某个应用外壳」—— 根路径现在默认是 React 新版（/react/assets/ 前缀的
// 资源引用），归档的 vanilla 单页在 /legacy/（DOM id chat-inner）。两者都算过关，
// 因为这组测试要验的是 token 门禁本身，不是外壳长什么样。
const isIndex =
  (res) => res._body.includes("chat-inner") || res._body.includes("/react/assets/");
const isReactShell = (res) => res._body.includes("/react/assets/");
const isVanillaShell = (res) => res._body.includes("chat-inner");

describe("router — token gate page (v2.3)", () => {
  test("non-local + no token → gate page", async () => {
    const res = await get("/");
    assert.equal(res._status, 200);
    assert.ok(isGate(res), "unauthenticated non-local request gets the gate page");
    assert.ok(!isIndex(res), "the app shell must not be served");
  });

  test("non-local + wrong token → gate page", async () => {
    const res = await get("/?token=wrong-token");
    assert.ok(isGate(res));
  });

  test("non-local + valid token via query → index", async () => {
    const res = await get(`/?token=${GATE_TOKEN}`);
    assert.ok(isIndex(res), "valid token must reach the app shell");
    assert.ok(!isGate(res));
  });

  test("non-local + valid token via Bearer → index", async () => {
    const res = await get("/", { headers: { authorization: `Bearer ${GATE_TOKEN}` } });
    assert.ok(isIndex(res));
  });

  test("loopback without token → index (local bypass intact)", async () => {
    const res = await get("/", { remoteAddress: "127.0.0.1", headers: { host: `127.0.0.1:${PORT}` } });
    assert.ok(isIndex(res), "local requests never see the gate");
  });

  // v2.5: 根路径默认新版，原版归档到 /legacy/（用户决策：「原版归档，运行默认是新版」）。
  //
  // 断言按**真实契约**写，而不是硬绑构建产物：public/react/ 是 vite 的构建
  // 输出（gitignored），CI 的 test:webui 并不先跑 build，所以 fresh checkout
  // 上它不存在 —— 那时 serveIndex 必须回落到 vanilla 外壳，页面照样可达。
  // 于是：产物在 → 必须是 React 外壳；产物不在 → 必须是 vanilla 外壳。
  // 两种情况都必须是「一个能打开的应用外壳」。
  const reactBuilt = existsSync(join(PUBLIC_DIR, "react", "index.html"));

  test("根路径默认是 React 新版外壳（构建产物存在时）", async () => {
    const res = await get("/", { remoteAddress: "127.0.0.1", headers: { host: `127.0.0.1:${PORT}` } });
    assert.equal(res._status, 200);
    if (reactBuilt) {
      assert.ok(isReactShell(res), "/ 必须是 React 新版外壳");
    } else {
      assert.ok(isVanillaShell(res), "构建产物缺失时 / 必须回落到 vanilla 外壳");
    }
    assert.ok(isIndex(res), "/ 必须可达，不能 404");
  });

  test("原版归档在 /legacy/，且与根路径互不占用", async () => {
    const legacy = await get("/legacy/", { remoteAddress: "127.0.0.1", headers: { host: `127.0.0.1:${PORT}` } });
    assert.equal(legacy._status, 200);
    assert.ok(isVanillaShell(legacy), "/legacy/ 必须是原版 vanilla 外壳（归档永远可达）");

    const modern = await get("/", { remoteAddress: "127.0.0.1", headers: { host: `127.0.0.1:${PORT}` } });
    assert.ok(isIndex(modern), "/ 也必须可达");
    if (reactBuilt) {
      assert.ok(!isVanillaShell(modern), "产物在时 / 不应再是 vanilla 外壳");
    }
  });

  test("gate page is self-contained and stores the right localStorage key", async () => {
    const res = await get("/");
    assert.ok(isGate(res));
    assert.match(res._body, /localStorage\.setItem\('webui_token'/, "stores into the key state.js reads");
    assert.match(res._body, /\/api\/health\?token=/, "verifies against the health endpoint before entering");
    assert.ok(!/src=["']https?:/.test(res._body), "no external scripts (works pre-auth)");
  });

  // Note: "token auth off" is unreachable in this file because the env
  // TOKEN path always wins (auth.js, fail-closed by design). The
  // settings-toggle-off flow only exists when no env token is set, which
  // is a different process image; the local-bypass test above covers the
  // reachable matrix here.
});
