import { describe, it, expect } from 'vitest';
import { tokenAnswer, tokenErrorCode } from './oauth-token-answer.js';

const frag = ['zq', 'Vx81Lm'].join('');

describe('tokenErrorCode', () => {
  it('keeps a plain OAuth error code', () => {
    expect(tokenErrorCode(JSON.stringify({ error: 'invalid_grant', error_description: frag }))).toBe(' (invalid_grant)');
  });
  it('drops a code that is not a plain OAuth code', () => {
    expect(tokenErrorCode(JSON.stringify({ error: `x ${frag}` }))).toBe('');
    expect(tokenErrorCode(JSON.stringify({ error: frag }))).toBe('');
  });
  it('drops a body that is not JSON or names no code', () => {
    expect(tokenErrorCode(`${frag} <html>`)).toBe('');
    expect(tokenErrorCode(JSON.stringify({ error_description: frag }))).toBe('');
  });
});

describe('tokenAnswer', () => {
  it('returns the parsed answer', async () => {
    await expect(tokenAnswer(new Response('{"a":1}'), 'X')).resolves.toEqual({ a: 1 });
  });
  it('names a malformed answer under its label, never quotes it', async () => {
    const err = await tokenAnswer(new Response(`${frag}abcdef`), 'X failed').then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe('X failed: the answer is not valid JSON');
  });
  it('passes a failure that is not a parse error through', async () => {
    const boom = new TypeError('terminated');
    await expect(tokenAnswer({ json: () => Promise.reject(boom) }, 'X')).rejects.toBe(boom);
  });
});
