import { describe, it, expect } from 'vitest';
import { bulkRunContract, externalRunWriter, type BulkApplyClientFor } from './bulk-external-writer.js';
import type { ExternalClient } from './bulk-external.js';
import type { BulkRunForApply } from './bulk-ledger.js';
import { contractGrants, type ShopifyApplyPhase } from '../tools/permission-guard.js';
import { shopifyProductReadBody, shopifyProductWriteBody } from './shopify-graphql.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// Which client, under which grant, the worker hands a run's apply or undo.

const HOST = 'acme.myshopify.com';
const ENDPOINT = `https://${HOST}/admin/api/2026-10/graphql.json`;
const P1 = 'gid://shopify/Product/101';
const AFTER = { title: 'Neu' };
const PHASE: ShopifyApplyPhase = { reads: [P1], writes: [{ form: 'shopify_product', gid: P1, after: AFTER }] };
const store: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: [],
  hostPatterns: [HOST], pathPatterns: [], paramConstraints: {},
};
const ordinary: CapabilityContract = { ...store, hostPatterns: ['shop.example.invalid'], httpMethods: ['GET', 'PUT'], pathPatterns: ['/items/*'] };
const run = (targetSystem: string, contract: CapabilityContract): BulkRunForApply => ({
  id: 'run-1', kind: 'apply', targetSystem, targetCollection: null, atomic: false, phase: 'approved', approvalChecksum: 'c',
  maxTargets: 1, expiresAt: null, applied: 0, failed: 0, haltReason: null, sourceRunId: null,
  contractJson: JSON.stringify(contract), delegatedPlanner: null,
});
const fakeClient = {} as ExternalClient;
function recording(): { calls: unknown[][]; clientFor: BulkApplyClientFor } {
  const calls: unknown[][] = [];
  return { calls, clientFor: (...args) => { calls.push(args); return fakeClient; } };
}

describe('externalRunWriter', () => {
  it('hands a Shopify run a client granted the apply phase its rows hold, and nothing else', () => {
    const { calls, clientFor } = recording();
    const r = run(`http:${HOST}`, store);
    expect(externalRunWriter(r, { shopifyApplyOf: () => PHASE, startDomainsOf: () => [] }, clientFor)).not.toBeNull();
    expect(calls).toEqual([[r, undefined, undefined, PHASE]]);
  });

  it('hands any other external run its stored contract, and writes with its one verb', () => {
    const { calls, clientFor } = recording();
    const r = run('http:shop.example.invalid', ordinary);
    expect(externalRunWriter(r, { shopifyApplyOf: () => null, startDomainsOf: () => [] }, clientFor)).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([r]);
  });

  it('has no writer without a client, or for a store host it cannot reach', () => {
    expect(externalRunWriter(run(`http:${HOST}`, store), { shopifyApplyOf: () => PHASE, startDomainsOf: () => [] }, () => null)).toBeNull();
    const { calls, clientFor } = recording();
    expect(externalRunWriter(run('http:not-a-store.example.invalid', store), { shopifyApplyOf: () => PHASE, startDomainsOf: () => [] }, clientFor)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('the read-back check of a written description (PRD shopify-preset §21.2 item 6, N5)', () => {
  const SCRIPT = '<script>steal()</script>';
  const kept = { title: 'T', descriptionHtml: `<p>Neu</p>${SCRIPT}`, seo: { title: null, description: null } };
  // A host that keeps whatever is written with a script appended, and reads it back so.
  const host = {
    track: () => () => null,
    graphqlWrite: async () => ({ kind: 'ok', value: {} }),
    graphqlRead: async () => ({ kind: 'ok', value: { product: { id: P1, ...kept } } }),
    write: async () => ({ kind: 'ok', value: {} }),
    get: async () => ({ kind: 'ok', value: { id: 1, description: `<p>Neu</p>${SCRIPT}` } }),
  } as unknown as ExternalClient;

  it('marks a product whose read-back holds markup the write never sent', async () => {
    // `shopifyApplyOf` names the form beside the phase.
    const w = externalRunWriter(run(`http:${HOST}`, store), { shopifyApplyOf: () => ({ ...PHASE, form: 'shopify_product' as const }), startDomainsOf: () => [] }, () => host)!;
    expect(await w.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p>' } })).toMatchObject({ result: 'written', hostAddedMarkup: true });
    // The same read-back of a field that was not sent is not the run's doing.
    expect(await w.write(P1, { absent: false, value: { title: 'T' } })).not.toHaveProperty('hostAddedMarkup');
  });

  it('takes the link domains of the run it writes for, not of another', async () => {
    const linked = { ...host, graphqlRead: async () => ({ kind: 'ok', value: { product: { id: P1, ...kept, descriptionHtml: '<p>Neu <a href="https://partner.example/">x</a></p>' } } }) } as unknown as ExternalClient;
    const domains = (id: string): string[] => (id === 'run-1' ? ['partner.example'] : []);
    const product = { shopifyApplyOf: () => ({ ...PHASE, form: 'shopify_product' as const }), startDomainsOf: domains };
    const own = externalRunWriter(run(`http:${HOST}`, store), product, () => linked)!;
    expect(await own.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p>' } })).not.toHaveProperty('hostAddedMarkup');
    const other = externalRunWriter({ ...run(`http:${HOST}`, store), id: 'run-2' }, product, () => linked)!;
    expect(await other.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p>' } })).toMatchObject({ hostAddedMarkup: true });
  });

  it('counts a read-back stored otherwise than sent, within what the run may write, and leaves one kept byte for byte unmarked', async () => {
    const product = { shopifyApplyOf: () => ({ ...PHASE, form: 'shopify_product' as const }), startDomainsOf: () => [] };
    const backing = (descriptionHtml: string): ExternalClient =>
      ({ ...host, graphqlRead: async () => ({ kind: 'ok', value: { product: { id: P1, ...kept, descriptionHtml } } }) }) as unknown as ExternalClient;
    const reformatted = externalRunWriter(run(`http:${HOST}`, store), product, () => backing('<p>Neu<br></p>'))!;
    const out = await reformatted.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu<br/></p>' } });
    expect(out).toMatchObject({ result: 'written', hostRewrote: true });
    expect(out).not.toHaveProperty('hostAddedMarkup');
    const wrapped = externalRunWriter(run(`http:${HOST}`, store), product, () => backing('<p>Neu</p>'))!;
    expect(await wrapped.write(P1, { absent: false, value: { descriptionHtml: 'Neu' } })).toMatchObject({ hostRewrote: true });
    const same = externalRunWriter(run(`http:${HOST}`, store), product, () => backing('<p>Neu</p>'))!;
    const kept1 = await same.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p>' } });
    expect(kept1).toMatchObject({ result: 'written' });
    expect(kept1).not.toHaveProperty('hostRewrote');
    // Markup the write never sent is the halt, never also the count.
    const marked = await externalRunWriter(run(`http:${HOST}`, store), product, () => host)!.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p>' } });
    expect(marked).toMatchObject({ hostAddedMarkup: true });
    expect(marked).not.toHaveProperty('hostRewrote');
  });

  it('marks a read-back with a stretch the parser drops that the write never sent', async () => {
    const product = { shopifyApplyOf: () => ({ ...PHASE, form: 'shopify_product' as const }), startDomainsOf: () => [] };
    const backing = (descriptionHtml: string): ExternalClient =>
      ({ ...host, graphqlRead: async () => ({ kind: 'ok', value: { product: { id: P1, ...kept, descriptionHtml } } }) }) as unknown as ExternalClient;
    for (const back of ['<body onload=alert(1)><p>Neu</p>', '<p>Neu</p></div>', '<p>N</div>eu</p>', '<p>N<body onload=alert(1)>eu</p>']) {
      const out = await externalRunWriter(run(`http:${HOST}`, store), product, () => backing(back))!.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p>' } });
      expect(out).toMatchObject({ result: 'written', hostAddedMarkup: true });
      expect(out).not.toHaveProperty('hostRewrote');
    }
    // A stretch the value sent held itself, kept as sent: not added.
    const held = await externalRunWriter(run(`http:${HOST}`, store), product, () => backing('<p>Neu</p></div>'))!.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p></div>' } });
    expect(held).not.toHaveProperty('hostAddedMarkup');
    // Held once, read back twice: the second copy is added.
    const twice = await externalRunWriter(run(`http:${HOST}`, store), product, () => backing('<p>Neu</p></div> </div>'))!.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p></div>' } });
    expect(twice).toMatchObject({ hostAddedMarkup: true });
  });

  it('counts a description the store cleared as stored otherwise than sent', async () => {
    const product = { shopifyApplyOf: () => ({ ...PHASE, form: 'shopify_product' as const }), startDomainsOf: () => [] };
    const cleared = { ...host, graphqlRead: async () => ({ kind: 'ok', value: { product: { id: P1, ...kept, descriptionHtml: null } } }) } as unknown as ExternalClient;
    expect(await externalRunWriter(run(`http:${HOST}`, store), product, () => cleared)!.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p>' } }))
      .toMatchObject({ result: 'written', hostRewrote: true });
  });

  it('counts nothing on a read-back that failed: the write is estimated', async () => {
    const product = { shopifyApplyOf: () => ({ ...PHASE, form: 'shopify_product' as const }), startDomainsOf: () => [] };
    const failing = { ...host, graphqlRead: async () => { throw new Error('down'); } } as unknown as ExternalClient;
    const out = await externalRunWriter(run(`http:${HOST}`, store), product, () => failing)!.write(P1, { absent: false, value: { descriptionHtml: 'Neu' } });
    expect(out).toMatchObject({ result: 'written', actual: { estimated: true } });
    expect(out).not.toHaveProperty('hostRewrote');
  });

  it('checks no field on the image form', async () => {
    const w = externalRunWriter(run(`http:${HOST}`, store), { shopifyApplyOf: () => ({ ...PHASE, form: 'shopify_media_alt' as const }), startDomainsOf: () => [] }, () => host)!;
    expect(await w.write(P1, { absent: false, value: { descriptionHtml: '<p>Neu</p>' } })).not.toHaveProperty('hostAddedMarkup');
  });

  it('checks no other form: a WooCommerce description keeps today\'s read-back', async () => {
    const w = externalRunWriter(run('http:shop.example.invalid', ordinary), { shopifyApplyOf: () => null, startDomainsOf: () => [] }, () => host)!;
    expect(await w.write('https://shop.example.invalid/items/1', { absent: false, value: { description: '<p>Neu</p>' } }))
      .toEqual({ result: 'written', actual: { value: { description: `<p>Neu</p>${SCRIPT}` }, estimated: false } });
  });
});

describe('bulkRunContract', () => {
  const post = (c: CapabilityContract | null, body: string | null): boolean =>
    c !== null && body !== null && contractGrants('http_request', { method: 'POST', url: ENDPOINT, headers: { 'content-type': 'application/json' }, body }, c);

  it('grants an apply phase its reads and writes on a copy, the stored contract untouched', () => {
    const c = bulkRunContract(store, `http:${HOST}`, { shopifyApply: PHASE });
    expect(post(c, shopifyProductWriteBody(P1, AFTER))).toBe(true);
    expect(post(c, shopifyProductReadBody(P1))).toBe(true);
    expect(post(store, shopifyProductWriteBody(P1, AFTER))).toBe(false);
  });

  it('grants a read phase no write', () => {
    const c = bulkRunContract(store, `http:${HOST}`, { shopifyRead: { phase: 'read', targets: [P1] } });
    expect(post(c, shopifyProductReadBody(P1))).toBe(true);
    expect(post(c, shopifyProductWriteBody(P1, AFTER))).toBe(false);
  });

  it('is the stored contract without a phase, and nothing for a phase it cannot grant', () => {
    expect(bulkRunContract(store, `http:${HOST}`, {})).toBe(store);
    expect(bulkRunContract(store, 'data_store', { shopifyApply: PHASE })).toBeNull();
    expect(bulkRunContract({ ...store, httpMethods: ['POST'] }, `http:${HOST}`, { shopifyApply: PHASE })).toBeNull();
  });
});
