/**
 * Interactive Docker Compose scaffolder.
 * `npx @lynox-ai/core` or `lynox init` creates a complete Docker setup
 * (docker-compose.yml, .env, SearXNG) and starts the containers.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { BOLD, DIM, GREEN, RED, YELLOW, RESET } from './ansi.js';
import { confirm, readSecret, select } from './interactive.js';
import { renderGradientArt } from './ui.js';
import { writeFileAtomicSync } from '../core/atomic-write.js';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Terms-of-service acceptance
// ---------------------------------------------------------------------------

const TOS_VERSION = '1';

async function acceptTos(rl: ReturnType<typeof createInterface>): Promise<boolean> {
  const lynoxDir = join(homedir(), '.lynox');
  const flagPath = join(lynoxDir, `.tos-accepted-${TOS_VERSION}`);
  if (existsSync(flagPath)) return true;

  stdout.write(`\n  ${BOLD}Terms of Service${RESET}\n`);
  stdout.write(`  ${DIM}https://lynox.ai/terms${RESET}\n\n`);
  stdout.write(`  By continuing you accept the lynox terms of service\n`);
  stdout.write(`  (ELv2 license, no warranty, no support obligation for self-host).\n\n`);

  const ok = await confirm('Continue?', true, stdin.isTTY ? undefined : rl);
  if (!ok) {
    stdout.write(`  ${DIM}Cancelled — acceptance required to proceed.${RESET}\n`);
    return false;
  }

  try {
    mkdirSync(lynoxDir, { recursive: true });
    writeFileAtomicSync(flagPath, `${new Date().toISOString()}\n`);
  } catch {
    // Non-fatal — the wizard proceeds even if the flag can't be persisted.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Docker check
// ---------------------------------------------------------------------------

async function checkDocker(): Promise<boolean> {
  try {
    const { stdout: v } = await execFileAsync('docker', ['--version'], { timeout: 10_000 });
    const ver = v.trim().match(/Docker version ([^\s,]+)/)?.[1] ?? 'unknown';
    stdout.write(`  ${GREEN}✓${RESET} Docker ${ver}\n`);
  } catch {
    stdout.write(`  ${RED}✗${RESET} Docker not found.\n`);
    stdout.write(`  ${DIM}Install: https://docs.docker.com/get-docker/${RESET}\n`);
    return false;
  }

  try {
    await execFileAsync('docker', ['info'], { timeout: 10_000 });
  } catch {
    stdout.write(`  ${RED}✗${RESET} Docker daemon is not running.\n`);
    stdout.write(`  ${DIM}Start Docker Desktop or: sudo systemctl start docker${RESET}\n`);
    return false;
  }

  try {
    const { stdout: cv } = await execFileAsync('docker', ['compose', 'version'], { timeout: 10_000 });
    const ver = cv.trim().match(/v([^\s]+)/)?.[1] ?? 'unknown';
    stdout.write(`  ${GREEN}✓${RESET} Compose ${ver}\n`);
  } catch {
    stdout.write(`  ${RED}✗${RESET} Docker Compose not found.\n`);
    stdout.write(`  ${DIM}Install: https://docs.docker.com/compose/install/${RESET}\n`);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// API key validation (lightweight — no Anthropic SDK import)
// ---------------------------------------------------------------------------
//
// Three-state result so the installer can distinguish "definitely good"
// (green), "definitely bad" (red), and "couldn't reach the API" (yellow).
// The old shape collapsed unreachable → valid:true which made the installer
// claim "Verified" on a flaky network even though no auth check ran. Fixing
// that false-positive is item 19 of PRD-HN-LAUNCH-HARDENING.
export type KeyValidation =
  | { state: 'valid' }
  | { state: 'invalid'; error: string }
  | { state: 'network-error'; error: string };

export async function validateAnthropicKey(key: string): Promise<KeyValidation> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { state: 'valid' };
    if (res.status === 401 || res.status === 403) return { state: 'invalid', error: 'Invalid API key' };
    if (res.status === 429) return { state: 'invalid', error: 'Rate limited — try again in a moment' };
    // 5xx and other non-2xx are upstream issues, not key issues — treat as
    // network-error so we don't gate on a transient Anthropic outage.
    return { state: 'network-error', error: `Anthropic API responded ${String(res.status)}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { state: 'network-error', error: `Could not reach Anthropic API (${msg})` };
  }
}

// Mistral key validation — mirrors validateAnthropicKey shape. Hits the
// cheap GET /v1/models endpoint instead of POST /v1/chat/completions so we
// don't burn a token quota on every installer run. Same 3-state contract:
// 200 → valid, 401/403 → invalid, anything else → network-error (don't block).
export async function validateMistralKey(key: string): Promise<KeyValidation> {
  try {
    const res = await fetch('https://api.mistral.ai/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { state: 'valid' };
    if (res.status === 401 || res.status === 403) return { state: 'invalid', error: 'Invalid API key' };
    if (res.status === 429) return { state: 'invalid', error: 'Rate limited — try again in a moment' };
    return { state: 'network-error', error: `Mistral API responded ${String(res.status)}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { state: 'network-error', error: `Could not reach Mistral API (${msg})` };
  }
}

// TCP-probe a port to see if anything is already listening. Fast (~50ms on
// localhost) and dependency-free. Returns true if the port is occupied.
// Used by the pre-flight check before `docker compose up` so the installer
// can fail loudly instead of letting compose return "exited 125" with empty
// container logs. Item 17 of PRD-HN-LAUNCH-HARDENING.
export function isPortInUse(port: number, host = '127.0.0.1', timeoutMs = 1_000): Promise<boolean> {
  return new Promise<boolean>((resolveOuter) => {
    const socket = netConnect({ port, host });
    let settled = false;
    const done = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOuter(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    // ECONNREFUSED = nothing listening; any other error (EHOSTUNREACH, etc.)
    // we also treat as free so we don't block install on weird network state.
    socket.once('error', () => done(false));
  });
}

// Parse `LYNOX_VAULT_KEY=...` from the recovery .env at ~/.lynox/.env (item
// 20). Returns the trimmed value or null when the file is missing/empty/has
// no key line. Tolerates surrounding quotes and Windows line endings.
export function readVaultKeyFromRecoveryFile(path: string): string | null {
  if (!existsSync(path)) return null;
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^LYNOX_VAULT_KEY=(.*)$/.exec(line);
    if (m) {
      const value = (m[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
      return value || null;
    }
  }
  return null;
}

// Best-effort process lookup for an occupied port. Uses lsof -i :PORT -t
// (POSIX-friendly, no parsing of human-readable output). Returns null on
// Windows, missing lsof, or no match. Pure diagnostic — never throws.
async function lookupPortProcess(port: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout: pidsOut } = await execFileAsync('lsof', ['-i', `:${String(port)}`, '-t'], { timeout: 2_000 });
    const pid = pidsOut.trim().split('\n')[0];
    if (!pid) return null;
    try {
      const { stdout: nameOut } = await execFileAsync('ps', ['-p', pid, '-o', 'comm='], { timeout: 2_000 });
      const name = nameOut.trim();
      return name ? `${name} (pid ${pid})` : `pid ${pid}`;
    } catch {
      return `pid ${pid}`;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Collect Anthropic API key with validation + retry
// ---------------------------------------------------------------------------

async function collectAnthropicKey(
  rl: import('node:readline/promises').Interface,
): Promise<string | null> {
  const MAX = 5;
  for (let i = 1; i <= MAX; i++) {
    const input = await readSecret(`${BOLD}Key:${RESET}`, stdin.isTTY ? undefined : rl);
    if (!input.trim()) {
      stdout.write(`  ${DIM}Cancelled.${RESET}\n`);
      return null;
    }
    const key = input.trim();
    if (!key.startsWith('sk-') || key.length < 20) {
      stdout.write(`  ${YELLOW}⚠${RESET} Should start with "sk-" and be 20+ characters.\n`);
      if (i >= 3) stdout.write(`  ${DIM}Get a key: console.anthropic.com → API Keys${RESET}\n`);
      continue;
    }
    stdout.write(`  ${DIM}Verifying...${RESET}`);
    const result = await validateAnthropicKey(key);
    if (result.state === 'invalid') {
      stdout.write(`\r  ${RED}✗${RESET} ${result.error}.\n`);
      if (i >= MAX) {
        stdout.write(`  ${YELLOW}⚠${RESET} Max attempts. Edit .env after setup.\n`);
        return null;
      }
      continue;
    }
    if (result.state === 'network-error') {
      // Honest yellow: we couldn't verify, but a flaky network shouldn't
      // gate the install. Proceed and let the engine surface a real 401 at
      // first chat if the key turns out to be bad.
      stdout.write(`\r  ${YELLOW}⚠${RESET} ${result.error} — proceeding without verification.\n`);
      return key;
    }
    stdout.write(`\r  ${GREEN}✓${RESET} Verified.           \n`);
    return key;
  }
  return null;
}

async function collectMistralKey(
  rl: import('node:readline/promises').Interface,
): Promise<string | null> {
  const MAX = 5;
  for (let i = 1; i <= MAX; i++) {
    const input = await readSecret(`  ${BOLD}Mistral API Key:${RESET}`, stdin.isTTY ? undefined : rl);
    if (!input.trim()) {
      stdout.write(`  ${DIM}Cancelled.${RESET}\n`);
      return null;
    }
    const key = input.trim();
    stdout.write(`  ${DIM}Verifying...${RESET}`);
    const result = await validateMistralKey(key);
    if (result.state === 'invalid') {
      stdout.write(`\r  ${RED}✗${RESET} ${result.error}.\n`);
      if (i >= MAX) {
        stdout.write(`  ${YELLOW}⚠${RESET} Max attempts. Edit .env after setup.\n`);
        return null;
      }
      continue;
    }
    if (result.state === 'network-error') {
      stdout.write(`\r  ${YELLOW}⚠${RESET} ${result.error} — proceeding without verification.\n`);
      return key;
    }
    stdout.write(`\r  ${GREEN}✓${RESET} Verified.           \n`);
    return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Health check polling
// ---------------------------------------------------------------------------

async function pollHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${String(port)}/api/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 2_000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shell command with inherited stdio (shows Docker pull progress)
// ---------------------------------------------------------------------------

function runShell(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${String(code ?? 'null')}`));
    });
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// File generators
// ---------------------------------------------------------------------------

function generateEnvFile(vars: Record<string, string>): string {
  const lines = [
    '# lynox — generated by npx @lynox-ai/core',
    '# https://docs.lynox.ai',
    '',
  ];
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}=${value}`);
  }
  lines.push('');
  return lines.join('\n');
}

// Parameterized so item 17 can re-map the host-side port when :3000 is
// already taken on the user's machine. Container port stays 3000 (matches
// the internal healthcheck + entrypoint default).
export function buildComposeFile(hostPort: number = 3000): string {
  return `# lynox Docker Compose
# Generated by npx @lynox-ai/core
#
# Start:   docker compose up -d
# Stop:    docker compose down
# Logs:    docker compose logs -f
# Update:  docker compose pull && docker compose up -d

services:
  lynox:
    image: ghcr.io/lynox-ai/lynox:latest
    # Explicit platform pin — safe default while the multi-arch manifest
    # rolls out. Apple Silicon users can remove this line once :latest is
    # multi-arch to get a native arm64 image instead of Rosetta emulation.
    platform: linux/amd64
    restart: unless-stopped
    read_only: true
    ports:
      - "${String(hostPort)}:3000"
    tmpfs:
      - /tmp:size=512M
      - /workspace:size=256M,uid=1001,gid=1001
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3
    env_file: .env
    environment:
      - SEARXNG_URL=http://searxng:8080
    volumes:
      - \${HOME}/.lynox:/home/lynox/.lynox

  searxng:
    image: searxng/searxng:latest
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp:size=64M
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
`;
}

export function generateSearxngSettings(): string {
  const secretKey = randomBytes(32).toString('base64');
  // Engine list mirrors core/searxng/settings.yml (source of truth).
  // The extra independent crawlers (brave, mojeek) and EU-friendly engines
  // (qwant, startpage) give the aggregator a larger quorum so a single
  // rate-limited upstream (DuckDuckGo on fresh container IPs) cannot kill
  // a query. Keep these two lists in sync.
  return `# SearXNG for lynox — generated by npx @lynox-ai/core

use_default_settings:
  engines:
    keep_only:
      # General — kept in sync with core/searxng/settings.yml
      - google
      - duckduckgo
      - bing
      - brave
      - qwant
      - startpage
      - mojeek
      - wikipedia
      - wikidata
      - currency
      # News
      - google news
      - duckduckgo news
      - bing news
      # Science
      - google scholar
      - semantic scholar
      - arxiv
      # IT
      - github
      - stackoverflow
      - npm
      - pypi

general:
  debug: false
  instance_name: "lynox-search"
  enable_metrics: false

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "auto"
  formats:
    - html
    - json

server:
  port: 8080
  bind_address: "0.0.0.0"
  secret_key: "${secretKey}"
  limiter: false
  public_instance: false
  image_proxy: false
  method: "GET"

ui:
  default_theme: simple
  query_in_title: false

outgoing:
  request_timeout: 5.0
  pool_connections: 100
  pool_maxsize: 20
  enable_http2: true
`;
}

// ---------------------------------------------------------------------------
// Main installer
// ---------------------------------------------------------------------------

export async function runDockerInstaller(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });

  try {
    stdout.write('\n' + renderGradientArt());
    stdout.write(`  ${BOLD}Install${RESET}  ${DIM}Docker setup in one command.${RESET}\n\n`);

    // ── ToS acceptance ─────────────────────────────────
    if (!(await acceptTos(rl))) return;

    // ── Docker check ───────────────────────────────────
    const ok = await checkDocker();
    if (!ok) return;

    // ── Install directory ──────────────────────────────
    const dirInput = await rl.question(`\n  ${BOLD}Directory${RESET} ${DIM}(./lynox)${RESET}: `);
    const installDir = resolve(dirInput.trim() || './lynox');

    if (existsSync(join(installDir, 'docker-compose.yml'))) {
      const overwrite = await confirm('Existing setup found. Reconfigure?', false, stdin.isTTY ? undefined : rl);
      if (!overwrite) {
        stdout.write(`  ${DIM}Cancelled.${RESET}\n`);
        return;
      }
    }

    // ── LLM Provider ───────────────────────────────────
    // Triad matches the in-product SetupBanner (Anthropic / Mistral /
    // OpenAI-compatible). Source of truth: src/cli/setup-wizard.ts's prior
    // menu (deleted with this PR — its logic is now ported here so the
    // README/docs promise lines up with what `npx @lynox-ai/core` actually
    // shows). Vertex stays wired in the engine for existing config.json
    // users but is no longer offered at install time.
    stdout.write(`\n  ${BOLD}LLM Provider${RESET}\n`);
    stdout.write(`  ${DIM}Where should AI requests be sent?${RESET}\n\n`);

    type ProviderChoice = 'anthropic' | 'mistral' | 'custom';
    const provider = await select<ProviderChoice>([
      { label: 'Claude (Anthropic)', value: 'anthropic', hint: 'recommended' },
      { label: 'Mistral', value: 'mistral', hint: 'Paris, EU' },
      { label: 'OpenAI-compatible', value: 'custom', hint: 'Ollama, LM Studio, Groq, LiteLLM, vLLM' },
    ], { default: 0, rl: stdin.isTTY ? undefined : rl }) ?? 'anthropic';

    // ── Provider-specific input ────────────────────────
    const envVars: Record<string, string> = {};

    if (provider === 'anthropic') {
      stdout.write(`\n  ${BOLD}API Key${RESET}  ${DIM}console.anthropic.com → API Keys${RESET}\n`);
      const key = await collectAnthropicKey(rl);
      if (!key) return;
      envVars['ANTHROPIC_API_KEY'] = key;

    } else if (provider === 'mistral') {
      // Mistral routes through the engine's OpenAI-compatible adapter (same
      // wire shape as openai/custom); the user-facing label stays "Mistral"
      // so the model + endpoint defaults are pre-filled.
      envVars['LYNOX_LLM_PROVIDER'] = 'openai';
      envVars['ANTHROPIC_BASE_URL'] = 'https://api.mistral.ai/v1';

      stdout.write(`\n  ${BOLD}Mistral${RESET}  ${DIM}console.mistral.ai → API Keys${RESET}\n`);

      const modelChoice = await select([
        { label: 'mistral-large-2512', value: 'mistral-large-2512', hint: 'recommended — pinned snapshot' },
        { label: 'ministral-8b-2512', value: 'ministral-8b-2512', hint: 'low-cost orchestration' },
        { label: 'magistral-medium-2509', value: 'magistral-medium-2509', hint: 'reasoning specialist' },
        { label: 'codestral-latest', value: 'codestral-latest', hint: 'code-focused' },
      ], { default: 0, rl: stdin.isTTY ? undefined : rl }) ?? 'mistral-large-2512';
      envVars['OPENAI_MODEL_ID'] = modelChoice;
      stdout.write(`  ${GREEN}✓${RESET} Model: ${modelChoice}\n`);

      const apiKey = await collectMistralKey(rl);
      if (!apiKey) return;
      // Primary slot for openai-provider key lookup (see provider-keys.ts).
      envVars['MISTRAL_API_KEY'] = apiKey;

    } else {
      // ── Custom OpenAI-compatible (Ollama, LM Studio, Groq, LiteLLM, vLLM, …) ──
      envVars['LYNOX_LLM_PROVIDER'] = 'openai';
      stdout.write(`\n  ${BOLD}OpenAI-compatible${RESET}\n`);
      stdout.write(`  ${DIM}Point at any OpenAI-compatible endpoint.${RESET}\n\n`);

      // Preset selection — Ollama / LM Studio are the common self-host
      // defaults; "Other" lets the user paste any URL (Groq, vLLM, LiteLLM,
      // hosted OpenAI, …). Matches the wizard's preset hints.
      type PresetChoice = 'ollama' | 'lmstudio' | 'other';
      const preset = await select<PresetChoice>([
        { label: 'Ollama', value: 'ollama', hint: 'http://localhost:11434/v1' },
        { label: 'LM Studio', value: 'lmstudio', hint: 'http://localhost:1234/v1' },
        { label: 'Other (paste URL)', value: 'other', hint: 'Groq, vLLM, LiteLLM, hosted OpenAI, …' },
      ], { default: 0, rl: stdin.isTTY ? undefined : rl }) ?? 'ollama';

      const defaultsByPreset: Record<PresetChoice, { url: string; model: string }> = {
        ollama: { url: 'http://localhost:11434/v1', model: 'llama3.2' },
        lmstudio: { url: 'http://localhost:1234/v1', model: 'qwen2.5' },
        other: { url: 'http://localhost:11434/v1', model: 'llama3.2' },
      };
      const presetDefaults = defaultsByPreset[preset];

      let parsedBaseUrl: URL | null = null;
      let apiBaseUrl = presetDefaults.url;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const urlInput = (await rl.question(
          `  ${BOLD}Base URL${RESET} ${DIM}(${presetDefaults.url})${RESET}: `,
        )).trim();
        const candidate = urlInput || presetDefaults.url;
        try {
          parsedBaseUrl = new URL(candidate);
          apiBaseUrl = candidate;
          break;
        } catch {
          stdout.write(`  ${YELLOW}⚠${RESET} "${candidate}" is not a valid URL — include the scheme (http:// or https://).\n`);
          if (attempt >= 5) {
            stdout.write(`  ${RED}✗${RESET} Could not parse the base URL after 5 attempts.\n`);
            return;
          }
        }
      }
      if (!parsedBaseUrl) return;
      envVars['ANTHROPIC_BASE_URL'] = apiBaseUrl;

      const modelInput = (await rl.question(
        `  ${BOLD}Model ID${RESET} ${DIM}(${presetDefaults.model})${RESET}: `,
      )).trim();
      const modelId = modelInput || presetDefaults.model;
      envVars['OPENAI_MODEL_ID'] = modelId;

      // Loopback hosts (Ollama, LM Studio, vLLM) usually run without auth.
      // For container→host calls Docker users typically target
      // host.docker.internal; treat that as loopback too. Public hosts must
      // ship a key — empty key + public URL throws in createLLMClient.
      const isLoopback = ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']
        .includes(parsedBaseUrl.hostname);
      const keyPromptSuffix = isLoopback
        ? ` ${DIM}(blank for local endpoints without auth)${RESET}`
        : ` ${DIM}(required for public hosts)${RESET}`;
      const apiKeyInput = (await readSecret(
        `  ${BOLD}API Key:${RESET}${keyPromptSuffix}`,
        stdin.isTTY ? undefined : rl,
      )).trim();
      if (apiKeyInput) {
        // CUSTOM_API_KEY is the primary slot for provider 'custom', but the
        // installer writes LYNOX_LLM_PROVIDER=openai (Mistral + custom both
        // share the openai adapter), whose primary slot is MISTRAL_API_KEY
        // (see provider-keys.ts). Use OPENAI_API_KEY as the SDK-canonical
        // secondary slot so the user-facing env name matches expectations.
        envVars['OPENAI_API_KEY'] = apiKeyInput;
        // Custom endpoints are unknowable shape (Ollama, Groq, vLLM, …) —
        // no single probe URL works. Warn-only per item 18 of PRD-HN-LAUNCH-
        // HARDENING: tell the user we can't pre-flight the key.
        stdout.write(`  ${DIM}Key validation not available for custom endpoints; will be checked at first request.${RESET}\n`);
      } else if (!isLoopback) {
        stdout.write(`  ${YELLOW}⚠${RESET} Public host ${parsedBaseUrl.hostname} usually requires an API key. Engine will fail to start until you set OPENAI_API_KEY in .env or via Settings → Keys.\n`);
      }
      stdout.write(`  ${GREEN}✓${RESET} ${apiBaseUrl} (${modelId})\n`);
    }

    // ── Port pre-check (item 17) ───────────────────────
    // Default :3000 may be occupied by another dev server / managed engine /
    // SaaS daemon. The PORT=... env-var lets the operator override the
    // host-side port without editing docker-compose.yml after the fact.
    const requestedPortRaw = process.env['PORT'];
    let hostPort = 3000;
    if (requestedPortRaw && /^\d{1,5}$/.test(requestedPortRaw)) {
      const parsed = Number(requestedPortRaw);
      if (parsed >= 1 && parsed <= 65535) hostPort = parsed;
    }
    if (await isPortInUse(hostPort)) {
      const owner = await lookupPortProcess(hostPort);
      stdout.write(`\n  ${YELLOW}⚠${RESET} Port ${String(hostPort)} is already in use${owner ? ` by ${owner}` : ''}.\n`);
      const useAlt = await confirm(
        'Pick a different port?',
        true,
        stdin.isTTY ? undefined : rl,
      );
      if (useAlt) {
        for (let i = 1; i <= 5; i++) {
          const altInput = (await rl.question(
            `  ${BOLD}Alternative port${RESET} ${DIM}(e.g. 3001)${RESET}: `,
          )).trim();
          if (!/^\d{1,5}$/.test(altInput)) {
            stdout.write(`  ${YELLOW}⚠${RESET} Not a valid port number.\n`);
            if (i >= 5) {
              stdout.write(`  ${RED}✗${RESET} Could not parse port after 5 attempts. Aborting.\n`);
              return;
            }
            continue;
          }
          const alt = Number(altInput);
          if (alt < 1 || alt > 65535) {
            stdout.write(`  ${YELLOW}⚠${RESET} Port must be between 1 and 65535.\n`);
            continue;
          }
          if (await isPortInUse(alt)) {
            stdout.write(`  ${YELLOW}⚠${RESET} Port ${String(alt)} is also in use. Try another.\n`);
            continue;
          }
          hostPort = alt;
          stdout.write(`  ${GREEN}✓${RESET} Using port ${String(hostPort)}.\n`);
          break;
        }
        if (await isPortInUse(hostPort)) return;
      } else {
        // User chose not to pick an alternative — surface the actionable hint
        // and stop. Empty `docker compose logs` after a port collision was
        // the silent-failure mode this whole branch fixes (item 17).
        stdout.write(`  ${DIM}Either stop the conflicting process, or rerun with:${RESET}\n`);
        stdout.write(`  ${DIM}  PORT=3001 npx @lynox-ai/core${RESET}\n`);
        return;
      }
    }

    // ── Access token ───────────────────────────────────
    const tokenInput = (await rl.question(`\n  ${BOLD}Access token${RESET} ${DIM}(blank = auto-generate)${RESET}: `)).trim();
    const token = tokenInput || randomBytes(32).toString('hex');
    envVars['LYNOX_HTTP_SECRET'] = token;

    // One-time onboarding token enables `?token=` auto-login on the first
    // browser open (item 22). The login page consumes it via
    // `.onboarding-consumed` so re-visiting the URL from shell history is
    // a no-op (no replay).
    const onboardingToken = randomBytes(32).toString('hex');
    envVars['LYNOX_ONBOARDING_TOKEN'] = onboardingToken;

    // ── Bind-mount target ──────────────────────────────
    // The compose file mounts ${HOME}/.lynox into the container. On native
    // Linux, if that directory doesn't exist yet, Docker creates it owned
    // by root, which then breaks the in-container user (uid 1001) trying
    // to write its DB / vault. Create it up front so the bind mount lands
    // on a user-owned dir. macOS Docker Desktop already user-owns auto-
    // created mount points, but the call is harmless there.
    try {
      mkdirSync(join(homedir(), '.lynox'), { recursive: true, mode: 0o700 });
    } catch {
      // Best-effort: if HOME isn't writable, docker compose will surface
      // the real error in the next step.
    }

    // ── Vault key recovery copy (item 20) ──────────────
    // The vault key has a single source of truth at ~/.lynox/.env so a user
    // who deletes the compose dir and re-runs `npx` keeps decryption working.
    // - If ~/.lynox/.env already holds a key, REUSE it (the persisted
    //   vault.db on the bind-mounted ~/.lynox volume was encrypted with that
    //   key — generating a new one would silently brick the install).
    // - Otherwise generate a fresh key and write it to ~/.lynox/.env with
    //   mode 0600 as the recovery copy.
    const recoveryEnvPath = join(homedir(), '.lynox', '.env');
    let vaultKey: string;
    let vaultKeyReused = false;
    let recoveryWritten = false;
    const existingVaultKey = readVaultKeyFromRecoveryFile(recoveryEnvPath);
    if (existingVaultKey) {
      vaultKey = existingVaultKey;
      vaultKeyReused = true;
      stdout.write(`  ${GREEN}✓${RESET} Reusing existing vault key from ${recoveryEnvPath} (preserves prior data).\n`);
    } else {
      vaultKey = randomBytes(48).toString('base64');
      try {
        writeFileAtomicSync(
          recoveryEnvPath,
          `LYNOX_VAULT_KEY=${vaultKey}\n`,
          { fileMode: 0o600 },
        );
        recoveryWritten = true;
      } catch {
        // Non-fatal — warn so the operator can copy it by hand.
        stdout.write(`  ${YELLOW}⚠${RESET} Could not write recovery copy to ${recoveryEnvPath}.\n`);
      }
    }
    envVars['LYNOX_VAULT_KEY'] = vaultKey;

    // Done with interactive input
    rl.close();

    // ── Generate files ─────────────────────────────────
    writeFileAtomicSync(join(installDir, 'docker-compose.yml'), buildComposeFile(hostPort));
    writeFileAtomicSync(join(installDir, '.env'), generateEnvFile(envVars));
    writeFileAtomicSync(join(installDir, 'searxng', 'settings.yml'), generateSearxngSettings());
    writeFileAtomicSync(join(installDir, '.gitignore'), '.env\n');

    stdout.write(`\n  ${GREEN}✓${RESET} docker-compose.yml\n`);
    stdout.write(`  ${GREEN}✓${RESET} .env\n`);
    stdout.write(`  ${GREEN}✓${RESET} searxng/settings.yml\n`);

    // ── docker compose up ──────────────────────────────
    stdout.write(`\n  ${DIM}Pulling images and starting...${RESET}\n\n`);
    try {
      await runShell('docker', ['compose', 'up', '-d'], installDir);
    } catch {
      stdout.write(`\n  ${RED}✗${RESET} Failed to start. Run:\n`);
      stdout.write(`  ${DIM}cd ${installDir} && docker compose logs${RESET}\n`);
      return;
    }

    // ── Health check ───────────────────────────────────
    stdout.write(`\n  ${DIM}Waiting for health check...${RESET}`);
    const healthy = await pollHealth(hostPort, 60_000);
    stdout.write(healthy
      ? `\r  ${GREEN}✓${RESET} Healthy.                    \n`
      : `\r  ${YELLOW}⚠${RESET} Timed out — check: cd ${installDir} && docker compose logs\n`);

    // ── Done ───────────────────────────────────────────
    const url = `http://localhost:${String(hostPort)}`;
    // Auto-login URL (item 22) — single-use token consumed server-side on
    // first hit. After consumption the bare URL still works (operator just
    // logs in normally). Token in shell history is noted below.
    const loginUrl = `${url}/login?token=${encodeURIComponent(onboardingToken)}`;
    stdout.write(`\n  ${GREEN}${BOLD}✨ lynox is running at ${url}${RESET}\n`);
    stdout.write(`     ${BOLD}Access token:${RESET} ${token}\n`);
    stdout.write(`     ${BOLD}Vault key:${RESET}    ${vaultKey}${vaultKeyReused ? `  ${DIM}(reused)${RESET}` : ''}\n`);
    if (recoveryWritten) {
      stdout.write(`     ${DIM}Vault key recovery copy saved to ${recoveryEnvPath} (mode 0600).${RESET}\n`);
      stdout.write(`     ${DIM}Keep this file backed up — it survives compose-dir deletion.${RESET}\n`);
    } else if (vaultKeyReused) {
      stdout.write(`     ${DIM}Recovery copy lives at ${recoveryEnvPath} (mode 0600).${RESET}\n`);
    }
    stdout.write(`\n  ${YELLOW}⚠${RESET}  Save both values in a password manager — the vault key\n`);
    stdout.write(`     encrypts your data. Without it, secrets cannot be recovered.\n\n`);
    stdout.write(`  ${DIM}Stop:    cd ${installDir} && docker compose down${RESET}\n`);
    stdout.write(`  ${DIM}Logs:    cd ${installDir} && docker compose logs -f${RESET}\n`);
    stdout.write(`  ${DIM}Update:  docker compose pull && docker compose up -d${RESET}\n\n`);
    stdout.write(`  ${YELLOW}Security:${RESET} lynox runs over HTTP by default.\n`);
    stdout.write(`  ${DIM}For remote access, use a reverse proxy (Caddy, nginx) with TLS.${RESET}\n`);
    stdout.write(`  ${DIM}Docs: https://docs.lynox.ai/integrations/remote-access/${RESET}\n\n`);

    // Open browser (best-effort) with one-time auto-login token (item 22).
    if (healthy) {
      stdout.write(`  ${DIM}Opening ${url} in your browser (one-time auto-login).${RESET}\n`);
      stdout.write(`  ${DIM}Tip: the login URL contains a sensitive token; it is single-use${RESET}\n`);
      stdout.write(`  ${DIM}and will be in your shell history if you re-run the open command.${RESET}\n\n`);
      try {
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open';
        execFileCb(cmd, [loginUrl], () => { /* ignore */ });
      } catch { /* best-effort */ }
    }

  } finally {
    try { rl.close(); } catch { /* already closed */ }
  }
}
