/**
 * OpenAI-compatible adapter for non-Claude LLM providers.
 *
 * Translates between Anthropic SDK types (used by Agent) and OpenAI API format
 * (used by Mistral, Gemini, etc.). No external dependencies.
 *
 * The Agent calls `client.beta.messages.stream(params)` and iterates over
 * `BetaRawMessageStreamEvent`s. This adapter makes the same call to an
 * OpenAI-compatible endpoint and translates the SSE response on the fly.
 */

import type {
  BetaRawMessageStreamEvent,
  BetaRawContentBlockStartEvent,
  BetaRawContentBlockDeltaEvent,
  BetaRawMessageDeltaEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type Anthropic from '@anthropic-ai/sdk';

// ── Types ───────────────────────────────────────────────────────

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | undefined;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined;
  tool_call_id?: string | undefined;
}

interface OpenAIStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string | undefined;
      content?: string | null | undefined;
      tool_calls?: Array<{
        index: number;
        id?: string | undefined;
        type?: string | undefined;
        function?: { name?: string | undefined; arguments?: string | undefined } | undefined;
      }> | undefined;
    };
    finish_reason?: string | null | undefined;
  }>;
  usage?: { prompt_tokens?: number | undefined; completion_tokens?: number | undefined } | undefined;
}

// ── Request Translation ─────────────────────────────────────────

function translateTools(tools: Anthropic.Tool[]): OpenAITool[] {
  return tools
    .filter((t): t is Anthropic.Tool & { name: string; input_schema: Record<string, unknown> } =>
      'name' in t && 'input_schema' in t)
    .map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema,
      },
    }));
}

function translateMessages(
  system: unknown,
  messages: unknown[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System prompt: Anthropic uses separate `system` field, OpenAI uses a message
  if (system) {
    if (typeof system === 'string') {
      result.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      // System blocks array — extract text content
      const text = system
        .filter((b: unknown): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && 'type' in b && (b as { type: string }).type === 'text' && 'text' in b)
        .map(b => b.text)
        .join('\n\n');
      if (text) result.push({ role: 'system', content: text });
    }
  }

  // Messages: translate Anthropic format to OpenAI format
  for (const msg of messages) {
    const m = msg as { role: string; content: unknown };
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        result.push({ role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        // Extract text from content blocks
        const text = (m.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('\n');
        result.push({ role: 'user', content: text });
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        result.push({ role: 'assistant', content: m.content });
      } else if (Array.isArray(m.content)) {
        const blocks = m.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        const textParts = blocks.filter(b => b.type === 'text').map(b => b.text ?? '');
        const toolCalls = blocks
          .filter(b => b.type === 'tool_use')
          .map(b => ({
            id: b.id ?? '',
            type: 'function' as const,
            function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
          }));

        result.push({
          role: 'assistant',
          content: textParts.join('\n') || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    } else if (m.role === 'tool') {
      // Anthropic sends tool results as user messages with tool_result content blocks
      // But in multi-turn, they come as role: 'user' with tool_result blocks
    }

    // Handle user messages that contain tool_result blocks (Anthropic's format for tool responses)
    if (m.role === 'user' && Array.isArray(m.content)) {
      const blocks = m.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>;
      const toolResults = blocks.filter(b => b.type === 'tool_result');
      if (toolResults.length > 0) {
        // Remove the user message we just added (it was a tool result, not a real user message)
        const lastAdded = result[result.length - 1];
        if (lastAdded?.role === 'user') result.pop();

        for (const tr of toolResults) {
          let content = '';
          if (typeof tr.content === 'string') {
            content = tr.content;
          } else if (Array.isArray(tr.content)) {
            content = (tr.content as Array<{ type: string; text?: string }>)
              .filter(b => b.type === 'text')
              .map(b => b.text ?? '')
              .join('\n');
          }
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id ?? '',
            content,
          });
        }
      }
    }
  }

  return result;
}

// ── Response Stream Translation ─────────────────────────────────

async function* translateStream(
  response: Response,
): AsyncIterable<BetaRawMessageStreamEvent> {
  // Emit message_start
  yield {
    type: 'message_start',
    message: {
      id: '',
      type: 'message',
      role: 'assistant',
      content: [],
      model: '',
      stop_reason: null,
      stop_sequence: null,
      container: null,
      context_management: null,
      usage: {
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
      },
    },
  } as unknown as BetaRawMessageStreamEvent;

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  let blockIndex = 0;
  let activeTextBlock = false;
  // Track tool call indices → block indices
  const toolBlockMap = new Map<number, number>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let chunk: OpenAIStreamChunk;
        try { chunk = JSON.parse(data) as OpenAIStreamChunk; } catch { continue; }

        // Track usage from streaming chunks
        if (chunk.usage) {
          totalInputTokens = chunk.usage.prompt_tokens ?? totalInputTokens;
          totalOutputTokens = chunk.usage.completion_tokens ?? totalOutputTokens;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        // Text content
        if (choice.delta.content) {
          if (!activeTextBlock) {
            activeTextBlock = true;
            yield {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '', citations: null },
            } as unknown as BetaRawContentBlockStartEvent as BetaRawMessageStreamEvent;
          }
          yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: choice.delta.content },
          } as unknown as BetaRawContentBlockDeltaEvent as BetaRawMessageStreamEvent;
        }

        // Tool calls
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (!toolBlockMap.has(tc.index)) {
              // Close text block if active
              if (activeTextBlock) {
                yield { type: 'content_block_stop', index: blockIndex } as BetaRawMessageStreamEvent;
                blockIndex++;
                activeTextBlock = false;
              }
              // Start new tool_use block
              toolBlockMap.set(tc.index, blockIndex);
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id ?? `tool_${blockIndex}`,
                  name: tc.function?.name ?? '',
                  input: {},
                },
              } as unknown as BetaRawContentBlockStartEvent as BetaRawMessageStreamEvent;
            }

            // Stream tool arguments as input_json_delta
            if (tc.function?.arguments) {
              const bi = toolBlockMap.get(tc.index) ?? blockIndex;
              yield {
                type: 'content_block_delta',
                index: bi,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              } as unknown as BetaRawContentBlockDeltaEvent as BetaRawMessageStreamEvent;
            }
          }
        }

        // Finish
        if (choice.finish_reason) {
          // Close any active blocks
          if (activeTextBlock) {
            yield { type: 'content_block_stop', index: blockIndex } as BetaRawMessageStreamEvent;
            blockIndex++;
            activeTextBlock = false;
          }
          for (const [, bi] of toolBlockMap) {
            yield { type: 'content_block_stop', index: bi } as BetaRawMessageStreamEvent;
          }

          const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use'
            : choice.finish_reason === 'stop' ? 'end_turn'
            : choice.finish_reason;

          yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          } as unknown as BetaRawMessageDeltaEvent as BetaRawMessageStreamEvent;

          yield { type: 'message_stop' } as BetaRawMessageStreamEvent;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Adapter Class ───────────────────────────────────────────────

export class OpenAIAdapter {
  private baseURL: string;
  private apiKey: string;
  private modelId: string;

  constructor(opts: { baseURL: string; apiKey: string; modelId: string }) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.modelId = opts.modelId;
  }

  /**
   * Matches the interface used by Agent: `client.beta.messages.stream(params, options)`.
   * Returns a stream object that is both AsyncIterable AND provides `.finalMessage()`
   * for code paths like memory extraction that await the complete message.
   */
  beta = {
    messages: {
      stream: (
        params: {
          model: string;
          max_tokens: number;
          system?: unknown;
          messages: unknown[];
          tools?: Anthropic.Tool[];
          [key: string]: unknown;
        },
        options?: { signal?: AbortSignal | undefined },
      ): AsyncIterable<BetaRawMessageStreamEvent> & { finalMessage: () => Promise<{ content: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }> } => {
        const iterable = this._stream(params, options);
        return {
          [Symbol.asyncIterator]: iterable[Symbol.asyncIterator].bind(iterable),
          finalMessage: async () => {
            // Iterate through the stream and assemble the final message
            const content: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }> = [];
            const rawInputs = new Map<number, string>();
            let stopReason = 'end_turn';
            let inputTokens = 0;
            let outputTokens = 0;

            for await (const event of iterable) {
              if (event.type === 'content_block_start') {
                const block = (event as { content_block: { type: string; text?: string; name?: string; id?: string } }).content_block;
                content.push({ ...block });
                if (block.type === 'tool_use') {
                  rawInputs.set((event as { index: number }).index, '');
                }
              } else if (event.type === 'content_block_delta') {
                const delta = (event as { delta: { type: string; text?: string; partial_json?: string } }).delta;
                const idx = (event as { index: number }).index;
                const block = content[idx];
                if (!block) continue;
                if (delta.type === 'text_delta' && delta.text) {
                  block.text = (block.text ?? '') + delta.text;
                } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                  rawInputs.set(idx, (rawInputs.get(idx) ?? '') + delta.partial_json);
                }
              } else if (event.type === 'content_block_stop') {
                const idx = (event as { index: number }).index;
                const block = content[idx];
                if (block?.type === 'tool_use') {
                  const json = rawInputs.get(idx) ?? '{}';
                  try { block.input = JSON.parse(json); } catch { block.input = {}; }
                }
              } else if (event.type === 'message_delta') {
                const e = event as { delta: { stop_reason?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
                if (e.delta.stop_reason) stopReason = e.delta.stop_reason;
                if (e.usage?.input_tokens) inputTokens = e.usage.input_tokens;
                if (e.usage?.output_tokens) outputTokens = e.usage.output_tokens;
              }
            }

            return { content, stop_reason: stopReason, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
          },
        };
      },
    },
  };

  private _stream(
    params: {
      model: string;
      max_tokens: number;
      system?: unknown;
      messages: unknown[];
      tools?: Anthropic.Tool[];
      [key: string]: unknown;
    },
    options?: { signal?: AbortSignal | undefined },
  ): AsyncIterable<BetaRawMessageStreamEvent> {
    const self = this;

    return {
      [Symbol.asyncIterator]() {
        let generator: AsyncGenerator<BetaRawMessageStreamEvent> | null = null;

        return {
          async next() {
            if (!generator) {
              generator = self._doStream(params, options);
            }
            return generator.next();
          },
          async return() {
            if (generator) await generator.return(undefined);
            return { done: true as const, value: undefined };
          },
          async throw(err: unknown) {
            if (generator) return generator.throw(err);
            throw err;
          },
        };
      },
    };
  }

  private async *_doStream(
    params: {
      model: string;
      max_tokens: number;
      system?: unknown;
      messages: unknown[];
      tools?: Anthropic.Tool[];
      [key: string]: unknown;
    },
    options?: { signal?: AbortSignal | undefined },
  ): AsyncGenerator<BetaRawMessageStreamEvent> {
    const openaiMessages = translateMessages(params.system, params.messages);
    const openaiTools = params.tools ? translateTools(params.tools) : undefined;

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: openaiMessages,
      max_tokens: params.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
    };
    if (openaiTools?.length) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal ?? null,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI-compatible API error ${response.status}: ${errText}`);
    }

    yield* translateStream(response);
  }
}
