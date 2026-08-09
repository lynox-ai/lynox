import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	knowledgeCauseKey,
	projectKnowledgeWrite,
	reviewResolution,
	retireResolution,
	type KnowledgeWriteChip,
} from './knowledge-chip.js';

describe('knowledgeCauseKey', () => {
	// The LITERAL pairs, not "three distinct keys": a swapped implementation passed a
	// distinctness count, which is a tautology dressed as coverage.
	it.each([
		['marker', 'chat.knowledge.cause.this_step'],
		['external-tool', 'chat.knowledge.cause.this_step'],
		['conversation', 'chat.knowledge.cause.earlier'],
	])('maps %s → %s', (cause, key) => {
		expect(knowledgeCauseKey(cause)).toBe(key);
	});

	it('separates THIS step from an EARLIER one — the only split the person can act on', () => {
		expect(knowledgeCauseKey('marker')).not.toBe(knowledgeCauseKey('conversation'));
	});

	it('falls back to the generic line for an absent or unknown cause', () => {
		// An older engine behind a newer UI sends no cause; the chip must still say something.
		for (const c of [undefined, 'none', 'something-new-the-engine-invented']) {
			expect(knowledgeCauseKey(c)).toBe('chat.knowledge.review_hint');
		}
	});

	it('every key it can return is declared in BOTH locales, non-empty', () => {
		// The failure this guards is SILENT: `t()` falls back to echoing the key, so a typo —
		// or a `de`-only entry — renders "chat.knowledge.cause.earlier" at the user instead of
		// a sentence. Checked by reading the source rather than importing it: `i18n.svelte.ts`
		// holds the locale in a rune, so a test cannot import it.
		const src = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8');
		for (const c of ['marker', 'external-tool', 'conversation', undefined]) {
			const key = knowledgeCauseKey(c);
			// Both locales, each with at least one character between the quotes — a bare
			// `toContain("'key': {")` passes for `{ de: 'x' }` with no `en`, and for `{ de: '' }`.
			const decl = new RegExp(
				`'${key.replace(/\./g, '\\.')}':\\s*\\{[^}]*\\bde:\\s*'[^']+'[^}]*\\ben:\\s*'[^']+'[^}]*\\}`,
			);
			expect(decl.test(src), `missing or incomplete i18n declaration for ${key}`).toBe(true);
		}
	});
});

describe('projectKnowledgeWrite', () => {
	const raw = { id: 'k1', subject: 'Nordfeld', kind: 'organization', status: 'active', text: 'pays net 30', cause: 'marker' };

	it('builds a chip from a raw event, normalizing the fields', () => {
		const chip = projectKnowledgeWrite([], raw);
		expect(chip).toEqual({
			id: 'k1', subject: 'Nordfeld', kind: 'organization', status: 'active', text: 'pays net 30', cause: 'marker',
		});
	});

	it('drops a replayed id — a Tier-2 SSE reconnect must not show the capture twice', () => {
		const existing: KnowledgeWriteChip[] = [{ id: 'k1', status: 'active', text: 'pays net 30' }];
		// The load-bearing dedup: same id already present → nothing to append.
		expect(projectKnowledgeWrite(existing, raw)).toBeNull();
		// A DIFFERENT id on the same message is still appended (not a blanket "already have one").
		expect(projectKnowledgeWrite(existing, { ...raw, id: 'k2' })?.id).toBe('k2');
	});

	it('drops a malformed event with no id', () => {
		expect(projectKnowledgeWrite([], { ...raw, id: '' })).toBeNull();
		expect(projectKnowledgeWrite([], { subject: 'x' })).toBeNull();
	});

	it('routes only an explicit pending_review to the review path; anything else is active', () => {
		// An unknown/absent status must NOT land a write in the untrusted-review path it did
		// not ask for — the security-relevant default.
		expect(projectKnowledgeWrite([], { ...raw, status: 'pending_review' })?.status).toBe('pending_review');
		expect(projectKnowledgeWrite([], { ...raw, status: 'active' })?.status).toBe('active');
		expect(projectKnowledgeWrite([], { ...raw, status: 'something-else' })?.status).toBe('active');
		expect(projectKnowledgeWrite([], { id: 'k9' })?.status).toBe('active');
	});

	it('leaves a non-string cause/subject/kind undefined rather than coercing', () => {
		const chip = projectKnowledgeWrite([], { id: 'k9', cause: 42, subject: null, kind: {} });
		expect(chip?.cause).toBeUndefined();
		expect(chip?.subject).toBeUndefined();
		expect(chip?.kind).toBeUndefined();
	});
});

describe('reviewResolution', () => {
	// Literal pairs, not a distinctness count: an edit is an approval of edited text, so
	// `edit_approve` must land on `kept`, the SAME state as `approve` — a "three distinct
	// outcomes" assertion would pass a buggy impl that gave edit_approve its own state.
	it.each([
		['approve', 'kept'],
		['edit_approve', 'kept'],
		['reject', 'discarded'],
	] as const)('maps %s → %s', (action, expected) => {
		expect(reviewResolution(action)).toBe(expected);
	});

	it('only reject discards — an approval of either kind keeps', () => {
		expect(reviewResolution('reject')).not.toBe(reviewResolution('approve'));
		expect(reviewResolution('approve')).toBe(reviewResolution('edit_approve'));
	});
});

describe('retireResolution', () => {
	it('resolves to undone only on a 2xx; a failed retire leaves the chip actionable', () => {
		expect(retireResolution(true)).toBe('undone');
		// `null` = no transition — the store must not flip the chip to done when the route refused.
		expect(retireResolution(false)).toBeNull();
	});
});
