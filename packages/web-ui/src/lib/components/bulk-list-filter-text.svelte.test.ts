import { describe, it, expect, afterEach } from 'vitest';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { bulkListFilterText } from './bulk-runs.js';

// The line naming a filtered Shopify list's group, rendered with the real texts (ux U-175): every
// value in its own quotes, the last after "or". One value reads byte for byte as it did before
// lists existed: the quotes moved out of the keys into `bulk.list.value`.
describe('the filter line of a Shopify list, word for word', () => {
	const before = getLocale();
	afterEach(() => setLocale(before));
	const line = (lang: 'de' | 'en', filters: Record<string, string | readonly string[]>): string | null => {
		setLocale(lang);
		return bulkListFilterText(filters, { t, tf });
	};

	it('reads one value as before', () => {
		expect(line('de', { product_type: 'Tee' })).toBe('Gelesen werden nur die Produkte vom Produkttyp „Tee“.');
		expect(line('de', { vendor: 'Acme' })).toBe('Gelesen werden nur die Produkte des Anbieters „Acme“.');
		expect(line('de', { product_type: 'Tee', vendor: 'Acme' })).toBe('Gelesen werden nur die Produkte vom Produkttyp „Tee“ und des Anbieters „Acme“.');
		expect(line('en', { product_type: 'Tee' })).toBe('Only the products of product type “Tee” are read.');
		expect(line('en', { vendor: 'Acme' })).toBe('Only the products of vendor “Acme” are read.');
		expect(line('en', { product_type: 'Tee', vendor: 'Acme' })).toBe('Only the products of product type “Tee” and vendor “Acme” are read.');
	});

	it('reads a list of values as ux decided it', () => {
		expect(line('de', { product_type: ['Zubehör', 'Filter', 'Kartuschen'] })).toBe('Gelesen werden nur die Produkte vom Produkttyp „Zubehör“, „Filter“ oder „Kartuschen“.');
		expect(line('de', { vendor: ['A', 'B'] })).toBe('Gelesen werden nur die Produkte des Anbieters „A“ oder „B“.');
		expect(line('de', { product_type: ['Tee', 'Kaffee'], vendor: 'Acme' })).toBe('Gelesen werden nur die Produkte vom Produkttyp „Tee“ oder „Kaffee“ und des Anbieters „Acme“.');
		expect(line('en', { product_type: ['A', 'B', 'C'] })).toBe('Only the products of product type “A”, “B” or “C” are read.');
		expect(line('en', { vendor: ['A', 'B'] })).toBe('Only the products of vendor “A” or “B” are read.');
		// A value that holds a placeholder's name stays text: the line fills each slot once.
		expect(line('en', { product_type: ['{vendor}', 'B'], vendor: 'Acme' })).toBe('Only the products of product type “{vendor}” or “B” and vendor “Acme” are read.');
	});
});
