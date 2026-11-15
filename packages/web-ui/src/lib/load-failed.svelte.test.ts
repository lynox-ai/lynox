import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './i18n.svelte.js';
import { LoadFailedError, ensureOk, loadFailedText } from './load-failed.js';

describe('the sentence for a failed load', () => {
	it('names the rate limit for a 429, in each form a page holds it', () => {
		for (const cause of [new LoadFailedError(429), new Response('', { status: 429 }), 429]) {
			expect(loadFailedText(cause)).toBe(t('common.rate_limited'));
		}
	});

	it('keeps the general sentence for every other failure', () => {
		for (const cause of [new LoadFailedError(500), new LoadFailedError(404), new Response('', { status: 503 }), 502, new TypeError('Failed to fetch'), new Error(), undefined]) {
			expect(loadFailedText(cause)).toBe(t('common.load_failed'));
		}
	});

	it('passes an ok response and throws its status otherwise', () => {
		const ok = new Response('{}', { status: 200 });
		expect(ensureOk(ok)).toBe(ok);
		expect(() => ensureOk(new Response('', { status: 429 }))).toThrow(LoadFailedError);
		try { ensureOk(new Response('', { status: 429 })); } catch (e) { expect((e as LoadFailedError).status).toBe(429); }
	});

	// A component that writes the general sentence itself would say "Is the engine reachable?"
	// to a 429 again. Every one goes through loadFailedText.
	it('is the only way a component writes the general sentence', () => {
		const dir = join(__dirname, 'components');
		const direct = readdirSync(dir, { recursive: true, encoding: 'utf8' })
			.filter((f) => f.endsWith('.svelte') || (f.endsWith('.ts') && !f.endsWith('.test.ts')))
			.filter((f) => readFileSync(join(dir, f), 'utf8').includes("t('common.load_failed')"));
		expect(direct).toEqual([]);
	});

	// A failure thrown without its status reaches loadFailedText as a plain Error and reads as
	// the general sentence, a 429 included. In each try whose catch writes the sentence from what
	// it caught, an ok check throws through ensureOk.
	function triesFeedingTheSentence(src: string): string[] {
		const out: string[] = [];
		const re = /\} catch \((\w+)\) \{/g;
		for (let m = re.exec(src); m !== null; m = re.exec(src)) {
			const tail = src.slice(m.index, m.index + 400);
			if (!tail.includes(`loadFailedText(${m[1]!})`)) continue;
			// Walk back from the `}` that closes the try to the `{` that opens it.
			let depth = 0;
			for (let i = m.index; i >= 0; i--) {
				if (src[i] === '}') depth++;
				else if (src[i] === '{' && --depth === 0) { out.push(src.slice(i, m.index)); break; }
			}
		}
		return out;
	}
	const BARE = /!\s*\w+\.ok\b[^;\n]*\)\s*throw new Error\(/;

	it('throws no failed response without its status where the sentence is written from it', () => {
		const dir = join(__dirname, 'components');
		const found = readdirSync(dir, { recursive: true, encoding: 'utf8' })
			.filter((f) => f.endsWith('.svelte') || (f.endsWith('.ts') && !f.endsWith('.test.ts')))
			.filter((f) => triesFeedingTheSentence(readFileSync(join(dir, f), 'utf8')).some((body) => BARE.test(body)));
		expect(found).toEqual([]);
	});

	it('finds such a throw, and only in a try that feeds the sentence', () => {
		const feeds = "try {\n\tconst r = await fetch(u);\n\tif (!r.ok) throw new Error(`${r.status}`);\n\tif (x) { y(); }\n} catch (e) {\n\terror = loadFailedText(e);\n}";
		expect(triesFeedingTheSentence(feeds).some((b) => BARE.test(b))).toBe(true);
		expect(BARE.test('if (!eRes.ok || !bRes.ok) throw new Error();')).toBe(true);
		const own = "try {\n\tif (!r.ok) throw new Error();\n} catch {\n\terror = t('crm.remove_failed');\n}";
		expect(triesFeedingTheSentence(own)).toEqual([]);
	});

});
