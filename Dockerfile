# Pin digest: run `docker pull node:22-slim` and update hash before release
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Production dependencies only — separate stage to exclude devDependencies
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod \
    && node node_modules/@ladybugdb/core/install.js

# Whisper.cpp build stage — compiles whisper-cli + downloads base model
FROM node:22-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS whisper-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake make g++ git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin whisper.cpp to release tag for reproducible builds
# GGML_NATIVE=OFF for portable binary (no host-specific SIMD auto-detection)
RUN git clone --depth 1 --branch v1.8.4 https://github.com/ggerganov/whisper.cpp /tmp/whisper \
    && cd /tmp/whisper \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
    && cmake --build build --config Release -j$(nproc) \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && cp build/src/libwhisper.so.1* /usr/local/lib/ \
    && cp build/ggml/src/libggml*.so.0* /usr/local/lib/ \
    && ldconfig

# Download model and verify checksum
RUN mkdir -p /usr/share/whisper \
    && curl -L -o /usr/share/whisper/ggml-base.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin \
    && echo "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe /usr/share/whisper/ggml-base.bin" | sha256sum -c -

# Production stage — Debian Trixie (13) for glibc 2.40
# LadybugDB prebuilt binaries require glibc >=2.38, Bookworm only has 2.36
FROM debian:trixie-slim

LABEL org.opencontainers.image.title="nodyn" \
      org.opencontainers.image.description="Open business AI engine built on Anthropic Claude" \
      org.opencontainers.image.url="https://github.com/nodyn-ai/nodyn" \
      org.opencontainers.image.source="https://github.com/nodyn-ai/nodyn" \
      org.opencontainers.image.licenses="ELv2" \
      org.opencontainers.image.vendor="nodyn-ai"

WORKDIR /app

# Node.js runtime copied from build stage (no curl|bash install script needed)
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/include/node /usr/local/include/node

# ffmpeg for audio conversion (OGG->WAV) + wget for lightweight health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg wget libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=whisper-build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /usr/local/lib/libwhisper* /usr/local/lib/
COPY --from=whisper-build /usr/local/lib/libggml* /usr/local/lib/
COPY --from=whisper-build /usr/share/whisper/ggml-base.bin /usr/share/whisper/ggml-base.bin
RUN ldconfig

COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Harden: remove package managers, shells, SUID binaries, unused accounts
RUN \
    # Remove package managers — no runtime installs possible
    rm -rf /usr/bin/apt-get /usr/bin/apt /usr/bin/dpkg /usr/bin/dpkg-* \
           /usr/lib/apt /var/lib/dpkg /var/lib/apt /etc/apt \
    # Remove perl — not needed at runtime
    && rm -rf /usr/bin/perl* /usr/share/perl* /usr/lib/*/perl* \
    # Remove bash — entrypoint uses /bin/sh (dash), execSync defaults to /bin/sh
    && rm -f /usr/bin/bash /bin/bash /usr/bin/rbash /bin/rbash \
    # Strip SUID bits — non-root user doesn't need privilege escalation
    && find / -perm -4000 -type f -exec chmod u-s {} + 2>/dev/null || true \
    # Set login shells to nologin for unused accounts
    && sed -i 's|root:/bin/bash|root:/usr/sbin/nologin|' /etc/passwd

RUN groupadd -g 1001 nodyn && useradd -u 1001 -g nodyn -m -s /bin/sh nodyn \
    && mkdir -p /home/nodyn/.nodyn/memory /workspace /home/nodyn/.cache/huggingface \
    && chown -R nodyn:nodyn /tmp /home/nodyn/.nodyn /workspace /home/nodyn/.cache/huggingface

ENV NODYN_WORKSPACE=/workspace
WORKDIR /workspace
USER nodyn

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${NODYN_MCP_PORT:-3042}/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
