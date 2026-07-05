// #4 big-image context: the occupancy estimator must count an inline base64
// image by its pixel token-equivalent (~IMAGE_TOKEN_ESTIMATE), NOT its ~5 MB
// base64 char length (which char-counts to ~1.4M "tokens" and trips a premature
// truncate/compaction the instant the image lands). And a recent user image must
// survive a compaction — re-attached INLINE in the post-compaction seed so the
// agent can still see it, valid outbound array, and it persists across a reload.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  BetaMessageParam,
  BetaImageBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

// === Mocks (mirror agent.test.ts so a REAL Agent can be driven) ===

const { mockStream, mockProcess } = vi.hoisted(() => ({
  mockStream: vi.fn(),
  mockProcess: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: mockStream } };
  }
  class APIError extends Error {
    status: number;
    constructor(status: number, _error: unknown, message: string | undefined) {
      super(message ?? 'api error');
      this.status = status;
      this.name = 'APIError';
    }
  }
  return { default: MockAnthropic, APIError };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

vi.mock('../tools/permission-guard.js', () => ({
  isDangerous: vi.fn().mockReturnValue(null),
}));

vi.mock('./observability.js', () => ({
  channels: {
    toolStart: { publish: vi.fn() },
    toolEnd: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: false, publish: vi.fn() },
    cacheHealth: { publish: vi.fn() },
    securityFlagged: { hasSubscribers: false, publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent, imageAwareSerializedLen, IMAGE_TOKEN_ESTIMATE } from './agent.js';
import { CHARS_PER_TOKEN } from '../types/index.js';
import { evictImagesFrom } from './tool-result-blob-store.js';
import { buildPostCompactionMessages } from './compaction-messages.js';

function endTurnResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function imageMsg(data: string, text = 'here is a screenshot'): BetaMessageParam {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ],
  };
}

function hasInlineImage(msg: BetaMessageParam): boolean {
  return Array.isArray(msg.content) && msg.content.some(b => b.type === 'image');
}

/** Assert a message array strictly alternates user/assistant starting with user
 *  — the shape Anthropic accepts (a break here is the ENGINE-10 400 class). */
function assertAlternating(msgs: BetaMessageParam[]): void {
  msgs.forEach((m, i) => expect(m.role).toBe(i % 2 === 0 ? 'user' : 'assistant'));
}

describe('image-aware occupancy estimator (#4 part a)', () => {
  it('imageAwareSerializedLen swaps a base64 payload for its pixel token-equivalent', () => {
    const bigData = 'A'.repeat(5_000_000); // ~5 MB base64 blob
    const msg = imageMsg(bigData);
    const naive = JSON.stringify(msg).length;
    const aware = imageAwareSerializedLen(msg);

    // The naive serialization is dominated by the 5 MB base64 payload…
    expect(naive).toBeGreaterThan(5_000_000);
    // …but the image-aware length drops the payload and adds the pixel estimate.
    expect(aware).toBe(naive - bigData.length + IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN);
    // As tokens: a few thousand, NOT ~1.4M.
    expect(aware / CHARS_PER_TOKEN).toBeLessThan(5_000);
  });

  it('leaves an image-free message unchanged', () => {
    const msg: BetaMessageParam = { role: 'user', content: 'just plain text, no image' };
    expect(imageAwareSerializedLen(msg)).toBe(JSON.stringify(msg).length);
  });

  it('the Agent estimate for a 5 MB image is low (proves the helper is WIRED into _estimateOccupancyTokens)', () => {
    const bigData = 'A'.repeat(5_000_000);
    const msg = imageMsg(bigData);

    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    agent.loadMessages([msg]);
    const estimate = agent.getEstimatedOccupancyTokens();

    // What the OLD char-count estimator would have reported: ~1.4M "tokens".
    const naiveTokens = JSON.stringify(msg).length / CHARS_PER_TOKEN;
    expect(naiveTokens).toBeGreaterThan(1_000_000);

    // The wired estimate is dominated by IMAGE_TOKEN_ESTIMATE, not the base64 blob:
    // ≲ low-thousands, so the pre-call _truncateHistory (85% of a huge maxCtx)
    // cannot fire on this message alone.
    expect(estimate).toBeLessThan(5_000);
    expect(estimate).toBeLessThan(naiveTokens / 100);
  });
});

describe('preserve recent user image across compaction (#4 part b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries the most-recent user image across a compaction, re-sends it in a valid outbound array, and survives reload', async () => {
    const bigData = 'B'.repeat(400_000);
    const preCompaction: BetaMessageParam[] = [
      imageMsg(bigData),
      { role: 'assistant', content: 'I can see the screenshot — it shows a sales dashboard.' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'You are welcome.' },
    ];

    // Reproduce Session.compact()'s preserve flow with the SAME helpers it calls.
    const carried = evictImagesFrom(preCompaction);
    expect(carried).toHaveLength(1);
    const seed = buildPostCompactionMessages(
      'Summary: the user shared a sales-dashboard screenshot and we discussed it.',
      [],
      { carriedImages: carried },
    );

    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    agent.reset();
    agent.loadMessages(seed);

    // Post-compaction buffer still holds BOTH the summary and the inline image.
    const buf = agent.getMessages();
    expect(buf.some(m => typeof m.content === 'string' && m.content.includes('Summary: the user shared a sales-dashboard'))).toBe(true);
    expect(buf.some(hasInlineImage)).toBe(true);
    assertAlternating(buf);

    // A subsequent send produces a valid outbound array that STILL carries the image.
    mockProcess.mockResolvedValueOnce(endTurnResponse('It is a sales dashboard with revenue up.'));
    const reply = await agent.send('what does the image show?');
    expect(typeof reply).toBe('string');

    const outboundArgs = mockStream.mock.calls.at(-1)![0] as { messages: BetaMessageParam[] };
    const outbound = outboundArgs.messages;
    expect(outbound.some(hasInlineImage)).toBe(true); // image not nuked by the estimator/truncate
    assertAlternating(outbound);                       // no 400 / role error shape

    // Reload: round-trip each message's content through JSON (the thread_store
    // content_json shape) into a fresh agent — the carried image is still there.
    const reloaded: BetaMessageParam[] = buf.map(m => ({
      role: m.role,
      content: JSON.parse(JSON.stringify(m.content)) as BetaMessageParam['content'],
    }));
    const agent2 = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    agent2.loadMessages(reloaded);
    const afterReload = agent2.getMessages().find(m =>
      Array.isArray(m.content) &&
      m.content.some(b => b.type === 'image' && b.source.type === 'base64' && b.source.data === bigData),
    );
    expect(afterReload).toBeDefined();
  });
});
