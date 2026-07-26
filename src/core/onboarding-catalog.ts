/**
 * Onboarding Wave 1 — the Step-0 knowledge catalog (D9v2, PRD-ONBOARDING §3/§6.1).
 *
 * The "clean phase" identity basics the ENGINE poses VERBATIM before any web_research
 * taints the thread. Scope is deliberately just IDENTITY FACTS the user always knows
 * (who they are, what they run) — NOT their goal. Asking "what do you want lynox to do?"
 * cold is goal-extraction, which the Activation Principle (POSITIONING.md) rejects: a new
 * user rarely knows yet, and the answer is vague. The goal/pain instead emerges GROUNDED
 * in the scan-informed questions (ONBOARDING_CONTEXT[1]), where the user reacts to
 * concrete prompts rather than generating an abstract goal.
 * Engine-posed (never model-composed) is the security property:
 * the question text is fixed here in code, so an injection can neither compose the
 * question (the dictation attack, D5) nor alter the promoted answer. The answers are
 * promoted verbatim to `user_asserted` on a clean-latch thread by
 * `onboarding-promotion.ts` (§6.1).
 *
 * `label` is the language-STABLE dedup key (AC-1.6, exact key-match, NOT semantic):
 * the promoted fact is `${label}: ${answer}`, and a re-onboarding skips a key whose
 * `${label}: ` prefix already has an active entry. English + stable, so a locale
 * switch between runs cannot defeat dedup. `question` is localized (rendered to the
 * user); `label` is not (an internal key that never reaches the UI as prose).
 */

export type OnboardingBasicKey = 'company' | 'role';

export const ONBOARDING_BASIC_KEYS: readonly OnboardingBasicKey[] = ['company', 'role'] as const;

export function isOnboardingBasicKey(s: string): s is OnboardingBasicKey {
  return (ONBOARDING_BASIC_KEYS as readonly string[]).includes(s);
}

export interface OnboardingBasic {
  readonly key: OnboardingBasicKey;
  /** The VERBATIM engine-posed question, localized (rendered to the user). */
  readonly question: { readonly en: string; readonly de: string };
  /** Language-STABLE fact + dedup key — the promoted fact is `${label}: ${answer}`. */
  readonly label: string;
  /** Subject attribution for the DK write (company → an `organization` subject). */
  readonly subjectKind?: 'organization' | undefined;
}

export const ONBOARDING_BASICS: readonly OnboardingBasic[] = [
  {
    key: 'company',
    question: {
      en: 'What is the name of your company or business?',
      de: 'Wie heißt dein Unternehmen bzw. dein Geschäft?',
    },
    label: 'Company',
    subjectKind: 'organization',
  },
  {
    key: 'role',
    question: {
      en: 'What is your role there?',
      de: 'Was ist deine Rolle dort?',
    },
    label: 'Role',
  },
] as const;

/** The verbatim question text for a locale (`'de'` → German, anything else → English). */
export function onboardingBasicQuestion(basic: OnboardingBasic, lang: string): string {
  return lang === 'de' ? basic.question.de : basic.question.en;
}
