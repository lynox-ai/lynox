import { describe, it, expect } from 'vitest';
import { hashPrompt } from './prompt-hash.js';

describe('hashPrompt', () => {
  it('returns consistent hash for the same input', () => {
    const h1 = hashPrompt('You are a helpful assistant.');
    const h2 = hashPrompt('You are a helpful assistant.');
    expect(h1).toBe(h2);
  });

  it('returns a 16 hex character string', () => {
    const hash = hashPrompt('test prompt');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = hashPrompt('prompt alpha');
    const h2 = hashPrompt('prompt beta');
    expect(h1).not.toBe(h2);
  });

  it('handles empty string', () => {
    const hash = hashPrompt('');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles unicode text', () => {
    const hash = hashPrompt('Du bist ein hilfreicher Assistent. 🤖');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
