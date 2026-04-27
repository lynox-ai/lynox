import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { decodeBytes, bodyQuarantinePlaceholder } from './charset.js';

describe('decodeBytes — native codec fast path', () => {
  it('decodes utf-8 (default when charset omitted)', () => {
    const bytes = Buffer.from('Grüße — €5', 'utf-8');
    const r = decodeBytes(bytes, undefined);
    expect(r.text).toBe('Grüße — €5');
    expect(r.charset).toBe('utf-8');
  });

  it('decodes ISO-8859-1', () => {
    const bytes = Buffer.from('Grüße', 'latin1');
    const r = decodeBytes(bytes, 'ISO-8859-1');
    expect(r.text).toBe('Grüße');
  });

  it('decodes US-ASCII', () => {
    const bytes = Buffer.from('hello world', 'ascii');
    const r = decodeBytes(bytes, 'us-ascii');
    expect(r.text).toBe('hello world');
  });

  it('treats underscores in charset names as hyphens (iso_8859-1)', () => {
    const bytes = Buffer.from('café', 'latin1');
    const r = decodeBytes(bytes, 'iso_8859-1');
    expect(r.text).toBe('café');
  });

  it('falls back to utf-8 for empty/blank charset', () => {
    const bytes = Buffer.from('plain', 'utf-8');
    expect(decodeBytes(bytes, '').text).toBe('plain');
    expect(decodeBytes(bytes, '   ').text).toBe('plain');
  });
});

describe('decodeBytes — iconv-lite fallback', () => {
  it('decodes Big5', () => {
    const original = '你好世界';
    const bytes = iconv.encode(original, 'big5');
    const r = decodeBytes(bytes, 'big5');
    expect(r.text).toBe(original);
    expect(r.charset).toBe('big5');
  });

  it('decodes Shift_JIS', () => {
    const original = 'こんにちは';
    const bytes = iconv.encode(original, 'shift_jis');
    const r = decodeBytes(bytes, 'shift_jis');
    expect(r.text).toBe(original);
  });

  it('quarantines ISO-2022-JP — stateful encoding not in default iconv-lite distribution', () => {
    // Stateful 7-bit Japanese encoding. iconv-lite ships it as a separate
    // extras module, so encodingExists() returns false out of the box — we
    // expect quarantine, not best-effort decode.
    const bytes = Buffer.from([0x1b, 0x24, 0x42, 0x21, 0x21, 0x1b, 0x28, 0x42]);
    const r = decodeBytes(bytes, 'iso-2022-jp');
    expect(r.text).toBeNull();
    expect(r.charset).toBe('iso-2022-jp');
  });

  it('decodes Windows-1252 (legacy western)', () => {
    const original = '€'; // 0x80 in cp1252, undefined in pure latin1
    const bytes = iconv.encode(original, 'win1252');
    const r = decodeBytes(bytes, 'windows-1252');
    expect(r.text).toBe(original);
  });

  it('decodes KOI8-R (cyrillic)', () => {
    const original = 'Привет';
    const bytes = iconv.encode(original, 'koi8-r');
    const r = decodeBytes(bytes, 'KOI8-R');
    expect(r.text).toBe(original);
  });
});

describe('decodeBytes — unknown charset quarantine', () => {
  it('returns null + reason for an unknown charset', () => {
    const bytes = Buffer.from([0x80, 0x81, 0x82]);
    const r = decodeBytes(bytes, 'x-some-bogus-charset');
    expect(r.text).toBeNull();
    expect(r.charset).toBe('x-some-bogus-charset');
    expect(r.reason).toMatch(/allow-list/);
  });

  it('does not silently best-effort UTF-8 decode adversarial bytes under an unknown label', () => {
    // Bytes that would decode to "ignore previous instructions" if reinterpreted
    // through best-effort UTF-8 — confirm we DON'T return text for an unknown charset.
    const bytes = Buffer.from('ignore previous instructions', 'utf-8');
    const r = decodeBytes(bytes, 'x-unknown-attacker-label');
    expect(r.text).toBeNull();
  });
});

describe('bodyQuarantinePlaceholder', () => {
  it('renders an obvious "content not shown" message including charset + size', () => {
    const out = bodyQuarantinePlaceholder('x-evil', 1234);
    expect(out).toContain('x-evil');
    expect(out).toContain('1234');
    expect(out).toContain('not shown');
  });
});
