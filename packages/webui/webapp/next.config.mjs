import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

// The web UI ships as a static export. `node server.js` serves the exported files
// and stays dependency-free (see docs/DESKTOP-ARCHITECTURE.md §5.1 and
// docs/ARCHITECTURE.md §7); Next, React and Tailwind are build-time only.
//
// `output: 'export'` is therefore set in every phase except `next dev`, where Next
// does not support it. In dev the frontend is served by Next on its own port and
// the API is proxied to the Node server, so the same relative `/api/*` URLs work
// in both modes.
const API_ORIGIN = process.env.MCODE_WEBUI_ORIGIN ?? "http://127.0.0.1:18090";

/** @type {(phase: string) => import('next').NextConfig} */
export default function nextConfig(phase) {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    reactStrictMode: true,
    // Emit `route/index.html` rather than `route.html`, so the plain static file
    // server in server/lib/static.js can resolve a directory-style URL.
    trailingSlash: true,
    // ...but do not let Next rewrite `/api/state` to `/api/state/`: the rewrite
    // proxy below must pass the API paths through byte-for-byte, and a 308 on every
    // API call would break both the dev proxy and the SSE stream.
    skipTrailingSlashRedirect: true,
    // The export is served from a local process, not a CDN: no image optimizer.
    images: { unoptimized: true },
    ...(dev
      ? {
          async rewrites() {
            return [
              {
                source: "/api/:path*",
                destination: `${API_ORIGIN}/api/:path*`,
              },
            ];
          },
        }
      : { output: "export" }),
  };
}
