import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ⚠ Its own file, and the reason is a trap this track already paid for:
 * `google-auth.test.ts` mocks `node:fs`, so a source scan written there reads a
 * stub and reports whatever the stub says. A checking tool that reads its own
 * mock reports clean.
 *
 * The claim: every write and every delete of the stored grant goes through the
 * two funnels, because §3.10's connection row mirrors the credential and a
 * mirror updated at four of five sites is worse than no mirror — it looks
 * maintained.
 */
describe('every token write announces itself', () => {
  const src = readFileSync(fileURLToPath(new URL('./google-auth.js'.replace('.js', '.ts'), import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the scan reads real source', () => {
    // Positive control. Without it, a path typo or a mocked fs turns "no
    // offenders" into "no file", and the two look identical in a green test.
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain('_persistTokens');
    expect(src).toContain('_dropTokens');
  });

  it('saveTokenData and deleteTokenData are called ONLY from the funnels', () => {
    const lines = src.split('\n');
    const offenders: string[] = [];
    for (const [i, line] of lines.entries()) {
      if (!/\b(save|delete)TokenData\s*\(/.test(line)) continue;
      if (/^(function|export function)\s+(save|delete)TokenData/.test(line.trim())) continue;
      // The two funnel bodies are the only permitted callers, identified by the
      // method they sit in rather than by line number — a number goes stale on
      // the next edit and the test would then guard nothing.
      const before = lines.slice(Math.max(0, i - 12), i).join('\n');
      if (/private _persistTokens|private _dropTokens/.test(before)) continue;
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
    expect(offenders, 'a token write outside the funnel skips the connection row').toEqual([]);
  });

  it('the detector can see an offender — positive control on the rule itself', () => {
    // A rule that has never fired is a rule nobody has tested. This runs the
    // same predicate over a synthetic body that breaks it.
    const synthetic = [
      'class X {',
      '  private somethingElse(): void {',
      '    saveTokenData(this.tokenData, this.vault);',
      '  }',
      '}',
    ];
    const offenders = synthetic.filter((l, i) =>
      /\b(save|delete)TokenData\s*\(/.test(l)
      && !/private _persistTokens|private _dropTokens/.test(synthetic.slice(Math.max(0, i - 12), i).join('\n')));
    expect(offenders).toHaveLength(1);
  });
});
