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

	it('an unknown name says the approval will CREATE the subject, emphasised', () => {
		const l = approveTargetLabel({ resolution: 'new', name: 'Nordberg AG', kind: 'organization' }, 'Nordberg AG');
		expect(l.noteKey).toBe('knowledge.queue.target_new');
		expect(l.kind).toBe('organization');
		// The mint is the consequence a reviewer cannot see in the hint. Neutral styling
		// would put it beside the kind chip as if it were metadata.
		expect(l.emphasis).toBe(true);
	});

	it('an ambiguous name says NO link is made, and offers no kind to imply one', () => {
		const l = approveTargetLabel({ resolution: 'ambiguous', name: 'Wikipedia', candidates: 2 }, 'Wikipedia');
		expect(l.noteKey).toBe('knowledge.queue.target_ambiguous');
		expect(l.kind).toBeNull();
		expect(l.titleKey).toBe('knowledge.queue.target_ambiguous_title');
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
