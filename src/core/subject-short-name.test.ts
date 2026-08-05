/**
 * Short-form organisation resolution — `Nordfeld` must reach `Nordfeld GmbH`.
 *
 * Measured on a live engine 2026-08-05: the model called `recall({subject: "Nordfeld"})` — the
 * argument the DK prompt tells it to pass — against a store that HELD the fact, and the store
 * answered "no matching durable knowledge". Same query with the subject omitted returned it.
 * The refusal itself is correct (an unresolved explicit subject must NOT fall back to a global
 * scan; that is how one client's facts would surface under another's name). What was wrong is
 * that the legal-form suffix made the name unresolvable at all.
 *
 * The engagement kind has had the mirror-image of this since the start — `normalizeSubjectName`
 * strips a leading "Projekt", which is why "Aurora" resolves while "Nordfeld" does not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore, organisationShortForm } from './subject-store.js';

describe('organisationShortForm', () => {
  it('strips a trailing legal form', () => {
    expect(organisationShortForm('Nordfeld GmbH')).toBe('Nordfeld');
    expect(organisationShortForm('Talbach AG')).toBe('Talbach');
    expect(organisationShortForm('Seewald & Partner Ltd.')).toBe('Seewald & Partner');
  });

  it('reaches beyond the home market', () => {
    // A German-only list would be a home-market default; the product is not CH/DE-scoped.
    expect(organisationShortForm('Meridian S.p.A.')).toBe('Meridian');
    expect(organisationShortForm('Bregenz B.V.')).toBe('Bregenz');
    expect(organisationShortForm('Lindau Oy')).toBe('Lindau');
    expect(organisationShortForm('Aurora Pty Ltd')).toBe('Aurora');
  });

  it('returns null when there is nothing to strip', () => {
    expect(organisationShortForm('Nordfeld')).toBeNull();
    expect(organisationShortForm('Stadtwerke Lindau')).toBeNull();
  });

  it('refuses to strip a name down to nothing', () => {
    // A subject legitimately CALLED "AG" or "Holding GmbH" must not collapse to '' and then
    // match everything — the empty string is a substring of every name.
    expect(organisationShortForm('GmbH')).toBeNull();
    expect(organisationShortForm('AG')).toBeNull();
    // The reachable shape: the boundary character is part of the name, so the match consumes
    // the whole string. A bare legal form cannot hit this (trim removes the leading space),
    // which is why the case has to be written out rather than assumed.
    expect(organisationShortForm(', GmbH')).toBeNull();
  });

  it('does not strip a legal form that is merely the TAIL of a word', () => {
    // The examples have to actually END in a legal-form string, or they prove nothing: an
    // earlier version of this test used "AGRA" and "Inconso", which pass with or without the
    // token boundary because neither ends in one. "Cisco" ends in `co` and "Sonntag" in `ag`.
    expect(organisationShortForm('Cisco')).toBeNull();
    expect(organisationShortForm('Sonntag')).toBeNull();
    // …and the boundary must not swallow a hyphen either — "Nord-AG" is one token to a reader.
    expect(organisationShortForm('Ferienhaus-AG')).toBeNull();
  });
});

describe('SubjectStore.findByShortFormResolved', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function make(): SubjectStore {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-shortform-'));
    tmpDirs.push(dir);
    return new SubjectStore(new EngineDb(join(dir, 'engine.db'), ''));
  }

  it('resolves the short name to the one subject that carries it', () => {
    const s = make();
    const id = s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    const hit = s.findByShortFormResolved('Nordfeld', 'organization');
    expect(hit.ambiguous).toBe(false);
    expect(hit.row?.id).toBe(id);
  });

  it('reports AMBIGUOUS rather than picking one when two legal forms share a short name', () => {
    // The whole point of the split return. Returning either row here would answer a question
    // the store cannot answer — and would show one client's facts under another client's name.
    const s = make();
    s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    s.createSubject({ kind: 'organization', name: 'Nordfeld AG' });
    const hit = s.findByShortFormResolved('Nordfeld', 'organization');
    expect(hit.ambiguous).toBe(true);
    expect(hit.row).toBeNull();
    expect(hit.ids).toHaveLength(2);
  });

  it('matches the caller\'s own legal form against the stored one', () => {
    // Symmetry: the stored name may be the SHORT one and the query the long one.
    const s = make();
    const id = s.createSubject({ kind: 'organization', name: 'Nordfeld' });
    expect(s.findByShortFormResolved('Nordfeld GmbH', 'organization').row?.id).toBe(id);
  });

  it('ignores archived subjects', () => {
    const s = make();
    const id = s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    s.archiveSubject(id);
    expect(s.findByShortFormResolved('Nordfeld', 'organization').row).toBeNull();
  });

  it('does not cross the kind boundary', () => {
    const s = make();
    s.createSubject({ kind: 'organization', name: 'Nordfeld GmbH' });
    expect(s.findByShortFormResolved('Nordfeld', 'person').row).toBeNull();
  });
});
