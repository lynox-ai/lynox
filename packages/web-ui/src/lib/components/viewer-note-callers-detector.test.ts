import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// A page that reads `GET /api/config` itself hands the body on through `viewerNote()`, taken before
// the request, so a body asked for before a sign-in reset is not taken after it. Calling
// `noteSettingsViewer` directly skips that check; only the store itself may.

const SRC = join(__dirname, '..', '..');
const STORE = join('lib', 'stores', 'settings-viewer.svelte.ts');

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
	});
}

/** Files under `src/` that call `noteSettingsViewer(` outside the store. */
function directCallers(files: Array<[string, string]>): string[] {
	return files.filter(([rel, text]) => rel !== STORE && /\bnoteSettingsViewer\s*\(/.test(text)).map(([rel]) => rel);
}

describe('who hands /config bodies to the viewer store', () => {
	const files = sources(SRC).map((p) => [relative(SRC, p), readFileSync(p, 'utf8')] as [string, string]);

	it('no page calls noteSettingsViewer directly', () => {
		expect(directCallers(files)).toEqual([]);
	});

	it('control: a page calling it directly is found, the store is not', () => {
		expect(directCallers([
			['lib/components/Shown.svelte', 'const body = await res.json(); noteSettingsViewer(body);'],
			[STORE, 'export function noteSettingsViewer(body: unknown): void {} noteSettingsViewer(body);'],
		])).toEqual(['lib/components/Shown.svelte']);
	});

	it('the pages that read /config themselves use viewerNote', () => {
		const users = files.filter(([, text]) => /\bviewerNote\(\)/.test(text)).map(([rel]) => rel);
		// The 17 at the time of writing; fewer means one went back to a direct call or lost the note.
		expect(users.length).toBeGreaterThanOrEqual(17);
	});
});
