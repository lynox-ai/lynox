import { describe, it, expect } from 'vitest';
import { deriveProvenanceTier } from './provenance.js';
import { ALL_PROVENANCE_KINDS } from '../types/memory.js';

describe('deriveProvenanceTier (§3, first-match-wins, resolves downward)', () => {
  it('rule 1: sourceUntrusted outranks EVERY channel', () => {
    for (const ch of ['user', 'ui', 'agent', 'upload', undefined, 'weird']) {
      expect(deriveProvenanceTier({ sourceChannel: ch, sourceUntrusted: true }))
        .toBe('external_unverified');
    }
  });

  it('rule 2: first-party human channels → user_asserted (when not untrusted)', () => {
    expect(deriveProvenanceTier({ sourceChannel: 'user' })).toBe('user_asserted');
    expect(deriveProvenanceTier({ sourceChannel: 'ui' })).toBe('user_asserted');
    expect(deriveProvenanceTier({ sourceChannel: 'user', sourceUntrusted: false })).toBe('user_asserted');
  });

  it('rule 3: upload → external_unverified', () => {
    expect(deriveProvenanceTier({ sourceChannel: 'upload' })).toBe('external_unverified');
  });

  it('rule 4: agent channel on a clean turn → agent_inferred (the bulk tier)', () => {
    // Regression guard for the V5.3 blocker: a "fully specified" function that
    // never produced agent_inferred would have floored 886/893 rows.
    expect(deriveProvenanceTier({ sourceChannel: 'agent' })).toBe('agent_inferred');
    expect(deriveProvenanceTier({ sourceChannel: 'agent', sourceUntrusted: false })).toBe('agent_inferred');
  });

  it('rule 5: absent OR unknown channel → external_unverified (fail-closed)', () => {
    expect(deriveProvenanceTier({})).toBe('external_unverified');
    expect(deriveProvenanceTier({ sourceChannel: undefined })).toBe('external_unverified');
    expect(deriveProvenanceTier({ sourceChannel: 'trigger' })).toBe('external_unverified');
    expect(deriveProvenanceTier({ sourceChannel: '' })).toBe('external_unverified');
  });

  it('never derives tool_verified — it is reserved, not produced (§3/§10.3)', () => {
    const derivable = new Set<string>();
    for (const ch of ['user', 'ui', 'agent', 'upload', 'unknown', undefined]) {
      for (const u of [true, false, undefined]) {
        derivable.add(deriveProvenanceTier({ sourceChannel: ch, sourceUntrusted: u }));
      }
    }
    expect(derivable.has('tool_verified')).toBe(false);
    // But the enum literal still exists (vocabulary + forgery guard).
    expect(ALL_PROVENANCE_KINDS).toContain('tool_verified');
  });

  it('every output is a valid ProvenanceKind (totality)', () => {
    for (const ch of ['user', 'ui', 'agent', 'upload', 'x', undefined]) {
      for (const u of [true, false, undefined]) {
        expect(ALL_PROVENANCE_KINDS).toContain(deriveProvenanceTier({ sourceChannel: ch, sourceUntrusted: u }));
      }
    }
  });

  it('reproduces the live rafael distribution mapping (886 agent / 6 user / upload)', () => {
    // The extractor + floored memory_store write channel=agent → agent_inferred (886).
    expect(deriveProvenanceTier({ sourceChannel: 'agent' })).toBe('agent_inferred');
    // The UI memory-facade writes channel=ui → user_asserted (the 6).
    expect(deriveProvenanceTier({ sourceChannel: 'ui' })).toBe('user_asserted');
    // document-ingest writes channel=upload, untrusted → external_unverified.
    expect(deriveProvenanceTier({ sourceChannel: 'upload', sourceUntrusted: true })).toBe('external_unverified');
  });
});
