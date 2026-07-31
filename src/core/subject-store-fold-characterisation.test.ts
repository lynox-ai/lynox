/**
 * Which names fold onto one subject — per RESOLVER, because there are three,
 * and PERSONS GO THROUGH TWO OF THEM depending on where the name came from.
 *
 * WHY THIS FILE EXISTS. The durable-knowledge rollout carries a blocker filed as
 * "same-named subjects merge irreversibly, no ledger". Sizing it turned out not
 * to need a production query — but it took three attempts to state the answer
 * correctly, and both wrong versions were wrong the same way: they described
 * ONE resolver and called it "the matcher".
 *
 *   v1: characterised `findOrCreate` and reported "no fuzzy matching anywhere".
 *       False — extraction resolves persons through `resolvePersonSubject`,
 *       which folds on a token subset.
 *   v2: corrected to "production never routes persons through `findOrCreate`".
 *       Also false, inverted: CRM contacts (`crm.ts`) and task assignees
 *       (`task-store.ts` → `resolveAssigneeToSubjectId`) do exactly that.
 *
 * The verified account, from an exhaustive sweep of the production call sites
 * (`findOrCreate` · `resolvePersonSubject` · `findOrCreateEngagement` ·
 * `resolveAssigneeToSubjectId` · `makeSubjectColumnBridge`):
 *
 *   engagement                → `findOrCreateEngagement`
 *   person, from EXTRACTION   → `resolvePersonSubject`  (subset fold)
 *   the SELF person           → `createSubject` directly (no dedup at all)
 *   EVERYTHING ELSE           → `findOrCreate`          (no subset fold)
 *
 * The third row is `resolveAssigneeToSubjectId('user')` → `findOrCreateSelfPerson`,
 * which mints in a reserved owner scope and never consults a resolver. It cannot
 * collide with the rest because the owner differs — noted so the table reads as
 * complete rather than as three cases someone stopped enumerating.
 *
 * The second line has exactly two sites — `knowledge-layer.ts:807` and `:995`,
 * the two arms of extraction. Every other resolution in the codebase is the
 * third line, persons included: CRM contacts (`crm.ts:261`), task assignees
 * (`task-store.ts:241` → `resolveAssigneeToSubjectId`), the graph backfill
 * (`subject-graph-backfill.ts:265`), the DataStore subject-column bridge
 * (`engine.ts:1712`), and — the one that matters most for the register entry
 * this file feeds — the DURABLE-KNOWLEDGE write path itself
 * (`knowledge-store.ts:143`, whose kind is `params.subjectKind ?? 'organization'`
 * and so resolves a person through `findOrCreate` too).
 *
 * That split is the finding, and it points the opposite way from the blocker it
 * was filed under: the same human entered as the contact "Ada" and extracted
 * from a mail as "Dr. Ada Lovelace" becomes TWO subjects. Over-merging was the
 * worry; on every person path except extraction, fragmentation is the behaviour.
 *
 * What holds across all of them: none MERGES two existing rows. Each either
 * attaches the incoming surface form to an existing subject as an alias, or
 * creates a new one — with one exception, engagement's orphan-adopt, which
 * re-parents an existing row.
 *
 * The real merge is a different call, and it is the inverse of the worry: `runMerge`
 * (`subject-merge-runner.ts`) redirects a row via `merged_into`, writes a ledger
 * file and has `rollbackMergeRun`. It is reachable ONLY from the `subjects_merge`
 * tool and the `subject-sweep` operator CLI — nothing schedules it. So the merge
 * that IS reversible has to be asked for, and the fold that is not reversible
 * happens on its own. Nothing reconciles a fragmented pair afterwards either,
 * which is why the divergence below persists rather than healing.
 *
 * And a fold does not reliably leave a trace: `_mergeAliases` dedupes
 * case-insensitively, so a case-variant fold writes nothing at all.
 *
 * CHARACTERISATION, not aspiration: these pin current behaviour so a future
 * change fails here rather than merging quietly in someone's graph. Where the
 * pinned behaviour is a real risk, the test says so.
 *
 * ONE thing this file did not merely characterise but got FIXED: `findByAlias`
 * used to return the first row of an unordered scan, so two subjects sharing an
 * alias were collapsed by row order. That is not blunt, it is wrong, and it does
 * not rest on a frequency assumption — every fold writes aliases, so the
 * constellation builds itself. It refuses on ambiguity now.
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

  describe('findOrCreate — organization, product, service', () => {
    /** Create `first`, then offer `second`. Did the second land on the first? */
    type DedupKind = 'organization' | 'product' | 'service';
    function folds(first: string, second: string, kind: DedupKind = 'organization'): boolean {
      const store = makeStore();
      const a = store.findOrCreate({ kind, name: first });
      // Anchors the negatives: without this, every `toBe(false)` below also
      // passes against a findOrCreate broken to ALWAYS create.
      expect(a.created).toBe(true);
      return store.findOrCreate({ kind, name: second }).id === a.id;
    }

    it('folds on case, whitespace and trailing punctuation', () => {
      expect(folds('Meridian AG', 'meridian ag')).toBe(true);
      expect(folds('Meridian AG', '  Meridian   AG ')).toBe(true);
      expect(folds('Meridian AG', 'Meridian AG.')).toBe(true);
    });

    it('does not fold the punctuated form stored FIRST', () => {
      // The asymmetry the implementation admits to: the normalised query is
      // matched against stored RAW names, so the clean form must arrive first.
      expect(folds('Meridian AG.', 'Meridian AG')).toBe(false);
    });

    it('does not transliterate, strip suffixes, or match on prefix or typo', () => {
      expect(folds('Müller GmbH', 'Mueller GmbH')).toBe(false);
      expect(folds('Meridian AG', 'Meridian')).toBe(false);
      expect(folds('Meridian AG', 'Meridian Bau AG')).toBe(false);
      expect(folds('Meridian AG', 'Meridan AG')).toBe(false);
    });

    it('behaves the same for product and service', () => {
      // The block used to be titled for three kinds and exercise one.
      for (const kind of ['product', 'service'] as const) {
        expect(folds('Orion Suite', 'orion suite', kind), kind).toBe(true);
        expect(folds('Orion Suite', 'Orion', kind), kind).toBe(false);
      }
    });

    it('does not fold across kind or owner', () => {
      const store = makeStore();
      const org = store.findOrCreate({ kind: 'organization', name: 'Orion' });
      expect(store.findOrCreate({ kind: 'product', name: 'Orion' }).id).not.toBe(org.id);
      expect(store.findOrCreate({ kind: 'organization', name: 'Orion', ownerUserId: 'u2' }).id)
        .not.toBe(org.id);
    });

    it('folds a name that equals a stored ALIAS, not just the canonical name', () => {
      // The second lookup stage. The first version of this file never reached it
      // — deleting the `findByAlias` call left every test green, because the
      // normalised fallback happened to cover each case it had.
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG', aliases: ['Meridian Group'] });
      expect(store.findOrCreate({ kind: 'organization', name: 'Meridian Group' }).id).toBe(a.id);
    });

    it('REFUSES when two subjects share an alias — it mints rather than guesses', () => {
      // `findByAlias` full-scans with no ORDER BY and aliases carry no unique
      // index, so returning the first hit collapsed two distinct organisations
      // by row order — silently, and with no trace. It declines now, the same
      // rule `resolvePersonSubject` applies to an ambiguous subset: minting a
      // third row is recoverable, resolving to the wrong one is not.
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG', aliases: ['Meridian'] });
      const b = store.findOrCreate({ kind: 'organization', name: 'Meridian Bau AG', aliases: ['Meridian'] });
      expect(b.id).not.toBe(a.id);
      const third = store.findOrCreate({ kind: 'organization', name: 'Meridian' });
      expect(third.id).not.toBe(a.id);
      expect(third.id).not.toBe(b.id);
      expect(third.created).toBe(true);
    });

    it('still resolves an UNambiguous alias — the refusal is not a blanket off-switch', () => {
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG', aliases: ['Meridian'] });
      store.findOrCreate({ kind: 'organization', name: 'Nordberg AG', aliases: ['Nordberg'] });
      expect(store.findOrCreate({ kind: 'organization', name: 'Meridian' }).id).toBe(a.id);
    });
  });

  describe('resolvePersonSubject — persons from EXTRACTION', () => {
    it('folds a token SUBSET into the fuller name when it is unambiguous', () => {
      const store = makeStore();
      const full = store.resolvePersonSubject('Dr. Ada Lovelace');
      const short = store.resolvePersonSubject('Ada');
      expect(short.id).toBe(full.id);
      expect(short.resolved).toBe('subset');
    });

    it('folds a title-stripped variant onto the plain name, and records it', () => {
      const store = makeStore();
      const plain = store.resolvePersonSubject('Ada Lovelace');
      const titled = store.resolvePersonSubject('Dr. Ada Lovelace');
      expect(titled.id).toBe(plain.id);
      expect(JSON.parse(store.getSubject(plain.id)!.aliases))
        .toEqual(['Ada Lovelace', 'Dr. Ada Lovelace']);
      // NOT asserting `resolved: 'canonical'`, though it is: three separate
      // branches return that label (exact hit, normalised fallback, equal-key),
      // so it would look like it identified the path taken while proving only
      // that some fold happened. The alias list is the observable that does not
      // over-state.
    });

    it('REFUSES an ambiguous subset — mints rather than guesses, and still folds a clear one', () => {
      const store = makeStore();
      const a = store.resolvePersonSubject('Ada Lovelace');
      const b = store.resolvePersonSubject('Ada Byron');
      const ambiguous = store.resolvePersonSubject('Ada');
      expect(ambiguous.id).not.toBe(a.id);
      expect(ambiguous.id).not.toBe(b.id);
      expect(ambiguous.created).toBe(true);
      // In the SAME store, so the refusal cannot be confused with a subset scan
      // that never runs: delete the scan and this line fails while the three
      // above still pass.
      expect(store.resolvePersonSubject('Byron').id).toBe(b.id);
    });

    it('⚠️ folds the FIRST exact homonym — two different people become one', () => {
      // Ambiguity protects only from the second collision onward. The first
      // "Thomas Müller" absorbs the next, and no string rule separates them.
      const store = makeStore();
      const first = store.resolvePersonSubject('Thomas Müller');
      expect(store.resolvePersonSubject('Thomas Müller').id).toBe(first.id);
    });
  });

  describe('⚠️ the two person paths disagree', () => {
    it('every person path EXCEPT extraction skips the subset fold', () => {
      // `crm.ts`, `resolveAssigneeToSubjectId`, the backfill, the DataStore
      // bridge and the durable-knowledge write path all call
      // `findOrCreate({kind:'person'})`, which has no subset stage. So the same
      // human, entered as the contact "Ada" and extracted from a mail as
      // "Dr. Ada Lovelace", becomes two subjects — fragmentation, the mirror of
      // the over-merge the register entry worries about. Pinned so the
      // divergence is visible; not endorsed.
      const store = makeStore();
      const extracted = store.resolvePersonSubject('Dr. Ada Lovelace');
      const viaContact = store.findOrCreate({ kind: 'person', name: 'Ada' });
      expect(viaContact.id).not.toBe(extracted.id);
      expect(viaContact.created).toBe(true);
    });
  });

  describe('the trace a fold leaves', () => {
    it('records a differing surface form', () => {
      const store = makeStore();
      const { id } = store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
      store.findOrCreate({ kind: 'organization', name: 'Meridian AG.' });
      expect(JSON.parse(store.getSubject(id)!.aliases)).toEqual(['Meridian AG', 'Meridian AG.']);
    });

    it('⚠️ records NOTHING for a case-variant or an exact homonym', () => {
      // `_mergeAliases` dedupes case-insensitively and `createSubject` seeds the
      // list with the canonical name, so these folds leave no trace. Asserted on
      // the RAW array: the first version lower-cased it before looking for the
      // folded form, which the ORIGINAL name satisfies — it passed while proving
      // nothing, and the register entry rested on it.
      const store = makeStore();
      const { id } = store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
      store.findOrCreate({ kind: 'organization', name: 'meridian ag' });
      expect(JSON.parse(store.getSubject(id)!.aliases)).toEqual(['Meridian AG']);

      const p = store.resolvePersonSubject('Thomas Müller');
      store.resolvePersonSubject('Thomas Müller');
      expect(JSON.parse(store.getSubject(p.id)!.aliases)).toEqual(['Thomas Müller']);
    });
  });

  describe('what these resolvers do NOT see', () => {
    it('an archived subject is invisible, so its name mints a fresh duplicate', () => {
      // Both lookups filter `archived_at IS NULL`, and the canonical index is
      // partial to match. Archiving is therefore not "soft delete" from the
      // graph's point of view — the next mention of the same name starts a new
      // subject beside the old one rather than reviving it.
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
      store.archiveSubject(a.id);
      const b = store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
      expect(b.id).not.toBe(a.id);
      expect(b.created).toBe(true);
    });
  });

  it('engagement is a THIRD resolver and is not characterised here', () => {
    // `findOrCreateEngagement` keys on (normalised name, parent), strips a
    // leading "Projekt"/"Project" — a prefix strip the findOrCreate block above
    // correctly denies for its own kinds — and has an orphan-adopt path that
    // RE-PARENTS an existing row, the one place any of this mutates a subject
    // rather than appending to it. Different rules, different risks; pinning
    // them belongs with the engagement work — including
    // `allowParentedReuseOnNullParent` (reached from `set-thread-context.ts`),
    // which reuses `matches[0]` under an ARBITRARY client by `updated_at DESC`:
    // the same scan-order hazard this file flags for shared aliases above.
    // This test exists so that reading
    // only the blocks above does not read as coverage of the whole graph.
    const store = makeStore();
    const a = store.findOrCreateEngagement('Projekt Orion', null);
    expect(store.findOrCreateEngagement('Orion', null).id).toBe(a.id);
  });
});
