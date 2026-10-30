/**
 * The escalation-notice kinds (`src/contract/http.ts`).
 *
 * Pinned as an exact list because it crosses a repo boundary: the engine sends a
 * kind, and the control plane accepts it and picks the mail text by it. A kind the
 * engine sends that the control plane does not know is answered with 400, and then
 * the owner gets no mail at all.
 */
import { describe, it, expect } from 'vitest';
import { ESCALATION_NOTICE_KINDS, isEscalationNoticeKind } from '../src/contract/http.js';
import type { EscalationNoticeRequest } from '../src/contract/http.js';

describe('the escalation-notice kinds', () => {
  it('are exactly an escalation and a waiting question, in that order', () => {
    expect([...ESCALATION_NOTICE_KINDS]).toEqual(['escalation', 'question']);
  });

  it('the guard accepts each kind and nothing near it', () => {
    for (const kind of ESCALATION_NOTICE_KINDS) expect(isEscalationNoticeKind(kind)).toBe(true);
    for (const value of ['Escalation', 'question ', 'questions', '', 'provider_billing', undefined, null, 1, ['question'], { kind: 'question' }]) {
      expect(isEscalationNoticeKind(value), JSON.stringify(value) ?? String(value)).toBe(false);
    }
  });

  it('a request body carries the kind and nothing else', () => {
    const body: EscalationNoticeRequest = { kind: 'question' };
    expect(JSON.parse(JSON.stringify(body))).toEqual({ kind: 'question' });
  });
});
