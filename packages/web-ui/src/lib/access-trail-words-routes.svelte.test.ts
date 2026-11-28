import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWord, routeText, WORDED_ACTIONS } from './access-trail-words.js';
import { t, setLocale, getLocale } from './i18n.svelte.js';

// The words are keyed by the action the engine writes for a read (`GET <route as registered>`). A
// route renamed in the engine would leave its word on a route that no longer exists, and the read
// would show its route only, unnoticed. This holds every worded action to the engine's routes.
const HTTP_API = readFileSync(join(__dirname, '../../../../src/server/http-api.ts'), 'utf8');

function registered(action: string): boolean {
	const path = action.slice('GET '.length);
	return HTTP_API.includes(`'${action}'`) || HTTP_API.includes(`'GET', '${path}'`);
}

describe('the words of the reads (U-306 B1(c))', () => {
	it('names only GET routes the engine registers', () => {
		expect(WORDED_ACTIONS.length).toBeGreaterThan(60);
		const dead = WORDED_ACTIONS.filter((a) => !registered(a));
		expect(dead).toEqual([]);
	});

	it('the check finds a route the engine does not have (control)', () => {
		expect(registered('GET /api/no-such-route')).toBe(false);
		expect(registered('GET /api/threads/:id/messages')).toBe(true);
	});

	it('has a text in both languages for every word and every settings page', () => {
		const before = getLocale();
		try {
			for (const lang of ['de', 'en'] as const) {
				setLocale(lang);
				for (const action of WORDED_ACTIONS) {
					const w = readWord(action)!;
					const key = 'key' in w ? w.key : w.settings;
					expect(t(key), `${action} (${lang})`).not.toBe(key);
					expect(t(key).trim(), `${action} (${lang})`).not.toBe('');
				}
			}
		} finally {
			setLocale(before);
		}
	});

	it('gives no word to a route it does not know', () => {
		expect(readWord('GET /api/not-worded')).toBeNull();
		expect(readWord('instance:remember#create:create')).toBeNull();
	});
});

describe('the route, once (U-306 B1(a))', () => {
	it('takes the concrete path for a route, and keeps a target that is not a path', () => {
		expect(routeText('GET /api/config', '/api/config')).toBe('GET /api/config');
		expect(routeText('GET /api/threads/:id', '/api/threads/t-1')).toBe('GET /api/threads/t-1');
		expect(routeText('http_request:read', 'GET example.invalid/')).toBe('http_request:read · GET example.invalid/');
		expect(routeText('GET /api/config', null)).toBe('GET /api/config');
		expect(routeText('mail_send:send', '')).toBe('mail_send:send');
	});
});
