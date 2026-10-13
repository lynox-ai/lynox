import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { LynoxHTTPApi } from './http-api.js';
import { loginSession as webUiLoginSession } from '../../packages/web-ui/src/lib/server/auth.js';
import { reloadConfig } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import type { KnowledgeStore } from '../core/knowledge-store.js';
import type { KnowledgeLayer } from '../core/knowledge-layer.js';
import type { SubjectStore } from '../core/subject-store.js';
import type { AuditLog } from '../core/audit-log.js';
import { PERSON_ERASURE_NOT_COVERED } from '../core/person-erasure.js';

/**
 * `POST /api/privacy/person-erasure[/preview]` on a real engine: who may call it, what it
 * answers, what it records. The store-level behaviour is in `src/core/person-erasure.test.ts`.
 * Every name here is invented.
 */
describe('person erasure routes (real engine)', () => {
  // Built at RUNTIME, never a literal: a key-shaped fixture string is what the commit-time
  // secret scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ADMIN = `a-${randomBytes(12).toString('hex')}`;
  const ENV = [
    'LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_HTTP_ADMIN_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY',
    'LYNOX_DURABLE_MEMORY_ENABLED', 'LYNOX_SUBJECT_GRAPH_ENABLED',
    'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE',
  ];
  const saved: Record<string, string | undefined> = {};
  let api: LynoxHTTPApi | undefined;
  let baseUrl: string;
  let dir: string | undefined;

  type Engine = {
    getKnowledgeStore: () => KnowledgeStore | null;
    getKnowledgeLayer: () => KnowledgeLayer | null;
    getSubjectStore: () => SubjectStore | null;
    getEngineDb: () => EngineDb | null;
    getAuditLog: () => AuditLog | null;
  };
  const engine = (): Engine => (api as unknown as { engine: Engine }).engine;
  const raw = (): Database.Database => engine().getEngineDb()!.getDb();

  async function post(path: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` }): Promise<{ status: number; body: Record<string, unknown>; cache: string | null }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get('cache-control') };
  }
  const preview = (subjectId: string, headers?: Record<string, string>) => post('/api/privacy/person-erasure/preview', { subjectId }, headers);
  const erase = (body: Record<string, unknown>, headers?: Record<string, string>) => post('/api/privacy/person-erasure', { confirm: 'ERASE_PERSON', entryIds: [], memoryIds: [], ...body }, headers);

  let n = 0;
  /** A person with one bound entry and one bound memory, under a fresh name. */
  function seedPerson(): { subjectId: string; entryId: string; memoryId: string } {
    n++;
    const name = `Dora Felsegg${'x'.repeat(n)}`;
    const ks = engine().getKnowledgeStore()!;
    const w = ks.write({ text: `Asked for the quote, round ${String(n)}`, subjectName: name, subjectKind: 'person', sourceChannel: 'user', sourceUntrusted: false });
    const kl = engine().getKnowledgeLayer()!;
    const memoryId = kl.getDb().createMemory({ text: `${name} called back`, namespace: 'knowledge', scopeType: 'global', scopeId: '', embedding: [0.1, 0.2, 0.3] });
    raw().prepare(`INSERT INTO memories (id, text, namespace, subject_id, scope_type, scope_id) VALUES (?, ?, 'knowledge', ?, 'global', '')`)
      .run(memoryId, engine().getEngineDb()!.enc(`${name} called back`), w.subjectId);
    return { subjectId: w.subjectId!, entryId: w.id, memoryId };
  }
  const subjectExists = (id: string): boolean => raw().prepare('SELECT 1 FROM subjects WHERE id = ?').get(id) !== undefined;
  const auditRows = (subjectId: string): Array<{ action: string; target: string; phase: string; correlation_id: string; actor_kind: string }> =>
    raw().prepare('SELECT action, target, phase, correlation_id, actor_kind FROM audit_log WHERE target LIKE ? ORDER BY id').all(`subject:${subjectId} %`) as never;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-person-erasure-route-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
    for (const k of ['LYNOX_HTTP_ADMIN_SECRET', 'LYNOX_SUBJECT_GRAPH_ENABLED', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE']) delete process.env[k];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('previews with the text and a plan, and no cache may keep the answer', async () => {
    const p = seedPerson();
    const r = await preview(p.subjectId);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('no-store');
    expect((r.body['entries'] as Array<{ id: string; text: string; matchedBy: string }>)).toEqual([
      { id: p.entryId, status: 'active', text: expect.stringContaining('Asked for the quote') as unknown, matchedBy: 'subject' },
    ]);
    expect((r.body['memories'] as Array<{ id: string; matchedBy: string }>).map(m => [m.id, m.matchedBy])).toEqual([[p.memoryId, 'subject']]);
    expect(typeof r.body['plan']).toBe('string');
    expect(r.body['notCovered']).toEqual([...PERSON_ERASURE_NOT_COVERED]);
  });

  it('erases, answers what it did and what it does not reach, and records an attempt and an outcome with ids only', async () => {
    const p = seedPerson();
    const { body: pv } = await preview(p.subjectId);
    const r = await erase({ subjectId: p.subjectId, plan: pv['plan'] });
    expect(r.status).toBe(200);
    expect(r.cache).toBe('no-store');
    expect(r.body).toMatchObject({ erased: true, failed: null, counts: { entries: 1, memories: 1, legacyEntities: 0, subjects: 1 } });
    expect(r.body['notCovered']).toEqual([...PERSON_ERASURE_NOT_COVERED]);
    expect(subjectExists(p.subjectId)).toBe(false);
    const rows = auditRows(p.subjectId);
    expect(rows.map(x => [x.action, x.phase, x.actor_kind])).toEqual([['person-erasure', 'attempt', 'owner'], ['person-erasure', 'done', 'owner']]);
    expect(rows[0]!.correlation_id).toBe(rows[1]!.correlation_id);
    expect(rows[0]!.target).toBe(`subject:${p.subjectId} entries:1 memories:1 entities:0`);
    expect(rows[1]!.target).toBe(`subject:${p.subjectId} entries:1 memories:1 entities:0`);
    expect(rows.some(x => x.target.includes('Felsegg'))).toBe(false);
  });

  it('answers 500 with how far it got when a step fails, records the failure, and a new preview finishes it', async () => {
    const p = seedPerson();
    const { body: pv } = await preview(p.subjectId);
    vi.spyOn(engine().getKnowledgeLayer()!, 'purgeLegacyMemoriesForErasure').mockImplementationOnce(() => { throw new Error('disk I/O error'); });
    const r = await erase({ subjectId: p.subjectId, plan: pv['plan'] });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ erased: false, done: ['durable_knowledge'], failed: 'memories_legacy' });
    expect(String(r.body['error'])).toContain('memories_legacy');
    expect(subjectExists(p.subjectId)).toBe(true);
    expect(auditRows(p.subjectId).map(x => [x.action, x.phase])).toEqual([
      ['person-erasure', 'attempt'], ['person-erasure failed:memories_legacy', 'failed'],
    ]);
    // The outcome row says what went, not what was planned.
    expect(auditRows(p.subjectId).map(x => x.target)).toEqual([
      `subject:${p.subjectId} entries:1 memories:1 entities:0`, `subject:${p.subjectId} entries:1 memories:0 entities:0`,
    ]);
    const again = await preview(p.subjectId);
    const done = await erase({ subjectId: p.subjectId, plan: again.body['plan'] });
    expect(done.status).toBe(200);
    expect(subjectExists(p.subjectId)).toBe(false);
  });

  it('refuses while a chat is running, and erases nothing', async () => {
    const p = seedPerson();
    const { body: pv } = await preview(p.subjectId);
    const running = (api as unknown as { runningSessions: Map<string, unknown> }).runningSessions;
    running.set('busy-thread', { streamAlive: true, takeover: () => {}, lastEventAt: Date.now() });
    try {
      const r = await erase({ subjectId: p.subjectId, plan: pv['plan'] });
      expect(r.status).toBe(409);
      expect(r.body['code']).toBe('runs_active');
    } finally {
      running.delete('busy-thread');
    }
    expect(subjectExists(p.subjectId)).toBe(true);
    expect(auditRows(p.subjectId)).toEqual([]);
  });

  it('refuses without the confirmation word, on a changed set and on an id it did not find', async () => {
    const p = seedPerson();
    const { body: pv } = await preview(p.subjectId);
    expect((await post('/api/privacy/person-erasure', { subjectId: p.subjectId, plan: pv['plan'] })).status).toBe(400);
    const unknown = await erase({ subjectId: p.subjectId, plan: pv['plan'], entryIds: ['not-a-candidate'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body['code']).toBe('unknown_ids');
    engine().getKnowledgeStore()!.write({ text: 'Moved to Chur', subjectName: `Dora Felsegg${'x'.repeat(n)}`, subjectKind: 'person', sourceChannel: 'user', sourceUntrusted: false });
    const changed = await erase({ subjectId: p.subjectId, plan: pv['plan'] });
    expect(changed.status).toBe(409);
    expect(changed.body['code']).toBe('plan_changed');
    expect(subjectExists(p.subjectId)).toBe(true);
  });

  it('erases nothing when the attempt cannot be recorded', async () => {
    const p = seedPerson();
    const { body: pv } = await preview(p.subjectId);
    vi.spyOn(engine() as unknown as { getAuditLog: () => AuditLog | null }, 'getAuditLog').mockReturnValue(null);
    const r = await erase({ subjectId: p.subjectId, plan: pv['plan'] });
    expect(r.status).toBe(503);
    expect(r.body['code']).toBe('audit_unavailable');
    expect(subjectExists(p.subjectId)).toBe(true);
  });

  it('answers 503 instead of an empty preview when a stored text cannot be decrypted', async () => {
    const p = seedPerson();
    const foreign = new EngineDb(join(dir!, 'foreign.db'), 'another-vault-key');
    try {
      raw().prepare('UPDATE knowledge_entries SET text = ? WHERE id = ?').run(foreign.enc('unreadable'), p.entryId);
    } finally {
      foreign.close();
    }
    const r = await preview(p.subjectId);
    expect(r.status).toBe(503);
    expect(r.body['code']).toBe('key_unavailable');
    raw().prepare('DELETE FROM knowledge_entries WHERE id = ?').run(p.entryId);
  });

  it('refuses a mandate on both routes', async () => {
    const p = seedPerson();
    const token = webUiLoginSession(SECRET, {
      kind: 'mandate', email: 'recipient@example.invalid', display: 'TEST-DISPLAY',
      mandate_id: 'TEST-MANDATE-1', mandate_expires_at: '2100-01-01T00:00:00.000Z',
    })!.token;
    const asMandate = { cookie: `lynox_session=${token}` };
    expect((await preview(p.subjectId, asMandate)).status).toBe(403);
    expect((await erase({ subjectId: p.subjectId, plan: 'x' }, asMandate)).status).toBe(403);
    expect(subjectExists(p.subjectId)).toBe(true);
  });

  // The control plane holds both of a provisioned instance's bearers (it generates the secrets),
  // and its tools use them. Neither reaches these routes there; the owner comes in signed in.
  it('the control plane\'s credentials are refused on a provisioned instance: the admin bearer and the instance bearer', async () => {
    const p = seedPerson();
    const { body: pv } = await preview(p.subjectId);
    vi.stubEnv('LYNOX_HTTP_ADMIN_SECRET', ADMIN);
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-test');
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    const asAdminBearer = { Authorization: `Bearer ${ADMIN}` };
    const pr = await preview(p.subjectId, asAdminBearer);
    expect(pr.status).toBe(403);
    expect(String(pr.body['error'])).toContain('control plane reaches admin routes only');
    expect((await erase({ subjectId: p.subjectId, plan: pv['plan'] }, asAdminBearer)).status).toBe(403);
    const asInstanceBearer = { Authorization: `Bearer ${SECRET}` };
    const ib = await preview(p.subjectId, asInstanceBearer);
    expect(ib.status).toBe(403);
    expect(ib.body['code']).toBe('session_required');
    const ie = await erase({ subjectId: p.subjectId, plan: pv['plan'] }, asInstanceBearer);
    expect(ie.status).toBe(403);
    expect(ie.body['code']).toBe('session_required');
    expect(subjectExists(p.subjectId)).toBe(true);
    expect(auditRows(p.subjectId)).toEqual([]);
  });

  it('lets the signed-in owner erase on a managed instance: no managed-instance refusal', async () => {
    const p = seedPerson();
    vi.stubEnv('LYNOX_HTTP_ADMIN_SECRET', ADMIN);
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-test');
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    const asOwner = { cookie: `lynox_session=${webUiLoginSession(SECRET, null)!.token}` };
    const { status, body: pv } = await preview(p.subjectId, asOwner);
    expect(status).toBe(200);
    expect((await erase({ subjectId: p.subjectId, plan: pv['plan'] }, asOwner)).status).toBe(200);
    expect(subjectExists(p.subjectId)).toBe(false);
  });

  it('keeps the instance bearer working on a self-hosted instance, where no control plane holds it', async () => {
    const p = seedPerson();
    const { status, body: pv } = await preview(p.subjectId);
    expect(status).toBe(200);
    expect((await erase({ subjectId: p.subjectId, plan: pv['plan'] })).status).toBe(200);
  });
});
