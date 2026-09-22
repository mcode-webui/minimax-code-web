# Development and testing image for the Web UI branch of this fork.
#
# Purpose: run the repository's built CLI + Web UI in an isolated container
# (docker compose up webui) and provide a full interactive dev environment
# (docker compose run dev). It is NOT a production deployment image: it keeps
# build tooling on purpose and expects the operator's token/credential mounts.
FROM node:24.19-bookworm-slim

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

# Clean-environment entrypoint: seeds ~/.minimax/config.yaml from
# MINIMAX_CN_API_KEY / MINIMAX_API_KEY (see docker/entrypoint.sh).
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Inside a container the browser cannot be opened and the host is a non-local
# client, so bind all interfaces (token auth still applies to non-local
# requests) and never try to open a browser.
ENV HOST=0.0.0.0
EXPOSE 18080

# Realistic non-root user home: the fs-picker's well-known directory keywords
# (documents/downloads/…) and XDG resolution expect the standard user
# directories to exist. Replaces the base image's `node` user (already uid
# 1000) with `user` so the name matches the /home/user layout; uid/gid 1000
# matches the default first user on most hosts — and the ownership of a
# bind-mounted checkout in the dev profile.
RUN userdel --remove node \
  && useradd --create-home --uid 1000 --user-group --shell /bin/bash user \
  && mkdir -p /home/user/Desktop /home/user/Documents /home/user/Downloads \
             /home/user/Pictures /home/user/Music /home/user/Videos \
             /home/user/projects /home/user/.config \
  && printf 'XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOCUMENTS_DIR="$HOME/Documents"\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_PICTURES_DIR="$HOME/Pictures"\nXDG_MUSIC_DIR="$HOME/Music"\nXDG_VIDEOS_DIR="$HOME/Videos"\n' \
     > /home/user/.config/user-dirs.dirs \
  && chown -R user:user /home/user
ENV HOME=/home/user
USER user

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-18080}/api/health" >/dev/null || exit 1

CMD ["node", "dist/cli.js", "webui", "--no-open"]
