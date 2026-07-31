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
 *
 * It took THREE attempts, and all three failures are the kind a reading of the code does
 * not catch — which is why they are recorded here rather than only in the history:
 *
 *   · It did not fire in German. The count was taken over rows an
 *     `aliases LIKE` prefilter had already reduced, and SQLite folds case for
 *     ASCII only, so a second subject differing in the case of an umlaut never
 *     reached the count — the guard reported "unambiguous" and answered
 *     confidently. Folding in SQL would NOT have fixed it either: that `lower()`
 *     is the same ASCII-only one. Pinned by the non-ASCII pair below; an
 *     all-ASCII fixture passes against the broken version.
 *   · Refusing is only half a decision. A bare `null` meant "no match" to every
 *     caller, and several legitimately treat that as KEEP LOOKING — so the
 *     refusal fell into wider matchers and produced new silent wrong answers
 *     (a third person via the subset scan; a person answering an organization
 *     scope; an exclusion filter that quietly stopped excluding).
 *   · Then the write path tried to ANSWER anyway, by collecting such mentions on a row
 *     named after the shared name. That row won `findCanonical`, so the name resolved to
 *     it from then on — and its only exit was a bulk repoint moving every collected fact
 *     onto ONE candidate, i.e. the original defect again, later and in bulk. A store
 *     cannot answer "which of these two" by inventing a third.
 *
 * What holds now: ambiguity is its own return value, and each caller says what it does
 * about it — refuse loudly where a human can disambiguate, skip the edge (and COUNT it)
 * where the mirror is additive.
 *
 * Which is why the fixtures here are German pairs rather than the tidier ASCII
 * ones: on this product the umlaut case is the normal case, and a test suite
 * that only ever asks in ASCII will keep passing while the guarantee is void.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore, makeSubjectColumnBridge } from './subject-store.js';

describe('subject folding, per resolver', () => {
  const tmpDirs: string[] = [];

  /** The id of a resolution that must not be ambiguous — fails loudly if it is. */
  function idOf(r: { ambiguous: boolean } & Record<string, unknown>): string {
    if (r.ambiguous) throw new Error('expected an unambiguous resolution, got the candidate set');
    return r['id'] as string;
  }

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
      expect(a.ambiguous === false && a.created).toBe(true);
      return idOf(store.findOrCreate({ kind, name: second })) === idOf(a);
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

    it('REPORTS the candidates when two subjects share a name — it does not answer', () => {
      // `findByAlias` full-scanned with no ORDER BY and aliases carry no unique index,
      // so returning the first hit collapsed two distinct organisations by row order,
      // silently. Two later attempts to replace that with an ANSWER were both wrong:
      // taking one of the two, and minting a third row named after the shared name (which
      // then won `findCanonical`, and could only be undone by a bulk repoint that moves
      // every collected fact onto ONE candidate — the original defect, later and larger).
      // The store does not invent an identity: it hands back who it could have meant.
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG', aliases: ['Meridian'] });
      const b = store.findOrCreate({ kind: 'organization', name: 'Meridian Bau AG', aliases: ['Meridian'] });
      expect(a.ambiguous).toBe(false);
      expect(b.ambiguous).toBe(false);
      const third = store.findOrCreate({ kind: 'organization', name: 'Meridian' });
      expect(third.ambiguous).toBe(true);
      if (third.ambiguous) {
        expect([...third.candidateIds].sort()).toEqual([idOf(a), idOf(b)].sort());
      }
      // and nothing was written — the count is unchanged.
      expect(store.count({ kinds: ['organization'] })).toBe(2);
    });

    it('still resolves an UNambiguous alias — the refusal is not a blanket off-switch', () => {
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG', aliases: ['Meridian'] });
      store.findOrCreate({ kind: 'organization', name: 'Nordberg AG', aliases: ['Nordberg'] });
      expect(store.findOrCreate({ kind: 'organization', name: 'Meridian' }).id).toBe(a.id);
    });

    it('stops widening after an ambiguous alias — the normalised fallback does not run', () => {
      // The stage after the alias lookup matches the NORMALISED query against
      // stored raw names, so letting an ambiguous alias fall into it hands the
      // name to a third subject that merely normalises the same way. Ambiguity
      // is not a miss, and every step below it is wider than the one that
      // already declined to answer.
      const store = makeStore();
      store.findOrCreate({ kind: 'organization', name: 'Nordberg AG', aliases: ['Meridian AG.'] });
      store.findOrCreate({ kind: 'organization', name: 'Ostwald AG', aliases: ['Meridian AG.'] });
      store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
      const after = store.findOrCreate({ kind: 'organization', name: 'Meridian AG.' });
      expect(after.ambiguous).toBe(true);
    });

    it('sees the ambiguity when the shared alias differs in a NON-ASCII case', () => {
      // The case that defeated the first version of the refusal, and the reason
      // this file now pins a German pair rather than an ASCII one. SQLite folds
      // case for ASCII only — `lower('MÜLLER')` is `'mÜller'` — so an
      // `aliases LIKE '%"müller"%'` prefilter matched the "Müller" row and
      // dropped the "MÜLLER" one. Exactly one candidate survived to be counted,
      // the guard reported "unambiguous", and the lookup answered with whichever
      // row the prefilter happened to keep. The count has to be taken over rows
      // the SQL layer did not pre-judge; folding IN SQL does not fix this,
      // because that `lower()` is the same ASCII-only one.
      const store = makeStore();
      store.findOrCreate({ kind: 'organization', name: 'Müller Bau AG', aliases: ['Müller'] });
      store.findOrCreate({ kind: 'organization', name: 'Müller Handel AG', aliases: ['MÜLLER'] });
      const hit = store.findOrCreate({ kind: 'organization', name: 'müller' });
      expect(hit.ambiguous).toBe(true);
      if (hit.ambiguous) expect(hit.candidateIds).toHaveLength(2);
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

    it('an ambiguous ALIAS reports back — it does not fall through to the looser subset scan', () => {
      // The steps after the alias lookup are progressively wider matchers, so
      // treating "two people already carry this alias" as a plain miss let the
      // name bind to a THIRD person who carried neither — worse than the
      // behaviour being fixed, which at least picked one of the two candidates.
      // "Ada Lovelace" below is that third person: her token set is a strict
      // superset of "Ada", so the subset scan resolves to her the moment the
      // alias refusal is allowed to fall through.
      const store = makeStore();
      const a = store.findOrCreate({ kind: 'person', name: 'Anna Meier', aliases: ['Ada'] });
      const b = store.findOrCreate({ kind: 'person', name: 'Bernd Meier', aliases: ['Ada'] });
      const third = store.findOrCreate({ kind: 'person', name: 'Ada Lovelace' });
      const resolved = store.resolvePersonSubject('Ada');
      expect('ambiguous' in resolved && resolved.ambiguous).toBe(true);
      // Nothing was bound and nothing was written: still exactly the three we made.
      expect(store.count({ kinds: ['person'] })).toBe(3);
      // The subset scan still runs for a name the alias stage did not refuse —
      // otherwise the lines above would also pass with the scan deleted.
      const clear = store.resolvePersonSubject('Lovelace');
      expect('ambiguous' in clear).toBe(false);
      if (!('ambiguous' in clear)) expect(clear.id).toBe(idOf(third));
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

  describe('the DataStore subject-column bridge', () => {
    it('returns one id for an unambiguous name and none for an unknown one', () => {
      const store = makeStore();
      const bridge = makeSubjectColumnBridge(store);
      const a = store.findOrCreate({ kind: 'person', name: 'Anna Meier', aliases: ['Anna'] });
      expect(bridge.findAll('Anna', 'person')).toEqual([idOf(a)]);
      expect(bridge.findAll('Nobody At All', 'person')).toEqual([]);
    });

    it('the WRITE half throws rather than binding a record to a guess', () => {
      // `resolve` links a record to a subject, which is an identity claim — exactly what
      // is unavailable here. Binding to one candidate, or to an invented row, made the
      // write and the later read disagree: a row stored under a shared name came back as
      // ZERO under `$eq` while still appearing under `$neq`.
      const store = makeStore();
      const bridge = makeSubjectColumnBridge(store);
      store.findOrCreate({ kind: 'person', name: 'Anna Meier', aliases: ['Meier'] });
      store.findOrCreate({ kind: 'person', name: 'Bernd Meier', aliases: ['Meier'] });
      expect(() => bridge.resolve('Meier', 'person')).toThrow(/more than one/);
      // It NAMES the candidates — the caller is an agent that can retry with a full name.
      expect(() => bridge.resolve('Meier', 'person')).toThrow(/Anna Meier/);
      expect(store.count({ kinds: ['person'] })).toBe(2);   // the attempt wrote nothing
    });

    it('the WRITE half still resolves an unambiguous name', () => {
      const store = makeStore();
      const bridge = makeSubjectColumnBridge(store);
      const a = store.findOrCreate({ kind: 'person', name: 'Anna Meier', aliases: ['Anna'] });
      expect(bridge.resolve('Anna', 'person')).toBe(idOf(a));
    });

    it('returns EVERY candidate for a shared name — the caller decides the polarity', () => {
      // A single id cannot express a shared name, and every single-value encoding
      // of it is wrong in one polarity. Collapsing to null let the caller substitute
      // a sentinel that matches nothing: right under `$eq`, but under `$neq`/`$nin`
      // it reads "not equal to a thing that does not exist" and matches EVERY row,
      // so an exclusion silently stopped excluding. Refusing outright was the first
      // fix and was worse in the other direction — it also fired for the polarity
      // that was already correct. The set is the only faithful answer.
      const store = makeStore();
      const bridge = makeSubjectColumnBridge(store);
      const a = store.findOrCreate({ kind: 'person', name: 'Anna Meier', aliases: ['Meier'] });
      const b = store.findOrCreate({ kind: 'person', name: 'Bernd Meier', aliases: ['Meier'] });
      expect(bridge.findAll('Meier', 'person').slice().sort()).toEqual([a.id, b.id].sort());
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
