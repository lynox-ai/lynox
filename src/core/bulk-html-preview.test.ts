import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// The approval view's list of added and removed markup: computed by the ledger, per HTML field
// of an `update` target, from the parser's tree (PRD shopify-preset §20.2 item 5, M3).

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
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-html-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A WooCommerce list run with one product read, its after-state planned as `after`. */
function previewOne(after: Record<string, unknown>, before: Record<string, unknown>): string {
  const source = parseListSource(HOST, { path: '/wp-json/wc/v3/products', after }, 'PUT', () => null);
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract });
  if (!out.ok) throw new Error(out.reason);
  const id = out.status.id;
  const started = ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! });
  if (!started.ok) throw new Error(started.reason);
  ledger.recordListPage(id, { page: 1, items: [{ key: `${LIST}/1`, id: '1' }], bytes: 1 });
  ledger.finishList(id, (keys) => mintBulkContract(HOST, keys, 'PUT'));
  if (!ledger.resumePreview(id).ok) throw new Error('reads not started');
  const [seq] = ledger.listUnread(id);
  if (seq === undefined || !ledger.recordRead(id, seq, { before })) throw new Error('read not recorded');
  return id;
}

describe('getPreview: markupChanges', () => {
  it('names the link an HTML field adds and the image it removes, with full values', () => {
    const id = previewOne(
      { description: '<p>Neu <a href="https://partner.example/p?q=1">mehr</a></p>', status: 'publish' },
      { description: '<p>Alt</p><img src="https://shop.example.com/a.jpg">', status: 'draft' },
    );
    const [t] = ledger.getPreview(id);
    expect(t!.change).toBe('update');
    expect(t!.markupChanges).toEqual([{
      field: 'description',
      added: [{ kind: 'element', namespace: 'html', element: 'a', attributes: [['href', 'https://partner.example/p?q=1']], text: null, inTemplate: false }],
      removed: [{ kind: 'element', namespace: 'html', element: 'img', attributes: [['src', 'https://shop.example.com/a.jpg']], text: null, inTemplate: false }],
    }]);
  });

  it('reads only the fields the list form declares as HTML', () => {
    const id = previewOne(
      { short_description: '<p>x</p><!-- c -->', name: '<b class="k">Shirt</b>' },
      { short_description: '<p>x</p>', name: 'Shirt' },
    );
    const [t] = ledger.getPreview(id);
    expect(t!.markupChanges).toEqual([
      { field: 'short_description', added: [{ kind: 'comment', namespace: '', element: '', attributes: [], text: ' c ', inTemplate: false }], removed: [] },
    ]);
  });

  it('carries no list where the HTML field adds and removes nothing worth naming', () => {
    const id = previewOne({ description: '<p>Neu</p><p>Text</p>' }, { description: '<p>Alt</p>' });
    const [t] = ledger.getPreview(id);
    expect(t!.change).toBe('update');
    expect(t!.markupChanges).toBeUndefined();
  });
});
