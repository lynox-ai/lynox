import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { promoteOnboardingBasics, type OnboardingBasicAnswer } from './onboarding-promotion.js';
import type { OnboardingBasicKey } from './onboarding-catalog.js';

/**
 * The §6.1 engine-promotion boundary (Onboarding Wave 1, D9v2). Uses the REAL
 * KnowledgeStore + EngineDb — the tier derivation and routing are the exact
 * production paths, not a mock.
 */
describe('promoteOnboardingBasics — §6.1 engine promotion boundary', () => {
  const tmpDirs: string[] = [];
  function makeKs(): { ks: KnowledgeStore; subjects: SubjectStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-onb-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const subjects = new SubjectStore(engine);
    return { ks: new KnowledgeStore(engine, subjects), subjects };
  }
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const THREAD = 'thread-onboarding-1';

  it('a CLEAN-latch answer → user_asserted active, verbatim under the catalog label + source_thread_id (AC-1.3a/1.10)', () => {
    const { ks } = makeKs();
    const r = promoteOnboardingBasics(
      [{ key: 'company', answer: 'Acme GmbH' }],
      { knowledgeStore: ks, sawUntrusted: false, threadId: THREAD },
    );
    expect(r).toEqual({ promoted: 1, queued: 0, skipped: 0, rejected: 0 });
    const active = ks.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.text).toBe('Company: Acme GmbH'); // engine label + VERBATIM answer
    expect(active[0]!.sourceType).toBe('user_asserted');
    expect(active[0]!.sourceChannel).toBe('user'); // the first 'user'-channel producer
    expect(active[0]!.sourceThreadId).toBe(THREAD); // AC-1.10 identifiability
  });

  it('all three basics promote; company mints an organization subject', () => {
    const { ks, subjects } = makeKs();
    const answers: OnboardingBasicAnswer[] = [
      { key: 'company', answer: 'Nordberg AG' },
      { key: 'role', answer: 'Marketing lead' },
      { key: 'goal', answer: 'automate invoicing' },
    ];
    const r = promoteOnboardingBasics(answers, { knowledgeStore: ks, sawUntrusted: false, threadId: THREAD });
    expect(r.promoted).toBe(3);
    const texts = ks.listActive().map(e => e.text).sort();
    expect(texts).toEqual(['Company: Nordberg AG', 'Primary goal: automate invoicing', 'Role: Marketing lead']);
    // company carries subject attribution (H1 findOrCreate on an active write)
    expect(subjects.findCanonical('Nordberg AG', 'organization')).not.toBeNull();
  });

  it('a TAINTED latch routes every answer to pending_review, never user_asserted (D5 defense in depth)', () => {
    const { ks } = makeKs();
    const r = promoteOnboardingBasics(
      [{ key: 'company', answer: 'Acme GmbH' }],
      { knowledgeStore: ks, sawUntrusted: true, threadId: THREAD },
    );
    expect(r).toEqual({ promoted: 0, queued: 1, skipped: 0, rejected: 0 });
    expect(ks.listActive()).toHaveLength(0);      // nothing trusted-written
    expect(ks.pendingCount()).toBe(1);            // it landed in the review queue
    // and the queued row still carries the onboarding thread (AC-1.10 holds on both paths)
    expect(ks.listPending()[0]!.sourceThreadId).toBe(THREAD);
  });

  it('dedup is EXACT key-match (AC-1.6): a re-run of the same key skips, even with a CHANGED value', () => {
    const { ks } = makeKs();
    promoteOnboardingBasics([{ key: 'company', answer: 'Acme' }], { knowledgeStore: ks, sawUntrusted: false, threadId: THREAD });
    // Re-onboarding with a corrected value — same key. Skipped (key-match, NOT value/semantic).
    const r2 = promoteOnboardingBasics([{ key: 'company', answer: 'Acme AG' }], { knowledgeStore: ks, sawUntrusted: false, threadId: 'thread-2' });
    expect(r2).toEqual({ promoted: 0, queued: 0, skipped: 1, rejected: 0 });
    const active = ks.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.text).toBe('Company: Acme'); // the original stands; corrections go via chat (§3/D11)
  });

  it('dedup is per-key: a different key still writes while a known key skips', () => {
    const { ks } = makeKs();
    promoteOnboardingBasics([{ key: 'company', answer: 'Acme' }], { knowledgeStore: ks, sawUntrusted: false, threadId: THREAD });
    const r2 = promoteOnboardingBasics(
      [{ key: 'company', answer: 'Acme' }, { key: 'role', answer: 'CEO' }],
      { knowledgeStore: ks, sawUntrusted: false, threadId: THREAD },
    );
    expect(r2).toEqual({ promoted: 1, queued: 0, skipped: 1, rejected: 0 });
    expect(ks.listActive().map(e => e.text).sort()).toEqual(['Company: Acme', 'Role: CEO']);
  });

  it('an empty / whitespace answer writes nothing', () => {
    const { ks } = makeKs();
    const r = promoteOnboardingBasics(
      [{ key: 'company', answer: '   ' }, { key: 'role', answer: '' }],
      { knowledgeStore: ks, sawUntrusted: false, threadId: THREAD },
    );
    expect(r).toEqual({ promoted: 0, queued: 0, skipped: 0, rejected: 0 });
    expect(ks.listActive()).toHaveLength(0);
  });

  it('SECURITY: a credential-shaped answer is REFUSED, never stored (write() has no shape scan)', () => {
    const { ks } = makeKs();
    // An API key typed into "company" (the S1b dictation residual) must not land in recall.
    const r = promoteOnboardingBasics(
      [{ key: 'company', answer: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
      { knowledgeStore: ks, sawUntrusted: false, threadId: THREAD },
    );
    expect(r).toEqual({ promoted: 0, queued: 0, skipped: 0, rejected: 1 });
    expect(ks.listActive()).toHaveLength(0);
  });

  it('an unknown key is ignored (defense in depth — the insert path is engine-only)', () => {
    const { ks } = makeKs();
    const r = promoteOnboardingBasics(
      [{ key: 'payment_iban' as OnboardingBasicKey, answer: 'CH93 0000' }],
      { knowledgeStore: ks, sawUntrusted: false, threadId: THREAD },
    );
    expect(r).toEqual({ promoted: 0, queued: 0, skipped: 0, rejected: 0 });
    expect(ks.listActive()).toHaveLength(0);
  });
});
