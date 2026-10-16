import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool } from './bash.js';
import { isToolSoftFailure } from '../../core/tool-soft-failure.js';
import { CredentialRegistry, type HostSet } from '../../egress-proxy/registry.js';
import { createAdminServer } from '../../egress-proxy/server.js';
import { credentialFromHeader } from '../../egress-proxy/policy.js';

/**
 * bash in sidecar mode with the egress proxy (PRD 152 v2 §4.2, W2), against the proxy's own
 * registry and registration listener. The daemon stand-in plays the proxy's other half: while
 * the call runs it looks the call's credential up, as the shell listener would, and records
 * the refusal a connection outside the set would get.
 */

const SECRET = 'a-registration-secret-of-enough-length';
let daemonServer: Server | null = null;
let admin: HttpServer | null = null;
let dir = '';
let registry: CredentialRegistry;
let seenEnv: Record<string, string> = {};
let setDuringCall: HostSet | null | 'unregistered' = 'unregistered';
let credDuringCall: string | null = null;

interface DaemonPlan {
  readonly code: number;
  readonly out?: (env: Record<string, string>) => string;
  readonly refuse?: { host: string; port: number; reason: 'not-in-set' | 'plain-http' };
}

function credOf(env: Record<string, string>): string | null {
  const url = env['HTTPS_PROXY'];
  if (url === undefined) return null;
  const u = new URL(url);
  // What a client sends from this URL, read back the way the shell listener reads it.
  const basic = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  return credentialFromHeader(`Basic ${basic}`);
}

async function daemon(plan: DaemonPlan): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'bash-egress-'));
  const sock = join(dir, 'exec.sock');
  daemonServer = createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (!buf.includes('\n')) return;
      const req = JSON.parse(buf.slice(0, buf.indexOf('\n'))) as { env: Record<string, string> };
      seenEnv = req.env;
      credDuringCall = credOf(req.env);
      setDuringCall = credDuringCall === null ? null : (registry.lookup(credDuringCall)?.set ?? null);
      if (plan.refuse && credDuringCall !== null) registry.recordDenial(credDuringCall, plan.refuse.host, plan.refuse.port, plan.refuse.reason);
      const out = plan.out ? JSON.stringify({ t: 'out', d: plan.out(req.env) }) + '\n' : '';
      s.end(out + JSON.stringify({ t: 'exit', code: plan.code, signal: null, timedOut: false }) + '\n');
    });
  });
  await new Promise<void>((r) => daemonServer!.listen(sock, () => r()));
  return sock;
}

async function proxyAdmin(secret = SECRET): Promise<string> {
  registry = new CredentialRegistry();
  admin = createAdminServer({ registry, secret, log: () => {} });
  await new Promise<void>((r) => admin!.listen(0, '127.0.0.1', () => r()));
  const addr = admin.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(addr.port)}`;
}

function agent(policy: 'allow-all' | 'guarded' | 'allow-list' | 'deny-all' | undefined, opts: {
  hosts?: string[]; wildcards?: string[]; acks?: string[]; envVars?: Record<string, string>;
} = {}): never {
  return {
    toolContext: {
      networkPolicy: policy,
      allowedHosts: opts.hosts ? new Set(opts.hosts) : undefined,
      allowedWildcards: opts.wildcards ?? [],
      apiStore: { getAcceptedEgressHosts: () => new Set(opts.acks ?? []) },
    },
    currentRunId: 'run-1',
    currentThreadId: 'thread-1',
    ...(opts.envVars ? { isolation: { envVars: opts.envVars } } : {}),
  } as never;
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e);
}

async function configured(plan: DaemonPlan, secret = SECRET): Promise<void> {
  vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon(plan));
  vi.stubEnv('LYNOX_EGRESS_PROXY_URL', await proxyAdmin(secret));
  vi.stubEnv('LYNOX_EGRESS_PROXY_SECRET', SECRET);
  vi.stubEnv('LYNOX_EGRESS_SHELL_PROXY', 'proxy:3128');
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (daemonServer) await new Promise<void>((r) => daemonServer!.close(() => r()));
  if (admin) await new Promise<void>((r) => admin!.close(() => r()));
  daemonServer = null;
  admin = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  seenEnv = {};
  setDuringCall = 'unregistered';
  credDuringCall = null;
});

describe('bash with the egress proxy', () => {
  it('registers the call with the hosts guarded allows, hands it the proxy, and revokes it after', async () => {
    await configured({ code: 0, out: () => 'ok' });
    const result = await bashTool.handler({ command: 'wget -q https://api.anthropic.com' }, agent('guarded', { hosts: ['floor.example'], wildcards: ['wild.example'], acks: ['ack.example'] }));
    expect(credDuringCall, 'the call carries a credential the proxy reads from its env').not.toBeNull();
    expect(setDuringCall).not.toBe('*');
    const set = [...(setDuringCall as ReadonlySet<string>)].sort();
    expect(set).toContain('api.anthropic.com');
    expect(set).toContain('floor.example');
    expect(set).toContain('ack.example');
    expect(set.some((h) => h.includes('wild.example') || h === 'localhost' || /^[0-9.]+$/.test(h))).toBe(false);
    expect(seenEnv['HTTPS_PROXY']).toBe(`http://${credDuringCall!}:x@proxy:3128`);
    expect(seenEnv['HTTP_PROXY']).toBe(seenEnv['HTTPS_PROXY']);
    expect(seenEnv['https_proxy']).toBe(seenEnv['HTTPS_PROXY']);
    expect(seenEnv['NODE_USE_ENV_PROXY']).toBe('1');
    expect(registry.lookup(credDuringCall!), 'revoked when the call ended').toBeNull();
    expect(result).toContain('ok');
    expect(result).toContain('"*.wild.example"');
  });

  it('registers allow-all as every host', async () => {
    await configured({ code: 0, out: () => 'ok' });
    await bashTool.handler({ command: 'true' }, agent('allow-all'));
    expect(setDuringCall).toBe('*');
  });

  it('treats no policy at all as allow-all, as the engine\'s own requests do', async () => {
    await configured({ code: 0 });
    await bashTool.handler({ command: 'true' }, agent(undefined));
    expect(setDuringCall).toBe('*');
  });

  it('registers allow-list as the listed exact names only', async () => {
    await configured({ code: 0 });
    await bashTool.handler({ command: 'true' }, agent('allow-list', { hosts: ['only.example', 'Upper.Example', '10.0.0.1'] }));
    expect([...(setDuringCall as ReadonlySet<string>)]).toEqual(['only.example']);
  });

  it('under deny-all registers nothing and gives the call no proxy', async () => {
    await configured({ code: 0, out: () => 'ok' });
    const result = await bashTool.handler({ command: 'true' }, agent('deny-all'));
    expect(credDuringCall).toBeNull();
    expect(seenEnv['HTTPS_PROXY']).toBeUndefined();
    expect(result).toContain('this command had no network: the network policy is deny-all');
  });

  it('tells the model what the proxy refused when the command FAILED, which is when it matters', async () => {
    await configured({ code: 4, out: () => 'wget: error', refuse: { host: 'evil.example', port: 443, reason: 'not-in-set' } });
    const err = await failure(bashTool.handler({ command: 'wget https://evil.example/x' }, agent('guarded')));
    expect(isToolSoftFailure(err)).toBe(true);
    const shown = (err as { agentVisibleResult: string }).agentVisibleResult;
    expect(shown).toContain('wget: error');
    expect(shown).toContain('refused "evil.example" port 443: not reachable from shell commands');
  });

  it('tells the model what the proxy refused when the command succeeded', async () => {
    await configured({ code: 0, out: () => 'done', refuse: { host: 'http://plain.example/path?q=secret', port: 0, reason: 'plain-http' } });
    const result = await bashTool.handler({ command: 'x' }, agent('allow-all'));
    expect(result).toContain('refused "plain.example": only HTTPS is allowed');
    expect(result).not.toContain('q=secret');
  });

  it('puts the network lines FIRST, so a long result cut from the end keeps them', async () => {
    await configured({ code: 0, out: () => 'x'.repeat(100_000), refuse: { host: 'evil.example', port: 443, reason: 'not-in-set' } });
    const result = await bashTool.handler({ command: 'x' }, agent('allow-all'));
    expect(result.startsWith('Network (egress proxy):\n- refused "evil.example" port 443')).toBe(true);
    expect(result.endsWith('x'.repeat(1000))).toBe(true);
  });

  it('puts the network lines first on a failed call too', async () => {
    await configured({ code: 2, out: () => 'boom', refuse: { host: 'evil.example', port: 443, reason: 'not-in-set' } });
    const err = await failure(bashTool.handler({ command: 'x' }, agent('allow-all')));
    expect((err as { agentVisibleResult: string }).agentVisibleResult.startsWith('Network (egress proxy):')).toBe(true);
  });

  it('never returns the credential, in any form the call might print it', async () => {
    await configured({ code: 0, out: (env) => `${env['HTTPS_PROXY']!}\n${Buffer.from(`${credOf(env)!}:x`).toString('base64')}` });
    const result = await bashTool.handler({ command: 'env' }, agent('allow-all'));
    expect(credDuringCall).not.toBeNull();
    expect(result).not.toContain(credDuringCall!);
    expect(result).not.toContain(Buffer.from(`${credDuringCall!}:x`).toString('base64'));
    expect(result).toContain('[egress credential]');
  });

  it('never returns the credential from a failed call either', async () => {
    await configured({ code: 1, out: (env) => env['HTTPS_PROXY']! });
    const err = await failure(bashTool.handler({ command: 'env; false' }, agent('allow-all')));
    expect((err as { agentVisibleResult: string }).agentVisibleResult).not.toContain(credDuringCall!);
  });

  it('a refused registration gives the call no proxy, and says so', async () => {
    await configured({ code: 0, out: () => 'ok' }, 'the-proxy-has-another-secret-entirely');
    const result = await bashTool.handler({ command: 'true' }, agent('allow-all'));
    expect(seenEnv['HTTPS_PROXY']).toBeUndefined();
    expect(seenEnv['NODE_USE_ENV_PROXY']).toBeUndefined();
    expect(result).toContain('this command had no network: the egress proxy refused to register it (HTTP 401)');
  });

  it('an unreachable proxy gives the call no proxy, and says so', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon({ code: 0 }));
    vi.stubEnv('LYNOX_EGRESS_PROXY_SECRET', SECRET);
    vi.stubEnv('LYNOX_EGRESS_PROXY_URL', 'http://127.0.0.1:1');
    const result = await bashTool.handler({ command: 'true' }, agent('allow-all'));
    expect(seenEnv['HTTPS_PROXY']).toBeUndefined();
    expect(result).toContain('this command had no network: the egress proxy could not be reached');
  });

  it('a proxy variable from the isolation config never reaches the call', async () => {
    await configured({ code: 0 });
    await bashTool.handler({ command: 'true' }, agent('allow-all', { envVars: { HTTPS_PROXY: 'http://elsewhere:1', NO_PROXY: '*' } }));
    expect(seenEnv['HTTPS_PROXY']).toBe(`http://${credDuringCall!}:x@proxy:3128`);
    expect(seenEnv['NO_PROXY']).toBeUndefined();
  });

  it('without an egress proxy configured, nothing is registered and the result is as before', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon({ code: 0, out: () => 'hi\n' }));
    vi.stubEnv('LYNOX_EGRESS_PROXY_URL', await proxyAdmin());
    const result = await bashTool.handler({ command: 'echo hi' }, agent('allow-all', { envVars: { HTTPS_PROXY: 'http://elsewhere:1' } }));
    expect(result).toBe('hi\n');
    expect(credDuringCall).toBeNull();
    expect(seenEnv['HTTPS_PROXY'], 'and no proxy from the isolation config either').toBeUndefined();
  });
});
