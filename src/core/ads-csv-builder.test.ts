import { describe, it, expect } from 'vitest';
import {
  EDITOR_COLUMNS,
  renderHeader, renderRow, renderCsvBody,
  encodeUtf16LeWithBom,
  buildCampaignRow, buildAdGroupRow, buildKeywordRow, buildRsaRow,
  buildSitelinkRow, buildCalloutRow, buildNegativeRow,
  buildAssetGroupRow, buildAssetRow, buildAudienceSignalRow, buildListingGroupRow,
  slugifyCampaignName,
} from './ads-csv-builder.js';

const COL_INDEX: Record<string, number> = Object.fromEntries(
  EDITOR_COLUMNS.map((n, i) => [n, i]),
);

describe('EDITOR_COLUMNS', () => {
  it('has exactly 183 columns', () => {
    expect(EDITOR_COLUMNS.length).toBe(183);
  });

  it('starts with Campaign and contains the documented PMAX columns', () => {
    expect(EDITOR_COLUMNS[0]).toBe('Campaign');
    expect(EDITOR_COLUMNS).toContain('Asset Group');
    expect(EDITOR_COLUMNS).toContain('Audience signal');
    expect(EDITOR_COLUMNS).toContain('Long headline 1');
    expect(EDITOR_COLUMNS).toContain('Asset name');
    expect(EDITOR_COLUMNS).toContain('Product Group');
  });
});

describe('renderHeader / renderCsvBody', () => {
  it('renders header as TAB-separated 183 columns', () => {
    const header = renderHeader();
    expect(header.split('\t')).toHaveLength(183);
  });

  it('uses CRLF line endings and trailing CRLF', () => {
    const body = renderCsvBody([buildCampaignRow({ campaignName: 'C1' })]);
    expect(body.endsWith('\r\n')).toBe(true);
    expect(body.split('\r\n').length).toBe(3); // header, 1 row, trailing empty
  });

  it('every row has exactly 183 fields', () => {
    const row = buildKeywordRow({
      campaignName: 'C', adGroupName: 'AG', keyword: 'foo', matchType: 'Exact',
    });
    expect(renderRow(row).split('\t')).toHaveLength(183);
  });

  it('sanitises in-field tabs and CRLFs to spaces', () => {
    const row = buildCampaignRow({ campaignName: 'Has\tA Tab\nIn It' });
    expect(row[COL_INDEX['Campaign']!]).toBe('Has A Tab In It');
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
    expect(bytes[2]).toBe(0x41);
    expect(bytes[3]).toBe(0x00);
    expect(bytes[4]).toBe(0x42);
    expect(bytes[5]).toBe(0x00);
  });

  it('encodes umlauts (BMP) correctly', () => {
    const bytes = encodeUtf16LeWithBom('ä');
    expect(bytes[2]).toBe(0xe4);
    expect(bytes[3]).toBe(0x00);
  });

  it('byte length: 2 (BOM) + body * 2', () => {
    const body = 'hello';
    expect(encodeUtf16LeWithBom(body).length).toBe(2 + body.length * 2);
  });
});

describe('Search row builders', () => {
  it('buildCampaignRow defaults to Search + Paused', () => {
    const r = buildCampaignRow({ campaignName: 'C1' });
    expect(r[COL_INDEX['Campaign']!]).toBe('C1');
    expect(r[COL_INDEX['Campaign Type']!]).toBe('Search');
    expect(r[COL_INDEX['Campaign Status']!]).toBe('Paused');
    expect(r[COL_INDEX['Networks']!]).toBe('Google search;Search Partners');
    expect(r[COL_INDEX['Languages']!]).toBe('de');
    expect(r[COL_INDEX['Bid Strategy Type']!]).toBe('Maximize conversions');
    expect(r[COL_INDEX['EU political ads']!]).toBe("Doesn't have EU political ads");
  });

  it('buildCampaignRow with Performance Max + tROAS', () => {
    const r = buildCampaignRow({
      campaignName: 'PMAX-1', campaignType: 'Performance Max',
      bidStrategy: 'Maximize conversion value', targetRoas: 4.5, status: 'Enabled',
    });
    expect(r[COL_INDEX['Campaign Type']!]).toBe('Performance Max');
    expect(r[COL_INDEX['Bid Strategy Type']!]).toBe('Maximize conversion value');
    expect(r[COL_INDEX['Target ROAS']!]).toBe('4.5');
    expect(r[COL_INDEX['Campaign Status']!]).toBe('Enabled');
  });

  it('buildAdGroupRow', () => {
    const r = buildAdGroupRow({ campaignName: 'C', adGroupName: 'AG', maxCpc: 1.25 });
    expect(r[COL_INDEX['Campaign']!]).toBe('C');
    expect(r[COL_INDEX['Ad Group']!]).toBe('AG');
    expect(r[COL_INDEX['Ad Group Status']!]).toBe('Enabled');
    expect(r[COL_INDEX['Max CPC']!]).toBe('1.25');
  });

  it('buildKeywordRow with optional Final URL', () => {
    const r = buildKeywordRow({
      campaignName: 'C', adGroupName: 'AG', keyword: 'foo', matchType: 'Phrase',
      finalUrl: 'https://example.com',
    });
    expect(r[COL_INDEX['Keyword']!]).toBe('foo');
    expect(r[COL_INDEX['Criterion Type']!]).toBe('Phrase');
    expect(r[COL_INDEX['Final URL']!]).toBe('https://example.com');
  });

  it('buildRsaRow places headlines/descriptions in their indexed columns', () => {
    const r = buildRsaRow({
      campaignName: 'C', adGroupName: 'AG',
      headlines: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'],
      descriptions: ['D1', 'D2', 'D3'],
      finalUrl: 'https://example.com', path1: 'shop',
    });
    expect(r[COL_INDEX['Headline 1']!]).toBe('H1');
    expect(r[COL_INDEX['Headline 6']!]).toBe('H6');
    expect(r[COL_INDEX['Headline 7']!]).toBe('');
    expect(r[COL_INDEX['Description 1']!]).toBe('D1');
    expect(r[COL_INDEX['Description 3']!]).toBe('D3');
    expect(r[COL_INDEX['Path 1']!]).toBe('shop');
    expect(r[COL_INDEX['Final URL']!]).toBe('https://example.com');
  });

  it('buildRsaRow caps at 15 headlines / 5 descriptions', () => {
    const r = buildRsaRow({
      campaignName: 'C', adGroupName: 'AG',
      headlines: Array.from({ length: 20 }, (_, i) => `H${i + 1}`),
      descriptions: Array.from({ length: 8 }, (_, i) => `D${i + 1}`),
      finalUrl: 'https://example.com',
    });
    expect(r[COL_INDEX['Headline 15']!]).toBe('H15');
    expect(r[COL_INDEX['Description 5']!]).toBe('D5');
  });

  it('buildSitelinkRow', () => {
    const r = buildSitelinkRow({
      campaignName: 'C', text: 'Shop now', desc1: 'Free shipping',
      desc2: '24h delivery', url: 'https://example.com/shop',
    });
    expect(r[COL_INDEX['Link Text']!]).toBe('Shop now');
    expect(r[COL_INDEX['Description Line 1']!]).toBe('Free shipping');
    expect(r[COL_INDEX['Final URL']!]).toBe('https://example.com/shop');
  });

  it('buildCalloutRow', () => {
    const r = buildCalloutRow({ campaignName: 'C', text: 'Free returns' });
    expect(r[COL_INDEX['Callout text']!]).toBe('Free returns');
  });

  it('buildNegativeRow normalises bare match-type to "Campaign Negative …"', () => {
    const r = buildNegativeRow({ campaignName: 'C', keyword: 'gizmo', matchType: 'Exact' });
    expect(r[COL_INDEX['Criterion Type']!]).toBe('Campaign Negative Exact');
    expect(r[COL_INDEX['Keyword']!]).toBe('gizmo');
  });

  it('buildNegativeRow accepts already-prefixed match-types', () => {
    const r = buildNegativeRow({
      campaignName: 'C', keyword: 'gizmo', matchType: 'Campaign Negative Phrase',
    });
    expect(r[COL_INDEX['Criterion Type']!]).toBe('Campaign Negative Phrase');
  });

  it('buildNegativeRow with no campaign produces account-level row', () => {
    const r = buildNegativeRow({ keyword: 'drills', matchType: 'Broad' });
    expect(r[COL_INDEX['Campaign']!]).toBe('');
    expect(r[COL_INDEX['Keyword']!]).toBe('drills');
  });
});

describe('PMAX row builders', () => {
  it('buildAssetGroupRow', () => {
    const r = buildAssetGroupRow({
      campaignName: 'PMAX-1', assetGroupName: 'AG-Drills',
      finalUrl: 'https://example.com/drills',
    });
    expect(r[COL_INDEX['Asset Group']!]).toBe('AG-Drills');
    expect(r[COL_INDEX['Final URL']!]).toBe('https://example.com/drills');
    expect(r[COL_INDEX['Asset Group Status']!]).toBe('Paused');
  });

  it('buildAssetRow places HEADLINE in indexed slot', () => {
    const r = buildAssetRow({
      campaignName: 'PMAX-1', assetGroupName: 'AG-Drills',
      fieldType: 'HEADLINE', index: 3, text: 'Beste Bohrer',
    });
    expect(r[COL_INDEX['Headline 3']!]).toBe('Beste Bohrer');
    expect(r[COL_INDEX['Headline 1']!]).toBe('');
  });

  it('buildAssetRow places LONG_HEADLINE in slot 1-5', () => {
    const r = buildAssetRow({
      campaignName: 'PMAX-1', assetGroupName: 'AG-Drills',
      fieldType: 'LONG_HEADLINE', index: 2, text: 'Premium Bohrer ab CHF 49',
    });
    expect(r[COL_INDEX['Long headline 2']!]).toBe('Premium Bohrer ab CHF 49');
  });

  it('buildAssetRow BUSINESS_NAME / CALL_TO_ACTION', () => {
    const a = buildAssetRow({
      campaignName: 'PMAX', assetGroupName: 'G', fieldType: 'BUSINESS_NAME', text: 'Acme',
    });
    expect(a[COL_INDEX['Business name']!]).toBe('Acme');
    const b = buildAssetRow({
      campaignName: 'PMAX', assetGroupName: 'G', fieldType: 'CALL_TO_ACTION', text: 'Jetzt kaufen',
    });
    expect(b[COL_INDEX['Call to action']!]).toBe('Jetzt kaufen');
  });

  it('buildAssetRow IMAGE uses Asset name field', () => {
    const r = buildAssetRow({
      campaignName: 'PMAX', assetGroupName: 'G', fieldType: 'IMAGE',
      assetName: 'hero-1200x628.jpg',
    });
    expect(r[COL_INDEX['Asset name']!]).toBe('hero-1200x628.jpg');
  });

  it('buildAssetRow VIDEO indexed in Video ID 1-5', () => {
    const r = buildAssetRow({
      campaignName: 'PMAX', assetGroupName: 'G', fieldType: 'VIDEO',
      index: 4, videoId: 'abc123',
    });
    expect(r[COL_INDEX['Video ID 4']!]).toBe('abc123');
  });

  it('buildAssetRow clamps invalid index into range', () => {
    const r = buildAssetRow({
      campaignName: 'PMAX', assetGroupName: 'G',
      fieldType: 'HEADLINE', index: 99, text: 'h',
    });
    expect(r[COL_INDEX['Headline 15']!]).toBe('h');
  });

  it('buildAudienceSignalRow', () => {
    const r = buildAudienceSignalRow({
      campaignName: 'PMAX-1', assetGroupName: 'AG-Drills',
      audienceName: 'DIY Heimwerker',
      interestCategories: 'Werkzeuge;Heimwerken',
      customAudienceSegments: 'aud_diy_de',
    });
    expect(r[COL_INDEX['Audience name']!]).toBe('DIY Heimwerker');
    expect(r[COL_INDEX['Audience signal']!]).toBe('DIY Heimwerker');
    expect(r[COL_INDEX['Interest categories']!]).toBe('Werkzeuge;Heimwerken');
    expect(r[COL_INDEX['Custom audience segments']!]).toBe('aud_diy_de');
  });

  it('buildListingGroupRow', () => {
    const r = buildListingGroupRow({
      campaignName: 'PMAX-Shop', assetGroupName: 'AG-Drills',
      productGroup: 'All products', productGroupType: 'UNIT', bidModifier: 1.2,
    });
    expect(r[COL_INDEX['Product Group']!]).toBe('All products');
    expect(r[COL_INDEX['Product Group Type']!]).toBe('UNIT');
    expect(r[COL_INDEX['Bid Modifier']!]).toBe('1.2');
  });
});

describe('slugifyCampaignName', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugifyCampaignName('DE-Search-Brand-Exact')).toBe('de-search-brand-exact');
    expect(slugifyCampaignName('Search & Display 2026')).toBe('search-display-2026');
  });
  it('trims edge hyphens and caps at 80 chars', () => {
    expect(slugifyCampaignName('---weird---')).toBe('weird');
    expect(slugifyCampaignName('x'.repeat(200))).toHaveLength(80);
  });
  it('falls back to "unnamed"', () => {
    expect(slugifyCampaignName('___')).toBe('unnamed');
    expect(slugifyCampaignName('')).toBe('unnamed');
  });
});
