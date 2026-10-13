import { describe, it, expect } from 'vitest';
import { globToRegex, isOverbroadHostPattern } from './glob.js';

describe('globToRegex', () => {
  it('matches "npm run *" against "npm run build"', () => {
    expect(globToRegex('npm run *').test('npm run build')).toBe(true);
  });

  it('matches "dist/**" against "dist/index.js"', () => {
    expect(globToRegex('dist/**').test('dist/index.js')).toBe(true);
  });

  it('matches "*.env" against ".env"', () => {
    expect(globToRegex('*.env').test('.env')).toBe(true);
  });

  it('does NOT match unrelated string', () => {
    expect(globToRegex('npm run *').test('git push')).toBe(false);
  });

  it('matches nested paths with **', () => {
    expect(globToRegex('src/**/*.ts').test('src/core/agent.ts')).toBe(true);
  });

  it('does not match path with / for single *', () => {
    expect(globToRegex('src/*.ts').test('src/core/agent.ts')).toBe(false);
  });

  it('escapes regex specials like dots and parens', () => {
    expect(globToRegex('file.txt').test('file.txt')).toBe(true);
    expect(globToRegex('file.txt').test('fileatxt')).toBe(false);
  });

  it('handles ? wildcard', () => {
    expect(globToRegex('file?.txt').test('file1.txt')).toBe(true);
    expect(globToRegex('file?.txt').test('file12.txt')).toBe(false);
  });

  it('does not catastrophically backtrack on hostile wildcard input (ReDoS guard)', () => {
    // Neither a contiguous star run NOR `**/**/…` groups (where `**` eats its
    // trailing `/`, re-creating adjacent quantifiers) may hang the event loop when
    // tested against a non-matching host. Both are reachable from an imported
    // capability-contract hostPattern (capped at 2000 chars). Each must resolve
    // promptly — the group vector froze for tens of seconds before the coalesce.
    for (const pattern of ['*'.repeat(1000) + 'zzz', '**/'.repeat(660) + '9']) {
      const start = performance.now();
      const result = globToRegex(pattern).test('b.attacker-domain.net');
      expect(result).toBe(false);
      expect(performance.now() - start).toBeLessThan(100);
    }
  });

  it('coalescing adjacent quantifiers is match-equivalent', () => {
    // `****`, `**/**`, `***` all reduce to a single `.*` — same matched language.
    for (const host of ['a.example.com', 'x', '', 'deep/path/here']) {
      expect(globToRegex('****').test(host)).toBe(globToRegex('**').test(host));
      expect(globToRegex('**/**').test(host)).toBe(globToRegex('**').test(host));
    }
    expect(globToRegex('***.googleapis.com').test('a.googleapis.com')).toBe(true);
  });
});

describe('isOverbroadHostPattern', () => {
  it('flags match-anything wildcards', () => {
    for (const p of ['*', '**', '*.*', '**/**']) {
      expect(isOverbroadHostPattern(p)).toBe(true);
    }
  });

  it('does not flag a pinned host or a bounded subdomain wildcard', () => {
    for (const p of ['api.acme.test', '*.googleapis.com', 'api.stripe.com']) {
      expect(isOverbroadHostPattern(p)).toBe(false);
    }
  });
});
