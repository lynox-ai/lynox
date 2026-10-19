import { describe, it, expect, vi } from 'vitest';
import { newToolUseId } from './tool-use-id.js';

describe('newToolUseId', () => {
  it('always gives 9 alphanumerics, and no repeats over many draws', () => {
    const ids = Array.from({ length: 5000 }, () => newToolUseId());
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not start over when the module is loaded again (a process restart)', async () => {
    // Threads outlive the process: an id that restarted with the module would
    // repeat inside a thread that was saved before the restart.
    const firsts: string[] = [];
    for (let i = 0; i < 2; i++) {
      vi.resetModules();
      const fresh = await import('./tool-use-id.js');
      firsts.push(fresh.newToolUseId());
    }
    expect(firsts[0]).not.toBe(firsts[1]);
  });
});
