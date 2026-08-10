import { describe, it, expect } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { Agent } from './agent.js';
import { ToolResultBlobStore } from './tool-result-blob-store.js';

/**
 * Context pressure on a tool-heavy run.
 *
 * The measured failure this covers: a 17-turn run carried 1.45M chars of tool
 * results in a 200K-token window. `_truncateHistory` front-dropped a flat
 * MESSAGE count each turn, which freed little, discarded the data, and — because
 * the API caches by prefix — invalidated the cached prefix every single time. The
 * prefix was re-written ~8× at 2× input price, and 80% of that run's cost was
 * cache-write.
 *
 * Collapsing parks the payloads instead: one prefix invalidation buys back most
 * of the context AND the data stays recallable.
 */

/** Assistant message with one tool_use block. */
function toolUseMsg(id: string, name = 'http_request'): BetaMessageParam {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] };
}

/** User message with one tool_result block carrying `payload`. */
function toolResultMsg(toolUseId: string, payload: string): BetaMessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: payload }],
  };
}

/** Reach the private truncation entry point — the function under test. */
function truncate(agent: Agent, overheadTokens = 0): void {
  (agent as unknown as { _truncateHistory(o: number): void })._truncateHistory(overheadTokens);
}

function messagesOf(agent: Agent): BetaMessageParam[] {
  return (agent as unknown as { messages: BetaMessageParam[] }).messages;
}

function setMessages(agent: Agent, messages: BetaMessageParam[]): void {
  (agent as unknown as { messages: BetaMessageParam[] }).messages = messages;
}

/** First tool_result payload of a message, '' when there is none. */
function resultTextOf(msg: BetaMessageParam): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  const block = content.find(b => b.type === 'tool_result');
  if (!block || block.type !== 'tool_result') return '';
  return typeof block.content === 'string' ? block.content : '';
}

/** N tool_use/tool_result pairs, each result `chars` long and unique. */
function heavyHistory(pairs: number, chars: number): BetaMessageParam[] {
  const messages: BetaMessageParam[] = [{ role: 'user', content: 'Triage every contact' }];
  for (let i = 0; i < pairs; i++) {
    messages.push(toolUseMsg(`tu-${i}`));
    messages.push(toolResultMsg(`tu-${i}`, `${i}:${'x'.repeat(chars)}`));
  }
  return messages;
}

describe('_truncateHistory — collapse before front-drop', () => {
  it('parks oversized tool results instead of dropping messages', () => {
    const store = new ToolResultBlobStore();
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });
    // 10 × 80K chars ≈ 228K tokens — comfortably past the 85% mark of a 200K window.
    const history = heavyHistory(10, 80_000);
    setMessages(agent, history);
    const before = history.length;

    truncate(agent);

    const after = messagesOf(agent);
    // No message was discarded: the front-drop is what loses data, and the
    // collapse freed enough that it never had to run.
    expect(after).toHaveLength(before);
    expect(agent.getCollapsedToolResultCount()).toBeGreaterThan(0);
    // The oldest result is now a stub pointing at its recall handle...
    expect(resultTextOf(after[2]!)).toContain('recall_tool_result');
    expect(resultTextOf(after[2]!)).not.toContain('x'.repeat(1_000));
    // ...and the payload survived in the store rather than being thrown away.
    expect(store.size).toBeGreaterThan(0);
  });

  it('leaves the newest exchange readable after collapsing', () => {
    const store = new ToolResultBlobStore();
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });
    setMessages(agent, heavyHistory(10, 80_000));

    truncate(agent);

    const after = messagesOf(agent);
    // The model is mid-reasoning on the result it just received; stubbing that
    // one would only make it recall the same bytes on the very next turn.
    expect(resultTextOf(after[after.length - 1]!)).not.toContain('recall_tool_result');
  });

  it('still front-drops when no blob store is wired', () => {
    // Sub-agents and bare Agents run without a Session, so the old path must
    // keep working unchanged — the collapse is an addition, not a replacement.
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    const history = heavyHistory(10, 80_000);
    setMessages(agent, history);

    truncate(agent);

    expect(messagesOf(agent).length).toBeLessThan(history.length);
    expect(agent.getCollapsedToolResultCount()).toBe(0);
  });

  it('does not touch a context that is under the ceiling', () => {
    const store = new ToolResultBlobStore();
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });
    const history = heavyHistory(2, 20_000);
    setMessages(agent, history);

    truncate(agent);

    // Below 85% nothing happens — collapsing a WARM cache mid-run would cost a
    // prefix invalidation for no reason. That is why `Session.compact` evicts
    // only at compaction, and this path respects the same rule.
    expect(agent.getCollapsedToolResultCount()).toBe(0);
    expect(resultTextOf(messagesOf(agent)[2]!)).toContain('x'.repeat(1_000));
  });
});

describe('_truncateHistory — last-resort pass reaches array content', () => {
  it('trims an oversized tool_result that front-drop could not reach', () => {
    // Too few messages for the front-drop (`length > keep + 1` fails at keep=5),
    // so the second pass is the only thing left. It used to test
    // `typeof content !== 'string'` and skip every tool_result, which are ALWAYS
    // array content — so it freed nothing and the request went out oversized.
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    const huge = 'y'.repeat(700_000);
    setMessages(agent, [
      toolUseMsg('tu-1'),
      toolResultMsg('tu-1', huge),
      { role: 'assistant', content: 'thinking about it' },
    ]);

    truncate(agent);

    const text = resultTextOf(messagesOf(agent)[1]!);
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain('content truncated to fit context window');
  });

  it('trims an oversized text block in array content', () => {
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    const huge = 'w'.repeat(700_000);
    setMessages(agent, [
      { role: 'assistant', content: [{ type: 'text', text: huge }] },
      { role: 'user', content: 'and?' },
    ]);

    truncate(agent);

    const content = messagesOf(agent)[0]!.content;
    const block = (content as Array<{ type: string; text?: string }>)[0]!;
    expect(block.text!.length).toBeLessThan(huge.length);
  });

  it('never rewrites a thinking block', () => {
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    const thought = 't'.repeat(700_000);
    setMessages(agent, [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: thought, signature: 'sig-abc' }],
      },
      { role: 'user', content: 'go on' },
    ]);

    truncate(agent);

    const content = messagesOf(agent)[0]!.content;
    const block = (content as Array<{ type: string; thinking?: string; signature?: string }>)[0]!;
    // The API signature-verifies thinking blocks: slicing one makes every
    // subsequent request 400, which bricks the thread rather than shrinking it.
    expect(block.thinking).toBe(thought);
    expect(block.signature).toBe('sig-abc');
  });
});
