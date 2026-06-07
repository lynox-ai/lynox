/**
 * Tests for the Web UI endpoint-disclosure helpers — mirror of the engine-side
 * `core/src/core/llm/endpoint-allowlist.test.ts` (Wave 5d).
 *
 * The web-ui twin keeps slightly different semantics for the empty / undefined
 * cases (returns true so the modal doesn't pop on a blank field) — this file
 * pins both the shared host-policy AND the UI-specific empty-input handling.
 */
import { describe, it, expect } from 'vitest';
import { isAllowlistedEndpoint, disclosureHostname } from './endpoint-disclosure.js';

describe('isAllowlistedEndpoint (web-ui twin)', () => {
  it('returns true for empty input (no save-button gate needed)', () => {
    expect(isAllowlistedEndpoint('')).toBe(true);
    expect(isAllowlistedEndpoint(null)).toBe(true);
    expect(isAllowlistedEndpoint(undefined)).toBe(true);
    expect(isAllowlistedEndpoint('   ')).toBe(true);
  });

  it('allowlisted exact-match hosts pass', () => {
    expect(isAllowlistedEndpoint('https://api.mistral.ai/v1')).toBe(true);
    expect(isAllowlistedEndpoint('https://api.anthropic.com')).toBe(true);
    expect(isAllowlistedEndpoint('http://localhost:11434')).toBe(true);
  });

  it('Azure OpenAI pattern passes', () => {
    expect(isAllowlistedEndpoint('https://acme.openai.azure.com/openai')).toBe(true);
  });

  it('AWS *.amazonaws.com is NOT allowlisted → fires the disclosure (parity with engine, core #691)', () => {
    // The too-broad `*.amazonaws.com` suffix was dropped from the engine twin
    // in core #691 (it vouched for any AWS host / Bedrock proxy). The client
    // twin must agree, else the user hits a server 400 they can't accept.
    expect(isAllowlistedEndpoint('https://bedrock-runtime.us-east-1.amazonaws.com')).toBe(false);
  });

  it('RFC1918 LAN patterns pass', () => {
    expect(isAllowlistedEndpoint('http://192.168.1.10:8080')).toBe(true);
    expect(isAllowlistedEndpoint('http://10.0.0.1')).toBe(true);
    expect(isAllowlistedEndpoint('http://172.20.0.5')).toBe(true);
  });

  it('non-allowlisted public hosts fail (trigger the modal)', () => {
    expect(isAllowlistedEndpoint('https://my-litellm.example.com')).toBe(false);
    expect(isAllowlistedEndpoint('https://random.cdn.io')).toBe(false);
  });

  it('suffix-spoof attempts fail', () => {
    expect(isAllowlistedEndpoint('https://evil.openai.azure.com.attacker.com')).toBe(false);
    expect(isAllowlistedEndpoint('https://10.example.com')).toBe(false);
  });

  it('malformed URL fails (modal will still need to show — caller checks separately)', () => {
    expect(isAllowlistedEndpoint('not-a-url')).toBe(false);
  });

  it('rejects non-http(s) protocols even on allowlisted hosts', () => {
    expect(isAllowlistedEndpoint('ftp://api.mistral.ai')).toBe(false);
  });
});

describe('disclosureHostname', () => {
  it('returns the hostname for a well-formed URL', () => {
    expect(disclosureHostname('https://my-host.example.com/v1/chat')).toBe('my-host.example.com');
  });
  it('falls back to the raw input when URL parsing fails', () => {
    expect(disclosureHostname('not-a-url')).toBe('not-a-url');
  });
});
