import { describe, it, expect, vi } from 'vitest';
import { setupMemoryStoreSubscription } from './engine-init.js';
import { channels } from './observability.js';
import { currentRunGroup, openRunGroup } from './run-group.js';
import type { KnowledgeLayer } from './knowledge-layer.js';

describe('knowledge extraction from a memory write reports in the writer\'s run group', () => {
  it('also when the extraction waited behind another run\'s extractions', async () => {
    // The subscriber caps concurrent extractions. A write that has to wait for a free slot
    // must still report in its own run's group, not in the group of whatever freed the slot.
    const seen: Array<{ content: string; group: string | null }> = [];
    const release: Array<() => void> = [];
    const layer = {
      store: (content: string): Promise<unknown> => new Promise((resolve) => {
        seen.push({ content, group: currentRunGroup() });
        release.push(() => resolve({}));
      }),
    } as unknown as KnowledgeLayer;
    setupMemoryStoreSubscription(layer, null, null, 'proj-1', () => false);
    const publish = (content: string): void => {
      channels.memoryStore.publish({ namespace: 'knowledge', content, scopeType: 'context', scopeId: 'proj-1', sourceChannel: 'agent' });
    };

    openRunGroup('run-a', () => { publish('a1'); publish('a2'); publish('a3'); });
    await vi.waitFor(() => { expect(seen).toHaveLength(3); });
    openRunGroup('run-b', () => publish('b1'));
    // All three slots are taken by run A; b1 starts only once one of them settles.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((s) => s.content), 'positive control: b1 is waiting').toEqual(['a1', 'a2', 'a3']);
    release[0]!();
    await vi.waitFor(() => { expect(seen).toHaveLength(4); });
    for (const r of release.slice(1)) r();
    expect(seen.find((s) => s.content === 'b1')!.group).toBe('run-b');
    expect(seen.filter((s) => s.content.startsWith('a')).every((s) => s.group === 'run-a')).toBe(true);
  });
});
