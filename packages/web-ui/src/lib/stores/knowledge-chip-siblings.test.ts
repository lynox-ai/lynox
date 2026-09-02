import { describe, it, expect } from 'vitest';
import {
	allKnowledgeWrites,
	carryKnowledgeWrites,
	performReview,
	projectKnowledgeWrite,
	queueEntriesToChips,
	anchorKnowledgeChips,
	type KnowledgeWriteChip,
	type ChipBearer,
} from './knowledge-chip.js';

/**
 * Two durable facts written by ONE turn must survive together, all the way from the
 * SSE event to the moment the person resolves one of them.
 *
 * Written while chasing a 2026-08-19 dogfood observation: a turn wrote two facts (two
 * `remember` calls 1ms apart, both subject "lynox GmbH"), one was approved, and the
 * screenshot afterwards showed only the approved chip. Real ids and the real sequence,
 * from capture-telemetry.jsonl on the reporting instance:
 *
 *   12:32:10.695  a66ccc10  pending_review  propose_shown
 *   12:32:10.696  19f4149c  pending_review  propose_shown
 *   12:32:40.488  19f4149c  propose_confirmed
 *   [screenshot]  a66ccc10 still pending, its chip not on screen
 *
 * These pass on the code as it stands — the DATA layer does not lose the sibling, and
 * that is what they now hold. The observation itself stayed unreproduced (the missing
 * chip is registered separately); what these cover is the class of regression that
 * WOULD produce it. Two mutations were run and both were caught: a dedup keyed on
 * `subject` instead of `id` kills the projection and resume tests, and a carry
 * truncated to `fresh[0]` kills the adoption test. That is the extent of the claim —
 * see the note in the resolve test for one property deliberately left unasserted.
 *
 * The render itself is out of reach here — web-ui has no component-test harness — so
 * a green run is an exoneration of the data path, not of the surface.
 */
const A = 'a66ccc10-bf02-48a7-9449-b027c6b85e2d'; // ELv2 / source-available
const B = '19f4149c-7ea7-40da-af46-c8211fe0e679'; // future revenue streams

const sse = (id: string) => ({
	id,
	subject: 'lynox GmbH',
	kind: 'fact',
	status: 'pending_review',
	text: `fact text for ${id}`,
	cause: 'conversation',
});

describe('two pending chips from ONE turn (dogfood 2026-08-19)', () => {
	it('projects BOTH sibling writes onto the same assistant message', () => {
		// Exactly the SSE handler's call shape (chat.svelte.ts:1804).
		const msg: ChipBearer = { role: 'assistant', content: 'answer' };
		const messages: ChipBearer[] = [{ role: 'user', content: 'q' }, msg];
		for (const id of [A, B]) {
			const chip = projectKnowledgeWrite(
				[...allKnowledgeWrites(messages), ...(msg.knowledgeWrites ?? [])],
				sse(id),
			);
			if (chip) (msg.knowledgeWrites ??= []).push(chip);
		}
		expect(msg.knowledgeWrites?.map((w) => w.id)).toEqual([A, B]);
	});

	it('keeps BOTH siblings across transcript adoption at run end', () => {
		const local: ChipBearer[] = [
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'answer', knowledgeWrites: [chip(A), chip(B)] },
		];
		const adopted: ChipBearer[] = [
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'answer' },
		];
		carryKnowledgeWrites(local, adopted);
		expect(adopted[1]!.knowledgeWrites?.map((w) => w.id)).toEqual([A, B]);
	});

	it('resolves the approved chip', async () => {
		// NOTE ON WHAT IS *NOT* ASSERTED HERE. The obvious test — "the sibling stays
		// unresolved" — cannot fail: `performReview(chip, …)` takes ONE chip and never
		// sees a list, so nothing in that module can reach a sibling to touch it.
		// Asserting it anyway would read as coverage of the reported symptom while being
		// a tautology. The sibling is unreachable from here as a PROPERTY OF THE
		// SIGNATURE; should it ever take a collection, this test owes a real one.
		// (The resolve transitions themselves — 2xx-gating, the already-resolved noop,
		// a thrown send — are covered in `knowledge-chip.test.ts`; not repeated here.)
		const chip1 = chip(B);
		const out = await performReview(chip1, 'approve', undefined, async () => ({ ok: true, errorMessage: null }));
		expect(out.outcome).toBe('resolved');
		expect(chip1.resolved).toBe('kept');
	});

	it('re-hydrates BOTH on resume while both are still pending', () => {
		const messages: ChipBearer[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'answer' }];
		const entries = [A, B].map((id) => ({ id, subjectHint: 'lynox GmbH', kind: 'fact', text: `fact ${id}`, cause: 'conversation' }));
		const chips = queueEntriesToChips(allKnowledgeWrites(messages), entries);
		const anchor = anchorKnowledgeChips(messages);
		if (chips.length > 0 && anchor) (anchor.knowledgeWrites ??= []).push(...chips);
		expect(messages[1]!.knowledgeWrites?.map((w) => w.id)).toEqual([A, B]);
	});

	it('re-hydrates ONLY the still-pending sibling after the other was approved', () => {
		// The queue route returns pending rows only, so after approving B the resume
		// path can carry A alone — the shape a reload lands in.
		const messages: ChipBearer[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'answer' }];
		const entries = [{ id: A, subjectHint: 'lynox GmbH', kind: 'fact', text: `fact ${A}`, cause: 'conversation' }];
		const chips = queueEntriesToChips(allKnowledgeWrites(messages), entries);
		const anchor = anchorKnowledgeChips(messages);
		if (chips.length > 0 && anchor) (anchor.knowledgeWrites ??= []).push(...chips);
		expect(messages[1]!.knowledgeWrites?.map((w) => w.id)).toEqual([A]);
	});
});

function chip(id: string): KnowledgeWriteChip {
	return { id, subject: 'lynox GmbH', kind: 'fact', status: 'pending_review', text: `fact text for ${id}`, cause: 'conversation' };
}
