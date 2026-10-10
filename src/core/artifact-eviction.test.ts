import { describe, it, expect } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { evictSavedArtifactBodies, restoreEvictedBodies, containsEvictionMarker, isSuccessfulSaveResult, EVICTION_MIN_CHARS, EVICTION_NOTE, LEGACY_EVICTION_NOTE } from './artifact-eviction.js';

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
  return inputOf(messages, index)['content'] as string;
}

function inputOf(messages: BetaMessageParam[], index = 1): Record<string, unknown> {
  const msg = messages[index]!;
  const block = (msg.content as Array<{ type: string; input?: Record<string, unknown> }>).find(b => b.type === 'tool_use')!;
  return block.input!;
}

function resultOf(messages: BetaMessageParam[], index = 2): unknown {
  return (messages[index]!.content as Array<{ content?: unknown }>)[0]!.content;
}

// The in-field reference eviction wrote into `content` until 2026-10-10.
const IN_FIELD = '[evicted after successful save — 5251 chars. The artifact is persisted; its id and file path are in the tool result below. read_file that path if you need the content again.]';

describe('evictSavedArtifactBodies', () => {
  it('removes the content field of a successfully saved big body and appends the note to its result', () => {
    const msgs = saveTurn();
    const out = evictSavedArtifactBodies(msgs);
    expect(inputOf(out)).not.toHaveProperty('content');
    expect(resultOf(out)).toBe(`${resultOf(msgs) as string}${EVICTION_NOTE}`);
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
    expect(inputOf(overLimit)).not.toHaveProperty('content');
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
    expect(inputOf(out)).not.toHaveProperty('content');
  });

  it('is idempotent: a second pass returns the SAME array identity', () => {
    const once = evictSavedArtifactBodies(saveTurn());
    const twice = evictSavedArtifactBodies(once);
    expect(twice).toBe(once);
  });

  it('a second pass appends no second note', () => {
    const twice = evictSavedArtifactBodies(evictSavedArtifactBodies(saveTurn()));
    expect((resultOf(twice) as string).split(EVICTION_NOTE.trim()).length - 1).toBe(1);
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
    expect(inputOf(out)).not.toHaveProperty('content');
    expect(resultOf(out)).toEqual([
      { type: 'text', text: 'Saved artifact "Report" (id: ab12cd, v1).' },
      { type: 'text', text: EVICTION_NOTE.trimStart() },
    ]);
  });

  it('an error-marked result before the success result gets no note — the success result does', () => {
    const msgs = saveTurn();
    (msgs[2]!.content as unknown[]).unshift({ type: 'tool_result', tool_use_id: 'tu_1', content: 'Saved artifact "Report" (id: e, v1).', is_error: true });
    const out = evictSavedArtifactBodies(msgs);
    const results = (out[2]!.content as Array<{ content: string }>).map(r => r.content);
    expect(results[0]).toBe('Saved artifact "Report" (id: e, v1).');
    expect(results[1]).toMatch(/removed from the conversation/);
  });

  it('the note goes to the first non-error result only, the one the success check read', () => {
    const msgs = saveTurn();
    (msgs[2]!.content as unknown[]).push({ type: 'tool_result', tool_use_id: 'tu_1', content: 'Saved artifact "Report" (id: zz, v1).' });
    const out = evictSavedArtifactBodies(msgs);
    const results = (out[2]!.content as Array<{ content: string }>).map(r => r.content);
    expect(results[0]).toMatch(/removed from the conversation/);
    expect(results[1]).toBe('Saved artifact "Report" (id: zz, v1).');
  });

  // Threads persisted before 2026-10-10 can hold the old in-field reference as a call's
  // `content`: a model-made save of it, or the persist bug of 2026-08-14. Left there, the model
  // keeps seeing a copyable reference as a field value, so it is evicted at any size.
  it('the old in-field reference on a successful save is evicted at any size, original kept', () => {
    const seen: Array<[string, string]> = [];
    const out = evictSavedArtifactBodies(saveTurn({ content: IN_FIELD }), (id, body) => seen.push([id, body]));
    expect(IN_FIELD.length).toBeLessThan(EVICTION_MIN_CHARS);
    expect(inputOf(out)).not.toHaveProperty('content');
    expect(seen).toEqual([['tu_1', IN_FIELD]]);
    // Its note claims nothing about the file: the file can hold the reference, or the document.
    expect(resultOf(out)).toMatch(new RegExp(`${LEGACY_EVICTION_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    expect(resultOf(out)).not.toMatch(/removed from the conversation|It is persisted/);
  });

  it('a long body that only starts with the old reference gets the regular note', () => {
    const out = evictSavedArtifactBodies(saveTurn({ content: IN_FIELD + BIG }));
    expect(inputOf(out)).not.toHaveProperty('content');
    expect(resultOf(out)).toMatch(/removed from the conversation[^\]]*\]$/);
  });

  it('a regular eviction gets the regular note, not the one for the old form', () => {
    const out = evictSavedArtifactBodies(saveTurn());
    expect(resultOf(out)).toMatch(/removed from the conversation[^\]]*\]$/);
    expect(resultOf(out)).not.toContain(LEGACY_EVICTION_NOTE.trim());
  });

  // An overwrite result also names the backup of the previous version, below the File: line.
  it('the note points at the File: line, not at "the path above"', () => {
    expect(EVICTION_NOTE).toContain('read_file the File: path above');
    expect(LEGACY_EVICTION_NOTE).toContain('read_file the File: path above');
  });

  it('the old in-field reference on a FAILED save stays — that call is no evidence of a saved document', () => {
    const msgs = saveTurn({ content: IN_FIELD, result: 'Artifact store not available.' });
    expect(evictSavedArtifactBodies(msgs)).toBe(msgs);
  });

  it('a short body that merely mentions the old reference later on is not evicted', () => {
    const msgs = saveTurn({ content: `# Notes\n\nquoted: ${IN_FIELD}` });
    expect(evictSavedArtifactBodies(msgs)).toBe(msgs);
  });
});

describe('restoreEvictedBodies', () => {
  function evictWithOriginals(msgs: BetaMessageParam[]): { out: BetaMessageParam[]; originals: Map<string, string> } {
    const originals = new Map<string, string>();
    const out = evictSavedArtifactBodies(msgs, (id, body) => originals.set(id, body));
    return { out, originals };
  }

  it('undoes eviction exactly: the body is back and the note is gone (string result)', () => {
    const msgs = saveTurn();
    const { out, originals } = evictWithOriginals(structuredClone(msgs));
    expect(restoreEvictedBodies(out, originals)).toEqual(msgs);
  });

  it('undoes eviction exactly for an array-form result', () => {
    const msgs = saveTurn();
    (msgs[2]! as { content: unknown }).content = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'Saved artifact "Report" (id: ab12cd, v1).' }] },
    ];
    const { out, originals } = evictWithOriginals(structuredClone(msgs));
    expect(restoreEvictedBodies(out, originals)).toEqual(msgs);
  });

  it('undoes the eviction of an old in-field reference to that reference, as it was on disk', () => {
    const msgs = saveTurn({ content: IN_FIELD });
    const { out, originals } = evictWithOriginals(structuredClone(msgs));
    expect(restoreEvictedBodies(out, originals)).toEqual(msgs);
  });

  // The persisted mark can fall between a call and its result: each half is restored alone.
  it('restores a result whose call is already persisted, and a call whose result is not in the slice', () => {
    const msgs = saveTurn();
    const { out, originals } = evictWithOriginals(structuredClone(msgs));
    expect(restoreEvictedBodies(out.slice(2), originals)).toEqual(msgs.slice(2));
    expect(restoreEvictedBodies(out.slice(0, 2), originals)).toEqual(msgs.slice(0, 2));
  });

  it('a malformed tail with a null content block does not throw', () => {
    const { out, originals } = evictWithOriginals(saveTurn());
    const tail = [...out, { role: 'user', content: [null, { type: 'text', text: 'next' }] }] as unknown as BetaMessageParam[];
    expect(() => restoreEvictedBodies(tail, originals)).not.toThrow();
  });

  it('touches nothing it holds no original for', () => {
    const { out } = evictWithOriginals(saveTurn());
    expect(restoreEvictedBodies(out, new Map([['other', 'x']]))).toBe(out);
  });
});

describe('containsEvictionMarker', () => {
  it('finds the note and the old in-field reference, anywhere in the text', () => {
    expect(containsEvictionMarker(`# Pitch\n\n${EVICTION_NOTE.trim()}`)).toBe(true);
    expect(containsEvictionMarker(`intro ${IN_FIELD}`)).toBe(true);
    expect(containsEvictionMarker(`# Pitch\n\n${LEGACY_EVICTION_NOTE.trim()}`)).toBe(true);
    expect(containsEvictionMarker('# Pitch\n\nThe body was removed from the page.')).toBe(false);
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
    // Both eviction notes send the model to "the File: path above".
    expect(result).toMatch(/^File: \/workspace\/artifacts\/new1\.md$/m);
  });

  it('an UPDATE result satisfies isSuccessfulSaveResult', async () => {
    const result = await runRealSave({ title: 'T', content: 'body', id: 'ab1' }, stubStore);
    expect(isSuccessfulSaveResult(result)).toBe(true);
    expect(result).toMatch(/^File: \/workspace\/artifacts\/ab1\.md$/m);
  });

  it('the store-unavailable failure does NOT satisfy it', async () => {
    const result = await runRealSave({ title: 'T', content: 'body' }, undefined);
    expect(isSuccessfulSaveResult(result)).toBe(false);
  });
});
