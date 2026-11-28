import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWord, routeText, WORDED_ACTIONS, CARRIES, CARRY_TERMS, type Carry } from './access-trail-words.js';
import { t, setLocale, getLocale } from './i18n.svelte.js';

// The words are keyed by the action the engine writes for a read (`GET <route as registered>`). A
// route renamed in the engine would leave its word on a route that no longer exists, and the read
// would show its route only, unnoticed. This holds every worded action to the engine's routes.
const HTTP_API = readFileSync(join(__dirname, '../../../../src/server/http-api.ts'), 'utf8');

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** As the engine registers a route: `addStatic(scope, 'GET /api/…'` or `parseDynamicRoute(scope, 'GET', '/api/…'`. */
function registered(action: string, source: string = HTTP_API): boolean {
	const path = action.slice('GET '.length);
	return new RegExp(`addStatic\\('[a-z]+', '${escape(action)}'`).test(source)
		|| new RegExp(`parseDynamicRoute\\('[a-z]+', 'GET', '${escape(path)}'`).test(source);
}

describe('the words of the reads (U-306 B1(c))', () => {
	it('names only GET routes the engine registers', () => {
		expect(WORDED_ACTIONS.length).toBeGreaterThan(60);
		const dead = WORDED_ACTIONS.filter((a) => !registered(a));
		expect(dead).toEqual([]);
	});

	it('the check finds a route the engine does not have (control)', () => {
		expect(registered('GET /api/no-such-route')).toBe(false);
		// A route only quoted (a table key, a comment) is not registered.
		expect(registered('GET /api/x', "['GET /api/x', ['path']] // GET /api/x")).toBe(false);
		expect(registered('GET /api/x', "this.addStatic('user', 'GET /api/x', h)")).toBe(true);
		expect(registered('GET /api/x/:id', "parseDynamicRoute('user', 'GET', '/api/x/:id', h)")).toBe(true);
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

describe('the word names what the read returns (U-306 N1)', () => {
	/** The word of an action in a language: the settings form fills in its page. */
	const wordIn = (action: string, lang: 'de' | 'en'): string => {
		setLocale(lang);
		const w = readWord(action)!;
		return 'key' in w ? t(w.key) : t('access_trail.read.settings').replace('{page}', t(w.settings));
	};
	/** The kinds a word does not name, as `kind (lang)`. */
	const unnamed = (action: string, carries: readonly Carry[], word: (lang: 'de' | 'en') => string): string[] =>
		carries.flatMap((c) => (c === 'state' ? [] : (['de', 'en'] as const).filter((l) => !CARRY_TERMS[c][l].test(word(l))).map((l) => `${action}: ${c} (${l})`)));

	it('declares what every worded route returns, and nothing else', () => {
		expect(Object.keys(CARRIES).sort()).toEqual([...WORDED_ACTIONS].sort());
		for (const [action, carries] of Object.entries(CARRIES)) {
			expect(carries.length, action).toBeGreaterThan(0);
			// `state` is said alone: a route that returns content is not also a status.
			if (carries.includes('state')) expect(carries, action).toEqual(['state']);
		}
	});

	it('has every kind of content a route returns in its word, in both languages', () => {
		const before = getLocale();
		try {
			const missing = Object.entries(CARRIES).flatMap(([action, carries]) => unnamed(action, carries, (l) => wordIn(action, l)));
			expect(missing).toEqual([]);
		} finally {
			setLocale(before);
		}
	});

	it('finds a word that says less than the route returns (control)', () => {
		// The run list before U-306 N1: up to 500 runs with task and answer, said as a list of runs.
		const old = { de: 'Liste der Läufe', en: 'List of runs' };
		expect(unnamed('GET /api/history/runs', CARRIES['GET /api/history/runs']!, (l) => old[l])).toEqual([
			'GET /api/history/runs: task (de)', 'GET /api/history/runs: task (en)', 'GET /api/history/runs: answer (de)', 'GET /api/history/runs: answer (en)',
			'GET /api/history/runs: cost (de)', 'GET /api/history/runs: cost (en)',
		]);
	});

	it('gives a HEAD read the word of its GET route', () => {
		expect(readWord('HEAD /api/threads')).toEqual(readWord('GET /api/threads'));
		expect(readWord('HEAD /api/backups')).toEqual(readWord('GET /api/backups'));
		expect(readWord('HEAD /api/not-worded')).toBeNull();
	});
});
