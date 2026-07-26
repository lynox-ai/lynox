import { describe, it, expect } from 'vitest';
import { deriveBusinessDomain, buildDomainSearchQuery } from './onboarding-domain.js';

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

  it('skips international national directories (DE/FR/UK/IT), not just CH', () => {
    const r = deriveBusinessDomain([
      { url: 'https://www.gelbeseiten.de/x' },
      { url: 'https://www.pagesjaunes.fr/x' },
      { url: 'https://www.yell.com/x' },
      { url: 'https://www.paginegialle.it/x' },
      { url: 'https://baeckerei-mueller.de/' },
    ]);
    expect(r).toBe('https://baeckerei-mueller.de');
  });

  it('skips multi-TLD directory brands (yelp.de, europages.fr)', () => {
    expect(deriveBusinessDomain([
      { url: 'https://www.yelp.de/biz/x' },
      { url: 'https://www.europages.fr/x' },
      { url: 'https://firma.de/' },
    ])).toBe('https://firma.de');
    // brand match must not eat a real business that merely contains the word
    expect(deriveBusinessDomain([{ url: 'https://yelp-catering.de/' }])).toBe('https://yelp-catering.de');
  });
});

describe('buildDomainSearchQuery (localized)', () => {
  it('appends a language-matched suffix for known locales', () => {
    expect(buildDomainSearchQuery('Migros', 'de')).toBe('Migros offizielle Website');
    expect(buildDomainSearchQuery('Migros', 'en')).toBe('Migros official website');
    expect(buildDomainSearchQuery('Migros', 'fr')).toBe('Migros site officiel');
  });

  it('falls back to the bare company name for unknown locales (no English skew)', () => {
    expect(buildDomainSearchQuery('楽天', 'ja')).toBe('楽天');
    expect(buildDomainSearchQuery('Migros', 'xx')).toBe('Migros');
  });
});
