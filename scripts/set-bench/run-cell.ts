/**
 * Set-Bench v4 cell runner — executes one (cell, scenario) pair end-to-end
 * against the configured provider and returns a deterministic CellRun.
 *
 * Loop shape (mirrors core/src/core/agent.ts but trimmed for the bench):
 *   1. Reset mock-tool state. Run scenario.setup() if any (seeds memory).
 *   2. Build system prompt = SYSTEM + optional inlineContext block, with
 *      cache_control=ephemeral on the inline-context block for Anthropic
 *      so the cache-hit fields populate across iterations within a run.
 *   3. Send messages + tools to the model. Anthropic-native uses the SDK
 *      directly; openai-compat uses the in-tree OpenAIAdapter.
 *   4. For each `tool_use` block in the response, dispatch to mock-tools
 *      and append the `tool_result` to the message stream.
 *   5. Loop until the model emits no more tool calls OR maxIterations.
 *   6. Pass the final assistant-text + toolCalls trace through the
 *      scenario's deterministic passCheck.
 *
 * Cost is computed two ways:
 *   - costUsdCold: pricing.inputPerMillion × all input tokens
 *   - costUsdWarm: cache_read_input_tokens billed at cacheReadPerMillion,
 *                  remaining input tokens at inputPerMillion, output as-is
 * Mistral / openai-compat cells without cache fields → warm == cold.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaTool,
  BetaToolUseBlock,
  BetaMessageParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { OpenAIAdapter } from '../../src/core/openai-adapter.js';
import { dispatchMockTool, resetMockState, SET_BENCH_TOOLS } from './mock-tools.js';
import type { CellRun, SetBenchCell, SetBenchScenario, ToolCallTrace } from './types.js';

const SYSTEM_PREAMBLE = [
  'You are a precise agent in a benchmark harness. Follow the user instructions',
  'literally. Call tools exactly as instructed. Reply in the exact format the',
  'instructions specify. Never narrate your reasoning; output only the final',
  'answer in the requested shape.',
].join(' ');

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClientLike {
  beta: {
    messages: {
      stream: (params: {
        model: string;
        max_tokens: number;
        system?: string | readonly BetaTextBlockParam[];
        messages: BetaMessageParam[];
        tools?: BetaTool[];
        [key: string]: unknown;
      }) => AsyncIterable<unknown> & {
        finalMessage: () => Promise<{
          content: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
          stop_reason: string;
          usage: UsageBlock;
        }>;
      };
    };
  };
}

function buildClient(cell: SetBenchCell, apiKey: string): ClientLike {
  if (cell.provider === 'anthropic') {
    return new Anthropic({ apiKey }) as unknown as ClientLike;
  }
  if (cell.provider === 'openai') {
    if (!cell.apiBaseURL) throw new Error(`openai cell ${cell.label} missing apiBaseURL`);
    return new OpenAIAdapter({
      baseURL: cell.apiBaseURL,
      apiKey,
      modelId: cell.modelId,
    }) as unknown as ClientLike;
  }
  throw new Error(`unsupported provider ${cell.provider} on cell ${cell.label}`);
}

/**
 * Classify whether a thrown error message indicates rate-limiting. Matches
 * "HTTP 429", "rate limit", "rate-limit", "rate_limit" — case-insensitive,
 * word-boundary anchored on "429" so a numeric body like "{ count: 4290 }"
 * doesn't trigger.
 */
export function isRateLimitError(msg: string): boolean {
  return /\b429\b|rate.?limit/i.test(msg);
}

interface Costs {
  cold: number;
  warm: number;
}

function computeCosts(
  cell: SetBenchCell,
  tokensIn: number,
  tokensOut: number,
  cacheRead: number,
  cacheCreation: number,
): Costs {
  const { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion } = cell.pricing;
  // tokensIn from Anthropic SDK *excludes* cache_read tokens; we add them
  // back here so cold reflects the all-uncached billing for comparison.
  const totalInputCold = tokensIn + cacheRead + cacheCreation;
  const cold = (totalInputCold / 1_000_000) * inputPerMillion
             + (tokensOut / 1_000_000) * outputPerMillion;

  // Warm: cache_read billed at cacheReadPerMillion if defined; cache_creation
  // billed at cacheWritePerMillion (one-time write cost); remaining input
  // (= tokensIn) at regular rate.
  const readRate = cacheReadPerMillion ?? inputPerMillion;
  const writeRate = cacheWritePerMillion ?? inputPerMillion;
  const warm = (tokensIn / 1_000_000) * inputPerMillion
             + (cacheRead / 1_000_000) * readRate
             + (cacheCreation / 1_000_000) * writeRate
             + (tokensOut / 1_000_000) * outputPerMillion;
  return { cold, warm };
}

/**
 * Build the system block. For Anthropic we send an array with two text
 * blocks: the preamble (uncached, small) and the inlineContext (cached,
 * potentially large). Anthropic's cache_control=ephemeral marker on the
 * 2nd block means the cache_read_input_tokens field populates across
 * iterations within the run.
 *
 * For openai-compat we send a flat string — Mistral has no cache field.
 */
function buildSystem(
  scenario: SetBenchScenario,
  provider: SetBenchCell['provider'],
): string | readonly BetaTextBlockParam[] {
  if (provider !== 'anthropic') {
    // Flat string for openai-compat — Mistral has no native prompt cache.
    if (!scenario.inlineContext) return SYSTEM_PREAMBLE;
    return `${SYSTEM_PREAMBLE}\n\n---\n\n${scenario.inlineContext}`;
  }
  // Anthropic: mark the preamble with cache_control=ephemeral so cache_read
  // populates across n=10 sequential runs of the same scenario AND across
  // multi-turn iterations within a single run. Without this, only the
  // long-context axis (which has an inlineContext block we cache below)
  // would ever exercise cache; all other axes would silently report
  // cache_read=0 and the "cache pays back on multi-turn loops" headline
  // claim wouldn't show in the data.
  if (!scenario.inlineContext) {
    return [{ type: 'text', text: SYSTEM_PREAMBLE, cache_control: { type: 'ephemeral' } }];
  }
  return [
    { type: 'text', text: SYSTEM_PREAMBLE, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: scenario.inlineContext, cache_control: { type: 'ephemeral' } },
  ];
}

export async function runCell(
  cell: SetBenchCell,
  scenario: SetBenchScenario,
  runId: string,
): Promise<CellRun> {
  const start = Date.now();
  const apiKey = process.env[cell.apiKeyEnv];
  const zeroCosts = computeCosts(cell, 0, 0, 0, 0);
  // openai-provider cells targeting api.mistral.ai get an explicit
  // prompt_cache_key. Anthropic-native cells use cache_control markers
  // (already set on the system block above) — no key needed.
  const willRouteCacheKey = cell.provider === 'openai'
    && typeof cell.apiBaseURL === 'string'
    && cell.apiBaseURL.includes('api.mistral.ai');
  if (!apiKey) {
    return {
      cellLabel: cell.label,
      axis: cell.axis,
      scenarioId: scenario.id,
      pass: false,
      reason: `missing env ${cell.apiKeyEnv}`,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsdCold: zeroCosts.cold,
      costUsdWarm: zeroCosts.warm,
      durationMs: 0,
      iterations: 0,
      finalText: '',
      toolCalls: [],
      error: `missing env ${cell.apiKeyEnv}`,
      routedCacheKey: false,
    };
  }

  // Reset mock-tool state for this cell run, then apply per-scenario seed
  // hook (memory pre-population etc.).
  resetMockState();
  scenario.setup?.();

  const client = buildClient(cell, apiKey);
  const messages: BetaMessageParam[] = [{ role: 'user', content: scenario.prompt }];
  const toolCalls: ToolCallTrace[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let iterations = 0;
  let finalText = '';

  const system = buildSystem(scenario, cell.provider);
  const deadline = start + scenario.timeoutMs;

  try {
    while (iterations < scenario.maxIterations) {
      iterations++;
      if (Date.now() > deadline) {
        const c = computeCosts(cell, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens);
        return {
          cellLabel: cell.label, axis: cell.axis, scenarioId: scenario.id,
          pass: false, reason: `timeout after ${iterations - 1} iterations`,
          tokensIn, tokensOut,
          cacheReadTokens, cacheCreationTokens,
          costUsdCold: c.cold, costUsdWarm: c.warm,
          durationMs: Date.now() - start, iterations, finalText, toolCalls,
          routedCacheKey: willRouteCacheKey,
        };
      }

      // 429 retry with exponential backoff.
      const MAX_ATTEMPTS = 4;
      let stream: ReturnType<typeof client.beta.messages.stream> | undefined;
      let msg: Awaited<ReturnType<NonNullable<typeof stream>['finalMessage']>> | undefined;
      let attempt = 0;
      while (attempt < MAX_ATTEMPTS) {
        try {
          stream = client.beta.messages.stream({
            model: cell.modelId,
            max_tokens: 2048,
            system,
            messages,
            tools: SET_BENCH_TOOLS as BetaTool[],
            // Mistral native prompt cache: `${runId}` prefix prevents
            // parallel-dev-run cross-pollution; within a single run, calls
            // 2+ of the same scenario hit the warm cache. Adapter further
            // salts with per-tenant UUID + hostname-gates to api.mistral.ai.
            ...(willRouteCacheKey
              ? { prompt_cache_key: `bench-${runId}-${cell.label}-${scenario.id}` }
              : {}),
            ...(cell.providerExtras ?? {}),
          } as unknown as Parameters<typeof client.beta.messages.stream>[0]);
          msg = await stream.finalMessage();
          break;
        } catch (err) {
          (stream as { controller?: { abort?: () => void } } | undefined)?.controller?.abort?.();
          const m = err instanceof Error ? err.message : String(err);
          if (!isRateLimitError(m) || attempt === MAX_ATTEMPTS - 1) {
            throw err;
          }
          attempt++;
          const delay = [1500, 4000, 10000][attempt - 1] ?? 10000;
          await new Promise((res) => setTimeout(res, delay));
        }
      }
      if (!msg) throw new Error('unreachable: no final message');

      const usage = msg.usage ?? {};
      tokensIn += usage.input_tokens ?? 0;
      tokensOut += usage.output_tokens ?? 0;
      cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;

      const assistantBlocks = msg.content;
      const toolUses = assistantBlocks.filter((b): b is BetaToolUseBlock & { type: 'tool_use' } =>
        b.type === 'tool_use');
      const textBlocks = assistantBlocks
        .filter((b) => b.type === 'text')
        .map((b) => (b.text ?? ''))
        .filter((t) => t.length > 0);
      finalText = textBlocks.join('\n');

      messages.push({
        role: 'assistant',
        content: assistantBlocks.map((b) => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text ?? '' };
          if (b.type === 'tool_use') return {
            type: 'tool_use' as const,
            id: b.id ?? '',
            name: b.name ?? '',
            input: b.input ?? {},
          };
          return { type: 'text' as const, text: '' };
        }).filter((b) => b.type !== 'text' || (b as { text: string }).text.length > 0),
      });

      if (toolUses.length === 0) break;

      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
      for (const t of toolUses) {
        const output = dispatchMockTool(t.name ?? '', t.input) ?? `ERROR: unknown tool ${t.name}`;
        toolCalls.push({ name: t.name ?? '', input: t.input, output });
        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: t.id ?? '',
          content: output,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    const reachedCap = iterations >= scenario.maxIterations;
    const c = computeCosts(cell, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens);
    if (reachedCap && toolCalls.length > 0 && finalText === '') {
      return {
        cellLabel: cell.label, axis: cell.axis, scenarioId: scenario.id,
        pass: false, reason: `hit max ${scenario.maxIterations} iterations without final answer`,
        tokensIn, tokensOut,
        cacheReadTokens, cacheCreationTokens,
        costUsdCold: c.cold, costUsdWarm: c.warm,
        durationMs: Date.now() - start, iterations, finalText, toolCalls,
        routedCacheKey: willRouteCacheKey,
      };
    }

    const result = scenario.passCheck(finalText, toolCalls);
    return {
      cellLabel: cell.label, axis: cell.axis, scenarioId: scenario.id,
      pass: result.pass,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      tokensIn, tokensOut,
      cacheReadTokens, cacheCreationTokens,
      costUsdCold: c.cold, costUsdWarm: c.warm,
      durationMs: Date.now() - start, iterations, finalText, toolCalls,
      routedCacheKey: willRouteCacheKey,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const c = computeCosts(cell, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens);
    return {
      cellLabel: cell.label, axis: cell.axis, scenarioId: scenario.id,
      pass: false, reason: `error: ${msg}`,
      tokensIn, tokensOut,
      cacheReadTokens, cacheCreationTokens,
      costUsdCold: c.cold, costUsdWarm: c.warm,
      durationMs: Date.now() - start, iterations, finalText, toolCalls,
      error: msg,
      routedCacheKey: willRouteCacheKey,
    };
  }
}
