/**
 * Benchmark: Agent history truncation
 *
 * Measures the cost of message history truncation at various sizes.
 * Uses a minimal Agent setup with mocked SDK to isolate the truncation logic.
 */
import { bench, describe } from 'vitest';
import { vi } from 'vitest';
import { generateText } from './setup.js';

// We benchmark the core truncation algorithm directly by simulating
// the same logic without needing a full Agent instance.

/** Estimate message length (same as Agent._estimateMsgLen). */
function estimateMsgLen(messages: Array<{ role: string; content: string }>): number {
  let len = 0;
  for (const msg of messages) {
    len += msg.content.length;
  }
  return len;
}

const CHARS_PER_TOKEN = 3.5;
const MAX_MESSAGE_COUNT = 500;

/**
 * Standalone truncation matching Agent._truncateHistory logic.
 * Returns the truncated messages array.
 */
function truncateHistory(
  messages: Array<{ role: string; content: string }>,
  overheadTokens: number,
  maxCtx: number,
): Array<{ role: string; content: string }> {
  let result = [...messages];

  // Phase 1: Hard message count limit
  if (result.length > MAX_MESSAGE_COUNT) {
    const keepCount = Math.floor(MAX_MESSAGE_COUNT * 0.6);
    const tailSize = keepCount - 1;
    const head = result.slice(0, 1);
    const tail = result.slice(-tailSize);
    const dropped = result.length - 1 - tailSize;
    result = [
      ...head,
      { role: 'user', content: `[${dropped} earlier message(s) were removed]` },
      ...tail,
    ];
  }

  // Phase 2: Token budget truncation
  const msgTokens = estimateMsgLen(result) / CHARS_PER_TOKEN;
  const totalTokens = msgTokens + overheadTokens;
  if (totalTokens < maxCtx * 0.85) return result;

  const ctxScale = maxCtx >= 1_000_000 ? 5 : maxCtx >= 500_000 ? 3 : 1;
  const overshoot = totalTokens / maxCtx;
  const keep = overshoot > 1.0 ? 5 * ctxScale : overshoot > 0.9 ? 10 * ctxScale : 20 * ctxScale;

  if (result.length > keep + 1) {
    const head = result.slice(0, 1);
    const tail = result.slice(-keep);
    result = [
      ...head,
      { role: 'user', content: `[messages removed to fit context window]` },
      ...tail,
    ];
  }

  // Phase 3: Content block truncation
  const afterDrop = estimateMsgLen(result) / CHARS_PER_TOKEN + overheadTokens;
  if (afterDrop >= maxCtx * 0.85) {
    const TARGET_CHARS = 8000 * ctxScale;
    for (let i = 0; i < result.length - 1; i++) {
      if (result[i]!.content.length > TARGET_CHARS) {
        result[i] = {
          ...result[i]!,
          content: result[i]!.content.slice(0, TARGET_CHARS) + '\n[…truncated]',
        };
      }
    }
  }

  return result;
}

function makeMessages(count: number, avgChars = 1000): Array<{ role: string; content: string }> {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: generateText(avgChars),
  }));
}

describe('History Truncation — message count gate', () => {
  bench('100 messages (under limit)', () => {
    truncateHistory(makeMessages(100), 5000, 200_000);
  });

  bench('500 messages (at limit)', () => {
    truncateHistory(makeMessages(500), 5000, 200_000);
  });

  bench('1000 messages (over limit)', () => {
    truncateHistory(makeMessages(1000), 5000, 200_000);
  });
});

describe('History Truncation — token budget', () => {
  bench('200K context, high pressure', () => {
    truncateHistory(makeMessages(200, 3000), 10000, 200_000);
  });

  bench('1M context, moderate pressure', () => {
    truncateHistory(makeMessages(300, 2000), 10000, 1_000_000);
  });

  bench('1M context, high pressure', () => {
    truncateHistory(makeMessages(500, 5000), 10000, 1_000_000);
  });
});

describe('History Truncation — content block truncation', () => {
  bench('oversized messages (10KB each, 200K ctx)', () => {
    truncateHistory(makeMessages(50, 10_000), 5000, 200_000);
  });

  bench('very large messages (50KB each, 200K ctx)', () => {
    truncateHistory(makeMessages(20, 50_000), 5000, 200_000);
  });
});
