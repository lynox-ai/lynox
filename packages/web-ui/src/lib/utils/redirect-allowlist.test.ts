// === Redirect allowlist contract tests (PRD-IA-V2 Security S2) ===
//
// `assertChannelTarget` is the chokepoint for every `+page.ts` redirect in
// the P3-PR-A2 channel-route split. The test set covers:
//   1. Every allowlisted target is accepted (so tomorrow's `git mv` doesn't
//      silently break a redirect chain)
//   2. Common Open-Redirect payloads from the audit category-list (PRD
//      Risks table line "Open-Redirect via crafted Query/Hash in 301-chain")
//      are rejected — `//evil.com`, `https://evil.com`, scheme tricks, etc.
//   3. Targets outside the allowlist (even valid `/app/`-prefixed paths)
//      are rejected — the set is enumerated, not pattern-matched.

import { describe, it, expect } from 'vitest';
import { assertChannelTarget } from './redirect-allowlist.js';

describe('assertChannelTarget', () => {
  describe('allowlisted targets pass through', () => {
    const ALLOWED = [
      '/app/settings/channels',
      '/app/settings/channels/mail',
      '/app/settings/channels/mail/rules',
      '/app/settings/channels/whatsapp',
      '/app/settings/channels/google',
      '/app/settings/channels/notifications',
      '/app/settings/channels/search',
    ];
    for (const target of ALLOWED) {
      it(`accepts ${target}`, () => {
        expect(assertChannelTarget(target)).toBe(target);
      });
    }
  });

  describe('Open-Redirect rejection (PRD S2)', () => {
    it.each([
      // Protocol-relative — would become an external redirect.
      '//evil.com',
      '//evil.com/app/settings/channels',
      // Absolute external URLs.
      'https://evil.com/app/settings/channels',
      'http://evil.com',
      // Scheme tricks.
      'javascript:alert(1)',
      'data:text/html,<script>',
      // Relative paths that escape /app/.
      '../etc/passwd',
      '/admin/secrets',
      '/',
      '',
    ])('rejects %s', (target) => {
      expect(() => assertChannelTarget(target)).toThrow();
    });
  });

  describe('non-allowlisted /app/ paths still rejected', () => {
    it.each([
      // Valid /app/ prefix but not on the allowlist — defence-in-depth.
      '/app/settings',
      '/app/settings/llm',
      '/app/settings/channels/unknown',
      '/app/inbox',
      '/app/hub',
    ])('rejects %s', (target) => {
      expect(() => assertChannelTarget(target)).toThrow(/not allowlisted/);
    });
  });
});
