import { describe, it, expect } from 'vitest';
import {
  computeShellSet, credentialForms, denialLines, mintCredential, openShellEgress, redactCredential,
  MAX_DENIAL_LINES, MAX_SHELL_SET, type AdminCall, type ShellPolicyInput,
} from './egress.js';
import { CRED_RE, MAX_TTL_S } from '../egress-proxy/registry.js';
import { guardedBaselineHostList, isGuardedBaselineHost, GATE_MEMBERSHIP_FOR_TESTS } from '../core/llm/endpoint-allowlist.js';
import { MAX_EXEC_TIMEOUT_MS } from './protocol.js';

const input = (over: Partial<ShellPolicyInput>): ShellPolicyInput => ({
  networkPolicy: 'guarded', allowedHosts: undefined, allowedWildcards: [], ackHosts: undefined, ...over,
});

describe('the set a shell call may reach', () => {
  it('allow-all and no policy are every host; deny-all and an unknown value are none', () => {
    expect(computeShellSet(input({ networkPolicy: 'allow-all' }))).toEqual({ kind: 'all' });
    expect(computeShellSet(input({ networkPolicy: undefined }))).toEqual({ kind: 'all' });
    expect(computeShellSet(input({ networkPolicy: 'deny-all' })).kind).toBe('none');
    expect(computeShellSet(input({ networkPolicy: 'open-sesame' as never })).kind).toBe('none');
  });

  it('guarded is the baseline, the floor and the acks, as exact names', () => {
    const s = computeShellSet(input({ allowedHosts: new Set(['floor.example']), ackHosts: new Set(['ack.example']) }));
    if (s.kind !== 'hosts') throw new Error(s.kind);
    expect(s.hosts).toContain('api.anthropic.com');
    expect(s.hosts).toContain('floor.example');
    expect(s.hosts).toContain('ack.example');
    expect(s.hosts).not.toContain('localhost');
    expect(s.hosts.filter((h) => /^[0-9.]+$/.test(h))).toEqual([]);
    expect(s.dropped, 'the baseline\'s own loopback entries are not named as dropped').toEqual([]);
  });

  it('allow-list is the floor only, without the baseline or the acks', () => {
    const s = computeShellSet(input({ networkPolicy: 'allow-list', allowedHosts: new Set(['only.example']), ackHosts: new Set(['ack.example']) }));
    expect(s).toEqual({ kind: 'hosts', hosts: ['only.example'], dropped: [] });
  });

  it('an entry the proxy cannot take is dropped and named, never widened or lower-cased', () => {
    const s = computeShellSet(input({
      networkPolicy: 'allow-list',
      allowedHosts: new Set(['ok.example', 'Upper.Example', '203.0.113.7', 'host.example:8443', 'trail.example.']),
      allowedWildcards: ['wild.example'],
    }));
    if (s.kind !== 'hosts') throw new Error(s.kind);
    expect(s.hosts).toEqual(['ok.example']);
    expect(s.dropped.sort()).toEqual(['*.wild.example', '203.0.113.7', 'Upper.Example', 'host.example:8443', 'trail.example.'].sort());
  });

  it('no wildcard list at all is no wildcards, not an error', () => {
    expect(computeShellSet(input({ networkPolicy: 'allow-list', allowedHosts: new Set(['a.example']), allowedWildcards: undefined })))
      .toEqual({ kind: 'hosts', hosts: ['a.example'], dropped: [] });
  });

  it('more names than the proxy takes is no network, not a cut list', () => {
    const many = new Set(Array.from({ length: MAX_SHELL_SET + 1 }, (_, i) => `h${String(i)}.example`));
    expect(computeShellSet(input({ networkPolicy: 'allow-list', allowedHosts: many })).kind).toBe('none');
    const enough = new Set(Array.from({ length: MAX_SHELL_SET }, (_, i) => `h${String(i)}.example`));
    expect(computeShellSet(input({ networkPolicy: 'allow-list', allowedHosts: enough })).kind).toBe('hosts');
  });

  it('the baseline list is the one Set the baseline predicate reads', () => {
    expect([...guardedBaselineHostList()].sort()).toEqual([...GATE_MEMBERSHIP_FOR_TESTS.exactHosts]);
    for (const h of guardedBaselineHostList()) expect(isGuardedBaselineHost(`https://${h}/`), h).toBe(true);
  });
});

describe('the credential', () => {
  it('is 43 base64url characters and fresh each time', () => {
    const a = mintCredential();
    expect(a).toMatch(CRED_RE);
    expect(mintCredential()).not.toBe(a);
  });

  it('is removed from text in every form a call might print it', () => {
    const cred = mintCredential();
    for (const form of credentialForms(cred)) {
      expect(redactCredential(`before ${form} after`, cred)).toBe('before [egress credential] after');
    }
    for (const plain of [`${cred}:x`, `${cred}:`, cred]) {
      expect(credentialForms(cred)).toContain(Buffer.from(plain).toString('base64'));
      expect(credentialForms(cred)).toContain(Buffer.from(plain).toString('base64url'));
    }
  });
});

describe('the denial lines', () => {
  const d = (over: Record<string, unknown>): Record<string, unknown> => ({ host: 'evil.example', port: 443, at: 1, reason: 'not-in-set', ...over });

  it('names each refused host once, with the reason', () => {
    expect(denialLines(JSON.stringify([d({}), d({ at: 2 }), d({ reason: 'port', port: 8443 })]))).toEqual([
      '- refused "evil.example" port 443: not reachable from shell commands under the current network policy. Ask the owner instead of trying other spellings.',
      '- refused "evil.example" port 8443: only HTTPS on port 443 is allowed.',
    ]);
  });

  it('shows only the host of a raw URL, and nothing that is not printable', () => {
    expect(denialLines(JSON.stringify([d({ host: 'http://plain.example/p?token=1', port: 0, reason: 'plain-http' })])))
      .toEqual(['- refused "plain.example": only HTTPS is allowed; use https://.']);
    const [line] = denialLines(JSON.stringify([d({ host: 'a\nb‮c' })]));
    expect(line).toContain('"a?b?c"');
  });

  it('leaves out anything that is not the denial shape', () => {
    expect(denialLines(JSON.stringify([d({ reason: 'made-up' }), d({ port: 70000 }), d({ port: 1.5 }), d({ host: 5 }), null, 'x']))).toEqual([]);
    expect(denialLines('not json')[0]).toContain('could not be read');
    expect(denialLines('{"a":1}')[0]).toContain('could not be read');
  });

  it('counts what it does not show', () => {
    const many = Array.from({ length: MAX_DENIAL_LINES + 3 }, (_, i) => d({ host: `h${String(i)}.example` }));
    const lines = denialLines(JSON.stringify(many));
    expect(lines).toHaveLength(MAX_DENIAL_LINES + 1);
    expect(lines.at(-1)).toBe('- and 3 more');
  });
});

describe('one call against the registration listener', () => {
  function fakeAdmin(answers: Partial<Record<'PUT' | 'DELETE' | 'GET', { status: number; body?: string } | 'throw'>>): { admin: AdminCall; calls: string[]; bodies: string[] } {
    const calls: string[] = [];
    const bodies: string[] = [];
    const admin: AdminCall = (method, path, body) => {
      calls.push(`${method} ${path.split('/')[1]!}`);
      if (body !== undefined) bodies.push(body);
      const a = answers[method] ?? { status: 204 };
      if (a === 'throw') return Promise.reject(new Error('egress proxy: not reachable'));
      return Promise.resolve({ status: a.status, body: a.body ?? '' });
    };
    return { admin, calls, bodies };
  }
  const config = { secret: 's', adminUrl: undefined, shellProxy: undefined };

  it('registers with the capped timeout plus five seconds, the run and the session', async () => {
    const { admin, bodies } = fakeAdmin({});
    await openShellEgress({ policy: input({ networkPolicy: 'allow-all' }), timeoutMs: 5000, run: 'r1', session: 's1', config, admin });
    expect(JSON.parse(bodies[0]!)).toEqual({ set: '*', ttl_s: 10, run: 'r1', session: 's1' });
    const { admin: a2, bodies: b2 } = fakeAdmin({});
    await openShellEgress({ policy: input({ networkPolicy: 'allow-all' }), timeoutMs: 0, run: undefined, session: undefined, config, admin: a2 });
    expect(JSON.parse(b2[0]!)).toEqual({ set: '*', ttl_s: Math.ceil(MAX_EXEC_TIMEOUT_MS / 1000) + 5, run: 'none', session: 'none' });
    expect(Math.ceil(MAX_EXEC_TIMEOUT_MS / 1000) + 5).toBe(MAX_TTL_S);
  });

  it('revokes before it reads the denials', async () => {
    const { admin, calls } = fakeAdmin({ GET: { status: 200, body: '[]' } });
    const e = await openShellEgress({ policy: input({ networkPolicy: 'allow-all' }), timeoutMs: 1000, run: 'r', session: 's', config, admin });
    await e!.finish();
    expect(calls).toEqual(['PUT cred', 'DELETE cred', 'GET denials']);
  });

  it('revokes even when the registration failed here, since it may have landed there', async () => {
    const { admin, calls } = fakeAdmin({ PUT: 'throw' });
    const e = await openShellEgress({ policy: input({ networkPolicy: 'allow-all' }), timeoutMs: 1000, run: 'r', session: 's', config, admin });
    expect(e!.env).toEqual({});
    const tail = await e!.finish();
    expect(calls).toEqual(['PUT cred', 'DELETE cred']);
    expect(tail).toContain('this command had no network: the egress proxy could not be reached (not reachable)');
  });

  it('a credential the proxy no longer knows is named as lost, not as unreadable', async () => {
    const { admin } = fakeAdmin({ GET: { status: 404 } });
    const e = await openShellEgress({ policy: input({ networkPolicy: 'allow-all' }), timeoutMs: 1000, run: 'r', session: 's', config, admin });
    expect(await e!.finish()).toContain('lost this command\'s credential');
  });

  it('a call without refusals and without notes gets nothing added', async () => {
    const { admin } = fakeAdmin({ GET: { status: 200, body: '[]' } });
    const e = await openShellEgress({ policy: input({ networkPolicy: 'allow-all' }), timeoutMs: 1000, run: 'r', session: 's', config, admin });
    expect(await e!.finish()).toBe('');
  });

  it('a shell proxy that is not host:port gives no network and registers nothing', async () => {
    const { admin, calls } = fakeAdmin({});
    const e = await openShellEgress({ policy: input({ networkPolicy: 'allow-all' }), timeoutMs: 1000, run: 'r', session: 's', config: { ...config, shellProxy: 'user@evil:1/x' }, admin });
    expect(e!.env).toEqual({});
    expect(calls).toEqual([]);
  });

  it('no secret is no egress proxy at all', async () => {
    const { admin, calls } = fakeAdmin({});
    expect(await openShellEgress({ policy: input({}), timeoutMs: 1, run: 'r', session: 's', config: { ...config, secret: '' }, admin })).toBeNull();
    expect(calls).toEqual([]);
  });
});
