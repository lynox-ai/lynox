import { describe, it, expect } from 'vitest';
import { urlScanForms } from './url-scan-forms.js';

describe('urlScanForms', () => {
  it('returns the URL as written when there is nothing to decode', () => {
    expect(urlScanForms('https://h.example/a/b?q=1')).toEqual(['https://h.example/a/b?q=1']);
  });

  it('decodes a run as UTF-8 when it is valid UTF-8', () => {
    expect(urlScanForms('https://h.example/caf%C3%A9')).toEqual(['https://h.example/caf%C3%A9', 'https://h.example/caf\u00e9']);
  });

  it('adds the decoded form when the URL carries percent-encoding', () => {
    expect(urlScanForms('https://h.example/a%2Db?q=%41')).toEqual(['https://h.example/a%2Db?q=%41', 'https://h.example/a-b?q=A']);
  });

  it('returns only the URL as written when nothing in it is encoded', () => {
    expect(urlScanForms('https://h.example/100%?x=%ZZ')).toEqual(['https://h.example/100%?x=%ZZ']);
  });

  it('decodes every well-formed sequence even next to one that is not', () => {
    // A stray `%` and an invalid UTF-8 byte must not keep the rest from being decoded.
    expect(urlScanForms('https://h.example/50%/a%2Db?x=%C3&y=%41')).toEqual([
      'https://h.example/50%/a%2Db?x=%C3&y=%41',
      'https://h.example/50%/a-b?x=\u00c3&y=A',
    ]);
  });
});
