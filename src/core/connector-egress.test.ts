import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertHostPolicy, type HostPolicyContext } from './network-guard.js';
import { GOOGLE_API_HOSTS, cpFetch, googleFetch } from './connector-egress.js';
import { httpRequestTool } from '../tools/builtin/http.js';
import { installPinnedFetchBridge, dnsLookupStub } from '../../tests/helpers/pinned-fetch-bridge.js';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

let restoreBridge: (() => void) | undefined;
beforeAll(() => { restoreBridge = installPinnedFetchBridge(); });
afterAll(() => { restoreBridge?.(); });
beforeEach(() => { mockFetch.mockReset(); });

function policy(p: HostPolicyContext['networkPolicy'], hosts: string[] = []): HostPolicyContext {
  return {
    networkPolicy: p,
    allowedHosts: hosts.length > 0 ? new Set(hosts) : undefined,
    allowedWildcards: [],
    enforceHttps: false,
  };
}

const GUARDED = policy('guarded');
const okJson = (): Response => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

// ─────────────────────────────────────────────────────────────────────────────
// PRD §6, "Egress (§3.8)": three assertions that only pass TOGETHER. Each is
// written against the branch, not against a helper's return value, so a fix
// that opens the surface wholesale fails one of them.
// ─────────────────────────────────────────────────────────────────────────────

describe('connector surface under `guarded`', () => {
  it('admits a host that is IN the call\'s own set', () => {
    // Mutation: delete the `call.hosts.has(hostname)` term from the connector
    // branch in network-guard.ts → this must fail.
    expect(() => assertHostPolicy(
      'https://www.googleapis.com/drive/v3/files', { surface: 'connector', hosts: GOOGLE_API_HOSTS }, GUARDED,
    )).not.toThrow();
  });

  it('refuses a host OUTSIDE the call\'s own set', () => {
    // Mutation: replace the connector branch with a bare `break` → this must
    // fail. That is the mutation that catches "fixing" the missing branch by
    // opening the surface wholesale, which reads green on every other test here.
    expect(() => assertHostPolicy(
      'https://evil.example.org/collect', { surface: 'connector', hosts: GOOGLE_API_HOSTS }, GUARDED,
    )).toThrow(/not permitted under guarded/);
  });

  it('does NOT leak the connector set into full-control — http_request to a Google API host stays blocked', async () => {
    // The third assertion, and the one that fails if somebody "solves" §3.8 by
    // putting the Google hosts into ALLOWLISTED_HOSTS: that would make the two
    // above pass and this one fail, which is the whole point of running all
    // three. Driven through the real tool handler, not through the guard, so it
    // also covers the handler's own gate.
    expect(() => assertHostPolicy(
      'https://www.googleapis.com/drive/v3/files', { surface: 'full-control' }, GUARDED,
    )).toThrow(/not permitted under guarded/);

    const agent = {
      toolContext: { ...GUARDED, apiStore: null },
      sessionCounters: { httpRequests: 0 },
      promptUser: undefined,
    } as unknown as Parameters<typeof httpRequestTool.handler>[1];
    const out = await httpRequestTool.handler({ url: 'https://www.googleapis.com/drive/v3/files' }, agent)
      .catch((e: unknown) => e instanceof Error ? e.message : String(e));
    expect(JSON.stringify(out)).toMatch(/not permitted|Network access|security mode/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('admits an off-set host when the OPERATOR floor lists it — the escape hatch is real', () => {
    expect(() => assertHostPolicy(
      'https://storage.example.org/x',
      { surface: 'connector', hosts: GOOGLE_API_HOSTS },
      policy('guarded', ['storage.example.org']),
    )).not.toThrow();
  });

  it('re-checks the policy on a REDIRECT HOP, not only on the first URL', async () => {
    // The connector's licence to pass under `guarded` rests on "the URL is a
    // module constant". A 302 breaks that premise, so the check has to run per
    // hop — which is why googleFetch is built on fetchWithValidatedRedirects
    // and not on a bare assertHostPolicy + fetch.
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://evil.example.org/collect' } }),
    );
    await expect(googleFetch('https://www.googleapis.com/drive/v3/files', {}, GUARDED))
      .rejects.toThrow(/not permitted under guarded/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // the second hop never left
  });
});

describe('connector surface under the other policies', () => {
  it('is blocked under `deny-all`, with the same message every other surface gets', async () => {
    await expect(googleFetch('https://www.googleapis.com/drive/v3/files', {}, policy('deny-all')))
      .rejects.toThrow(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is admitted under `allow-list` exactly when the operator listed the host', async () => {
    mockFetch.mockResolvedValueOnce(okJson());
    await expect(googleFetch('https://www.googleapis.com/x', {}, policy('allow-list', ['www.googleapis.com'])))
      .resolves.toBeInstanceOf(Response);
    await expect(googleFetch('https://sheets.googleapis.com/x', {}, policy('allow-list', ['www.googleapis.com'])))
      .rejects.toThrow(/not in network allow-list/);
  });

  it('is unchanged when no policy is configured — a self-host box that never set one', async () => {
    mockFetch.mockResolvedValueOnce(okJson());
    await expect(googleFetch('https://www.googleapis.com/x', {}, undefined)).resolves.toBeInstanceOf(Response);
  });
});

describe('cpFetch — the control plane is a different host class', () => {
  it('admits the CP host and refuses a Google host on the same surface', () => {
    const cp = 'https://cp.invalid/internal/oauth/google/refresh';
    expect(() => assertHostPolicy(cp, { surface: 'connector', hosts: new Set(['cp.invalid']) }, GUARDED)).not.toThrow();
    expect(() => assertHostPolicy(cp, { surface: 'connector', hosts: GOOGLE_API_HOSTS }, GUARDED))
      .toThrow(/not permitted under guarded/);
  });

  it('matches a CP URL that carries an explicit PORT', async () => {
    // The PRD specifies this set as `[new URL(cp.url).host]`. `host` carries the
    // port, `hostname` does not, and assertHostPolicy matches on `hostname` —
    // so a set built from `host` misses its own target on every CP URL with a
    // port, which is every local and every non-443 deployment. The symptom
    // would be a blocked brokered refresh under `guarded`: the exact outage
    // this surface exists to prevent. Mutation: build the set from `.host` →
    // this must fail.
    mockFetch.mockResolvedValueOnce(okJson());
    await expect(cpFetch('https://cp.invalid:8443', '/internal/x', { method: 'POST' }, GUARDED))
      .resolves.toBeInstanceOf(Response);
  });

  it('REFUSES a path that moves the authority off the configured control plane', async () => {
    // The check has to be able to say no. The first version of `cpFetch` took a
    // single `url` and built its host set out of that same url, so
    // `hosts.has(hostname)` compared a value with itself: it passed for every
    // host on earth while reading exactly like a control. Nothing caught it —
    // both call sites build from env, so no call-site review would show it, and
    // every test supplied the host set by hand. Mutation: derive the host set
    // from the request instead of from `base` ⇒ these must stop refusing.
    await expect(cpFetch('https://cp.invalid', 'https://evil.example.org/collect', { method: 'POST' }, GUARDED))
      .rejects.toThrow(/resolves off the configured control plane/);
    // …and under NO policy at all, because this one is not a policy decision:
    // the request carries the instance secret, so it is refused whatever the
    // operator configured.
    await expect(cpFetch('https://cp.invalid', 'https://evil.example.org/x', {}, undefined))
      .rejects.toThrow(/resolves off the configured control plane/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats a protocol-relative path as a PATH, which is why the url is concatenated', async () => {
    // `//evil.example.org/x` is the case that decides HOW the url is built.
    // `new URL(path, base)` resolves it as protocol-relative and lands on
    // evil.example.org — the authority moves and only the explicit host check
    // stands between that and a request carrying the instance secret. String
    // concatenation makes it `https://cp.invalid//evil.example.org/x`: a path on
    // the control plane, no authority change, nothing to catch. The safer
    // construction is the one where the dangerous case cannot arise, not the one
    // where it is caught. This test is the record of that choice — it fails if
    // anyone "tidies" the concatenation into a URL resolve, because then this
    // call starts throwing the off-plane error instead of going out.
    mockFetch.mockResolvedValueOnce(okJson());
    await expect(cpFetch('https://cp.invalid', '//evil.example.org/x', {}, GUARDED))
      .resolves.toBeInstanceOf(Response);
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe('https://cp.invalid//evil.example.org/x');
  });

  it('does NOT follow a redirect — the instance secret is not replayed', async () => {
    // `x-instance-secret` is not in CROSS_ORIGIN_DROP_HEADERS, so a followed hop
    // would carry it to whatever the redirect names. cpFetch goes through
    // fetchPinned, which has no redirect handling at all. Mutation: route
    // cpFetch through fetchWithValidatedRedirects → the call count must change.
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://evil.example.org/collect' } }),
    );
    const res = await cpFetch('https://cp.invalid', '/internal/x', { method: 'POST' }, GUARDED);
    expect(res.status).toBe(302);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe('https://cp.invalid/internal/x');
  });

  it('is refused under `allow-list` unless the OPERATOR listed the control-plane host', async () => {
    // The behaviour the release note has to describe, pinned so the note cannot
    // drift from it: `allow-list` is uniform across surfaces by PRD decision, so
    // the connector's own host set does not help here. A managed tenant that
    // lists only the Google hosts keeps working until its access token expires
    // and then loses the brokered refresh — which is why the CP host is named
    // in CHANGELOG.md and in the `network_policy` doc comment.
    await expect(cpFetch('https://cp.invalid', '/internal/x', {}, policy('allow-list', ['www.googleapis.com'])))
      .rejects.toThrow(/not in network allow-list/);
    mockFetch.mockResolvedValueOnce(okJson());
    await expect(cpFetch('https://cp.invalid', '/internal/x', {}, policy('allow-list', ['cp.invalid'])))
      .resolves.toBeInstanceOf(Response);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6: "A brokered refresh succeeds under `guarded`". Without it the egress
// suite is green on an implementation that has silently disabled brokered
// refresh for the whole fleet — the one mode Stage 1 exists to serve.
// ─────────────────────────────────────────────────────────────────────────────

describe('a brokered refresh under `guarded`', () => {
  const CP = 'https://cp.invalid';
  const ENV = ['LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_HTTP_SECRET'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = CP;
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'instance-secret-value';
  });
  afterEach(() => {
    for (const k of ENV) {
      const v = saved[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  function vaultWith(tokens: Record<string, unknown>): {
    get: (k: string) => string | null; set: () => void; delete: () => boolean;
  } {
    const store = new Map<string, string>([['GOOGLE_OAUTH_TOKENS', JSON.stringify({
      access_token: 'stale-access-token',
      refresh_token: 'refresh-token-bbbbbbbb',
      expires_at: Date.now() - 1000,   // expired, so getAccessToken must refresh
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
      ...tokens,
    })]]);
    return {
      get: (k: string) => store.get(k) ?? null,
      set: () => undefined,
      delete: () => true,
    };
  }

  async function newAuth(pol: HostPolicyContext): Promise<import('../integrations/google/google-auth.js').GoogleAuth> {
    const { GoogleAuth } = await import('../integrations/google/google-auth.js');
    return new GoogleAuth({
      vault: vaultWith({ refresh_handle: 'sealed-handle-1' }) as unknown as import('./secret-vault.js').SecretVault,
      hostPolicy: pol,
    });
  }

  it('succeeds — the CP host is reached even though it is not a Google host', async () => {
    // Mutation: route _doRefresh's control-plane branch through googleFetch /
    // GOOGLE_API_HOSTS instead of cpFetch ⇒ this must fail.
    mockFetch.mockResolvedValueOnce(new Response(
      JSON.stringify({ access_token: 'cp-issued', expires_at: Date.now() + 3_600_000 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const auth = await newAuth(GUARDED);
    await expect(auth.getAccessToken()).resolves.toBe('cp-issued');
    expect((mockFetch.mock.calls[0] as [string])[0]).toBe(`${CP}/internal/oauth/google/refresh`);
  });

  it('fails under `deny-all` BEFORE the response is read, and keeps the token', async () => {
    const auth = await newAuth(policy('deny-all'));
    await expect(auth.getAccessToken()).rejects.toThrow();
    // Nothing left the box, so `classifyRefreshFailure` never ran and no vault
    // wipe could have been triggered by a policy decision.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The WIRING, not the helper. Everything above drives `googleFetch` directly and
// is therefore blind to whether the four tools actually HAND IT a policy — the
// threading could pass `undefined` at every call site and every assertion above
// would stay green. Measured, not assumed: dropping `auth.hostPolicy` from
// `driveFetch` survived all 1074 tests until this describe existed.
// ─────────────────────────────────────────────────────────────────────────────

describe('the tool path hands the policy through (§6: a Drive call under deny-all)', () => {
  async function driveSearchUnder(pol: HostPolicyContext | undefined): Promise<string> {
    const { createDriveTool } = await import('../integrations/google/google-drive.js');
    const auth = {
      getAccessToken: async () => 'access-token',
      hasScope: () => true,
      hostPolicy: pol,
    } as unknown as import('../integrations/google/google-auth.js').GoogleAuth;
    const tool = createDriveTool(() => auth);
    const agent = { promptUser: undefined } as unknown as Parameters<typeof tool.handler>[1];
    return await tool.handler({ action: 'search', query: 'q' }, agent) as string;
  }

  it('fails with the policy message under `deny-all`, and nothing leaves the box', async () => {
    // Mutation: pass `undefined` instead of `auth.hostPolicy` in driveFetch ⇒
    // this must fail. It is the wiring mutation, and it is the reason this test
    // is written against the TOOL and not against googleFetch.
    const out = await driveSearchUnder(policy('deny-all'));
    expect(out).toMatch(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is refused under `guarded` only for a host outside the set — the Drive host passes', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const out = await driveSearchUnder(GUARDED);
    // The control for the test above: if the policy were dropped, BOTH would
    // pass, and only the deny-all one would notice. If the connector branch
    // were removed, this one turns red while deny-all stays green.
    expect(out).toBe('No files found.');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('is unaffected when the instance configured no policy', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    expect(await driveSearchUnder(undefined)).toBe('No files found.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One driven call per FILE that threads the policy. Per file, not per call site,
// because the threading is per file: each module reads `auth.hostPolicy` (or
// `this.googleAuth.hostPolicy`) in one helper that all its sites share, so one
// driven call per file is what a dropped thread cannot survive.
//
// The review that produced this table was right about the size of the gap: the
// first version drove ONE of the eight files and called the wiring covered.
// ─────────────────────────────────────────────────────────────────────────────

describe('the policy reaches every module that threads it', () => {
  function fakeAuth(pol: HostPolicyContext | undefined): import('../integrations/google/google-auth.js').GoogleAuth {
    return {
      getAccessToken: async () => 'access-token',
      hasScope: () => true,
      hostPolicy: pol,
    } as unknown as import('../integrations/google/google-auth.js').GoogleAuth;
  }
  const DENY = policy('deny-all');
  const noAgent = {} as never;

  it('google-sheets.ts', async () => {
    const { createSheetsTool } = await import('../integrations/google/google-sheets.js');
    const out = await createSheetsTool(() => fakeAuth(DENY)).handler({ action: 'list' }, noAgent) as string;
    expect(out).toMatch(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('google-calendar.ts', async () => {
    const { createCalendarTool } = await import('../integrations/google/google-calendar.js');
    const out = await createCalendarTool(() => fakeAuth(DENY)).handler({ action: 'list_events' }, noAgent) as string;
    expect(out).toMatch(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('google-docs.ts — the shared helper', async () => {
    const { createDocsTool } = await import('../integrations/google/google-docs.js');
    const out = await createDocsTool(() => fakeAuth(DENY))
      .handler({ action: 'read', document_id: 'doc-1' }, noAgent) as string;
    expect(out).toMatch(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('google-docs.ts — the standalone multipart upload, which does NOT use that helper', async () => {
    // A second site in the same file, reached only by `create`. It builds its
    // own request rather than going through `docsFetch`, so the test above
    // cannot speak for it — this is the one case where per-file granularity is
    // not enough, and the reason is visible in the code rather than guessed.
    const { createDocsTool } = await import('../integrations/google/google-docs.js');
    const out = await createDocsTool(() => fakeAuth(DENY))
      .handler({ action: 'create', title: 'T', content: 'x' }, noAgent) as string;
    expect(out).toMatch(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('mail/providers/oauth-gmail.ts — the GET helper', async () => {
    const { OAuthGmailProvider } = await import('../integrations/mail/providers/oauth-gmail.js');
    const account = { id: 'acc-1', address: 'a@b.c' } as never;
    await expect(new OAuthGmailProvider(account, fakeAuth(DENY)).list({}))
      .rejects.toThrow(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('mail/providers/oauth-gmail.ts — the POST helper', async () => {
    const { OAuthGmailProvider } = await import('../integrations/mail/providers/oauth-gmail.js');
    const account = { id: 'acc-1', address: 'a@b.c' } as never;
    await expect(new OAuthGmailProvider(account, fakeAuth(DENY))
      .send({ to: ['x@y.z'], subject: 's', text: 't' } as never))
      .rejects.toThrow(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('core/backup-upload-gdrive.ts', async () => {
    const { GDriveBackupUploader } = await import('./backup-upload-gdrive.js');
    const up = new GDriveBackupUploader({
      getAccessToken: async () => 'access-token',
      hasScope: () => true,
      hostPolicy: DENY,
    });
    const res = await up.upload('/tmp/does-not-matter', {} as never);
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/network_policy=deny-all/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('google-auth.ts — the DIRECT refresh branch, which is not the brokered one', async () => {
    // The brokered describe above drives `cpFetch`. This drives the other side
    // of the same ternary: a self-host instance with its own pair and a raw
    // refresh token, which goes to Google through `googleFetch`.
    const { GoogleAuth } = await import('../integrations/google/google-auth.js');
    const store = new Map<string, string>([['GOOGLE_OAUTH_TOKENS', JSON.stringify({
      access_token: 'stale', refresh_token: 'refresh-token-bbbbbbbb',
      expires_at: Date.now() - 1000, scopes: [],
    })]]);
    const auth = new GoogleAuth({
      clientId: 'id', clientSecret: 'secret',
      vault: { get: (k: string) => store.get(k) ?? null, set: () => undefined, delete: () => true } as never,
      hostPolicy: DENY,
    });
    await expect(auth.getAccessToken()).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The source test. §3.8: "A source test admits only the helper — and it must be
// scoped by BEHAVIOUR, not by directory."
// ─────────────────────────────────────────────────────────────────────────────

describe('source: every authenticated Google call goes through the helper', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
    }
    return out;
  }

  /** Comments are not code. A file that MENTIONS `fetch(` in prose is not a site. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
  }

  /**
   * A call to the global `fetch`. Excludes `googleFetch(`/`cpFetch(`/
   * `fetchPinned(`/`fetchWithValidatedRedirects(` (the identifier boundary does
   * that), member calls like `client.fetch(` (the `.` lookbehind), and a METHOD
   * DECLARATION named `fetch` — `OAuthGmailProvider.fetch(opts)` is one, and
   * counting it was the false positive the PRD warns about by name.
   */
  const BARE_FETCH = /(?<![\w.$])fetch\s*\(|globalThis\.fetch\s*\(/g;
  const METHOD_DECL = /(?:async\s+|\*\s*)fetch\s*\(/g;

  function bareFetchLines(code: string): number[] {
    const decls = new Set<number>();
    for (const m of code.matchAll(METHOD_DECL)) decls.add(m.index + m[0].length - 'fetch('.length);
    const out: number[] = [];
    for (const m of code.matchAll(BARE_FETCH)) {
      if (decls.has(m.index)) continue;
      out.push(code.slice(0, m.index).split('\n').length);
    }
    return out;
  }

  /**
   * The membership predicate, over BEHAVIOUR rather than over a directory: a
   * file is in scope if it names a host this engine fetches for a Google grant,
   * OR if it takes an access token from one of the auth objects. The second
   * clause is what catches a member that does not know this rule exists — a new
   * Google integration in a new folder still has to call `getAccessToken()`
   * before it can fetch anything, so it lands in scope on its first line of
   * real work rather than on somebody remembering a convention.
   *
   * Drawing this over `integrations/google/` + `mail/` is what hid
   * `core/backup-upload-gdrive.ts › driveFetch` for the whole of v5: it is in
   * neither folder and it carries the OAuth bearer to `googleapis.com`.
   */
  function inScope(code: string): boolean {
    for (const h of GOOGLE_API_HOSTS) if (code.includes(h)) return true;
    if (code.includes('.getAccessToken()')) return true;
    // Third clause, added after a review pointed at the member both earlier
    // clauses miss: a helper that RECEIVES an already-fetched token as a
    // parameter names no host and calls no `getAccessToken()`, so it was
    // invisible to both. Building a bearer header is the thing such a helper
    // cannot avoid doing, so that is what the predicate asks about.
    return /Authorization`?\s*:\s*`Bearer /.test(code);
  }

  const files = walk('src').map(p => ({ path: p, code: stripComments(readFileSync(p, 'utf8')) }));
  /** Every file that CALLS a helper — the module that defines them is not a call site. */
  const callers = files.filter(f => !f.path.endsWith('connector-egress.ts'));

  it('the detector actually detects — positive control on a synthetic member', () => {
    // Without this, a regex that matches nothing reports a clean codebase and
    // reads exactly like a codebase with no violations.
    const synthetic = `const t = await auth.getAccessToken();\nconst r = await fetch('https://www.googleapis.com/x');`;
    expect(inScope(synthetic)).toBe(true);
    expect(bareFetchLines(synthetic)).toEqual([2]);
    // …and it does NOT fire on the two shapes that are not sites.
    expect(bareFetchLines(`async fetch(opts: X) { return this.get(opts); }`)).toEqual([]);
    expect(bareFetchLines(`const r = await googleFetch(url, {}, ctx);`)).toEqual([]);
    expect(bareFetchLines(`const r = await client.fetch(url);`)).toEqual([]);
  });

  it('the scan sees a non-empty universe', () => {
    // A path typo turns "no violations" into "no files", and the two look the
    // same in a green test.
    expect(files.length).toBeGreaterThan(200);
    expect(files.filter(f => inScope(f.code)).length).toBeGreaterThanOrEqual(10);
  });

  it('no in-scope file reaches the network with a bare fetch', () => {
    const offenders = files
      .filter(f => inScope(f.code))
      .flatMap(f => bareFetchLines(f.code).map(l => `${f.path}:${l}`));
    // If this fails on a Vertex/LLM path rather than a Workspace one, the answer
    // is a recorded decision in this test — not a quiet exclusion. §3.8 keeps
    // the LLM surface out of scope deliberately, and that has to stay visible.
    expect(offenders).toEqual([]);
  });

  it('all 16 Google sites and both control-plane sites are accounted for', () => {
    // The count is the PRD's, re-measured here rather than trusted: 12 in
    // `integrations/google/`, 3 Gmail-API fetches in `mail/`, 1 in
    // `core/backup-upload-gdrive.ts`. Plus the two control-plane calls, which
    // are deliberately NOT in the Google set — routing them through
    // GOOGLE_API_HOSTS would refuse the CP host and break every brokered
    // refresh in the fleet.
    const count = (re: RegExp): number => callers
      .reduce((n, f) => n + (f.code.match(re)?.length ?? 0), 0);
    expect(count(/\bgoogleFetch\s*\(/g)).toBe(16);
    expect(count(/\bcpFetch\s*\(/g)).toBe(2);
  });

  it('every one of those sites passes a POLICY, not `undefined`', () => {
    // The count above is satisfied by `googleFetch(url, init, undefined)` — it
    // counts occurrences of a name, which is a FORM, while the question is
    // whether the call carries the instance's policy. Both numbers stay at
    // 16/2 while the surface silently stops being policed, and that is exactly
    // the failure this whole PR is about, one level up.
    //
    // This reads the LAST argument of each call by matching parentheses, so it
    // is not fooled by a nested call or a template literal in an earlier one.
    const offenders: string[] = [];
    for (const f of callers) {
      for (const m of f.code.matchAll(/\b(googleFetch|cpFetch)\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        let depth = 0, k = open;
        for (; k < f.code.length; k++) {
          const c = f.code[k];
          if (c === '(') depth++;
          else if (c === ')' && --depth === 0) break;
        }
        const args = f.code.slice(open + 1, k);
        // Split on the top-level commas only; the last piece is the ctx arg.
        let d = 0; const parts: string[] = []; let cur = '';
        for (const c of args) {
          if ('([{'.includes(c)) d++;
          else if (')]}'.includes(c)) d--;
          if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
          cur += c;
        }
        parts.push(cur);
        const last = (parts.at(-1) ?? '').trim();
        if (!/hostPolicy/.test(last)) {
          offenders.push(`${f.path}:${f.code.slice(0, m.index).split('\n').length} → ${last.slice(0, 40)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('that last check can actually fail — positive control', () => {
    // A source assertion that matches nothing reports a clean codebase and a
    // codebase with no call sites identically.
    const synthetic = `const a = await googleFetch(url, {}, undefined);`;
    const m = /\b(googleFetch|cpFetch)\s*\(/.exec(synthetic);
    expect(m).not.toBeNull();
    expect(/hostPolicy/.test('undefined')).toBe(false);
    expect(callers.length).toBeGreaterThanOrEqual(8);
  });
});
