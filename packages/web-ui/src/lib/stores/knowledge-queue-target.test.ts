import { describe, it, expect } from 'vitest';
import { approveTargetLabel } from './knowledge-queue-target.js';

/**
 * The queue row is a consent surface: the reviewer presses approve on the strength of what
 * it says. Each arm therefore has to say the thing that would change the decision — and the
 * fallback has to say LESS rather than something wrong.
 */
describe('approveTargetLabel', () => {
	it('an existing subject shows its name and kind, with no consequence note', () => {
		const l = approveTargetLabel({ resolution: 'existing', id: 's1', name: 'Vireo', kind: 'product' }, 'Vireo');
		expect(l).toEqual({
			name: 'Vireo', kind: 'product', noteKey: null,
			titleKey: 'knowledge.queue.target_existing_title', emphasis: false,
		});
	});

	// The mint is the consequence a reviewer cannot see in the hint. Neutral styling would
	// put it beside the kind chip as if it were metadata — hence `emphasis`. Asserted as a
	// WHOLE object, not field by field: picking fields leaves the unpicked ones free, and a
	// mutation swapping this arm's `titleKey` for the existing-arm one survived that way.
	it('an unknown name says the approval will CREATE the subject, emphasised', () => {
		expect(approveTargetLabel({ resolution: 'new', name: 'Nordberg AG', kind: 'organization' }, 'Nordberg AG')).toEqual({
			name: 'Nordberg AG', kind: 'organization', noteKey: 'knowledge.queue.target_new',
			titleKey: 'knowledge.queue.target_new_title', emphasis: true,
		});
	});

	it('an ambiguous name says NO link is made, and offers no kind to imply one', () => {
		expect(approveTargetLabel({ resolution: 'ambiguous', name: 'Wikipedia', candidates: 2 }, 'Wikipedia')).toEqual({
			name: 'Wikipedia', kind: null, noteKey: 'knowledge.queue.target_ambiguous',
			titleKey: 'knowledge.queue.target_ambiguous_title', emphasis: false,
		});
	});

	/**
	 * The hint and the resolved name are the SAME string in every other fixture here, which
	 * makes `name: target.name` and `name: hint` indistinguishable — a mutation swapping
	 * them survived the whole suite. The canonical name behind a non-identical hint is the
	 * one field this component exists to show, so it gets a case where they differ.
	 */
	it('shows the CANONICAL subject name, not the hint that found it', () => {
		const l = approveTargetLabel({ resolution: 'existing', id: 's1', name: 'Nordberg AG', kind: 'organization' }, 'nordberg ag');
		expect(l.name).toBe('Nordberg AG');
	});

	/**
	 * An engine older than this UI sends no target. That is the one case where the previous,
	 * less informative rendering is the CORRECT one — anything else claims to know what
	 * approve will do on a server that never told us.
	 */
	it.each([
		['absent (older engine)', undefined],
		['null (no hint on the entry)', null],
	])('%s falls back to the bare hint and promises nothing', (_case, target) => {
		expect(approveTargetLabel(target, 'SVA')).toEqual({
			name: 'SVA', kind: null, noteKey: null, titleKey: null, emphasis: false,
		});
	});

	it('an unknown resolution from a NEWER engine also falls back rather than guessing', () => {
		const future = { resolution: 'merged', name: 'X' } as unknown as Parameters<typeof approveTargetLabel>[0];
		expect(approveTargetLabel(future, 'SVA').name).toBe('SVA');
	});
});
