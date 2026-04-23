import { describe, it, expect } from 'vitest';
import { sanitizeToolPairs } from './tool-pair-sanitizer.js';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

function asst(content: BetaMessageParam['content']): BetaMessageParam {
  return { role: 'assistant', content };
}

function user(content: BetaMessageParam['content']): BetaMessageParam {
  return { role: 'user', content };
}

describe('sanitizeToolPairs', () => {
  it('leaves a well-formed history untouched', () => {
    const msgs: BetaMessageParam[] = [
      user('hello'),
      asst([
        { type: 'text', text: 'thinking...' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a' } },
      ]),
      user([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }]),
      asst([{ type: 'text', text: 'done' }]),
    ];

    expect(sanitizeToolPairs(msgs)).toEqual(msgs);
  });

  it('drops an orphan tool_result whose id has no matching tool_use', () => {
    const msgs: BetaMessageParam[] = [
      user('hi'),
      asst([{ type: 'text', text: 'no tools used' }]),
      user([
        { type: 'tool_result', tool_use_id: 'toolu_01XaKREYUQqDEUwfHBU4BpoT', content: 'stale' },
      ]),
    ];

    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(user('hi'));
    expect(out[1]).toEqual(asst([{ type: 'text', text: 'no tools used' }]));
  });

  it('drops an orphan tool_use whose id has no matching tool_result', () => {
    const msgs: BetaMessageParam[] = [
      user('hi'),
      asst([
        { type: 'text', text: 'calling a tool' },
        { type: 'tool_use', id: 'tu_orphan', name: 'read_file', input: {} },
      ]),
      user('follow-up without tool_result'),
    ];

    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual(asst([{ type: 'text', text: 'calling a tool' }]));
    expect(out[2]).toEqual(user('follow-up without tool_result'));
  });

  it('removes an entire tool_use/tool_result pair when only one side is orphan', () => {
    const msgs: BetaMessageParam[] = [
      user('hi'),
      asst([
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} },
        { type: 'tool_use', id: 'tu_2', name: 'read_file', input: {} },
      ]),
      user([
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'tu_3_bogus', content: 'orphan' },
      ]),
    ];

    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual(asst([
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} },
    ]));
    expect(out[2]).toEqual(user([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
    ]));
  });

  it('drops the assistant turn entirely when all tool_uses are orphans and the turn has no other content', () => {
    const msgs: BetaMessageParam[] = [
      user('hi'),
      asst([{ type: 'tool_use', id: 'tu_orphan', name: 'read_file', input: {} }]),
      user('follow-up without tool_result'),
    ];

    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(user('hi'));
    expect(out[1]).toEqual(user('follow-up without tool_result'));
  });

  it('drops a user turn entirely when all its blocks are orphan tool_results', () => {
    const msgs: BetaMessageParam[] = [
      user('hi'),
      asst([{ type: 'text', text: 'no tools' }]),
      user([{ type: 'tool_result', tool_use_id: 'tu_orphan', content: 'stale' }]),
      asst([{ type: 'text', text: 'next turn' }]),
    ];

    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual(asst([{ type: 'text', text: 'next turn' }]));
  });

  it('preserves non-tool content in a user tool_result carrier that has partial orphans', () => {
    const msgs: BetaMessageParam[] = [
      user('hi'),
      asst([{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} }]),
      user([
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        { type: 'text', text: 'and also by the way' },
        { type: 'tool_result', tool_use_id: 'tu_orphan', content: 'stale' },
      ]),
    ];

    const out = sanitizeToolPairs(msgs);
    expect(out[2]).toEqual(user([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
      { type: 'text', text: 'and also by the way' },
    ]));
  });

  it('handles an assistant tool_use turn with no following user message (pending state)', () => {
    const msgs: BetaMessageParam[] = [
      user('hi'),
      asst([
        { type: 'text', text: 'about to call' },
        { type: 'tool_use', id: 'tu_pending', name: 'read_file', input: {} },
      ]),
    ];

    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(asst([{ type: 'text', text: 'about to call' }]));
  });

  it('handles back-to-back tool turns with drift in only the first pair', () => {
    const msgs: BetaMessageParam[] = [
      user('hi'),
      asst([{ type: 'tool_use', id: 'tu_1', name: 't', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: 'tu_bogus', content: 'orphan' }]),
      asst([{ type: 'tool_use', id: 'tu_2', name: 't', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: 'tu_2', content: 'ok' }]),
    ];

    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(user('hi'));
    expect(out[1]).toEqual(asst([{ type: 'tool_use', id: 'tu_2', name: 't', input: {} }]));
    expect(out[2]).toEqual(user([{ type: 'tool_result', tool_use_id: 'tu_2', content: 'ok' }]));
  });

  it('leaves string-content messages alone', () => {
    const msgs: BetaMessageParam[] = [user('hi'), asst('plain string reply')];
    expect(sanitizeToolPairs(msgs)).toEqual(msgs);
  });

  it('returns an empty array for an empty history', () => {
    expect(sanitizeToolPairs([])).toEqual([]);
  });
});
