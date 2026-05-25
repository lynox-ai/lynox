/**
 * Tests for the BYOK endpoint allowlist (Wave 5d HN-launch hardening).
 *
 * Each behaviour ships paired security-block + legitimate-use coverage so a
 * future refactor of the allowlist can't silently break either side
 * (Wave-5c convention).
 */
import { describe, it, expect } from 'vitest';
import { isAllowlistedEndpoint, describeDisclosure } from './endpoint-allowlist.js';

describe('isAllowlistedEndpoint — exact-match hosts', () => {
  it('allows api.mistral.ai (https)', () => {
    expect(isAllowlistedEndpoint('https://api.mistral.ai/v1')).toBe(true);
  });
  it('allows api.mistral.ai with explicit port', () => {
    expect(isAllowlistedEndpoint('https://api.mistral.ai:443/v1')).toBe(true);
  });
  it('allows api.anthropic.com', () => {
    expect(isAllowlistedEndpoint('https://api.anthropic.com')).toBe(true);
  });
  it('allows api.openai.com', () => {
    expect(isAllowlistedEndpoint('https://api.openai.com')).toBe(true);
  });
  it('allows api.openai.com with a path (host match is what counts)', () => {
    expect(isAllowlistedEndpoint('https://api.openai.com/v1/chat/completions')).toBe(true);
  });
  it('allows api.groq.com', () => {
    expect(isAllowlistedEndpoint('https://api.groq.com/openai/v1')).toBe(true);
  });
  it('allows api.together.xyz', () => {
    expect(isAllowlistedEndpoint('https://api.together.xyz')).toBe(true);
  });
  it('allows api.fireworks.ai', () => {
    expect(isAllowlistedEndpoint('https://api.fireworks.ai/inference/v1')).toBe(true);
  });
  it('allows aiplatform.googleapis.com', () => {
    expect(isAllowlistedEndpoint('https://aiplatform.googleapis.com')).toBe(true);
  });
  it('allows localhost (http) for self-host dev', () => {
    expect(isAllowlistedEndpoint('http://localhost:8080/v1')).toBe(true);
  });
  it('allows 127.0.0.1 (http) for self-host dev', () => {
    expect(isAllowlistedEndpoint('http://127.0.0.1:8000')).toBe(true);
  });
  it('allows 0.0.0.0', () => {
    expect(isAllowlistedEndpoint('http://0.0.0.0:11434')).toBe(true);
  });
});

describe('isAllowlistedEndpoint — pattern-allowed hosts', () => {
  it('allows Azure OpenAI deployments (my-deploy.openai.azure.com)', () => {
    expect(isAllowlistedEndpoint('https://my-deploy.openai.azure.com/openai/deployments/gpt-4')).toBe(true);
  });
  it('allows AWS Bedrock regional endpoints (bedrock.us-east-1.amazonaws.com)', () => {
    expect(isAllowlistedEndpoint('https://bedrock.us-east-1.amazonaws.com')).toBe(true);
  });
  it('allows RFC1918 192.168/16', () => {
    expect(isAllowlistedEndpoint('http://192.168.1.42:8080')).toBe(true);
  });
  it('allows RFC1918 10/8', () => {
    expect(isAllowlistedEndpoint('http://10.0.0.5')).toBe(true);
  });
  it('allows RFC1918 172.16/12 lower bound (172.16.x.x)', () => {
    expect(isAllowlistedEndpoint('http://172.16.0.1')).toBe(true);
  });
  it('allows RFC1918 172.16/12 mid range (172.20.x.x)', () => {
    expect(isAllowlistedEndpoint('http://172.20.0.1')).toBe(true);
  });
  it('allows RFC1918 172.16/12 upper bound (172.31.x.x)', () => {
    expect(isAllowlistedEndpoint('http://172.31.255.255')).toBe(true);
  });
  it('allows .local mDNS hostnames', () => {
    expect(isAllowlistedEndpoint('http://myserver.local')).toBe(true);
  });
  it('allows .lan hostnames', () => {
    expect(isAllowlistedEndpoint('http://internal.lan')).toBe(true);
  });
  it('allows .intranet hostnames', () => {
    expect(isAllowlistedEndpoint('http://gw.intranet')).toBe(true);
  });
});

describe('isAllowlistedEndpoint — rejects non-allowlisted hosts', () => {
  it('rejects random public host', () => {
    expect(isAllowlistedEndpoint('https://my-random-host.com')).toBe(false);
  });
  it('rejects an example CDN', () => {
    expect(isAllowlistedEndpoint('https://api.examplecdn.com')).toBe(false);
  });
  it('rejects suffix-spoof of openai.azure.com', () => {
    // Defeats `endsWith('.openai.azure.com')`-style checks by tacking
    // the legitimate suffix into the middle of the attacker hostname.
    expect(isAllowlistedEndpoint('https://evil.openai.azure.com.attacker.com')).toBe(false);
  });
  it('rejects suffix-spoof of amazonaws.com', () => {
    expect(isAllowlistedEndpoint('https://bedrock.us-east-1.amazonaws.com.evil.example')).toBe(false);
  });
  it('rejects 10.example.com (legitimate-looking but wrong shape)', () => {
    // 10.example.com is a public DNS name, not an RFC1918 IP — the regex is
    // anchored to a numeric octet, so this is correctly out of scope.
    expect(isAllowlistedEndpoint('https://10.example.com')).toBe(false);
  });
  it('rejects 172.32.0.1 (just outside RFC1918 172.16-31/12 range)', () => {
    expect(isAllowlistedEndpoint('http://172.32.0.1')).toBe(false);
  });
  it('rejects 172.15.0.1 (just below RFC1918 lower bound)', () => {
    expect(isAllowlistedEndpoint('http://172.15.0.1')).toBe(false);
  });
});

describe('isAllowlistedEndpoint — edge cases', () => {
  it('rejects malformed URL string', () => {
    expect(isAllowlistedEndpoint('not-a-url')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isAllowlistedEndpoint('')).toBe(false);
  });
  it('rejects ftp protocol even on an allowlisted host', () => {
    expect(isAllowlistedEndpoint('ftp://api.mistral.ai')).toBe(false);
  });
  it('rejects file: URL', () => {
    expect(isAllowlistedEndpoint('file:///etc/passwd')).toBe(false);
  });
  it('rejects javascript: URL', () => {
    expect(isAllowlistedEndpoint('javascript:alert(1)')).toBe(false);
  });
});

describe('describeDisclosure', () => {
  it('embeds the hostname in the disclosure text', () => {
    const msg = describeDisclosure('https://my-random-host.com/api');
    expect(msg).toContain('my-random-host.com');
    expect(msg).toContain('controller responsibility');
    expect(msg).toContain('Customer-Configured Endpoints');
  });
  it('does not include the path or query (only the hostname)', () => {
    const msg = describeDisclosure('https://my-host.example/path/secret?token=foo');
    expect(msg).toContain('my-host.example');
    // Token must not bleed into the disclosure shown to the user — they may
    // have pasted a URL with credentials by mistake.
    expect(msg).not.toContain('token=foo');
    expect(msg).not.toContain('/path/secret');
  });
  it('returns a malformed-URL message for invalid input', () => {
    const msg = describeDisclosure('not-a-url');
    expect(msg).toContain('malformed');
    expect(msg).toContain('not-a-url');
  });
});
