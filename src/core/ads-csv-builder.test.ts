import { describe, it, expect } from 'vitest';
import {
  renderCsvBody, encodeUtf16LeWithBom,
  buildCampaignSettingsRow, buildAdGroupRow, buildKeywordRow, buildNegativeKeywordRow,
  slugifyCampaignName, EDITOR_COLUMNS,
} from './ads-csv-builder.js';

describe('renderCsvBody', () => {
  it('writes the header row first', () => {
    const body = renderCsvBody([]);
    const headerLine = body.split('\r\n')[0];
    expect(headerLine).toBe(EDITOR_COLUMNS.join('\t'));
  });

  it('uses TAB separators and CRLF line endings', () => {
    const body = renderCsvBody([
      buildKeywordRow({ campaignName: 'C1', adGroupName: 'AG1', keyword: 'foo', matchType: 'Exact', status: 'Paused', action: 'Add' }),
    ]);
    expect(body).toContain('\t');
    expect(body).toContain('\r\n');
    expect(body.split('\r\n')).toHaveLength(3); // header, row, trailing empty
  });

  it('renders each row in the locked column order', () => {
    const row = buildKeywordRow({
      campaignName: 'C1', adGroupName: 'AG1', keyword: 'foo',
      matchType: 'Phrase', finalUrl: 'https://example.com', status: 'Paused', action: 'Add',
    });
    const body = renderCsvBody([row]);
    const dataLine = body.split('\r\n')[1]!;
    const fields = dataLine.split('\t');
    expect(fields).toHaveLength(EDITOR_COLUMNS.length);
    expect(fields[0]).toBe('Add');
    expect(fields[1]).toBe('C1');
    expect(fields[2]).toBe('AG1');
    expect(fields[3]).toBe('Keyword');
    expect(fields[4]).toBe('Paused');
    expect(fields[5]).toBe('foo');
    expect(fields[6]).toBe('Phrase');
    expect(fields[7]).toBe('https://example.com');
  });

  it('sanitises in-field tabs and CRLFs to spaces', () => {
    const row = buildKeywordRow({
      campaignName: 'C\twith tab', adGroupName: 'AG', keyword: 'foo\nbar',
      matchType: 'Exact', status: 'Paused', action: 'Add',
    });
    const body = renderCsvBody([row]);
    const fields = body.split('\r\n')[1]!.split('\t');
    expect(fields[1]).toBe('C with tab');
    expect(fields[5]).toBe('foo bar');
  });
});

describe('encodeUtf16LeWithBom', () => {
  it('starts with the BOM 0xFF 0xFE', () => {
    const bytes = encodeUtf16LeWithBom('A');
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
  });

  it('encodes ASCII as 2 bytes per char little-endian', () => {
    const bytes = encodeUtf16LeWithBom('AB');
    // After BOM: 'A' = 0x41 0x00, 'B' = 0x42 0x00
    expect(bytes[2]).toBe(0x41);
    expect(bytes[3]).toBe(0x00);
    expect(bytes[4]).toBe(0x42);
    expect(bytes[5]).toBe(0x00);
  });

  it('encodes umlauts correctly (BMP code points)', () => {
    const bytes = encodeUtf16LeWithBom('ä');
    // 'ä' = U+00E4 → bytes 0xE4 0x00 in LE
    expect(bytes[2]).toBe(0xe4);
    expect(bytes[3]).toBe(0x00);
  });

  it('round-trips body length: BOM (2) + body * 2', () => {
    const body = 'hello';
    expect(encodeUtf16LeWithBom(body).length).toBe(2 + body.length * 2);
  });
});

describe('row builders', () => {
  it('buildCampaignSettingsRow defaults to Status=Paused', () => {
    const r = buildCampaignSettingsRow({ campaignName: 'C1' });
    expect(r.Action).toBe('Edit');
    expect(r.Status).toBe('Paused');
    expect(r.Type).toBe('Campaign');
  });

  it('buildKeywordRow includes optional FinalUrl', () => {
    const r = buildKeywordRow({
      campaignName: 'C1', adGroupName: 'AG', keyword: 'foo', matchType: 'Exact',
      status: 'Paused', action: 'Add',
    });
    expect(r.FinalUrl).toBeUndefined();
    const r2 = buildKeywordRow({
      campaignName: 'C1', adGroupName: 'AG', keyword: 'foo', matchType: 'Exact',
      finalUrl: 'https://example.com', status: 'Paused', action: 'Add',
    });
    expect(r2.FinalUrl).toBe('https://example.com');
  });

  it('buildNegativeKeywordRow handles account-level negatives (no campaign)', () => {
    const r = buildNegativeKeywordRow({ keyword: 'drills', matchType: 'Exact' });
    expect(r.Type).toBe('Negative keyword');
    expect(r.Campaign).toBe('');
    expect(r.AdGroup).toBe('');
  });

  it('buildAdGroupRow allows Add or Edit action', () => {
    const r = buildAdGroupRow({ campaignName: 'C', adGroupName: 'AG', status: 'Paused', action: 'Add' });
    expect(r.Action).toBe('Add');
    const r2 = buildAdGroupRow({ campaignName: 'C', adGroupName: 'AG', status: 'Enabled', action: 'Edit' });
    expect(r2.Action).toBe('Edit');
  });
});

describe('slugifyCampaignName', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugifyCampaignName('DE-Search-Brand-Exact')).toBe('de-search-brand-exact');
    expect(slugifyCampaignName('Search & Display 2026')).toBe('search-display-2026');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugifyCampaignName('---weird---')).toBe('weird');
  });

  it('caps at 80 characters', () => {
    const long = 'x'.repeat(200);
    expect(slugifyCampaignName(long)).toHaveLength(80);
  });

  it('falls back to "unnamed" for empty input', () => {
    expect(slugifyCampaignName('___')).toBe('unnamed');
    expect(slugifyCampaignName('')).toBe('unnamed');
  });
});
