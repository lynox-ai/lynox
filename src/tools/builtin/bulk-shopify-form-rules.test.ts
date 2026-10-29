import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlanTool } from './bulk.js';
import { EngineDb } from '../../core/engine-db.js';
import { BulkLedger } from '../../core/bulk-ledger.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { validateToolInput } from '../../core/tool-input-validator.js';
import { PLACEHOLDER_REFUSAL, PLACEHOLDER_REFUSAL_MEDIA } from '../../core/bulk-list.js';
import type { IAgent } from '../../types/index.js';

/**
 * The bulk_plan schema names the Shopify forms but not their rules, so a refused plan in such a
 * form carries all of them: the checks stop at the first fault they meet, and a model would learn
 * the rest one refusal at a time (measured with tests/online/bulk-plan-shopify-form-eval.test.ts).
 */
const HOST = 'acme.myshopify.com';
const FLAG = 'LYNOX_FEATURE_SHOPIFY_BULK_READ';
const PRODUCT_RULES = 'Form shopify plans the products of target_host (<store>.myshopify.com): no path, filters, id_field or write_method; source_list.after sets only title, seo_title, seo_description, each as text or null; a judge (then without after) sets only the same fields, each of type "string". For the images of the products, use form shopify_media.';
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

  it('a refused plan on a Shopify store in another form, or from a file, names the Shopify forms', async () => {
    const HINT = ' target_host is a Shopify store: to change its products across the store, plan with source_list and form shopify (product fields) or shopify_media (image alt texts).';
    const woo = await plan({ source_list: { form: 'woocommerce', path: '/admin/api/2025-01/products.json', after: { title: 'x' } } });
    expect(woo.startsWith('Error: source_list.path is not a list of the form woocommerce.'), woo).toBe(true);
    expect(woo.endsWith(HINT), woo).toBe(true);
    const file = await plan({ source_file: 'products.json' });
    expect(file.startsWith('Error: The source file'), file).toBe(true);
    expect(file.endsWith(HINT), file).toBe(true);
    // A Shopify form carries its rules instead, not both.
    expect(await plan({ write_method: 'PUT', source_list: { form: 'shopify', after: { title: 'x' } } })).not.toContain('target_host is a Shopify store');
    // With the read off, both forms are refused anyway: no hint that points there.
    vi.stubEnv(FLAG, '0');
    expect(await plan({ source_file: 'products.json' })).not.toContain('target_host is a Shopify store');
  });

  it('a refused plan in another form gets no Shopify rules', async () => {
    const answer = await plan({ target_host: 'shop.example.com', source_list: { form: 'woocommerce', path: '/nope', after: { name: 'x' } } });
    // Exactly the refusal, nothing appended.
    expect(answer).toBe('Error: source_list.path is not a list of the form woocommerce.');
  });
});

describe('a placeholder in a list\'s after', () => {
  // The after-state is written as it stands into every target: a placeholder would land verbatim.
  it.each([
    ['shopify', { title: '{{ truncate(name, 60) }}' }],
    ['shopify', { seo_title: '{{ truncate(title, 60) | lower }}' }],
    ['shopify', { seo_description: '{title} | Bergladen' }],
    ['shopify', { seo_title: 'Buy ${a + b} now' }],
    ['shopify', { seo_title: '%%title%% %%sep%% Shop' }],
    ['shopify', { seo_title: '{Größe} – Shop' }],
    ['shopify', { seo_title: '{product-name} | Shop' }],
    ['shopify', { seo_title: '{ product name } | Shop' }],
    ['shopify', { seo_title: '{0} | Shop' }],
    ['shopify', { seo_title: '{$title} | Shop' }],
    ['shopify', { title: 'Fixed', seo_title: null, seo_description: '{{ description }}' }],
    ['shopify', { seo_title: '{% if x %}a{% endif %}' }],
    ['shopify', { seo_title: '<%= title %>' }],
  ])('in form %s, %j is refused and nothing is recorded', async (form, after) => {
    const answer = await plan({ source_list: { form, after } });
    expect(answer.startsWith(`Error: ${PLACEHOLDER_REFUSAL}`), answer).toBe(true);
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });

  it('in form shopify_media, says that no judge can write such a text', async () => {
    const answer = await plan({ source_list: { form: 'shopify_media', after: { alt: '{{ product.title }}' } } });
    expect(answer.startsWith(`Error: ${PLACEHOLDER_REFUSAL_MEDIA}`), answer).toBe(true);
    expect(answer).not.toContain('use a judge');
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });

  it('in another form too', async () => {
    const answer = await plan({ target_host: 'shop.example.com', source_list: { form: 'woocommerce', path: '/wp-json/wc/v3/products', after: { name: '{{name}} – Sale' } } });
    expect(answer).toBe(`Error: ${PLACEHOLDER_REFUSAL}`);
  });

  it('a literal text with braces that name nothing, and a judged plan, are recorded', async () => {
    expect(await plan({ source_list: { form: 'shopify', after: { seo_title: 'Sale {50%} – {} – }{ – 100% – $10 – [NEU]' } } })).toMatch(/^List dry run recorded/);
    expect(await plan({ target_host: 'shop.example.com', source_list: { form: 'woocommerce', path: '/wp-json/wc/v3/products', after: { name: 'Sale {50%}' } } })).toMatch(/^List dry run recorded|^Another external dry run/);
    expect(await plan({ source_list: { form: 'shopify' }, judge: { rule: 'r', schema: { seo_title: { type: 'string', maxLength: 70 } } } })).toMatch(/^List dry run recorded|^Another external dry run/);
  });
});

describe('the bulk_plan schema', () => {
  // The dispatch validator enforces `required` before the handler runs: a schema demanding
  // source_list.after refused every judged list plan, which takes none.
  it('lets a judged list plan without after through the dispatch validator', () => {
    const judged = { target_system: 'http', target_host: HOST, source_list: { form: 'shopify' }, judge: { rule: 'r', schema: { seo_title: { type: 'string', maxLength: 70 } } } };
    expect(validateToolInput(bulkPlanTool.definition.input_schema, judged)).toEqual({ ok: true, errors: [] });
  });
});
