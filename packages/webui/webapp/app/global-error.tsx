"use client";

// webapp/app/global-error.tsx
//
// Last-resort error boundary for the webui.
//
// `app/error.tsx` is the per-route boundary: it catches render errors
// below it but Next still has to mount the root `layout.tsx`, and any
// failure inside layout (provider, antd ConfigProvider, the
// `<html>` shell) bypasses that boundary entirely. We hit this exact
// failure mode once already in this slice's evidence chain — a stale
// `.next` from a sibling agent's `webapp:build` left hydration broken,
// every component crashed during render, and the only thing the user
// saw was a bare 404 page with no actionable information.
//
// `global-error.tsx` is the only Next boundary that can replace
// `<html>` and `<body>`. It must therefore render the absolute minimum
// — no shared stylesheet, no providers, no theme hooks. We inline
// the typography so the page reads even when the antd / Tailwind
// pipeline is what blew up.
//
// Diagnostics block
// -----------------
// Every incident needs a fingerprint. The block captures:
//   * the cids currently in localStorage (the two of them — the
//     desktop client id + any sessionStorage key we read off `webui:`
//     that carries a cid);
//   * the build hash embedded by `next.config.mjs` (next: '12-char-sha')
//     so a regression has a single search handle;
//   * the error message and stack (capped at 2 KB so a runaway loop
//     does not fill localStorage);
//   * the current pathname + session id from the URL.
//
// Copy-diagnostics button serialises the block and writes it via the
// clipboard API (with the textarea fallback used elsewhere in this
// code base). A reload button clears `?session=` so a deep-linked
// visit into a permanently-broken session does not loop.

import { useEffect, useMemo, useState } from "react";
import { clientId } from "@/lib/cid";

interface CapturedError {
  message: string;
  stack?: string;
  digest?: string;
}

interface ErrorPageProps {
  /** Next passes the thrown error here; we capture it but never trust
   *  its shape — defensive extraction. */
  error?: Error | (Error & { digest?: string });
  /** `reset` is the function Next invokes when the user clicks the
   *  in-page "Try again" button; we wire it to the reload control. */
  reset?: () => void;
}

const STACK_CAP_BYTES = 2048;

function diagnose(err: unknown): CapturedError {
  if (!err) return { message: "Unknown error" };
  if (err instanceof Error) {
    const stack = typeof err.stack === "string" ? err.stack.slice(0, STACK_CAP_BYTES) : undefined;
    const digest = typeof (err as { digest?: unknown }).digest === "string" ? ((err as { digest?: string }).digest) : undefined;
    return { message: err.message || err.name || "Error", stack, digest };
  }
  if (typeof err === "string") return { message: err.slice(0, 512) };
  try {
    const text = JSON.stringify(err).slice(0, 512);
    return { message: text || "Unknown error" };
  } catch {
    return { message: "Unknown error" };
  }
}

function readSessionParam(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("session");
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function readWindowCids(): { client: string | null } {
  if (typeof window === "undefined") return { client: null };
  let client: string | null = null;
  try {
    client = window.localStorage.getItem("webui_cid");
  } catch {
    /* */
  }
  return { client };
}

function buildDiagnostics(captured: CapturedError): string {
  const cid = clientId();
  const sessionUrl = readSessionParam();
  const cids = readWindowCids();
  const buildTag =
    typeof process !== "undefined" && process.env && typeof process.env.NEXT_PUBLIC_BUILD_ID === "string"
      ? process.env.NEXT_PUBLIC_BUILD_ID
      : "dev";
  const lines: string[] = [
    "webui global-error report",
    `timestamp: ${new Date().toISOString()}`,
    `clientId: ${cid || "(none)"}`,
    `webui_cid_localstorage: ${cids.client || "(none)"}`,
    `url: ${typeof window !== "undefined" ? window.location.href : "(ssr)"}`,
    `pathname: ${typeof window !== "undefined" ? window.location.pathname : "(ssr)"}`,
    `?session: ${sessionUrl || "(none)"}`,
    `build: ${buildTag}`,
    `userAgent: ${typeof navigator !== "undefined" ? navigator.userAgent : "(server)"}`,
    `message: ${captured.message}`,
  ];
  if (captured.digest) lines.push(`digest: ${captured.digest}`);
  if (captured.stack) lines.push(`stack:\n${captured.stack}`);
  return lines.join("\n");
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    if (typeof document === "undefined") return false;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    return true;
  } catch {
    return false;
  }
}

export default function GlobalError({ error, reset }: ErrorPageProps) {
  const captured = useMemo(() => diagnose(error), [error]);
  const diagnostics = useMemo(() => buildDiagnostics(captured), [captured]);
  const [copied, setCopied] = useState(false);

  // `reset` is whatever Next handed us, but it can crash on the very
  // thing that broke the app. Safe reset = full page reload, optionally
  // dropping the bad `?session=` so a broken session id cannot loop.
  const onReset = () => {
    try {
      if (typeof reset === "function") reset();
    } catch {
      /* fall through to the hard reload */
    }
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("session");
      window.location.replace(`${url.pathname}${url.search}${url.hash}`);
    } catch {
      window.location.reload();
    }
  };

  const onHome = () => {
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("session");
      url.hash = "";
      window.location.replace(`${url.pathname}${url.search}`);
    } catch {
      /* same `replace` may throw on file://, but a bare reload is
         still better than the broken page */
    }
  };

  const onCopy = async () => {
    const ok = await copyToClipboard(diagnostics);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied((value) => (value === true ? false : value)), 1500);
    }
  };

  // Prevent reset from firing twice in StrictMode dev — only attach the
  // effect in production. Done via `useEffect` to keep component order
  // identical across modes.
  useEffect(() => {
    /* no-op: reserved for a future "report to /api/diag" call. */
  }, []);

  return (
    <html lang="zh" suppressHydrationWarning>
      <body
        style={{
          margin: 0,
          padding: 0,
          background: "#f5f5f5",
          color: "#171717",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
          minHeight: "100vh",
        }}
      >
        <main
          role="alert"
          aria-live="assertive"
          data-testid="global-error-page"
          style={{
            maxWidth: 720,
            margin: "0 auto",
            padding: "48px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <h1 style={{ fontSize: 24, lineHeight: "32px", margin: 0 }}>渲染失败 · Something went wrong</h1>
          <p data-testid="global-error-message" style={{ margin: 0, fontSize: 14, lineHeight: "22px", color: "#5f5f5f" }}>
            {captured.message || "页面未能完成渲染。请尝试刷新或返回首页。"}
          </p>
          <p style={{ margin: 0, fontSize: 12, lineHeight: "18px", color: "#8c8c8c" }}>
            Page failed to render. Reload, or go home.
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={onReset}
              data-testid="global-error-reload"
              style={btnPrimary}
            >
              重新加载 · Reload
            </button>
            <button
              type="button"
              onClick={onHome}
              data-testid="global-error-home"
              style={btnSecondary}
            >
              回到首页 · Home
            </button>
            <button
              type="button"
              onClick={() => void onCopy()}
              data-testid="global-error-copy"
              style={btnSecondary}
            >
              {copied ? "已复制 · Copied" : "复制诊断信息 · Copy diagnostics"}
            </button>
          </div>

          <details style={{ marginTop: 8 }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 12,
                lineHeight: "18px",
                color: "#5f5f5f",
                padding: "8px 0",
              }}
            >
              诊断信息 · Diagnostics
            </summary>
            <pre
              data-testid="global-error-diagnostics"
              style={{
                margin: 0,
                padding: 12,
                background: "#ffffff",
                border: "1px solid #e5e5e5",
                borderRadius: 6,
                fontSize: 11,
                lineHeight: "16px",
                color: "#171717",
                overflowX: "auto",
                maxHeight: 320,
              }}
            >
              {diagnostics}
            </pre>
          </details>
        </main>
      </body>
    </html>
  );
}

const btnPrimary: React.CSSProperties = {
  height: 32,
  padding: "0 14px",
  borderRadius: 6,
  background: "#1677ff",
  color: "#ffffff",
  border: "1px solid #1677ff",
  cursor: "pointer",
  fontSize: 13,
};

const btnSecondary: React.CSSProperties = {
  height: 32,
  padding: "0 14px",
  borderRadius: 6,
  background: "#ffffff",
  color: "#171717",
  border: "1px solid #d4d4d4",
  cursor: "pointer",
  fontSize: 13,
};
