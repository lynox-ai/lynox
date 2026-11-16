import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { hiddenAddsOf, targetHiddenAdds } from './bulk-hidden-adds.js';
import { IN_PLACE_CHARS, inPlaceReferences } from './hidden-chars.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// Hidden characters a target adds where real text may carry one, and the page would not show
// them: counted per field and code point against the before-image.

const SHY = 0x00ad;
const ZWNJ = 0x200c;
const VS16 = 0xfe0f;

describe('hiddenAddsOf', () => {
  it('names no code point a field holds as often as before, nor one it holds less often', () => {
    expect(hiddenAddsOf('Ketab\u200cha', 'Ketab\u200cha neu')).toEqual([]);
    expect(hiddenAddsOf('Was\u00adser\u00adfilter', 'Wasser\u00adfilter')).toEqual([]);
  });

  it('names a code point the field holds once more than before', () => {
    expect(hiddenAddsOf('Ketab\u200cha', 'Ketab\u200cha\u200cye')).toEqual([ZWNJ]);
    expect(hiddenAddsOf(null, 'Wasser\u00adfilter')).toEqual([SHY]);
  });

  it('counts an emoji\'s presentation selector and joiner, inside a valid sequence too', () => {
    expect(hiddenAddsOf('Wasserfilter', 'Wasserfilter ❤\ufe0f')).toEqual([VS16]);
    expect(hiddenAddsOf('Team', 'Team \u{1F468}\u200d\u{1F469}\u200d\u{1F467}')).toEqual([0x200d]);
  });

  it('takes each character of the class and no other', () => {
    for (const cp of IN_PLACE_CHARS) expect(hiddenAddsOf('a', `a${String.fromCodePoint(cp)}b`), cp.toString(16)).toEqual([cp]);
    // A zero-width space is never in place: the page shows it as its code point already.
    expect(hiddenAddsOf('a', 'a\u200bb')).toEqual([]);
    expect([...IN_PLACE_CHARS].sort((a, b) => a - b)).toEqual([0x00ad, 0x061c, 0x200c, 0x200d, 0x200e, 0x200f, 0xfe0f]);
  });
});

// In HTML a character reference turns into the character on the store's page; the source shows
// it as text. checkMarkup reads the parsed tree, so it takes `&shy;` between letters as it takes
// the character: the count has to as well.
describe('character references in an HTML field', () => {
  it('finds every form a browser reads as one of the characters, and no other', () => {
    const text = 'a&shy;b a&#173;b a&#xAD;b a&#XaD;b a&#0173;b a&#xad b a&shyb a&zwnj;b a&zwj;b a&lrm;b a&rlm;b a&#8203;b a&amp;b a&ZWNJ;b'
      + ' a&#00000000000173;b a&#x0000000000AD;b';
    expect(inPlaceReferences(text).map((r) => [text.slice(r.start, r.end), r.cp])).toEqual([
      ['&shy;', 0x00ad], ['&#173;', 0x00ad], ['&#xAD;', 0x00ad], ['&#XaD;', 0x00ad], ['&#0173;', 0x00ad], ['&#xad', 0x00ad], ['&shy', 0x00ad],
      ['&zwnj;', 0x200c], ['&zwj;', 0x200d], ['&lrm;', 0x200e], ['&rlm;', 0x200f],
      // Leading zeros in any number, as a browser reads them.
      ['&#00000000000173;', 0x00ad], ['&#x0000000000AD;', 0x00ad],
    ]);
  });

  it('counts a reference with the characters in an HTML field, and not in a plain one', () => {
    expect(hiddenAddsOf('<p>Wasserfilter</p>', '<p>Wasser&shy;filter</p>', true)).toEqual([SHY]);
    expect(hiddenAddsOf('Wasserfilter', 'Wasser&shy;filter')).toEqual([]);
    // The character and its reference are the same on the page: one for the other adds nothing.
    expect(hiddenAddsOf('<p>Wasser\u00adfilter</p>', '<p>Wasser&shy;filter</p>', true)).toEqual([]);
    expect(hiddenAddsOf('<p>Wasserfilter</p>', '<p>Wasser&#00000000000173;filter</p>', true)).toEqual([SHY]);
  });

  // Counted as the parser reads the value, as checkMarkup counts it: a reference a browser leaves as
  // it is holds no character, so it does not stand in for one the after-state adds.
  it('counts no reference the parser leaves as it is', () => {
    // `&shy` before `=` in an attribute is not a reference, and a comment is not decoded.
    expect(hiddenAddsOf('<a href="/x?q=1&shy=2">Mehr</a><p>Wasserfilter</p>', '<a href="/x?q=1&amp;shy=2">Mehr</a><p>Wasser\u00adfilter</p>', true)).toEqual([SHY]);
    expect(hiddenAddsOf('<!-- &shy; --><p>Wasserfilter</p>', '<p>Wasser\u00adfilter</p>', true)).toEqual([SHY]);
  });

  it('names an HTML field as such, for the page to mark its references', () => {
    expect(targetHiddenAdds({ description: '<p>a</p>', name: 'a' }, { description: '<p>Wa&shy;sser</p>', name: 'Wa&shy;sser' }, ['description']))
      .toEqual([{ field: 'description', codePoints: [SHY], html: true }]);
  });
});

describe('targetHiddenAdds', () => {
  it('names each text field that adds one, and a target whose value is one text', () => {
    expect(targetHiddenAdds({ name: 'Mug', description: '<p>Alt</p>' }, { name: 'Mug', description: '<p>Wasser\u00adfilter</p>', stock: 3 }))
      .toEqual([{ field: 'description', codePoints: [SHY] }]);
    expect(targetHiddenAdds('Ketab', 'Ke\u00adtab')).toEqual([{ field: '', codePoints: [SHY] }]);
    expect(targetHiddenAdds({ name: 'Ke\u00adtab' }, { name: 'Ke\u00adtab blau' })).toEqual([]);
  });

  // A field that is not text shows as its JSON, which writes these characters as they are: a
  // string nested in an object is counted too.
  it('counts a string nested in an object or a list by the JSON the page shows', () => {
    expect(targetHiddenAdds({ meta: { note: 'Ketab' } }, { meta: { note: 'Ke\u200ctab' } })).toEqual([{ field: 'meta', codePoints: [0x200c] }]);
    expect(targetHiddenAdds(['Ketab'], ['Ke\u200ctab'])).toEqual([{ field: '', codePoints: [0x200c] }]);
    expect(targetHiddenAdds({ meta: { note: 'Ke\u200ctab' } }, { meta: { note: 'Ke\u200ctab', n: 2 } })).toEqual([]);
  });
});

const HOST = 'shop.example.com';
const LIST = `https://${HOST}/wp-json/wc/v3/products`;
const readContract: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
  hostPatterns: [HOST], pathPatterns: ['/wp-json/wc/v3/products'], paramConstraints: {},
};

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-hidden-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A WooCommerce list run, one product per before-image, each planned with `after`. */
function previewed(after: Record<string, unknown>, befores: Record<string, unknown>[]): string {
  const source = parseListSource(HOST, { path: '/wp-json/wc/v3/products', after }, 'PUT', () => null);
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract });
  if (!out.ok) throw new Error(out.reason);
  const id = out.status.id;
  const started = ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! });
  if (!started.ok) throw new Error(started.reason);
  ledger.recordListPage(id, { page: 1, items: befores.map((_, i) => ({ key: `${LIST}/${i + 1}`, id: String(i + 1) })), bytes: 1 });
  ledger.finishList(id, (keys) => mintBulkContract(HOST, keys, 'PUT'));
  if (!ledger.resumePreview(id).ok) throw new Error('reads not started');
  ledger.listUnread(id).forEach((seq, i) => {
    if (!ledger.recordRead(id, seq, { before: befores[i]! })) throw new Error('read not recorded');
  });
  if (!ledger.finishPreview(id)) throw new Error('preview not finished');
  return id;
}

describe('the preview and the run\'s count', () => {
  it('names in the preview the soft hyphen an HTML description adds, and counts the target', () => {
    const id = previewed({ description: '<p>Wasser\u00adfilter</p>' }, [{ description: '<p>Wasserfilter</p>' }]);
    const [t] = ledger.getPreview(id);
    expect(t!.change).toBe('update');
    expect(t!.hiddenAdds).toEqual([{ field: 'description', codePoints: [SHY], html: true }]);
    // The value itself is the one planned: a mark is the page's, never part of what is written.
    expect((t!.after as Record<string, unknown>)['description']).toBe('<p>Wasser\u00adfilter</p>');
    expect(ledger.hiddenAddsTargets(id)).toBe(1);
  });

  it('counts only the targets that add one, and none the owner took out', () => {
    const id = previewed({ name: 'Ketab\u200cha\u200cye' }, [{ name: 'Ketab\u200cha' }, { name: 'Ketab\u200cha\u200cye' }, { name: 'Ketab' }]);
    const preview = ledger.getPreview(id);
    expect(preview.map((t) => t.hiddenAdds ?? null)).toEqual([
      [{ field: 'name', codePoints: [ZWNJ] }], null, [{ field: 'name', codePoints: [ZWNJ] }],
    ]);
    expect(ledger.hiddenAddsTargets(id)).toBe(2);
    expect(ledger.deselectTarget(id, preview[2]!.seq, { checksum: ledger.computeChecksum(id)! })).toMatchObject({ ok: true });
    expect(ledger.hiddenAddsTargets(id)).toBe(1);
  });

  // A target the run creates holds no before-image: every such character counts as added. Planted
  // as a data-store plan holds it; a list run creates nothing.
  it('names and counts a hidden character a created target holds', () => {
    const id = previewed({ name: 'Ke\u200ctab' }, [{ name: 'Ketab' }]);
    engineDb.getDb().prepare(`UPDATE bulk_targets SET change = 'create', before = ? WHERE run_id = ?`)
      .run(engineDb.enc(JSON.stringify({ absent: true })), id);
    expect(ledger.getPreview(id)[0]).toMatchObject({ change: 'create', hiddenAdds: [{ field: 'name', codePoints: [0x200c] }] });
    expect(ledger.hiddenAddsTargets(id)).toBe(1);
  });

  // A list run stores its planned HTML in canonical form, which writes `&shy;` as the character;
  // a before-image read from the store keeps the source as the store sent it.
  it('stores a planned reference as the character, and counts one the before-image held as a reference as held', () => {
    const id = previewed({ description: '<p>Wasser&shy;filter blau</p>' }, [{ description: '<p>Wasser&shy;filter</p>' }]);
    const [t] = ledger.getPreview(id);
    expect((t!.after as Record<string, unknown>)['description']).toBe('<p>Wasser\u00adfilter blau</p>');
    expect(t!.hiddenAdds).toBeUndefined();
    expect(ledger.hiddenAddsTargets(id)).toBe(0);
  });

  // An after-state that keeps the reference as written, planted as a value the canonical form did
  // not pass through would hold it: counted and named all the same.
  it('names and counts a soft hyphen an HTML description adds as its reference', () => {
    const id = previewed({ description: '<p>Wasser filter</p>' }, [{ description: '<p>Wasserfilter</p>' }]);
    engineDb.getDb().prepare('UPDATE bulk_targets SET after_planned = ? WHERE run_id = ?')
      .run(engineDb.enc(JSON.stringify({ description: '<p>Wasser&shy;filter</p>' })), id);
    expect(ledger.getPreview(id)[0]).toMatchObject({ change: 'update', hiddenAdds: [{ field: 'description', codePoints: [SHY], html: true }] });
    expect(ledger.hiddenAddsTargets(id)).toBe(1);
  });

  it('counts past a page of the preview', () => {
    const befores = Array.from({ length: 501 }, () => ({ name: 'Ketab' }));
    const id = previewed({ name: 'Ke\u200ctab' }, befores);
    expect(ledger.hiddenAddsTargets(id)).toBe(501);
  });
});
