# Combined Engine + Web UI image for self-hosted single-user deployment
# Recommended: docker compose up (includes SearXNG for web search)
# Standalone:  docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ghcr.io/lynox-ai/lynox:latest

# Build acceleration notes
#   - `--mount=type=cache` keeps the pnpm store + apt lists between builds when
#     the BuildKit backend has a persistent cache (GitHub Actions `type=gha`,
#     Docker Build Cloud, or local docker buildx). Cuts ~1–2 min per build by
#     avoiding redundant package downloads when only application code changed.
#   - We deliberately drop the `rm -rf /var/lib/apt/lists/*` lines because the
#     directories are tmpfs-mounted via `--mount=type=cache`; trying to remove
#     them at build time would just re-download next time. The lists are not
#     copied into the final image (multi-stage), so image size is unaffected.

# --- Stage 1: Build Engine ---
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build-engine
WORKDIR /app
# Disable lefthook in the build: its dev-dep postinstall runs `lefthook install`
# which needs a git repo/binary that isn't in this stage, failing the build on a
# cold install-layer cache (the `|| true` on our own `prepare` doesn't cover the
# package's own postinstall). LEFTHOOK=0 makes lefthook skip — git hooks are a
# dev-machine concern, never needed in an image build.
ENV LEFTHOOK=0

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Install only engine deps (web-ui has separate install)
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter @lynox-ai/core
COPY src/ src/
COPY tsconfig.json ./
RUN pnpm run build

# --- Stage 2: Build Web UI ---
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build-webui
WORKDIR /app

# Bake the build SHA into the web-ui bundle so the running client can detect
# a stale-cache mismatch against the engine's /api/health.build_sha. CI passes
# this via --build-arg BUILD_SHA=$GITHUB_SHA in staging.yml.
ARG BUILD_SHA=
ENV BUILD_SHA=${BUILD_SHA}
# See build-engine stage: skip lefthook's git-dependent postinstall in the build.
ENV LEFTHOOK=0

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY packages/web-ui/package.json packages/web-ui/package.json
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No `--mount=type=cache` here: on Apple Silicon local docker builds, the
# pnpm content-addressable store inside the cache mount produces symlinks
# in /app/packages/web-ui/node_modules that dangle the moment the cache
# unmounts post-RUN — `vite build` then fails with `Cannot find module
# .../vite/bin/vite.js`. CI builds (GHA Ubuntu, type=gha cache survives)
# work without this guard, but pinning explicitly keeps local + CI builds
# behaviour-identical at the cost of ~1-2min slower install (no shared
# pnpm store across builds).
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    cd packages/web-ui && pnpm install --frozen-lockfile
COPY packages/web-ui/ packages/web-ui/
RUN cd packages/web-ui && pnpm run build

# --- Stage 3: Production deps (Engine) ---
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS deps
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod \
    && node -e "const db = require('better-sqlite3')(':memory:'); db.prepare('SELECT 1').get(); db.close(); console.log('better-sqlite3 OK')"

# --- Stage 4: Whisper.cpp (audio transcription) ---
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS whisper-build

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    cmake make g++ git curl ca-certificates

# Pin whisper.cpp to the exact commit the v1.8.4 tag points at. The shallow
# --branch clone stays (efficient), but we assert HEAD equals the expected
# commit so a moved/re-pointed tag fails the build (tamper-detection) instead
# of silently compiling swapped-out upstream code.
RUN git clone --depth 1 --branch v1.8.4 https://github.com/ggerganov/whisper.cpp /tmp/whisper \
    && cd /tmp/whisper \
    && test "$(git rev-parse HEAD)" = "9386f239401074690479731c1e41683fbbeac557" \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
    && cmake --build build --config Release -j$(nproc) \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && cp build/src/libwhisper.so.1* /usr/local/lib/ \
    && cp build/ggml/src/libggml*.so.0* /usr/local/lib/ \
    && ldconfig

# Whisper STT model: pulled from OUR GitHub release mirror, not HuggingFace.
# HF intermittently served HTTP errors and the model download flaked the build
# repeatedly (~5× on 2026-06-03/04, blocking CI/staging/canary). The model is
# mirrored once to the `whisper-models` release (pinned by the sha256 below).
# Only the `base` model is shipped — it transcribes all clip lengths; the prior
# `tiny` model was just a short-clip speed optimisation that whisper-cpp.ts
# already treats as optional (falls back to base). -f --retry guards the mirror.
RUN mkdir -p /usr/share/whisper \
    && curl -fL --retry 5 --retry-delay 3 --retry-all-errors -o /usr/share/whisper/ggml-base.bin \
       https://github.com/lynox-ai/lynox/releases/download/whisper-models/ggml-base.bin \
    && echo "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe /usr/share/whisper/ggml-base.bin" | sha256sum -c -

# --- Stage 5: Production image ---
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS production

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    wget ffmpeg libstdc++6

# Whisper.cpp binaries + model
COPY --from=whisper-build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /usr/local/lib/libwhisper* /usr/local/lib/
COPY --from=whisper-build /usr/local/lib/libggml* /usr/local/lib/
COPY --from=whisper-build /usr/share/whisper/ggml-base.bin /usr/share/whisper/ggml-base.bin
RUN ldconfig

# Harden: remove package managers, shells, SUID binaries
RUN \
    rm -rf /usr/bin/apt-get /usr/bin/apt /usr/bin/dpkg /usr/bin/dpkg-* \
           /usr/lib/apt /var/lib/dpkg /var/lib/apt /etc/apt \
    && rm -rf /usr/bin/perl* /usr/share/perl* /usr/lib/*/perl* \
    && rm -f /usr/bin/bash /bin/bash /usr/bin/rbash /bin/rbash \
    && find / -perm -4000 -type f -exec chmod u-s {} + 2>/dev/null || true \
    && sed -i 's|root:/bin/bash|root:/usr/sbin/nologin|' /etc/passwd

RUN groupadd -g 1001 lynox && useradd -u 1001 -g lynox -m -s /bin/sh lynox \
    && mkdir -p /home/lynox/.lynox/memory /workspace /home/lynox/.cache/huggingface \
    && chown -R lynox:lynox /home/lynox/.lynox /workspace /home/lynox/.cache

WORKDIR /app

# Engine
COPY --from=deps --chown=lynox:lynox /app/node_modules/ /app/node_modules/
COPY --from=build-engine --chown=lynox:lynox /app/dist/ /app/dist/
COPY --from=build-engine --chown=lynox:lynox /app/package.json /app/package.json

# Web UI
COPY --from=build-webui --chown=lynox:lynox /app/packages/web-ui/build/ /app/web-ui/
COPY --from=build-webui --chown=lynox:lynox /app/packages/web-ui/node_modules/ /app/web-ui/node_modules/
COPY --from=build-webui --chown=lynox:lynox /app/packages/web-ui/package.json /app/web-ui/package.json

COPY --chown=lynox:lynox entrypoint-webui.sh /entrypoint-webui.sh
RUN chmod +x /entrypoint-webui.sh

USER lynox

# Git SHA the engine was built from. Surfaced via /api/health so UpdateManager
# can verify the running container actually swapped to the new image after a
# rollout — package.json `version` (PKG_VERSION) is unchanged between two
# tagged builds against the same release commit (e.g. `staging` floats), so
# version-equality alone can't catch a stalled `docker compose pull`.
# Defaults empty so dev images don't bake in a stale SHA; CI always passes one
# via --build-arg BUILD_SHA=$GITHUB_SHA.
ARG BUILD_SHA=
ENV BUILD_SHA=${BUILD_SHA}

ENV NODE_ENV=production
ENV LYNOX_HTTP_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:${LYNOX_HTTP_PORT:-3000}/health || exit 1

ENTRYPOINT ["/entrypoint-webui.sh"]
