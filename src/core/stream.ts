import type { EmittingStreamHandler } from '../types/index.js';
import type {
  BetaRawMessageStreamEvent,
  BetaContentBlock,
  BetaTextBlock,
  BetaToolUseBlock,
  BetaThinkingBlock,
  BetaTextDelta,
  BetaThinkingDelta,
  BetaInputJSONDelta,
  BetaRawContentBlockStartEvent,
  BetaRawContentBlockDeltaEvent,
  BetaRawMessageDeltaEvent,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type { ImitationHit, ToolCallImitationDetector } from './tool-call-imitation.js';
import { StreamIncompleteError } from './stream-incomplete.js';

/** A reply cut off mid-stream, as far as it came: the usage the provider reported
 *  (`message_start`, any `message_delta`) and the content blocks streamed so far. */
export interface PartialReply {
  readonly usage: BetaUsage | undefined;
  readonly content: readonly BetaContentBlock[];
}

/**
 * Stops a reply that writes a tool call out as text again and again. `stop` is
 * called once, when the detector trips, before the stream is left: it is where
 * the caller ends the upstream request, and the error it returns is thrown out
 * of `process()`.
 */
export interface ImitationGuard {
  readonly detector: ToolCallImitationDetector;
  readonly stop: (hit: ImitationHit, partial: PartialReply) => Error;
}

export class StreamProcessor {
  constructor(
    private onEvent: EmittingStreamHandler,
    private agentName: string,
    private guard?: ImitationGuard | undefined,
  ) {}

  /** Usage seen so far in the current stream; the `message_delta` merge updates it in place. */
  private _usage: BetaUsage | undefined;
  /** Content blocks streamed so far in the current stream; filled in place as events arrive. */
  private _content: BetaContentBlock[] = [];
  /**
   * Stream events received so far: more than zero once the provider has answered. On the
   * openai-compatible wire the adapter's first event follows the provider's accepting HTTP
   * response, before any body; on the Anthropic wire it is the provider's own first event.
   */
  private _events = 0;

  /** Whether the provider answered this stream with at least one event. */
  answered(): boolean {
    return this._events > 0;
  }

  /**
   * Whether this stream's `turn_end` was handed on, with the usage of its `message_delta`. A
   * consumer counts that usage into the run's own (Session does), so a call ended after it
   * must not add an estimate of the same reply on top.
   */
  private _turnEnded = false;

  /** Whether `turn_end` was handed on for this stream (see {@link _turnEnded}). */
  turnEnded(): boolean {
    return this._turnEnded;
  }

  /**
   * The reply as far as it came: for a caller that ends the stream from outside (a user stop)
   * and books what the provider billed. Before the first event, no usage and no content.
   */
  partial(): PartialReply {
    return { usage: this._usage, content: this._content };
  }

  async process(stream: AsyncIterable<BetaRawMessageStreamEvent>): Promise<{
    content: BetaContentBlock[];
    stop_reason: string;
    usage: BetaUsage;
  }> {
    const content: BetaContentBlock[] = [];
    this._content = content;
    const rawInputs = new Map<number, string>();
    let stopReason = 'end_turn';
    let usage: BetaUsage | undefined;
    let stopped = false;

    for await (const event of stream) {
      this._events++;
      switch (event.type) {
        case 'content_block_start':
          this._handleBlockStart(event, content, rawInputs);
          break;

        case 'content_block_delta':
          await this._handleBlockDelta(event, content, rawInputs);
          break;

        case 'content_block_stop':
          await this._handleBlockStop(event, content, rawInputs);
          break;

        case 'message_delta':
          {
            const next = await this._handleMessageDelta(event, usage);
            if (next.stopReason !== undefined) {
              stopReason = next.stopReason;
            }
          }
          break;

        case 'message_start':
          usage = event.message.usage;
          this._usage = usage;
          break;

        case 'message_stop':
          stopped = true;
          break;
      }
    }

    // A response closed cleanly before its `message_stop` is a cut-off reply, even after its
    // `message_delta`: returned, it would pass for a finished answer.
    if (!stopped) throw new StreamIncompleteError();

    if (!usage) {
      usage = {
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        inference_geo: null,
        input_tokens: 0,
        iterations: null,
        output_tokens: 0,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      };
    }

    return { content, stop_reason: stopReason, usage };
  }

  private _handleBlockStart(
    event: BetaRawContentBlockStartEvent,
    content: BetaContentBlock[],
    rawInputs: Map<number, string>,
  ): void {
    const block = event.content_block;
    content.push(block);

    if (block.type === 'tool_use') {
      rawInputs.set(event.index, '');
    }
    // A real call has started (a server tool, such as web search, counts as one).
    if (block.type === 'tool_use' || block.type === 'server_tool_use') this.guard?.detector.noteToolUse();
  }

  private async _handleBlockDelta(
    event: BetaRawContentBlockDeltaEvent,
    content: BetaContentBlock[],
    rawInputs: Map<number, string>,
  ): Promise<void> {
    const delta = event.delta;
    const block = content[event.index];
    if (!block) return;

    switch (delta.type) {
      case 'text_delta': {
        const textDelta = delta as BetaTextDelta;
        const textBlock = block as BetaTextBlock;
        (textBlock as { text: string }).text += textDelta.text;
        // Checked before the delta is shown: the delta that completes a stopping
        // copy is not rendered.
        const hit = this.guard?.detector.push(textDelta.text) ?? null;
        if (hit !== null && this.guard) throw this.guard.stop(hit, { usage: this._usage, content });
        await this.onEvent({ type: 'text', text: textDelta.text, agent: this.agentName });
        break;
      }

      case 'thinking_delta': {
        const thinkingDelta = delta as BetaThinkingDelta;
        const thinkingBlock = block as BetaThinkingBlock;
        (thinkingBlock as { thinking: string }).thinking += thinkingDelta.thinking;
        await this.onEvent({ type: 'thinking', thinking: thinkingDelta.thinking, agent: this.agentName });
        break;
      }

      case 'input_json_delta': {
        const jsonDelta = delta as BetaInputJSONDelta;
        const current = rawInputs.get(event.index) ?? '';
        rawInputs.set(event.index, current + jsonDelta.partial_json);
        break;
      }
    }
  }

  private async _handleBlockStop(
    event: { index: number },
    content: BetaContentBlock[],
    rawInputs: Map<number, string>,
  ): Promise<void> {
    const block = content[event.index];
    if (!block) return;

    if (block.type === 'thinking') {
      await this.onEvent({ type: 'thinking_done', agent: this.agentName });
      return;
    }

    if (block.type !== 'tool_use') return;

    const toolBlock = block as BetaToolUseBlock;
    const rawJson = rawInputs.get(event.index) ?? '';

    try {
      (toolBlock as { input: unknown }).input = rawJson ? JSON.parse(rawJson) as unknown : {};
    } catch {
      (toolBlock as { input: unknown }).input = {};
      // NOT fatal: the input was replaced with `{}` and the turn continues right
      // below. Emitting this as an indistinguishable `error` is what let the client
      // decide a live run had died.
      await this.onEvent({ type: 'error', message: `Failed to parse tool input for ${toolBlock.name}`, fatal: false, agent: this.agentName });
      return;
    }

    await this.onEvent({
      type: 'tool_call',
      name: toolBlock.name,
      input: toolBlock.input,
      agent: this.agentName,
      toolUseId: toolBlock.id,
    });
  }

  private async _handleMessageDelta(
    event: BetaRawMessageDeltaEvent,
    existingUsage?: BetaUsage | undefined,
  ): Promise<{ stopReason?: string | undefined }> {
    const stopReason = event.delta.stop_reason;
    const deltaUsage = event.usage;

    // Merge delta into existing usage (preserve cache fields from message_start)
    if (existingUsage) {
      if (deltaUsage.input_tokens !== null && deltaUsage.input_tokens !== undefined && deltaUsage.input_tokens > 0) {
        existingUsage.input_tokens = deltaUsage.input_tokens;
      }
      existingUsage.output_tokens = deltaUsage.output_tokens;
      if (deltaUsage.cache_creation_input_tokens !== null && deltaUsage.cache_creation_input_tokens !== undefined) {
        existingUsage.cache_creation_input_tokens = deltaUsage.cache_creation_input_tokens;
      }
      if (deltaUsage.cache_read_input_tokens !== null && deltaUsage.cache_read_input_tokens !== undefined) {
        existingUsage.cache_read_input_tokens = deltaUsage.cache_read_input_tokens;
      }
    }

    const usage: BetaUsage = existingUsage ?? {
      cache_creation: null,
      cache_creation_input_tokens: deltaUsage.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: deltaUsage.cache_read_input_tokens ?? null,
      inference_geo: null,
      input_tokens: deltaUsage.input_tokens ?? 0,
      iterations: deltaUsage.iterations ?? null,
      output_tokens: deltaUsage.output_tokens,
      server_tool_use: deltaUsage.server_tool_use ?? null,
      service_tier: null,
      speed: null,
    };

    if (stopReason !== null && stopReason !== undefined) {
      // Set before the hand-off, so a consumer that throws on it still leaves it set.
      this._turnEnded = true;
      await this.onEvent({
        type: 'turn_end',
        stop_reason: stopReason,
        usage,
        agent: this.agentName,
      });
      return { stopReason };
    }

    return {};
  }
}
