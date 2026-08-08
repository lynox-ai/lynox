/**
 * Tests for the BYOK endpoint allowlist (Wave 5d HN-launch hardening).
 *
 * Each behaviour ships paired security-block + legitimate-use coverage so a
 * future refactor of the allowlist can't silently break either side
 * (Wave-5c convention).
 */
import { describe, it, expect } from 'vitest';
import { isAllowlistedEndpoint, describeDisclosure, isEndpointAcked, isVettedEgressHost, GATE_MEMBERSHIP_FOR_TESTS, type CustomEndpointAck } from './endpoint-allowlist.js';

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
  // Bedrock was removed as a provider; the `*.amazonaws.com` apex pattern is
  // gone. A former Bedrock host — and, critically, any self-hosted model behind
  // a default AWS hostname — must now fall through to the controller-shift
  // disclosure instead of being silently allowlisted.
  it('rejects former AWS Bedrock host (provider removed)', () => {
    expect(isAllowlistedEndpoint('https://bedrock.us-east-1.amazonaws.com')).toBe(false);
  });
  it('rejects self-hosted model on a default EC2 hostname', () => {
    expect(isAllowlistedEndpoint('https://ec2-3-120-55-7.compute-1.amazonaws.com:8000/v1')).toBe(false);
  });
  it('rejects self-hosted model on a SageMaker hostname', () => {
    expect(isAllowlistedEndpoint('https://runtime.sagemaker.eu-central-1.amazonaws.com/endpoints/x/invocations')).toBe(false);
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

describe('isEndpointAcked — persisted acceptance for runtime egress', () => {
  const ack: CustomEndpointAck = {
    accepted: true,
    hosts: ['token-thief.example.com', 'shop.myshopify.com'],
    accepted_at: '2026-07-02T10:00:00.000Z',
  };

  it('returns true when the url host is in the accepted set', () => {
    expect(isEndpointAcked(ack, 'https://token-thief.example.com/oauth/token')).toBe(true);
    expect(isEndpointAcked(ack, 'https://shop.myshopify.com/admin/oauth/access_token')).toBe(true);
  });
  it('is host-bound — a DIFFERENT non-vetted host is not covered (swap-after-accept re-gates)', () => {
    expect(isEndpointAcked(ack, 'https://other-host.example/oauth/token')).toBe(false);
  });
  it('fail-closed on a missing ack (pre-fix / disk-loaded profile)', () => {
    expect(isEndpointAcked(undefined, 'https://token-thief.example.com/oauth/token')).toBe(false);
  });
  it('fail-closed on an empty accepted-host set', () => {
    const empty: CustomEndpointAck = { accepted: true, hosts: [], accepted_at: '2026-07-02T10:00:00.000Z' };
    expect(isEndpointAcked(empty, 'https://token-thief.example.com/oauth/token')).toBe(false);
  });
  it('fail-closed on a malformed url', () => {
    expect(isEndpointAcked(ack, 'not-a-url')).toBe(false);
  });
  it('matches on hostname only — port/path/query do not defeat the match', () => {
    expect(isEndpointAcked(ack, 'https://token-thief.example.com:8443/oauth/token?x=1')).toBe(true);
  });
});

describe('isVettedEgressHost — the credential-attach gate', () => {
  // Two callers ask this: api_setup decides whether to raise the acceptance prompt
  // and persist an ack, and the credential attach in http.ts decides whether an ack
  // was required. They MUST agree — when they did not, an `*.openai.azure.com`
  // profile saved with no prompt and no ack, and the attach then refused it with
  // advice ("re-save and accept when prompted") that could never be followed.
  const CASES: Array<{ url: string; vetted: boolean; why: string }> = [
    { url: 'https://api.anthropic.com/v1/messages', vetted: true,  why: 'vetted provider' },
    { url: 'https://api.mistral.ai/v1/chat',        vetted: true,  why: 'vetted provider' },
    { url: 'https://nas.local/api',                 vetted: true,  why: 'operator LAN, not a sub-processor' },
    { url: 'https://192.168.1.5/api',               vetted: true,  why: 'operator LAN, not a sub-processor' },
    { url: 'https://x.openai.azure.com/v1',         vetted: false, why: 'ANY account can register this label' },
    { url: 'https://api.bexio.com/3.0/users/me',    vetted: false, why: 'ordinary third party' },
  ];

  for (const { url, vetted, why } of CASES) {
    it(`${vetted ? 'vouches for' : 'requires acceptance for'} ${url} — ${why}`, () => {
      expect(isVettedEgressHost(url)).toBe(vetted);
    });
  }

  it('the CASES above diverge only on the azure wildcard', () => {
    const divergent = CASES.filter(c => isAllowlistedEndpoint(c.url) !== isVettedEgressHost(c.url));
    expect(divergent.map(c => c.url)).toEqual(['https://x.openai.azure.com/v1']);
  });

  it('vouches for EXACTLY these hosts and patterns — nothing may join silently', () => {
    // Pinned positively, because the dangerous direction is WIDENING. An earlier
    // version asserted the DECLINED set (all-minus-privateLan), which does not move
    // when someone adds to the vouched-for side: a new `privateLan` pattern, or a new
    // exact host, hands the credential attach another host that needs no acceptance
    // on record. Both left 393 tests green. Whatever is added there has to be added
    // here too, and that edit is where someone asks whether the engine should hand a
    // stored credential to that host unprompted.
    const { privateLan, exactHosts } = GATE_MEMBERSHIP_FOR_TESTS;
    expect(privateLan).toEqual([
      String(/^192\.168\.\d{1,3}\.\d{1,3}$/),
      String(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/),
      String(/^172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}$/),
      String(/\.local$/),
      String(/\.lan$/),
      String(/\.intranet$/),
    ]);
    expect(exactHosts).toEqual([
      '0.0.0.0', '127.0.0.1', 'aiplatform.googleapis.com', 'api.anthropic.com',
      'api.fireworks.ai', 'api.groq.com', 'api.mistral.ai', 'api.openai.com',
      'api.together.xyz', 'localhost',
    ]);
  });

  it('declines the azure wildcard — the one entry isAllowlistedEndpoint adds', () => {
    const { allPatterns, privateLan } = GATE_MEMBERSHIP_FOR_TESTS;
    const lan = new Set(privateLan);
    expect(allPatterns.filter(p => !lan.has(p))).toEqual([String(/\.openai\.azure\.com$/)]);
  });

  // Membership is only half of it. The assertions above compare literals to literals
  // and never call the gate, so they are blind to the FUNCTIONS: four logic mutations
  // once survived the whole 9778-test suite — an extra `||` branch, a dropped protocol
  // check in either helper, and swapping the exact-host lookup for `endsWith`, which
  // reinstates the very suffix spoof this file's own comment claims to defeat.
  describe('the gate LOGIC, not just its membership', () => {
    it('refuses a non-HTTP protocol on a host it otherwise vouches for', () => {
      // Both helpers check this independently; a drop in either one survives if only
      // the https spelling is ever asserted.
      expect(isVettedEgressHost('https://api.mistral.ai/v1')).toBe(true);
      expect(isVettedEgressHost('ftp://api.mistral.ai/v1')).toBe(false);
      expect(isVettedEgressHost('https://nas.local/api')).toBe(true);
      expect(isVettedEgressHost('ftp://nas.local/api')).toBe(false);
    });

    it('matches exact hosts exactly — no suffix spoof', () => {
      // `endsWith` instead of a Set lookup would vouch for both of these, which is
      // exactly the attack the pattern anchoring elsewhere in this file is against.
      expect(isVettedEgressHost('https://evillocalhost/x')).toBe(false);
      expect(isVettedEgressHost('https://notapi.mistral.ai/v1')).toBe(false);
      expect(isVettedEgressHost('https://api.mistral.ai.attacker.com/v1')).toBe(false);
    });

    it('vouches for nothing beyond the two sets it names', () => {
      // A third `||` branch is invisible to membership assertions.
      expect(isVettedEgressHost('https://api.bexio.com/3.0/users/me')).toBe(false);
      expect(isVettedEgressHost('https://x.openai.azure.com/v1')).toBe(false);
      expect(isVettedEgressHost('not a url')).toBe(false);
    });
  });
});
