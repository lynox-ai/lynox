import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A detector: every `PUT` on `/config` in the web UI goes through `throwIfRefused`. Pages that
 * threw `HTTP ${res.status}` or a bare Error showed "HTTP 403" to a mandate whose save the server
 * refused with a sentence, and a new settings page would copy whichever pattern it found first.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUT_CONFIG = /fetch\(\s*`\$\{[^}]+\}\/config`,\s*\{\s*method:\s*'PUT'/g;
/**
 * Any fetch whose first lines name `/config` and a PUT, in any order or quoting. The strict
 * pattern above must find every one of these; a save written another way would otherwise be
 * missed without a sound.
 */
/** Where each fetch starts whose URL names `/config` and whose options say PUT, in any form. */
function loosePutConfigAt(src: string): number[] {
	const out: number[] = [];
	for (const m of src.matchAll(/\bfetch\(/g)) {
		const rest = src.slice(m.index + 6, m.index + 900);
		const next = rest.search(/\bfetch\(/);
		const call = `fetch(${next === -1 ? rest : rest.slice(0, next)}`;
		const url = call.slice(0, 200).split(/,\s*\{/)[0]!;
		if (/\/config\b(?![-\w./])/.test(url) && /method\s*:\s*['"`]PUT['"`]/.test(call)) out.push(m.index);
	}
	return out;
}
function loosePutConfigCount(src: string): number {
	return loosePutConfigAt(src).length;
}

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sources(path));
		else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
	}
	return out;
}

/**
 * Each `PUT /config` in `src`: whether `throwIfRefused` reads its answer before the next fetch,
 * and whether the code after it shows the refusal (`saveFailedText`, or the error's `.message`)
 * rather than a fixed text that drops the sentence again.
 */
function putConfigSites(src: string): { at: number; checked: boolean; shown: boolean }[] {
	return [...src.matchAll(PUT_CONFIG)].map((m) => {
		const after = src.slice(m.index + m[0].length);
		const next = after.search(/\bfetch\(/);
		const scope = next === -1 ? after.slice(0, 1500) : after.slice(0, Math.min(next, 1500));
		const call = scope.search(/\bthrowIfRefused\(/);
		// The first handler after the call is the one that sees its refusal: `catch {`, `catch (e) {`
		// or a promise chain's `.catch(`.
		const rest = call === -1 ? '' : after.slice(call);
		const at = rest.search(/\}\s*catch\b|^\s*\.catch\(/m);
		const handler = at === -1 ? '' : rest.slice(at, at + 400);
		return { at: m.index, checked: call !== -1, shown: /(?:addToast\(|=)[^;]*(?:\bsaveFailedText\(|\b(?:e|err)\.message\b)/.test(handler) };
	});
}

describe('every PUT on /config shows why the server refused it', () => {
	it('finds no save that skips throwIfRefused', () => {
		const unchecked: string[] = [];
		let total = 0;
		const unseen: string[] = [];
		for (const path of sources(ROOT)) {
			const src = readFileSync(path, 'utf8');
			const strictAt = new Set(putConfigSites(src).map((site) => site.at));
			for (const at of loosePutConfigAt(src)) {
				if (!strictAt.has(at)) unseen.push(`${relative(ROOT, path)}:${src.slice(0, at).split('\n').length}`);
			}
			for (const site of putConfigSites(src)) {
				total++;
				if (!site.checked || !site.shown) unchecked.push(`${relative(ROOT, path)}:${src.slice(0, site.at).split('\n').length}${site.checked ? ' (refusal not shown)' : ''}`);
			}
		}
		// The 16 saves counted when this landed; fewer means the pattern went blind.
		expect(total).toBeGreaterThanOrEqual(16);
		// Every save the loose scan sees, the strict one checked.
		expect(unseen).toEqual([]);
		expect(unchecked).toEqual([]);
	});

	it('CONTROL: flags a save that throws the status, and passes one that reads the refusal', () => {
		const bare = "const res = await fetch(`${getApiBase()}/config`, {\n\tmethod: 'PUT',\n\tbody: '{}',\n});\nif (!res.ok) throw new Error(`HTTP ${res.status}`);";
		const read = "const res = await fetch(`${base}/config`, { method: 'PUT', body: '{}' });\nawait throwIfRefused(res);";
		expect(putConfigSites(bare).map((s) => s.checked)).toEqual([false]);
		expect(putConfigSites(read).map((s) => s.checked)).toEqual([true]);
		// Read, then dropped: the catch shows only its own text.
		const dropped = `${read}\n} catch {\n\taddToast(t('x.save_failed'), 'error');\n}`;
		const shown = `${read}\n} catch (e) {\n\taddToast(saveFailedText(e, t('x.save_failed')), 'error');\n}`;
		expect(putConfigSites(dropped).map((s) => s.shown)).toEqual([false]);
		expect(putConfigSites(shown).map((s) => s.shown)).toEqual([true]);
		// The message logged and a fixed text shown is still a dropped sentence.
		const logged = `${read}\n} catch (e) {\n\tconsole.warn(e.message);\n\taddToast(t('x.save_failed'), 'error');\n}`;
		expect(putConfigSites(logged).map((s) => s.shown)).toEqual([false]);
		// A save in another form is seen by the loose scan, and not by the strict one.
		const other = "const res = await fetch(url + '/config', { headers: {}, method: \"PUT\", body: '{}' });";
		expect(loosePutConfigCount(other)).toBe(1);
		expect(putConfigSites(other)).toEqual([]);
		// A check that belongs to a later fetch does not count for this one.
		const later = `${bare}\nconst r2 = await fetch('/x');\nawait throwIfRefused(r2);`;
		expect(putConfigSites(later)[0]!.checked).toBe(false);
	});
});
