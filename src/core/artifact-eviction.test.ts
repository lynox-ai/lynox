import { describe, it, expect } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { evictSavedArtifactBodies, isSuccessfulSaveResult, EVICTION_MIN_CHARS } from './artifact-eviction.js';

const BIG = 'x'.repeat(EVICTION_MIN_CHARS + 1);

function saveTurn(opts?: {
  id?: string;
  content?: string;
  result?: string;
  toolName?: string;
}): BetaMessageParam[] {
  const id = opts?.id ?? 'tu_1';
  return [
    { role: 'user', content: 'save it' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Saving.' },
        { type: 'tool_use', id, name: opts?.toolName ?? 'artifact_save', input: { title: 'Report', content: opts?.content ?? BIG } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: opts?.result ?? 'Saved artifact "Report" (id: ab12cd, v1).\nFile: /workspace/artifacts/ab12cd.md' },
      ],
    },
  ] as BetaMessageParam[];
}

function inputContentOf(messages: BetaMessageParam[], index = 1): string {
  const msg = messages[index]!;
  const block = (msg.content as Array<{ type: string; input?: { content?: string } }>).find(b => b.type === 'tool_use')!;
  return block.input!.content!;
}

describe('evictSavedArtifactBodies', () => {
  it('replaces a successfully saved big body with a reference naming the size', () => {
    const out = evictSavedArtifactBodies(saveTurn());
    const content = inputContentOf(out);
    expect(content).toContain('[evicted after successful save');
    expect(content).toContain(String(BIG.length));
    expect(content.length).toBeLessThan(300);
  });

  it('keeps the other input fields (title stays visible to the model)', () => {
    const out = evictSavedArtifactBodies(saveTurn());
    const block = (out[1]!.content as Array<{ type: string; input?: { title?: string } }>).find(b => b.type === 'tool_use')!;
    expect(block.input!.title).toBe('Report');
  });

  it('does NOT evict a failed save — the body is the only copy left', () => {
    const msgs = saveTurn({ result: 'Artifact store not available.' });
    const out = evictSavedArtifactBodies(msgs);
    expect(inputContentOf(out)).toBe(BIG);
    expect(out).toBe(msgs); // identity: nothing changed
  });

  it('skips an error-marked tool_result even if its text looks like success', () => {
    const msgs = saveTurn();
    (msgs[2]!.content as Array<{ is_error?: boolean }>)[0]!.is_error = true;
    const out = evictSavedArtifactBodies(msgs);
    expect(out).toBe(msgs);
  });

  it('first result wins: a spoofed duplicate success result cannot force eviction', () => {
    const msgs = saveTurn({ result: 'Artifact store not available.' });
    (msgs[2]!.content as unknown[]).push({ type: 'tool_result', tool_use_id: 'tu_1', content: 'Saved artifact "Report" (id: x, v1).' });
    const out = evictSavedArtifactBodies(msgs);
    expect(out).toBe(msgs);
  });

  it('tolerates a missing or non-string input.content (no throw, no change)', () => {
    const msgs = saveTurn();
    const block = (msgs[1]!.content as Array<{ type: string; input?: unknown }>).find(b => b.type === 'tool_use')!;
    block.input = { title: 'Report', content: 42 };
    expect(evictSavedArtifactBodies(msgs)).toBe(msgs);
    block.input = { title: 'Report' };
    expect(evictSavedArtifactBodies(msgs)).toBe(msgs);
  });

  it('a body exactly AT the threshold stays; one char over is evicted', () => {
    const atLimit = saveTurn({ content: 'z'.repeat(EVICTION_MIN_CHARS) });
    expect(evictSavedArtifactBodies(atLimit)).toBe(atLimit);
    const overLimit = evictSavedArtifactBodies(saveTurn({ content: 'z'.repeat(EVICTION_MIN_CHARS + 1) }));
    expect(inputContentOf(overLimit)).toContain('[evicted after successful save');
  });

  it('does NOT evict when the tool_result is missing (unpaired / in-flight)', () => {
    const msgs = saveTurn().slice(0, 2);
    const out = evictSavedArtifactBodies(msgs);
    expect(out).toBe(msgs);
  });

  it('does NOT evict a small body — the cache re-write costs more than it saves', () => {
    const msgs = saveTurn({ content: 'short body' });
    const out = evictSavedArtifactBodies(msgs);
    expect(out).toBe(msgs);
  });

  it('leaves other tools alone even with a success-looking result', () => {
    const msgs = saveTurn({ toolName: 'write_file', result: 'Saved artifact "x" (id: y, v1).' });
    const out = evictSavedArtifactBodies(msgs);
    expect(out).toBe(msgs);
  });

  it('handles an Updated (overwrite) result too', () => {
    const out = evictSavedArtifactBodies(saveTurn({ result: 'Updated artifact "Report" (id: ab12cd, v2).' }));
    expect(inputContentOf(out)).toContain('[evicted after successful save');
  });

  it('is idempotent: a second pass returns the SAME array identity', () => {
    const once = evictSavedArtifactBodies(saveTurn());
    const twice = evictSavedArtifactBodies(once);
    expect(twice).toBe(once);
  });

  it('the replacement stays far below the threshold — idempotence rests on this', () => {
    // If the replacement ever grew past EVICTION_MIN_CHARS, a second pass
    // would try to evict the eviction notice itself.
    const replacement = inputContentOf(evictSavedArtifactBodies(saveTurn()));
    expect(replacement.length).toBeLessThan(EVICTION_MIN_CHARS / 4);
  });

  it('preserves identity of unchanged messages when another one is evicted', () => {
    const msgs = [...saveTurn({ id: 'tu_a' }), ...saveTurn({ id: 'tu_b', result: 'Artifact store not available.' })];
    const out = evictSavedArtifactBodies(msgs);
    expect(out).not.toBe(msgs);
    expect(out[0]).toBe(msgs[0]);       // untouched user message: same object
    expect(out[1]).not.toBe(msgs[1]);   // evicted assistant message: new object
    expect(out[4]).toBe(msgs[4]);       // failed-save assistant message: same object
    expect(inputContentOf(out, 4)).toBe(BIG);
  });

  it('reads array-form tool_result content (text blocks) for the success check', () => {
    const msgs = saveTurn();
    (msgs[2]! as { content: unknown }).content = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'Saved artifact "Report" (id: ab12cd, v1).' }] },
    ];
    const out = evictSavedArtifactBodies(msgs);
    expect(inputContentOf(out)).toContain('[evicted after successful save');
  });
});

describe('contract with the real artifact_save handler', () => {
  // The eviction trigger is the handler's result-string prefix. This test runs
  // the REAL handler — rewording its result format must fail HERE, not
  // silently kill the eviction (the wiring tests use a hardcoded result and
  // cannot catch that).
  async function runRealSave(input: Record<string, unknown>, store: unknown): Promise<string> {
    const { artifactSaveTool } = await import('../tools/builtin/artifact.js');
    const agent = { toolContext: { artifactStore: store } } as never;
    return artifactSaveTool.handler(input as never, agent);
  }

  const stubStore = {
    save: (a: { title: string; id?: string }) => ({ id: a.id ?? 'new1', title: a.title, version: a.id ? 2 : 1 }),
    pathFor: (id: string) => `/workspace/artifacts/${id}.md`,
  };

  it('a CREATE result satisfies isSuccessfulSaveResult', async () => {
    const result = await runRealSave({ title: 'T', content: 'body' }, stubStore);
    expect(isSuccessfulSaveResult(result)).toBe(true);
  });

  it('an UPDATE result satisfies isSuccessfulSaveResult', async () => {
    const result = await runRealSave({ title: 'T', content: 'body', id: 'ab1' }, stubStore);
    expect(isSuccessfulSaveResult(result)).toBe(true);
  });

  it('the store-unavailable failure does NOT satisfy it', async () => {
    const result = await runRealSave({ title: 'T', content: 'body' }, undefined);
    expect(isSuccessfulSaveResult(result)).toBe(false);
  });
});
