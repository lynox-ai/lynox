import { describe, it, expect } from 'vitest';
import { hostParts, hostSegments, longDay } from './store-access-end.js';

describe('a store host in a sentence', () => {
	it('splits the sentence at {host}, and keeps a sentence without one whole', () => {
		expect(hostParts('Der Shop {host} läuft ab.')).toEqual({ before: 'Der Shop ', after: ' läuft ab.' });
		expect(hostParts('Kein Platzhalter.')).toEqual({ before: 'Kein Platzhalter.', after: '' });
	});

	it('cuts a host after each dot only, and a host without a dot not at all', () => {
		expect(hostSegments('beta-shop.myshopify.com')).toEqual(['beta-shop.', 'myshopify.', 'com']);
		expect(hostSegments('localhost')).toEqual(['localhost']);
	});
});

describe('a deadline\'s day', () => {
	it('names the month, in German and English, never digits alone, held together on one line', () => {
		expect(longDay('2026-12-05T12:00:00.000Z', 'de')).toBe('5.\u00a0Dezember\u00a02026');
		expect(longDay('2026-12-05T12:00:00.000Z', 'en')).toBe('December\u00a05,\u00a02026');
	});
});
