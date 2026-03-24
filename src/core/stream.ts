import type { StreamHandler } from '../types/index.js';
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

export class StreamProcessor {
  constructor(
    private onEvent: StreamHandler,
    private agentName: string,
  ) {}

  async process(stream: AsyncIterable<BetaRawMessageStreamEvent>): Promise<{
    content: BetaContentBlock[];
    stop_reason: string;
    usage: BetaUsage;
  }> {
    const content: BetaContentBlock[] = [];
    const rawInputs = new Map<number, string>();
    let stopReason = 'end_turn';
    let usage: BetaUsage | undefined;

    for await (const event of stream) {
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
          break;

        case 'message_stop':
          break;
      }
    }

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
      await this.onEvent({ type: 'error', message: `Failed to parse tool input for ${toolBlock.name}`, agent: this.agentName });
      return;
    }

    await this.onEvent({
      type: 'tool_call',
      name: toolBlock.name,
      input: toolBlock.input,
      agent: this.agentName,
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
      if (deltaUsage.input_tokens != null && deltaUsage.input_tokens > 0) {
        existingUsage.input_tokens = deltaUsage.input_tokens;
      }
      existingUsage.output_tokens = deltaUsage.output_tokens;
      if (deltaUsage.cache_creation_input_tokens != null) {
        existingUsage.cache_creation_input_tokens = deltaUsage.cache_creation_input_tokens;
      }
      if (deltaUsage.cache_read_input_tokens != null) {
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
