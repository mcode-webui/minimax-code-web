# Development and testing image for the Web UI branch of this fork.
#
# Purpose: run the repository's built CLI + Web UI in an isolated container
# (docker compose up webui) and provide a full interactive dev environment
# (docker compose run dev). It is NOT a production deployment image: it keeps
# build tooling on purpose and expects the operator's token/credential mounts.
FROM node:24-bookworm-slim

# git      — workspace annotations (trajectory studio) and agent tools
# sqlite3  — the webui's sqlite CLI fallback path
# python3/make/g++ — node-gyp toolchain for native deps (e.g. node-pty) on
#                    platforms without a shipped prebuild
# curl     — container healthcheck
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git sqlite3 ca-certificates curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Build the CLI from the copied source tree.
# npm-installed pnpm (pinned to the repository's packageManager) avoids
# corepack availability differences across Node images.
RUN npm install -g pnpm@9.12.0
COPY . .
RUN pnpm install --no-frozen-lockfile && pnpm build

# Inside a container the browser cannot be opened and the host is a non-local
# client, so bind all interfaces (token auth still applies to non-local
# requests) and never try to open a browser.
ENV HOST=0.0.0.0
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null || exit 1

CMD ["node", "dist/cli.js", "webui", "--no-open"]
