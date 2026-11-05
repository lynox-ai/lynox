import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setLocale, getLocale, t, tf } from '../i18n.svelte.js';
import { bulkInvalidText, bulkMandateI18n, type BulkI18n } from './bulk-runs.js';

// ux U-154 (row 1121): a new run leaves out a product whose description is the version an earlier
// run wrote and the store added markup to. The sentence names that run by its date where the
// ledger still holds it; a mandate's session reads it with "the shop" and "the owner".

const owner: BulkI18n = { t, tf };
const mandate = bulkMandateI18n(owner);
const said = (i18n: BulkI18n, date: string | null): string =>
	bulkInvalidText('before_has_shop_markup', true, true, i18n, { field: undefined, host: 'acme.myshopify.com', dataStore: false, markedDate: date });

const initial = getLocale();
afterEach(() => { setLocale(initial); });

describe('before_has_shop_markup: the sentence under the product (U-154)', () => {
	it('words it as ux decided, in German, for the owner and a mandate, with and without the date', () => {
		setLocale('de');
		const tail = 'Pass die Beschreibung im Shopify-Admin so an, wie sie sein soll; soll sie so bleiben, ändere trotzdem ein Wort oder Satzzeichen, dann gilt sie als deine. Bitte lynox danach im Chat, den Lauf neu zu planen.';
		expect(said(owner, '03.11.2026')).toBe(`Diese Beschreibung hat der lynox-Lauf vom 03.11.2026 geschrieben, und dein Shop hat dabei Markup ergänzt, das lynox nicht gesendet hat. Sie war nie dein Stand, deshalb ändert lynox dieses Produkt nicht. ${tail}`);
		expect(said(owner, null)).toBe(`Diese Beschreibung hat der lynox-Lauf geschrieben, und dein Shop hat dabei Markup ergänzt, das lynox nicht gesendet hat. Sie war nie dein Stand, deshalb ändert lynox dieses Produkt nicht. ${tail}`);
		const mandateTail = 'Pass die Beschreibung im Shopify-Admin so an, wie sie sein soll; soll sie so bleiben, ändere trotzdem ein Wort oder Satzzeichen, dann gilt sie als die des Inhabers. Bitte lynox danach im Chat, den Lauf neu zu planen.';
		expect(said(mandate, '03.11.2026')).toBe(`Diese Beschreibung hat der lynox-Lauf vom 03.11.2026 geschrieben, und der Shop hat dabei Markup ergänzt, das lynox nicht gesendet hat. Sie war nie der Stand des Inhabers, deshalb ändert lynox dieses Produkt nicht. ${mandateTail}`);
		expect(said(mandate, null)).toBe(`Diese Beschreibung hat der lynox-Lauf geschrieben, und der Shop hat dabei Markup ergänzt, das lynox nicht gesendet hat. Sie war nie der Stand des Inhabers, deshalb ändert lynox dieses Produkt nicht. ${mandateTail}`);
	});

	it('words it as ux decided, in English, for the owner and a mandate, with and without the date', () => {
		setLocale('en');
		const tail = 'Edit the description in the Shopify admin to what it should be; if it should stay as it is, still change one word or punctuation mark, and it counts as yours. Then ask lynox in the chat to plan the run again.';
		expect(said(owner, '11/03/2026')).toBe(`This description was written by the lynox run of 11/03/2026, and your shop added markup to it that lynox did not send. It was never your version, so lynox does not change this product. ${tail}`);
		expect(said(owner, null)).toBe(`This description was written by the lynox run, and your shop added markup to it that lynox did not send. It was never your version, so lynox does not change this product. ${tail}`);
		const mandateTail = 'Edit the description in the Shopify admin to what it should be; if it should stay as it is, still change one word or punctuation mark, and it counts as the owner\'s. Then ask lynox in the chat to plan the run again.';
		expect(said(mandate, '11/03/2026')).toBe(`This description was written by the lynox run of 11/03/2026, and the shop added markup to it that lynox did not send. It was never the owner's version, so lynox does not change this product. ${mandateTail}`);
		expect(said(mandate, null)).toBe(`This description was written by the lynox run, and the shop added markup to it that lynox did not send. It was never the owner's version, so lynox does not change this product. ${mandateTail}`);
	});

	it('is the sentence on every run, not the code: it has a key of its own', () => {
		setLocale('de');
		expect(said(owner, null)).not.toContain('before_has_shop_markup');
		// A date undefined reads as none.
		expect(bulkInvalidText('before_has_shop_markup', true, true, owner)).toBe(said(owner, null));
	});

	it('is given the date and the session\'s wording by the run page', () => {
		const page = readFileSync(fileURLToPath(new URL('./BulkRunDetail.svelte', import.meta.url)), 'utf8');
		// The mandate's wording (`view`), not the owner's (`i18n`), and the date from the target.
		expect(page).toContain('bulkInvalidText(target.error, shopify, managed, view, {');
		expect(page).toContain('markedDate: target.shopMarkedAt ? markedDateText(target.shopMarkedAt) : null');
	});
});
