import { describe, it, expect } from 'vitest';
import { maskSecretPatterns, matchesSecretPattern } from '../../src/core/secret-store.js';

describe('ask_secret security', () => {
  describe('matchesSecretPattern', () => {
    it('detects Anthropic API keys', () => {
      expect(matchesSecretPattern('my key is sk-ant-abc123XYZ789defGHI456jkl')).not.toBeNull();
    });

    it('detects OpenAI API keys', () => {
      expect(matchesSecretPattern('sk-abcdefghijklmnopqrstuv')).not.toBeNull();
    });

    it('detects Stripe keys', () => {
      expect(matchesSecretPattern('sk_live_abcdef1234567890')).not.toBeNull();
      expect(matchesSecretPattern('sk_test_abcdef1234567890')).not.toBeNull();
      expect(matchesSecretPattern('rk_live_abcdef1234567890')).not.toBeNull();
    });

    it('detects GitHub tokens', () => {
      expect(matchesSecretPattern('ghp_abcdefghijklmnopqrstuv')).not.toBeNull();
      expect(matchesSecretPattern('gho_abcdefghijklmnopqrstuv')).not.toBeNull();
      expect(matchesSecretPattern('github_pat_abcdefghijklmnopqrstuv')).not.toBeNull();
    });

    it('detects AWS access keys', () => {
      expect(matchesSecretPattern('AKIAIOSFODNN7EXAMPLE')).not.toBeNull();
    });

    it('detects Google API keys', () => {
      expect(matchesSecretPattern('AIzaSyA1234567890abcdefghijklmnopqrstuv')).not.toBeNull();
    });

    it('detects Slack tokens (bot/user/admin + webhook/refresh prefixes)', () => {
      expect(matchesSecretPattern('xoxb-123456789012-abcdefgh')).not.toBeNull();
      // 2026-05-18: xoxo (incoming webhook) + xoxr (refresh) added.
      expect(matchesSecretPattern('xoxo-123456789012-abcdefgh')).not.toBeNull();
      expect(matchesSecretPattern('xoxr-123456789012-abcdefgh')).not.toBeNull();
    });

    it('detects GitHub user-installation tokens (ghu_)', () => {
      // 2026-05-18: ghu_ added to cover user-to-server installation tokens.
      expect(matchesSecretPattern('ghu_abcdefghijklmnopqrstuv')).not.toBeNull();
    });

    it('detects Shopify tokens (admin / app secret / partner / custom)', () => {
      // 2026-05-18: Shopify shp* added after a real flow leaked the prefix
      // into the agent transcript and triggered the user-cancel-loop bug.
      // Tokens assembled at runtime so GitHub Secret Scanning doesn't
      // flag this test file as a leaked-credential commit (the literal
      // shape matches the real token format too closely to embed as a
      // string constant).
      const body = 'a'.repeat(24);
      const prefix = 'shp';
      expect(matchesSecretPattern(`${prefix}at_${body}`)).not.toBeNull();
      expect(matchesSecretPattern(`${prefix}ss_${body}`)).not.toBeNull();
      expect(matchesSecretPattern(`${prefix}pa_${body}`)).not.toBeNull();
      expect(matchesSecretPattern(`${prefix}ca_${body}`)).not.toBeNull();
    });

    it('detects JWT (three base64-url segments)', () => {
      // 2026-05-18: JWT pattern added — catches OAuth ID tokens etc.
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      expect(matchesSecretPattern(jwt)).not.toBeNull();
    });

    it('returns null for normal text', () => {
      expect(matchesSecretPattern('hello world')).toBeNull();
      expect(matchesSecretPattern('my email is user@example.com')).toBeNull();
      expect(matchesSecretPattern('the setting is YES')).toBeNull();
    });

    it('does not false-positive on short prefixes', () => {
      expect(matchesSecretPattern('sk-short')).toBeNull();
      expect(matchesSecretPattern('ghp_short')).toBeNull();
      expect(matchesSecretPattern('sk_live_abc')).toBeNull();
    });

    it('does not false-positive on common words or URLs', () => {
      expect(matchesSecretPattern('I skipped the meeting')).toBeNull();
      expect(matchesSecretPattern('Check https://example.com/path')).toBeNull();
      expect(matchesSecretPattern('The SKU is product-12345')).toBeNull();
    });
  });

  describe('maskSecretPatterns', () => {
    it('masks Anthropic keys', () => {
      const input = 'Use this: sk-ant-abc123XYZ789defGHI456jkl';
      const result = maskSecretPatterns(input);
      expect(result).not.toContain('sk-ant-abc123');
      expect(result).toContain('***');
    });

    it('masks Stripe keys', () => {
      const input = 'sk_live_abcdef1234567890xyz';
      const result = maskSecretPatterns(input);
      expect(result).not.toContain('sk_live_abcdef');
      expect(result).toContain('***');
    });

    it('masks GitHub tokens', () => {
      const input = 'Token: ghp_abcdefghijklmnopqrstuv';
      const result = maskSecretPatterns(input);
      expect(result).not.toContain('ghp_abcdefgh');
      expect(result).toContain('***');
    });

    it('preserves normal text', () => {
      const input = 'Hello, my name is Alice';
      expect(maskSecretPatterns(input)).toBe(input);
    });

    it('masks multiple secrets in one string', () => {
      const input = 'key1: sk-ant-abc123XYZ789defGHI456jkl key2: ghp_abcdefghijklmnopqrstuv';
      const result = maskSecretPatterns(input);
      expect(result).not.toContain('sk-ant-abc123');
      expect(result).not.toContain('ghp_abcdefgh');
    });
  });
});
