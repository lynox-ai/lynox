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
 * WOULD produce it: a dedup keyed on something coarser than the id, or a carry that
 * takes only the first chip. Both were confirmed to fail these tests by mutation.
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

	it('leaves the sibling untouched and unresolved when one is approved', async () => {
		const chips = [chip(A), chip(B)];
		const out = await performReview(chips[1], 'approve', undefined, async () => ({ ok: true, errorMessage: null }));
		expect(out.outcome).toBe('resolved');
		expect(chips[1]!.resolved).toBe('kept');
		// The observation: after approving one, is the OTHER still there and actionable?
		expect(chips[0]!.resolved).toBeUndefined();
		expect(chips.map((c) => c.id)).toEqual([A, B]);
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
