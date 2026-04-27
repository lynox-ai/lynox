import { describe, it, expect } from 'vitest';
import { parseTemplate, validateName, checkName } from './ads-naming-convention.js';

describe('parseTemplate', () => {
  it('parses a 4-token template with hyphen separators', () => {
    const t = parseTemplate('{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}');
    expect(t.valid).toBe(true);
    expect(t.tokens).toEqual(['LANG', 'CHANNEL', 'THEME', 'MATCHTYPE']);
    expect(t.separators).toEqual(['-', '-', '-']);
  });

  it('accepts mixed separators', () => {
    const t = parseTemplate('{LANG}_{CHANNEL}-{THEME}.{MATCHTYPE}');
    expect(t.valid).toBe(true);
    expect(t.separators).toEqual(['_', '-', '.']);
  });

  it('rejects template with no tokens', () => {
    const t = parseTemplate('hello-world');
    expect(t.valid).toBe(false);
    expect(t.errors[0]).toMatch(/no \{TOKEN\} placeholders/);
  });

  it('rejects empty template', () => {
    expect(parseTemplate('').valid).toBe(false);
  });

  it('rejects template with leading literal', () => {
    const t = parseTemplate('prefix-{LANG}-{CHANNEL}');
    expect(t.valid).toBe(false);
    expect(t.errors[0]).toMatch(/leading literal/);
  });

  it('rejects template with trailing literal', () => {
    const t = parseTemplate('{LANG}-{CHANNEL}-suffix');
    expect(t.valid).toBe(false);
    expect(t.errors[0]).toMatch(/trailing literal/);
  });

  it('rejects template with empty separator between tokens', () => {
    const t = parseTemplate('{LANG}{CHANNEL}');
    expect(t.valid).toBe(false);
    expect(t.errors.some(e => /empty separator/.test(e))).toBe(true);
  });
});

describe('validateName', () => {
  const template = parseTemplate('{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}');

  it('accepts a fully-compliant name', () => {
    const r = validateName('DE-Search-Schraubenzieher-Exact', template, { languages: ['de', 'fr'] });
    expect(r.valid).toBe(true);
    expect(r.parts).toEqual({
      LANG: 'DE', CHANNEL: 'Search', THEME: 'Schraubenzieher', MATCHTYPE: 'Exact',
    });
  });

  it('rejects unknown CHANNEL value', () => {
    const r = validateName('DE-Sucht-Theme-Exact', template);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/CHANNEL="Sucht"/);
  });

  it('rejects unknown MATCHTYPE value', () => {
    const r = validateName('DE-Search-Theme-Wide', template);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/MATCHTYPE="Wide"/);
  });

  it('rejects LANG outside customer profile languages', () => {
    const r = validateName('IT-Search-Theme-Exact', template, { languages: ['de', 'fr'] });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/LANG="IT" not in customer languages/);
  });

  it('rejects LANG that is not 2-letter ISO', () => {
    const r = validateName('DEU-Search-Theme-Exact', template);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/LANG="DEU" must be a 2-letter ISO code/);
  });

  it('rejects name with structural mismatch (wrong number of tokens)', () => {
    const r = validateName('DE-Search-Theme', template);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/does not match template structure/);
  });

  it('rejects name with separator characters inside token', () => {
    // Hyphen inside theme token should fail.
    const r = validateName('DE-Search-Multi-Word-Theme-Exact', template);
    expect(r.valid).toBe(false);
  });

  it('accepts THEME as free-form', () => {
    const r = validateName('DE-Search-AnyArbitraryThemeName-Exact', template);
    expect(r.valid).toBe(true);
    expect(r.parts?.THEME).toBe('AnyArbitraryThemeName');
  });

  it('validates BRAND token against customer ownBrands', () => {
    const t = parseTemplate('{LANG}-{CHANNEL}-{BRAND}-{MATCHTYPE}');
    const ok = validateName('DE-Search-Acme-Exact', t, { ownBrands: ['Acme', 'WidgetCo'] });
    expect(ok.valid).toBe(true);
    const fail = validateName('DE-Search-Stranger-Exact', t, { ownBrands: ['Acme'] });
    expect(fail.valid).toBe(false);
    expect(fail.errors[0]).toMatch(/BRAND="Stranger"/);
  });

  it('skips BRAND validation when ownBrands not provided', () => {
    const t = parseTemplate('{LANG}-{CHANNEL}-{BRAND}-{MATCHTYPE}');
    const r = validateName('DE-Search-AnyBrand-Exact', t);
    expect(r.valid).toBe(true);
  });

  it('validates REGION when regions provided', () => {
    const t = parseTemplate('{REGION}-{CHANNEL}-{THEME}-{MATCHTYPE}');
    const ok = validateName('CH-Search-Theme-Exact', t, { regions: ['CH', 'DE', 'AT'] });
    expect(ok.valid).toBe(true);
    const fail = validateName('FR-Search-Theme-Exact', t, { regions: ['CH', 'DE', 'AT'] });
    expect(fail.valid).toBe(false);
  });

  it('accepts custom token names as free-form', () => {
    const t = parseTemplate('{LANG}-{CUSTOMER_TIER}-{THEME}');
    const r = validateName('DE-Premium-Theme', t);
    expect(r.valid).toBe(true);
    expect(r.parts?.['CUSTOMER_TIER']).toBe('Premium');
  });

  it('returns template-level error when template invalid', () => {
    const t = parseTemplate('no-placeholders');
    const r = validateName('any-name', t);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/template invalid/);
  });
});

describe('checkName (parse + validate convenience)', () => {
  it('passes through to parseTemplate + validateName', () => {
    const r = checkName('DE-Search-Brand-Exact', '{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}');
    expect(r.valid).toBe(true);
  });

  it('reports template error for invalid template', () => {
    const r = checkName('any', 'no-placeholders');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/template invalid/);
  });
});
