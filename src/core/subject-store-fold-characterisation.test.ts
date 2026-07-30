/**
 * Which names fold onto one subject — per RESOLVER, because there are three.
 *
 * WHY THIS FILE EXISTS. The durable-knowledge rollout carries a blocker filed as
 * "same-named subjects merge irreversibly, no ledger", and the plan was to size
 * it with a production query. Reading the code first was cheaper and changed the
 * question — but the FIRST version of this file then got the answer wrong in a
 * way worth recording, because it is the failure mode this whole exercise is
 * about: it characterised `findOrCreate` and reported the result as "the
 * matcher". Production does not route persons through `findOrCreate` at all
 * (`knowledge-layer.ts` sends `person` → `resolvePersonSubject`, `engagement` →
 * `findOrCreateEngagement`), and `resolvePersonSubject` deliberately DOES fold on
 * a token subset. The instrument answered a question; it was not the question.
 *
 * What holds after the correction:
 *
 *  - No resolver here merges two existing rows. Each attaches the incoming
 *    surface form to an existing subject as an ALIAS, or creates a new one.
 *    Nothing is deleted. (`mergeSubjects` — separate and explicit — is the call
 *    that redirects a row via `merged_into`, and it IS ledgered.)
 *  - So the failure mode is two real entities sharing one row, not data loss.
 *  - A fold does not reliably leave a trace: `_mergeAliases` dedupes
 *    case-insensitively, so a case-variant fold writes nothing at all. The alias
 *    list is a record of some folds, not of folding.
 *
 * These are CHARACTERISATION tests: they pin current behaviour so a future
 * loosening fails here rather than merging quietly in someone's graph. Where the
 * pinned behaviour is a real risk, the test says so instead of implying it is fine.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';

describe('subject folding, per resolver', () => {
  const tmpDirs: string[] = [];

  function makeStore(): SubjectStore {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-fold-'));
    tmpDirs.push(dir);
    return new SubjectStore(new EngineDb(join(dir, 'engine.db'), ''));
  }

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // ── findOrCreate: organization / product / service ───────────────────────
  //
  // The name-deduped kinds MINUS person, which has its own resolver below.

  describe('findOrCreate (organization, product, service)', () => {
    /** Create `first`, then offer `second`. Did the second land on the first? */
    function folds(first: string, second: string, kind = 'organization' as const): boolean {
      const store = makeStore();
      const a = store.findOrCreate({ kind, name: first });
      // Anchors the negatives: without this, every `expect(...).toBe(false)`
      // below also passes against a findOrCreate broken to ALWAYS create.
      expect(a.created).toBe(true);
      const b = store.findOrCreate({ kind, name: second });
      return b.id === a.id;
    }

    it('folds on case, whitespace and trailing punctuation', () => {
      expect(folds('Meridian AG', 'meridian ag')).toBe(true);
      expect(folds('Meridian AG', '  Meridian   AG ')).toBe(true);
      expect(folds('Meridian AG', 'Meridian AG.')).toBe(true);
    });

    it('does not fold the punctuated form stored FIRST', () => {
      // The asymmetry the implementation admits to: the normalised query is
      // matched against stored RAW names, so the clean form has to arrive first.
      expect(folds('Meridian AG.', 'Meridian AG')).toBe(false);
    });

    it('does not transliterate, strip suffixes, or match on prefix or typo', () => {
      expect(folds('Müller GmbH', 'Mueller GmbH')).toBe(false);
      expect(folds('Meridian AG', 'Meridian')).toBe(false);
      expect(folds('Meridian AG', 'Meridian Bau AG')).toBe(false);
      expect(folds('Meridian AG', 'Meridan AG')).toBe(false);
    });

    it('does not fold across kind or owner', () => {
      const store = makeStore();
      const org = store.findOrCreate({ kind: 'organization', name: 'Orion' });
      expect(store.findOrCreate({ kind: 'product', name: 'Orion' }).id).not.toBe(org.id);
      expect(store.findOrCreate({ kind: 'organization', name: 'Orion', ownerUserId: 'u2' }).id)
        .not.toBe(org.id);
    });

    it('folds a name that equals a stored ALIAS, not just the canonical name', () => {
      // The second lookup stage, which the first version of this file never
      // reached — deleting the `findByAlias` call left all of it green, because
      // the normalised fallback happened to cover every case it had.
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG', aliases: ['Meridian Group'] });
      expect(store.findOrCreate({ kind: 'organization', name: 'Meridian Group' }).id).toBe(a.id);
    });

    it('⚠️ folds onto ONE of two subjects sharing an alias, without saying which', () => {
      // `findByAlias` scans with no ORDER BY and aliases carry no unique index,
      // so this resolves to whichever row SQLite returns first. Two distinct
      // organisations that each list "Meridian" then make a third mention of
      // "Meridian" a coin flip — a cross-entity fold, and the one case here
      // where the pinned behaviour is simply wrong rather than merely blunt.
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG', aliases: ['Meridian'] });
      const b = store.findOrCreate({ kind: 'organization', name: 'Meridian Bau AG', aliases: ['Meridian'] });
      expect(b.id).not.toBe(a.id);
      const third = store.findOrCreate({ kind: 'organization', name: 'Meridian' });
      expect([a.id, b.id]).toContain(third.id); // one of them; nothing decides which
    });
  });

  // ── resolvePersonSubject: the path production actually uses for people ────

  describe('resolvePersonSubject (person)', () => {
    it('folds a token SUBSET into the fuller name when it is unambiguous', () => {
      // "Ada" lands on "Dr. Ada Lovelace". This is the loose match the first
      // version of this file reported as absent — on the most identity-sensitive
      // kind there is.
      const store = makeStore();
      const full = store.resolvePersonSubject('Dr. Ada Lovelace');
      const short = store.resolvePersonSubject('Ada');
      expect(short.id).toBe(full.id);
      expect(short.resolved).toBe('subset');
    });

    it('folds a title-stripped variant onto the same person', () => {
      const store = makeStore();
      const plain = store.resolvePersonSubject('Ada Lovelace');
      expect(store.resolvePersonSubject('Dr. Ada Lovelace').id).toBe(plain.id);
    });

    it('REFUSES when the subset is ambiguous — it mints rather than guesses', () => {
      // The design this resolver gets right, and it is the shape the register
      // entry asks for elsewhere: with two candidates it declines to choose.
      const store = makeStore();
      const a = store.resolvePersonSubject('Ada Lovelace');
      const b = store.resolvePersonSubject('Ada Byron');
      const ambiguous = store.resolvePersonSubject('Ada');
      expect(ambiguous.id).not.toBe(a.id);
      expect(ambiguous.id).not.toBe(b.id);
      expect(ambiguous.created).toBe(true);
    });

    it('⚠️ folds the FIRST exact homonym — two different people become one', () => {
      // Ambiguity protects only from the second collision onward. The first
      // "Thomas Müller" to arrive absorbs the next one, silently, and no string
      // rule can separate them: they need a second identity signal.
      const store = makeStore();
      const first = store.resolvePersonSubject('Thomas Müller');
      expect(store.resolvePersonSubject('Thomas Müller').id).toBe(first.id);
    });
  });

  // ── What a fold leaves behind ────────────────────────────────────────────

  describe('the trace a fold leaves', () => {
    it('records a differing surface form', () => {
      const store = makeStore();
      const { id } = store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
      store.findOrCreate({ kind: 'organization', name: 'Meridian AG.' });
      expect(JSON.parse(store.getSubject(id)!.aliases)).toEqual(['Meridian AG', 'Meridian AG.']);
    });

    it('⚠️ records NOTHING for a case-variant or an exact homonym', () => {
      // `_mergeAliases` dedupes case-insensitively, and `createSubject` seeds the
      // list with the canonical name — so these folds are invisible afterwards.
      // Asserted on the RAW array: the first version of this file checked
      // `aliases.map(toLowerCase).toContain('meridian ag')`, which the ORIGINAL
      // name satisfies. It passed while proving nothing, which is worse than
      // absent, because the register entry rested on it.
      const store = makeStore();
      const { id } = store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
      store.findOrCreate({ kind: 'organization', name: 'meridian ag' });
      expect(JSON.parse(store.getSubject(id)!.aliases)).toEqual(['Meridian AG']);

      const p = store.resolvePersonSubject('Thomas Müller');
      store.resolvePersonSubject('Thomas Müller');
      expect(JSON.parse(store.getSubject(p.id)!.aliases)).toEqual(['Thomas Müller']);
    });
  });

  // ── Out of scope here, and named so the omission is not read as absence ──

  it('engagement is a THIRD resolver and is not characterised here', () => {
    // `findOrCreateEngagement` keys on (normalised name, parent), strips a
    // leading "Projekt"/"Project" — a prefix strip the findOrCreate block above
    // correctly denies for its own kinds — and has an orphan-adopt path that
    // rewrites `parent_id` with no ledger entry. Different rules, different
    // risks; pinning them belongs with the engagement work, not here. This test
    // exists so that reading only the blocks above does not leave the impression
    // that they cover the graph.
    const store = makeStore();
    const a = store.findOrCreateEngagement('Projekt Orion', null);
    expect(store.findOrCreateEngagement('Orion', null).id).toBe(a.id);
  });
});
