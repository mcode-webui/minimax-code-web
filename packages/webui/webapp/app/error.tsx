"use client";

// webapp/app/error.tsx
//
// Route-level error boundary.
//
// Next 14 ignores `app/error.tsx` when the failure happens in the root
// `layout.tsx` — the `app/global-error.tsx` next to this file is what
// renders in that case. This file catches everything below the layout:
// errors inside `SessionProvider`, the antd `ConfigProvider`, the
// page tree, hooks, etc.
//
// Unlike `global-error.tsx`, we can depend on the css pipeline
// (Tailwind + the antd skin), so the layout here matches the rest of
// the app's chrome. Diagnostics block + copy + reload mirror the
// global page but stay scoped to the current view.

import { useMemo, useState } from "react";
import { clientId } from "@/lib/cid";
import { resolveLocale, translate } from "@/lib/i18n";

const STACK_CAP_BYTES = 2048;

function diagnose(err: unknown): { message: string; digest?: string; stack?: string } {
  if (!err) return { message: "Unknown error" };
  if (err instanceof Error) {
    return {
      message: err.message || err.name || "Error",
      digest: typeof (err as { digest?: unknown }).digest === "string" ? ((err as { digest?: string }).digest) : undefined,
      stack: typeof err.stack === "string" ? err.stack.slice(0, STACK_CAP_BYTES) : undefined,
    };
  }
  if (typeof err === "string") return { message: err.slice(0, 512) };
  try {
    return { message: JSON.stringify(err).slice(0, 512) || "Unknown error" };
  } catch {
    return { message: "Unknown error" };
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

function readSessionParam(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = new URLSearchParams(window.location.search).get("session");
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function buildDiagnostics(captured: { message: string; digest?: string; stack?: string }): string {
  const cid = clientId();
  const cids = readWindowCids();
  const session = readSessionParam();
  const buildTag =
    typeof process !== "undefined" && process.env && typeof process.env.NEXT_PUBLIC_BUILD_ID === "string"
      ? process.env.NEXT_PUBLIC_BUILD_ID
      : "dev";
  const lines: string[] = [
    "webui error report",
    `timestamp: ${new Date().toISOString()}`,
    `clientId: ${cid || "(none)"}`,
    `webui_cid_localstorage: ${cids.client || "(none)"}`,
    `url: ${typeof window !== "undefined" ? window.location.href : "(ssr)"}`,
    `?session: ${session || "(none)"}`,
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
      /* */
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

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RouteError({ error, reset }: ErrorBoundaryProps) {
  const locale = typeof window === "undefined" ? "zh" : resolveLocale();
  const t = (key: "webui.errorBoundary.title" | "webui.errorBoundary.subtitle" | "webui.errorBoundary.reload" | "webui.errorBoundary.home" | "webui.errorBoundary.copy" | "webui.errorBoundary.copied" | "webui.errorBoundary.details" | "webui.errorBoundary.messageFallback") => translate(locale, key);

  const captured = useMemo(() => diagnose(error), [error]);
  const diagnostics = useMemo(() => buildDiagnostics(captured), [captured]);
  const [copied, setCopied] = useState(false);

  const onReset = () => {
    try {
      reset();
    } catch {
      /* full reload fallback below */
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
      window.location.replace(`${url.pathname}${url.search}`);
    } catch {
      /* */
    }
  };

  const onCopy = async () => {
    const ok = await copyToClipboard(diagnostics);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied((value) => (value === true ? false : value)), 1500);
    }
  };

  return (
    <main
      role="alert"
      aria-live="assertive"
      data-testid="route-error-page"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg_grouped_secondary px-6 py-12 text-text_default_primary"
    >
      <div className="flex w-full max-w-[640px] flex-col gap-3 rounded-[12px] bg-bg_default_scrim p-6 shadow-shadow_default">
        <h1 className="text-[20px] font-medium leading-7 text-text_default_primary">{t("webui.errorBoundary.title")}</h1>
        <p data-testid="route-error-message" className="text-sm leading-5 text-text_default_secondary">
          {captured.message || t("webui.errorBoundary.messageFallback")}
        </p>
        <p className="text-caption-small-strong text-text_default_tertiary">{t("webui.errorBoundary.subtitle")}</p>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={onReset}
            data-testid="route-error-reload"
            className="h-8 rounded-[8px] bg-bg_interaction_primary_default px-4 text-sm font-weight_medium text-text_default_inverted_static transition-colors hover:bg-bg_interaction_primary_hover"
          >
            {t("webui.errorBoundary.reload")}
          </button>
          <button
            type="button"
            onClick={onHome}
            data-testid="route-error-home"
            className="h-8 rounded-[8px] border border-border_default px-4 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {t("webui.errorBoundary.home")}
          </button>
          <button
            type="button"
            onClick={() => void onCopy()}
            data-testid="route-error-copy"
            className="h-8 rounded-[8px] border border-border_default px-4 text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
          >
            {copied ? t("webui.errorBoundary.copied") : t("webui.errorBoundary.copy")}
          </button>
        </div>

        <details className="pt-1">
          <summary className="cursor-pointer text-caption-small-strong text-text_default_tertiary">
            {t("webui.errorBoundary.details")}
          </summary>
          <pre
            data-testid="route-error-diagnostics"
            className="mavis-thin-scrollbar mt-2 max-h-[280px] overflow-x-auto rounded-[8px] bg-bg_grouped_tertiary p-3 font-family-code text-caption-small-strong text-text_default_secondary"
          >
            {diagnostics}
          </pre>
        </details>
      </div>
    </main>
  );
}
