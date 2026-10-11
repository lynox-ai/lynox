/**
 * What a helper call cost when it was aborted before its reply arrived.
 *
 * A timeout or a user stop ends a helper stream early, and `finalMessage()` rejects. Every
 * helper books its spend from the reply, so an aborted call booked nothing — while the
 * provider still bills the prompt and whatever it generated before the abort.
 *
 * The exact amount cannot be known here: the output count arrives only with the stream's
 * last event. So this module produces two numbers, for two different readers:
 *
 * - `upperBoundUsd` is for the BUDGET CAPS (the run ceiling and the session cap). For a
 *   cap, overstating is safe and understating lets money through, so it is a bound that
 *   cannot be below the real cost: the prompt priced at the higher of the input and the
 *   cache-write rate, and the whole `max_tokens` as output.
 * - `estimateUsd` is for DISPLAY: the run's own cost line. It is a best guess, not a bound.
 *
 * Neither number goes to the tenant debit. The customer has never paid for an aborted
 * helper call, and still does not; the provider bills us for it. {@link reportAbortedCall}
 * counts every such call per site, so the unbilled amount stays measurable.
 */
import { calculateCost } from './pricing.js';

/**
 * Tokens the provider adds to a tool-use request beyond what the request body carries (its
 * tool-use system prompt). Generous on purpose: it only feeds the upper bound.
 */
export const TOOL_USE_OVERHEAD_TOKENS = 1024;

/** Bytes per token for the display estimate of a prompt or a partial reply. */
const ESTIMATE_BYTES_PER_TOKEN = 4;

export interface AbortedCallCost {
  /** A cost the call cannot have exceeded. For the budget caps. */
  upperBoundUsd: number;
  /** A best guess. For display only. */
  estimateUsd: number;
  /** Whether the prompt size came from the provider's own count rather than from the request. */
  fromSnapshot: boolean;
}

/** The parts of a stream's partial message this module reads. */
export interface PartialMessage {
  usage?: {
    input_tokens?: number | null | undefined;
    cache_creation_input_tokens?: number | null | undefined;
    cache_read_input_tokens?: number | null | undefined;
  } | null | undefined;
  content?: unknown;
}

/**
 * The partial message a stream holds when it is aborted, if it exposes one. The Anthropic
 * SDK's stream does (`currentMessage`, set by the first event); the OpenAI-compatible
 * adapter's does not.
 */
export function partialMessageOf(stream: unknown): PartialMessage | undefined {
  if (typeof stream !== 'object' || stream === null) return undefined;
  try {
    const m = (stream as { currentMessage?: unknown }).currentMessage;
    return typeof m === 'object' && m !== null ? m as PartialMessage : undefined;
  } catch {
    return undefined;
  }
}

function utf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Cost bounds for an aborted call to `model` that asked for `maxTokens` and sent `request`
 * (the system prompt, messages and tools — whatever the request body carried).
 *
 * The prompt: the provider's own count when the stream got as far as its first event;
 * otherwise the request's UTF-8 size plus {@link TOOL_USE_OVERHEAD_TOKENS} — a token is at
 * least one byte, so that cannot be below the real count.
 */
export function abortedCallCost(input: {
  model: string;
  maxTokens: number;
  request: unknown;
  partial?: PartialMessage | undefined;
}): AbortedCallCost {
  const { model, maxTokens, request, partial } = input;
  const usage = partial?.usage ?? undefined;
  const counted = typeof usage?.input_tokens === 'number' && usage.input_tokens > 0;
  const requestBytes = utf8Bytes(request);

  const outputSoFar = Math.min(maxTokens, Math.ceil(utf8Bytes(partial?.content ?? []) / ESTIMATE_BYTES_PER_TOKEN));

  if (counted) {
    const measured = {
      input_tokens: usage.input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? undefined,
    };
    return {
      upperBoundUsd: calculateCost(model, { ...measured, output_tokens: maxTokens }),
      estimateUsd: calculateCost(model, { ...measured, output_tokens: outputSoFar }),
      fromSnapshot: true,
    };
  }

  // No count from the provider. Price the prompt bound at the cache-write rate as well as the
  // input rate and take the higher: a cached prompt is billed above the plain input rate.
  const promptBound = requestBytes + TOOL_USE_OVERHEAD_TOKENS;
  const atInput = calculateCost(model, { input_tokens: promptBound, output_tokens: maxTokens });
  const atCacheWrite = calculateCost(model, { input_tokens: 0, cache_creation_input_tokens: promptBound, output_tokens: maxTokens });
  return {
    upperBoundUsd: Math.max(atInput, atCacheWrite),
    estimateUsd: calculateCost(model, {
      input_tokens: Math.ceil(requestBytes / ESTIMATE_BYTES_PER_TOKEN),
      output_tokens: outputSoFar,
    }),
    fromSnapshot: false,
  };
}

/** Aborted helper calls per site since process start: none of them reached the tenant debit. */
const notBilled = new Map<string, number>();
/** The subset whose prompt size was not counted by the provider, so the bound is from the request. */
const uncounted = new Map<string, number>();

/** Copies of the per-site counts. */
export function abortedCallCounts(): { notBilled: Record<string, number>; uncounted: Record<string, number> } {
  return { notBilled: Object.fromEntries(notBilled), uncounted: Object.fromEntries(uncounted) };
}

/**
 * Say, by name, that a helper call was aborted and is not billed to the tenant. One stderr
 * line with site, model and the two amounts — never request or reply text. Never throws.
 */
export function reportAbortedCall(site: string, model: string, cost: AbortedCallCost): void {
  try {
    notBilled.set(site, (notBilled.get(site) ?? 0) + 1);
    if (!cost.fromSnapshot) uncounted.set(site, (uncounted.get(site) ?? 0) + 1);
    process.stderr.write(
      `[wire] ${site}: ${model} call aborted; not billed to the tenant, capped at $${cost.upperBoundUsd.toFixed(6)}`
      + ` (estimate $${cost.estimateUsd.toFixed(6)}${cost.fromSnapshot ? '' : ', prompt uncounted'})\n`,
    );
  } catch {
    // Reporting must not take a caller down.
  }
}
