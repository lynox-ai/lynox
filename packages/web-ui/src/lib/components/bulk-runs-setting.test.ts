import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bulkRunsView } from './bulk-runs-setting.js';

/**
 * The owner's bulk-runs switch on the tool-permissions page (UX-031): what it shows for each answer
 * of `GET /api/config`, its texts, and its wiring. Source is read for the i18n and wiring checks,
 * not imported: `i18n.svelte.ts` holds the locale in a `$state` rune.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const I18N = read('../i18n.svelte.ts');
const COMPONENT = read('./BulkRunsSetting.svelte');
const PAGE = read('../../routes/app/settings/policy-tools/+page.svelte');
const PAGE_SERVER = read('../../routes/app/settings/policy-tools/+page.server.ts');
const HTTP_API = read('../../../../../src/server/http-api.ts');

function entry(key: string): { de: string; en: string } | null {
	const lines = I18N.split('\n').filter((l) => l.trimStart().startsWith(`'${key}':`));
	if (lines.length !== 1) return null;
	const de = /\bde:\s*'((?:[^'\\]|\\.)*)'/.exec(lines[0]!);
	const en = /\ben:\s*'((?:[^'\\]|\\.)*)'/.exec(lines[0]!);
	return de && en ? { de: de[1]!, en: en[1]! } : null;
}

const bulk = (b: { on: boolean; source: 'config' | 'control-plane'; allowed: boolean; shopify: boolean }, managed?: string): unknown =>
	managed === undefined ? { bulk_runs: b } : { bulk_runs: b, managed };

describe('what the bulk-runs switch shows', () => {
	it('the owner switches it where the config decides, on and off', () => {
		expect(bulkRunsView(bulk({ on: false, source: 'config', allowed: true, shopify: false })))
			.toEqual({ on: false, lockedKey: null, lockedNextKey: null, shopifyKey: null });
		expect(bulkRunsView(bulk({ on: true, source: 'config', allowed: true, shopify: true }, 'hosted')))
			.toEqual({ on: true, lockedKey: null, lockedNextKey: null, shopifyKey: null });
	});

	it('on a pool tier lynox opened, the owner switches it too', () => {
		expect(bulkRunsView(bulk({ on: false, source: 'control-plane', allowed: true, shopify: true }, 'managed')))
			.toEqual({ on: false, lockedKey: null, lockedNextKey: null, shopifyKey: null });
	});

	it('on a pool tier lynox did not open, it is locked and names support', () => {
		expect(bulkRunsView(bulk({ on: false, source: 'control-plane', allowed: false, shopify: false }, 'managed')))
			.toEqual({ on: false, lockedKey: 'bulk.setting.locked_pool', lockedNextKey: null, shopifyKey: null });
	});

	it('without an engine database it is locked, with the next step per kind of instance', () => {
		expect(bulkRunsView(bulk({ on: false, source: 'config', allowed: false, shopify: false })))
			.toEqual({ on: false, lockedKey: 'bulk.setting.locked_db', lockedNextKey: 'bulk.setting.locked_db_selfhost', shopifyKey: null });
		expect(bulkRunsView(bulk({ on: false, source: 'config', allowed: false, shopify: false }, 'hosted')))
			.toEqual({ on: false, lockedKey: 'bulk.setting.locked_db', lockedNextKey: 'bulk.setting.locked_db_managed', shopifyKey: null });
	});

	it('bulk runs on without the Shopify read add a line, per kind of instance', () => {
		expect(bulkRunsView(bulk({ on: true, source: 'config', allowed: true, shopify: false }))?.shopifyKey).toBe('bulk.setting.shopify_selfhost');
		expect(bulkRunsView(bulk({ on: true, source: 'config', allowed: true, shopify: false }, 'hosted'))?.shopifyKey).toBe('bulk.setting.shopify_managed');
		expect(bulkRunsView(bulk({ on: true, source: 'control-plane', allowed: true, shopify: false }, 'managed'))?.shopifyKey).toBe('bulk.setting.shopify_managed');
		// Off, the line would promise nothing: bulk runs are the first thing to turn on.
		expect(bulkRunsView(bulk({ on: false, source: 'config', allowed: true, shopify: false }))?.shopifyKey).toBeNull();
	});

	it('an empty tier counts as self-hosted', () => {
		expect(bulkRunsView(bulk({ on: true, source: 'config', allowed: true, shopify: false }, ''))?.shopifyKey).toBe('bulk.setting.shopify_selfhost');
	});

	it('an answer without a readable bulk_runs shows no section', () => {
		for (const config of [null, 'x', {}, { bulk_runs: null }, { bulk_runs: { on: 'yes', source: 'config', allowed: true, shopify: true } },
			{ bulk_runs: { on: true, source: 'owner', allowed: true, shopify: true } }, { bulk_runs: { on: true, source: 'config', shopify: true } },
			{ bulk_runs: { on: true, source: 'config', allowed: true } }]) {
			expect(bulkRunsView(config)).toBeNull();
		}
	});

	it('the engine sends the fields this reads, under the same names', () => {
		const at = HTTP_API.indexOf("redacted['bulk_runs'] = {");
		expect(at).toBeGreaterThan(-1);
		const block = HTTP_API.slice(at, HTTP_API.indexOf('};', at));
		for (const field of ['on:', 'source,', 'allowed:', 'shopify:']) expect(block).toContain(field);
		expect(HTTP_API).toContain("redacted['managed'] = ");
	});
});

describe('the texts of the bulk-runs switch', () => {
	it('match ux U-053 and the engine-database wording', () => {
		expect(entry('bulk.setting.title')).toEqual({ de: 'Massenläufe', en: 'Bulk runs' });
		expect(entry('bulk.setting.switch')).toEqual({ de: 'Massenläufe erlauben', en: 'Allow bulk runs' });
		expect(entry('bulk.setting.description')?.de).toBe('Ein Massenlauf ändert viele Einträge auf einmal, zum Beispiel Produkttexte in Shopify. Du siehst vorher eine Vorschau und gibst ihn frei.');
		expect(entry('bulk.setting.locked_pool')?.de).toBe('Auf dieser Instanz schaltet lynox Massenläufe frei. Schreib dazu an support@lynox.ai.');
		expect(entry('bulk.setting.locked_db')?.de).toBe('Massenläufe brauchen die Engine-Datenbank, und die liess sich beim Start dieser Instanz nicht öffnen.');
		expect(entry('bulk.setting.locked_db_selfhost')?.en).toBe('The startup log names the reason under “EngineDb init failed”.');
		expect(entry('bulk.setting.locked_db_managed')?.de).toBe('Schreib dazu an support@lynox.ai.');
		expect(entry('bulk.setting.shopify_selfhost')?.de).toBe('Für Shopify-Shops schaltest du zusätzlich das Lesen frei (LYNOX_FEATURE_SHOPIFY_BULK_READ).');
		expect(entry('bulk.setting.shopify_managed')?.en).toBe('For Shopify stores, write to support@lynox.ai.');
	});

	it('every key the view can return has both languages', () => {
		for (const key of ['bulk.setting.locked_pool', 'bulk.setting.locked_db', 'bulk.setting.locked_db_selfhost', 'bulk.setting.locked_db_managed',
			'bulk.setting.shopify_selfhost', 'bulk.setting.shopify_managed', 'bulk.setting.description']) {
			expect(entry(key), key).not.toBeNull();
		}
	});
});

describe('the wiring of the bulk-runs switch', () => {
	it('the page mounts it above the tool list, for the owner only', () => {
		const guard = PAGE.indexOf('{#if data.owner}');
		const mount = PAGE.indexOf('<BulkRunsSetting />');
		expect(guard).toBeGreaterThan(-1);
		expect(mount).toBeGreaterThan(guard);
		expect(PAGE.indexOf('{/if}', guard)).toBeGreaterThan(mount);
		expect(PAGE.indexOf('<ToolToggles />')).toBeGreaterThan(mount);
		expect(PAGE_SERVER).toContain("owner: !secret || isOwnerSession(cookies.get('lynox_session'), secret)");
	});

	it('it writes bulk_runs_enabled, reads the config again after every save, and locks where it must', () => {
		expect(COMPONENT).toContain('JSON.stringify({ bulk_runs_enabled: next })');
		expect(COMPONENT).toMatch(/finally \{[\s\S]*?await load\(\);[\s\S]*?\}/);
		expect(COMPONENT).toContain('disabled={saving || view.lockedKey !== null}');
		expect(COMPONENT).toContain('if (!view || view.lockedKey !== null || saving) return;');
		expect(COMPONENT).toContain('aria-checked={view.on}');
	});
});
