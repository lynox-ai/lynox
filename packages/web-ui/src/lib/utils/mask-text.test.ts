import { describe, it, expect } from 'vitest';
import { maskText } from './mask-text.js';
import { looksLikeSecret } from './secret-shapes.js';

// Values assembled at runtime so no commit scan reads them as keys.
const botSecret = 'AA' + 'Hdq0Zr8k'.repeat(4) + 'x'; // 35 characters, the length of a bot token's secret

describe('maskText — Telegram bot tokens', () => {
  it.each([
    ['a bare token', '123456789:' + botSecret],
    ['a token in an API URL, right after /bot', 'https://api.telegram.org/bot123456789:' + botSecret + '/sendMessage'],
    ['a ten-digit id', '1234567890:' + botSecret],
    ['a twelve-digit id', '123456789012:' + botSecret],
  ])('masks %s', (_name, text) => {
    expect(maskText(text)).not.toContain(botSecret);
  });

  it('still hides the secret when the id is longer than the cap', () => {
    expect(maskText('1234567890123:' + botSecret)).not.toContain(botSecret);
  });

  it('leaves a short id-like number with a colon alone', () => {
    expect(maskText('call 12345:later today')).toBe('call 12345:later today');
  });
});

describe('maskText — shared shapes', () => {
  it('masks a JWT and an Anthropic-style key', () => {
    const jwt = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'Sf1Kx'.repeat(5);
    const key = 'sk-' + 'ant-api03-' + 'Q7r'.repeat(8);
    const out = maskText(`token ${jwt} and ${key}`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain(key);
  });
});

describe('web UI secret scanners on adversarial input', () => {
  const PREFIXES = ['sk-' + 'ant-', 'sk-', 'tv' + 'ly-', 'ey' + 'J', 'gh' + 'p_', 'AK' + 'IA', 'xo' + 'xb-', 'ya' + '29.', '99999:', '9'];
  const units: string[] = [];
  for (const p of PREFIXES) units.push(p, p + 'aaa', p + '.', '_' + p + '9', p + '-');
  units.push('eyJ---', '_eyJ9aaaaaaaaaaaa', '0');

  // Wide on purpose: CI measures with coverage on, and a quadratic scan takes seconds here.
  it('maskText and looksLikeSecret answer within 1000 ms on every 128 KB input', () => {
    const slow: string[] = [];
    for (const unit of units) {
      const text = unit.repeat(Math.ceil((128 * 1024) / unit.length)).slice(0, 128 * 1024);
      for (const [name, scan] of [['maskText', maskText], ['looksLikeSecret', looksLikeSecret]] as const) {
        const started = performance.now();
        scan(text);
        const ms = performance.now() - started;
        if (ms > 1_000) slow.push(`${name} on ${JSON.stringify(unit)}: ${ms.toFixed(0)} ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 300_000);
});
