import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { KnowledgeStore } from './knowledge-store.js';

/**
 * `DEF-dk-trust-gate-consistency` (d): the approve path must DERIVE the tier it stores, not
 * assert it.
 *
 * Its own file because the assertion needs the derivation to answer something other than
 * `user_asserted`, which is only reachable by replacing the module — and a module mock poisons
 * every other test in its file. The sibling tests in `knowledge-store.test.ts` pin the OUTCOME
 * (stored tier equals what the evidence re-derives to); this one pins the WIRING, which that
 * outcome cannot distinguish while both sides happen to produce the same value.
 *
 * The defect it guards is ordinary and slow: someone changes rule 0 — approval becomes
 * `tool_verified`, say — and the approve path keeps writing its literal, so every approved row
 * from then on stores a tier its own evidence contradicts. That is exactly the drift (d) is
 * about, re-introduced by the fix for (d).
 */
vi.mock('./provenance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provenance.js')>();
  return {
    ...actual,
    deriveProvenanceTier: vi.fn((ev: import('./provenance.js').ProvenanceEvidence) =>
      (ev.reviewApproved === true ? 'tool_verified' : actual.deriveProvenanceTier(ev))),
  };
});

describe('approve stores the DERIVED tier, not a literal', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.restoreAllMocks();
  });

  it('a changed rule 0 moves the stored tier with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-approve-derive-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-approve');
    const ks = new KnowledgeStore(engine, new SubjectStore(engine));

    const id = ks.write({
      text: 'ACME pays via IBAN CHXX.', subjectName: 'ACME',
      sourceChannel: 'agent', sourceUntrusted: true,
    }).id;
    // Untrusted → queued, and the queued tier still comes from the real rules (rule 0 does not
    // apply yet), so the fixture cannot pass by the mock alone.
    expect(ks.getEntry(id)!.sourceType).toBe('external_unverified');

    // Under the stand-in rule 0 an approval derives `tool_verified`. A hardcoded
    // `'user_asserted'` in the approve UPDATE fails here; deriving follows.
    expect(ks.reviewEntry(id, 'approve')!.sourceType).toBe('tool_verified');
    expect(ks.reviewEntry(ks.write({
      text: 'ACME renews in March.', subjectName: 'ACME',
      sourceChannel: 'agent', sourceUntrusted: true,
    }).id, 'edit_approve', 'ACME renews every March.')!.sourceType).toBe('tool_verified');

    engine.close();
  });
});
