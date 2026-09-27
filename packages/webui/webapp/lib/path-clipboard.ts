// webapp/lib/path-clipboard.ts
//
// Clipboard helper for absolute file paths. The file tree already
// implements its own copy in components/panels.tsx#FileRow (it
// shows a transient "Path copied" confirmation). The file-tab
// breadcrumb (slice 15) needs the same copy without the
// confirmation banner — the breadcrumb is too compact for a
// transient label, and a global confirmation banner is overkill
// for a small affordance.

export async function copyPathToClipboard(path: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(path);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = path;
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