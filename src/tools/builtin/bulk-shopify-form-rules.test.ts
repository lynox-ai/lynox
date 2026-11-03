import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlanTool } from './bulk.js';
import { EngineDb } from '../../core/engine-db.js';
import { BulkLedger } from '../../core/bulk-ledger.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { validateToolInput } from '../../core/tool-input-validator.js';
import type { IAgent } from '../../types/index.js';

/**
 * The bulk_plan schema names the Shopify forms but not their rules, so a refused plan in such a
 * form carries all of them: the checks stop at the first fault they meet, and a model would learn
 * the rest one refusal at a time (measured with tests/online/bulk-plan-shopify-form-eval.test.ts).
 */
const HOST = 'acme.myshopify.com';
// The store connection of HOST, granted the scope image alt texts need (`shopifyMediaWritable`), so a
// plan in the image form gets past the scope check to what this file tests.
const IMAGE_WRITING_STORE = {
  getByHostname: (h: string) => h === HOST ? { base_url: `https://${HOST}`, auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: HOST.split('.')[0] } } }, oauth_grant: { granted_scope: ['read_products', 'write_products', 'write_files'] } } : undefined,
};
const FLAG = 'LYNOX_FEATURE_SHOPIFY_BULK_READ';
const PRODUCT_RULES = 'Form shopify plans the products of target_host (<store>.myshopify.com): no path, filters, id_field or write_method; source_list.after sets only title, seo_title, seo_description, each as text or null; a judge (then without after) sets only the same fields, each of type "string". For the images of the products, use form shopify_media.';
const IMAGE_RULES = 'Form shopify_media plans the images of the products of target_host (<store>.myshopify.com): no path, filters, id_field, write_method or judge; source_list.after sets only alt, as text of at most 512 characters or null. For product fields, use form shopify.';

// The placeholder refusals word for word: they are prompt surface, and the measured switch to a
// judge (tests/online/bulk-plan-shopify-form-eval.test.ts, case s3) rests on this wording.
const PLACEHOLDER_REFUSAL = 'source_list.after holds a placeholder such as {{name}} or {title}: a list\'s after is written as it stands into every target, and nothing fills it in. Give the literal text; for a value that differs per target, use a judge where the form takes one. If the user wants such braces as literal text, plan a judge whose rule gives that exact text, or tell the user in one sentence that a fixed text cannot hold them; never drop the braces without saying so.';
const PLACEHOLDER_REFUSAL_MEDIA = 'source_list.after holds a placeholder such as {{name}} or {title}: a list\'s after is written as it stands into every target, and nothing fills it in. Form shopify_media writes one alt text into every image and takes no judge: give that one text, without such braces. If the user wanted a different alt text per image, or braces as literal text, tell them in one sentence that this run cannot do that.';

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

const agent = (): IAgent => ({ toolContext: { bulkLedger: ledger, apiStore: IMAGE_WRITING_STORE }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL }) as unknown as IAgent;
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

// fileUpdate needs write_files or write_themes, which the Shopify preset never asks for: an image
// plan over such a connection would be approved and then fail at Shopify for every target.
describe('an image plan on a store connection that may not write image alt texts', () => {
  const NO_SCOPE = "source_list.form shopify_media writes image alt texts through fileUpdate, which needs a Shopify connection granted write_files or write_themes; the Shopify connection lynox sets up asks for neither, so a bulk run cannot change image alt texts in this store. Tell the user in one sentence that a bulk run cannot change image alt texts here, and offer to write alt texts in this chat from the product names and what the user says about the images, so they can enter them in Shopify themselves. Do not suggest reconnecting the store or changing the connection.";
  const NOTE = "Image alt texts: a bulk run cannot change them in this store, because its Shopify connection may not write files. If the user asks to change alt texts for many images, tell them so in one sentence and offer to write alt texts in this chat from the product names and what the user says about the images, so they can enter them in Shopify themselves.";
  const connection = (profile: unknown) => ({ getByHostname: (h: string) => h === HOST ? profile : undefined });
  const planOn = (store: unknown, input: Record<string, unknown>): Promise<string> =>
    bulkPlanTool.handler({ target_system: 'http', target_host: HOST, ...input } as Parameters<typeof bulkPlanTool.handler>[0],
      ({ toolContext: { bulkLedger: ledger, apiStore: store }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL }) as unknown as IAgent);
  const runs = (): unknown => engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get();
  // The engine's own Shopify connection to HOST, as `api_setup` saves it.
  const preset = (grant: Record<string, unknown> | undefined, over: { presetId?: string; shop?: string; scope?: string } = {}) => ({
    base_url: `https://${over.shop ?? 'acme'}.myshopify.com`,
    auth: { type: 'oauth2', oauth: { preset_id: over.presetId ?? 'shopify', preset_params: { shop: over.shop ?? 'acme' }, scope: over.scope ?? 'read_products write_products' } },
    ...(grant ? { oauth_grant: grant } : {}),
  });

  it.each([
    // Also what a host with two profiles gives: the API store names none of them (`getByHostname`).
    ['no connection for the store', null],
    ['a preset connection granted the product scopes only', connection(preset({ granted_scope: ['read_products', 'write_products'] }))],
    ['a preset connection with no recorded grant', connection(preset(undefined))],
    ['a profile naming a preset this engine does not have, granted write_files', connection(preset({ granted_scope: ['write_files'] }, { presetId: 'example-shop' }))],
    // A whole connection to another store, granted the scope: it is not the one this host's write attaches.
    ['a connection to another store granted write_files', connection(preset({ granted_scope: ['write_files'] }, { shop: 'other' }))],
    ['a profile that is no OAuth connection', connection({ base_url: `https://${HOST}`, auth: { type: 'bearer' }, oauth_grant: { granted_scope: ['write_files'] } })],
  ])('refuses it with its own reason, without the form\'s rules, over %s', async (_what, store) => {
    const answer = await planOn(store, { source_list: { form: 'shopify_media', after: { alt: 'x' } } });
    expect(answer).toBe(`Error: ${NO_SCOPE}`);
    expect(runs()).toEqual({ n: 0 });
  });

  // A host that is no store is refused for that: the scope reason would send the user the wrong way.
  it('refuses an image plan on a host that is no store for the host, not for the scope', async () => {
    const answer = await bulkPlanTool.handler({ target_system: 'http', target_host: 'shop.acme.ch', source_list: { form: 'shopify_media', after: { alt: 'x' } } } as Parameters<typeof bulkPlanTool.handler>[0],
      ({ toolContext: { bulkLedger: ledger, apiStore: connection(null) }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL }) as unknown as IAgent);
    expect(answer.startsWith('Error: source_list.form shopify_media reads a store: target_host must be <store>.myshopify.com.'), answer).toBe(true);
    expect(answer).not.toContain('write_files');
  });

  it.each([
    ['write_files', ['read_products', 'write_files']],
    ['write_themes', ['read_products', 'write_themes']],
  ])('records it over a connection granted %s', async (_scope, granted) => {
    const answer = await planOn(connection(preset({ granted_scope: granted })), { source_list: { form: 'shopify_media', after: { alt: 'x' } } });
    expect(answer).toMatch(/^List dry run recorded/);
    expect(runs()).toEqual({ n: 1 });
  });

  it('refuses the image form before its other checks, so a judge or write method does not hide it', async () => {
    const store = connection(preset({ granted_scope: ['read_products', 'write_products'] }));
    expect(await planOn(store, { write_method: 'PUT', source_list: { form: 'shopify_media', after: { alt: 'x' } } })).toBe(`Error: ${NO_SCOPE}`);
    expect(await planOn(store, { source_list: { form: 'shopify_media' }, judge: { rule: 'r', schema: { alt: { type: 'string', maxLength: 100 } } } })).toBe(`Error: ${NO_SCOPE}`);
  });

  it('records a product plan over the same connection; its refusals and the host hint do not name the image form and carry the bulk-run note', async () => {
    const store = connection(preset({ granted_scope: ['read_products', 'write_products'] }));
    expect(await planOn(store, { source_list: { form: 'shopify', after: { seo_title: 'x' } } })).toMatch(/^List dry run recorded/);
    const refused = await planOn(store, { write_method: 'PUT', source_list: { form: 'shopify', after: { title: 'x' } } });
    expect(refused.endsWith(` ${PRODUCT_RULES.replace(' For the images of the products, use form shopify_media.', '')} ${NOTE}`), refused).toBe(true);
    expect(refused).not.toContain('shopify_media');
    const woo = await planOn(store, { source_list: { form: 'woocommerce', path: '/admin/api/2025-01/products.json', after: { title: 'x' } } });
    expect(woo.endsWith(` target_host is a Shopify store: to change its products across the store, plan with source_list and form shopify (product fields). ${NOTE}`), woo).toBe(true);
    expect(woo).not.toContain('shopify_media');
  });
});
