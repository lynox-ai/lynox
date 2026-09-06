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

/**
 * The offenders in a TypeScript source: calls to the raw persistence helpers
 * from anywhere but the two funnels.
 *
 * Scope-aware on purpose. A proximity rule ("within 12 lines of a funnel
 * signature") is wrong in both directions: a call in the NEXT method is
 * skipped, and a method named `_persistTokensLegacy` shields everything inside
 * it because the name is a prefix of the real one. This tracks the enclosing
 * method by brace depth instead, and it is the ONE predicate — the control
 * below runs this same function rather than a copy of it that can drift.
 */
export function tokenWriteOffenders(src: string): string[] {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const FUNNELS = new Set(['_persistTokens', '_dropTokens']);
  const lines = stripped.split('\n');
  const offenders: string[] = [];
  let depth = 0;
  let methodStack: { name: string; depth: number }[] = [];
  for (const [i, line] of lines.entries()) {
    // A method header at this depth opens a new scope on the next `{`.
    const header = /^\s*(?:private\s+|public\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (header && opens > 0) methodStack.push({ name: header[1]!, depth });
    if (/\b(save|delete)TokenData\s*\(/.test(line)
      && !/^\s*(export\s+)?function\s+(save|delete)TokenData/.test(line)) {
      const enclosing = methodStack.at(-1)?.name ?? '<top-level>';
      // Exact name, not a prefix: `_persistTokensLegacy` is a different method.
      if (!FUNNELS.has(enclosing)) offenders.push(`${i + 1} [${enclosing}]: ${line.trim()}`);
    }
    depth += opens - closes;
    methodStack = methodStack.filter((m) => m.depth < depth);
  }
  return offenders;
}

describe('every token write announces itself', () => {
  const src = readFileSync(fileURLToPath(new URL('./google-auth.ts', import.meta.url)), 'utf8');

  it('the scan reads real source', () => {
    // Positive control. Without it, a path typo or a mocked fs turns "no
    // offenders" into "no file", and the two look identical in a green test.
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain('_persistTokens');
    expect(src).toContain('_dropTokens');
  });

  it('saveTokenData and deleteTokenData are called ONLY from the funnels', () => {
    expect(tokenWriteOffenders(src), 'a token write outside the funnel skips the connection row').toEqual([]);
  });

  it('the SAME predicate sees the shapes a proximity rule would miss', () => {
    // A rule that has never fired is a rule nobody has tested — and these are
    // the two shapes the previous, line-distance version let through.
    const nextMethod = [
      'class X {',
      '  private _dropTokens(): void {',
      '    deleteTokenData(this.vault);',
      '  }',
      '  private somethingElse(): void {',
      '    saveTokenData(this.tokenData, this.vault);',
      '  }',
      '}',
    ].join('\n');
    expect(tokenWriteOffenders(nextMethod)).toHaveLength(1);
    expect(tokenWriteOffenders(nextMethod)[0]).toContain('somethingElse');

    const prefixName = [
      'class X {',
      '  private _persistTokensLegacy(): void {',
      '    saveTokenData(this.tokenData, this.vault);',
      '  }',
      '}',
    ].join('\n');
    expect(tokenWriteOffenders(prefixName), 'a prefix name must not shield an offender').toHaveLength(1);

    // …and it does NOT fire on the real funnels.
    const legit = [
      'class X {',
      '  private _persistTokens(r: string): void {',
      '    saveTokenData(this.tokenData, this.vault);',
      '  }',
      '}',
    ].join('\n');
    expect(tokenWriteOffenders(legit)).toEqual([]);
  });
});
