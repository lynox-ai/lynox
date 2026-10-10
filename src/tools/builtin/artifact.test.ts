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

  // The placeholder exactly as a model sees it: a real save through the handler,
  // then the real eviction transform over that turn. Built, not typed, so a
  // reworded placeholder cannot leave this test checking a string nobody writes.
  async function placeholderFor(document: string): Promise<{ id: string; placeholder: string }> {
    const result = await artifactSaveTool.handler({ title: 'Pitch', content: document }, makeAgent(store));
    const id = /id: ([0-9a-f]+)/.exec(result)![1]!;
    const turn = [
      { role: 'user', content: 'write the pitch' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'artifact_save', input: { title: 'Pitch', content: document } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: result }] },
    ] as BetaMessageParam[];
    const evicted = evictSavedArtifactBodies(turn);
    const block = (evicted[1]!.content as Array<{ type: string; input?: { content?: string } }>).find(b => b.type === 'tool_use')!;
    return { id, placeholder: block.input!.content! };
  }

  const DOCUMENT = '# Pitch\n\n' + 'Budget options and expected leads. '.repeat(Math.ceil(EVICTION_MIN_CHARS / 30));

  it('the placeholder built here is the evicted form, not the document', async () => {
    const { placeholder } = await placeholderFor(DOCUMENT);
    expect(placeholder).not.toBe(DOCUMENT);
    expect(placeholder.length).toBeLessThan(400);
  });

  it('an update carrying the placeholder throws and leaves the document as it was', async () => {
    const { id, placeholder } = await placeholderFor(DOCUMENT);
    await expect(artifactSaveTool.handler({ id, title: 'Pitch', content: placeholder }, makeAgent(store)))
      .rejects.toThrow(/artifact_save refused[\s\S]*edit_file/);
    expect(store.get(id)?.content).toBe(DOCUMENT);
    expect(store.get(id)?.version).toBe(1);
  });

  it('a new artifact carrying the placeholder throws and creates nothing', async () => {
    const { placeholder } = await placeholderFor(DOCUMENT);
    const before = store.list().length;
    await expect(artifactSaveTool.handler({ title: 'Pitch v3', content: placeholder }, makeAgent(store)))
      .rejects.toThrow(/artifact_save refused/);
    expect(store.list().length).toBe(before);
  });

  it('the placeholder under a heading is refused too', async () => {
    const { placeholder } = await placeholderFor(DOCUMENT);
    await expect(artifactSaveTool.handler({ title: 'Pitch', content: `# Pitch\n\n${placeholder}\n` }, makeAgent(store)))
      .rejects.toThrow(/artifact_save refused/);
  });

  it('a real document still saves, as an update and as a new artifact', async () => {
    const { id } = await placeholderFor(DOCUMENT);
    const updated = await artifactSaveTool.handler({ id, title: 'Pitch', content: DOCUMENT + '\nThree options.' }, makeAgent(store));
    expect(updated).toMatch(/^Updated artifact "Pitch"/);
    expect(store.get(id)?.content).toBe(DOCUMENT + '\nThree options.');
    const created = await artifactSaveTool.handler({ title: 'Notes', content: 'short note' }, makeAgent(store));
    expect(created).toMatch(/^Saved artifact "Notes"/);
  });
});
