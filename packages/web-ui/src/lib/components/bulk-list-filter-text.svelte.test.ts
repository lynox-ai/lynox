import { describe, it, expect, afterEach } from 'vitest';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { bulkListFilterFolded, bulkListFilterText, bulkListStatusText } from './bulk-runs.js';

// The line naming a filtered Shopify list's group, rendered with the real texts (ux U-175): every
// value in its own quotes, the last after "or". One value reads byte for byte as it did before
// lists existed: the quotes moved out of the keys into `bulk.list.value`.
describe('the filter line of a Shopify list, word for word', () => {
	const before = getLocale();
	afterEach(() => setLocale(before));
	const line = (lang: 'de' | 'en', filters: Record<string, string | readonly string[]>, folded = false): string | null => {
		setLocale(lang);
		return bulkListFilterText(filters, { t, tf }, folded);
	};
	const groups = (n: number, name = 'Gruppe'): string[] => Array.from({ length: n }, (_, i) => `${name} ${String(i + 1).padStart(2, '0')}`);

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

	it('folds a list of more than 5 values to its first 3 and the count of the rest, and keeps 5 whole', () => {
		const fifty = { product_type: groups(50) };
		expect(line('de', fifty, true)).toBe('Gelesen werden nur die Produkte vom Produkttyp „Gruppe 01“, „Gruppe 02“, „Gruppe 03“ oder 47 weiteren.');
		expect(line('en', fifty, true)).toBe('Only the products of product type “Gruppe 01”, “Gruppe 02”, “Gruppe 03” or 47 others are read.');
		expect(line('de', { product_type: groups(6) }, true)).toBe('Gelesen werden nur die Produkte vom Produkttyp „Gruppe 01“, „Gruppe 02“, „Gruppe 03“ oder 3 weiteren.');
		// 5 values: the full line, folded or not, as before folding existed.
		const five = 'Gelesen werden nur die Produkte vom Produkttyp „Gruppe 01“, „Gruppe 02“, „Gruppe 03“, „Gruppe 04“ oder „Gruppe 05“.';
		expect(line('de', { product_type: groups(5) }, true)).toBe(five);
		expect(line('de', { product_type: groups(5) })).toBe(five);
		expect(line('de', { product_type: 'Tee' }, true)).toBe('Gelesen werden nur die Produkte vom Produkttyp „Tee“.');
		// Unfolded, the 50 read in full: what the click shows.
		expect(line('de', fifty)).toBe(`Gelesen werden nur die Produkte vom Produkttyp ${groups(49).map((g) => `„${g}“`).join(', ')} oder „Gruppe 50“.`);
	});

	it('folds both lists of a line that names type and vendor, and counts every value a click shows', () => {
		const both = { product_type: groups(50), vendor: groups(7, 'Anbieter') };
		expect(line('de', both, true)).toBe('Gelesen werden nur die Produkte vom Produkttyp „Gruppe 01“, „Gruppe 02“, „Gruppe 03“ oder 47 weiteren und des Anbieters „Anbieter 01“, „Anbieter 02“, „Anbieter 03“ oder 4 weiteren.');
		expect(line('en', both, true)).toBe('Only the products of product type “Gruppe 01”, “Gruppe 02”, “Gruppe 03” or 47 others and vendor “Anbieter 01”, “Anbieter 02”, “Anbieter 03” or 4 others are read.');
		expect(line('de', both)).toBe(`Gelesen werden nur die Produkte vom Produkttyp ${groups(49).map((g) => `„${g}“`).join(', ')} oder „Gruppe 50“ und des Anbieters ${groups(6, 'Anbieter').map((g) => `„${g}“`).join(', ')} oder „Anbieter 07“.`);
		expect(bulkListFilterFolded(both)).toBe(57);
		expect(bulkListFilterFolded({ product_type: groups(50), vendor: groups(5, 'Anbieter') })).toBe(50);
		expect(bulkListFilterFolded({ product_type: groups(5), vendor: 'Acme' })).toBe(0);
		expect(bulkListFilterFolded(null)).toBe(0);
		setLocale('de');
		expect(tf('bulk.list.showAll', { n: '57' })).toBe('Alle 57 zeigen');
		setLocale('en');
		expect(tf('bulk.list.showAll', { n: '57' })).toBe('Show all 57');
	});
});

// A store's search lists drafts, archived products and gift cards unless a status narrows it, and
// the targets name none of them as such: a line of its own says which statuses are read, under
// the group's line, which reads as it always did.
describe('the status line of a Shopify list, word for word', () => {
	const before = getLocale();
	afterEach(() => setLocale(before));
	const line = (lang: 'de' | 'en', filters: Record<string, string | readonly string[]> | null): string | null => {
		setLocale(lang);
		return bulkListStatusText(filters, { t, tf });
	};

	it('names every status where no filter names one, with a group or without', () => {
		expect(line('de', {})).toBe('Gelesen wird jedes Produkt des Shops, in jedem Status, auch „Entwurf“ und „archiviert“, und auch Geschenkgutscheine.');
		expect(line('en', {})).toBe('Every product of the store is read, in every status, “draft” and “archived” too, and gift cards as well.');
		expect(line('de', { product_type: 'Tee' })).toBe('Gelesen wird jeder Status, auch „Entwurf“ und „archiviert“.');
		expect(line('en', { vendor: ['A', 'B'] })).toBe('Every status is read, “draft” and “archived” too.');
		expect(line('de', { status: 'unlisted' })).toBe('Gelesen werden nur Produkte mit dem Status „nicht gelistet“.');
	});

	it('names the statuses a filter reads, by their names in the page\'s language', () => {
		expect(line('de', { status: 'active' })).toBe('Gelesen werden nur Produkte mit dem Status „aktiv“.');
		expect(line('en', { product_type: 'Tee', status: ['draft', 'archived'] })).toBe('Only products with status “draft” or “archived” are read.');
		expect(line('de', { status: ['active', 'draft', 'archived'] })).toBe('Gelesen werden nur Produkte mit dem Status „aktiv“, „Entwurf“ oder „archiviert“.');
	});

	it('says nothing for a list that is not a store\'s products, and leaves the group\'s line as it was', () => {
		expect(line('de', null)).toBeNull();
		setLocale('de');
		expect(bulkListFilterText({}, { t, tf })).toBeNull();
		expect(bulkListFilterText({ product_type: 'Tee', status: 'active' }, { t, tf })).toBe('Gelesen werden nur die Produkte vom Produkttyp „Tee“.');
		expect(bulkListFilterFolded({ status: ['active', 'draft'] })).toBe(0);
	});
});
