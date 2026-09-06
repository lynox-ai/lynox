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
 * Blank out the CONTENTS of string and template literals, keeping the source's
 * shape and line count.
 *
 * Without this the brace counter below is not counting braces, it is counting
 * characters that look like braces: a single `const s = '{';` inside a funnel
 * inflates the depth so that method never closes, every later call is
 * attributed to it, and the guard returns "no offenders" for a file full of
 * them. Not an adversarial case — one string literal is enough.
 */
function maskLiterals(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === quote) { quote = null; out += c; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * The offenders in a TypeScript source: calls to the raw persistence helpers
 * from anywhere but the two funnels.
 *
 * Scope-aware on purpose. A proximity rule ("within 12 lines of a funnel
 * signature") is wrong in both directions: a call in the NEXT method is
 * skipped, and a method named `_persistTokensLegacy` shields everything inside
 * it because the name is a prefix of the real one. This tracks the enclosing
 * method by brace depth over literal-masked source instead, and it is the ONE
 * predicate — the control below runs this same function rather than a copy of
 * it that can drift.
 *
 * ⚠ It THROWS when the depth does not return to zero. A counter that ends
 * unbalanced has mis-attributed something, and the honest answer there is "I
 * cannot tell you", not an empty offender list that reads like a clean file.
 */
export function tokenWriteOffenders(src: string): string[] {
  const stripped = maskLiterals(
    src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
       .replace(/^([ \t]*)\/\/.*$/gm, '$1'),
  );
  const FUNNELS = new Set(['_persistTokens', '_dropTokens']);
  const lines = stripped.split('\n');
  const rawLines = src.split('\n');
  const offenders: string[] = [];
  let depth = 0;
  let methodStack: { name: string; depth: number }[] = [];
  for (const [i, line] of lines.entries()) {
    const header = /^\s*(?:private\s+|public\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (header && opens > 0) methodStack.push({ name: header[1]!, depth });
    if (/\b(save|delete)TokenData\s*\(/.test(line)
      && !/^\s*(export\s+)?function\s+(save|delete)TokenData/.test(line)) {
      const enclosing = methodStack.at(-1)?.name ?? '<top-level>';
      // Exact name, not a prefix: `_persistTokensLegacy` is a different method.
      if (!FUNNELS.has(enclosing)) offenders.push(`${i + 1} [${enclosing}]: ${rawLines[i]?.trim() ?? ''}`);
    }
    depth += opens - closes;
    methodStack = methodStack.filter((m) => m.depth < depth);
  }
  if (depth !== 0) {
    throw new Error(`token-write scan: brace depth ended at ${depth}, not 0 — the scan cannot attribute calls to methods and must not report a clean file`);
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

  it('a brace inside a STRING does not disable the scan', () => {
    // The accident that made the previous version useless: one `'{'` inside a
    // funnel inflated the depth, that method never closed, and every later
    // call was attributed to it — so the guard returned "clean" for a file
    // full of offenders.
    const withLiteral = [
      'class X {',
      '  private _persistTokens(): void {',
      "    const s = '{';",
      '    void s;',
      '    saveTokenData(this.tokenData, this.vault);',
      '  }',
      '  private somethingElse(): void {',
      '    saveTokenData(this.tokenData, this.vault);',
      '  }',
      '}',
    ].join('\n');
    const found = tokenWriteOffenders(withLiteral);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('somethingElse');
  });

  it('refuses to answer when its own counting did not balance', () => {
    // A counter that ends unbalanced has mis-attributed something. An empty
    // offender list would then read exactly like a clean file — which is the
    // failure mode this whole file exists against, one level up.
    expect(() => tokenWriteOffenders('class X { private a(): void { }')).toThrow(/brace depth ended/);
  });

  it('the engine names the vault slot from the leaf module, not a copy', () => {
    // Two owners of one string is how a rename desyncs a row from the slot it
    // names. One owner, and the engine's Google loading stays lazy.
    const engineSrc = readFileSync(fileURLToPath(new URL('../../core/engine.ts', import.meta.url)), 'utf8');
    expect(engineSrc).toContain("from '../integrations/google/vault-keys.js'");
    expect(engineSrc, 'the literal must not be re-typed in the engine')
      .not.toMatch(/vaultKeys:\s*\['GOOGLE_OAUTH_TOKENS'\]/);
    // …and the engine must not import the integration itself at module scope:
    // `google-auth.ts` reaches node:http, node:crypto and the egress guard, and
    // every other Google import here is a dynamic `await import(...)`.
    const staticGoogleImports = engineSrc.match(/^import .*integrations\/google.*$/gm) ?? [];
    expect(staticGoogleImports).toHaveLength(1);
    expect(staticGoogleImports[0]).toContain('vault-keys.js');
    // Positive control on the scan: it reads real source and the pattern CAN match.
    expect(engineSrc.length).toBeGreaterThan(50_000);
    expect(/^import .*integrations\/google.*$/m.test("import { X } from '../integrations/google/google-auth.js';")).toBe(true);
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
