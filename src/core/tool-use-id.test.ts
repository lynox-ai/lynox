import { describe, it, expect } from 'vitest';
import { newToolUseId } from './tool-use-id.js';

describe('newToolUseId', () => {
  it('always gives 9 alphanumerics, and no repeats over many draws', () => {
    const ids = Array.from({ length: 5000 }, () => newToolUseId());
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
