import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlanTool } from './bulk.js';
import { EngineDb } from '../../core/engine-db.js';
import { BulkLedger } from '../../core/bulk-ledger.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import type { IAgent } from '../../types/index.js';

/**
 * The bulk_plan schema names the Shopify forms but not their rules, so a refused plan in such a
 * form carries all of them: the checks stop at the first fault they meet, and a model would learn
 * the rest one refusal at a time (measured with tests/online/bulk-plan-shopify-form-eval.test.ts).
 */
const HOST = 'acme.myshopify.com';
const FLAG = 'LYNOX_FEATURE_SHOPIFY_BULK_READ';
const PRODUCT_RULES = 'Form shopify plans the products of target_host (<store>.myshopify.com): no path, filters, id_field or write_method; source_list.after (or a judge\'s schema, without after) sets only title, seo_title, seo_description, each as text or null. For the images of the products, use form shopify_media.';
const IMAGE_RULES = 'Form shopify_media plans the images of the products of target_host (<store>.myshopify.com): no path, filters, id_field, write_method or judge; source_list.after sets only alt, as text of at most 512 characters or null. For product fields, use form shopify.';

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-form-rules-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
  vi.stubEnv(FLAG, '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const agent = (): IAgent => ({ toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL }) as unknown as IAgent;
const plan = (input: Record<string, unknown>): Promise<string> =>
  bulkPlanTool.handler({ target_system: 'http', target_host: HOST, ...input } as Parameters<typeof bulkPlanTool.handler>[0], agent());

describe('a refused bulk_plan in a Shopify form', () => {
  it.each([
    ['write_method', { write_method: 'PUT', source_list: { form: 'shopify', after: { seo_description: 'x' } } }, 'source_list.form shopify does not take write_method'],
    ['a nested after', { source_list: { form: 'shopify', after: { seo: { description: 'x' } } } }, 'source_list.after may only hold text, numbers, true/false or null.'],
    ['a field the store cannot be written', { source_list: { form: 'shopify', after: { vendor: 'x' } } }, 'source_list.after may only set: title, seo_title, seo_description.'],
    ['a path', { source_list: { form: 'shopify', path: '/admin/api/2025-01/products.json', after: { title: 'x' } } }, 'source_list.path is not given for form shopify'],
    ['a judge with after', { source_list: { form: 'shopify', after: { seo_title: null } }, judge: { rule: 'r', schema: { seo_title: { type: 'string', maxLength: 70 } } } }, 'With judge, source_list takes no "after"'],
  ])('in form shopify, refused for %s, says the refusal and then every rule of the form', async (_what, input, refusal) => {
    const answer = await plan(input);
    expect(answer.startsWith(`Error: ${refusal}`), answer).toBe(true);
    expect(answer.endsWith(` ${PRODUCT_RULES}`), answer).toBe(true);
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });

  it.each([
    ['write_method', { write_method: 'PUT', source_list: { form: 'shopify_media', after: { alt: 'x' } } }, 'source_list.form shopify_media does not take write_method'],
    ['a product field', { source_list: { form: 'shopify_media', after: { title: 'x' } } }, 'source_list.after may only set: alt.'],
    ['a judge', { source_list: { form: 'shopify_media' }, judge: { rule: 'r', schema: { alt: { type: 'string', maxLength: 100 } } } }, 'source_list.form shopify_media does not take judge yet'],
  ])('in form shopify_media, refused for %s, says the refusal and then every rule of the form', async (_what, input, refusal) => {
    const answer = await plan(input);
    expect(answer.startsWith(`Error: ${refusal}`), answer).toBe(true);
    expect(answer.endsWith(` ${IMAGE_RULES}`), answer).toBe(true);
  });

  it('a plan in the right form is recorded, without the rules', async () => {
    const answer = await plan({ source_list: { form: 'shopify', after: { seo_description: 'x' } } });
    expect(answer).toMatch(/^List dry run recorded/);
    expect(answer).not.toContain('Form shopify plans');
  });

  it('with the Shopify read switched off, the refusal says only that', async () => {
    vi.stubEnv(FLAG, '0');
    expect(await plan({ source_list: { form: 'shopify', after: { title: 'x' } } }))
      .toBe('Error: Reading a Shopify store in a bulk run is switched off on this instance.');
  });

  it('a refused plan in another form gets no Shopify rules', async () => {
    const answer = await plan({ target_host: 'shop.example.com', source_list: { form: 'woocommerce', path: '/nope', after: { name: 'x' } } });
    expect(answer).toMatch(/^Error: /);
    expect(answer).not.toContain('Form shopify');
  });
});
