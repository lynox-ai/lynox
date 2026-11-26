import { describe, it, expect } from 'vitest';
import { longDay, storeAccessAskAgain } from './store-access-end.js';
import { placeholderParts, valueSegments } from './value-breaks.js';

describe('whether the store banner asks the engine again', () => {
	const end = (at: string) => ({ id: 'a', store_access_ends: { host: 'acme.myshopify.com', ended: false, at } });
	const askedAt = Date.parse('2099-01-20T11:58:00.000Z');
	const now = new Date('2099-01-20T12:00:00.000Z');
	it('asks again while no question has been answered, with or without a store it knows', () => {
		expect(storeAccessAskAgain([], null, now)).toBe(true);
		expect(storeAccessAskAgain([end('2099-02-20T12:00:00.000Z')], null, now)).toBe(true);
	});
	it('after an answer, asks only for an end that came since that question', () => {
		expect(storeAccessAskAgain([], askedAt, now)).toBe(false);
		expect(storeAccessAskAgain([end('2099-01-20T11:59:00.000Z')], askedAt, now)).toBe(true);
		expect(storeAccessAskAgain([end('2099-01-20T11:57:00.000Z')], askedAt, now)).toBe(false);
		expect(storeAccessAskAgain([end('2099-01-20T12:01:00.000Z')], askedAt, now)).toBe(false);
	});
});

describe('a host or URL in a sentence', () => {
	it('splits the sentence at its placeholder, and keeps a sentence without one whole', () => {
		expect(placeholderParts('Der Shop {host} läuft ab.', '{host}')).toEqual({ before: 'Der Shop ', after: ' läuft ab.' });
		expect(placeholderParts('Konto: {account}', '{account}')).toEqual({ before: 'Konto: ', after: '' });
		expect(placeholderParts('Kein Platzhalter.', '{host}')).toEqual({ before: 'Kein Platzhalter.', after: '' });
	});

	it('cuts a host after each dot only, and a host without a dot not at all', () => {
		expect(valueSegments('beta-shop.myshopify.com', 'host')).toEqual(['beta-shop.', 'myshopify.', 'com']);
		expect(valueSegments('acme-store', 'host')).toEqual(['acme-store']);
		expect(valueSegments('localhost', 'host')).toEqual(['localhost']);
	});

	it('cuts a URL after a dot or a slash, never inside the // of its scheme, at a hyphen or mid-word', () => {
		expect(valueSegments('https://acme-store.myshopify.com/admin/api/2025-10', 'url')).toEqual(['https://', 'acme-store.', 'myshopify.', 'com/', 'admin/', 'api/', '2025-10']);
		expect(valueSegments('https://x.lynox.cloud/api/oauth/callback', 'url')).toEqual(['https://', 'x.', 'lynox.', 'cloud/', 'api/', 'oauth/', 'callback']);
		expect(valueSegments('https://acme-store.myshopify.com/admin/api/2025-10', 'url').join('')).toBe('https://acme-store.myshopify.com/admin/api/2025-10');
	});
});

describe('a deadline\'s day', () => {
	it('names the month, in German and English, never digits alone, held together on one line', () => {
		expect(longDay('2026-12-05T12:00:00.000Z', 'de')).toBe('5.\u00a0Dezember\u00a02026');
		expect(longDay('2026-12-05T12:00:00.000Z', 'en')).toBe('December\u00a05,\u00a02026');
	});
});
