import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SaveRefused, saveFailedText, throwIfRefused } from './save-refusal.js';

const OWNER_ONLY = 'Only the owner of this instance can change the configuration.';

async function failedText(res: Response, fallback = 'Save failed'): Promise<string> {
	try {
		await throwIfRefused(res);
	} catch (e) {
		return saveFailedText(e, fallback);
	}
	return 'NOT REFUSED';
}

describe('throwIfRefused + saveFailedText — the sentence a refused save shows', () => {
	it('shows the server\'s sentence for a 403 that names the owner', async () => {
		expect(await failedText(Response.json({ error: OWNER_ONLY }, { status: 403 }))).toBe(OWNER_ONLY);
	});

	it('shows the sentence of any other refusal, a locked field or a failed validation', async () => {
		const locked = 'Managed instance: cannot change provider';
		expect(await failedText(Response.json({ error: locked }, { status: 403 }))).toBe(locked);
		expect(await failedText(Response.json({ error: "provider:'openai' requires openai_model_id" }, { status: 400 })))
			.toBe("provider:'openai' requires openai_model_id");
	});

	it('falls back to the page\'s own text when the server sent no sentence', async () => {
		expect(await failedText(new Response('<html>bad gateway</html>', { status: 502 }))).toBe('Save failed');
		expect(await failedText(Response.json({ error: '   ' }, { status: 400 }))).toBe('Save failed');
		expect(await failedText(Response.json({ error: { code: 'x' } }, { status: 400 }))).toBe('Save failed');
		expect(await failedText(Response.json(null, { status: 500 }))).toBe('Save failed');
	});

	it('keeps the status in the error message, for a page that shows the message itself', async () => {
		const err = await throwIfRefused(new Response('', { status: 403 })).then(() => null, (e: unknown) => e);
		expect(err).toBeInstanceOf(SaveRefused);
		expect((err as SaveRefused).message).toBe('HTTP 403');
		expect((err as SaveRefused).status).toBe(403);
		const named = await throwIfRefused(Response.json({ error: OWNER_ONLY }, { status: 403 })).then(() => null, (e: unknown) => e);
		expect((named as SaveRefused).message).toBe(OWNER_ONLY);
	});

	it('lets an ok answer through, and gives any other failure the fallback', async () => {
		await expect(throwIfRefused(Response.json({ ok: true }, { status: 200 }))).resolves.toBeUndefined();
		expect(saveFailedText(new TypeError('Failed to fetch'), 'Save failed')).toBe('Save failed');
		expect(saveFailedText('weird', 'Save failed')).toBe('Save failed');
	});
});

/**
 * A detector: every `PUT` on `/config` in the web UI goes through `throwIfRefused`. Pages that
 * threw `HTTP ${res.status}` or a bare Error showed "HTTP 403" to a mandate whose save the server
 * refused with a sentence, and a new settings page would copy whichever pattern it found first.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUT_CONFIG = /fetch\(\s*`\$\{[^}]+\}\/config`,\s*\{\s*method:\s*'PUT'/g;

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
		const at = rest.search(/\bcatch\b/);
		const handler = at === -1 ? '' : rest.slice(at, at + 400);
		return { at: m.index, checked: call !== -1, shown: /\bsaveFailedText\(|\b(?:e|err)\.message\b/.test(handler) };
	});
}

describe('every PUT on /config shows why the server refused it', () => {
	it('finds no save that skips throwIfRefused', () => {
		const unchecked: string[] = [];
		let total = 0;
		for (const path of sources(ROOT)) {
			const src = readFileSync(path, 'utf8');
			for (const site of putConfigSites(src)) {
				total++;
				if (!site.checked || !site.shown) unchecked.push(`${relative(ROOT, path)}:${src.slice(0, site.at).split('\n').length}${site.checked ? ' (refusal not shown)' : ''}`);
			}
		}
		// The 16 saves counted when this landed; fewer means the pattern went blind.
		expect(total).toBeGreaterThanOrEqual(16);
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
		// A check that belongs to a later fetch does not count for this one.
		const later = `${bare}\nconst r2 = await fetch('/x');\nawait throwIfRefused(r2);`;
		expect(putConfigSites(later)[0]!.checked).toBe(false);
	});
});
