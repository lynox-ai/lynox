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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';

import type {
  BetaRawMessageStreamEvent,
  BetaRawContentBlockStartEvent,
  BetaRawContentBlockDeltaEvent,
  BetaRawMessageDeltaEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type Anthropic from '@anthropic-ai/sdk';

// ── Per-tenant cache-key salt ───────────────────────────────────
//
// Mistral's prompt_cache_key is a tenant-side routing hint. Without a
// salt, two tenants sharing one MISTRAL_MANAGED_API_KEY (managed-tier
// reality) and using the same logical key (e.g. "bench-x-y") would
// route to the same cache partition → cross-tenant key collision.
//
// Salt source: persistent UUID at ${LYNOX_DIR}/.cache-salt. Per-tenant
// because LYNOX_DIR is per-tenant (managed: /var/lib/lynox/<id>;
// self-host: ~/.lynox). 16 hex chars → 64-bit collision space.
// Fallback for read-only-FS: in-memory crypto.randomBytes (still
// cross-tenant-safe, just loses cache benefit across restarts).
//
// Salt only appears in outgoing request bodies to api.mistral.ai —
// no console.log/debug-trace prints it.

// Module-scoped salt: one process = one tenant = one salt
// (per feedback_one_engine_per_tenant). Never refactor into an instance
// field — adapter instances per tenant don't exist in lynox's architecture.
let _cacheKeySaltMemo: string | undefined;
let _cacheSaltWarnedReadonly = false;
const SALT_HEX_RE = /^[0-9a-f]{16}$/;

export function getCacheKeySalt(): string {
  if (_cacheKeySaltMemo) return _cacheKeySaltMemo;
  const lynoxDir = process.env['LYNOX_DIR'] ?? path.join(os.homedir(), '.lynox');
  const saltPath = path.join(lynoxDir, '.cache-salt');
  try {
    if (fs.existsSync(saltPath)) {
      const content = fs.readFileSync(saltPath, 'utf-8').trim();
      // Validate format — manual edit/corruption could otherwise leak
      // arbitrary bytes into the outgoing Mistral routing key.
      if (SALT_HEX_RE.test(content)) {
        _cacheKeySaltMemo = content;
        return _cacheKeySaltMemo;
      }
      // Bad content → fall through to regenerate.
    }
    fs.mkdirSync(lynoxDir, { recursive: true });
    const newSalt = randomUUID().replace(/-/g, '').slice(0, 16);
    try {
      // `wx` = exclusive-create. If a concurrent first-caller wins the
      // race, re-read their salt instead of overwriting → memo stays in
      // sync with disk for the whole process.
      fs.writeFileSync(saltPath, newSalt, { mode: 0o600, flag: 'wx' });
      _cacheKeySaltMemo = newSalt;
    } catch (writeErr) {
      const code = (writeErr as { code?: string }).code;
      if (code === 'EEXIST') {
        const content = fs.readFileSync(saltPath, 'utf-8').trim();
        if (SALT_HEX_RE.test(content)) {
          _cacheKeySaltMemo = content;
          return _cacheKeySaltMemo;
        }
      }
      throw writeErr;
    }
    return _cacheKeySaltMemo;
  } catch {
    if (!_cacheSaltWarnedReadonly) {
      // eslint-disable-next-line no-console
      console.warn('[openai-adapter] cache-salt persist failed (read-only FS?); using in-memory salt — cache benefit lost on restart.');
      _cacheSaltWarnedReadonly = true;
    }
    _cacheKeySaltMemo = randomBytes(8).toString('hex');
    return _cacheKeySaltMemo;
  }
}

/** @internal Test-only reset. */
export function _resetCacheKeySaltMemo(): void {
  _cacheKeySaltMemo = undefined;
  _cacheSaltWarnedReadonly = false;
}

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
      // Typed as `unknown` (not `string | null`) on purpose: real OpenAI-
      // compat servers diverge from the spec — Mistral can drop a stray
      // object here during tool-call transitions, and multimodal endpoints
      // use an array of content parts. Narrowing happens at the read site
      // via `extractDeltaText` to keep the leak guard at one boundary.
      content?: unknown;
      tool_calls?: Array<{
        index: number;
        id?: string | undefined;
        type?: string | undefined;
        function?: { name?: string | undefined; arguments?: string | undefined } | undefined;
      }> | undefined;
    };
    finish_reason?: string | null | undefined;
  }>;
  usage?: {
    prompt_tokens?: number | undefined;
    completion_tokens?: number | undefined;
    prompt_tokens_details?: { cached_tokens?: number | undefined } | undefined;
  } | undefined;
}

// ── Request Translation ─────────────────────────────────────────

/**
 * Translate Anthropic-shape `tool_choice` to the OpenAI request body field.
 *
 * Anthropic shapes:
 *   - { type: 'auto' }            → 'auto'         (model decides)
 *   - { type: 'any'  }            → 'required'     (must call one of the tools)
 *   - { type: 'tool', name: 'X' } → { type: 'function', function: { name: 'X' } }
 *
 * Returns `undefined` for malformed/unknown shapes so the caller leaves the
 * default ('auto') in place rather than sending a bogus field. T2-P2 — without
 * this map, every llm-helper / dag-planner / process-capture call that *forces*
 * a specific tool was silently downgraded to "auto", letting the model wander
 * off into freeform text and breaking the structured-extraction contract.
 */
function translateToolChoice(
  choice: unknown,
): string | { type: 'function'; function: { name: string } } | undefined {
  if (!choice || typeof choice !== 'object') return undefined;
  const c = choice as { type?: unknown; name?: unknown };
  if (c.type === 'auto') return 'auto';
  if (c.type === 'any') return 'required';
  if (c.type === 'tool' && typeof c.name === 'string' && c.name.length > 0) {
    return { type: 'function', function: { name: c.name } };
  }
  // 'none' is not in the Anthropic tool_choice union but is a valid OpenAI
  // value; pass it through if a caller ever sends the OpenAI literal directly.
  if (c.type === 'none') return 'none';
  return undefined;
}

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

/**
 * Coerce the OpenAI-compat `delta.content` field to a safe string for the
 * text channel. The OpenAI spec types this as `string | null`, but real
 * servers diverge:
 *
 *  - Mistral occasionally emits a stray object during the tool-call →
 *    tool-result transition (root cause of issue #37 spawn-bracket leak).
 *  - Post-2024 multimodal OpenAI shapes use `Array<{type:'text',text:string}>`.
 *
 * Returns the empty string for anything that isn't safe to forward —
 * callers should treat `''` as "no text in this chunk". Crucially, we
 * NEVER fall through to JS coercion: an object reaching `text += value`
 * downstream becomes the literal "[object Object]" baked into history,
 * which the model then "completes" with hallucinated bracket-tails.
 */
function extractDeltaText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    // Multimodal content parts shape. Only `text` parts contribute to the
    // text channel; image/audio parts are ignored here (the adapter has
    // no image-block emission today). Each part's `text` must itself be
    // a string — never coerce.
    let out = '';
    for (const part of content) {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        out += (part as { text: string }).text;
      }
    }
    return out;
  }
  // Object/number/boolean/etc. — drop silently. The pre-fix behaviour
  // (`String(value)` via `+=` coercion) is what caused the leak.
  return '';
}

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
  let totalCachedTokens = 0;

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
          totalCachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? totalCachedTokens;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        // Text content. The OpenAI spec types `delta.content` as
        // `string | null`, but in practice some servers (notably Mistral
        // during the tool-call → tool-result transition) occasionally emit
        // an object/array shape there. Without a string-guard we forward
        // the non-string straight into `text_delta.text`; downstream
        // `text += textDelta.text` then coerces via Object.prototype
        // .toString → "[object Object]" gets baked into the assistant
        // text block. That corrupted text re-enters history and the model
        // hallucinates runaway bracket tails (`}] }] }] }]`) trying to
        // "close" the malformed prefix it sees in its own prior turn.
        // Regression for issue #37 (Mistral spawn-bracket leak).
        const textPart = extractDeltaText(choice.delta.content);
        if (textPart) {
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
            delta: { type: 'text_delta', text: textPart },
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
              // Reserve this index for THIS tool — subsequent parallel
              // tool_calls in the same turn must claim the next slot, or
              // StreamProcessor.rawInputs (keyed by index) concatenates
              // their JSON deltas onto this block → JSON.parse throws.
              blockIndex++;
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

          // OpenAI/Mistral/Ollama spec uses 'length' for max-tokens-hit; the
          // Anthropic stream-event spec uses 'max_tokens'. Without this map
          // the downstream StreamProcessor treats 'length' as an unknown
          // stop_reason and the calling Agent loop silently drops the
          // truncated turn (no continuation, no user-visible error). T2-P1.
          const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use'
            : choice.finish_reason === 'stop' ? 'end_turn'
            : choice.finish_reason === 'length' ? 'max_tokens'
            : choice.finish_reason;

          yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
              // Anthropic semantics: input_tokens excludes cached.
              // Mistral SSE returns prompt_tokens including cached → subtract.
              input_tokens: Math.max(0, totalInputTokens - totalCachedTokens),
              output_tokens: totalOutputTokens,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: totalCachedTokens || null,
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

/** Static API key or a function that returns a fresh token (e.g. OAuth refresh). */
export type ApiKeyProvider = string | (() => Promise<string>);

export class OpenAIAdapter {
  private baseURL: string;
  private apiKeyProvider: ApiKeyProvider;
  private modelId: string;
  // Precomputed once at construction — Mistral is the only OpenAI-compat
  // endpoint we forward `prompt_cache_key` to. Hostname-gate is case-
  // insensitive (DNS is); exact-match prevents subdomain attacks like
  // `api.mistral.ai.evil.com` which would otherwise pass a `.endsWith` check.
  private readonly _isMistralHost: boolean;

  constructor(opts: { baseURL: string; apiKey: ApiKeyProvider; modelId: string }) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKeyProvider = opts.apiKey;
    this.modelId = opts.modelId;
    let isMistral = false;
    try { isMistral = new URL(this.baseURL).hostname.toLowerCase() === 'api.mistral.ai'; } catch { /* malformed baseURL → gate stays closed */ }
    this._isMistralHost = isMistral;
  }

  private async resolveApiKey(): Promise<string> {
    return typeof this.apiKeyProvider === 'function'
      ? await this.apiKeyProvider()
      : this.apiKeyProvider;
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
      ): AsyncIterable<BetaRawMessageStreamEvent> & { finalMessage: () => Promise<{ content: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>; stop_reason: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null } }> } => {
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
            let cacheReadTokens: number | null = null;

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
                const e = event as { delta: { stop_reason?: string }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null } };
                if (e.delta.stop_reason) stopReason = e.delta.stop_reason;
                if (e.usage?.input_tokens) inputTokens = e.usage.input_tokens;
                if (e.usage?.output_tokens) outputTokens = e.usage.output_tokens;
                if (e.usage?.cache_read_input_tokens !== undefined && e.usage.cache_read_input_tokens !== null) {
                  cacheReadTokens = e.usage.cache_read_input_tokens;
                }
              }
            }

            return { content, stop_reason: stopReason, usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens } };
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

    // Honour caller-provided model id when it's a real downstream id (e.g.
    // 'mistral-large-2512' from the registered tier-map). Reject Anthropic
    // tier aliases that leak through when no tier-map is registered — those
    // get rejected by Mistral/OpenAI endpoints. Empty/undefined → fall back
    // to the adapter's constructor modelId (legacy single-model behaviour).
    const requestedModel = typeof params.model === 'string' ? params.model : '';
    const looksAnthropic = requestedModel.startsWith('claude-');
    const model = requestedModel && !looksAnthropic ? requestedModel : this.modelId;

    const body: Record<string, unknown> = {
      model,
      messages: openaiMessages,
      max_tokens: params.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
    };
    if (openaiTools?.length) {
      body.tools = openaiTools;
      // T2-P2: honour caller-provided tool_choice. Anthropic shapes
      // ({type:'auto'|'any'|'tool'}) → OpenAI shapes ('auto'|'required'|object).
      // Default to 'auto' when unset or malformed.
      const translated = translateToolChoice(params['tool_choice']);
      body.tool_choice = translated ?? 'auto';
    }

    // Mistral-native prompt cache: forward prompt_cache_key when caller sets
    // it AND outgoing endpoint is api.mistral.ai. Hostname-gate keeps the
    // Mistral-shaped key from leaking into other OpenAI-compat endpoints
    // (future PRD-OPENAI-NATIVE native cells, etc.). Salt-prefix ensures
    // cross-tenant safety on shared MISTRAL_MANAGED_API_KEY.
    //
    // Length cap + charset gate: prevent runaway keys (Mistral validator
    // rejects unknown shapes and surfaces them in error logs unredacted)
    // and avoid bytes that could break JSON/url-encoded paths anywhere
    // downstream. ASCII alnum + `_-:` is the conservative intersection of
    // what Mistral docs allow and what's safe across log pipelines.
    if (this._isMistralHost && typeof params['prompt_cache_key'] === 'string') {
      const rawKey = params['prompt_cache_key'];
      if (rawKey.length > 0 && rawKey.length <= 128 && /^[A-Za-z0-9_:-]+$/.test(rawKey)) {
        body['prompt_cache_key'] = `${getCacheKeySalt()}:${rawKey}`;
      }
    }

    const apiKey = await this.resolveApiKey();
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
