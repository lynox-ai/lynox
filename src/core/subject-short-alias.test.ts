/**
 * Short-form organisation aliases — `Nordfeld` must reach `Nordfeld GmbH`.
 *
 * Measured on a live engine 2026-08-05: the model called `recall({subject: "Nordfeld"})` — the
 * argument the DK prompt tells it to pass — against a store that HELD the fact, and the store
 * answered "no matching durable knowledge". Passing the subject was strictly WORSE than omitting
 * it, because an unresolved explicit subject correctly refuses rather than falling back to a
 * global scan.
 *
 * THE SHAPE, and why it is an alias rather than a matcher. A first attempt (core#1133) added a
 * legal-form-insensitive MATCHER at the two recall surfaces. It needed its own vocabulary, a
 * second narrower vocabulary for scanning prose, a synonym map for `Ltd`/`Limited`, and a
 * collision counter that had to agree with a third function's owner scope — and three review
 * rounds found 8, 5 and 5 defects, two of them re-opened by the round that fixed the previous.
 * Registering the short form as an ALIAS at creation deletes all four mechanisms:
 *
 *   - resolution     → `findByAliasResolved`, which already exists and already returns
 *                      `{row, ambiguous, ids}`; two clients sharing a short form refuse by
 *                      the contract the store already keeps, with no new guard.
 *   - the focus scan → `_mentions` already reads `subj.aliases`; no change at all.
 *   - `Ltd`/`Limited` → never compared: both yield the short form `Talbach`.
 *   - a caller who
 *     names a DIFFERENT
 *     legal form      → `Nordfeld AG` matches neither the canonical name nor the alias
 *                      `Nordfeld`. Structurally impossible rather than guarded against —
 *                      that exact case was the cross-client bleed in the first attempt.
 *
 * This mirrors what the ENGAGEMENT kind has done since the start (`findOrCreateEngagement`
 * stores the normalised name and keeps the surface form as an alias), which is why "Aurora"
 * resolved in the same live session and "Nordfeld" did not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore, organisationShortForm, backfillOrganisationShortAliases } from './subject-store.js';

describe('organisationShortForm', () => {
  it('strips a trailing legal form', () => {
    expect(organisationShortForm('Nordfeld GmbH')).toBe('Nordfeld');
    expect(organisationShortForm('Talbach AG')).toBe('Talbach');
    expect(organisationShortForm('Seewald & Partner Ltd.')).toBe('Seewald & Partner');
  });

  it('reaches past the home market', () => {
    // A German-only list would be a home-market default; the product is not CH/DE-scoped.
    expect(organisationShortForm('Meridian S.p.A.')).toBe('Meridian');
    expect(organisationShortForm('Bregenz B.V.')).toBe('Bregenz');
    expect(organisationShortForm('Lindau Oy')).toBe('Lindau');
    expect(organisationShortForm('Aurora Pty Ltd')).toBe('Aurora');
    expect(organisationShortForm('Nordfeld AG & Co. KG')).toBe('Nordfeld');
  });

  it('returns null when there is nothing to strip', () => {
    expect(organisationShortForm('Nordfeld')).toBeNull();
    expect(organisationShortForm('Stadtwerke Lindau')).toBeNull();
  });

  it('does not read a legal form that is merely the TAIL of a word', () => {
    // These must actually END in a legal-form string or they prove nothing: "Cisco" ends in
    // `co`, "Sonntag" in `ag`. An earlier version used "AGRA"/"Inconso", which pass with or
    // without the token boundary because neither ends in one.
    expect(organisationShortForm('Cisco')).toBeNull();
    expect(organisationShortForm('Sonntag')).toBeNull();
    expect(organisationShortForm('Ferienhaus-AG')).toBeNull();
  });

  it('refuses a residue that is empty or punctuation', () => {
    // An empty short form would equal every other empty one; `-` and `&` name nothing.
    expect(organisationShortForm('GmbH')).toBeNull();
    expect(organisationShortForm(', GmbH')).toBeNull();
    expect(organisationShortForm('- GmbH')).toBeNull();
    expect(organisationShortForm('Kanzlei Weber & Co')).toBe('Kanzlei Weber');
  });

  it('does not backtrack on a hostile name, at the size that can actually reach it', () => {
    // The bound has to be BELOW the input cap or the cap does the work and the regex is
    // untested — which is exactly what happened to the first attempt's version of this test.
    const worst = 'Acme' + ', '.repeat(90);        // 184 chars, under the 200-char cap
    expect(worst.length).toBeLessThan(200);
    const started = Date.now();
    for (let i = 0; i < 500; i++) organisationShortForm(worst);
    expect(Date.now() - started).toBeLessThan(200);
    // The cap needs an input whose answer CHANGES without it: a long name that really does end
    // in a legal form. `'x'.repeat(5000)` would return null either way — the same tautology the
    // first attempt's ReDoS test shipped with.
    const longWithForm = 'x'.repeat(300) + ' GmbH';
    expect(longWithForm.length).toBeGreaterThan(200);
    expect(organisationShortForm(longWithForm)).toBeNull();
  });
});

describe('SubjectStore — the short form is registered as an alias', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function make(): SubjectStore {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-shortalias-'));
    tmpDirs.push(dir);
    return new SubjectStore(new EngineDb(join(dir, 'engine.db'), ''));
  }

  it('a created organisation carries its short form as an alias', () => {
    const s = make();
    const id = s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    expect(s.findByAlias('Nordfeld', 'organization', undefined, { includeDerived: true })?.id).toBe(id);
    // A write-path lookup must NOT see it — that separation is the v12 column, not a convention.
    expect(s.findByAlias('Nordfeld', 'organization')).toBeNull();
    // …and the canonical name is untouched: the legal form is part of the company's identity
    // and has to keep rendering.
    expect(s.getSubject(id)?.name).toBe('Nordfeld GmbH');
  });

  it('is an ORGANISATION rule and does not leak to other kinds', () => {
    // `organisationShortForm` is a company-name rule. Applied to a product, "iPhone SE" would
    // gain the surface form "iPhone" and fire on a turn about a different product entirely.
    const s = make();
    s.createSubject({ kind: 'product', name: 'iPhone SE' });
    s.createSubject({ kind: 'person', name: 'Kim Se' });
    expect(s.findByAlias('iPhone', 'product', undefined, { includeDerived: true })).toBeNull();
    expect(s.findByAlias('Kim', 'person', undefined, { includeDerived: true })).toBeNull();
  });

  it('two clients sharing a short form resolve to NEITHER', () => {
    // The bleed the matcher-shaped attempt had to guard against explicitly. Here it falls out
    // of the alias contract: both rows carry the alias, so the lookup is ambiguous.
    const s = make();
    s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    s.createSubject({ kind: 'organization', name: 'Nordfeld AG' });
    const hit = s.findByAliasResolved('Nordfeld', 'organization', undefined, { includeDerived: true });
    expect(hit.ambiguous).toBe(true);
    expect(hit.row).toBeNull();
    expect(hit.ids).toHaveLength(2);
    // The full names still reach their own client.
    expect(s.findCanonical('Nordfeld GmbH', 'organization')).not.toBeNull();
    expect(s.findCanonical('Nordfeld AG', 'organization')).not.toBeNull();
  });

  it('a caller naming a DIFFERENT legal form matches nothing', () => {
    // Structurally, not by a guard: `Nordfeld AG` is neither the canonical name nor the alias.
    const s = make();
    s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    expect(s.findCanonical('Nordfeld AG', 'organization')).toBeNull();
    expect(s.findByAlias('Nordfeld AG', 'organization', undefined, { includeDerived: true })).toBeNull();
  });

  it('does NOT fold a later short-name mention into the existing company', () => {
    // The derived alias is a READ surface. Folding here would let a heuristic decide at write
    // time that "Meridian Bau" and "Meridian Bau AG" are one company and attach every later
    // fact to the winner — the identity-invention this resolver refuses for the ambiguous case.
    // Caught by the full suite: the subjects_merge test builds exactly this pair as its
    // duplicate fixture, and folding made the duplicate stop existing.
    const s = make();
    const id = s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    const r = s.findOrCreate({ kind: 'organization', name: 'Nordfeld' });
    expect(r.ambiguous).toBe(false);
    expect(r.ambiguous === false && r.id).not.toBe(id);
    expect(r.ambiguous === false && r.created).toBe(true);
  });

  it('still folds on a REAL alias, so the read surface did not disable write-time dedup', () => {
    // The opposite direction: only the derived form is inert. A surface form the caller
    // actually supplied must still resolve, or this change would have quietly broken dedup.
    const s = make();
    const id = s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH', aliases: ['Nordfeld GmbH', 'Nordfeld Maschinenbau'] });
    const r = s.findOrCreate({ kind: 'organization', name: 'Nordfeld Maschinenbau' });
    expect(r).toEqual({ ambiguous: false, id, created: false });
  });

  it('leaves the WRITE path exactly as it was — including its fragmentation', () => {
    // Stated because it is a real limit, not an oversight. With two companies sharing a short
    // form, a write that names only the short form still mints a THIRD row: `findOrCreate`
    // cannot see the derived aliases, so it neither folds nor reports ambiguity. That is
    // unchanged from before this work — the measured failure was a READ, and widening the write
    // path is a separate decision with its own risk. `subjects_merge` remains the repair.
    const s = make();
    s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    s.createSubject({ kind: 'organization', name: 'Nordfeld AG' });
    const r = s.findOrCreate({ kind: 'organization', name: 'Nordfeld' });
    expect(r.ambiguous).toBe(false);
    expect(r.ambiguous === false && r.created).toBe(true);
    // …while the READ surface refuses, because there the ambiguity is answerable and honest.
    expect(s.findByAliasResolved('Nordfeld', 'organization', undefined, { includeDerived: true }).ambiguous).toBe(true);
  });
});

describe('backfillOrganisationShortAliases', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function make(): { s: SubjectStore; legacy: (kind: string, name: string, archived?: boolean) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-backfill-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const s = new SubjectStore(engine);
    // A row exactly as it sits on disk today: inserted WITHOUT the rule, because that is what
    // "created before the rule existed" means. Going through `createSubject` cannot express it
    // any more — the rule now applies there, which is the whole reason a backfill is needed.
    const legacy = (kind: string, name: string, archived = false): string => {
      const id = `legacy-${kind}-${name.replace(/\W+/g, '-').toLowerCase()}`;
      engine.getDb().prepare(
        'INSERT INTO subjects (id, kind, name, aliases, archived_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, kind, name, JSON.stringify([name]), archived ? new Date().toISOString() : null);
      return id;
    };
    return { s, legacy };
  }

  it('reaches rows created before the rule existed', () => {
    // The whole reason a backfill exists: a tenant provisioned earlier has organisations with
    // no short alias, and nothing would ever add one — findOrCreate only touches a row it is
    // asked about.
    const { s, legacy } = make();
    const id = legacy('organization', 'Altbestand GmbH');
    expect(s.findByAlias('Altbestand', 'organization', undefined, { includeDerived: true })).toBeNull();
    expect(backfillOrganisationShortAliases(s)).toBe(1);
    expect(s.findByAlias('Altbestand', 'organization', undefined, { includeDerived: true })?.id).toBe(id);
  });

  it('is idempotent — a second run changes nothing', () => {
    const { s, legacy } = make();
    legacy('organization', 'Altbestand GmbH');
    expect(backfillOrganisationShortAliases(s)).toBe(1);
    expect(backfillOrganisationShortAliases(s)).toBe(0);
  });

  it('leaves other kinds and archived rows alone', () => {
    const { s, legacy } = make();
    legacy('product', 'Modell AG');
    legacy('organization', 'Vergangen GmbH', true);
    expect(backfillOrganisationShortAliases(s)).toBe(0);
  });

  it('does NOT create an ambiguity that did not exist', () => {
    // Backfilling two colliding rows would turn a pair that resolved fine by full name into a
    // pair where the short name is ambiguous. That is correct — the short name genuinely names
    // neither — but it must not touch the full-name lookups, which is what this pins.
    const { s, legacy } = make();
    legacy('organization', 'Doppel GmbH');
    legacy('organization', 'Doppel AG');
    expect(backfillOrganisationShortAliases(s)).toBe(2);
    expect(s.findByAliasResolved('Doppel', 'organization', undefined, { includeDerived: true }).ambiguous).toBe(true);
    expect(s.findCanonical('Doppel GmbH', 'organization')).not.toBeNull();
    expect(s.findCanonical('Doppel AG', 'organization')).not.toBeNull();
  });
});

describe('the backfill is WIRED, not merely exported', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('runs when the KnowledgeLayer opens an engine.db', async () => {
    // This arc has twice shipped a mechanism that worked and was reachable from nowhere
    // (`_recoverFollowUps` on one call site; a review queue nobody opened). An export is not a
    // feature. Constructing the layer the way the engine does must be enough to heal the row.
    const { KnowledgeLayer } = await import('./knowledge-layer.js');
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wired-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engine.getDb().prepare(
      'INSERT INTO subjects (id, kind, name, aliases) VALUES (?, ?, ?, ?)',
    ).run('legacy-1', 'organization', 'Altbestand GmbH', JSON.stringify(['Altbestand GmbH']));

    const probe = new SubjectStore(engine);
    const seek = (): unknown => probe.findByAlias('Altbestand', 'organization', undefined, { includeDerived: true })?.id;
    expect(seek(), 'precondition: not yet aliased').toBeUndefined();

    const embeddings = { dimensions: 8, embed: async () => new Array(8).fill(0) };
    new KnowledgeLayer(
      join(dir, 'agent-memory.db'), embeddings as never,
      undefined, undefined, engine, true, false,
    );

    expect(seek()).toBe('legacy-1');
  });
});
