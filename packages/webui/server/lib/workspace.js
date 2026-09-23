// webui/server/lib/workspace.js
// Workspace state + browsing helpers.

import {
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
  sep,
  delimiter,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { DEFAULT_WORKSPACE } from "./config.js";
import { detectTuiCwd } from "./config.js";
import { pushStateFor } from "./state-bus.js";
import { loadSessions } from "./sessions.js";
import { spawn } from "node:child_process";
import { basename } from "node:path";

// Workspace containment.
//
// Candidate paths are realpathSync'd into one of an "allowed roots"
// set before being accepted; traversal and symlink-escape attempts are
// rejected at that check with an actionable error. Allowed roots come
// from env MCODE_WEBUI_WORKSPACE_ROOTS (system-path-delimiter
// separated, full-replacement semantics); unset = default surface =
// user home + DEFAULT_WORKSPACE + tmp dir. So scratch workspaces in
// /tmp keep working without configuration.
//
// Known residual: cs.workspace.dir stores the resolve() form, not the
// realpath form (matches the prior behavior + tests). If a symlink is
// repointed out of the allowed roots AFTER the initial check, there is
// a small window — far narrower than the prior "any directory"
// surface. The route handlers do not currently re-check on every
// command, by design.
const WORKSPACE_ROOTS_ENV = "MCODE_WEBUI_WORKSPACE_ROOTS";

// Read every call (realpath + dedupe + filter to existing dirs). Tests
// and ops can change the surface mid-run with no cache invalidation.
export function getAllowedWorkspaceRoots() {
  const fromEnv = process.env[WORKSPACE_ROOTS_ENV];
  const candidates = [];
  if (fromEnv && fromEnv.trim()) {
    for (const p of fromEnv.split(delimiter)) {
      const t = p.trim();
      if (t) candidates.push(resolve(t));
    }
  } else {
    candidates.push(homedir(), DEFAULT_WORKSPACE, tmpdir());
  }
  const roots = [];
  for (const c of candidates) {
    let real;
    try {
      real = realpathSync(c);
      if (!statSync(real).isDirectory()) continue;
    } catch {
      continue; // 不存在/不可解析的根直接跳过，不 fatal
    }
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

// dir 是否位于 root 内（含 root 本身）。用 relative() 而非字符串前缀：
// ".."-开头或跨盘绝对路径都判外；`..${sep}` 前缀写法不会误杀 "..foo" 这类
// 合法目录名。
function isWithinRoot(root, dir) {
  const rel = relative(root, dir);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function containmentError(absDir, realDir, roots) {
  const via = realDir === absDir ? "" : `（软链解析后为 ${realDir}）`;
  const rootsDesc = roots.length
    ? roots.join(" , ")
    : `（空 — 检查 ${WORKSPACE_ROOTS_ENV} 是否全部指向存在的目录）`;
  return (
    `工作区越界: ${absDir}${via} 不在任何允许根内。` +
    `允许根: ${rootsDesc}。` +
    `如需扩展请设置 ${WORKSPACE_ROOTS_ENV} 环境变量` +
    `（多个根用系统路径分隔符分段；设置后完全替换默认允许根）。`
  );
}

// Resolve `absDir` (already an absolute path) and verify it falls
// inside one of the allowed roots after full symlink resolution.
// Returns {ok:true, real, roots} or {ok:false, error, roots}.
function resolveWithinRoots(absDir) {
  const roots = getAllowedWorkspaceRoots();
  let real;
  try {
    real = realpathSync(absDir);
  } catch (e) {
    return {
      ok: false,
      roots,
      error: `无法解析路径 ${absDir}: ${e.message}`,
    };
  }
  for (const r of roots) {
    if (isWithinRoot(r, real)) return { ok: true, real, roots };
  }
  return { ok: false, roots, error: containmentError(absDir, real, roots) };
}

// Per-cid workspace switch.
// body: {dir, syncTui?, saveRecent?, action?}
//   dir: absolute path; must exist and fall inside an allowed root
//   syncTui: when true, also write ~/.minimax/runtime/cwd.json so the
//            mcode TUI sees the new cwd
//   saveRecent: when true (default), record dir in the per-cid recents
//   action: 'set' (default) | 'useTui' (read TUI's cwd.json) |
//           'reset' (DEFAULT_WORKSPACE) | 'detect' (read-only probe)
export function handleWorkspaceChange(cs, cid, payload) {
  const action = payload.action || "set"; // 'set' | 'useTui' | 'reset' | 'detect'
  let target;
  if (action === "useTui") {
    target = detectTuiCwd();
    if (!target)
      return { ok: false, error: "mcode TUI 还没启动过，没有 cwd 记录" };
  } else if (action === "reset") {
    target = DEFAULT_WORKSPACE;
  } else if (action === "detect") {
    const tui = detectTuiCwd();
    return {
      ok: true,
      tuiCwd: tui,
      defaultWorkspace: DEFAULT_WORKSPACE,
      current: cs.workspace.dir,
      detectOnly: true,
    };
  } else {
    target = payload.dir;
  }
  if (!target || typeof target !== "string")
    return { ok: false, error: "dir 不能为空" };
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { ok: false, error: `目录不存在: ${target}` };
  }
  const absDir = resolve(target);
  // Containment check — useTui/reset targets go through the same gate
  // and yield an actionable error on miss instead of silent passthrough.
  const contained = resolveWithinRoots(absDir);
  if (!contained.ok) return { ok: false, error: contained.error };
  // Store the resolve() form (matches existing behavior + tests; the
  // containment check above is the real enforcement line).
  cs.workspace = { dir: absDir, branch: null, tree: null };
  if (payload.syncTui) {
    try {
      const cwdFile = join(homedir(), ".minimax", "runtime", "cwd.json");
      mkdirSync(dirname(cwdFile), { recursive: true });
      writeFileSync(
        cwdFile,
        JSON.stringify({ cwd: absDir, updatedAt: Date.now() }, null, 2),
        "utf8",
      );
    } catch (e) {
      console.warn(`[webui] sync cwd.json failed: ${e.message}`);
    }
  }
  pushStateFor(cid);
  return {
    ok: true,
    workspace: cs.workspace,
    tuiCwd: detectTuiCwd(),
    defaultWorkspace: DEFAULT_WORKSPACE,
  };
}

// List the directories under `rawPath` (only directories, lazy-loaded
// for the front-end tree). When `rawPath` is empty, returns the allowed
// roots.
//
// Same containment boundary as handleWorkspaceChange: only directories
// inside an allowed root are enumerable. The root-view (no path) is
// restricted to the allowed roots themselves, not the platform root.
//
// Response shape compatibility:
//   POSIX: dir:"/", entries from "/"
//   Windows: dir:null, roots-only
// The front-end branches on data.roots; both shapes must stay stable.
export function browseWorkspace(rawPath) {
  const MAX = 500; // 单层最多返回 500 个子目录，避免 huge dirs 把前端卡死
  let target,
    parent,
    roots = null;
  if (!rawPath) {
    // 没传 path → 根视图 = 允许根（前端把它渲染为顶层节点）
    roots = getAllowedWorkspaceRoots();
    target = process.platform === "win32" ? null : "/";
    if (target) {
      const parentPath = dirname(target);
      parent = parentPath === target ? null : parentPath;
    } else {
      parent = null;
    }
    return { ok: true, dir: target, parent, roots, children: [] };
  }
  target = resolve(rawPath);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { ok: false, error: `目录不存在: ${rawPath}` };
  }
  // Containment check before enumerating — only directories inside an
  // allowed root are enumerable.
  const contained = resolveWithinRoots(target);
  if (!contained.ok) return { ok: false, error: contained.error };
  const parentPath = dirname(target);
  parent = parentPath === target ? null : parentPath;
  if (parent !== null && !resolveWithinRoots(parent).ok) {
    // 上级已在允许根外 → 导航到顶（前端 up 按钮不再引导越界请求）
    parent = null;
  }
  const children = [];
  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: `无法读取: ${e.message}` };
  }
  const dirs = [];
  let skipped = 0;
  for (const ent of entries) {
    if (dirs.length >= MAX) {
      skipped++;
      continue;
    }
    try {
      if (ent.isDirectory()) {
        dirs.push({ name: ent.name, path: join(target, ent.name) });
      }
    } catch {
      skipped++;
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans"));
  children.push(...dirs);
  return {
    ok: true,
    dir: target,
    parent,
    children,
    skipped,
    total: dirs.length,
  };
}

// Directory-picker helpers (exposed by the webui for the front-end's
// fallback directory selection flow). All entries are read-only
// aggregates or return candidates; final points-of-no-return go
// through handleWorkspaceChange's containment check.

// expandTilde — accepts leading "~", "~/" or "~\" exactly once and
// expands to the user's home directory. ("~user" syntax not supported.)
export function expandTilde(rawPath) {
  if (typeof rawPath !== "string") return rawPath;
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

// resolveWorkspaceCandidates — pair the front-end's webkitdirectory
// <input type="file"> (hidden, no browser authorization prompt) with
// a server-side search for matching folder names in platform-typical
// search roots. One candidate → submit directly; multiple → user picks;
// none → caller falls back to the built-in tree.
//
// Search roots by platform:
//   all: home itself + home's first-level subdirs + common project parents (2 levels)
//   win32: every existing drive letter (C:\name, D:\name, ...)
//   darwin: /Volumes/<name>
//   linux: /mnt, /media(/$USER), /run/media(/$USER)
//
// opts.home / opts.platform / opts.user are injectable for tests.
export function resolveWorkspaceCandidates(rawName, opts = {}) {
  const home = opts.home || homedir();
  const platform = opts.platform || process.platform;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  // 校验：必须是纯目录名（不能带路径分隔符），防注入/防误用
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.length > 255
  ) {
    return {
      ok: false,
      error: "非法目录名（不能为空、不能包含路径分隔符）",
      name: name || null,
      home,
      platform,
      candidates: [],
    };
  }
  const candidates = [];
  const seen = new Set();
  const push = (dirPath, via) => {
    try {
      const abs = resolve(dirPath);
      if (seen.has(abs)) return;
      if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
      seen.add(abs);
      candidates.push({ path: abs, via });
    } catch {}
  };
  // 跳过隐藏目录和已知巨无霸目录（只影响"往下再搜一层"的父目录遍历）
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "AppData",
    "Application Data",
    "Library",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "System Volume Information",
    "$RECYCLE.BIN",
  ]);
  const safeReaddir = (dirPath) => {
    try {
      return readdirSync(dirPath, { withFileTypes: true })
        .filter(
          (ent) =>
            ent.isDirectory() &&
            ent.name !== "." &&
            ent.name !== ".." &&
            !ent.name.startsWith(".") &&
            !SKIP_DIRS.has(ent.name),
        )
        .slice(0, 500) // 与 browseWorkspace 同款上限，防 huge dirs
        .map((ent) => ent.name);
    } catch {
      return [];
    }
  };
  const listChildren = (dirPath) => safeReaddir(dirPath).map((n) => join(dirPath, n));

  // 1) home 自身（仅当其 basename 恰好等于目标名，例如 home 是 /Users/proj）
  if (basename(home) === name) push(home, "home");
  // 2) home 一级子目录: ~/name（只收名字精确匹配的）
  const homeChildren = listChildren(home);
  for (const child of homeChildren) {
    if (basename(child) === name) push(child, "home-sub");
  }
  // 3) home 常见项目父目录的二级: ~/projects/name、~/Desktop/name …
  const COMMON_PROJECT_PARENTS = new Set([
    "Desktop", "Documents", "Downloads", "projects", "Projects", "code",
    "Code", "codes", "Codes", "dev", "Dev", "develop", "Develop",
    "workspace", "workspaces", "repos", "repo", "Repo", "src", "git",
    "work", "Work", "桌面", "文档", "下载", "项目", "代码", "工作区",
  ]);
  for (const child of homeChildren) {
    if (!COMMON_PROJECT_PARENTS.has(basename(child))) continue;
    for (const grand of listChildren(child)) {
      if (basename(grand) === name) push(grand, "home-deep");
    }
  }
  // 4) 平台特有根
  if (platform === "win32") {
    for (let c = 65; c <= 90; c++) {
      const drive = String.fromCharCode(c) + ":\\";
      try {
        if (!existsSync(drive)) continue;
      } catch {
        continue;
      }
      push(join(drive, name), "drive");
      for (const child of listChildren(drive)) push(join(child, name), "drive-sub");
    }
  } else if (platform === "darwin") {
    for (const vol of listChildren("/Volumes")) {
      push(join(vol, name), "volumes");
    }
  } else {
    // linux: 外接盘 / 容器挂载点常见位置
    const user = opts.user || process.env.USER || process.env.USERNAME || "";
    const mediaRoots = ["/mnt", "/media", `/media/${user}`, "/run/media", `/run/media/${user}`];
    for (const root of mediaRoots) {
      push(join(root, name), "mnt");
      for (const child of listChildren(root)) push(join(child, name), "mnt-sub");
    }
  }
  return {
    ok: true,
    name,
    platform,
    home,
    candidates: candidates.slice(0, 12), // 超过 12 个候选基本等于没解析，让用户手动浏览
  };
}


// GET /api/workspace/recent — group sessions.json by dir and return
// the most-recently-active workspaces, case-insensitive substring
// filter on `search` (optional). `limit` defaults to 5, hard cap 20.
export function getRecentWorkspaces({ search = "", limit = 5 } = {}) {
  const all = loadSessions();
  // 按 dir 分组，聚合 lastActiveAt 和 sessionCount
  const map = new Map();
  for (const s of all) {
    const dir = (s.workspace || "").trim();
    if (!dir) continue;
    const time = s.updatedAt || s.createdAt || 0;
    if (!map.has(dir)) {
      map.set(dir, { dir, lastActiveAt: time, sessionCount: 0 });
    } else {
      const entry = map.get(dir);
      entry.lastActiveAt = Math.max(entry.lastActiveAt, time);
    }
    map.get(dir).sessionCount++;
  }
  let items = [...map.values()];
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    items = items.filter(
      (it) =>
        it.dir.toLowerCase().includes(q) ||
        basename(it.dir).toLowerCase().includes(q),
    );
  }
  items.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const MAX_LIMIT = 20;
  const safeLimit = Math.min(Number(limit) || 5, MAX_LIMIT);
  const sliced = items.slice(0, safeLimit);
  return {
    ok: true,
    items: sliced.map((it) => ({
      dir: it.dir,
      name: basename(it.dir) || it.dir,
      lastActiveAt: it.lastActiveAt,
      sessionCount: it.sessionCount,
    })),
    total: items.length,
    search: search.trim(),
    limit: safeLimit,
  };
}


// POST /api/workspace/pick — spawn the platform's native directory
// picker (zenity / kdialog on Linux; osascript on macOS; PowerShell
// dialog on Windows). Returns { ok, path } where path === null when
// the user cancelled. `signal` (AbortSignal) cancels the child.
export function pickDirectoryNative(signal) {
  const platform = process.platform;
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      child?.kill();
      fn();
    };
    const onAbort = () => {
      settle(() => reject(new Error("picker aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (platform === "linux") {
        // 优先用 kdialog（KDE 原生目录选择器，无"上传"按钮，体验最好）
        // kdialog 也有 TTY 问题，用 setsid 创建独立 session
        child = spawn("setsid", ["--", "kdialog", "--getexistingdirectory", ".", "--title", "选择工作区目录"], {
          stdio: ["ignore", "pipe", "inherit"],
          windowsHide: true,
          env: { ...process.env },
          detached: false,
        });
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.on("close", (code) => {
          if (signal?.aborted) {
            settle(() => reject(new Error("picker aborted")));
          } else if (code === 0) {
            const path = stdout.replace(/[\r\n]+$/, "").trim();
            settle(() => resolve(path || null));
          } else {
            // 用户取消（code === 1）或其他错误 → try zenity
            settle(() => {
              tryZenity(signal).then(resolve).catch(reject);
            });
          }
        });
        child.on("error", (e) => {
          settle(() => {
            if (e.code === "ENOENT") {
              tryZenity(signal).then(resolve).catch(reject);
            } else {
              reject(e);
            }
          });
        });
      } else if (platform === "darwin") {
        child = spawn("osascript", [
          "-e",
          'set selectedFolder to choose folder with prompt "选择工作区目录"',
          "-e",
          "POSIX path of selectedFolder",
        ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env } });
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.on("close", (code) => {
          if (signal?.aborted) {
            settle(() => reject(new Error("picker aborted")));
          } else if (code === 0) {
            const path = stdout.replace(/[\r\n]+$/, "").trim();
            settle(() => resolve(path || null));
          } else {
            // 用户取消（osascript -128 = user cancelled）
            settle(() => resolve(null));
          }
        });
        child.on("error", (e) => settle(() => reject(e)));
      } else if (platform === "win32") {
        // Windows: PowerShell 风格 folder picker（不依赖三方库）
        const ps = [
          "Add-Type -AssemblyName System.Windows.Forms",
          "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
          "$f.Description = '选择工作区目录'",
          "$f.ShowNewFolderButton = $true",
          "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { '' }",
        ].join("; ");
        child = spawn("powershell", ["-NoProfile", "-Command", ps], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env },
        });
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.on("close", (code) => {
          if (signal?.aborted) {
            settle(() => reject(new Error("picker aborted")));
          } else if (code === 0) {
            const path = stdout.replace(/[\r\n]+$/, "").trim();
            settle(() => resolve(path || null));
          } else {
            settle(() => resolve(null));
          }
        });
        child.on("error", (e) => settle(() => reject(e)));
      } else {
        settle(() => reject(new Error(`unsupported platform: ${platform}`)));
      }
    } catch (e) {
      settle(() => reject(e));
    }
  });
}

async function tryKdialog(signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      child?.kill();
      fn();
    };
    const onAbort = () => settle(() => reject(new Error("picker aborted")));
    signal?.addEventListener("abort", onAbort, { once: true });
    const child = spawn("setsid", ["--", "kdialog", "--getexistingdirectory", ".", "--title", "选择工作区目录"], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => {
      if (signal?.aborted) {
        settle(() => reject(new Error("picker aborted")));
      } else if (code === 0) {
        const path = stdout.replace(/[\r\n]+$/, "").trim();
        settle(() => resolve(path || null));
      } else {
        settle(() => resolve(null)); // 用户取消
      }
    });
    child.on("error", (e) => {
      settle(() => reject(new Error("no supported native directory picker found (install zenity or kdialog)")));
    });
  });
}

// browseWorkspace (defined above) handles `?path=<abs>` or `?path=~/xxx`;
// when path is omitted it returns the root view (with home / platform /
// tmpDir for the front-end to localize).

// assertWorkspacePath — containment gate for the /api/fs/* routes
// (/api/fs/read, /api/fs/mkdir). Same boundary as browseWorkspace;
// the route handlers only see { ok:true, path } or { ok:false, error }.
export function assertWorkspacePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") {
    return { ok: false, error: "path 不能为空" };
  }
  const absDir = resolve(rawPath);
  const contained = resolveWithinRoots(absDir);
  if (!contained.ok) return { ok: false, error: contained.error };
  return { ok: true, path: absDir };
}

// assertWorkspaceParentPath — mkdir-specific: target directory does not
// exist yet (realpath would fail), so verify the parent exists and is
// inside an allowed root, and that the basename itself is legal.
export function assertWorkspaceParentPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") {
    return { ok: false, error: "path 不能为空" };
  }
  const absDir = resolve(rawPath);
  const parent = dirname(absDir);
  const contained = resolveWithinRoots(parent);
  if (!contained.ok) return { ok: false, error: contained.error };
  return { ok: true, path: absDir };
}
