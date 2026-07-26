import { describe, it, expect } from 'vitest';
import { deriveBusinessDomain } from './onboarding-domain.js';

describe('deriveBusinessDomain (onboarding domain candidate)', () => {
  it('returns the first business-looking domain, https, no www', () => {
    const r = deriveBusinessDomain([
      { url: 'https://www.roestwerk-zurich.ch/about' },
      { url: 'https://example.com' },
    ]);
    expect(r).toBe('https://roestwerk-zurich.ch');
  });

  it('skips social / directory / marketplace results (incl. subdomains)', () => {
    const r = deriveBusinessDomain([
      { url: 'https://www.linkedin.com/company/roestwerk' },
      { url: 'https://de.wikipedia.org/wiki/Roestwerk' },
      { url: 'https://moneyhouse.ch/de/company/roestwerk' },
      { url: 'https://roestwerk-zurich.ch/' },
    ]);
    expect(r).toBe('https://roestwerk-zurich.ch');
  });

  it('returns null when nothing clean surfaces (→ empty field, manual fallback)', () => {
    const r = deriveBusinessDomain([
      { url: 'https://www.linkedin.com/company/x' },
      { url: 'https://facebook.com/x' },
      { url: 'not-a-url' },
    ]);
    expect(r).toBeNull();
  });

  it('ignores non-http(s) schemes, bare TLDs and IPs', () => {
    expect(deriveBusinessDomain([{ url: 'ftp://files.example.com' }, { url: 'https://firma.ch' }])).toBe('https://firma.ch');
    expect(deriveBusinessDomain([{ url: 'https://localhost' }])).toBeNull();
    expect(deriveBusinessDomain([{ url: 'https://10.0.0.1/' }])).toBeNull();
  });

  it('empty input → null', () => {
    expect(deriveBusinessDomain([])).toBeNull();
  });

  it('respects maxScan (a good domain buried past the window is not returned)', () => {
    const junk = Array.from({ length: 6 }, () => ({ url: 'https://linkedin.com/x' }));
    expect(deriveBusinessDomain([...junk, { url: 'https://firma.ch' }])).toBeNull();
  });
});
