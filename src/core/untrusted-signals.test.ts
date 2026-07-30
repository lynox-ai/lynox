import { describe, it, expect } from 'vitest';
import { deriveTurnUntrusted, describeTurnUntrusted } from './untrusted-signals.js';
import type { UntrustedSignals } from './untrusted-signals.js';

describe('deriveTurnUntrusted (the canonical write-trust / taint union)', () => {
  it('is false when no signal is set (clean business turn)', () => {
    expect(deriveTurnUntrusted({})).toBe(false);
    expect(deriveTurnUntrusted({ sawUntrustedData: false, sawExternalContentTool: false, conversationSawUntrusted: false })).toBe(false);
  });

  it('is true on the bare wrap marker', () => {
    expect(deriveTurnUntrusted({ sawUntrustedData: true })).toBe(true);
  });

  it('is true when an external-content tool ran this turn (the allowlist-by-omission hole the union closes)', () => {
    // The wrap marker is FALSE — web_research/mail/read_file/bash set no marker. The union must
    // still taint, or external-derived content rides out as trusted.
    expect(deriveTurnUntrusted({ sawUntrustedData: false, sawExternalContentTool: true })).toBe(true);
  });

  it('is true on the conversation-sticky signal alone (F5 deferred-injection defence)', () => {
    expect(deriveTurnUntrusted({ sawUntrustedData: false, sawExternalContentTool: false, conversationSawUntrusted: true })).toBe(true);
  });

  it('treats undefined signals as not-set (over-taints only in the safe direction)', () => {
    expect(deriveTurnUntrusted({ sawExternalContentTool: undefined })).toBe(false);
  });
});

describe('describeTurnUntrusted (which member of the union fired)', () => {
  // The contract that makes the record usable at all: when the gate says untrusted the log must
  // name a cause, and when it says trusted it must not invent one. Drift here would let the
  // telemetry silently disagree with the decision it exists to explain.
  // MUTATION: return 'none' unconditionally → every tainted combination below breaks.
  it('agrees with the gate on all eight signal combinations', () => {
    for (const marker of [true, false]) {
      for (const tool of [true, false]) {
        for (const conv of [true, false]) {
          const s: UntrustedSignals = {
            sawUntrustedData: marker,
            sawExternalContentTool: tool,
            conversationSawUntrusted: conv,
          };
          expect(describeTurnUntrusted(s) === 'none').toBe(!deriveTurnUntrusted(s));
        }
      }
    }
  });

  // MUTATION: test `conversationSawUntrusted` first. Every later turn of a tainted thread then
  // reports 'conversation' and the two INHERENT causes disappear from the data — which would
  // answer "what does the sticky half cost?" with a number that is 100% by construction.
  it('reports the most specific cause when several signals hold at once', () => {
    expect(describeTurnUntrusted({
      sawUntrustedData: true, sawExternalContentTool: true, conversationSawUntrusted: true,
    })).toBe('marker');
    expect(describeTurnUntrusted({
      sawExternalContentTool: true, conversationSawUntrusted: true,
    })).toBe('external-tool');
  });

  // The measurement this record exists for: a turn whose OWN signals are clean, tainted only
  // because the conversation was tainted earlier. MUTATION: drop the conversation branch → this
  // reads 'none' while the gate still routes to review, i.e. an unexplainable queue entry.
  it('isolates the sticky (F5) cause from the inherent ones', () => {
    expect(describeTurnUntrusted({ conversationSawUntrusted: true })).toBe('conversation');
  });

  it('reports none on a clean turn, and treats an absent signal as not-set', () => {
    expect(describeTurnUntrusted({})).toBe('none');
    expect(describeTurnUntrusted({ sawUntrustedData: undefined, conversationSawUntrusted: true })).toBe('conversation');
  });
});
