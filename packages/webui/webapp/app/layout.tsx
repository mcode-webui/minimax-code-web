import type { Metadata, Viewport } from "next";

import "./globals.css";
import "../styles/tokens.css";
import "../styles/official-utilities.css";
import "../styles/desktop-typography.css";

export const metadata: Metadata = {
  title: "MiniMax Code",
  description: "AI-powered productivity assistant",
  icons: { icon: "/favicon_v2.ico" },
};

// Mirrors the upstream viewport declaration (maximum-scale / user-scalable are
// kept for parity with the desktop renderer's meta tag).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  userScalable: false,
};

/**
 * Theme bootstrap, run before first paint.
 *
 * Same three rules as upstream: an explicit stored choice wins, otherwise follow
 * the OS, and either way record the result as a class on <html> plus a matching
 * `color-scheme` so native controls and scrollbars agree. The fallback branch
 * keeps the UI readable if storage or matchMedia throws (private modes, embedded
 * webviews).
 *
 * Kept as a blocking inline script on purpose: rendering even one frame in the
 * wrong theme is a visible flash, and this is the only place the theme is read
 * before React hydrates.
 */
const THEME_BOOTSTRAP = `(function () {
  try {
    var storedTheme = window.localStorage.getItem('theme');
    var prefersDark =
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme;
    if (storedTheme === 'light' || storedTheme === 'dark') {
      theme = storedTheme;
    } else {
      theme = prefersDark ? 'dark' : 'light';
    }
    var root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.style.colorScheme = theme;
  } catch (e) {
    document.documentElement.classList.add('light');
    document.documentElement.style.colorScheme = 'light';
  }
})();`;

/**
 * Platform + typography gate classes.
 *
 * The desktop stylesheet splits most of its typography and chat-markdown cascade
 * behind two classes on the root element: `mavis-platform-electron` (the desktop
 * renderer, as opposed to the web build of the same bundle) and
 * `mavis-desktop-typography-enabled` (the typography preset is active).
 *
 * This frontend reproduces the desktop client, so it opts into both rather than
 * forking the rules: the copied stylesheets then apply exactly as they do in the
 * Electron app. `styles/desktop-typography.css` documents what each gate unlocks.
 */
const PLATFORM_CLASSES = "mavis-platform-electron mavis-desktop-typography-enabled";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh"
      translate="no"
      className={`notranslate ${PLATFORM_CLASSES}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
