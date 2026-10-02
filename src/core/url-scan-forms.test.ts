import { describe, it, expect } from 'vitest';
import { urlScanForms } from './url-scan-forms.js';

describe('urlScanForms', () => {
  it('returns the URL as written when there is nothing to decode', () => {
    expect(urlScanForms('https://h.example/a/b?q=1')).toEqual(['https://h.example/a/b?q=1']);
  });

  it('adds the decoded form when the URL carries percent-encoding', () => {
    expect(urlScanForms('https://h.example/a%2Db?q=%41')).toEqual(['https://h.example/a%2Db?q=%41', 'https://h.example/a-b?q=A']);
  });

  it('returns only the URL as written when it cannot be decoded', () => {
    expect(urlScanForms('https://h.example/100%?x=%ZZ')).toEqual(['https://h.example/100%?x=%ZZ']);
  });
});
