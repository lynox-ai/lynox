/**
 * Interactive Docker Compose scaffolder.
 * `npx @lynox-ai/core` or `lynox init` creates a complete Docker setup
 * (docker-compose.yml, .env, SearXNG) and starts the containers.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
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

async function validateAnthropicKey(key: string): Promise<{ valid: boolean; error?: string | undefined }> {
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
    if (res.ok) return { valid: true };
    if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
    if (res.status === 429) return { valid: false, error: 'Rate limited — try again in a moment' };
    return { valid: true };
  } catch {
    return { valid: true };
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
    if (!result.valid) {
      stdout.write(`\r  ${RED}✗${RESET} ${result.error ?? 'Invalid'}.\n`);
      if (i >= MAX) {
        stdout.write(`  ${YELLOW}⚠${RESET} Max attempts. Edit .env after setup.\n`);
        return null;
      }
      continue;
    }
    stdout.write(result.error
      ? `\r  ${YELLOW}⚠${RESET} ${result.error}\n`
      : `\r  ${GREEN}✓${RESET} Verified.           \n`);
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

const COMPOSE_TEMPLATE = `# lynox Docker Compose
# Generated by npx @lynox-ai/core
#
# Start:   docker compose up -d
# Stop:    docker compose down
# Logs:    docker compose logs -f
# Update:  docker compose pull && docker compose up -d

services:
  lynox:
    image: ghcr.io/lynox-ai/lynox:latest
    restart: unless-stopped
    read_only: true
    ports:
      - "3000:3000"
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
        { label: 'mistral-large-latest', value: 'mistral-large-latest', hint: 'recommended' },
        { label: 'mistral-medium-latest', value: 'mistral-medium-latest' },
        { label: 'codestral-latest', value: 'codestral-latest', hint: 'code-focused' },
      ], { default: 0, rl: stdin.isTTY ? undefined : rl }) ?? 'mistral-large-latest';
      envVars['OPENAI_MODEL_ID'] = modelChoice;
      stdout.write(`  ${GREEN}✓${RESET} Model: ${modelChoice}\n`);

      const apiKey = (await readSecret(`  ${BOLD}Mistral API Key:${RESET}`, stdin.isTTY ? undefined : rl)).trim();
      if (!apiKey) {
        stdout.write(`  ${DIM}Cancelled.${RESET}\n`);
        return;
      }
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
      } else if (!isLoopback) {
        stdout.write(`  ${YELLOW}⚠${RESET} Public host ${parsedBaseUrl.hostname} usually requires an API key. Engine will fail to start until you set OPENAI_API_KEY in .env or via Settings → Keys.\n`);
      }
      stdout.write(`  ${GREEN}✓${RESET} ${apiBaseUrl} (${modelId})\n`);
    }

    // ── Access token ───────────────────────────────────
    const tokenInput = (await rl.question(`\n  ${BOLD}Access token${RESET} ${DIM}(blank = auto-generate)${RESET}: `)).trim();
    const token = tokenInput || randomBytes(32).toString('hex');
    envVars['LYNOX_HTTP_SECRET'] = token;

    // ── Vault key (encryption at rest) ────────────────
    const vaultKey = randomBytes(48).toString('base64');
    envVars['LYNOX_VAULT_KEY'] = vaultKey;

    // Done with interactive input
    rl.close();

    // ── Generate files ─────────────────────────────────
    writeFileAtomicSync(join(installDir, 'docker-compose.yml'), COMPOSE_TEMPLATE);
    writeFileAtomicSync(join(installDir, '.env'), generateEnvFile(envVars));
    writeFileAtomicSync(join(installDir, 'searxng', 'settings.yml'), generateSearxngSettings());
    writeFileAtomicSync(join(installDir, '.gitignore'), '.env\n');

    stdout.write(`\n  ${GREEN}✓${RESET} docker-compose.yml\n`);
    stdout.write(`  ${GREEN}✓${RESET} .env\n`);
    stdout.write(`  ${GREEN}✓${RESET} searxng/settings.yml\n`);

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
    const healthy = await pollHealth(3000, 60_000);
    stdout.write(healthy
      ? `\r  ${GREEN}✓${RESET} Healthy.                    \n`
      : `\r  ${YELLOW}⚠${RESET} Timed out — check: cd ${installDir} && docker compose logs\n`);

    // ── Done ───────────────────────────────────────────
    const url = 'http://localhost:3000';
    stdout.write(`\n  ${GREEN}${BOLD}✨ lynox is running at ${url}${RESET}\n`);
    stdout.write(`     ${BOLD}Access token:${RESET} ${token}\n`);
    stdout.write(`     ${BOLD}Vault key:${RESET}    ${vaultKey}\n\n`);
    stdout.write(`  ${YELLOW}⚠${RESET}  Save both values in a password manager — the vault key\n`);
    stdout.write(`     encrypts your data. Without it, secrets cannot be recovered.\n\n`);
    stdout.write(`  ${DIM}Stop:    cd ${installDir} && docker compose down${RESET}\n`);
    stdout.write(`  ${DIM}Logs:    cd ${installDir} && docker compose logs -f${RESET}\n`);
    stdout.write(`  ${DIM}Update:  docker compose pull && docker compose up -d${RESET}\n\n`);
    stdout.write(`  ${YELLOW}Security:${RESET} lynox runs over HTTP by default.\n`);
    stdout.write(`  ${DIM}For remote access, use a reverse proxy (Caddy, nginx) with TLS.${RESET}\n`);
    stdout.write(`  ${DIM}Docs: https://docs.lynox.ai/integrations/remote-access/${RESET}\n\n`);

    // Open browser (best-effort)
    if (healthy) {
      try {
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open';
        execFileCb(cmd, [url], () => { /* ignore */ });
      } catch { /* best-effort */ }
    }

  } finally {
    try { rl.close(); } catch { /* already closed */ }
  }
}
