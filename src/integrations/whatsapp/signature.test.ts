import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from './signature.js';

const SECRET = 'test-app-secret';

function sign(body: string): string {
  const hex = createHmac('sha256', SECRET).update(body).digest('hex');
  return `sha256=${hex}`;
}

describe('verifySignature', () => {
  it('accepts a correctly-signed body', () => {
    const body = '{"entry":[{"changes":[{}]}]}';
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects when signature header is missing', () => {
    expect(verifySignature('{}', null, SECRET)).toBe(false);
  });

  it('rejects when the sha256= prefix is missing', () => {
    const body = '{}';
    const hex = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(body, hex, SECRET)).toBe(false);
  });

  it('rejects when the signature is computed with a different secret', () => {
    const body = '{"foo":"bar"}';
    const wrong = `sha256=${createHmac('sha256', 'other-secret').update(body).digest('hex')}`;
    expect(verifySignature(body, wrong, SECRET)).toBe(false);
  });

  it('rejects when the body is tampered', () => {
    const body = '{"foo":"bar"}';
    const sig = sign(body);
    expect(verifySignature('{"foo":"baz"}', sig, SECRET)).toBe(false);
  });

  it('accepts Buffer input as well as string', () => {
    const body = 'hello world';
    expect(verifySignature(Buffer.from(body, 'utf8'), sign(body), SECRET)).toBe(true);
  });

  it('does not throw on malformed hex', () => {
    expect(verifySignature('{}', 'sha256=not-hex-at-all', SECRET)).toBe(false);
  });
});
