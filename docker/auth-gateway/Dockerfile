ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS source-pack

WORKDIR /tmp/paseo-src
COPY . .

RUN set -eux; \
    node -e 'const fs=require("node:fs");const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));delete pkg.scripts.prepare;fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci; \
    npm run build --workspace=@getpaseo/auth-gateway; \
    mkdir -p /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/auth-gateway --pack-destination /tmp/paseo-packs

FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    PORT=8080 \
    PASEO_AUTH_DATABASE_PATH=/data/auth.sqlite

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tini; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /data; \
    chown node:node /data

COPY --from=source-pack /tmp/paseo-packs /tmp/paseo-packs
RUN set -eux; \
    npm install --global --omit=dev /tmp/paseo-packs/*.tgz; \
    rm -rf /tmp/paseo-packs; \
    npm cache clean --force

USER node
WORKDIR /data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:8080/healthz").then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))'

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["paseo-auth-gateway"]
