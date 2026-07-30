/**
 * What `findOrCreate` folds, and what it leaves alone.
 *
 * WHY THIS FILE EXISTS. The durable-knowledge rollout carried a blocker recorded
 * as "same-named subjects merge irreversibly, no ledger" — and the honest way to
 * size that turned out not to be a production query. Reading the code first
 * changed the question twice over:
 *
 *  1. `findOrCreate` never merges two existing rows. It attaches the incoming
 *     surface form to an existing subject as an ALIAS, or creates a new one.
 *     Nothing is deleted, and the alias list is itself a partial record of what
 *     was folded in. (`mergeSubjects` — a different, explicit call — is the one
 *     that redirects a row via `merged_into`.)
 *  2. So the failure mode is not data loss. It is two real-world entities
 *     sharing one row, and the only question worth measuring is which inputs
 *     actually cause that.
 *
 * These tests answer #2 offline, against the real store. They are
 * CHARACTERISATION tests: they pin current behaviour rather than assert a wish,
 * so that any future loosening of the matcher shows up as a failure here instead
 * of as a quiet merge in someone's graph. Where the pinned behaviour is a real
 * risk, the test says so instead of implying the behaviour is fine.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';

describe('findOrCreate — which names fold onto one subject', () => {
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

  /** Create `first`, then offer `second`. Did the second land on the first? */
  function folds(first: string, second: string, kind = 'organization' as const): boolean {
    const store = makeStore();
    const a = store.findOrCreate({ kind, name: first });
    const b = store.findOrCreate({ kind, name: second });
    return b.id === a.id && !b.created;
  }

  describe('folds — and each of these is the intended, correct outcome', () => {
    it('is case-insensitive', () => {
      expect(folds('Meridian AG', 'meridian ag')).toBe(true);
      expect(folds('Meridian AG', 'MERIDIAN AG')).toBe(true);
    });

    it('ignores surrounding and doubled whitespace', () => {
      expect(folds('Meridian AG', '  Meridian   AG ')).toBe(true);
    });

    it('ignores trailing sentence punctuation', () => {
      // One-directional by construction: the CLEAN form has to be stored first,
      // because the normalised query is matched against stored RAW names.
      expect(folds('Meridian AG', 'Meridian AG.')).toBe(true);
    });

    it('does NOT fold the other way round — the punctuated form stored first', () => {
      // The asymmetry the implementation comment admits to. Worth pinning: it is
      // the difference between "converges on a clean name" and "converges".
      expect(folds('Meridian AG.', 'Meridian AG')).toBe(false);
    });
  });

  describe('does not fold — the matcher is far more conservative than folklore', () => {
    it('does not transliterate or fold diacritics', () => {
      expect(folds('Müller GmbH', 'Mueller GmbH')).toBe(false);
      expect(folds('Müller GmbH', 'Muller GmbH')).toBe(false);
    });

    it('does not strip or equate legal-form suffixes', () => {
      expect(folds('Meridian AG', 'Meridian')).toBe(false);
      expect(folds('Meridian AG', 'Meridian GmbH')).toBe(false);
    });

    it('does not fold on a shared prefix, a substring, or a typo', () => {
      expect(folds('Meridian AG', 'Meridian Bau AG')).toBe(false);
      expect(folds('Meridian AG', 'Meridan AG')).toBe(false);
    });

    it('does not fold across kinds', () => {
      const store = makeStore();
      const org = store.findOrCreate({ kind: 'organization', name: 'Orion' });
      const person = store.findOrCreate({ kind: 'person', name: 'Orion' });
      expect(person.id).not.toBe(org.id);
    });

    it('does not fold across owners', () => {
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Orion', ownerUserId: 'u1' });
      const b = store.findOrCreate({ kind: 'organization', name: 'Orion', ownerUserId: 'u2' });
      expect(b.id).not.toBe(a.id);
    });
  });

  /**
   * ⚠️ THE ONE THAT ACTUALLY OVER-MERGES, and it is not a fuzzy-matching bug.
   *
   * Every loose-match story above turns out to be false: the matcher does not
   * transliterate, does not strip suffixes, does not do edit distance. What it
   * does do is treat an EXACT name as an identity — so two different real people
   * or companies with the same name become one subject, silently and by design.
   * No amount of tightening the string comparison addresses this; the fix is
   * either a second identity signal (email, domain, parent) or a way back out.
   */
  it('folds two DIFFERENT entities that happen to share a name', () => {
    expect(folds('Thomas Müller', 'Thomas Müller', 'person')).toBe(true);
  });

  it('records the surface forms it folded — the partial ledger that already exists', () => {
    const store = makeStore();
    const { id } = store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
    store.findOrCreate({ kind: 'organization', name: 'meridian ag' });
    store.findOrCreate({ kind: 'organization', name: 'Meridian AG.' });

    const aliases = JSON.parse(store.getSubject(id)!.aliases) as string[];
    // What is recoverable today: WHICH forms arrived. What is not: when, from
    // which extraction, and what attached to the subject after each — which is
    // exactly what a split would need. That gap is the real deferred item; the
    // "irreversible merge" it was filed as is not what this code does.
    expect(aliases).toContain('Meridian AG.');
    expect(aliases.map((a) => a.toLowerCase())).toContain('meridian ag');
  });
});
