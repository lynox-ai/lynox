import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The passkey hint (U-454) is a strip in the chat above the transcript, and nowhere else: on a work
// page or as a layout overlay it covered buttons and the composer.

const root = fileURLToPath(new URL('..', import.meta.url));
const svelteFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
	const p = join(dir, n);
	return statSync(p).isDirectory() ? svelteFiles(p) : p.endsWith('.svelte') ? [p] : [];
});

describe('where the passkey hint shows', () => {
	it('only in the chat, above the transcript: no layout or work page renders it', () => {
		const sites = svelteFiles(root).filter((f) => /<PasskeyPrompt\b/.test(readFileSync(f, 'utf8')));
		expect(sites.map((f) => f.slice(root.length))).toEqual(['lib/components/ChatView.svelte']);
		const chat = readFileSync(join(root, 'lib/components/ChatView.svelte'), 'utf8');
		expect(chat.match(/<PasskeyPrompt\b/g)).toHaveLength(1);
		const at = chat.indexOf('<PasskeyPrompt />');
		expect(at).toBeGreaterThan(-1);
		expect(at).toBeLessThan(chat.indexOf('bind:this={messagesEl}'));
	});
});
