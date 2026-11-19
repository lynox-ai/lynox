import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { Engine } from '../core/engine.js';
import type { CapabilityContract } from '../types/capability-contract.js';

/**
 * What `GET /api/workflows/library` tells each reader of a workflow's capability contract,
 * through a real engine and the real dispatcher: the owner reads it all; a mandate reads no allowed
 * values or bounds, and no contract of a workflow it may not schedule.
 */

const SECRET = `t-${randomBytes(12).toString('hex')}`;
const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED'];
type Inner = { engine: Engine; rateCounts: Map<string, unknown>; server: Server | null };
type Card = { id: string; capabilityContract?: Record<string, unknown>; schedule_refusal?: string };

const CONTRACT: CapabilityContract = {
  version: 1, grantedTools: ['http_request'], httpMethods: ['POST'], hostPatterns: ['api.partner.example'], pathPatterns: ['/v1/invoices'],
  paramConstraints: { region: { enum: ['ch', 'de'] }, count: { min: 1, max: 10 } },
};
/** A workflow saved without a contract (an explicit `undefined` would take the default). */
const NONE = Symbol('no contract');
const WITHOUT_VALUES = { version: 1, grantedTools: ['http_request'], httpMethods: ['POST'], hostPatterns: ['api.partner.example'], pathPatterns: ['/v1/invoices'] };

const saved: Record<string, string | undefined> = {};

describe('the workflow library shows each reader the contract it may read (real engine)', () => {
  let dir: string;
  let api: LynoxHTTPApi;
  let base: string;
  let ownerCookie: string;
  let mandateCookie: string;

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // A mandate is let in only on the durable memory tools, as on the fleet.
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    dir = mkdtempSync(join(tmpdir(), 'lynox-library-viewer-'));
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as Inner).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('fixture: no port');
    base = `http://127.0.0.1:${String(addr.port)}`;
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const m = loginSession(SECRET, {
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-IDA',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    const o = loginSession(SECRET, null)?.token;
    if (m === undefined || o === undefined) throw new Error('fixture: no cookie');
    mandateCookie = m;
    ownerCookie = o;
    const history = (api as unknown as Inner).engine.getRunHistory()!;
    const save = (id: string, author: Parameters<typeof history.insertPlannedPipeline>[1], contract: unknown = CONTRACT): void => {
      history.insertPlannedPipeline({
        id, name: id, goal: 'g', steps: [{ id: 's1', task: 't' }], reasoning: '', estimatedCost: 0,
        createdAt: '2026-01-01T00:00:00.000Z', template: true, ...(contract === NONE ? {} : { capabilityContract: contract as CapabilityContract }),
      }, author);
    };
    save('wf-owner', { kind: 'owner' });
    save('wf-ida', { kind: 'mandate', email: 'ida@example.invalid', mandateId: 'TEST-MANDATE-IDA' });
    save('wf-ole', { kind: 'mandate', email: 'ole@example.invalid', mandateId: 'TEST-MANDATE-OLE' });
    // A contract with a field the consent does not show, as an import or a later version may store.
    save('wf-extra', { kind: 'owner' }, { ...CONTRACT, extraField: 'only-the-owner-reads-this' });
    // A stored contract that is not an object, and a workflow with none.
    save('wf-junk', { kind: 'owner' }, ['api.partner.example']);
    save('wf-none', { kind: 'owner' }, NONE);
    // A workflow whose authorship cannot be read: refused to a mandate as `unreadable`.
    save('wf-unread', { kind: 'owner' });
    const read = history.getWorkflowAuthorship.bind(history);
    history.getWorkflowAuthorship = (id: string) => {
      if (id === 'wf-unread') throw new Error('authorship read failed');
      return read(id);
    };
  }, 120_000);

  afterAll(async () => {
    await api?.shutdown();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const library = async (headers: Record<string, string>): Promise<Map<string, Card>> => {
    (api as unknown as Inner).rateCounts.clear();
    const res = await fetch(`${base}/api/workflows/library`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json() as { workflows: Card[] };
    return new Map(body.workflows.map((w) => [w.id, w]));
  };

  it('gives the owner every contract whole, allowed values and bounds included, by cookie and by bearer', async () => {
    for (const headers of [{ cookie: `lynox_session=${ownerCookie}` }, { authorization: `Bearer ${SECRET}` }]) {
      const cards = await library(headers);
      for (const id of ['wf-owner', 'wf-ida', 'wf-ole', 'wf-unread']) expect(cards.get(id)?.capabilityContract).toEqual(CONTRACT);
      expect(cards.get('wf-extra')?.capabilityContract).toEqual({ ...CONTRACT, extraField: 'only-the-owner-reads-this' });
      expect(cards.get('wf-junk')?.capabilityContract).toEqual(['api.partner.example']);
      expect(cards.get('wf-none')).not.toHaveProperty('capabilityContract');
    }
  });

  it('gives a mandate no allowed values or bounds, and the rest of the contract only of a workflow it may schedule', async () => {
    const cards = await library({ cookie: `lynox_session=${mandateCookie}` });
    // Its own and the owner's: schedulable, so the consent's hosts, paths, methods and tools stay.
    for (const id of ['wf-ida', 'wf-owner']) {
      expect(cards.get(id)?.schedule_refusal).toBeUndefined();
      expect(cards.get(id)?.capabilityContract).toEqual(WITHOUT_VALUES);
    }
    // Another mandate's: listed as not its to schedule, without anything of its contract.
    expect(cards.get('wf-ole')?.schedule_refusal).toBe('foreign');
    expect(cards.get('wf-ole')).not.toHaveProperty('capabilityContract');
    // One whose authorship cannot be read: refused the same way, and its contract withheld too.
    expect(cards.get('wf-unread')?.schedule_refusal).toBe('unreadable');
    expect(cards.get('wf-unread')).not.toHaveProperty('capabilityContract');
  });

  it('gives a mandate only the fields the consent shows, so a field a contract gains is not one of them', async () => {
    const cards = await library({ cookie: `lynox_session=${mandateCookie}` });
    expect(cards.get('wf-extra')?.capabilityContract).toEqual(WITHOUT_VALUES);
    // A stored contract that is not an object reaches a mandate as nothing, and one with none as none.
    expect(cards.get('wf-junk')).not.toHaveProperty('capabilityContract');
    expect(cards.get('wf-none')).not.toHaveProperty('capabilityContract');
  });

  it('puts no allowed value, bound or unshown field anywhere in a mandate\'s answer, and no host or path of a workflow it may not schedule', async () => {
    (api as unknown as Inner).rateCounts.clear();
    const res = await fetch(`${base}/api/workflows/library`, { headers: { cookie: `lynox_session=${mandateCookie}` } });
    const text = await res.text();
    for (const stored of ['"ch"', '"de"', '"min"', '"max"', 'paramConstraints', 'only-the-owner-reads-this']) expect(text).not.toContain(stored);
    // The hosts and paths it reads are those of the workflows it may schedule with a contract it can
    // read (its own, the owner's, the owner's with an extra field): three. The host is stored in six
    // workflows (the malformed one holds it too), the path in five.
    expect(text.split('api.partner.example').length - 1).toBe(3);
    expect(text.split('/v1/invoices').length - 1).toBe(3);
  });
});
