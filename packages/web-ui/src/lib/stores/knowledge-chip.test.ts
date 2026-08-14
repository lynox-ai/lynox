import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	allKnowledgeWrites,
	carryKnowledgeWrites,
	knowledgeCauseKey,
	parseReviewFailure,
	performRetire,
	performReview,
	projectKnowledgeWrite,
	queueEntriesToChips,
	reviewRequestBody,
	reviewResolution,
	retireResolution,
	type KnowledgeWriteChip,
	type ChipBearer,
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
		// The replayed id sits at position TWO, so this also pins that the dedup scans the whole
		// array (`.some`) — a first-element-only check would let the replay through.
		const existing: KnowledgeWriteChip[] = [
			{ id: 'k0', status: 'active', text: 'earlier' },
			{ id: 'k1', status: 'active', text: 'pays net 30' },
		];
		expect(projectKnowledgeWrite(existing, raw)).toBeNull(); // raw.id === 'k1', already present
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

	it('narrows cause to the known vocabulary — an out-of-enum string is dropped, not typed as a lie', () => {
		// An older/newer engine could send a cause this UI does not know; it must become
		// undefined, not a string cast to the 4-literal union.
		expect(projectKnowledgeWrite([], { id: 'k9', cause: 'conversation' })?.cause).toBe('conversation');
		expect(projectKnowledgeWrite([], { id: 'k9', cause: 'something-new' })?.cause).toBeUndefined();
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

describe('performRetire — the store glue that used to be untestable', () => {
	const freshChip = (): KnowledgeWriteChip => ({ id: 'k1', status: 'active', text: 'pays net 30' });

	it('resolves the chip to undone, and only after the route accepted', async () => {
		const chip = freshChip();
		const outcome = await performRetire(chip, async () => ({ ok: true }));
		expect(outcome).toBe('resolved');
		expect(chip.resolved).toBe('undone');
	});

	it('a refused retire leaves the chip actionable — resolved must NOT be set', async () => {
		// The 2xx gate: flipping `chip.resolved = 'undone'` unconditionally (the mutation
		// this kills) would show "undone" for an entry the server still holds active.
		const chip = freshChip();
		const outcome = await performRetire(chip, async () => ({ ok: false }));
		expect(outcome).toBe('failed');
		expect(chip.resolved).toBeUndefined();
	});

	it('a send that throws counts as failed, same as a refusal', async () => {
		const chip = freshChip();
		const outcome = await performRetire(chip, async () => { throw new Error('network down'); });
		expect(outcome).toBe('failed');
		expect(chip.resolved).toBeUndefined();
	});

	it('no chip, or an already-resolved chip, is a noop and never hits the route', async () => {
		// The double-click guard: a second click while resolved must not re-fire the request.
		let calls = 0;
		const send = async () => { calls++; return { ok: true }; };
		expect(await performRetire(undefined, send)).toBe('noop');
		const done: KnowledgeWriteChip = { ...freshChip(), resolved: 'undone' };
		expect(await performRetire(done, send)).toBe('noop');
		expect(calls).toBe(0);
	});
});

describe('performReview — success-only transition, editor stays open on failure', () => {
	const pending = (): KnowledgeWriteChip => ({ id: 'k1', status: 'pending_review', text: 'original wording' });

	it.each([
		['approve', 'kept'],
		['reject', 'discarded'],
	] as const)('%s on a 2xx resolves the chip to %s', async (action, expected) => {
		const chip = pending();
		const { outcome } = await performReview(chip, action, undefined, async () => ({ ok: true, errorMessage: null }));
		expect(outcome).toBe('resolved');
		expect(chip.resolved).toBe(expected);
		expect(chip.text).toBe('original wording'); // no edit, no text change
	});

	it('an accepted edit_approve lands the edited text AND resolves to kept', async () => {
		const chip = pending();
		const { outcome } = await performReview(chip, 'edit_approve', 'edited wording', async () => ({ ok: true, errorMessage: null }));
		expect(outcome).toBe('resolved');
		expect(chip.text).toBe('edited wording');
		expect(chip.resolved).toBe('kept');
	});

	it('a FAILED edit_approve keeps the editor open: text unchanged, chip unresolved', async () => {
		// The verify-done case: applying `chip.text = editedText` before the ok-check (the
		// mutation this kills) would render the edit as landed when the server refused it.
		const chip = pending();
		const result = await performReview(
			chip, 'edit_approve', 'edited wording',
			async () => ({ ok: false, errorMessage: 'text too long' }),
		);
		// Whole-object equality: pins the outcome AND that the server's wording reaches the toast.
		expect(result).toEqual({ outcome: 'failed', errorMessage: 'text too long' });
		expect(chip.text).toBe('original wording');
		expect(chip.resolved).toBeUndefined();
	});

	it('a send that throws fails with the thrown wording; a non-Error throw yields null', async () => {
		const chip = pending();
		const thrown = await performReview(chip, 'approve', undefined, async () => { throw new Error('boom'); });
		expect(thrown).toEqual({ outcome: 'failed', errorMessage: 'boom' });
		expect(chip.resolved).toBeUndefined();
		const opaque = await performReview(chip, 'approve', undefined, async () => { throw 'string-throw'; });
		expect(opaque).toEqual({ outcome: 'failed', errorMessage: null });
	});

	it('no chip, or an already-resolved chip, is a noop and never hits the route', async () => {
		let calls = 0;
		const send = async () => { calls++; return { ok: true, errorMessage: null }; };
		expect((await performReview(undefined, 'approve', undefined, send)).outcome).toBe('noop');
		const done: KnowledgeWriteChip = { ...pending(), resolved: 'kept' };
		expect((await performReview(done, 'reject', undefined, send)).outcome).toBe('noop');
		expect(calls).toBe(0);
	});
});

describe('reviewRequestBody', () => {
	it('a plain approve/reject sends NO text key — not even an undefined one', () => {
		// The route treats a present `text` as an edit; `{ action, text: undefined }` would
		// JSON.stringify away today but the absence is the contract, so pin it structurally.
		const body = reviewRequestBody('approve', undefined);
		expect(body).toEqual({ action: 'approve' });
		expect('text' in body).toBe(false);
	});

	it('an edit rides the edited text along', () => {
		expect(reviewRequestBody('edit_approve', 'edited wording')).toEqual({ action: 'edit_approve', text: 'edited wording' });
	});
});

describe('parseReviewFailure', () => {
	it('prefers the server wording, falls back to the bare status', () => {
		expect(parseReviewFailure(422, { error: 'text too long' })).toBe('text too long');
		expect(parseReviewFailure(500, null)).toBe('HTTP 500');
		expect(parseReviewFailure(400, {})).toBe('HTTP 400');
	});

	it('passes an explicit empty-string error through — the pre-extraction behaviour', () => {
		// `??`, not `||`: the old inline code let `error: ''` through as the toast text, and
		// this helper must not silently upgrade it to the status line.
		expect(parseReviewFailure(400, { error: '' })).toBe('');
	});
});

describe('carryKnowledgeWrites', () => {
	const chip = (id: string, status: 'active' | 'pending_review' = 'pending_review'): KnowledgeWriteChip =>
		({ id, status, text: `fact ${id}` });

	it('carries a chip onto the adopted message with matching role and content', () => {
		const local: ChipBearer[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'done', knowledgeWrites: [chip('k1')] },
		];
		const adopted: ChipBearer[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'done' },
		];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[1]!.knowledgeWrites?.map((w) => w.id)).toEqual(['k1']);
		expect(adopted[0]!.knowledgeWrites).toBeUndefined();
	});

	it('falls back to the LAST assistant message when the server reprojected the turn', () => {
		// Local fragmented shape vs the server's merged projection (the #4 multi-step merge):
		// no content match exists, so the chip anchors to the last assistant message.
		// TWO assistant messages in `adopted`, or "last" would be indistinguishable
		// from "first" — the mutation this fixture must kill.
		const local: ChipBearer[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'step 1', knowledgeWrites: [chip('k1')] },
			{ role: 'assistant', content: 'step 2' },
		];
		const adopted: ChipBearer[] = [
			{ role: 'assistant', content: 'earlier turn' },
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'merged answer' },
		];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[0]!.knowledgeWrites).toBeUndefined();
		expect(adopted[2]!.knowledgeWrites?.map((w) => w.id)).toEqual(['k1']);
	});

	it('never duplicates an id the adopted transcript already carries', () => {
		const local: ChipBearer[] = [{ role: 'assistant', content: 'done', knowledgeWrites: [chip('k1'), chip('k2')] }];
		const adopted: ChipBearer[] = [{ role: 'assistant', content: 'done', knowledgeWrites: [chip('k1')] }];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[0]!.knowledgeWrites?.map((w) => w.id)).toEqual(['k1', 'k2']);
	});

	it('pairs duplicate-content messages positionally, not both onto the first', () => {
		// Two tool-call messages share empty content; the cursor keeps the pairing ordered.
		const local: ChipBearer[] = [
			{ role: 'assistant', content: '', knowledgeWrites: [chip('k1')] },
			{ role: 'assistant', content: '', knowledgeWrites: [chip('k2')] },
		];
		const adopted: ChipBearer[] = [
			{ role: 'assistant', content: '' },
			{ role: 'assistant', content: '' },
		];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[0]!.knowledgeWrites?.map((w) => w.id)).toEqual(['k1']);
		expect(adopted[1]!.knowledgeWrites?.map((w) => w.id)).toEqual(['k2']);
	});

	it('carries resolved chips too — a reviewed chip must keep rendering as done', () => {
		const resolved: KnowledgeWriteChip = { ...chip('k1'), resolved: 'kept' };
		const local: ChipBearer[] = [{ role: 'assistant', content: 'done', knowledgeWrites: [resolved] }];
		const adopted: ChipBearer[] = [{ role: 'assistant', content: 'done' }];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[0]!.knowledgeWrites?.[0]?.resolved).toBe('kept');
	});

	it('drops chips without throwing when the adopted transcript has no assistant message', () => {
		const local: ChipBearer[] = [{ role: 'assistant', content: 'x', knowledgeWrites: [chip('k1')] }];
		const adopted: ChipBearer[] = [{ role: 'user', content: 'hi' }];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[0]!.knowledgeWrites).toBeUndefined();
		carryKnowledgeWrites(local, []); // empty adopted: same drop branch, must not throw
	});

	it('advances the cursor past chip-less twins so a later chip anchors positionally', () => {
		// The first "done" reply has NO chip; the second does. Without lockstep cursor
		// advance the chip would anchor onto the earlier, chip-less twin.
		const local: ChipBearer[] = [
			{ role: 'assistant', content: 'done' },
			{ role: 'user', content: 'again' },
			{ role: 'assistant', content: 'done', knowledgeWrites: [chip('k1')] },
		];
		const adopted: ChipBearer[] = [
			{ role: 'assistant', content: 'done' },
			{ role: 'user', content: 'again' },
			{ role: 'assistant', content: 'done' },
		];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[0]!.knowledgeWrites).toBeUndefined();
		expect(adopted[2]!.knowledgeWrites?.map((w) => w.id)).toEqual(['k1']);
	});

	it('dedups partially on the fallback path — only the fresh chip lands', () => {
		const local: ChipBearer[] = [
			{ role: 'assistant', content: 'step 1', knowledgeWrites: [chip('k1'), chip('k2')] },
		];
		const adopted: ChipBearer[] = [
			{ role: 'assistant', content: 'merged', knowledgeWrites: [chip('k1')] },
		];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[0]!.knowledgeWrites?.map((w) => w.id)).toEqual(['k1', 'k2']);
	});
});

describe('allKnowledgeWrites', () => {
	it('flattens every chip across the transcript in message order', () => {
		const messages: ChipBearer[] = [
			{ role: 'assistant', content: 'a', knowledgeWrites: [{ id: 'k1', status: 'active', text: 'x' }] },
			{ role: 'user', content: 'b' },
			{ role: 'assistant', content: 'c', knowledgeWrites: [{ id: 'k2', status: 'pending_review', text: 'y' }] },
		];
		expect(allKnowledgeWrites(messages).map((w) => w.id)).toEqual(['k1', 'k2']);
		expect(allKnowledgeWrites([])).toEqual([]);
	});
});

describe('transcript adoption wires the carry-over (source guard)', () => {
	// `chat.svelte.ts` is a Svelte 5 rune module the root vitest config cannot import
	// (`$state is not defined`) — the same constraint chat-detach-reset.test.ts documents.
	// So the two call sites are pinned at source level: BOTH wholesale adoptions
	// (`messages = serverMessages`) must be immediately preceded by a
	// `carryKnowledgeWrites(..., serverMessages)` call. Removing either call — the
	// mutation that re-opens the chip wipe — fails here; the behaviour of the carry
	// itself is covered by the block above.
	it('both adoption sites call carryKnowledgeWrites before swapping in serverMessages', () => {
		const src = readFileSync(fileURLToPath(new URL('./chat.svelte.ts', import.meta.url)), 'utf-8');
		// Line-start anchored: a commented-out call (`// carryKnowledgeWrites(...)`)
		// must NOT satisfy this guard.
		const swaps = src.match(/(?:^|\n)[\t ]*carryKnowledgeWrites\((?:localMessages|messages), serverMessages\);[\s\S]{0,220}?messages = serverMessages;/g) ?? [];
		expect(swaps.length, 'each wholesale adoption must carry knowledgeWrites over').toBe(2);
		const totalSwaps = src.match(/messages = serverMessages;/g) ?? [];
		expect(totalSwaps.length, 'a new adoption site was added without carry-over').toBe(2);
	});

	it('the SSE knowledge_write handler dedups against the whole transcript', () => {
		const src = readFileSync(fileURLToPath(new URL('./chat.svelte.ts', import.meta.url)), 'utf-8');
		// Per-message dedup (`projectKnowledgeWrite(msg.knowledgeWrites ?? []`) re-adds a
		// replayed id after adoption anchored the carried chip on another message.
		expect(/(?:^|\n)[\t ]*\[\.\.\.allKnowledgeWrites\(messages\), \.\.\.\(msg\.knowledgeWrites \?\? \[\]\)\], data\)/.test(src),
			'knowledge_write must dedup transcript-globally via allKnowledgeWrites').toBe(true);
	});
});

describe('store wrappers delegate the chip glue (source guard)', () => {
	// The dead-wire class: `performRetire`/`performReview`'s own tests stay green even if
	// the store stops calling them or re-inlines a divergent copy. Pinned at source because
	// the rune module cannot be imported. Line-start anchored so a commented-out line never
	// passes. Three layers per wrapper, because each can die independently: the delegation
	// call, the send closure's REAL `res.ok` (an `ok: true` here silently kills the 2xx
	// gate in production while every unit test stays green), and the outcome consumers
	// (an assigned-but-ignored result would drop the toast / the pending-count refresh).
	const src = readFileSync(fileURLToPath(new URL('./chat.svelte.ts', import.meta.url)), 'utf-8');

	it('retireKnowledge: delegation, real res.ok, and the failure toast', () => {
		expect(/(?:^|\n)[\t ]*const outcome = await performRetire\(chip, async \(\) => \{/.test(src),
			'retireKnowledge must delegate its guard/gate/transition to performRetire').toBe(true);
		expect(/(?:^|\n)[\t ]*return \{ ok: res\.ok \};/.test(src),
			'the retire send closure must report the REAL res.ok').toBe(true);
		expect(/(?:^|\n)[\t ]*if \(outcome === 'failed'\) addToast\(t\('chat\.knowledge\.undo_failed'\)/.test(src),
			'a failed retire must surface the undo_failed toast').toBe(true);
	});

	it('reviewKnowledge: delegation, real res.ok, tested body/parse helpers, both consumers', () => {
		expect(/(?:^|\n)[\t ]*const result = await performReview\(chip, action, editedText, async \(\) => \{/.test(src),
			'reviewKnowledge must delegate its guard/gate/transition to performReview').toBe(true);
		expect(/(?:^|\n)[\t ]*if \(res\.ok\) return \{ ok: true, errorMessage: null \};/.test(src),
			'the review send closure must gate on the REAL res.ok').toBe(true);
		expect(/(?:^|\n)[\t ]*body: JSON\.stringify\(reviewRequestBody\(action, editedText\)\),/.test(src),
			'the request body must come from the tested reviewRequestBody helper').toBe(true);
		expect(/(?:^|\n)[\t ]*return \{ ok: false, errorMessage: parseReviewFailure\(res\.status, body\) \};/.test(src),
			'the failure wording must come from the tested parseReviewFailure helper').toBe(true);
		expect(/(?:^|\n)[\t ]*if \(result\.outcome === 'failed'\) \{\n[\t ]*addToast\(result\.errorMessage \?\? t\('chat\.knowledge\.review_failed'\)/.test(src),
			'a failed review must surface the server wording (or the generic line) as a toast').toBe(true);
		expect(/(?:^|\n)[\t ]*\} else if \(result\.outcome === 'resolved'\) \{[\s\S]{0,240}?void refreshThreadPendingCount\(\);/.test(src),
			'a resolved review must refresh the thread pending count').toBe(true);
	});
});

describe('ChatView re-anchors for a late knowledge chip (source guard)', () => {
	it('streamSignal counts knowledgeWrites', () => {
		// A chip arrives near the very END of a turn, appended after the text settled.
		// If `streamSignal` does not count knowledgeWrites, the pin effect never re-runs
		// for that late height change and the review chip renders under the composer —
		// the person approves a capture they never saw (founder-observed 2026-08-09,
		// reproduced at the pixel: chip bottom 860px vs composer top 797px at 1440x900).
		const src = readFileSync(fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8');
		const signal = src.match(/const streamSignal = \$derived\.by\(\(\) => \{[\s\S]*?\n\t\}\);/)?.[0];
		expect(signal, 'streamSignal derivation not found — update this guard').toBeTruthy();
		// The CODE line, not a substring — a comment inside the block naming the
		// identifier must never satisfy this guard.
		expect(signal, 'streamSignal must count knowledgeWrites so a late chip re-anchors the view')
			.toMatch(/if \(m\.knowledgeWrites\) s \+= m\.knowledgeWrites\.length;/);
	});
});

// ── DEF-dk-review-chip-resume-invisible: queue re-hydration ────────────────

describe('queueEntriesToChips', () => {
	const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
		id: 'ke_1',
		subjectHint: 'SVA',
		kind: 'fact',
		status: 'pending_review',
		text: 'Die SVA-Anmeldung ist seit gestern durch.',
		...over,
	});

	it('projects a pending queue row into a pending_review chip (subjectHint → subject)', () => {
		const [chip] = queueEntriesToChips([], [row()]);
		expect(chip).toBeDefined();
		expect(chip!.status).toBe('pending_review');
		expect(chip!.subject).toBe('SVA');
		expect(chip!.text).toContain('SVA-Anmeldung');
	});

	it('drops entries whose id is already chipped (reload after a carried chip)', () => {
		const existing: KnowledgeWriteChip[] = [{ id: 'ke_1', status: 'pending_review', text: 'x' }];
		expect(queueEntriesToChips(existing, [row()])).toHaveLength(0);
	});

	it('skips malformed entries instead of throwing', () => {
		expect(queueEntriesToChips([], [null, 'string', 3, row()])).toHaveLength(1);
	});

	it('an already-approved row keeps its queue filter server-side — only pending rows arrive', () => {
		// The endpoint filters status=pending_review; nothing here can mint an
		// `active` chip from a queue row even if a future caller passes one
		// whose stored status drifted.
		const [chip] = queueEntriesToChips([], [row({ status: 'active' })]);
		expect(chip!.status).toBe('pending_review');
	});
});
