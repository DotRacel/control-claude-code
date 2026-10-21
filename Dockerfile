# syntax=docker/dockerfile:1
#
# The controller server (control-plane + data-plane + the SPA it serves). The CLI half of this
# repo ships on npm instead — see package.json `files`.
#
# Build: docker build -t ccc .
# Run:   docker compose up -d      (see docker-compose.yml for the database wiring)

# Security baseline: October 2026 fixes (including CVE-2026-111497). Keep in sync with .nvmrc.
ARG NODE_VERSION=24.22.1

# ── stage 1: the mobile SPA ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS web
WORKDIR /build
# Copy manifests first so the dependency layer survives edits to the app source.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# The SPA imports shared modules out of the repo root (the ../../src/ imports in web/src/), so the
# bundler needs them on disk at the path the sources expect.
COPY src/ /src/
# `vite build` rather than `npm run build`, which also runs `tsc --noEmit`. Type-checking here
# would drag in the server's own type graph — ws.ts type-imports store.ts, which imports db.ts,
# which imports `pg` — and module resolution starts at /src/server/, where no node_modules exists.
# Value imports are unaffected: esbuild erases `import type` outright, so the bundle never reaches
# db.ts. Types are CI's job (see .github/workflows/ci.yml), where the full workspace is installed.
RUN npx vite build

# ── stage 2: the server ────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine
WORKDIR /app

# `pg` is the server's ONLY third-party dependency — everything else it imports is a node: builtin.
# It sits in devDependencies because the npm package ships the CLI alone, and putting it in
# dependencies would make every `npx control-claude-code` user download a database driver they
# never load. Reading the range back out of package.json keeps the two from drifting apart.
# --no-save matters as much as the version lookup: with `pg` sitting in devDependencies, a plain
# `npm install pg` keeps it filed under dev, which any production-mode install then skips —
# silently, leaving a green build that dies at startup with ERR_MODULE_NOT_FOUND.
COPY package.json ./
RUN npm install --no-save --no-package-lock --no-audit --no-fund \
      "pg@$(node -p "require('./package.json').devDependencies.pg")"

# Node 24 strips TypeScript types on its own, so the server runs from source — no build step, and
# no second bundler config to keep in sync with the CLI's.
COPY src/ ./src/
# main.ts resolves the SPA at ../../web/dist relative to src/server/, so this path is load-bearing.
COPY --from=web /build/dist ./web/dist

# Set after the install above, not before — see the --no-save note.
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
EXPOSE 8787
USER node

# The server answers on / with the SPA shell once it is listening. Probing with node's fetch rather
# than wget on purpose: busybox wget honours http_proxy but ignores NO_PROXY, so on any host with a
# Docker proxy configured it ships the loopback probe off to the proxy and gets a 502 back.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form (no shell) so SIGTERM reaches Node directly — main.ts traps it to flush the batched
# last_activity writes and close the pool.
CMD ["node", "src/server/main.ts"]
