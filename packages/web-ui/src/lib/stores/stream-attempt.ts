import type { ContentBlock, ToolCallInfo } from './chat-attribution.js';

/**
 * Where a provider call began in an assistant message, so a call the engine retries can be taken
 * back out of it. A retried call is sent again from the same history: what it streamed before it
 * failed (text, thinking, tool-call chips) is not part of the answer, and leaving it in shows the
 * reply twice. What earlier calls of the same turn streamed stays.
 *
 * The engine sends no event at the start of a call. Its end is `turn_end` (the model's stop
 * reason), and the next call's first content follows it, so a mark is taken at the first content
 * of a run and again at each `turn_end`; the mark at a `turn_end` becomes the current call's start
 * once the next call streams something.
 */
export interface CallMark {
	readonly contentLength: number;
	readonly blockCount: number;
	/** Text length of the last block when it is text or thinking: a later call can append to it. */
	readonly lastBlockTextLength: number | undefined;
	readonly toolCallCount: number;
	readonly thinkingLength: number;
	readonly toolSinceText: boolean;
}

/** The parts of an assistant message a call streams into. */
export interface AttemptState {
	content: string;
	blocks?: ContentBlock[] | undefined;
	toolCalls?: ToolCallInfo[] | undefined;
	thinking?: string | undefined;
	_toolSinceText?: boolean | undefined;
}

export function markCall(state: AttemptState): CallMark {
	const blocks = state.blocks ?? [];
	const last = blocks[blocks.length - 1];
	return {
		contentLength: state.content.length,
		blockCount: blocks.length,
		lastBlockTextLength: last && (last.type === 'text' || last.type === 'thinking') ? last.text.length : undefined,
		toolCallCount: state.toolCalls?.length ?? 0,
		thinkingLength: state.thinking?.length ?? 0,
		toolSinceText: state._toolSinceText === true,
	};
}

/** Take out of `state` everything streamed after `mark`. */
export function trimToMark(state: AttemptState, mark: CallMark): void {
	state.content = state.content.slice(0, mark.contentLength);
	if (state.blocks) {
		state.blocks.length = Math.min(state.blocks.length, mark.blockCount);
		const last = state.blocks[state.blocks.length - 1];
		if (last && mark.lastBlockTextLength !== undefined && (last.type === 'text' || last.type === 'thinking')) {
			last.text = last.text.slice(0, mark.lastBlockTextLength);
		}
	}
	if (state.toolCalls) state.toolCalls.length = Math.min(state.toolCalls.length, mark.toolCallCount);
	if (state.thinking !== undefined) state.thinking = state.thinking.slice(0, mark.thinkingLength);
	state._toolSinceText = mark.toolSinceText;
}
