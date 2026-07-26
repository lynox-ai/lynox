import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_BASICS,
  ONBOARDING_BASIC_KEYS,
  isOnboardingBasicKey,
  onboardingBasicQuestion,
} from './onboarding-catalog.js';

describe('onboarding-catalog (Step-0 basics, D9v2)', () => {
  it('holds exactly the three Step-0 keys, in order', () => {
    expect(ONBOARDING_BASIC_KEYS).toEqual(['company', 'role', 'goal']);
    expect(ONBOARDING_BASICS.map(b => b.key)).toEqual(['company', 'role', 'goal']);
  });

  it('every basic has a localized question and a stable (non-empty) label', () => {
    for (const b of ONBOARDING_BASICS) {
      expect(b.question.en.length).toBeGreaterThan(0);
      expect(b.question.de.length).toBeGreaterThan(0);
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  it('labels are unique — the dedup key must not collide across basics (AC-1.6)', () => {
    const labels = ONBOARDING_BASICS.map(b => b.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('labels are ASCII/English-stable (language-independent dedup key)', () => {
    for (const b of ONBOARDING_BASICS) {
      // eslint-disable-next-line no-control-regex
      expect(b.label).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it('only company carries a subject kind (organization)', () => {
    expect(ONBOARDING_BASICS.find(b => b.key === 'company')!.subjectKind).toBe('organization');
    expect(ONBOARDING_BASICS.find(b => b.key === 'role')!.subjectKind).toBeUndefined();
    expect(ONBOARDING_BASICS.find(b => b.key === 'goal')!.subjectKind).toBeUndefined();
  });

  it('isOnboardingBasicKey narrows only the catalog keys', () => {
    expect(isOnboardingBasicKey('company')).toBe(true);
    expect(isOnboardingBasicKey('role')).toBe(true);
    expect(isOnboardingBasicKey('goal')).toBe(true);
    expect(isOnboardingBasicKey('payment')).toBe(false);
    expect(isOnboardingBasicKey('')).toBe(false);
  });

  it('onboardingBasicQuestion picks DE for "de" and EN for anything else', () => {
    const company = ONBOARDING_BASICS[0]!;
    expect(onboardingBasicQuestion(company, 'de')).toBe(company.question.de);
    expect(onboardingBasicQuestion(company, 'en')).toBe(company.question.en);
    expect(onboardingBasicQuestion(company, 'fr')).toBe(company.question.en); // fallback
  });
});
