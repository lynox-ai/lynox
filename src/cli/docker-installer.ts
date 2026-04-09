/**
 * Interactive Docker Compose scaffolder.
 * `npx @lynox-ai/core` or `lynox init` creates a complete Docker setup
 * (docker-compose.yml, .env, SearXNG) and starts the containers.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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

function generateSearxngSettings(): string {
  const secretKey = randomBytes(32).toString('base64');
  return `# SearXNG for lynox — generated by npx @lynox-ai/core

use_default_settings:
  engines:
    keep_only:
      - google
      - duckduckgo
      - bing
      - wikipedia
      - wikidata
      - currency
      - google news
      - duckduckgo news
      - bing news
      - google scholar
      - semantic scholar
      - arxiv
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
    stdout.write(`\n  ${BOLD}LLM Provider${RESET}\n`);
    stdout.write(`  ${DIM}Where should AI requests be sent?${RESET}\n\n`);

    type ProviderChoice = 'anthropic' | 'bedrock' | 'custom';
    const provider = await select<ProviderChoice>([
      { label: 'Claude (Anthropic)', value: 'anthropic', hint: 'recommended' },
      { label: 'Claude (AWS Bedrock)', value: 'bedrock', hint: 'EU data residency' },
      { label: 'Custom Proxy', value: 'custom', hint: 'experimental' },
    ], { default: 0, rl: stdin.isTTY ? undefined : rl }) ?? 'anthropic';

    // ── Provider-specific input ────────────────────────
    const envVars: Record<string, string> = {};

    if (provider === 'anthropic') {
      stdout.write(`\n  ${BOLD}API Key${RESET}  ${DIM}console.anthropic.com → API Keys${RESET}\n`);
      const key = await collectAnthropicKey(rl);
      if (!key) return;
      envVars['ANTHROPIC_API_KEY'] = key;

    } else if (provider === 'bedrock') {
      envVars['LYNOX_LLM_PROVIDER'] = 'bedrock';
      stdout.write(`\n  ${BOLD}AWS Bedrock${RESET}\n`);

      const region = await select([
        { label: 'eu-central-1 (Frankfurt)', value: 'eu-central-1' },
        { label: 'eu-west-1 (Ireland)', value: 'eu-west-1' },
        { label: 'us-east-1 (N. Virginia)', value: 'us-east-1' },
        { label: 'us-west-2 (Oregon)', value: 'us-west-2' },
      ], { default: 0, rl: stdin.isTTY ? undefined : rl }) ?? 'eu-central-1';
      envVars['AWS_REGION'] = region;
      stdout.write(`  ${GREEN}✓${RESET} Region: ${region}\n`);

      const accessKey = (await rl.question(`  ${BOLD}AWS Access Key ID:${RESET} `)).trim();
      if (accessKey) envVars['AWS_ACCESS_KEY_ID'] = accessKey;
      else stdout.write(`  ${YELLOW}⚠${RESET} Set AWS_ACCESS_KEY_ID in .env before starting.\n`);

      const secretKey = await readSecret(`${BOLD}AWS Secret Access Key:${RESET}`, stdin.isTTY ? undefined : rl);
      if (secretKey) envVars['AWS_SECRET_ACCESS_KEY'] = secretKey;
      else stdout.write(`  ${YELLOW}⚠${RESET} Set AWS_SECRET_ACCESS_KEY in .env before starting.\n`);

    } else {
      envVars['LYNOX_LLM_PROVIDER'] = 'custom';
      stdout.write(`\n  ${BOLD}Custom Proxy${RESET} ${DIM}(Anthropic-compatible)${RESET}\n`);

      const proxyUrl = (await rl.question(`  ${BOLD}Proxy URL${RESET} ${DIM}(http://localhost:4000)${RESET}: `)).trim();
      envVars['ANTHROPIC_BASE_URL'] = proxyUrl || 'http://localhost:4000';
      stdout.write(`  ${GREEN}✓${RESET} URL: ${envVars['ANTHROPIC_BASE_URL']}\n`);

      const apiKey = await readSecret(`${BOLD}API Key (optional):${RESET}`, stdin.isTTY ? undefined : rl);
      if (apiKey) envVars['ANTHROPIC_API_KEY'] = apiKey;
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
    stdout.write(`  ${DIM}Docs: https://docs.lynox.ai/getting-started/reverse-proxy${RESET}\n\n`);

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
