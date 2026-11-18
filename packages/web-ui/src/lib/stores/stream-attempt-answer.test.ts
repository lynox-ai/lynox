import { describe, expect, it } from 'vitest';
import { markCall, trimToMark, type AttemptState } from './stream-attempt.js';

describe('a retried call taken out of the reply', () => {
	it('keeps a typed answer given after the call began: it is not the call\'s output', () => {
		const state: AttemptState = { content: 'Before.', blocks: [{ type: 'text', text: 'Before.' }] };
		const mark = markCall(state);
		state.blocks!.push({ type: 'answer', text: 'ja' });
		state.blocks!.push({ type: 'text', text: 'Partial output' });
		state.content += 'Partial output';
		trimToMark(state, mark);
		expect(state.blocks).toEqual([{ type: 'text', text: 'Before.' }, { type: 'answer', text: 'ja' }]);
		expect(state.content).toBe('Before.');
	});

	it('control: without a typed answer it takes out everything after the mark', () => {
		const state: AttemptState = { content: 'Before.', blocks: [{ type: 'text', text: 'Before.' }] };
		const mark = markCall(state);
		state.blocks!.push({ type: 'text', text: 'Partial output' });
		trimToMark(state, mark);
		expect(state.blocks).toEqual([{ type: 'text', text: 'Before.' }]);
	});
});
