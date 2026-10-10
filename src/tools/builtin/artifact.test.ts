import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../../core/artifact-store.js';
import { artifactHistoryTool, artifactRestoreTool, artifactSaveTool } from './artifact.js';
import type { IAgent } from '../../types/index.js';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { evictSavedArtifactBodies, EVICTION_MIN_CHARS } from '../../core/artifact-eviction.js';

// Minimal agent — the artifact tools only read agent.toolContext.artifactStore.
function makeAgent(store: ArtifactStore | null): IAgent {
  return { toolContext: { artifactStore: store } } as unknown as IAgent;
}

describe('artifact history/restore tool handlers', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-artifact-tool-'));
    store = new ArtifactStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('artifact_history: fresh artifact reports no earlier versions', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    const out = await artifactHistoryTool.handler({ id: a.id }, makeAgent(store));
    expect(out).toContain('no earlier versions');
    expect(out).toContain('v1');
  });

  it('artifact_history: lists prior versions newest-first with the current version', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    store.save({ id: a.id, title: 'Deck', content: 'v2' });
    store.save({ id: a.id, title: 'Deck', content: 'v3' });
    const out = await artifactHistoryTool.handler({ id: a.id }, makeAgent(store));
    expect(out).toMatch(/current v3/);
    expect(out).toContain('v2');
    expect(out).toContain('v1');
    expect(out).toContain('artifact_restore');
  });

  it('artifact_history: unknown id → not found', async () => {
    const out = await artifactHistoryTool.handler({ id: 'ffffffff' }, makeAgent(store));
    expect(out).toContain('not found');
  });

  it('artifact_restore: rolls back to a prior version and is reversible', async () => {
    const a = store.save({ title: 'Deck', content: 'original' });
    store.save({ id: a.id, title: 'Deck', content: 'rewritten' });
    const out = await artifactRestoreTool.handler({ id: a.id, version: 1 }, makeAgent(store));
    expect(out).toContain('Restored');
    expect(store.get(a.id)?.content).toBe('original');
    // The rewrite is still recoverable (restore snapshotted it first).
    expect(store.history(a.id).some(h => h.version >= 2)).toBe(true);
  });

  it('artifact_restore: missing version → actionable not-found message', async () => {
    const a = store.save({ title: 'Deck', content: 'x' });
    const out = await artifactRestoreTool.handler({ id: a.id, version: 99 }, makeAgent(store));
    expect(out).toContain('not found');
    expect(out).toContain('artifact_history');
  });

  it('both tools: degrade cleanly when the store is unavailable', async () => {
    expect(await artifactHistoryTool.handler({ id: 'ffffffff' }, makeAgent(null))).toContain('not available');
    expect(await artifactRestoreTool.handler({ id: 'ffffffff', version: 1 }, makeAgent(null))).toContain('not available');
  });
});

describe('artifact_save refuses the eviction placeholder as content', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-artifact-marker-'));
    store = new ArtifactStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The reference in the two forms a model can copy: the note the engine now appends to an
  // evicted save's result — taken from a real save through the handler and the real eviction
  // transform, so a reworded note cannot leave this test checking a string nobody writes — and
  // the in-field form it put into `content` until 2026-10-10, which threads persisted before
  // then still carry (typed: nothing writes it any more).
  const IN_FIELD = '[evicted after successful save — 5251 chars. The artifact is persisted; its id and file path are in the tool result below. read_file that path if you need the content again.]';

  async function placeholdersFor(document: string): Promise<{ id: string; forms: Array<[string, string]>; evictedInput: Record<string, unknown> }> {
    const result = await artifactSaveTool.handler({ title: 'Pitch', content: document }, makeAgent(store));
    const id = /id: ([0-9a-f]+)/.exec(result)![1]!;
    const turn = [
      { role: 'user', content: 'write the pitch' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'artifact_save', input: { title: 'Pitch', content: document } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: result }] },
    ] as BetaMessageParam[];
    const evicted = evictSavedArtifactBodies(turn);
    const call = (evicted[1]!.content as Array<{ type: string; input?: Record<string, unknown> }>).find(b => b.type === 'tool_use')!;
    const evictedResult = (evicted[2]!.content as Array<{ content: string }>)[0]!.content;
    const note = evictedResult.slice(result.length).trim();
    return { id, forms: [['note', note], ['in-field form', IN_FIELD]], evictedInput: call.input! };
  }

  const DOCUMENT = '# Pitch\n\n' + 'Budget options and expected leads. '.repeat(Math.ceil(EVICTION_MIN_CHARS / 30));

  it('the note built here is what eviction appends, and the evicted call keeps no content', async () => {
    const { forms, evictedInput } = await placeholdersFor(DOCUMENT);
    const note = forms[0]![1];
    expect(note.length, 'eviction appended a note').toBeGreaterThan(20);
    expect(note.length).toBeLessThan(400);
    expect(evictedInput).not.toHaveProperty('content');
  });

  it('an update carrying either form throws and leaves the document as it was', async () => {
    const { id, forms } = await placeholdersFor(DOCUMENT);
    for (const [form, placeholder] of forms) {
      await expect(artifactSaveTool.handler({ id, title: 'Pitch', content: placeholder }, makeAgent(store)), form)
        .rejects.toThrow(/artifact_save refused[\s\S]*edit_file/);
    }
    expect(store.get(id)?.content).toBe(DOCUMENT);
    expect(store.get(id)?.version).toBe(1);
  });

  it('a new artifact carrying either form throws and creates nothing', async () => {
    const { forms } = await placeholdersFor(DOCUMENT);
    const before = store.list().length;
    for (const [form, placeholder] of forms) {
      await expect(artifactSaveTool.handler({ title: 'Pitch v3', content: placeholder }, makeAgent(store)), form)
        .rejects.toThrow(/artifact_save refused/);
    }
    expect(store.list().length).toBe(before);
  });

  it('either form under a heading is refused too', async () => {
    const { forms } = await placeholdersFor(DOCUMENT);
    for (const [form, placeholder] of forms) {
      await expect(artifactSaveTool.handler({ title: 'Pitch', content: `# Pitch\n\n${placeholder}\n` }, makeAgent(store)), form)
        .rejects.toThrow(/artifact_save refused/);
    }
  });

  it('a real document still saves, as an update and as a new artifact', async () => {
    const { id } = await placeholdersFor(DOCUMENT);
    const updated = await artifactSaveTool.handler({ id, title: 'Pitch', content: DOCUMENT + '\nThree options.' }, makeAgent(store));
    expect(updated).toMatch(/^Updated artifact "Pitch"/);
    expect(store.get(id)?.content).toBe(DOCUMENT + '\nThree options.');
    const created = await artifactSaveTool.handler({ title: 'Notes', content: 'short note' }, makeAgent(store));
    expect(created).toMatch(/^Saved artifact "Notes"/);
  });
});
