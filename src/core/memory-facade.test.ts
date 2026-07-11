import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from './memory.js';
import { MemoryFacade } from './memory-facade.js';
import type { KnowledgeLayer } from './knowledge-layer.js';

/**
 * The facade is the single mutation choke point: every doc write must mirror to the
 * knowledge layer (the recall authority), so a UI edit/delete actually changes what
 * the agent recalls. These pin the sync matrix + the empty-oldText guard (the T1 bug).
 */
interface KgCalls { store: string[]; deactivate: string[]; erase: string[]; update: Array<[string, string]> }
function spyKg(opts: { throws?: boolean } = {}): { kg: KnowledgeLayer; calls: KgCalls } {
  const calls: KgCalls = { store: [], deactivate: [], erase: [], update: [] };
  const kg = {
    store: async (text: string): Promise<unknown> => { if (opts.throws) throw new Error('kg down'); calls.store.push(text); return {}; },
    deactivateByPattern: async (pattern: string): Promise<number> => { if (opts.throws) throw new Error('kg down'); calls.deactivate.push(pattern); return 1; },
    eraseByPattern: async (pattern: string): Promise<number> => { if (opts.throws) throw new Error('kg down'); calls.erase.push(pattern); return 1; },
    updateMemoryText: async (o: string, n: string): Promise<boolean> => { if (opts.throws) throw new Error('kg down'); calls.update.push([o, n]); return true; },
  } as unknown as KnowledgeLayer;
  return { kg, calls };
}

describe('MemoryFacade — doc↔KG mutation sync', () => {
  let dir: string;
  let memory: Memory;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lynox-facade-')); memory = new Memory(dir); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('append writes the doc AND mirrors to the KG', async () => {
    const { kg, calls } = spyKg();
    await new MemoryFacade(memory, kg).append('knowledge', 'user prefers TypeScript');
    expect(await memory.load('knowledge')).toContain('user prefers TypeScript');
    expect(calls.store).toEqual(['user prefers TypeScript']);
  });

  it('delete removes matching doc lines AND hard-erases the KG twins (unconditionally — even with no doc match)', async () => {
    await memory.append('knowledge', 'fact about Acme');
    const { kg, calls } = spyKg();
    const facade = new MemoryFacade(memory, kg);
    const n = await facade.delete('knowledge', 'Acme');
    expect(n).toBe(1);
    expect(await memory.load('knowledge') ?? '').not.toContain('Acme');
    expect(calls.erase).toEqual(['Acme']);
    // No flat-file match STILL erases the KG: a document-ingest row has no flat-file
    // twin, so the old `if (count > 0)` gate is exactly what left it unforgettable.
    await facade.delete('knowledge', 'nonexistent');
    expect(calls.erase).toEqual(['Acme', 'nonexistent']);
  });

  it('delete refuses an empty/whitespace pattern — no doc wipe, no KG erase', async () => {
    await memory.append('knowledge', 'keep me safe');
    const { kg, calls } = spyKg();
    const n = await new MemoryFacade(memory, kg).delete('knowledge', '   ');
    expect(n).toBe(0);
    expect(await memory.load('knowledge')).toContain('keep me safe'); // NOT wiped
    expect(calls.erase).toEqual([]);
  });

  it('update rewrites the doc AND the KG when the old text exists', async () => {
    await memory.append('knowledge', 'budget is 5000');
    const { kg, calls } = spyKg();
    const ok = await new MemoryFacade(memory, kg).update('knowledge', 'budget is 5000', 'budget is 8000');
    expect(ok).toBe(true);
    expect(await memory.load('knowledge')).toContain('budget is 8000');
    expect(calls.update).toEqual([['budget is 5000', 'budget is 8000']]);
  });

  it('update with EMPTY old text is refused — no prepend, no KG call (the T1 no-op guard)', async () => {
    await memory.append('knowledge', 'existing fact');
    const before = await memory.load('knowledge');
    const { kg, calls } = spyKg();
    // A non-empty newText would be PREPENDED by `''.replace('', x)` without the guard —
    // this asserts the guard actually blocks the corruption, not just returns unchanged.
    const ok = await new MemoryFacade(memory, kg).update('knowledge', '', 'INJECTED');
    expect(ok).toBe(false);
    expect(await memory.load('knowledge')).toBe(before);
    expect(await memory.load('knowledge') ?? '').not.toContain('INJECTED');
    expect(calls.update).toEqual([]);
  });

  it('replaceDocument does NOT deactivate a removed line that is a substring of a surviving line', async () => {
    await memory.save('knowledge', 'Roland prefers email\nRoland prefers email in the morning');
    const { kg, calls } = spyKg();
    // Remove the short line, keep the longer one that contains it as a substring.
    await new MemoryFacade(memory, kg).replaceDocument('knowledge', 'Roland prefers email in the morning');
    // A LIKE %pattern% deactivate of the short line would wrongly retire the survivor's
    // KG twin — the guard must skip it. Nothing is deactivated (or stored).
    expect(calls.deactivate).toEqual([]);
    expect(calls.store).toEqual([]);
  });

  it('mirrors the [date] prefix strip through replaceDocument (removed dated line → stored body)', async () => {
    await memory.save('knowledge', '[2026-07-01] old dated fact');
    const { kg, calls } = spyKg();
    await new MemoryFacade(memory, kg).replaceDocument('knowledge', '[2026-07-06] fresh fact');
    expect(calls.deactivate).toEqual(['old dated fact']);
    expect(calls.store).toEqual(['fresh fact']);
  });

  it('a KG erase failure FAILS the delete (erasure is not best-effort) — update stays best-effort', async () => {
    await memory.append('knowledge', 'budget is 5000');
    const { kg } = spyKg({ throws: true });
    const facade = new MemoryFacade(memory, kg);
    // update is a soft mirror → a KG hiccup must not fail the user's edit.
    await expect(facade.update('knowledge', 'budget is 5000', 'budget is 8000')).resolves.toBe(true);
    // delete is erasure → a swallowed reap leaves content recallable, so it MUST surface.
    await expect(facade.delete('knowledge', 'budget')).rejects.toThrow('kg down');
    // The flat-file line was still removed BEFORE the KG reap threw (the doc is the
    // source of truth); the rejection is the recall-mirror half, which the caller sees.
    expect(await memory.load('knowledge') ?? '').not.toContain('budget');
  });

  it('replaceDocument deactivates removed lines and stores added lines (kept lines untouched)', async () => {
    await memory.save('knowledge', 'line A\nline B');
    const { kg, calls } = spyKg();
    await new MemoryFacade(memory, kg).replaceDocument('knowledge', 'line A\nline C');
    expect(calls.deactivate).toEqual(['line B']);
    expect(calls.store).toEqual(['line C']);
  });

  it('strips the [date] prefix so the KG mirror matches the stored statement text', async () => {
    const { kg, calls } = spyKg();
    await new MemoryFacade(memory, kg).append('knowledge', '[2026-07-06] dated fact');
    expect(calls.store).toEqual(['dated fact']);
  });

  it('a KG failure never fails the document mutation (best-effort mirror)', async () => {
    const { kg } = spyKg({ throws: true });
    await expect(new MemoryFacade(memory, kg).append('knowledge', 'still saved')).resolves.toBeUndefined();
    expect(await memory.load('knowledge')).toContain('still saved');
  });

  it('a null knowledge layer is a no-op mirror (self-host / KG disabled)', async () => {
    const facade = new MemoryFacade(memory, null);
    await facade.append('knowledge', 'no kg here');
    expect(await facade.delete('knowledge', 'no kg')).toBe(1);
    expect(await memory.load('knowledge') ?? '').toBe('');
  });
});
