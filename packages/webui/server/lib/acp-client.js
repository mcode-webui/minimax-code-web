// webui/server/lib/acp-client.js
// ACP client singleton + command/session cache.
// Does NOT replace acp.mjs (which is the JSON-RPC transport).
// Wraps it with caching/lifecycle for webui use.
//
// S3 (runtime-first migration step 3): when MCODE_WEBUI_TRANSPORT=runtime,
// the catalogue host (server/lib/runtime-host.js) takes the list/title
// traffic and we skip the mcode acp subprocess entirely. The catalogue
// boot is process-lifetime like the ACP singleton: one instance, lazy
// init, a single sqlite read per list call. Any failure (host not
// constructed, list throws, etc.) falls back to the legacy ACP path so
// a runtime regression does not break the sidebar — the fallback is
// a one-line log message, not silent.

import { McodeAcpClient } from "../../acp.mjs";
import { CMD_BUTTON_COMMANDS } from "./interaction/command-registry.js";
import {
  DEFAULT_WORKSPACE,
  MCODE_RUNTIME_DB,
  MCODE_WEBUI_TRANSPORT,
  MAVIS_DATA_DIR,
} from "./config.js";
import { deleteMcodeSessionFromDb } from "./mcode-session-delete.js";
import {
  listMcodeSessionsViaRuntime,
  getMcodeSessionTitleViaRuntime,
} from "./catalogue-sessions.js";

// ---------------------------------------------------------------------------
// S3: catalogue host (in-process runtime) wiring.
// ---------------------------------------------------------------------------

let _catalogueHost = null;
let _catalogueHostInitPromise = null;

/**
 * The process-lifetime catalogue host singleton, booted on first call.
 *
 * Exported because `/api/plugins/*` (routes/plugins.js) and
 * `/api/turn-diff*` (routes/turn-diff.js) need the runtime's `cliService`
 * and `applications.session.diff` as their only data sources, and the host
 * is the single owner of both. Since migration step M3's first batch (B0)
 * those routes no longer import this module: they call the facade's
 * `getEngineCatalogueHost()` (server/engine/host.js), which forwards here
 * through a dynamic import, because `app.js` loads the engine facade at
 * boot and this module carries the ACP client tree. The reasons below are
 * the facade's reasons now, and the facade forwards them unchanged.
 *
 * Routing plugins through the host is deliberate: `transportWantsCatalogue()`
 * below gates *session-list* traffic only — in ACP protocol there is no
 * plugin method at all, so gating plugins on the transport would leave the
 * panel dead in the default `acp` mode. Callers must never construct a
 * second host: two CliService instances on one dataDir is both wasteful and
 * a split-brain against the plugin/local-disable tables.
 *
 * Resolves to `null` when the runtime fails to boot; callers answer
 * `RUNTIME_UNAVAILABLE` rather than falling back to another path.
 */
export async function getCatalogueHost() {
  if (_catalogueHost) return _catalogueHost;
  if (_catalogueHostInitPromise) return _catalogueHostInitPromise;
  _catalogueHostInitPromise = (async () => {
    try {
      // Lazy import — keeps runtime-host.js out of the boot path for
      // ACP-only deployments.
      const { createCatalogueHost } = await import("./runtime-host.js");
      _catalogueHost = await createCatalogueHost({ dataDir: MAVIS_DATA_DIR });
      console.log(`[runtime] catalogue host ready (dataDir=${MAVIS_DATA_DIR})`);
      return _catalogueHost;
    } catch (e) {
      console.warn(`[runtime] catalogue host init failed: ${e.message}`);
      return null;
    } finally {
      _catalogueHostInitPromise = null;
    }
  })();
  return _catalogueHostInitPromise;
}

function transportWantsCatalogue() {
  return MCODE_WEBUI_TRANSPORT === "runtime";
}

// v0.5.bu: 拉 mcode 真实 session 列表（mcode acp session/list 协议）
// 数据源：mcode TUI 自己的 session 存储（不是 webui 的 sessions.json）
// 按 cwd 过滤（mcode 每个 session 都有 cwd 字段，匹配 cs.workspace.dir 才显示）
let mcodeSessionsCache = { ws: null, sessions: [], fetchedAt: 0 };

// v0.5.bx-19: mcode acp client 单例后台常驻 — 之前每次 getMcodeSessionsForWorkspace cache miss 都
//   new McodeAcpClient + start + list + stop, 切 session 频繁触发, 2-3 个 mcode 子进程并发, CPU 高
//   单例常驻后, 切 session 只走 30s cache hit, 0 spawn
let _mcodeAcpSingleton = null;
let _mcodeAcpInitPromise = null; // 防止并发 init 同一个 client

export async function getMcodeAcpClient() {
  if (_mcodeAcpSingleton && _mcodeAcpSingleton.alive) return _mcodeAcpSingleton;
  if (_mcodeAcpInitPromise) return _mcodeAcpInitPromise;
  _mcodeAcpInitPromise = (async () => {
    const client = new McodeAcpClient({ debug: false });
    try {
      await client.start();
      _mcodeAcpSingleton = client;
      console.log(`[acp] singleton client started pid=${client.pid || "?"}`);
      return client;
    } catch (e) {
      console.warn(`[acp] singleton start failed: ${e.message}`);
      try {
        client.stop();
      } catch {}
      return null;
    } finally {
      _mcodeAcpInitPromise = null;
    }
  })();
  return _mcodeAcpInitPromise;
}

// v0.5.bx-19 (改 #2): 列出所有 mcode session (跨 workspace), 不做 cwd 过滤
//   之前 getMcodeSessionsForWorkspace 内部用同一个 cache, 但 cleanup 需要列所有
//   这函数绕过 cwd 过滤, 走 mcode acp 直接拿 raw 列表
export async function listAllMcodeSessions() {
  // S3: catalogue path preferred when MCODE_WEBUI_TRANSPORT=runtime.
  // The catalogue host reads the same SQLite, so the page shape and
  // content are equivalent — both paths return the ACP wire shape
  // (sessionId/cwd/title) by construction.
  if (transportWantsCatalogue()) {
    const host = await getCatalogueHost();
    if (host) {
      try {
        return await listMcodeSessionsViaRuntime(host);
      } catch (e) {
        console.warn(`[runtime] listAllMcodeSessions failed, falling back to ACP: ${e.message}`);
        // Fall through to the ACP path so a runtime regression never
        // breaks the sidebar.
      }
    }
  }
  const client = await getMcodeAcpClient();
  if (!client) return [];
  try {
    const r = await client.listSessions();
    return r && Array.isArray(r.sessions) ? r.sessions : [];
  } catch (e) {
    console.warn(`[acp] listAllMcodeSessions failed: ${e.message}`);
    // Stop before dropping the reference. Nulling alone leaks the subprocess:
    // its stdio pipes keep the caller's event loop alive, so `node --test` never
    // exits in a logged-out environment, and in production every auth failure
    // leaks one child. (Fix landed on main as 7590309; carried through the
    // rebase by hand because the rest of main's change to this file is the
    // superseded transport.)
    if (_mcodeAcpSingleton === client) {
      _mcodeAcpSingleton = null;
      try { client.stop(); } catch {}
    }
    return [];
  }
}

export async function getMcodeSessionsForWorkspace(workspace) {
  const STALE_MS = 30 * 1000; // 30s — 比 commands 的 5min 短，因为 prompt 后要立即刷新
  const now = Date.now();
  if (
    mcodeSessionsCache.ws === workspace &&
    now - mcodeSessionsCache.fetchedAt < STALE_MS
  ) {
    return mcodeSessionsCache.sessions;
  }
  const all = await listAllMcodeSessions();
  // 按 cwd 过滤（normalize path — windows 大小写不敏感 + 去尾斜杠）
  const norm = (p) =>
    (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = norm(workspace);
  const filtered = target ? all.filter((s) => norm(s.cwd) === target) : all;
  mcodeSessionsCache = { ws: workspace, sessions: filtered, fetchedAt: now };
  return filtered;
}

// v0.5.bx-31: 同步读 cache, 给 pushStateFor 用 (pushStateFor 是同步, 不能 await getMcodeSessionsForWorkspace)
//   命中: 返 array; miss 或 workspace 不匹配: 返 null (caller 自己决定 fallback [] 或 fire-and-forget 拉)
//
// S3: the cache is shared between the ACP path and the catalogue path
// (both write through `mcodeSessionsCache`). The cache is filled by
// `getMcodeSessionsForWorkspace` only — readers must call that
// async fn first to populate it, then read here. The catalogue path
// reads the same SQLite, so a cache built by one path serves the
// other equivalently.
export function getMcodeSessionsCacheSync(workspace) {
  const now = Date.now();
  if (
    mcodeSessionsCache.ws === workspace &&
    now - mcodeSessionsCache.fetchedAt < 30 * 1000
  ) {
    return mcodeSessionsCache.sessions;
  }
  return null;
}

// v1.0: 过期但同 workspace 的缓存 — 返回过期列表 (宁推旧值不推空);
//   之前 TTL 一过 caller 直接推空占位, 侧栏闪跌十来条再弹回 (删除/广播都触发)
export function getMcodeSessionsStaleSync(workspace) {
  if (mcodeSessionsCache.ws === workspace && mcodeSessionsCache.ws !== null) {
    return mcodeSessionsCache.sessions;
  }
  return null;
}

// v0.5.bx: prompt 完成后用 mcodeSessionId 反查 mcode 真实 title
// 数据源：mcode TUI 自己的 session 存储（不是 webui 的）
// 用途：替换 webui "New session" / 截断首句 → 用 mcode 自动生成的标题
export async function getMcodeSessionTitle(mcodeSessionId) {
  if (!mcodeSessionId) return null;
  // S3: catalogue path preferred when MCODE_WEBUI_TRANSPORT=runtime.
  if (transportWantsCatalogue()) {
    const host = await getCatalogueHost();
    if (host) {
      try {
        return await getMcodeSessionTitleViaRuntime(host, mcodeSessionId);
      } catch (e) {
        console.warn(`[runtime] getMcodeSessionTitle failed, falling back to ACP: ${e.message}`);
      }
    }
  }
  const client = await getMcodeAcpClient();
  if (!client) return null;
  try {
    const r = await client.listSessions();
    const all = r && Array.isArray(r.sessions) ? r.sessions : [];
    const hit = all.find((s) => s.sessionId === mcodeSessionId);
    return hit && hit.title ? hit.title : null;
  } catch (e) {
    console.warn(`[acp] getMcodeSessionTitle failed: ${e.message}`);
    // Same as listAllMcodeSessions — stop before dropping the reference.
    if (_mcodeAcpSingleton === client) {
      _mcodeAcpSingleton = null;
      try { client.stop(); } catch {}
    }
    return null;
  }
}

// v0.5.bx-19: 软失效 — 只让 TTL 立即过期, 保留 cached sessions (这样切 session 不阻塞)
export function invalidateMcodeSessionsCache() {
  mcodeSessionsCache = { ...mcodeSessionsCache, fetchedAt: 0 };
}

// v1.0: 硬剔除 — 把指定 sid 从 cached 数组里移除 (删除会话后立即从侧栏消失, 不等 30s TTL)
export function dropMcodeSessionFromCache(sid) {
  if (!sid) return;
  mcodeSessionsCache = {
    ...mcodeSessionsCache,
    sessions: mcodeSessionsCache.sessions.filter((s) => s.sessionId !== sid),
  };
}

// v0.5.bx-19: 进程退出时关掉 singleton mcode acp (避免僵尸)
export function shutdownMcodeAcpSingleton() {
  if (_mcodeAcpSingleton) {
    try {
      _mcodeAcpSingleton.stop();
    } catch {}
    _mcodeAcpSingleton = null;
  }
  // S3: also close the catalogue host so the bounded drain fires
  // before graceful-shutdown returns. The catalogue host shares the
  // bounded-drain semantics from runtime-host.js.
  if (_catalogueHost) {
    const host = _catalogueHost;
    _catalogueHost = null;
    try {
      // Fire and forget — graceful-shutdown.js polls its own timer; we
      // don't block on the runtime-side close.
      host.close().catch(() => {});
    } catch {}
  }
}

// v0.5.by: 暴露 mcode acp initialize 响应 (含 agentInfo) 给能力探测
//  - 用于 GET /api/protocol/capabilities 返回动态 mcode version (不 hardcode)
//  - 不暴露 _mcodeAcpSingleton 内部,只读 agentInfo
//  - initialize answers with { protocolVersion, agentCapabilities, agentInfo: { name, title, version } }
export function getMcodeServerInfo() {
  if (!_mcodeAcpSingleton || !_mcodeAcpSingleton.capabilities) return null;
  return _mcodeAcpSingleton.capabilities.agentInfo || null;
}

// ============================================================
// v0.5.ak: mcode 真实命令缓存（不套预设）
// 用一个长寿命 McodeAcpClient lazy init 拉 available_commands_update
// /help 读这里，不用 hardcode 列表
//
// 本模块不声明 webui 本地命令表。缓存的 `webui` 组直接取自
// interaction/command-registry.js#CMD_BUTTON_COMMANDS —— 它是 POST /api/cmd
// 接受集的唯一声明处，也是 /help 兜底与 400 分支读的那一份。此前这里另有一份
// 7 条目的 WEBUI_LOCAL_COMMANDS（缺 /review），而本文件是 /help 与命令面板
// （SSE availableCommands.webui → composer.tsx）的活路径来源，兜底路径反而读
// 注册表，于是同一次 /help 会打出两张不同的命令表。现在只有一个事实来源；
// test/lib/command-list-drift.check.mjs 钉住这个关系。
// ============================================================
let cachedMcodeCommands = {
  mcode: [],
  webui: [],
  fetchedAt: 0,
  source: "none",
};
let mcodeCommandsClient = null; // long-lived McodeAcpClient
let mcodeCommandsPromise = null; // 去重 lazy init

export function getCachedMcodeCommands() {
  return cachedMcodeCommands;
}

export async function ensureMcodeCommands({
  forceRefresh = false,
  onRefresh,
} = {}) {
  // v1.0: 5min → 24h — 这个函数靠 newSession 触发 available_commands_update,
  //   而 newSession 是真实持久化的 (db 里留 mvs_ 会话, 侧栏堆积 "Mcode session")。
  //   5min TTL 下每次过期都新建一个; 命令列表只在 mcode 升级时变, 每次进程启动刷一次足够
  const STALE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedMcodeCommands.mcode.length > 0 &&
    now - cachedMcodeCommands.fetchedAt < STALE_MS
  ) {
    return cachedMcodeCommands;
  }
  // 去重：如果已经在 fetch，复用
  if (mcodeCommandsPromise) return mcodeCommandsPromise;
  mcodeCommandsPromise = (async () => {
    // v1.0: 记下探测会话 sid, 拉完命令后清掉 (否则侧栏每次启动多一个 "Mcode session")
    let probeSid = null;
    try {
      // 关掉旧 client（refresh 时）
      if (mcodeCommandsClient) {
        try {
          mcodeCommandsClient.stop();
        } catch {}
        mcodeCommandsClient = null;
      }
      const client = new McodeAcpClient({ debug: false });
      mcodeCommandsClient = client;
      // v0.5.ak fix: available_commands_update 是在 session/new 之后才发的，不是 initialize 之后
      // 所以要：start → newSession → listen event
      const got = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error("mcode acp available_commands_update timeout 8s")),
          8000,
        );
        client.on("available_commands_update", (u) => {
          // payload 形态待定：{commands: [...]} 或 [...string] 或其他
          const cmds = (u && (u.commands || u.availableCommands || u)) || [];
          const list = Array.isArray(cmds) ? cmds : [];
          clearTimeout(timer);
          resolve(list);
        });
        client
          .start()
          .then(() => client.newSession(DEFAULT_WORKSPACE))
          .then((r) => {
            probeSid = r && r.sessionId ? r.sessionId : null;
          })
          .catch((e) => {
            clearTimeout(timer);
            reject(e);
          });
      });
      const list = await got;
      cachedMcodeCommands = {
        mcode: list,
        webui: CMD_BUTTON_COMMANDS,
        fetchedAt: Date.now(),
        source: "mcode.acp.available_commands_update",
      };
      console.log(
        `[webui] cachedMcodeCommands refreshed: ${list.length} mcode commands`,
      );
      if (typeof onRefresh === "function") onRefresh();
      return cachedMcodeCommands;
    } catch (e) {
      console.warn(`[webui] ensureMcodeCommands failed: ${e.message}`);
      cachedMcodeCommands = {
        mcode: [],
        webui: CMD_BUTTON_COMMANDS,
        fetchedAt: 0,
        source: `error: ${e.message}`,
      };
      return cachedMcodeCommands;
    } finally {
      mcodeCommandsPromise = null;
      // 关掉 client（保持长寿命的话别 stop，但 mcode acp 闲置 5min 后可能 hang，先关掉按需重启）
      if (mcodeCommandsClient) {
        try {
          mcodeCommandsClient.stop();
        } catch {}
        mcodeCommandsClient = null;
      }
      // v1.0: 清理探测会话 — 探测 client 已 stop (无回写源), 再 SQL 删 + 缓存剔除该 sid。
      //   不整体作废缓存 (会让侧栏闪跌后复原); TTL 自然过期后新子进程重读即可
      if (probeSid) {
        try {
          shutdownMcodeAcpSingleton();
        } catch {}
        try {
          const del = deleteMcodeSessionFromDb(probeSid, { MCODE_RUNTIME_DB });
          console.log(
            `[webui] commands probe session cleaned: ${probeSid.substring(0, 12)}… ok=${del.ok}`,
          );
        } catch {}
        dropMcodeSessionFromCache(probeSid);
      }
    }
  })();
  return mcodeCommandsPromise;
}
