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
 *     relaying attacker text; the dictation attack, D5).
 *
 * The taint latch is a BEST-EFFORT SECONDARY signal, not the primary control. The caller
 * reads it from the live in-memory session, so an evicted / not-rehydrated session reads
 * clean (fails OPEN, not queued). That is acceptable because the PRIMARY trust anchor is
 * that the value is ENGINE-MEDIATED — the model never touches it (engine-posed question +
 * verbatim PromptStore answer), so a clean read is first-party by the data path regardless
 * of the latch. The latch only ADDS S1b-dictation defence-in-depth when it is observed
 * armed; its absence never weakens the data-path guarantee.
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
  /** The conversation clean-latch at promotion time — a BEST-EFFORT secondary signal
   *  (the caller reads the live session; an evicted one reads clean → fails open). TRUE
   *  routes an answer to `pending_review` (rule 1 taint). The PRIMARY anchor is that the
   *  value is engine-mediated (model never touched it), NOT this latch. */
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

/** The canonical skip marker the tabs answer path emits for an unanswered question
 *  (http-api.ts). It is NON-empty, so a skipped basic must be filtered explicitly —
 *  otherwise it promotes as a literal `"Company: __dismissed__"` fact. */
const ONBOARDING_SKIP_MARKER = '__dismissed__';

/** Reject an answer longer than this (count `rejected`) BEFORE `write()` throws at its
 *  8000-char store limit. A mid-loop throw would 500 AND leave a PARTIAL promotion
 *  (earlier answers committed, the oversized one and later ones not) that a retry cannot
 *  complete — dedup skips the committed ones, the oversized one re-throws. A business-fact
 *  basic fits easily; a multi-KB paste is not a basic. */
const MAX_ONBOARDING_ANSWER_CHARS = 2000;

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
    // An empty answer, OR the canonical skip marker for an unanswered tabs question,
    // writes nothing (the marker is non-empty, so it must be filtered explicitly).
    if (!value || value === ONBOARDING_SKIP_MARKER) continue;

    // Length cap BEFORE write() — a mid-loop throw at the 8000-char store limit would
    // 500 and leave a partial, un-retryable promotion.
    if (value.length > MAX_ONBOARDING_ANSWER_CHARS) {
      rejected++;
      continue;
    }

    // Secret-shape gate — write() does NOT scan, and this promotion writes DIRECTLY. A
    // credential-shaped answer (the dictation residual, S1b) must never land agent-readable
    // in recall. Best-effort: catches vendor keys, JWT/Bearer, 40+ char tokens, and known
    // vault values; it does NOT catch every short non-vendor credential.
    if (deps.knowledgeStore.looksLikeSecret(value)) {
      rejected++;
      continue;
    }

    const prefix = `${basic.label}: `;
    // AC-1.6 exact key-match dedup (NOT semantic): skip when an active fact already starts
    // with this engine-fixed label prefix (plain text, never masked) — "same semantics as a
    // re-run" (§3); corrections go through chat, not a re-run (D11). The scan is GLOBAL: a
    // pre-existing active fact with this prefix (even a lower-trust agent_inferred one)
    // suppresses the write — accepted per AC-1.6 ("skip already-known"); a deliberate upgrade
    // is a chat correction, never a silent re-onboard overwrite.
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
