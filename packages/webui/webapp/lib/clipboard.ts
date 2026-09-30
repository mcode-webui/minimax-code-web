// webapp/lib/clipboard.ts
//
// The one text-to-clipboard path in the webapp. Every caller that
// copies a *value* rather than a file path (the conversation
// toolbar's version badge copies a commit id) belongs here so there
// is a single fallback chain to reason about rather than one copy per
// surface.
//
// The chain is the browser's async Clipboard API first, then the
// legacy `document.execCommand("copy")` route for the contexts where
// the async API is unavailable or refused (a non-secure origin, a
// document that is not focused). The second step is a real
// requirement, not belt-and-braces: served over plain HTTP on a LAN
// address, `navigator.clipboard` is undefined in every current
// browser, and a copy control that silently does nothing is worse
// than no copy control at all.
//
// Returns whether the text actually reached the clipboard, so a
// caller can give honest feedback instead of claiming success.

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  if (typeof document === "undefined") return false;
  try {
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
