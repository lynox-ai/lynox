import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withinReadingBounds, MARKUP_MAX_DEPTH } from './html-tree.js';
import { EngineDb } from './engine-db.js';
import { BulkLedger, sameValue } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { rawHtmlField } from './bulk-apply.js';
import { judgeContext } from './bulk-judge.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// Every path that parses or walks a value a shop, a plan or a model wrote asks the reading bounds
// first, and a value beyond them takes the strict side: compared byte for byte, left as it is, or
// held back. Values just beyond the depth bound stand in for every value beyond a bound: they are
// cheap to parse, so each test sees the path's answer, not its cost.

const range = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('');
/** `n` nested elements around a text, with an unquoted attribute the parser writes quoted. */
const unquoted = (n: number): string => '<span class=k>'.repeat(n) + 'x' + '</span>'.repeat(n);
const quoted = (n: number): string => '<span class="k">'.repeat(n) + 'x' + '</span>'.repeat(n);
const DEEP = MARKUP_MAX_DEPTH + 10;

describe('the bounds read off the bytes, before the parse', () => {
  it('ends at the tag bound, counting every start, end, comment and declaration', () => {
    expect(withinReadingBounds('<br>'.repeat(10), { tags: 10 })).toBe(true);
    expect(withinReadingBounds('<br>'.repeat(11), { tags: 10 })).toBe(false);
    expect(withinReadingBounds('<p>x</p><!-- c --><?x>', { tags: 4 })).toBe(true);
    expect(withinReadingBounds('<p>x</p><!-- c --><?x>', { tags: 3 })).toBe(false);
    expect(withinReadingBounds('<p>x</p><!-- c --><!x>', { tags: 3 })).toBe(false);
  });

  it('does not count a < the parser reads as text', () => {
    expect(withinReadingBounds('a < b, 1 <2 '.repeat(50), { tags: 0 })).toBe(true);
  });

  it('ends at the attribute bound of one tag, a quoted value read whole', () => {
    expect(withinReadingBounds('<p a b c>x</p>', { attributesPerTag: 3 })).toBe(true);
    expect(withinReadingBounds('<p a b c d>x</p>', { attributesPerTag: 3 })).toBe(false);
    expect(withinReadingBounds('<p a="x y z" b=\'u v\' c=w>x</p>', { attributesPerTag: 3 })).toBe(true);
    expect(withinReadingBounds('<p a="x y z" b=\'u v\' c=w d>x</p>', { attributesPerTag: 3 })).toBe(false);
  });

  it('holds the defaults far above the descriptions shops write', () => {
    expect(withinReadingBounds(range(600, (i) => `<p class="c${i}">Text ${i}</p>`))).toBe(true);
  });
});

describe('the bounds the parse keeps while it runs', () => {
  it('ends at the attribute bound where the parser gathers attributes onto one element', () => {
    // Each tag carries one attribute; the parser moves them all onto one element.
    expect(withinReadingBounds(range(5, (i) => `<html a${i}>`), { attributesPerTag: 5 })).toBe(true);
    expect(withinReadingBounds(range(6, (i) => `<html a${i}>`), { attributesPerTag: 5 })).toBe(false);
  });

  it('ends at the depth bound', () => {
    expect(withinReadingBounds('<b>'.repeat(10) + 'x', { depth: 11 })).toBe(true);
    expect(withinReadingBounds('<b>'.repeat(11) + 'x', { depth: 11 })).toBe(false);
  });

  it('stops a parse at the depth bound, not after it has built the whole tree', () => {
    const v = range(4000, (i) => `<b a${i}>`);
    const fastest = (depth: number): number => Math.min(...[0, 1, 2].map(() => {
      const start = performance.now();
      withinReadingBounds(v, { depth });
      return performance.now() - start;
    }));
    // The same value under a small and a large depth bound: a parse that runs to its end costs
    // the same under both. Compared to each other, so a slow machine does not change the answer.
    expect(fastest(10)).toBeLessThan(fastest(1e9) / 5);
  });
});

describe('a value beyond the reading bounds takes the strict side on every path', () => {
  it('sameValue compares it byte for byte', () => {
    expect(sameValue({ d: unquoted(10) }, { d: quoted(10) }, ['d'])).toBe(true);
    expect(sameValue({ d: unquoted(DEEP) }, { d: quoted(DEEP) }, ['d'])).toBe(false);
    expect(sameValue({ d: quoted(DEEP) }, { d: quoted(DEEP) }, ['d'])).toBe(true);
  });

  it('rawHtmlField names it as not canonical', () => {
    const target = (v: string) => ({ after: { absent: false, value: { d: v } }, expected: { absent: false, value: { d: '<p>x</p>' } } });
    expect(rawHtmlField(target(quoted(10)), ['d'])).toBeNull();
    expect(rawHtmlField(target(quoted(DEEP)), ['d'])).toBe('d');
  });

  it('judgeContext holds a context with markup beyond them back, as one it cannot read', () => {
    const check = { scanSecret: () => null, maskVault: (t: string) => t };
    expect(judgeContext({ d: quoted(10) }, ['d'], check)).toHaveProperty('context');
    expect(judgeContext({ d: quoted(DEEP) }, ['d'], check)).toEqual({ secretField: 0 });
    expect(judgeContext({ d: 'Text ohne Markup. '.repeat(5000) }, ['d'], check)).toHaveProperty('context');
  });
});

describe('the ledger leaves a value beyond the reading bounds as it is', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-parse-paths-'));
    engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
    ledger = new BulkLedger(engineDb, null);
  });
  afterEach(() => {
    engineDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function listed(after: Record<string, unknown>): { id: string; seq: number } {
    const source = parseListSource(HOST, { path: '/wp-json/wc/v3/products', after }, 'PUT', () => null);
    const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract });
    if (!out.ok) throw new Error(out.reason);
    const id = out.status.id;
    if (!ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! }).ok) throw new Error('list start');
    ledger.recordListPage(id, { page: 1, items: [{ key: `${LIST}/1`, id: '1' }], bytes: 1 });
    ledger.finishList(id, (keys) => mintBulkContract(HOST, keys, 'PUT'));
    if (!ledger.resumePreview(id).ok) throw new Error('reads not started');
    const [seq] = ledger.listUnread(id);
    if (seq === undefined) throw new Error('no target');
    return { id, seq };
  }
  const storedAfter = (id: string): Record<string, unknown> => {
    const row = engineDb.getDb().prepare('SELECT after_planned FROM bulk_targets WHERE run_id = ?').get(id) as { after_planned: string };
    return JSON.parse(engineDb.dec(row.after_planned)) as Record<string, unknown>;
  };

  it('CONTROL: stores a planned value within them in its canonical form', () => {
    const near = listed({ description: unquoted(10) });
    expect(ledger.recordRead(near.id, near.seq, { before: { description: '<p>x</p>' } })).toBe(true);
    expect(storedAfter(near.id)['description']).toBe(quoted(10));
  });

  it('stores a planned value beyond them in its own bytes, not in a canonical form', () => {
    const deep = listed({ description: unquoted(DEEP) });
    expect(ledger.recordRead(deep.id, deep.seq, { before: { description: '<p>x</p>' } })).toBe(true);
    expect(storedAfter(deep.id)['description']).toBe(unquoted(DEEP));
  });

  it('offers no value beyond them to copy for a shortcode, the check refusing it for its size', () => {
    const value = '[button url="/a?x=1&y=2"]Neu[/button]' + quoted(DEEP);
    const { id, seq } = listed({ description: value });
    expect(ledger.recordRead(id, seq, { invalid: 'shortcode_changed' })).toBe(true);
    expect(ledger.getPreview(id).find((p) => p.seq === seq)!.refusedValues ?? []).toEqual([]);
  });

  it('CONTROL: offers the same shortcode within them to copy', () => {
    const value = '[button url="/a?x=1&y=2"]Neu[/button]' + quoted(10);
    const { id, seq } = listed({ description: value });
    expect(ledger.recordRead(id, seq, { invalid: 'shortcode_changed' })).toBe(true);
    expect(ledger.getPreview(id).find((p) => p.seq === seq)!.refusedValues).toEqual([{ field: 'description', value }]);
  });
});
