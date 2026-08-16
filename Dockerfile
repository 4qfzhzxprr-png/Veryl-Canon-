# Veryl Canon — the container.
#
# Build context is the REPOSITORY ROOT, not server/: the TypeScript project is
# rooted a level up so the test suite can drive the stubs in process
# (server/tsconfig.json says why). None of the stubs reach the `canon` image.
#
#   docker build -t veryl-canon:local --target canon .
#   docker run --rm -p 3000:3000 -v canon-data:/data veryl-canon:local
#
# Five properties this file is written for, in order of how much they matter:
#
#   THE DEPLOYABLE STAGE IS LAST, AND THAT ORDERING IS LOAD-BEARING. A build
#   that names no target builds the FINAL stage, and several build platforms
#   cannot name one at all — Render's blueprint has no field for it. While the
#   stubs sat last, the image such a platform produced was `stubs`: an
#   identity provider that issues a token for anybody, in front of an
#   unauthenticated administrative face. The safe image has to be the one you
#   get by default, because the dangerous one cannot be the one you get by
#   accident. Do not move `canon` back above them. (Under BuildKit the stub
#   stages are skipped entirely for a target-less build, since nothing the
#   final stage needs comes from them.)
#
#   NON-ROOT. The runtime stage runs as the `node` user. A container process
#   that is root is root on the host kernel; Canon reads operator-supplied paths
#   (import) and writes one file (the record), and needs nothing else.
#
#   NO BUILD TOOLCHAIN IN THE FINAL IMAGE. TypeScript, npm's cache and the dev
#   dependencies stay in the build stage. What is copied forward is compiled
#   JavaScript and the static web UI — and, because Canon has ZERO RUNTIME
#   DEPENDENCIES, no node_modules at all. There is no `npm ci --omit=dev` step
#   here because there is nothing for it to install. The whole application layer
#   is a few hundred kilobytes on top of the Node runtime; if that ever stops
#   being true, something has grown a dependency.
#
#   SIGNALS. `CMD` is exec form, so node is PID 1 and receives SIGTERM directly
#   rather than through a shell that would swallow it. Node installs no default
#   SIGTERM handler at PID 1 — src/shutdown.ts installs the real one, which
#   stops accepting, drains in-flight requests, clears the timers and closes the
#   database so SQLite checkpoints its WAL. `docker stop` is therefore graceful
#   rather than ten seconds of waiting followed by SIGKILL.
#
#   THE RECORD IS A VOLUME. /data, owned by `node`, declared VOLUME. The whole
#   of Canon's state is one SQLite file; a container that keeps it on its own
#   writable layer loses the record — and the audit log — on `docker rm`.

# ---------------------------------------------------------------------------
# Stage 1: build the server. Dev dependencies live and die here.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /build/server

# Manifests first, so editing source does not re-run npm install.
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

# server/tsconfig.json also names the stub packages and the test directory in
# its `include`. They are deliberately absent here: a glob that matches nothing
# is not an error, and the deployable image has no business compiling either.
COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/scripts ./scripts
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 1b: build the React client (web/, see web/MIGRATION.md).
# ---------------------------------------------------------------------------
# Its own stage so its node_modules — which are large, and every one of them a
# build-time dependency — cannot reach the runtime image, and so editing the
# server does not re-run npm install here or the other way round.
#
# It is built into EVERY image, whether or not the deployment serves it: which
# client `/` answers with is CANON_UI's decision at run time, and a flag that
# needs a different image is not a flag, it is a second build to get wrong. The
# cost is a few hundred kilobytes of static files.
FROM node:22-alpine AS webbuild
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/tsconfig.json web/vite.config.ts web/tailwind.config.ts web/postcss.config.js web/index.html ./
COPY web/public ./public
COPY web/src ./src
# `npm run build` typechecks first and then bundles, so a type error fails the
# image rather than shipping a client that compiled by accident. Vite's outDir
# is ../server/public-app (web/vite.config.ts), which is where it lands below.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: the stubs. FOR DEMOS AND TESTS ONLY — NEVER FOR A DEPLOYMENT.
# ---------------------------------------------------------------------------
# A separate target so nothing here can end up in the deployable image. Every
# one of these is a test double that authenticates nobody:
#
#   idp-stub       issues a valid ID token for anyone it is told about, and can
#                  be asked to lie on purpose (`POST /admin/quirk`)
#   registry-stub  in-memory agent state, unauthenticated administrative face
#   source-stub    invents benefits figures
#   studio-stub    a sample Studio app
#
# SECURITY.md §5, assumption 1: "an identity provider that will issue a token
# for anybody is a Canon anybody can enter."
#
# These sit in the MIDDLE of the file rather than at the end on purpose — see
# the header. Last place belongs to the image a deployment runs.
FROM node:22-alpine AS stubbuild
WORKDIR /build
# Each stub's tsconfig compiles a slice of ../server/src (Canon's own registry
# client, its HTTP connector, its Knowledge API types), so the server's dev
# dependencies have to be resolvable from /build/server or TypeScript cannot
# find @types/node for those files.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --no-audit --no-fund
COPY server/src ./server/src
COPY registry-stub ./registry-stub
COPY source-stub ./source-stub
COPY idp-stub ./idp-stub
COPY studio-stub ./studio-stub
RUN for pkg in registry-stub source-stub idp-stub studio-stub; do \
      cd /build/$pkg && npm ci --no-audit --no-fund && npm run build || exit 1; \
    done

FROM node:22-alpine AS stubs
ENV NODE_ENV=production
WORKDIR /app
COPY --from=stubbuild /build/registry-stub/dist ./registry-stub/dist
COPY --from=stubbuild /build/source-stub/dist ./source-stub/dist
COPY --from=stubbuild /build/idp-stub/dist ./idp-stub/dist
COPY --from=stubbuild /build/studio-stub/dist ./studio-stub/dist
USER node
CMD ["node", "registry-stub/dist/registry-stub/src/index.js"]

# ---------------------------------------------------------------------------
# Stage 3, and DELIBERATELY THE LAST: the server image. This is what a
# deployment runs, and what a build with no `--target` produces.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS canon

ENV NODE_ENV=production \
    CANON_DB=/data/canon.db \
    CANON_LOG_FORMAT=json \
    PORT=3000

WORKDIR /app

# Compiled output keeps its dist/server/… shape, because static.ts finds the web
# UI three directories up from its own compiled location: from
# /app/dist/server/src that is /app/public. This layout is load-bearing — a
# tidier-looking one serves 404s for the whole UI and nothing else complains.
COPY --from=build /build/server/dist/server/src ./dist/server/src
COPY --from=build /build/server/dist/server/scripts ./dist/server/scripts
COPY server/public ./public
# The React client, beside the original rather than instead of it. Both are
# reachable at once while routes migrate: `/` is whichever CANON_UI names, and
# `/classic.html` is always the original, which is where the React client hands
# back a route it has not taken over yet (server/src/static.ts).
COPY --from=webbuild /build/server/public-app ./public-app
COPY server/package.json ./package.json

# seed-demo writes several hundred invented pages under invented people's names
# and history is append-only, so there is no taking it back. It is a
# development tool (server/README.md says so on every run) and it does not
# belong in a deployable image.
RUN rm -f dist/server/scripts/seed-demo.js \
 && mkdir -p /data && chown -R node:node /data /app

VOLUME ["/data"]
USER node
EXPOSE 3000

# Readiness, not liveness. An unhealthy container here is one that cannot serve
# — record unreachable, schema behind the binary, a configured door down — which
# is exactly what should leave the load balancer. See src/ready.ts on why the
# two questions are different.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: node is PID 1 and gets SIGTERM directly.
CMD ["node", "dist/server/src/index.js"]
