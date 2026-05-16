/**
 * Set-Bench cell runner — executes one (cell, scenario) pair end-to-end
 * against the configured provider and returns a deterministic CellRun.
 *
 * Loop shape (mirrors core/src/core/agent.ts but trimmed for the bench):
 *   1. Send messages + tools to the model. Anthropic-native uses the
 *      SDK directly; openai-compat uses the in-tree OpenAIAdapter.
 *   2. For each `tool_use` block in the response, dispatch to mock-tools
 *      and append the `tool_result` to the message stream.
 *   3. Loop until the model emits no more tool calls OR maxIterations.
 *   4. Pass the final assistant-text + toolCalls trace through the
 *      scenario's deterministic passCheck.
 *
 * Cost is computed from cell pricing + accumulated usage — we do not
 * trust the engine's pricing.ts table here, because the bench has to
 * report the GROUND-TRUTH cost for the published rate.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { BetaTool, BetaToolUseBlock, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { OpenAIAdapter } from '../../src/core/openai-adapter.js';
import { dispatchMockTool, SET_BENCH_TOOLS } from './mock-tools.js';
import type { CellRun, SetBenchCell, SetBenchScenario, ToolCallTrace } from './types.js';

const SYSTEM = [
  'You are a precise agent in a benchmark harness. Follow the user instructions',
  'literally. Call tools exactly as instructed. Reply in the exact format the',
  'instructions specify. Never narrate your reasoning; output only the final',
  'answer in the requested shape.',
].join(' ');

interface ClientLike {
  beta: {
    messages: {
      stream: (params: {
        model: string;
        max_tokens: number;
        system?: string;
        messages: BetaMessageParam[];
        tools?: BetaTool[];
        [key: string]: unknown;
      }) => AsyncIterable<unknown> & {
        finalMessage: () => Promise<{
          content: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
          stop_reason: string;
          usage: { input_tokens: number; output_tokens: number };
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
 *
 * Exported so test coverage can pin the match-set without spinning up a
 * full bench client.
 */
export function isRateLimitError(msg: string): boolean {
  return /\b429\b|rate.?limit/i.test(msg);
}

function costFromUsage(cell: SetBenchCell, tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * cell.pricing.inputPerMillion
       + (tokensOut / 1_000_000) * cell.pricing.outputPerMillion;
}

export async function runCell(
  cell: SetBenchCell,
  scenario: SetBenchScenario,
): Promise<CellRun> {
  const start = Date.now();
  const apiKey = process.env[cell.apiKeyEnv];
  if (!apiKey) {
    return {
      cellLabel: cell.label,
      scenarioId: scenario.id,
      pass: false,
      reason: `missing env ${cell.apiKeyEnv}`,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 0,
      iterations: 0,
      finalText: '',
      toolCalls: [],
      error: `missing env ${cell.apiKeyEnv}`,
    };
  }

  const client = buildClient(cell, apiKey);
  const messages: BetaMessageParam[] = [{ role: 'user', content: scenario.prompt }];
  const toolCalls: ToolCallTrace[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let iterations = 0;
  let finalText = '';

  const deadline = start + scenario.timeoutMs;

  try {
    while (iterations < scenario.maxIterations) {
      iterations++;
      if (Date.now() > deadline) {
        return {
          cellLabel: cell.label, scenarioId: scenario.id,
          pass: false, reason: `timeout after ${iterations - 1} iterations`,
          tokensIn, tokensOut, costUsd: costFromUsage(cell, tokensIn, tokensOut),
          durationMs: Date.now() - start, iterations, finalText, toolCalls,
        };
      }

      // Mistral free + Tier-1 paid tiers cap RPM aggressively. The bench
      // would otherwise emit a noisy 0% for cells that work fine when given
      // more breathing room. Retry with exponential backoff on 429 only —
      // any other error still surfaces (kept inside the catch below so the
      // run's failure reason stays informative).
      const MAX_ATTEMPTS = 4;
      let stream: ReturnType<typeof client.beta.messages.stream> | undefined;
      let msg: Awaited<ReturnType<NonNullable<typeof stream>['finalMessage']>> | undefined;
      let attempt = 0;
      while (attempt < MAX_ATTEMPTS) {
        try {
          stream = client.beta.messages.stream({
            model: cell.modelId,
            max_tokens: 2048,
            system: SYSTEM,
            messages,
            tools: SET_BENCH_TOOLS as BetaTool[],
            ...(cell.providerExtras ?? {}),
          });
          msg = await stream.finalMessage();
          break;
        } catch (err) {
          // Discard the failed stream's connection BEFORE backoff so the
          // SDK's underlying SSE/fetch reader is freed promptly rather
          // than relying on GC. SDK exposes `controller.abort()` on the
          // returned stream — best-effort, optional-chained because the
          // shape differs between Anthropic SDK and the in-tree OpenAI
          // adapter.
          (stream as { controller?: { abort?: () => void } } | undefined)?.controller?.abort?.();
          const m = err instanceof Error ? err.message : String(err);
          if (!isRateLimitError(m) || attempt === MAX_ATTEMPTS - 1) {
            throw err;
          }
          attempt++;
          // 1.5s → 4s → 10s — keeps the bench tractable while letting the
          // 1m RPM window roll over.
          const delay = [1500, 4000, 10000][attempt - 1] ?? 10000;
          await new Promise((res) => setTimeout(res, delay));
        }
      }
      if (!msg) throw new Error('unreachable: no final message');
      // Some openai-compat adapters elide `usage` on streamed responses.
      // Default to 0 so a missing usage doesn't crash the run and mask
      // a successful tool-chain as `error: …`.
      tokensIn += msg.usage?.input_tokens ?? 0;
      tokensOut += msg.usage?.output_tokens ?? 0;

      // Extract assistant text + tool_use blocks from the content array.
      const assistantBlocks = msg.content;
      const toolUses = assistantBlocks.filter((b): b is BetaToolUseBlock & { type: 'tool_use' } =>
        b.type === 'tool_use');
      const textBlocks = assistantBlocks
        .filter((b) => b.type === 'text')
        .map((b) => (b.text ?? ''))
        .filter((t) => t.length > 0);
      finalText = textBlocks.join('\n');

      // Append the assistant message verbatim so the next turn sees the
      // tool_use blocks AND any reasoning text the model emitted.
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

      if (toolUses.length === 0) break; // model produced no more tool calls

      // Dispatch each tool_use through mock-tools.
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

    // Loop exited normally — final assistant turn was text-only OR we hit
    // maxIterations.
    const reachedCap = iterations >= scenario.maxIterations;
    if (reachedCap && toolCalls.length > 0 && finalText === '') {
      return {
        cellLabel: cell.label, scenarioId: scenario.id,
        pass: false, reason: `hit max ${scenario.maxIterations} iterations without final answer`,
        tokensIn, tokensOut, costUsd: costFromUsage(cell, tokensIn, tokensOut),
        durationMs: Date.now() - start, iterations, finalText, toolCalls,
      };
    }

    const result = scenario.passCheck(finalText, toolCalls);
    return {
      cellLabel: cell.label, scenarioId: scenario.id,
      pass: result.pass, reason: result.reason,
      tokensIn, tokensOut, costUsd: costFromUsage(cell, tokensIn, tokensOut),
      durationMs: Date.now() - start, iterations, finalText, toolCalls,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      cellLabel: cell.label, scenarioId: scenario.id,
      pass: false, reason: `error: ${msg}`,
      tokensIn, tokensOut, costUsd: costFromUsage(cell, tokensIn, tokensOut),
      durationMs: Date.now() - start, iterations, finalText, toolCalls,
      error: msg,
    };
  }
}
