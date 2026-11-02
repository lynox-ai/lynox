/**
 * Interactive Docker Compose scaffolder.
 * `npx @lynox-ai/core` or `lynox init` creates a complete Docker setup
 * (docker-compose.yml, .env, SearXNG) and starts the containers.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stderr, stdin, stdout } from 'node:process';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { BOLD, DIM, GREEN, RED, YELLOW, RESET } from './ansi.js';
import { shapeRequestForModel } from '../core/llm-wire-rules.js';
import { confirm, readSecret, select } from './interactive.js';
import { renderGradientArt } from './ui.js';
import { writeFileAtomicSync } from '../core/atomic-write.js';
import {
  IMAGE_IDS,
  chownFileToImage,
  dataOwnerOf,
  decideVaultKey,
  dockerModeFromSecurityOptions,
  freshDataDirProblem,
  tosMarkerPath,
  TOS_VERSION,
  handOverFreshDataDir,
  helperChownArgs,
  helperFailure,
  planRunAs,
  shellQuote,
  precheckDataDir,
  type DockerMode,
  type Ids,
} from './docker-run-as.js';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Terms-of-service acceptance
// ---------------------------------------------------------------------------


// `acceptFlag` is undefined in an interactive run (the user is asked) and the
// value of `--accept-terms` in a non-interactive one. Without the flag a
// non-interactive run stops here: acceptance must stay a deliberate act.
async function acceptTos(
  rl: ReturnType<typeof createInterface>,
  acceptFlag?: boolean,
): Promise<boolean> {
  const lynoxDir = join(homedir(), '.lynox');
  const flagPath = tosMarkerPath(lynoxDir);
  // A non-interactive run decides by its flag alone, so a marker from an
  // earlier run on this machine cannot stand in for it.
  if (acceptFlag === undefined && existsSync(flagPath)) return true;

  stdout.write(`\n  ${BOLD}Terms of Service${RESET}\n`);
  stdout.write(`  ${DIM}https://lynox.ai/terms${RESET}\n\n`);
  stdout.write(`  By continuing you accept the lynox terms of service\n`);
  stdout.write(`  (ELv2 license, no warranty, no support obligation for self-host).\n\n`);

  const ok = acceptFlag === undefined
    ? await confirm('Continue?', true, stdin.isTTY ? undefined : rl)
    : acceptFlag;
  if (acceptFlag === false) {
    stdout.write(`  ${RED}✗${RESET} lynox's terms of use (https://lynox.ai/terms) must be accepted first. Pass --accept-terms to accept them in a non-interactive run.\n`);
    return false;
  }
  if (acceptFlag === true) {
    stdout.write(`  ${GREEN}✓${RESET} Accepted with --accept-terms: https://lynox.ai/terms (terms version ${TOS_VERSION}).\n`);
  }
  if (!ok) {
    stdout.write(`  ${DIM}Cancelled — acceptance required to proceed.${RESET}\n`);
    return false;
  }

  try {
    mkdirSync(lynoxDir, { recursive: true, mode: 0o700 });
    writeFileAtomicSync(flagPath, `${new Date().toISOString()}\n`);
  } catch {
    // Non-fatal — the wizard proceeds even if the flag can't be persisted.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Non-interactive mode
// ---------------------------------------------------------------------------
//
// `--non-interactive` replaces every prompt with a flag or an environment
// variable, so the installer runs without a terminal (CI, a coding assistant).
// It is an explicit switch: a run without a TTY that pipes answers into the
// prompts keeps working as before. API keys are read from the environment
// only, never from a flag, so they stay out of shell history and `ps`.

export type InstallerProvider = 'anthropic' | 'mistral' | 'openai-compatible' | 'none';

export interface NonInteractiveOptions {
  acceptTerms: boolean;
  provider: InstallerProvider;
  dir: string;
  reconfigure: boolean;
  model?: string;
  baseUrl?: string;
}

export type InstallerArgs =
  | { nonInteractive: false }
  | { nonInteractive: true; options: NonInteractiveOptions };

const INSTALLER_PROVIDERS: readonly InstallerProvider[] = ['anthropic', 'mistral', 'openai-compatible', 'none'];
const VALUE_FLAGS = ['--provider', '--model', '--base-url', '--dir'] as const;
const SWITCH_FLAGS = ['--accept-terms', '--reconfigure'] as const;
// Read by src/index.ts before the installer runs (`--flag <value>` only); the
// installer passes over them and their value.
const ENGINE_VALUE_FLAGS = ['--project', '--data-dir'] as const;

export const NON_INTERACTIVE_USAGE = [
  'Non-interactive install:',
  '  npx @lynox-ai/core --non-interactive --accept-terms --provider <anthropic|mistral|openai-compatible|none>',
  '      [--model <id>] [--base-url <url>] [--dir <path>] [--reconfigure]',
  '  Keys come from the environment: ANTHROPIC_API_KEY, MISTRAL_API_KEY, OPENAI_API_KEY (optional).',
  '  --provider none starts lynox without a key; add one later in the Web UI.',
].join('\n');

/**
 * The command that repeats a non-interactive run on another port. Built from
 * the parsed options, not the raw arguments: a base URL can carry credentials,
 * so it is left as a placeholder.
 */
export function rerunCommand(o: NonInteractiveOptions, port: number): string {
  const parts = [`PORT=${String(port)}`, 'npx @lynox-ai/core', '--non-interactive'];
  if (o.acceptTerms) parts.push('--accept-terms');
  parts.push('--provider', o.provider);
  if (o.model !== undefined) parts.push('--model', shellQuote(o.model));
  if (o.baseUrl !== undefined) parts.push('--base-url', '<your base URL>');
  if (o.dir !== './lynox') parts.push('--dir', shellQuote(o.dir));
  if (o.reconfigure) parts.push('--reconfigure');
  return parts.join(' ');
}

/**
 * Reads the installer's own flags from the CLI arguments. Its flags are only
 * valid together with `--non-interactive`. An interactive run leaves every other
 * argument alone; a non-interactive one accepts only `init` / `--init` and the
 * engine's `--project` / `--data-dir` besides its flags, so a typo stops the
 * run instead of turning into a default.
 */
export function parseInstallerArgs(args: readonly string[]): InstallerArgs | { error: string } {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const unknown: string[] = [];
  let nonInteractive = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name === '--non-interactive' && eq === -1) { nonInteractive = true; continue; }
    if (arg === '--init' || arg === 'init') continue;
    if ((ENGINE_VALUE_FLAGS as readonly string[]).includes(arg)) { i++; continue; }
    if ((SWITCH_FLAGS as readonly string[]).includes(name)) {
      if (eq !== -1) return { error: `${name} takes no value.` };
      switches.add(name);
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        return { error: `${name} needs a value.` };
      }
      values.set(name, value);
      continue;
    }
    // Only something shaped like a flag name is ever echoed: a stray value may
    // be a key.
    unknown.push(/^--?[a-z]+(-[a-z]+)*$/i.test(name) && name.length <= 40 ? name
      : name.startsWith('-') ? 'an unknown flag' : 'a value without a flag');
  }

  if (!nonInteractive) {
    const stray = [...values.keys(), ...switches];
    if (stray.length > 0) {
      return { error: `${stray.join(', ')} only work together with --non-interactive. Add --non-interactive, or leave them out.` };
    }
    return { nonInteractive: false };
  }

  // Without a prompt to fall back on, a misspelt flag would silently become a
  // default (`--dri` installs into ./lynox), so anything unknown stops the run.
  if (unknown.length > 0) {
    return { error: `Unknown argument${unknown.length > 1 ? 's' : ''}: ${[...new Set(unknown)].join(', ')}.` };
  }

  const provider = values.get('--provider');
  if (provider === undefined) {
    return { error: '--provider is required: anthropic, mistral, openai-compatible, or none (start without a key).' };
  }
  if (!(INSTALLER_PROVIDERS as readonly string[]).includes(provider)) {
    // The value is not echoed: a key pasted into the wrong place would land in the log.
    return { error: 'Unknown --provider. Use anthropic, mistral, openai-compatible, or none.' };
  }
  const chosen = provider as InstallerProvider;
  const model = values.get('--model');
  const baseUrl = values.get('--base-url');
  if (model !== undefined && chosen !== 'mistral' && chosen !== 'openai-compatible') {
    return { error: '--model only applies to --provider mistral or openai-compatible.' };
  }
  if (baseUrl !== undefined) {
    if (chosen !== 'openai-compatible') {
      return { error: '--base-url only applies to --provider openai-compatible.' };
    }
    // `new URL('localhost:11434')` parses, with `localhost:` as the scheme, so
    // the scheme is checked explicitly.
    let protocol = '';
    try {
      protocol = new URL(baseUrl).protocol;
    } catch { /* reported below */ }
    if (protocol !== 'http:' && protocol !== 'https:') {
      // The value is not echoed: a URL can carry credentials.
      return { error: '--base-url is not a valid URL. Include the scheme (http:// or https://).' };
    }
  }

  const options: NonInteractiveOptions = {
    acceptTerms: switches.has('--accept-terms'),
    provider: chosen,
    dir: values.get('--dir') ?? './lynox',
    reconfigure: switches.has('--reconfigure'),
  };
  if (model !== undefined) options.model = model;
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  return { nonInteractive: true, options };
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
    // Output is `Docker Compose version v2.x.y` — anchor on the literal so we
    // don't pick up the `v` in `version` itself (which would print
    // "Compose ersion" — caught during HN-launch self-host E2E).
    const ver = cv.trim().match(/Docker Compose version v?([^\s]+)/)?.[1] ?? 'unknown';
    stdout.write(`  ${GREEN}✓${RESET} Compose ${ver}\n`);
  } catch {
    stdout.write(`  ${RED}✗${RESET} Docker Compose not found.\n`);
    stdout.write(`  ${DIM}Install: https://docs.docker.com/compose/install/${RESET}\n`);
    return false;
  }

  return true;
}

/**
 * Rootful or rootless, from the daemon itself. Any failure counts as rootful,
 * the mode in which no container is ever started as uid 0.
 */
export async function detectDockerMode(
  exec: (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }> = execFileAsync,
): Promise<DockerMode> {
  try {
    const { stdout: raw } = await exec('docker', ['info', '--format', '{{json .SecurityOptions}}'], { timeout: 10_000 });
    return dockerModeFromSecurityOptions(raw.trim());
  } catch {
    return 'rootful';
  }
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
      body: JSON.stringify(shapeRequestForModel({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }).params),
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

// Generic OpenAI-compatible key validation — hits GET <baseUrl>/models with
// Bearer auth, which is the universal probe across Mistral, OpenAI, Groq,
// vLLM, LM Studio, Ollama, etc. Cheap (no token spend) and short-circuits
// on the same 3-state contract as validateAnthropicKey.
//
// `providerLabel` only feeds the user-facing error string ("Could not reach
// Mistral API" vs "Could not reach OpenAI-compatible endpoint"), so the same
// function backs both `validateMistralKey` and the engine-side
// `POST /api/secrets/validate-key` endpoint that SetupBanner uses pre-save
// to block typo'd keys from silently ending up in the vault.
export async function validateOpenAICompatKey(
  key: string,
  baseUrl: string,
  providerLabel = 'OpenAI-compatible endpoint',
  // Injectable fetch so a server-side caller with a USER-supplied baseUrl can
  // pass an SSRF-safe transport (network-guard's fetchWithPublicRedirects:
  // pins the resolved IP + re-validates each redirect hop). Defaults to global
  // fetch for the CLI installer + the fixed-URL Mistral validator.
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<KeyValidation> {
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { state: 'valid' };
    if (res.status === 401 || res.status === 403) return { state: 'invalid', error: 'Invalid API key' };
    if (res.status === 429) return { state: 'invalid', error: 'Rate limited — try again in a moment' };
    return { state: 'network-error', error: `${providerLabel} responded ${String(res.status)}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { state: 'network-error', error: `Could not reach ${providerLabel} (${msg})` };
  }
}

// Mistral key validation — mirrors validateAnthropicKey shape via
// validateOpenAICompatKey. Hits the cheap GET /v1/models endpoint instead
// of POST /v1/chat/completions so we don't burn a token quota on every
// installer run.
export async function validateMistralKey(key: string): Promise<KeyValidation> {
  return validateOpenAICompatKey(key, 'https://api.mistral.ai/v1', 'Mistral API');
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
  // The last non-empty value wins, as in an env file: the copy command a
  // refusal prints appends a line, and an empty `LYNOX_VAULT_KEY=` above it
  // must not hide it.
  let key: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^LYNOX_VAULT_KEY=(.*)$/.exec(line);
    if (m) {
      const value = (m[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
      if (value) key = value;
    }
  }
  return key;
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

// Non-interactive counterpart of collectAnthropicKey / collectMistralKey: the
// key comes from the environment, gets one validation, and a missing or
// rejected key ends the run with the reason instead of a prompt.
async function keyFromEnv(
  envName: string,
  validate: (key: string) => Promise<KeyValidation>,
  formatError?: (key: string) => string | null,
): Promise<string | null> {
  const key = (process.env[envName] ?? '').trim();
  if (!key) {
    stdout.write(`  ${RED}✗${RESET} Set ${envName} in the environment, or use --provider none to start without a key.\n`);
    return null;
  }
  const bad = formatError?.(key);
  if (bad) {
    stdout.write(`  ${RED}✗${RESET} ${envName}: ${bad}\n`);
    return null;
  }
  const result = await validate(key);
  if (result.state === 'invalid') {
    stdout.write(`  ${RED}✗${RESET} ${envName}: ${result.error}.\n`);
    return null;
  }
  if (result.state === 'network-error') {
    stdout.write(`  ${YELLOW}⚠${RESET} ${result.error} — proceeding without verification.\n`);
    return key;
  }
  stdout.write(`  ${GREEN}✓${RESET} ${envName} verified.\n`);
  return key;
}

// ---------------------------------------------------------------------------
// Health check polling
// ---------------------------------------------------------------------------

export const HEALTH_TIMEOUT_MS = 60_000;

export async function pollHealth(
  port: number,
  timeoutMs: number,
  opts: { fetchImpl?: typeof fetch; intervalMs?: number } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://localhost:${String(port)}/api/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// What the installer prints once the containers are up
// ---------------------------------------------------------------------------

export interface StartupFacts {
  healthy: boolean;
  nonInteractive: boolean;
  url: string;
  installDir: string;
  token: string;
  vaultKey: string;
  vaultKeyReused: boolean;
  /** Where a reused vault key was read from. */
  vaultKeyFrom?: string;
  recoveryWritten: boolean;
  recoveryEnvPath: string;
}

/**
 * The closing report. A run whose health check timed out must not read as a
 * success: it says so, names the command that shows why, and ends with exit
 * code 1. A non-interactive run names the files that hold the access token and
 * the vault key instead of printing them, because its output usually lands in
 * a CI or agent log.
 */
export function startupReport(f: StartupFacts): { text: string; exitCode: 0 | 1 } {
  const out: string[] = [];
  if (f.healthy) {
    out.push(`\n  ${GREEN}${BOLD}✨ lynox is running at ${f.url}${RESET}\n`);
  } else {
    out.push(`\n  ${RED}${BOLD}✗ lynox did not become healthy within ${String(HEALTH_TIMEOUT_MS / 1000)} s.${RESET}\n`);
    out.push(`     The containers were started, but ${f.url}/api/health did not answer.\n`);
    out.push(`     See why: ${BOLD}cd ${f.installDir} && docker compose logs lynox${RESET}\n`);
  }
  if (f.nonInteractive) {
    out.push(`     ${BOLD}Access token:${RESET} LYNOX_HTTP_SECRET in ${join(f.installDir, '.env')}\n`);
    out.push(`     ${BOLD}Vault key:${RESET}    LYNOX_VAULT_KEY in ${join(f.installDir, '.env')}${f.vaultKeyReused ? `  ${DIM}(reused)${RESET}` : ''}\n`);
  } else {
    out.push(`     ${BOLD}Access token:${RESET} ${f.token}\n`);
    out.push(`     ${BOLD}Vault key:${RESET}    ${f.vaultKey}${f.vaultKeyReused ? `  ${DIM}(reused)${RESET}` : ''}\n`);
  }
  if (f.recoveryWritten) {
    out.push(`     ${DIM}Vault key recovery copy saved to ${f.recoveryEnvPath} (mode 0600).${RESET}\n`);
    out.push(`     ${DIM}Keep this file backed up — it survives compose-dir deletion.${RESET}\n`);
  } else if (f.vaultKeyFrom !== undefined) {
    out.push(`     ${DIM}Taken from ${f.vaultKeyFrom}.${RESET}\n`);
  }
  out.push(`\n  ${YELLOW}⚠${RESET}  Save both values in a password manager — the vault key\n`);
  out.push(`     encrypts your data. Without it, secrets cannot be recovered.\n\n`);
  out.push(`  ${DIM}Stop:    cd ${f.installDir} && docker compose down${RESET}\n`);
  out.push(`  ${DIM}Logs:    cd ${f.installDir} && docker compose logs -f${RESET}\n`);
  out.push(`  ${DIM}Update:  docker compose pull && docker compose up -d${RESET}\n\n`);
  out.push(`  ${YELLOW}Security:${RESET} lynox runs over HTTP by default.\n`);
  out.push(`  ${DIM}For remote access, use a reverse proxy (Caddy, nginx) with TLS.${RESET}\n`);
  out.push(`  ${DIM}Docs: https://docs.lynox.ai/integrations/remote-access/${RESET}\n\n`);
  return { text: out.join(''), exitCode: f.healthy ? 0 : 1 };
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
//
// `runAs` sets each container's `user:` (see `docker-run-as.ts` for why and
// which ids). Without it the engine runs as the image's own user and SearXNG
// as the image's default, as before. `HOME` is set because an id the image has
// no passwd entry for would otherwise get `/` as its home.
export function buildComposeFile(
  hostPort: number = 3000,
  runAs?: { readonly engine: Ids; readonly search: Ids | null },
): string {
  const engine = runAs?.engine ?? IMAGE_IDS;
  const engineIds = `${String(engine.uid)}:${String(engine.gid)}`;
  const searchUser = runAs?.search
    ? `\n    user: "${String(runAs.search.uid)}:${String(runAs.search.gid)}"`
    : '';
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
    user: "${engineIds}"
    ports:
      - "${String(hostPort)}:3000"
    tmpfs:
      - /tmp:size=512M
      - /workspace:size=256M,uid=${String(engine.uid)},gid=${String(engine.gid)}
      # ONNX embedding cache for the Knowledge Graph (Xenova/transformers.js).
      # Without this writable tmpfs the read_only root filesystem rejects the
      # subdirectory \`mkdir\` and every web-research call spams the engine
      # log with ENOENT.
      - /home/lynox/.cache:size=512M,uid=${String(engine.uid)},gid=${String(engine.gid)}
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges
    pids_limit: 512
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3
    env_file: .env
    environment:
      - HOME=/home/lynox
      - SEARXNG_URL=http://searxng:8080
    # Long form so a missing ~/.lynox fails the start loudly: the short form
    # lets the daemon create it, owned by root, which only sudo can repair.
    volumes:
      - type: bind
        source: \${HOME}/.lynox
        target: /home/lynox/.lynox
        bind:
          create_host_path: false
    networks:
      - internal

  searxng:
    image: searxng/searxng:latest
    restart: unless-stopped
    read_only: true${searchUser}
    tmpfs:
      - /tmp:size=64M
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges
    pids_limit: 128
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "2"
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
    networks:
      - internal

# Not \`internal: true\` — outbound stays open, the engine needs it for the LLM
# API. What this buys is opt-in membership: a service added below without a
# \`networks:\` key lands on Compose's implicit \`default\` network and gets no
# route to SearXNG, which runs with \`limiter: false\`.
networks:
  internal:
    driver: bridge
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

export async function runDockerInstaller(args: readonly string[] = []): Promise<void> {
  const parsed = parseInstallerArgs(args);
  if ('error' in parsed) {
    stderr.write(`  ${RED}✗${RESET} ${parsed.error}\n\n${NON_INTERACTIVE_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  // A non-interactive run counts as failed until it reaches a healthy end, so
  // every early `return` below exits non-zero without being touched one by one.
  const ni = parsed.nonInteractive ? parsed.options : undefined;
  let succeeded = false;

  // A non-interactive run never reads stdin, so it gets an empty input: readline
  // on a terminal would otherwise swallow Ctrl+C instead of ending the run.
  const rl = ni
    ? createInterface({ input: Readable.from([]), output: stdout, terminal: false })
    : createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });

  try {
    stdout.write('\n' + renderGradientArt());
    stdout.write(`  ${BOLD}Install${RESET}  ${DIM}Docker setup in one command.${RESET}\n\n`);

    // ── ToS acceptance ─────────────────────────────────
    if (!(await acceptTos(rl, ni?.acceptTerms))) return;

    // ── Docker check ───────────────────────────────────
    const ok = await checkDocker();
    if (!ok) return;

    // ── Install directory ──────────────────────────────
    const dirInput = ni
      ? ni.dir
      : await rl.question(`\n  ${BOLD}Directory${RESET} ${DIM}(./lynox)${RESET}: `);
    const installDir = resolve(dirInput.trim() || './lynox');

    if (existsSync(join(installDir, 'docker-compose.yml'))) {
      if (ni && !ni.reconfigure) {
        stdout.write(`  ${RED}✗${RESET} ${installDir} already holds a setup. Pass --reconfigure to set it up again. The vault key of existing data is kept; the access token is replaced unless LYNOX_HTTP_SECRET is set.\n`);
        return;
      }
      const overwrite = ni
        ? true
        : await confirm('Existing setup found. Reconfigure?', false, stdin.isTTY ? undefined : rl);
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
    // shows). Vertex is no longer offered at install time; its engine code
    // path remains, but the image this installer sets up does not include
    // the optional package it needs, so it cannot run there.
    stdout.write(`\n  ${BOLD}LLM Provider${RESET}\n`);
    stdout.write(`  ${DIM}Where should AI requests be sent?${RESET}\n\n`);

    // `none` exists only in a non-interactive run (`--provider none`): no LLM
    // settings are written, and lynox starts in browse mode until a key is
    // added in the Web UI's setup wizard.
    type ProviderChoice = 'anthropic' | 'mistral' | 'custom' | 'none';
    const provider: ProviderChoice = ni
      ? (ni.provider === 'openai-compatible' ? 'custom' : ni.provider)
      : await select<ProviderChoice>([
        { label: 'Claude (Anthropic)', value: 'anthropic', hint: 'recommended — tested' },
        { label: 'Mistral', value: 'mistral', hint: 'Paris, EU — tested' },
        { label: 'OpenAI-compatible', value: 'custom', hint: 'Ollama / LM Studio / Groq / LiteLLM / vLLM — experimental' },
      ], { default: 0, rl: stdin.isTTY ? undefined : rl }) ?? 'anthropic';

    // ── Provider-specific input ────────────────────────
    const envVars: Record<string, string> = {};

    if (provider === 'none') {
      stdout.write(`  ${GREEN}✓${RESET} No provider key — lynox starts in browse mode; add a key in the Web UI's setup wizard.\n`);

    } else if (provider === 'anthropic') {
      stdout.write(`\n  ${BOLD}API Key${RESET}  ${DIM}console.anthropic.com → API Keys${RESET}\n`);
      const key = ni
        ? await keyFromEnv('ANTHROPIC_API_KEY', validateAnthropicKey,
          k => (k.startsWith('sk-') && k.length >= 20 ? null : 'should start with "sk-" and be 20+ characters.'))
        : await collectAnthropicKey(rl);
      if (!key) return;
      envVars['ANTHROPIC_API_KEY'] = key;

    } else if (provider === 'mistral') {
      // Mistral routes through the engine's OpenAI-compatible adapter (same
      // wire shape as openai/custom); the user-facing label stays "Mistral"
      // so the model + endpoint defaults are pre-filled.
      envVars['LYNOX_LLM_PROVIDER'] = 'openai';
      envVars['ANTHROPIC_BASE_URL'] = 'https://api.mistral.ai/v1';

      stdout.write(`\n  ${BOLD}Mistral${RESET}  ${DIM}console.mistral.ai → API Keys${RESET}\n`);

      const modelChoice = ni
        ? (ni.model ?? 'mistral-medium-2604')
        : await select([
          { label: 'mistral-medium-2604', value: 'mistral-medium-2604', hint: 'recommended — Medium 3.5, current' },
          { label: 'ministral-14b-2512', value: 'ministral-14b-2512', hint: 'balanced cost/quality' },
          { label: 'ministral-8b-2512', value: 'ministral-8b-2512', hint: 'low-cost orchestration' },
          { label: 'mistral-large-2512', value: 'mistral-large-2512', hint: 'Large 3 — legacy' },
          { label: 'codestral-2508', value: 'codestral-2508', hint: 'code-focused' },
        ], { default: 0, rl: stdin.isTTY ? undefined : rl }) ?? 'mistral-medium-2604';
      envVars['OPENAI_MODEL_ID'] = modelChoice;
      stdout.write(`  ${GREEN}✓${RESET} Model: ${modelChoice}\n`);

      const apiKey = ni
        ? await keyFromEnv('MISTRAL_API_KEY', validateMistralKey)
        : await collectMistralKey(rl);
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
      const preset: PresetChoice = ni
        ? 'ollama'
        : await select<PresetChoice>([
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
        // parseInstallerArgs already rejected an unparsable --base-url.
        const urlInput = ni
          ? (ni.baseUrl ?? '')
          : (await rl.question(
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

      const modelInput = ni
        ? (ni.model ?? '')
        : (await rl.question(
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
      const apiKeyInput = ni
        ? (process.env['OPENAI_API_KEY'] ?? '').trim()
        : (await readSecret(
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
      // A non-interactive run cannot pick another port; it stops with the
      // PORT hint below.
      const useAlt = ni
        ? false
        : await confirm(
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
        if (await isPortInUse(hostPort)) {
          stdout.write(`  ${RED}✗${RESET} No free port chosen. Stop the conflicting process, or rerun with PORT set to a free port.\n`);
          process.exitCode = 1;
          return;
        }
      } else {
        // User chose not to pick an alternative — surface the actionable hint
        // and stop. Empty `docker compose logs` after a port collision was
        // the silent-failure mode this whole branch fixes (item 17).
        stdout.write(`  ${DIM}Either stop the conflicting process, or rerun with:${RESET}\n`);
        const nextPort = hostPort < 65535 ? hostPort + 1 : 3001;
        stdout.write(`  ${DIM}  ${ni ? rerunCommand(ni, nextPort) : `PORT=${String(nextPort)} npx @lynox-ai/core`}${RESET}\n`);
        process.exitCode = 1;
        return;
      }
    }

    // ── Access token ───────────────────────────────────
    const tokenInput = ni
      ? (process.env['LYNOX_HTTP_SECRET'] ?? '').trim()
      : (await rl.question(`\n  ${BOLD}Access token${RESET} ${DIM}(blank = auto-generate)${RESET}: `)).trim();
    const token = tokenInput || randomBytes(32).toString('hex');
    envVars['LYNOX_HTTP_SECRET'] = token;

    // One-time onboarding token enables `?token=` auto-login on the first
    // browser open (item 22). The login page consumes it via
    // `.onboarding-consumed` so re-visiting the URL from shell history is
    // a no-op (no replay).
    const onboardingToken = randomBytes(32).toString('hex');
    envVars['LYNOX_ONBOARDING_TOKEN'] = onboardingToken;

    // SvelteKit (adapter-node) defaults the request URL protocol to https when
    // ORIGIN env is unset, which makes the CSRF Origin check reject every POST
    // form submission from an http://localhost browser as cross-site (401/403
    // "Cross-site POST form submissions are forbidden"). The /login token form
    // is the user-facing path that hits this. Setting ORIGIN to the actual
    // bind URL keeps url.origin aligned with the browser's Origin header.
    envVars['ORIGIN'] = `http://localhost:${String(hostPort)}`;

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

    // ── Which user the containers run as ───────────────
    // The data dir and SearXNG's settings belong to whoever runs this, and the
    // containers have to read and write them (docker-run-as.ts). Native Linux
    // only: Docker Desktop on macOS and Windows maps ownership on its own, so
    // the compose file stays as it was there. Everything up to the file
    // writes below decides or refuses, so the previous compose setup stays as
    // it was. The one write before a possible refusal is a new vault key's
    // recovery copy, which the next run reuses.
    const dataDir = join(homedir(), '.lynox');
    const installEnvPath = join(installDir, '.env');
    let runAs: { engine: Ids; search: Ids | null } | undefined;
    let chown: 'none' | 'direct' | 'helper' = 'none';
    let asRoot = false;
    let hostIds: Ids | undefined;
    let dockerMode: DockerMode = 'rootful';
    // Every refusal below ends the run with exit 1, so a script that runs the installer sees it.
    // A command is printed only where one fixes it; otherwise the reason names the step.
    const refuse = (reason: string, command: string | null = null, note?: string): void => {
      stdout.write(`\n  ${RED}✗${RESET} ${reason}\n`);
      if (command !== null) {
        stdout.write(`  ${DIM}Fix it once, then run this again:${RESET}\n`);
        stdout.write(`  ${DIM}  ${command}${RESET}\n`);
        if (note !== undefined) stdout.write(`  ${DIM}${note}${RESET}\n`);
      }
      process.exitCode = 1;
    };
    if (process.platform === 'linux' && typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      dockerMode = await detectDockerMode();
      hostIds = { uid: process.getuid(), gid: process.getgid() };
      const plan = planRunAs({ mode: dockerMode, host: hostIds, dataOwner: dataOwnerOf(dataDir), dataDir });
      if (plan.kind === 'refuse') {
        refuse(plan.reason, plan.command);
        return;
      }
      runAs = { engine: plan.engine, search: plan.search };
      chown = plan.chown;
      asRoot = hostIds.uid === 0;
      if (chown === 'direct') {
        // Installing as root: only a fresh data dir is handed over (see
        // freshDataDirProblem); the pre-check would judge it before that.
        const problem = freshDataDirProblem(dataDir, homedir());
        if (problem) {
          refuse(problem.reason, problem.command);
          return;
        }
      } else {
        const blocked = precheckDataDir({ mode: dockerMode, host: hostIds, engine: runAs.engine, dataDir });
        if (blocked) {
          refuse(blocked.reason, blocked.command);
          return;
        }
      }
    }

    // ── Vault key (item 20) ────────────────────────────
    // The vault key has a single source of truth at ~/.lynox/.env so a user
    // who deletes the compose dir and re-runs `npx` keeps decryption working.
    // A new key is made only when no vault can exist yet (decideVaultKey);
    // once the data dir belongs to the container's user, this user may no
    // longer read it, and the install dir's own .env is the other copy.
    let listable = true;
    try {
      readdirSync(dataDir);
    } catch {
      listable = false;
    }
    const vaultDecision = decideVaultKey({
      mode: dockerMode,
      dataDir,
      installEnv: installEnvPath,
      recoveryKey: readVaultKeyFromRecoveryFile(join(dataDir, '.env')),
      installKey: readVaultKeyFromRecoveryFile(installEnvPath),
      listable,
      vaultExists: listable && readdirSync(dataDir).some((name) => name.endsWith('.db')),
    });
    if (vaultDecision.kind === 'refuse') {
      refuse(vaultDecision.reason, vaultDecision.command, 'The command copies the key without printing it.');
      return;
    }
    const recoveryEnvPath = join(dataDir, '.env');
    let vaultKey: string;
    let vaultKeyReused = false;
    let recoveryWritten = false;
    if (vaultDecision.kind === 'reuse') {
      vaultKey = vaultDecision.key;
      vaultKeyReused = true;
      stdout.write(`  ${GREEN}✓${RESET} Reusing existing vault key from ${vaultDecision.from} (preserves prior data).\n`);
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

    // ── Hand the data dir to the container's user ──────
    // After the recovery copy, so it is handed over too. Installing as root:
    // directly. Rootless Docker: through a pinned helper container, because
    // only root inside a rootless container can re-own to its subordinate ids.
    if (chown === 'direct') {
      try {
        handOverFreshDataDir(dataDir, homedir());
      } catch (err: unknown) {
        refuse(err instanceof Error ? err.message : String(err));
        return;
      }
    } else if (chown === 'helper' && hostIds) {
      let args: string[];
      try {
        args = helperChownArgs(dataDir);
      } catch (err: unknown) {
        refuse(err instanceof Error ? err.message : String(err));
        return;
      }
      try {
        await execFileAsync('docker', args, { timeout: 300_000 });
      } catch (err: unknown) {
        const stderr = typeof (err as { stderr?: unknown }).stderr === 'string'
          ? (err as { stderr: string }).stderr
          : (err instanceof Error ? err.message : String(err));
        const failure = helperFailure(stderr, hostIds, dataDir);
        refuse(failure.reason, failure.command);
        return;
      }
    }

    // Done with interactive input
    rl.close();

    // ── Generate files ─────────────────────────────────
    writeFileAtomicSync(join(installDir, 'docker-compose.yml'), buildComposeFile(hostPort, runAs));
    writeFileAtomicSync(installEnvPath, generateEnvFile(envVars));
    writeFileAtomicSync(join(installDir, 'searxng', 'settings.yml'), generateSearxngSettings());
    writeFileAtomicSync(join(installDir, '.gitignore'), '.env\n');

    // SearXNG runs as the image's user too when installing as root.
    if (asRoot) {
      try {
        chownFileToImage(join(installDir, 'searxng', 'settings.yml'));
      } catch (err: unknown) {
        refuse(err instanceof Error ? err.message : String(err));
        return;
      }
    }

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
      process.exitCode = 1;
      return;
    }

    // ── Health check ───────────────────────────────────
    stdout.write(`\n  ${DIM}Waiting for health check...${RESET}`);
    const healthy = await pollHealth(hostPort, HEALTH_TIMEOUT_MS);
    stdout.write(healthy
      ? `\r  ${GREEN}✓${RESET} Healthy.                    \n`
      : `\r  ${RED}✗${RESET} Timed out.                  \n`);

    // ── Done ───────────────────────────────────────────
    const url = `http://localhost:${String(hostPort)}`;
    // Auto-login URL (item 22) — single-use token consumed server-side on
    // first hit. After consumption the bare URL still works (operator just
    // logs in normally). Token in shell history is noted below.
    const loginUrl = `${url}/login?token=${encodeURIComponent(onboardingToken)}`;
    const report = startupReport({
      healthy,
      nonInteractive: ni !== undefined,
      url,
      installDir,
      token,
      vaultKey,
      vaultKeyReused,
      ...(vaultDecision.kind === 'reuse' ? { vaultKeyFrom: vaultDecision.from } : {}),
      recoveryWritten,
      recoveryEnvPath,
    });
    stdout.write(report.text);
    process.exitCode = report.exitCode;
    succeeded = healthy;

    // Open browser (best-effort) with one-time auto-login token (item 22).
    // Not in a non-interactive run: there is usually nobody at a browser.
    if (healthy && !ni) {
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
    if (ni && !succeeded && !process.exitCode) process.exitCode = 1;
  }
}
