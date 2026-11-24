import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The inbox says "Posteingang" and "zurückstellen" in DE (U-445): no inbox text keeps the English
// word, the old snooze forms, or "Items". Read from the dictionary source, so a new key is covered.

function deValues(): Array<[string, string]> {
	const src = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf8');
	const starts = [...src.matchAll(/^\t'([^']+)':/gm)];
	return starts.map((m, i) => {
		const block = src.slice(m.index, i + 1 < starts.length ? starts[i + 1]!.index : undefined);
		const de = /\bde: '((?:[^'\\]|\\.)*)'/.exec(block)?.[1] ?? '';
		return [m[1]!, de];
	});
}

describe('words of the inbox in DE', () => {
	it('reads every inbox key with its DE text', () => {
		const inbox = deValues().filter(([k]) => /^(nav\.inbox|tool\.inbox|inbox\.)/.test(k));
		expect(inbox.length).toBeGreaterThan(100);
		expect(inbox.filter(([, de]) => de === '')).toEqual([]);
		expect(Object.fromEntries(inbox)['inbox.reclassify_banner_text']).toBe('{count} Nachrichten haben den Status geändert');
	});

	it('leaves no snooze, Schlummer, Items or Inbox in any DE inbox text', () => {
		const left = deValues()
			.filter(([k]) => /^(nav\.inbox|tool\.inbox|inbox\.)/.test(k))
			.filter(([, de]) => /snooz|Schlummer|\bItems?\b|\bInbox\b/i.test(de.replace('LYNOX_FEATURE_UNIFIED_INBOX', '')))
			.map(([k]) => k);
		expect(left).toEqual([]);
	});
});
