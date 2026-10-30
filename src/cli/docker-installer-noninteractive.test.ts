// Non-interactive installer: flag parsing, the health-wait bound, the closing
// report, and the exit codes a script or coding assistant relies on.
//
// The full runDockerInstaller() flow needs Docker. What is tested here is every
// piece that decides the outcome without it: parseInstallerArgs, pollHealth
// (its timeout is actually tripped, not just configured), startupReport, the
// early exits before Docker is touched, and the refusals after the Docker check,
// run against a stand-in `docker` on PATH that logs every call.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HEALTH_TIMEOUT_MS,
  parseInstallerArgs,
  pollHealth,
  runDockerInstaller,
  startupReport,
  type StartupFacts,
} from './docker-installer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('parseInstallerArgs', () => {
  it('leaves an interactive run alone, whatever else is on the command line', () => {
    expect(parseInstallerArgs([])).toEqual({ nonInteractive: false });
    expect(parseInstallerArgs(['init'])).toEqual({ nonInteractive: false });
    expect(parseInstallerArgs(['--init', '--project', '/x'])).toEqual({ nonInteractive: false });
  });

  it('refuses installer flags without --non-interactive instead of ignoring them', () => {
    const r = parseInstallerArgs(['--provider', 'none', '--accept-terms']);
    expect(r).toEqual({ error: '--provider, --accept-terms only work together with --non-interactive.' });
  });

  it('requires --provider and names `none` as the way to start without a key', () => {
    const r = parseInstallerArgs(['--non-interactive', '--accept-terms']);
    expect('error' in r && r.error).toContain('--provider is required');
    expect('error' in r && r.error).toContain('none (start without a key)');
  });

  it('rejects an unknown provider', () => {
    const r = parseInstallerArgs(['--non-interactive', '--provider', 'vertex']);
    expect(r).toEqual({ error: 'Unknown --provider "vertex". Use anthropic, mistral, openai-compatible, or none.' });
  });

  it('reads the defaults for a keyless install', () => {
    expect(parseInstallerArgs(['--non-interactive', '--accept-terms', '--provider', 'none'])).toEqual({
      nonInteractive: true,
      options: { acceptTerms: true, provider: 'none', dir: './lynox', reconfigure: false },
    });
  });

  it('records a missing --accept-terms as false rather than failing the parse', () => {
    const r = parseInstallerArgs(['--non-interactive', '--provider', 'none']);
    expect(r).toEqual({
      nonInteractive: true,
      options: { acceptTerms: false, provider: 'none', dir: './lynox', reconfigure: false },
    });
  });

  it('accepts both `--flag value` and `--flag=value`', () => {
    const r = parseInstallerArgs([
      '--non-interactive', '--provider=openai-compatible', '--model', 'qwen2.5',
      '--base-url=http://host.docker.internal:1234/v1', '--dir', '/srv/lynox', '--reconfigure',
    ]);
    expect(r).toEqual({
      nonInteractive: true,
      options: {
        acceptTerms: false,
        provider: 'openai-compatible',
        dir: '/srv/lynox',
        reconfigure: true,
        model: 'qwen2.5',
        baseUrl: 'http://host.docker.internal:1234/v1',
      },
    });
  });

  it('takes --model for mistral', () => {
    const r = parseInstallerArgs(['--non-interactive', '--provider', 'mistral', '--model', 'ministral-8b-2512']);
    expect('options' in r && r.options.model).toBe('ministral-8b-2512');
  });

  it('rejects --model and --base-url where the provider does not use them', () => {
    expect(parseInstallerArgs(['--non-interactive', '--provider', 'anthropic', '--model', 'x']))
      .toEqual({ error: '--model only applies to --provider mistral or openai-compatible.' });
    expect(parseInstallerArgs(['--non-interactive', '--provider', 'none', '--model', 'x']))
      .toEqual({ error: '--model only applies to --provider mistral or openai-compatible.' });
    expect(parseInstallerArgs(['--non-interactive', '--provider', 'mistral', '--base-url', 'https://a.b/v1']))
      .toEqual({ error: '--base-url only applies to --provider openai-compatible.' });
  });

  it('rejects a base URL without a scheme', () => {
    const r = parseInstallerArgs(['--non-interactive', '--provider', 'openai-compatible', '--base-url', 'localhost:11434']);
    expect('error' in r && r.error).toContain('is not a valid URL');
  });

  it('refuses a value flag with no value, or with the next flag in its place', () => {
    expect(parseInstallerArgs(['--non-interactive', '--provider']))
      .toEqual({ error: '--provider needs a value.' });
    expect(parseInstallerArgs(['--non-interactive', '--provider', '--accept-terms']))
      .toEqual({ error: '--provider needs a value.' });
    expect(parseInstallerArgs(['--non-interactive', '--provider=']))
      .toEqual({ error: '--provider needs a value.' });
  });

  it('stops on an unknown argument instead of falling back to a default', () => {
    expect(parseInstallerArgs(['--non-interactive', '--accept-terms', '--provider', 'none', '--dri', '/srv/x']))
      .toEqual({ error: 'Unknown arguments: --dri, a value without a flag.' });
    expect(parseInstallerArgs(['--non-interactive', '--provider', 'mistral', '--modle=x']))
      .toEqual({ error: 'Unknown argument: --modle.' });
  });

  it('keeps the installer entry words and never echoes a stray value, which may be a key', () => {
    expect(parseInstallerArgs(['init', '--non-interactive', '--init', '--provider', 'none']))
      .toEqual({ nonInteractive: true, options: { acceptTerms: false, provider: 'none', dir: './lynox', reconfigure: false } });
    const secret = `sk-${randomBytes(12).toString('hex')}`;
    const r = parseInstallerArgs(['--non-interactive', '--provider', 'none', `--api-key=${secret}`, secret]);
    expect('error' in r && r.error).toBe('Unknown arguments: --api-key, a value without a flag.');
  });

  it('does not echo a base URL it rejects, since a URL can carry credentials', () => {
    const r = parseInstallerArgs(['--non-interactive', '--provider', 'openai-compatible', '--base-url', 'user:pw@host']);
    expect('error' in r && r.error).not.toContain('pw');
  });

  it('refuses a value on a switch', () => {
    expect(parseInstallerArgs(['--non-interactive', '--accept-terms=yes', '--provider', 'none']))
      .toEqual({ error: '--accept-terms takes no value.' });
  });
});

describe('pollHealth', () => {
  it('gives up when the timeout passes, after asking more than once', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const started = Date.now();
    const healthy = await pollHealth(3000, 150, { fetchImpl: fetchImpl as unknown as typeof fetch, intervalMs: 20 });
    expect(healthy).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it('treats a request that throws as not healthy yet', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const healthy = await pollHealth(3000, 80, { fetchImpl: fetchImpl as unknown as typeof fetch, intervalMs: 20 });
    expect(healthy).toBe(false);
  });

  it('returns as soon as the health endpoint answers ok', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://localhost:3123/api/health');
      n++;
      return new Response('{}', { status: n < 3 ? 503 : 200 });
    });
    const healthy = await pollHealth(3123, 5_000, { fetchImpl: fetchImpl as unknown as typeof fetch, intervalMs: 10 });
    expect(healthy).toBe(true);
    expect(n).toBe(3);
  });
});

describe('startupReport', () => {
  const base: StartupFacts = {
    healthy: true,
    nonInteractive: false,
    url: 'http://localhost:3000',
    installDir: '/srv/lynox',
    // Built at runtime: secret-shaped literals trip the repo's leak scanners.
    token: randomBytes(16).toString('hex'),
    vaultKey: randomBytes(24).toString('base64'),
    vaultKeyReused: false,
    recoveryWritten: true,
    recoveryEnvPath: '/home/u/.lynox/.env',
  };

  it('reports a healthy start as running, with exit code 0', () => {
    const r = startupReport(base);
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain('lynox is running at http://localhost:3000');
  });

  it('never calls a timed-out start "running", names the logs command, and exits 1', () => {
    const r = startupReport({ ...base, healthy: false });
    expect(r.exitCode).toBe(1);
    expect(r.text).not.toContain('is running');
    expect(r.text).toContain(`did not become healthy within ${String(HEALTH_TIMEOUT_MS / 1000)} s`);
    expect(r.text).toContain('cd /srv/lynox && docker compose logs lynox');
  });

  it('prints the access token and vault key in an interactive run', () => {
    const r = startupReport(base);
    expect(r.text).toContain(base.token);
    expect(r.text).toContain(base.vaultKey);
  });

  it('names where a reused vault key came from, and only then', () => {
    const reused = startupReport({ ...base, vaultKeyReused: true, recoveryWritten: false, vaultKeyFrom: '/srv/lynox/.env' });
    expect(reused.text).toContain('Taken from /srv/lynox/.env.');
    expect(startupReport({ ...base, recoveryWritten: false }).text).not.toContain('Taken from');
  });

  it('names the files instead of printing the secrets in a non-interactive run, healthy or not', () => {
    for (const healthy of [true, false]) {
      const r = startupReport({ ...base, nonInteractive: true, healthy });
      expect(r.text).not.toContain(base.token);
      expect(r.text).not.toContain(base.vaultKey);
      expect(r.text).toContain('LYNOX_HTTP_SECRET in /srv/lynox/.env');
      expect(r.text).toContain('LYNOX_VAULT_KEY in /srv/lynox/.env');
    }
  });
});

describe('runDockerInstaller exit codes before Docker is touched', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lynox-installer-ni-'));
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    process.exitCode = savedExitCode;
    rmSync(home, { recursive: true, force: true });
  });

  it('exits 2 on a usage error and says how to call it', async () => {
    await runDockerInstaller(['--non-interactive', '--provider', 'vertex']);
    expect(process.exitCode).toBe(2);
    const err = vi.mocked(process.stderr.write).mock.calls.map(c => String(c[0])).join('');
    expect(err).toContain('Unknown --provider "vertex"');
    expect(err).toContain('--non-interactive --accept-terms --provider');
  });

  it('asks for --accept-terms even when an earlier run on this machine accepted the terms', async () => {
    mkdirSync(join(home, '.lynox'), { recursive: true });
    writeFileSync(join(home, '.lynox', '.tos-accepted-1'), 'x\n');
    await runDockerInstaller(['--non-interactive', '--provider', 'none']);
    expect(process.exitCode).toBe(1);
    const out = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('');
    expect(out).toContain('Pass --accept-terms');
  });

  it('exits 1 when the terms were not accepted, and stops before anything else', async () => {
    await runDockerInstaller(['--non-interactive', '--provider', 'none']);
    expect(process.exitCode).toBe(1);
    const out = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('');
    expect(out).toContain('Pass --accept-terms');
    // checkDocker always prints one of these; none may appear.
    expect(out).not.toMatch(/Docker not found|Docker daemon is not running|✓\S* Docker \S/);
  });
});

describe('runDockerInstaller refusals after the Docker check', () => {
  let home: string;
  let bin: string;
  let dockerLog: string;
  const saved: Record<string, string | undefined> = {};
  let savedExitCode: typeof process.exitCode;
  let server: Server | undefined;

  const output = (): string => vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('');
  const dockerCalls = (): string => (existsSync(dockerLog) ? readFileSync(dockerLog, 'utf-8') : '');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lynox-installer-ni-'));
    bin = join(home, 'bin');
    dockerLog = join(home, 'docker-calls.log');
    mkdirSync(bin);
    // Answers the three probes of checkDocker and logs every call.
    writeFileSync(join(bin, 'docker'), [
      '#!/bin/sh',
      `echo "$*" >> '${dockerLog}'`,
      'case "$*" in',
      '  "--version") echo "Docker version 27.0.0, build x" ;;',
      '  "compose version") echo "Docker Compose version v2.29.0" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(bin, 'docker'), 0o755);
    for (const k of ['HOME', 'PATH', 'PORT', 'ANTHROPIC_API_KEY']) saved[k] = process.env[k];
    process.env['HOME'] = home;
    process.env['PATH'] = `${bin}:${saved['PATH'] ?? ''}`;
    delete process.env['PORT'];
    delete process.env['ANTHROPIC_API_KEY'];
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.exitCode = savedExitCode;
    if (server) await new Promise<void>(r => server?.close(() => r()));
    server = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses an existing setup without --reconfigure and leaves it untouched', async () => {
    const dir = join(home, 'inst');
    mkdirSync(dir);
    writeFileSync(join(dir, 'docker-compose.yml'), 'old\n');
    await runDockerInstaller(['--non-interactive', '--accept-terms', '--provider', 'none', '--dir', dir]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('already holds a setup. Pass --reconfigure');
    expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8')).toBe('old\n');
    expect(dockerCalls()).toContain('--version');
    expect(dockerCalls()).not.toContain('compose up');
  });

  it('refuses a missing provider key, naming the variable and the keyless way', async () => {
    await runDockerInstaller(['--non-interactive', '--accept-terms', '--provider', 'anthropic', '--dir', join(home, 'inst')]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('Set ANTHROPIC_API_KEY in the environment, or use --provider none');
    expect(dockerCalls()).not.toContain('compose up');
  });

  it('stops on a port in use instead of asking for another one', async () => {
    server = createServer();
    await new Promise<void>(r => server?.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    process.env['PORT'] = String(typeof addr === 'object' && addr ? addr.port : 0);
    await runDockerInstaller(['--non-interactive', '--accept-terms', '--provider', 'none', '--dir', join(home, 'inst')]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain(`Port ${process.env['PORT']} is already in use`);
    expect(output()).toContain('PORT=3001 npx @lynox-ai/core');
    expect(output()).not.toContain('Alternative port');
    expect(dockerCalls()).not.toContain('compose up');
  });
});

describe('the CLI hands its arguments to the installer', () => {
  it('passes args on both installer entry points in index.ts', () => {
    const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(indexSrc.match(/runDockerInstaller\(args\)/g)?.length).toBe(2);
    expect(indexSrc).not.toMatch(/runDockerInstaller\(\)/);
  });
});
