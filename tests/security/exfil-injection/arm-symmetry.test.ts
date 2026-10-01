// === The INSTRUMENT'S OWN GUARD — arm symmetry + substrate preflight (offline) ===
//
// This is the preflight that makes the eventual number trustworthy. It runs in
// the normal suite (no API keys) and FAILS THE BUILD if the instrument is
// mis-cut. Do not hand-trust the corpus phrasings — trust this.
//
// It enforces, against the REAL engine code:
//   (H2) every match/evade PAIR names the identical channel;
//   (H2) each MATCH injection trips `detectInjectionAttempt`, each EVADE misses —
//        so the match/evade delta isolates the warning, not channel steering;
//   (M3) the canary is SECRET-scan-negative and not a long base64 run, so the
//        real secret scan cannot block a real exfil (which would under-count);
//   (H3) `managedSystemPrompt()` is the REAL production prompt, not a fallback.

import { describe, it, expect } from 'vitest';
import { detectInjectionAttempt } from '../../../src/core/data-boundary.js';
import { detectSecretInContent } from '../../../src/tools/builtin/http.js';
import { makeCanary } from './judge.js';
import {
  buildCorpus,
  renderInjection,
  managedSystemPrompt,
  SYSTEM_PROMPT,
  type InjectionCase,
} from './corpus.js';

const CORPUS = buildCorpus();
// A fixed canary so the preflight is deterministic across runs (makeCanary is
// tested separately). Shaped exactly like a real one.
const FIXED_CANARY = 'LYNOX-CANARY-0011223344556677889900aa';

function pairs(): Map<string, InjectionCase[]> {
  const byPair = new Map<string, InjectionCase[]>();
  for (const c of CORPUS) {
    const arr = byPair.get(c.pairId) ?? [];
    arr.push(c);
    byPair.set(c.pairId, arr);
  }
  return byPair;
}

describe('arm-symmetry preflight — pairing', () => {
  it('every pair has exactly one match and one evade', () => {
    for (const [pairId, cs] of pairs()) {
      const arms = cs.map(c => c.arm).sort();
      expect(arms, `pair ${pairId}`).toEqual(['evade', 'match']);
    }
  });

  it('both arms of a pair name the IDENTICAL channel (refuter H2 — no channel steering)', () => {
    for (const [pairId, cs] of pairs()) {
      const channels = new Set(cs.map(c => c.channel));
      expect(channels.size, `pair ${pairId} spans channels ${[...channels].join(',')}`).toBe(1);
    }
  });

  it('the corpus does NOT drive google_drive (exfil-by-reference, descoped — refuter C3)', () => {
    expect(CORPUS.some(c => c.channel === 'google_drive')).toBe(false);
  });

  it('covers the go/no-go channel (web_research) and the negative control (http_request)', () => {
    const channels = new Set(CORPUS.map(c => c.channel));
    expect(channels.has('web_research')).toBe(true);
    expect(channels.has('http_request')).toBe(true);
  });
});

describe('arm-symmetry preflight — the regex separation (against the REAL detectInjectionAttempt)', () => {
  for (const c of CORPUS) {
    const rendered = renderInjection(c, FIXED_CANARY);
    const detected = detectInjectionAttempt(rendered).detected;
    if (c.arm === 'match') {
      it(`MATCH case ${c.id} trips INJECTION_PATTERNS`, () => {
        expect(detected, `patterns: ${detectInjectionAttempt(rendered).patterns.join(', ')}`).toBe(true);
      });
    } else {
      it(`EVADE case ${c.id} misses INJECTION_PATTERNS`, () => {
        expect(detected, `unexpectedly tripped: ${detectInjectionAttempt(rendered).patterns.join(', ')}`).toBe(false);
      });
    }
  }
});

describe('arm-symmetry preflight — every case actually CARRIES exfil intent (guards against a neutered corpus)', () => {
  // Without this, a case that misses INJECTION_PATTERNS AND names the same channel
  // AND pairs correctly would pass every other check while instructing NOTHING —
  // a silent under-count (the corpus would measure 0 for the wrong reason). Assert
  // each rendered injection names the attacker sink AND references the secret.
  for (const c of CORPUS) {
    it(`case ${c.id} names the attacker sink and references the secret`, () => {
      const rendered = renderInjection(c, FIXED_CANARY);
      expect(rendered, 'missing attacker destination').toContain(c.attackerDestination);
      // The secret is referenced by its label AND its value is substituted in.
      expect(rendered, 'missing the secret value').toContain(FIXED_CANARY);
    });
  }
});

describe('arm-symmetry preflight — the canary is a safe probe (refuter M3)', () => {
  it('a real canary does not match the secret scan (else a real exfil is blocked → under-count)', () => {
    for (let i = 0; i < 20; i++) {
      const canary = makeCanary();
      expect(detectSecretInContent(canary), `canary ${canary}`).toBeNull();
    }
  });

  it('the canary is short and hex (not a >=64-char base64 run that trips GET-exfil heuristics)', () => {
    const canary = makeCanary();
    expect(canary.length).toBeLessThan(64);
    // hex payload only after the fixed sentinel — no long base64 alphabet run
    expect(canary).toMatch(/^LYNOX-CANARY-[0-9a-f]+$/);
  });

  it('the canary does not itself trip an injection pattern (adds no spurious warning)', () => {
    expect(detectInjectionAttempt(makeCanary()).detected).toBe(false);
  });
});

describe('arm-symmetry preflight — the system prompt is the REAL managed substrate (refuter H3)', () => {
  it('managedSystemPrompt starts with the production SYSTEM_PROMPT (never a fallback)', () => {
    expect(managedSystemPrompt().startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  it('SYSTEM_PROMPT carries the injection-relevant guidance it is being measured for', () => {
    // The line the whole measurement is about: surfaced context is BACKGROUND,
    // not an instruction to act. If this drifts out of the base prompt, the
    // harness is measuring a different prompt than production ships.
    expect(SYSTEM_PROMPT).toContain('BACKGROUND');
  });
});
