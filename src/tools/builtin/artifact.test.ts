import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../../core/artifact-store.js';
import { artifactHistoryTool, artifactRestoreTool } from './artifact.js';
import type { IAgent } from '../../types/index.js';

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
