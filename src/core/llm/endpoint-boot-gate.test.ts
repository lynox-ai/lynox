/**
 * Tests for the engine-boot allowlist gate (Wave 5d).
 *
 * The decision function `evaluateEndpointBootGate` is the unit covered here;
 * Engine wiring (`_enforceEndpointAllowlist`) just dispatches on the decision
 * and writes to stderr / throws — no logic worth re-mocking for.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateEndpointBootGate,
  buildBootRefusalMessage,
  buildBootAcceptedWarning,
} from './endpoint-allowlist.js';

describe('evaluateEndpointBootGate', () => {
  it('allowlisted BASE_URL + no env flag → "allowlisted" (boots silently)', () => {
    expect(evaluateEndpointBootGate('https://api.anthropic.com', undefined)).toBe('allowlisted');
  });

  it('allowlisted BASE_URL + env flag set → still "allowlisted" (flag is a no-op for vetted hosts)', () => {
    expect(evaluateEndpointBootGate('https://api.mistral.ai', 'true')).toBe('allowlisted');
  });

  it('non-allowlisted BASE_URL + no env flag → "refuse"', () => {
    expect(evaluateEndpointBootGate('https://my-litellm.example.com/v1', undefined)).toBe('refuse');
  });

  it('non-allowlisted BASE_URL + LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true → "accepted"', () => {
    expect(evaluateEndpointBootGate('https://my-litellm.example.com/v1', 'true')).toBe('accepted');
  });

  it('non-allowlisted BASE_URL + LYNOX_CUSTOM_ENDPOINT_ACCEPTED=1 → still "refuse" (strict equality with "true")', () => {
    // We want operators to type the literal "true" — bash truthiness ("1", "yes", "on")
    // is too easy to set accidentally via an unrelated env var.
    expect(evaluateEndpointBootGate('https://my-litellm.example.com/v1', '1')).toBe('refuse');
  });

  it('undefined BASE_URL → "skip" (standard Anthropic default host, no disclosure capture needed)', () => {
    expect(evaluateEndpointBootGate(undefined, undefined)).toBe('skip');
  });

  it('null BASE_URL → "skip"', () => {
    expect(evaluateEndpointBootGate(null, undefined)).toBe('skip');
  });

  it('empty / whitespace-only BASE_URL → "skip"', () => {
    expect(evaluateEndpointBootGate('', undefined)).toBe('skip');
    expect(evaluateEndpointBootGate('   ', undefined)).toBe('skip');
  });

  it('localhost BASE_URL → "allowlisted" (self-host dev case)', () => {
    expect(evaluateEndpointBootGate('http://localhost:8080/v1', undefined)).toBe('allowlisted');
  });

  it('Azure OpenAI BASE_URL → "allowlisted"', () => {
    expect(evaluateEndpointBootGate('https://my-deploy.openai.azure.com/openai', undefined)).toBe('allowlisted');
  });
});

describe('buildBootRefusalMessage', () => {
  it('includes the host', () => {
    const msg = buildBootRefusalMessage('https://attacker.example.com/v1');
    expect(msg).toContain('attacker.example.com');
  });

  it('mentions the env-var name so operators know how to opt in', () => {
    const msg = buildBootRefusalMessage('https://attacker.example.com/v1');
    expect(msg).toContain('LYNOX_CUSTOM_ENDPOINT_ACCEPTED');
  });

  it('mentions controller responsibility', () => {
    const msg = buildBootRefusalMessage('https://attacker.example.com/v1');
    expect(msg).toContain('controller-responsibility');
  });

  it('handles malformed BASE_URL gracefully', () => {
    const msg = buildBootRefusalMessage('not-a-url');
    expect(msg).toContain('not-a-url');
    expect(msg).toContain('LYNOX_CUSTOM_ENDPOINT_ACCEPTED');
  });
});

describe('buildBootAcceptedWarning', () => {
  it('includes the host + WARNING marker + disclosure body', () => {
    const msg = buildBootAcceptedWarning('https://my-litellm.example.com/v1');
    expect(msg).toContain('WARNING');
    expect(msg).toContain('my-litellm.example.com');
    expect(msg).toContain('controller responsibility');
    expect(msg).toContain('LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true');
  });
});
