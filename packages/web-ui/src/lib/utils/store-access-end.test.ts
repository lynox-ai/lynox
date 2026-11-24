import { describe, it, expect } from 'vitest';
import { longDay } from './store-access-end.js';
import { placeholderParts, valueSegments } from './value-breaks.js';

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
