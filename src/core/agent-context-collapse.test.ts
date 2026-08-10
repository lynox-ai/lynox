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

/**
 * Put the agent in the state EVERY agent is in from its second API call onward:
 * an exact prompt size reported by the API, plus the message index that figure
 * was measured at.
 *
 * This matters more than it looks. `_estimateOccupancyTokens` prefers
 * `_lastRealInputTokens + delta-since-that-index`, and the delta covers only the
 * newest messages — exactly the ones `COLLAPSE_SKIP_TAIL_MESSAGES` protects. So
 * with the anchor set, freeing 700K chars of older history moves the estimate by
 * ZERO. A fixture that omits this tests only the first call of a fresh agent, a
 * state that never recurs, and would stay green while the feature does nothing
 * in production.
 */
function seedRealUsage(agent: Agent, promptTokens: number): void {
  const internals = agent as unknown as {
    _lastRealInputTokens: number;
    _lastRealAtMsgCount: number;
  };
  internals._lastRealInputTokens = promptTokens;
  // Mirrors `_lastRealAtMsgCount = msgCountBeforeRecovery - 1` at the call site.
  internals._lastRealAtMsgCount = Math.max(0, messagesOf(agent).length - 1);
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
function heavyHistory(pairs: number, chars: number, tool = 'http_request'): BetaMessageParam[] {
  const messages: BetaMessageParam[] = [{ role: 'user', content: 'Triage every contact' }];
  for (let i = 0; i < pairs; i++) {
    messages.push(toolUseMsg(`tu-${i}`, tool));
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
    seedRealUsage(agent, 190_000);
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

describe('collapse and the untrusted-data taint', () => {
  it('keeps the conversation taint armed across a collapse', () => {
    // `_conversationSawUntrusted` is a LATCH. It is re-derived from context only
    // in `loadMessages` (resume / post-compaction) — never mid-run. Wiring a
    // re-derivation into the truncation path would silently disarm the
    // durable-write gate on exactly the long, tool-heavy threads most likely to
    // have ingested external content.
    //
    // The fixture is doing real work here, so it is spelled out: the history
    // must hold NO context-derivable taint signal at all, or the assertion
    // passes for the wrong reason. Two traps, both hit while writing this:
    //   - a marker-carrying payload does not work, because `buildDescriptor`
    //     copies the payload's first 80 chars into the stub, so an outer
    //     <untrusted-data …> tag survives the collapse in the descriptor;
    //   - neither does the default `http_request` tool name, because
    //     `_contextHoldsUntrustedMarker` returns true for any tool_use named in
    //     EXTERNAL_CONTENT_TOOLS, whatever the payload says.
    // `plan_task` is in neither set, so the latch is the ONLY thing keeping the
    // gate armed — which is exactly the property under test.
    const store = new ToolResultBlobStore();
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });
    setMessages(agent, heavyHistory(10, 80_000, 'plan_task'));
    agent.noteUntrustedData();

    truncate(agent);

    expect(agent.getCollapsedToolResultCount()).toBeGreaterThan(0);
    expect(agent.conversationSawUntrusted).toBe(true);
  });

  it('carries a marked payload\'s boundary into the stub that replaces it', async () => {
    // The complement of the test above, and the reason a collapse does not
    // launder external content on RESUME: `loadMessages` re-derives the taint
    // from whatever the context holds, so the stub must still testify that
    // untrusted data passed through here.
    const { wrapUntrustedData, containsUntrustedMarker } = await import('./data-boundary.js');
    const store = new ToolResultBlobStore();
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });

    const history: BetaMessageParam[] = [{ role: 'user', content: 'Triage every contact' }];
    history.push(toolUseMsg('tu-0'));
    history.push(toolResultMsg('tu-0', wrapUntrustedData('x'.repeat(80_000), 'http_request')));
    for (let i = 1; i < 10; i++) {
      history.push(toolUseMsg(`tu-${i}`));
      history.push(toolResultMsg(`tu-${i}`, `${i}:${'y'.repeat(80_000)}`));
    }
    setMessages(agent, history);

    truncate(agent);

    const stub = resultTextOf(messagesOf(agent)[2]!);
    expect(stub).toContain('recall_tool_result');
    expect(containsUntrustedMarker(stub)).toBe(true);
  });

  it('re-wraps a recalled payload as untrusted', async () => {
    // Complements the above: the payload comes BACK through recall_tool_result,
    // which re-wraps it. Collapsing must not become a laundering path that
    // returns external content stripped of its boundary.
    const { recallToolResultTool } = await import('../tools/builtin/recall-tool-result.js');
    const { containsUntrustedMarker } = await import('./data-boundary.js');
    const store = new ToolResultBlobStore();
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });
    setMessages(agent, heavyHistory(10, 80_000));

    truncate(agent);

    const id = store.entries()[0]!.id;
    const recalled = await recallToolResultTool.handler({ id }, agent);
    expect(containsUntrustedMarker(recalled)).toBe(true);
  });
});

describe('collapse — bounds and block kinds (refutation follow-ups)', () => {
  it('prunes the store on the mint path, not only at compaction', async () => {
    // `pruneToCap` used to be called only from `Session.compact`. A spawned
    // agent shares the parent's store (spawn.ts) but has no Session, so it
    // never compacts — an unbounded writer into someone else's store.
    const { vi } = await import('vitest');
    const store = new ToolResultBlobStore();
    const spy = vi.spyOn(store, 'pruneToCap');
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });
    setMessages(agent, heavyHistory(10, 80_000));
    seedRealUsage(agent, 190_000);

    truncate(agent);

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not collapse a tool_result that carries a non-text block', () => {
    // `park` stores `toolResultText`, which keeps text and drops everything
    // else. Collapsing such a block in place would remove the image from the
    // context AND leave it out of the blob — unrecallable, permanently gone.
    const store = new ToolResultBlobStore();
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });
    const history = heavyHistory(10, 80_000);
    history[2] = {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu-0',
        content: [
          { type: 'text', text: 'i'.repeat(50_000) },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      }],
    };
    setMessages(agent, history);
    seedRealUsage(agent, 190_000);

    truncate(agent);

    const content = messagesOf(agent)[2]!.content as Array<{ type: string; content?: unknown }>;
    const block = content[0]!;
    // Untouched: still the original array, image included.
    expect(Array.isArray(block.content)).toBe(true);
    const inner = block.content as Array<{ type: string }>;
    expect(inner.some(b => b.type === 'image')).toBe(true);
  });

  it('keeps the untrusted boundary when engine framing precedes the wrap', async () => {
    // `buildDescriptor` copies the payload's first 80 chars into the stub, so a
    // wrap at offset 0 survives by accident. Real producers put framing first —
    // mail_read emits Date/UID/Folder lines before the wrapped envelope — which
    // pushes the marker out of the excerpt entirely.
    const { wrapUntrustedData, containsUntrustedMarker } = await import('./data-boundary.js');
    const store = new ToolResultBlobStore();
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', toolResultBlobStore: store });

    const framed = `Date: 2026-08-11T09:15:22.000Z\nUID: 184213\nFolder: INBOX\n`
      + `Message-ID: <CAF9x8k2m0@mail.example>\n`
      + wrapUntrustedData('m'.repeat(80_000), 'mail_read');
    const history = heavyHistory(10, 80_000);
    history[2] = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-0', content: framed }],
    };
    setMessages(agent, history);
    seedRealUsage(agent, 190_000);

    truncate(agent);

    const stub = resultTextOf(messagesOf(agent)[2]!);
    expect(stub).toContain('recall_tool_result');
    expect(containsUntrustedMarker(stub)).toBe(true);
  });

  it('trims a tool_result whose own content is an array of text blocks', () => {
    // One layer below the fix above: the block itself holds [text], not a
    // string. Stopping at the string case would leave the same blind spot.
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    const huge = 'v'.repeat(700_000);
    setMessages(agent, [
      toolUseMsg('tu-1'),
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: [{ type: 'text', text: huge }],
        }],
      },
      { role: 'assistant', content: 'ok' },
    ]);

    truncate(agent);

    const content = messagesOf(agent)[1]!.content as Array<{ content?: unknown }>;
    const inner = content[0]!.content as Array<{ type: string; text?: string }>;
    expect(inner[0]!.text!.length).toBeLessThan(huge.length);
  });
});
