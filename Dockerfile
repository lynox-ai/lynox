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
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build-engine
WORKDIR /app
# Disable lefthook in the build: its dev-dep postinstall runs `lefthook install`
# which needs a git repo/binary that isn't in this stage, failing the build on a
# cold install-layer cache (the `|| true` on our own `prepare` doesn't cover the
# package's own postinstall). LEFTHOOK=0 makes lefthook skip — git hooks are a
# dev-machine concern, never needed in an image build.
ENV LEFTHOOK=0
# onnxruntime-node's postinstall fetches only CUDA/TensorRT providers on
# linux/x64 (~300 MB, never loaded; the CPU runtime ships in the package).
ENV ONNXRUNTIME_NODE_INSTALL=skip

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
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build-webui
WORKDIR /app

# Bake the build SHA into the web-ui bundle so the running client can detect
# a stale-cache mismatch against the engine's /api/health.build_sha. CI passes
# this via --build-arg BUILD_SHA=$GITHUB_SHA in staging.yml.
ARG BUILD_SHA=
ENV BUILD_SHA=${BUILD_SHA}
# See build-engine stage: skip lefthook's git-dependent postinstall in the build.
ENV LEFTHOOK=0
# The web-ui install also installs the workspace root's dependencies, so the
# onnxruntime-node postinstall runs here too (see build-engine stage).
ENV ONNXRUNTIME_NODE_INSTALL=skip

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
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# onnxruntime-node: skip the postinstall download (CUDA/TensorRT providers only on
# linux/x64, ~300 MB, never loaded — the CPU runtime ships in the npm package),
# and remove the provider files in case a warm store's side-effects cache put them
# back. Then prove the CPU runtime still loads in this image.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod \
    && node -e "const db = require('better-sqlite3')(':memory:'); db.prepare('SELECT 1').get(); db.close(); console.log('better-sqlite3 OK')" \
    && ORT_DIR="$(ls -d node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node)" \
    && rm -f "$ORT_DIR"/bin/napi-v6/linux/*/libonnxruntime_providers_*.so \
    && test -z "$(find "$ORT_DIR/bin" -name 'libonnxruntime_providers_*')" \
    && node -e "require(require('path').resolve(process.argv[1])); console.log('onnxruntime-node OK')" "$ORT_DIR"

# --- Stage 4: Whisper.cpp (audio transcription) ---
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS whisper-build

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

# Whisper STT model: first from OUR GitHub release mirror, then from Hugging
# Face at a pinned commit. HF intermittently served HTTP errors and flaked the
# build repeatedly (~5× on 2026-06-03/04), which is why the mirror comes first;
# the mirror in turn answered 504 for longer than one source's retry window, so
# HF stays as the second source. Both serve the same bytes, and the sha256 below
# is checked once, whichever source delivered (scripts/fetch-pinned.sh).
# Only the `base` model is shipped — it transcribes all clip lengths; the prior
# `tiny` model was just a short-clip speed optimisation that whisper-cpp.ts
# already treats as optional (falls back to base).
RUN --mount=type=bind,source=scripts/fetch-pinned.sh,target=/tmp/fetch-pinned.sh \
    mkdir -p /usr/share/whisper \
    && sh /tmp/fetch-pinned.sh /usr/share/whisper/ggml-base.bin \
       60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe \
       https://github.com/lynox-ai/lynox/releases/download/whisper-models/ggml-base.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin

# --- Stage 5: Production image ---
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS production

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    wget ffmpeg libstdc++6 tini

# Whisper.cpp binaries + model
COPY --from=whisper-build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /usr/local/lib/libwhisper* /usr/local/lib/
COPY --from=whisper-build /usr/local/lib/libggml* /usr/local/lib/
COPY --from=whisper-build /usr/share/whisper/ggml-base.bin /usr/share/whisper/ggml-base.bin
RUN ldconfig

# Harden: remove package managers, shells, SUID binaries.
# npm, corepack and yarn are the base image's bundled Node package managers; the
# runtime runs `node /app/dist/index.js` with pre-installed /app/node_modules and
# never invokes them, so they are dead weight — and their bundled node-tar carries
# fixed-but-unreachable CVEs (e.g. CVE-2026-59873) that fail the image scan.
#
# The dpkg STATUS stays (/var/lib/dpkg): an image scanner reads the installed OS
# packages from it. Without it a scan reports zero OS packages, which reads like a
# clean image and is a blind one. The tools go; the record of what is installed stays.
# Perl is removed through dpkg first, so the database no longer lists it. (It still
# lists apt, dpkg and bash, whose files the chain below deletes: a scan then reports
# packages that are gone, which fails a release, not passes it.) Its own RUN, because
# the chain below ends in `|| true`.
RUN dpkg --purge --force-remove-essential --force-depends perl-base
RUN \
    rm -rf /usr/bin/apt-get /usr/bin/apt /usr/bin/dpkg /usr/bin/dpkg-* \
           /usr/lib/apt /var/lib/apt /etc/apt \
    && rm -rf /usr/bin/perl* /usr/share/perl* /usr/lib/*/perl* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && rm -f /usr/bin/bash /bin/bash /usr/bin/rbash /bin/rbash \
    && find / -perm -4000 -type f -exec chmod u-s {} + 2>/dev/null || true \
    && sed -i 's|root:/bin/bash|root:/usr/sbin/nologin|' /etc/passwd

RUN groupadd -g 1001 lynox && useradd -u 1001 -g lynox -m -s /bin/sh lynox \
    && mkdir -p /home/lynox/.lynox/memory /workspace /home/lynox/.cache/huggingface \
    && chown -R lynox:lynox /home/lynox/.lynox /workspace /home/lynox/.cache

# Shell sidecar (PRD 152 v2 §4.1). The same image runs as the sidecar with
# `/usr/bin/tini -- node /app/dist/shell-sidecar/exec-daemon.js` as uid 0 with only
# CAP_SETUID/CAP_SETGID. Its calls run as pool uids whose only group is lynox-ws
# (1002); the engine user is a member, so both reach the shared workspace, but a
# pool uid is never in 1001 and cannot open the socket. /run/lynox-exec is the
# socket volume's mount point: root 0755, so a fresh named volume starts that way
# and the daemon creates its 0710 root:1001 directory inside. tini because a
# killed call's children otherwise stay as zombies (measured: 33 without, 0 with).
RUN groupadd -g 1002 lynox-ws && usermod -aG lynox-ws lynox \
    && mkdir -p /run/lynox-exec && chown root:root /run/lynox-exec && chmod 0755 /run/lynox-exec

WORKDIR /app

# The code belongs to root and the runtime user only reads it, so the process cannot
# change what it runs on its next start. The fleet's read-only root filesystem already
# stops that; a container started without it (`docker run`, an own compose file) did
# not. Nothing writes under /app at runtime: caches go to $HOME/.cache.

# Engine
COPY --from=deps /app/node_modules/ /app/node_modules/
COPY --from=build-engine /app/dist/ /app/dist/
COPY --from=build-engine /app/package.json /app/package.json

# Web UI
COPY --from=build-webui /app/packages/web-ui/build/ /app/web-ui/
COPY --from=build-webui /app/packages/web-ui/node_modules/ /app/web-ui/node_modules/
COPY --from=build-webui /app/packages/web-ui/package.json /app/web-ui/package.json

COPY entrypoint-webui.sh /entrypoint-webui.sh
RUN chmod 0755 /entrypoint-webui.sh

# Every program in the image is execute-only for the runtime user, so no
# process in the container is dumpable. The kernel marks a process started from
# a binary its user cannot read as not dumpable, and another process of the
# same user then cannot read its /proc/<pid>/environ or memory (with the
# host's fs.suid_dumpable at 0 or 2, the default). It holds for every process
# started from a program in the image: the engine, what it starts, and what
# `docker exec` starts from here. Not for a binary from outside the image, such
# as the `docker-init` that `init: true` mounts in as pid 1 — so the container
# runs without one. A program is an executable ELF file without a library name; owned by
# root, because its owner could read it whatever the mode. Libraries stay
# readable: the loader maps them. Last, after every COPY, so a binary a
# dependency brings is covered too. scripts/image-exec-only-probe.sh checks
# the built image (smoke).
RUN find / -xdev -type f -perm /111 ! -name '*.so' ! -name '*.so.*' ! -name '*.node' \
      -exec sh -c 'for f; do head -c4 "$f" | grep -q ELF && chown root:root "$f" && chmod go-r "$f"; done; true' sh {} +

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
