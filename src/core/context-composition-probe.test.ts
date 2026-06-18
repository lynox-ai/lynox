import { describe, it, expect } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { computeComposition } from './context-composition-probe.js';

/** Build a tool_use + tool_result pair across an assistant + user message. */
function toolRoundtrip(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  resultText: string,
): [BetaMessageParam, BetaMessageParam] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: resultText }] },
  ];
}

describe('computeComposition', () => {
  it('returns an empty snapshot for no messages', () => {
    const snap = computeComposition([]);
    expect(snap.messageCount).toBe(0);
    expect(snap.totalBytes).toBe(0);
    expect(snap.duplicateResidentBytes).toBe(0);
    expect(snap.occupancyTokens).toBeUndefined();
    expect(snap.overheadTokens).toBeUndefined();
  });

  it('attributes plain-string content to user/assistant text by role', () => {
    const msgs: BetaMessageParam[] = [
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'general kenobi' },
    ];
    const snap = computeComposition(msgs);
    expect(snap.messageCount).toBe(2);
    expect(snap.categories.userText).toBeGreaterThan(0);
    expect(snap.categories.assistantText).toBeGreaterThan(0);
    expect(snap.categories.toolResult).toBe(0);
  });

  it('groups tool_result bytes by the originating tool name', () => {
    const [a1, u1] = toolRoundtrip('t1', 'web_fetch', { url: 'x' }, 'A'.repeat(500));
    const [a2, u2] = toolRoundtrip('t2', 'http_request', { url: 'y' }, 'B'.repeat(300));
    const snap = computeComposition([a1, u1, a2, u2]);
    expect(snap.toolResultByTool['web_fetch']?.count).toBe(1);
    expect(snap.toolResultByTool['http_request']?.count).toBe(1);
    expect(snap.toolResultByTool['web_fetch']!.bytes).toBeGreaterThan(
      snap.toolResultByTool['http_request']!.bytes,
    );
    expect(snap.categories.toolUse).toBeGreaterThan(0);
    expect(snap.categories.toolResult).toBeGreaterThan(0);
  });

  it('counts an exact-repeat tool_result as a resident duplicate (L3 ceiling)', () => {
    const big = 'X'.repeat(4000); // same doc fetched twice
    const [a1, u1] = toolRoundtrip('t1', 'web_fetch', { url: 'doc' }, big);
    const [a2, u2] = toolRoundtrip('t2', 'web_fetch', { url: 'doc' }, big);
    const [a3, u3] = toolRoundtrip('t3', 'web_fetch', { url: 'other' }, 'Y'.repeat(4000));
    const snap = computeComposition([a1, u1, a2, u2, a3, u3]);
    // The second occurrence of `big` is the duplicate; the unique `other` is not.
    expect(snap.duplicateResidentCount).toBe(1);
    expect(snap.duplicateResidentBytes).toBeGreaterThan(4000);
  });

  it('counts every repeat after the first (same doc 3×)', () => {
    const big = 'Z'.repeat(2000);
    const pairs = ['t1', 't2', 't3'].flatMap((id) => toolRoundtrip(id, 'web_fetch', { url: 'd' }, big));
    const snap = computeComposition(pairs);
    expect(snap.duplicateResidentCount).toBe(2); // 2nd and 3rd are duplicates
  });

  it('derives real occupancy + overhead from lastRealInputTokens', () => {
    const msgs: BetaMessageParam[] = [{ role: 'user', content: 'a'.repeat(350) }];
    const snap = computeComposition(msgs, { lastRealInputTokens: 5000 });
    expect(snap.occupancyTokens).toBe(5000);
    // overhead = occupancy − message tokens, clamped >= 0, and clearly positive
    // here because 350 chars ≈ 100 message tokens « 5000 occupancy.
    expect(snap.overheadTokens).toBeGreaterThan(4000);
  });

  it('clamps overhead to 0 when the message estimate exceeds reported occupancy', () => {
    const msgs: BetaMessageParam[] = [{ role: 'user', content: 'a'.repeat(100_000) }];
    const snap = computeComposition(msgs, { lastRealInputTokens: 10 });
    expect(snap.overheadTokens).toBe(0);
  });

  it('handles a tool_result with array content (text blocks)', () => {
    const msgs: BetaMessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'R'.repeat(1000) }],
          },
        ],
      },
    ];
    const snap = computeComposition(msgs);
    expect(snap.toolResultByTool['search']?.count).toBe(1);
    expect(snap.duplicateResidentCount).toBe(0);
  });

  it('detects a verbatim duplicate of array-content (text+image) tool_results', () => {
    const content = [
      { type: 'text' as const, text: 'D'.repeat(2000) },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } },
    ];
    const msgs: BetaMessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'web_fetch', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'web_fetch', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content }] },
    ];
    const snap = computeComposition(msgs);
    // Serialized-content keying catches the repeat even though it carries an image
    // block — text-only keying would have under-counted here.
    expect(snap.duplicateResidentCount).toBe(1);
    expect(snap.duplicateResidentBytes).toBeGreaterThan(2000);
  });

  it('does not treat empty/absent tool_result content as mutual duplicates', () => {
    const msgs: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [] }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: '' }] },
    ];
    const snap = computeComposition(msgs);
    expect(snap.duplicateResidentCount).toBe(0);
  });

  it('falls back to "unknown" tool when no matching tool_use exists', () => {
    const msgs: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'data' }] },
    ];
    const snap = computeComposition(msgs);
    expect(snap.toolResultByTool['unknown']?.count).toBe(1);
  });

  it('totalBytes equals the sum of per-message JSON lengths', () => {
    const msgs: BetaMessageParam[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
    ];
    const snap = computeComposition(msgs);
    const expected = msgs.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    expect(snap.totalBytes).toBe(expected);
  });
});
