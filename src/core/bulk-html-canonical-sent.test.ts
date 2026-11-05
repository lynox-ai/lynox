import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, type BeforeImage } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { judgeTemplate, normalizeJudgeRule } from './bulk-judge-rule.js';
import { runBulkJudge, verdictTextRefusal, type BulkJudgeDeps } from './bulk-judge.js';
import { checkMarkup, droppedTagsOf, shortcodeChangedBy, shortcodeRefusalOf, shortcodeTextOf } from './bulk-html.js';
import { canonicalHtml } from './html-tree.js';
import { formatStatus } from '../tools/builtin/bulk.js';
import { rawHtmlField, runBulkEffect, type TargetWriter } from './bulk-apply.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// The belt of 1130: an HTML field is stored, and so sent, in the canonical bytes the markup check
// reads, never the planner's or the verdict's raw bytes; the send refuses raw bytes it finds.

const HOST = 'shop.example.com';
const LIST = `https://${HOST}/wp-json/wc/v3/products`;
const readContract: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
  hostPatterns: [HOST], pathPatterns: ['/wp-json/wc/v3/products'], paramConstraints: {},
};
const rule = normalizeJudgeRule({ rule: 'Rewrite the description.', schema: { description: { type: 'string', maxLength: 2000 } } }, { idField: 'id' });

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-canonical-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A WooCommerce list run with product 1 listed and its reads started; `judged` plans a judge. */
function listed(after: Record<string, unknown>, judged = false, judgeRule = rule): { id: string; seq: number } {
  const source = parseListSource(HOST, { path: '/wp-json/wc/v3/products', after: judged ? judgeTemplate(judgeRule) : after }, 'PUT', () => null);
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract, ...(judged ? { judge: judgeRule } : {}) });
  if (!out.ok) throw new Error(out.reason);
  const id = out.status.id;
  if (!ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! }).ok) throw new Error('list start');
  ledger.recordListPage(id, { page: 1, items: [{ key: `${LIST}/1`, id: '1' }], bytes: 1 });
  ledger.finishList(id, (keys) => mintBulkContract(HOST, keys, 'PUT'));
  const reads = judged
    ? ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 2 })
    : ledger.resumePreview(id);
  if (!reads.ok) throw new Error('reads not started');
  const [seq] = ledger.listUnread(id);
  if (seq === undefined) throw new Error('no target');
  return { id, seq };
}

/** The after-state the ledger stored for a run's only target. */
function storedAfter(id: string): Record<string, unknown> {
  const row = engineDb.getDb().prepare('SELECT after_planned FROM bulk_targets WHERE run_id = ?').get(id) as { after_planned: string };
  return JSON.parse(engineDb.dec(row.after_planned)) as Record<string, unknown>;
}

describe('the ledger stores an HTML field in its canonical bytes (1130)', () => {
  it('stores a planned description canonical when the read records it', () => {
    const { id, seq } = listed({ description: '<p>a<br/>b &#8211; c</p>' });
    expect(ledger.recordRead(id, seq, { before: { description: '<p>x</p>' } })).toBe(true);
    expect(storedAfter(id)['description']).toBe('<p>a<br>b – c</p>');
  });

  it('stores a verdict\'s description canonical, so the stretch the check held never reaches the shop', () => {
    const { id, seq } = listed({}, true);
    const before = '<body class="z"><p>a</p>';
    expect(ledger.recordRead(id, seq, { before: { description: before } })).toBe(true);
    const verdict = '<p>neu<br/>Text</p><body class="z">';
    // The check holds the stretch the before-image carries, because what is sent is canonical.
    expect(checkMarkup({ before, after: verdict, storeHost: HOST, startDomains: [] }).ok).toBe(true);
    expect(ledger.claimJudge(id, seq, 'tok', Date.now(), 60_000)).toBe(true);
    expect(ledger.recordJudgement(id, seq, 'tok', { after: { description: verdict } })).toBe(true);
    const stored = storedAfter(id)['description'] as string;
    expect(stored).toBe('<p>neu<br>Text</p>');
    expect(droppedTagsOf(stored)).toEqual([]);
  });

  it('keeps a description equal to its before-image byte for byte, so an unchanged field is no write', () => {
    const raw = '<p>a<br/>b</p>';
    const { id, seq } = listed({ description: raw });
    expect(ledger.recordRead(id, seq, { before: { description: raw } })).toBe(true);
    expect(storedAfter(id)['description']).toBe(raw);
    expect(ledger.getPreview(id)[0]?.change).toBe('unchanged');
  });

  it('keeps a verdict equal to its before-image byte for byte', () => {
    const { id, seq } = listed({}, true);
    const raw = '<p>a<br/>b</p>';
    expect(ledger.recordRead(id, seq, { before: { description: raw } })).toBe(true);
    expect(ledger.claimJudge(id, seq, 'tok', Date.now(), 60_000)).toBe(true);
    expect(ledger.recordJudgement(id, seq, 'tok', { after: { description: raw } })).toBe(true);
    expect(storedAfter(id)['description']).toBe(raw);
  });

  it('stores a value whose canonical form is not stable raw, so the send refuses it', () => {
    // `<pre>` with a leading blank line loses one line per round trip: a canonical form that
    // changes again would show the shop something the check never read.
    const raw = '<pre>\n\nCode</pre>';
    const { id, seq } = listed({ description: raw });
    expect(ledger.recordRead(id, seq, { before: { description: '<p>x</p>' } })).toBe(true);
    expect(storedAfter(id)['description']).toBe(raw);
    expect(rawHtmlField({ after: { absent: false, value: storedAfter(id) }, expected: { absent: false, value: { description: '<p>x</p>' } } }, ['description'])).toBe('description');
  });

  it('CONTROL: leaves a field the list form does not name HTML as it is', () => {
    const { id, seq } = listed({ name: 'a<br/>b' });
    expect(ledger.recordRead(id, seq, { before: { name: 'x' } })).toBe(true);
    expect(storedAfter(id)['name']).toBe('a<br/>b');
  });
});

describe('a shortcode the canonical form would change is refused, not rewritten (1130, U-103)', () => {
  const check = (after: string, before: string | null = null) => checkMarkup({ before, after, storeHost: HOST, startDomains: [] });
  it('refuses &, < and > in a shortcode\'s attributes and in what it encloses, naming the shortcode', () => {
    expect(check('<p>[button url="/a?x=1&y=2"]Kaufen[/button]</p>')).toEqual({ ok: false, reason: 'shortcode_changed', detail: 'Writing would change the shortcode text: [button url="/a?x=1&y=2"]' });
    expect(check('[x a="b>c"]')).toMatchObject({ ok: false, reason: 'shortcode_changed' });
    expect(check('[x a="1 < 2"]')).toMatchObject({ ok: false, reason: 'shortcode_changed' });
    expect(check('[embed]https://youtu.be/abc?t=1&list=x[/embed]')).toMatchObject({ ok: false, reason: 'shortcode_changed' });
    expect(shortcodeChangedBy('[embed]a&b[/embed]', canonicalHtml('[embed]a&b[/embed]'))).toBe('a&b');
  });

  it('refuses shortcodes whose names or attributes WordPress allows beyond letters and words', () => {
    // A digit, `_`, `:` or `.` in the name, `=` right after it, a `[` in an attribute, an enclosing
    // pair with such a name: each one the canonical form changes, and each was let through before.
    for (const after of ['[3d-gallery title="A & B"]', '[_x a="1&2"]', '[ns:code a="a&b"]', '[a.b a="&"]', '[x="A&B"]', '[x a="[&"]', '[ns:box]a&b[/ns:box]']) {
      expect(canonicalHtml(after), `${after}: the canonical form changes it`).not.toBe(after);
      expect(check(after), after).toMatchObject({ ok: false, reason: 'shortcode_changed' });
    }
    // The CDATA opener's brackets are passed over, a shortcode of its own inside the section is not.
    const inCdata = '<svg><![CDATA[ [x a="&"] ]]></svg>';
    expect(canonicalHtml(inCdata)).not.toBe(inCdata);
    // (`checkMarkup` refuses the section itself first, as markup the page drops.)
    expect(shortcodeRefusalOf(inCdata, null)).toBe('Writing would change the shortcode text: [x a="&"]');
    expect(shortcodeRefusalOf('<svg><![CDATA[ x ]]></svg>', null), 'the opener alone is no shortcode').toBeNull();
  });

  it('passes a shortcode the canonical form keeps, and HTML tags that read the same inside one', () => {
    expect(check('<p>[product_page id="99"]</p>')).toEqual({ ok: true });
    // A shortcode the field already holds, references and all, is the owner's own.
    const own = '[button url="/a?x=1&amp;y=2"]Kaufen[/button]';
    expect(check(`<p>neu</p>${own}`, own)).toEqual({ ok: true });
    // `<br/>` becomes `<br>` inside the pair: the enclosed text reads the same.
    expect(check('[note]a<br/>b[/note]')).toEqual({ ok: true });
    // CONTROL: an & outside any shortcode is HTML text, and becomes &amp; harmlessly.
    expect(check('<p>Salz & Pfeffer</p>')).toEqual({ ok: true });
  });

  it('refuses a character reference written into a shortcode by hand, which the shop reads literally', () => {
    expect(check('[button url="/a?x=1&amp;y=2"]Kaufen[/button]')).toEqual({ ok: false, reason: 'shortcode_changed',
      detail: 'The shortcode spells a character as a reference the shop reads literally: [button url="/a?x=1&amp;y=2"]' });
    expect(check('[x a="1&#38;2"]')).toMatchObject({ ok: false, reason: 'shortcode_changed' });
    expect(check('[embed]a&#x26;b[/embed]')).toMatchObject({ ok: false, reason: 'shortcode_changed' });
    // Held once, written twice: the second copy is the value's own.
    const own = '[x a="1&amp;2"]';
    expect(check(`${own}${own}`, own)).toMatchObject({ ok: false, reason: 'shortcode_changed' });
    // CONTROL: a reference in HTML text outside any shortcode is ordinary HTML.
    expect(check('<p>Salz &amp; Pfeffer</p>')).toEqual({ ok: true });
  });

  it('refuses no field the run leaves as it is, though its shortcode carries an &', () => {
    const raw = '[button url="/a?x=1&y=2"]Kaufen[/button]';
    const { id, seq } = listed({ description: raw });
    expect(ledger.recordRead(id, seq, { before: { description: raw } })).toBe(true);
    expect(ledger.getPreview(id)[0]?.change).toBe('unchanged');
  });

  it('records the refusal the preview finds, and tells the model the way out', () => {
    const after = { description: '[button url="/a?x=1&y=2"]Neu[/button]' };
    const { form } = parseListSource(HOST, { path: '/wp-json/wc/v3/products', after }, 'PUT', () => null);
    // The preview's rule for a planner's after-state (bulk-preview.ts `planMarkupRefusal`).
    const reason = verdictTextRefusal(after, { description: '<p>x</p>' }, { listForm: form, storeHost: HOST, startDomains: [] });
    expect(reason).toBe('shortcode_changed');
    const { id, seq } = listed(after);
    expect(ledger.recordRead(id, seq, { invalid: reason! })).toBe(true);
    const status = ledger.getStatus(id)!;
    expect(status.invalidReasons).toEqual({ shortcode_changed: 1 });
    const note = formatStatus(status);
    // The wording ux released (U-103, version after the third eval), word for word.
    expect(note).toContain('shortcode_changed: the new text has a [shortcode] containing &, < or > that lynox cannot write. '
      + 'The preview shows the owner the whole new text exactly as planned, to copy into the shop themselves. Tell the owner that. '
      + 'Do not put the text, the shortcode or a changed form of it in your reply, and do not offer another way out. '
      + 'Only where you wrote these characters yourself, plan the value again without them.');
    // …and the preview does show it: the whole planned value of the field the refusal is about.
    const shown = ledger.getPreview(id).find((p) => p.seq === seq)!;
    expect(shown.refusedValues).toEqual([{ field: 'description', value: after.description }]);
  });

  it('CONTROL: a target refused for another reason carries no value to copy', () => {
    const { id, seq } = listed({ description: '[button url="/a?x=1&y=2"]Neu[/button]' });
    expect(ledger.recordRead(id, seq, { invalid: 'markup_dropped' })).toBe(true);
    expect(ledger.getPreview(id).find((p) => p.seq === seq)!.refusedValues).toBeUndefined();
  });
});

describe('a judged run refused for shortcode_changed shows the judge\'s value to copy (1130)', () => {
  const both = normalizeJudgeRule({ rule: 'Rewrite both descriptions.', schema: {
    description: { type: 'string', maxLength: 2000 }, short_description: { type: 'string', maxLength: 2000 },
  } }, { idField: 'id' });
  // A shortcode the description already holds, a reference and all: the owner's own, not refused.
  const own = '[button url="/a?x=1&amp;y=2"]Kaufen[/button]';
  const before = { description: `<p>alt</p>${own}`, short_description: '<p>kurz</p>' };
  const verdict = { description: `<p>neu</p>${own}`, short_description: '[pbutton url="/b?x=1&y=2"]Los[/pbutton]' };

  /** Judge the run's one target with a stub model that answers `after`; `over` replaces deps. */
  async function judge(after: Record<string, unknown>, over: Partial<BulkJudgeDeps> = {}, read: Record<string, unknown> = before): Promise<{ id: string; seq: number }> {
    const { id, seq } = listed({}, true, both);
    expect(ledger.recordRead(id, seq, { before: read })).toBe(true);
    const call = (async () => ({ data: { keep: false, after }, inputTokens: 1, outputTokens: 1, costUsd: 0.001, modelId: 'claude-haiku-4-5' })) as unknown as BulkJudgeDeps['call'];
    await runBulkJudge(id, {
      ledger, call,
      resolveModel: (tier) => ({ tier, modelId: 'claude-haiku-4-5', client: {} as never }),
      gate: async () => ({ runId: 'g', blockedReason: null }),
      report: () => {}, bookSpend: () => {}, budgetAllows: () => true,
      scanSecret: (t) => (t.includes('sk-live-') ? 'api_key' : null), maskVault: (t) => t,
      ...over,
    });
    return { id, seq };
  }

  it('shows only the field the check refuses, not the one whose shortcode the field already holds', async () => {
    expect(verdictTextRefusal(verdict, before, { listForm: 'woocommerce', storeHost: HOST, startDomains: [] })).toBe('shortcode_changed');
    const { id, seq } = await judge(verdict);
    const shown = ledger.getPreview(id).find((p) => p.seq === seq)!;
    expect([shown.change, shown.error]).toEqual(['invalid', 'shortcode_changed']);
    expect(shown.refusedValues).toEqual([{ field: 'short_description', value: verdict.short_description }]);
  });

  it('shows no field the verdict leaves as it is, though its own shortcode would be refused', async () => {
    // The description holds a raw-& shortcode the canonical form would change; the verdict leaves it.
    const raw = { description: '<p>alt</p>[x a="1&2"]', short_description: '<p>kurz</p>' };
    expect(shortcodeRefusalOf(raw.description, raw.description)).not.toBeNull();
    const kept = { description: raw.description, short_description: verdict.short_description };
    const { id, seq } = await judge(kept, {}, raw);
    expect(ledger.getPreview(id).find((p) => p.seq === seq)!.refusedValues).toEqual([{ field: 'short_description', value: verdict.short_description }]);
  });

  it('shows each field the check refuses when both are', async () => {
    const twice = { description: '[box a="1&2"]x[/box]', short_description: verdict.short_description };
    const { id, seq } = await judge(twice);
    expect(ledger.getPreview(id).find((p) => p.seq === seq)!.refusedValues).toEqual([
      { field: 'description', value: twice.description }, { field: 'short_description', value: twice.short_description },
    ]);
  });

  it('records a credential among the values as that, with nothing to show', async () => {
    const secret = await judge({ ...verdict, short_description: '[pbutton url="/b?k=sk-live-1&y=2"]Los[/pbutton]' });
    const s = ledger.getPreview(secret.id).find((p) => p.seq === secret.seq)!;
    expect([s.error, s.refusedValues]).toEqual(['secret_in_after', undefined]);
  });

  it('records a vault value among the values as a credential, with nothing to show', async () => {
    const vaulted = await judge(verdict, { maskVault: (t) => t.replace('/b?x=1', '***') });
    const v = ledger.getPreview(vaulted.id).find((p) => p.seq === vaulted.seq)!;
    expect([v.error, v.refusedValues]).toEqual(['secret_in_after', undefined]);
  });

  it('records the reason an external run refuses the values as a write for, with nothing to show', async () => {
    const { id, seq } = await judge({ ...verdict, extra: { nested: true } });
    const shown = ledger.getPreview(id).find((p) => p.seq === seq)!;
    expect([shown.error, shown.refusedValues]).toEqual(['field_not_scalar', undefined]);
  });

  it('stores the judge\'s values with a shortcode_changed refusal only, never with another reason', () => {
    const { id, seq } = listed({}, true, both);
    expect(ledger.recordRead(id, seq, { before })).toBe(true);
    expect(ledger.claimJudge(id, seq, 'tok', Date.now(), 60_000)).toBe(true);
    expect(ledger.recordJudgement(id, seq, 'tok', { invalid: 'new_link_domain', refused: verdict })).toBe(true);
    // The template the run was planned with, every field null: the refused values are not stored.
    expect(storedAfter(id)).toEqual({ description: null, short_description: null });
  });

  it('CONTROL: the same values are stored with a shortcode_changed refusal', () => {
    const { id, seq } = listed({}, true, both);
    expect(ledger.recordRead(id, seq, { before })).toBe(true);
    expect(ledger.claimJudge(id, seq, 'tok', Date.now(), 60_000)).toBe(true);
    expect(ledger.recordJudgement(id, seq, 'tok', { invalid: 'shortcode_changed', refused: verdict })).toBe(true);
    expect(storedAfter(id)).toEqual(verdict);
  });

  it('CONTROL: a verdict refused for another reason keeps no value either', async () => {
    const { id, seq } = await judge({ ...verdict, short_description: '<p>neu <a href="https://evil.example/x">x</a></p>' });
    const shown = ledger.getPreview(id).find((p) => p.seq === seq)!;
    expect([shown.error, shown.refusedValues]).toEqual(['new_link_domain', undefined]);
  });

  describe('the domain of a refused link (1010)', () => {
    const linked = (href: string): Record<string, unknown> => ({ ...before, short_description: `<p>neu <a href="${href}">x</a></p>` });
    const shownOf = (r: { id: string; seq: number }) => ledger.getPreview(r.id).find((p) => p.seq === r.seq)!;
    const aws = (t: string): string | null => (/AKIA[A-Z0-9]{16}/.test(t) ? 'aws' : null);

    it('names the domain the judge\'s link points to', async () => {
      const shown = shownOf(await judge(linked('https://evil.example/x')));
      expect([shown.error, shown.linkDomain]).toEqual(['new_link_domain', 'evil.example']);
    });

    it('names an internationalised domain in Punycode as it is written', async () => {
      expect(shownOf(await judge(linked('https://xn--pple-43d.example/'))).linkDomain).toBe('xn--pple-43d.example');
    });

    it('keeps no domain the value spells only in Unicode or percent-encoded: its decoded form was never scanned as written', async () => {
      // A Cyrillic а before „pple“: `new URL` reads it as xn--pple-43d.example, which the value does not spell.
      expect(shownOf(await judge(linked('https://\u0430pple.example/'))).linkDomain).toBeUndefined();
    });

    it('keeps no domain the value spells only percent-encoded', async () => {
      const shown = shownOf(await judge(linked('https://ev%69l.example/x')));
      expect([shown.error, shown.linkDomain]).toEqual(['new_link_domain', undefined]);
    });

    it('names a domain the value spells in another case, as the check read it (twin)', async () => {
      expect(shownOf(await judge(linked('https://Evil.Example/x'), { scanSecret: aws })).linkDomain).toBe('evil.example');
    });

    it('keeps no domain whose spelling holds a credential that lower case would hide', async () => {
      // An AWS key is upper case; the host as `new URL` reads it is not, and passes the same scanner.
      expect(aws('akiaiosfodnn7example.evil.example')).toBeNull();
      // Built at run time, so no key-shaped literal sits in the source.
      const key = `AKIA${'IOSFODNN7EXAMPLE'}`;
      const shown = shownOf(await judge(linked(`https://${key}.evil.example/`), { scanSecret: aws }));
      expect([shown.error, shown.linkDomain]).toEqual(['new_link_domain', undefined]);
    });

    it('keeps no domain whose spelling holds a vault value that lower case would hide', async () => {
      const vault = (t: string): string => t.replaceAll('MyToken42', '***');
      expect(vault('mytoken42.evil.example')).toBe('mytoken42.evil.example');
      const shown = shownOf(await judge(linked('https://MyToken42.evil.example/'), { maskVault: vault }));
      expect([shown.error, shown.linkDomain]).toEqual(['new_link_domain', undefined]);
    });

    it('keeps a long host whole, past the 200 characters a refusal\'s detail is cut at', async () => {
      const host = `${Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.')}.example`;
      expect(host.length).toBeGreaterThan(200);
      expect(shownOf(await judge(linked(`https://${host}/`))).linkDomain).toBe(host);
    });

    it('keeps no domain that holds a vault value', async () => {
      const vaulted = shownOf(await judge(linked('https://evil.example/x'), { maskVault: (t) => t.replace('evil.example', '***') }));
      expect([vaulted.error, vaulted.linkDomain]).toEqual(['new_link_domain', undefined]);
    });

    it('keeps no domain shaped like a credential', async () => {
      const secret = shownOf(await judge(linked('https://sk-live-abc.evil.example/x')));
      expect([secret.error, secret.linkDomain]).toEqual(['new_link_domain', undefined]);
    });

    it('stores a domain only with new_link_domain, whatever a caller hands in', () => {
      const { id, seq } = listed({}, true, both);
      expect(ledger.recordRead(id, seq, { before })).toBe(true);
      expect(ledger.claimJudge(id, seq, 'tok', Date.now(), 60_000)).toBe(true);
      expect(ledger.recordJudgement(id, seq, 'tok', { invalid: 'url_scheme', linkDomain: 'evil.example' })).toBe(true);
      expect(shownOf({ id, seq })).toMatchObject({ error: 'url_scheme' });
      expect(shownOf({ id, seq }).linkDomain).toBeUndefined();
      // Not stored either: the column stays empty.
      const cell = engineDb.getDb().prepare('SELECT link_domain FROM bulk_targets WHERE run_id = ? AND seq = ?').get(id, seq) as { link_domain: string | null };
      expect(cell.link_domain).toBeNull();
    });

    it('stores a domain from a read only with new_link_domain, whatever a caller hands in', () => {
      const { id, seq } = listed({ short_description: '<p>neu</p>' });
      expect(ledger.recordRead(id, seq, { invalid: 'url_scheme', linkDomain: 'evil.example' })).toBe(true);
      expect(shownOf({ id, seq })).toMatchObject({ error: 'url_scheme' });
      const cell = engineDb.getDb().prepare('SELECT link_domain FROM bulk_targets WHERE run_id = ? AND seq = ?').get(id, seq) as { link_domain: string | null };
      expect(cell.link_domain).toBeNull();
    });

    it('shows no stored domain once the target holds another reason, or none', async () => {
      const r = await judge(linked('https://evil.example/x'));
      expect(shownOf(r).linkDomain).toBe('evil.example');
      // A resume clears a target's error and leaves its other cells (bulk-ledger resume, `SET
      // error = NULL`); the domain of the old reason is then not shown with the new one.
      for (const error of [null, 'read_failed']) {
        engineDb.getDb().prepare('UPDATE bulk_targets SET error = ? WHERE run_id = ? AND seq = ?').run(error, r.id, r.seq);
        expect(shownOf(r).linkDomain, String(error)).toBeUndefined();
      }
    });
  });

  it('refuses a value for its link, script or hidden character before its shortcode, so none is offered to paste', () => {
    const sc = '[box a="1&2"]x[/box]';
    const at = (after: string): string => {
      const r = checkMarkup({ before: '<p>kurz</p>', after, storeHost: HOST, startDomains: [] });
      return r.ok ? 'ok' : r.reason;
    };
    expect(at(sc)).toBe('shortcode_changed');
    expect(at(`${sc}<p><a href="https://evil.example/x">x</a></p>`)).toBe('new_link_domain');
    expect(at(`${sc}<script>x()</script>`)).toBe('element_not_allowed');
    expect(at(`<p>a‮b</p>${sc}`)).toBe('hidden_char');
    // Across fields: the other field's reason wins, whichever field comes first.
    const run = { listForm: 'woocommerce' as const, storeHost: HOST, startDomains: [] as string[] };
    expect(verdictTextRefusal({ description: sc, short_description: '<p><a href="https://evil.example/x">x</a></p>' }, before, run)).toBe('new_link_domain');
    expect(verdictTextRefusal({ description: sc, short_description: '<p>neu</p>' }, before, run)).toBe('shortcode_changed');
  });
});

describe('the shortcode scans read what the patterns read, in linear time (1130)', () => {
  // The patterns the scans replace, kept here as their specification.
  const TAG = /(?<!<!|<!\[CDATA)\[[^\]]*\]/g;
  const PAIR = /(?<!<!|<!\[CDATA)\[([^\s[\]/=<>&"']+)[^\]]*\]([\s\S]*?)\[\/\1\]/g;
  const byPatterns = (value: string, pair = PAIR, tag = TAG): string[] => [
    ...(value.match(tag) ?? []),
    ...[...value.matchAll(pair)].map((m) => (m[2] ?? '').replace(/<[^<>]*>/g, '')),
  ];
  const PIECES = ['[', ']', '[/', '/', 'a', 'b', 'ab', 'a:b', ' ', '=', '"', '&', '<', '>', '<b>', '<!', 'CDATA', '<![CDATA[', ']]>',
    '[a]', '[ab x="1"]', '[/a]', '[/ab]', '[/a:b]', '\u{1F600}', 'é'];
  /** mulberry32: a seeded generator whose output is spread over [0, 1). */
  const rng = (seed: number): (() => number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const values = (n: number): string[] => {
    const next = rng(1130);
    return Array.from({ length: n }, () => Array.from({ length: 1 + Math.floor(next() * 14) }, () => PIECES[Math.floor(next() * PIECES.length)]!).join(''));
  };

  it('reads every generated value as the patterns do', () => {
    const differ = values(20_000).filter((v) => JSON.stringify(shortcodeTextOf(v)) !== JSON.stringify(byPatterns(v)));
    expect(differ.slice(0, 5)).toEqual([]);
  });

  it('CONTROL: the same values tell a pattern apart that pairs only a whole name, or reads a CDATA bracket', () => {
    const wholeName = /(?<!<!|<!\[CDATA)\[([^\s[\]/=<>&"']+)(?![^\s[\]/=<>&"'])[^\]]*\]([\s\S]*?)\[\/\1\]/g;
    const noCdata = /\[[^\]]*\]/g;
    const vs = values(20_000);
    expect(vs.some((v) => JSON.stringify(byPatterns(v)) !== JSON.stringify(byPatterns(v, wholeName)))).toBe(true);
    expect(vs.some((v) => JSON.stringify(byPatterns(v)) !== JSON.stringify(byPatterns(v, PAIR, noCdata)))).toBe(true);
  });

  it('reads a value of many brackets without a closing one in linear time', () => {
    for (const value of ['['.repeat(200_000), '[a'.repeat(100_000), '[/'.repeat(100_000) + ']', '<![CDATA['.repeat(20_000) + ']', `[${'a'.repeat(100_000)}]` + '[/'.repeat(200_000) + ']', `[${'a'.repeat(100_000)}]`.repeat(2) + '[/a]'.repeat(1000)]) {
      const start = performance.now();
      shortcodeTextOf(value);
      expect(performance.now() - start, `${value.slice(0, 12)}… of ${value.length}`).toBeLessThan(1500);
    }
  });
});

describe('rawHtmlField: the send takes only canonical bytes (1130)', () => {
  const img = (value: Record<string, unknown>): BeforeImage => ({ absent: false, value });
  it('names an HTML field in raw bytes that is not its before-image', () => {
    expect(rawHtmlField({ after: img({ description: '<p>a<br/>b</p>' }), expected: img({ description: '<p>x</p>' }) }, ['description'])).toBe('description');
  });
  it('passes canonical bytes, a field equal to its before-image, and a run with no HTML field', () => {
    expect(rawHtmlField({ after: img({ description: '<p>a<br>b</p>' }), expected: img({ description: '<p>x</p>' }) }, ['description'])).toBeNull();
    expect(rawHtmlField({ after: img({ description: '<p>a<br/>b</p>' }), expected: img({ description: '<p>a<br/>b</p>' }) }, ['description'])).toBeNull();
    expect(rawHtmlField({ after: img({ description: '<p>a<br/>b</p>' }), expected: img({ description: '<p>x</p>' }) }, [])).toBeNull();
  });
});

describe('a write sends what the ledger stored, and never raw HTML (1130)', () => {
  /** A one-target WooCommerce run, read and approved; `legacy` stores raw bytes as a row from before the belt would. */
  function approved(after: string, legacy: boolean, before = '<p>x</p>'): string {
    const { id, seq } = listed({ description: after });
    if (!ledger.recordRead(id, seq, { before: { description: before } })) throw new Error('read');
    if (legacy) {
      engineDb.getDb().prepare('UPDATE bulk_targets SET after_planned = ? WHERE run_id = ?').run(engineDb.enc(JSON.stringify({ description: after })), id);
    }
    if (!ledger.finishPreview(id)) throw new Error('preview not finished');
    const ok = ledger.approve(id, { checksum: ledger.computeChecksum(id)! });
    if (!ok.ok) throw new Error(ok.reason);
    return id;
  }

  function shop(before = '<p>x</p>'): { writer: TargetWriter; sent: unknown[] } {
    const sent: unknown[] = [];
    let held: Record<string, unknown> = { description: before };
    const writer: TargetWriter = {
      async read() { return { absent: false, value: held }; },
      async write(_key, after) {
        if (!after.absent) { sent.push(after.value); held = after.value as Record<string, unknown>; }
        return 'written';
      },
    };
    return { writer, sent };
  }

  it('sends the canonical bytes the check read', async () => {
    const runId = approved('<p>a<br/>b</p>', false);
    const s = shop();
    await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: () => s.writer });
    expect(s.sent).toEqual([{ description: '<p>a<br>b</p>' }]);
  });

  it('sends nothing for a row holding raw bytes, and halts the run', async () => {
    const runId = approved('<p>a<br/>b</p>', true);
    const s = shop();
    await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: () => s.writer });
    expect(s.sent).toEqual([]);
    expect(ledger.getStatus(runId)?.haltReason).toBe(BULK_HALT_REASONS.contract);
  });

  it('lets an undo send the store\'s own raw bytes back: it restores a before-image', async () => {
    const own = '<p>x<br/>y</p>';
    const runId = approved('<p>a<br/>b</p>', false, own);
    const s = shop(own);
    await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: () => s.writer });
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
    const out = await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: () => s.writer });
    expect(out.status).toBe('done');
    expect(s.sent).toEqual([{ description: '<p>a<br>b</p>' }, { description: own }]);
  });
});
