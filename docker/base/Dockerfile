# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG PASEO_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/paseo-src
COPY . .

RUN set -eux; \
    if [ -n "${PASEO_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${PASEO_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/highlight --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/relay --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/protocol --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/client --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/chat --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/server --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/cli --pack-destination /tmp/paseo-packs

FROM ${NODE_IMAGE}

ARG PASEO_UID=1000
ARG PASEO_GID=1000

ENV HOME=/home/paseo \
    PASEO_HOME=/home/paseo/.paseo \
    PASEO_LISTEN=0.0.0.0:6767 \
    PASEO_WEB_UI_ENABLED=true \
    PASEO_LOG_FORMAT=json \
    PASEO_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/paseo/.claude \
    CODEX_HOME=/home/paseo/.codex \
    XDG_CONFIG_HOME=/home/paseo/.config \
    XDG_DATA_HOME=/home/paseo/.local/share \
    XDG_STATE_HOME=/home/paseo/.local/state \
    XDG_CACHE_HOME=/home/paseo/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/paseo-packs /tmp/paseo-packs
RUN set -eux; \
    npm install -g /tmp/paseo-packs/*.tgz; \
    rm -rf /tmp/paseo-packs; \
    npm install -g pnpm bun; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/paseo-server-entry; \
    node --check "$server_entry"

ENV NPM_CONFIG_PREFIX=/home/paseo/.local \
    PATH=/home/paseo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN set -eux; \
    existing_group="$(getent group "$PASEO_GID" | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "paseo" ]; then \
      groupmod --new-name paseo "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid "$PASEO_GID" paseo; \
    fi; \
    existing_user="$(getent passwd "$PASEO_UID" | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "paseo" ]; then \
      usermod --login paseo --gid paseo --home /home/paseo --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid "$PASEO_UID" --gid paseo --create-home --home-dir /home/paseo --shell /bin/bash paseo; \
    fi; \
    mkdir -p \
      /workspace \
      "$NPM_CONFIG_PREFIX" \
      "$NPM_CONFIG_PREFIX/bin" \
      "$PASEO_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R paseo:paseo /home/paseo /workspace

COPY docker/base/rootfs/ /
RUN chmod +x \
    /usr/local/bin/paseo-docker-entrypoint \
    /usr/local/bin/paseo-chat-bridge-entrypoint \
    /usr/local/bin/paseo-web-ui-entrypoint \
    /usr/local/bin/paseo-healthcheck

WORKDIR /workspace

EXPOSE 6767 8787 8788
VOLUME ["/home/paseo"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD /usr/local/bin/paseo-healthcheck

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/paseo-docker-entrypoint"]
