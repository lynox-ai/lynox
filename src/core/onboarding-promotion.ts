/**
 * Onboarding Wave 1 — the §6.1 engine promotion module (D9v2). THE onboarding
 * security boundary.
 *
 * Writes each Step-0 answer VERBATIM as a durable-knowledge entry:
 *   - CLEAN-latch thread (`sawUntrusted === false`) → `sourceChannel: 'user'` →
 *     `user_asserted` (provenance rule 2). This is the ONLY conversational path
 *     that mints `user_asserted` — the engine is the writer, the model is never in
 *     it, so the promoted text is provably the user's typed answer (AC-1.3a).
 *   - TAINTED thread (`sawUntrusted === true`) → `sourceUntrusted: true` →
 *     `pending_review` (provenance rule 1 OUTRANKS the channel — the operator may be
 *     relaying attacker text; the dictation attack, D5). Defense in depth: Step-0 is
 *     clean by construction, but if the latch is somehow armed the answer is queued,
 *     never trusted-written.
 *
 * Dedup is EXACT label-prefix (AC-1.6, never semantic): a re-onboarding whose key
 * already has an active fact skips — "same semantics as a re-run" (§3). Every entry
 * carries `source_thread_id` = the onboarding thread (AC-1.10, the mass-repair link).
 *
 * A PURE function (deps injected) so the boundary is unit-tested without a Session or
 * HTTP. Telemetry (the funnel events) is emitted by the endpoint, not here — this
 * module only writes knowledge.
 */

import type { KnowledgeStore } from './knowledge-store.js';
import { ONBOARDING_BASICS, type OnboardingBasicKey } from './onboarding-catalog.js';

export interface OnboardingBasicAnswer {
  readonly key: OnboardingBasicKey;
  readonly answer: string;
}

export interface PromoteOnboardingDeps {
  readonly knowledgeStore: KnowledgeStore;
  /** The conversation clean-latch at promotion time. TRUE routes every answer to
   *  `pending_review` (rule 1 taint) instead of `user_asserted` (defense in depth). */
  readonly sawUntrusted: boolean;
  /** The onboarding thread-id → `source_thread_id` on every written entry (AC-1.10). */
  readonly threadId: string;
}

export interface PromoteOnboardingResult {
  /** Written as `user_asserted` active (a clean-latch thread). */
  readonly promoted: number;
  /** Routed to `pending_review` (a tainted thread — defense-in-depth path). */
  readonly queued: number;
  /** Deduped — the key already had an active fact (AC-1.6). */
  readonly skipped: number;
  /** Refused — the answer looked like a secret/credential (never stored). */
  readonly rejected: number;
}

const CATALOG = new Map(ONBOARDING_BASICS.map(basic => [basic.key, basic] as const));

export function promoteOnboardingBasics(
  answers: readonly OnboardingBasicAnswer[],
  deps: PromoteOnboardingDeps,
): PromoteOnboardingResult {
  let promoted = 0;
  let queued = 0;
  let skipped = 0;
  let rejected = 0;

  for (const { key, answer } of answers) {
    const basic = CATALOG.get(key);
    if (!basic) continue; // unknown key — ignore (also guarded at insert; defense in depth)
    const value = answer.trim();
    if (!value) continue; // an empty / skipped answer writes nothing

    // Secret-shape gate — write() does NOT scan, and this promotion writes DIRECTLY. A
    // credential-shaped answer (an IBAN typed into "company" via the dictation residual,
    // S1b) must never land agent-readable in recall. Mirrors the remember/approve guard.
    if (deps.knowledgeStore.looksLikeSecret(value)) {
      rejected++;
      continue;
    }

    const prefix = `${basic.label}: `;
    // AC-1.6 exact key-match dedup (NOT semantic): the engine-fixed label prefix is
    // plain text (never masked), so a re-onboarding whose key already has an active
    // fact skips — corrections go through chat, not a re-run (§3, D11).
    if (deps.knowledgeStore.hasActiveFactWithPrefix(prefix)) {
      skipped++;
      continue;
    }

    const result = deps.knowledgeStore.write({
      text: `${prefix}${value}`, // engine-fixed label + the VERBATIM answer
      // The FIRST `user`-channel producer (see provenance.ts). Clean latch → rule 2 →
      // user_asserted; a tainted latch → sourceUntrusted → rule 1 → pending_review.
      sourceChannel: 'user',
      sourceUntrusted: deps.sawUntrusted,
      sourceThreadId: deps.threadId,
      kind: 'fact',
      ...(basic.subjectKind ? { subjectName: value, subjectKind: basic.subjectKind } : {}),
    });

    if (result.status === 'active') promoted++;
    else queued++;
  }

  return { promoted, queued, skipped, rejected };
}
