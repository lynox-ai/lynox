import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStartupReap } from './memory-gc.js';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import type { IKnowledgeLayer } from '../types/index.js';

/**
 * The periodic reap trigger is `runCount % 50` and `runCount` is an in-memory field that
 * resets on every restart, so a restart-heavy instance never reaps. These pin the startup
 * hook that closes that hole — and, just as importantly, pin that it does NOT run
 * consolidation, which would merge a user's memories on every reboot.
 */
describe('runStartupReap', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  describe('against a REAL knowledge layer', () => {
    // A fake would accept `gc({ dryRun: true })` — a compiling, plausible bug that reaps
    // nothing — without noticing. This drives the actual delete.
    let layer: KnowledgeLayer;
    const embedding = new LocalProvider();

    beforeEach(() => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-reap-'));
      tmpDirs.push(dir);
      layer = new KnowledgeLayer(join(dir, 'agent-memory.db'), embedding);
    });

    it('actually removes a deactivated row from disk', async () => {
      const db = layer.getDb();
      const id = db.createMemory({
        text: 'Jana Reber lives in Bern', namespace: 'knowledge',
        scopeType: 'global', scopeId: 'global', embedding: new Array(embedding.dimensions).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
      });
      db.deactivateMemoriesByPattern('Jana Reber');
      expect(db.getMemory(id)).not.toBeNull(); // deactivated, still on disk

      const result = await runStartupReap(layer);

      expect(result).toEqual({ reaped: true, error: null });
      expect(db.getMemory(id)).toBeNull(); // gone — a dry-run reap would fail here
    });

    it('leaves ACTIVE rows alone', async () => {
      const db = layer.getDb();
      const id = db.createMemory({
        text: 'ACME pays by invoice', namespace: 'knowledge',
        scopeType: 'global', scopeId: 'global', embedding: new Array(embedding.dimensions).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
      });
      await runStartupReap(layer);
      expect(db.getMemory(id)).not.toBeNull();
    });
  });

  it('does NOT consolidate — a reboot must not silently merge a user\'s memories', async () => {
    const layer = {
      gc: vi.fn().mockResolvedValue({ supersededRemoved: 0, orphanEntitiesRemoved: 0, staleMemoriesRemoved: 0 }),
      consolidateMemories: vi.fn(),
    } as unknown as IKnowledgeLayer;

    await runStartupReap(layer);

    expect(layer.gc).toHaveBeenCalledTimes(1);
    expect(layer.gc).toHaveBeenCalledWith(); // no dry-run flag smuggled in
    expect(layer.consolidateMemories).not.toHaveBeenCalled();
  });

  it('returns the failure instead of swallowing it, so the caller can report', async () => {
    const boom = new Error('database is locked');
    const layer = { gc: vi.fn().mockRejectedValue(boom) } as unknown as IKnowledgeLayer;

    const result = await runStartupReap(layer);

    expect(result.reaped).toBe(false);
    expect(result.error).toBe(boom); // a swallowed error would leave this null
  });

  it('is a no-op with no layer wired', async () => {
    await expect(runStartupReap(null)).resolves.toEqual({ reaped: false, error: null });
  });
});
