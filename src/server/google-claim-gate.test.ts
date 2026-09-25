import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';

/**
 * `POST /api/google/claim-managed` — the gate, driven through the route.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * The claim is the one flow that CREATES a brokered tenant's Google
 * credential, so the route must not refuse it for not having one. That is why
 * it calls `ensureGoogleAuth()` and not `getGoogleAuth()`. The engine half of
 * that is pinned in `google-visibility-boot.test.ts`; the ROUTE half was
 * pinned by nothing.
 *
 * Measured on `origin/main` at `4df5d094` before this file was written:
 * `git grep claim-managed -- '*.test.ts'` returns **one** hit and it is a
 * comment (`google-auth.test.ts:1659`), and `requireService` returns **zero**
 * across every test file (positive control in the same run: `jsonResponse`
 * matches in **four**). A route whose own comment explains which gate it uses,
 * and no test that reaches it.
 *
 * ⚠ That control said "three" until a refuter counted it: the command had been
 * written `git grep -c … | head -3`, so the number was the head limit and not
 * the answer. It is the second time the same pipe produced a wrong count in the
 * work that produced this file. The claim it supports is unaffected — the
 * control's job is to show the search is not structurally blind, and four hits
 * do that as well as three — but a number is quoted with its command or it is
 * not evidence.
 *
 * ⚠ **One of the mutations named in the engine-half test cannot be killed
 * there, and this is the file that kills it.** `google-visibility-boot.test.ts`
 * says *"MUTATION THIS KILLS: point the claim route back at getGoogleAuth()"* —
 * but it never loads `http-api.ts`, so swapping the call at the route leaves
 * it green. A test that names a mutation in another file is describing an
 * intention, not exercising a control.
 *
 * ── What each half pins ─────────────────────────────────────────────────
 *
 * Both halves are needed and neither is sufficient:
 *
 * - **Refusal** (no credential, not managed) → `503`. Remove the
 *   `requireService` line and the request falls through to the control-plane
 *   env check, which answers `400`. Different status, same request.
 * - **Passage** (managed, no pair) → anything BUT `503`. Without this, a
 *   mutant that makes `ensureGoogleAuth` return null unconditionally, or that
 *   reverts the route to `getGoogleAuth()`, keeps the refusal half green: "the
 *   claim refuses" would be vacuously true because the claim always refuses.
 *
 * So the assertions are on WHICH status, never on "not 200".
 */

const SECRET = 'claim-gate-test-secret-value';
const CLAIM = '/api/google/claim-managed';

/** Env this file must own, so a stray value from the outer shell cannot decide a case. */
const OWNED = [
  'LYNOX_MANAGED_INSTANCE_ID',
  'LYNOX_MANAGED_CONTROL_PLANE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_KEY',
] as const;

interface Booted {
  readonly base: string;
  readonly close: () => Promise<void>;
}

async function boot(port: number, managedInstanceId: string | undefined): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-claimgate-'));
  for (const k of OWNED) vi.stubEnv(k, undefined);
  vi.stubEnv('LYNOX_DATA_DIR', dir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  if (managedInstanceId !== undefined) vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', managedInstanceId);

  const api = new LynoxHTTPApi();
  await api.init();
  // `start` returns `Promise<void>` — it keeps the server on the instance, and
  // `shutdown()` is the only handle to it. ⚠ `oauth-callback-route.test.ts`
  // assigns its result to a `Server | undefined` and closes THAT, which is
  // always `undefined`: that file's teardown has never closed a socket or shut
  // an engine down. Fixed there in this same change; named here because copying
  // the neighbouring pattern is how it would have spread.
  await api.start(port);
  const base = `http://127.0.0.1:${String(port)}`;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return {
    base,
    close: async () => {
      await api.shutdown();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function claim(base: string, body: unknown = { claim_nonce: 'n' }): Promise<Response> {
  return fetch(`${base}${CLAIM}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('a self-host instance with no client pair', () => {
  let b: Booted;
  beforeAll(async () => { b = await boot(39_611, undefined); }, 60_000);
  afterAll(async () => { await b.close(); });

  it('refuses the claim with 503, not with the control-plane 400', async () => {
    // THE mutation: delete `if (!requireService(res, google, 'Google auth')) return;`.
    // `google` is then null, the handler walks on to the LYNOX_MANAGED_* check,
    // and answers 400 — a plausible-looking refusal that says the instance is
    // misconfigured rather than that the service is absent. Asserting only
    // "not 200" would not see it.
    const res = await claim(b.base);
    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toMatchObject({ error: 'Google auth not available' });
  });

  it('refuses BEFORE reading the control-plane env, which is the order that matters', async () => {
    // Same 503 with a body the later checks would reject for a different
    // reason. If the env check moved above the gate, this answers 400 while
    // the case above still answers 400 too — one assertion cannot separate a
    // deleted gate from a reordered one, and two can.
    //
    // ⭐ And it turns out to carry a SECOND property, which is the one worth
    // having and was not the reason it was written. The case above pins the
    // REFUSAL; this one pins that nothing was CREATED. `ensureGoogleAuth`
    // installs what it builds on `this._googleAuth` before it returns, so a
    // version that builds first and only then refuses self-host still answers
    // 503 here on the first request — and hands the credential out on the
    // SECOND, because the early `if (this._googleAuth) return it` no longer
    // has a reason to say no. Measured: that mutation leaves every other
    // assertion in this file and in `google-visibility-boot.test.ts` green,
    // including that file's `resolves.toBeNull()`, which tests the return
    // value and not the side effect. It fails here, and only here, with
    // `expected 400 to be 503`.
    //
    // So: a second request against the SAME engine is what separates "returned
    // null" from "created nothing". Do not collapse these two cases into one.
    const res = await claim(b.base, {});
    expect(res.status).toBe(503);
  });

  it('still requires a session — the gate is not a way around auth', async () => {
    const res = await fetch(`${b.base}${CLAIM}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim_nonce: 'n' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('a managed tenant with no client pair — the flow the gate must not refuse', () => {
  let b: Booted;
  beforeAll(async () => { b = await boot(39_612, 'inst-claim-gate'); }, 60_000);
  afterAll(async () => { await b.close(); });

  it('gets past the credential gate and fails on the control-plane config instead', async () => {
    // The whole point of §3.2: no pair resolves here, so `getGoogleAuth()` is
    // null — and the claim must still proceed, because the claim is what
    // creates the credential. 400 means the route reached the control-plane
    // check, i.e. `ensureGoogleAuth` built one.
    //
    // MUTATIONS THIS KILLS: (a) `ensureGoogleAuth` → `getGoogleAuth` at the
    // route — the mutation the engine-half test names and cannot reach;
    // (b) collapsing `ensureGoogleAuth` to an unconditional `return null`.
    //
    // ⚠ (b) read "dropping the `LYNOX_MANAGED_INSTANCE_ID` branch … so it
    // returns null for everyone" until a refuter took that wording literally
    // and measured it. **Deleting** that line does the opposite: nothing then
    // refuses a self-host caller, `_createGoogleAuth(null)` succeeds (it
    // validates no client pair), and every instance gets a credential. So the
    // phrase named one mutant and described another. Both are real and both
    // die — the deletion at `:116`/`:126` (503 → 400, measured), the collapse
    // here — which means the coverage was WIDER than the comment claimed while
    // the mechanism it stated was backwards. The pre-existing
    // `google-visibility-boot.test.ts` already describes the deletion
    // correctly and kills it at the engine level; this file adds the route.
    const res = await claim(b.base);
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown)
      .toMatchObject({ error: 'Not a managed instance or missing control plane config' });
  });

  it('never answers 503 on this instance, whatever the body', async () => {
    // The negative half of the pairing, on the same machinery that produced a
    // 503 one describe above — so "no 503" here is a measured difference
    // between two instances, not a property of the harness.
    for (const body of [{}, { claim_nonce: '' }, { claim_nonce: 'n' }]) {
      expect((await claim(b.base, body)).status).not.toBe(503);
    }
  });
});
