// webui/scripts/desktop-reference.mjs
// Extract reference material from a running MiniMax Code desktop client.
//
// Why this exists: the webapp is a reverse translation of the official desktop
// renderer, and the only trustworthy source for "what does upstream actually
// render" is the running client itself — the packaged CSS is emitted as a
// minified one-liner, and (verified 2026-09-22) the build inside
// `linux-mcode-desktop/unpacked` can be several versions behind the installed
// one, so reading it silently produces stale "upstream" values. This script
// reads the live DOM instead, so a component can be re-derived at any time
// rather than hand-transcribed once.
//
// Usage
//   node scripts/desktop-reference.mjs --list
//   node scripts/desktop-reference.mjs --surface sidebar
//   node scripts/desktop-reference.mjs --tokens
//   node scripts/desktop-reference.mjs --all --out /tmp/desktop-ref
//
// Prerequisites: the desktop client must be running with remote debugging on.
// The Linux build ships a launcher that does this; the short version is
// `electron --remote-debugging-port=9333 --remote-allow-origins='*' <app.asar>`.
//
// Output goes OUTSIDE the repository by default. The dumps are review material
// (and contain the user's own session titles), not source — see the repository
// AGENTS.md rule about keeping review material out of the tree.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = 9333;

/** Surfaces worth re-deriving, with the selector that finds each one. */
const SURFACES = {
  sidebar: {
    what: "Left rail: nav rows, section headers, project rows, session rows",
    selector: '[data-testid="sidebar-base-card"]',
  },
  "sidebar-more": {
    what: "Everything after the viewport in the sidebar (footer/user area)",
    selector: '[data-testid="sidebar-base-card"]',
    slice: [40_000, 90_000],
  },
  composer: {
    what: "The message input card and its button row",
    locate: `(() => {
      const boxes = Array.from(document.querySelectorAll("div")).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 400 && r.width < 1100 && r.y > window.innerHeight * 0.5 && r.height > 40 && r.height < 300;
      });
      boxes.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      return boxes[0] ?? null;
    })()`,
  },
  toolbar: {
    what: "Top-right window actions",
    locate: `(() => {
      const btns = Array.from(document.querySelectorAll("button, [role=button]")).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.y < 64 && r.x > window.innerWidth - 420 && r.width <= 48;
      });
      if (!btns.length) return null;
      return btns[0].closest("div") ?? btns[0];
    })()`,
  },
  "user-footer": {
    what: "The account/home row at the bottom of the sidebar",
    locate: `(() => {
      const el = document.querySelector('[data-testid="sidebar-user-menu"], [data-testid*="user"], [data-testid*="account"]');
      if (el) return el.closest("div");
      const cands = Array.from(document.querySelectorAll("div,button")).filter((n) => {
        const r = n.getBoundingClientRect();
        return r.y > window.innerHeight - 140 && r.x < 420 && r.width > 150 && r.height > 24;
      });
      return cands[cands.length - 1] ?? null;
    })()`,
  },
};

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(s));
          } catch (cause) {
            reject(new Error(`${urlPath} did not return JSON: ${s.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`cannot open ${wsUrl}`));
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== id) return;
        this.ws.removeEventListener("message", onMessage);
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
        resolve(msg.result);
      };
      this.ws.addEventListener("message", onMessage);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 90_000);
    });
  }

  /** Evaluate an expression in the renderer and return its value. */
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page threw: ${JSON.stringify(res.exceptionDetails).slice(0, 600)}`);
    }
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

/** Serialize an element: trimmed markup plus the computed styles that matter. */
const serializeFn = `(el) => {
  if (!el) return null;
  const clone = el.cloneNode(true);
  for (const n of Array.from(clone.querySelectorAll("svg"))) n.replaceWith("[svg]");
  const style = (node) => {
    const cs = getComputedStyle(node);
    return {
      bg: cs.backgroundColor, color: cs.color, border: cs.borderColor + " " + cs.borderWidth,
      radius: cs.borderRadius, shadow: cs.boxShadow, font: cs.fontSize + "/" + cs.fontWeight + "/" + cs.lineHeight,
      pad: cs.padding, opacity: cs.opacity, display: cs.display,
    };
  };
  const interactive = Array.from(el.querySelectorAll("button, a, input, textarea, [role=button]")).map((node) => ({
    tag: node.tagName.toLowerCase(),
    label: node.getAttribute("aria-label") || node.getAttribute("title") || "",
    cls: typeof node.className === "string" ? node.className : "",
    style: style(node),
    box: (() => { const r = node.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
  }));
  return {
    html: clone.outerHTML.replace(/\\s+/g, " ").replace(/> </g, ">\\n<"),
    self: style(el),
    interactive,
  };
}`;

async function findTarget(port) {
  const list = await request(port, "/json");
  const page =
    list.find((t) => t.type === "page" && t.url.startsWith("app://")) ??
    list.find((t) => t.type === "page" && !t.url.includes("Rsbuild"));
  if (!page) throw new Error(`no app:// renderer on port ${port} (is the client running with --remote-debugging-port?)`);
  return page;
}

async function dumpSurface(cdp, name) {
  const surface = SURFACES[name];
  if (!surface) throw new Error(`unknown surface "${name}" (try --list)`);
  const locate = surface.locate ?? `document.querySelector(${JSON.stringify(surface.selector)})`;
  const raw = await cdp.eval(`(${serializeFn})(${locate})`);
  if (!raw) return { name, what: surface.what, found: false };
  let html = raw.html;
  if (surface.slice) html = html.slice(surface.slice[0], surface.slice[1]);
  return { name, what: surface.what, found: true, self: raw.self, interactive: raw.interactive, html };
}

async function dumpTokens(cdp) {
  // Resolved computed values (Chrome substitutes var() in custom properties).
  const light = await cdp.eval(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = new Set();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules ?? [])) {
        const style = rule.style;
        if (!style || typeof style.length !== "number") continue;
        for (let i = 0; i < style.length; i += 1) if (style[i]?.startsWith("--")) names.add(style[i]);
      }
    }
    const out = {};
    for (const n of names) out[n] = cs.getPropertyValue(n).trim();
    return JSON.stringify({ theme: document.documentElement.className, tokens: out });
  })()`);
  // The `.dark` block as authored, so dark mode can be compared without
  // switching the user's theme.
  const dark = await cdp.eval(`(() => {
    const found = {};
    const walk = (rules) => {
      for (const rule of Array.from(rules ?? [])) {
        if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules); continue; }
        if (!rule.selectorText || !/(^|,)\\s*\\.dark\\s*($|,|\\s)/.test(rule.selectorText)) continue;
        const style = rule.style;
        if (!style) continue;
        for (let i = 0; i < style.length; i += 1) {
          const n = style[i];
          if (n?.startsWith("--") && found[n] === undefined) found[n] = style.getPropertyValue(n).trim();
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      walk(rules);
    }
    return JSON.stringify(found);
  })()`);
  return { light: JSON.parse(light), dark: JSON.parse(dark) };
}

function parseArgs(argv) {
  const args = { out: path.join(os.tmpdir(), "mcode-desktop-reference"), port: DEFAULT_PORT, surfaces: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--all") args.all = true;
    else if (a === "--tokens") args.tokens = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--surface") args.surfaces.push(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  return args;
}

const HELP = `desktop-reference — re-derive upstream UI from the running desktop client

  --list               show the surfaces this can dump
  --surface <name>     dump one surface (repeatable)
  --all                dump every surface
  --tokens             dump the resolved light token set and the authored .dark block
  --out <dir>          where to write (default: $TMPDIR/mcode-desktop-reference)
  --port <n>           CDP port (default ${DEFAULT_PORT})
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.list) {
    for (const [name, s] of Object.entries(SURFACES)) process.stdout.write(`${name.padEnd(14)} ${s.what}\n`);
    return;
  }

  const wanted = args.all ? Object.keys(SURFACES) : args.surfaces;
  if (!wanted.length && !args.tokens) {
    process.stdout.write(`${HELP}\nNothing to do — pass --all, --surface, or --tokens.\n`);
    return;
  }

  const page = await findTarget(args.port);
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  fs.mkdirSync(args.out, { recursive: true });

  try {
    for (const name of wanted) {
      const dump = await dumpSurface(cdp, name);
      if (!dump.found) {
        process.stdout.write(`${name}: NOT FOUND (the desktop may be on a screen that lacks it)\n`);
        continue;
      }
      const file = path.join(args.out, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(dump, null, 1));
      process.stdout.write(`${name}: ${dump.html.length} chars -> ${file}\n`);
    }
    if (args.tokens) {
      const tokens = await dumpTokens(cdp);
      const file = path.join(args.out, "tokens.json");
      fs.writeFileSync(file, JSON.stringify(tokens, null, 1));
      process.stdout.write(
        `tokens: ${Object.keys(tokens.light.tokens).length} light / ${Object.keys(tokens.dark).length} dark -> ${file}\n`,
      );
    }
  } finally {
    cdp.close();
  }
}

main().catch((cause) => {
  process.stderr.write(`desktop-reference failed: ${cause.message}\n`);
  process.exitCode = 1;
});
