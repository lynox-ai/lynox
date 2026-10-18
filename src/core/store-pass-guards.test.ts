/**
 * Source guards for the store pass (PRD-SHOPIFY-CONTAINMENT-ERASURE Appendix B):
 *  - a pass is minted in one place only, the attach in `tools/builtin/http.ts`, after the
 *    binding and the clearance; any other module that can mint one is a way around them;
 *  - the store binding's subkey comes from its own HKDF label (R1-7): a subkey shared with the
 *    keyed hash would make a binding computable from digests engine.db already stores.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('the store pass is minted in one place', () => {
  it('only store-pass.ts defines mintStorePass and only tools/builtin/http.ts calls it', () => {
    const callers = sources(SRC)
      .filter((p) => /\bmintStorePass\b/.test(readFileSync(p, 'utf-8')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual(['core/store-pass.ts', 'tools/builtin/http.ts']);
  });

  it('http.ts calls it once, right after the clearance', () => {
    const http = readFileSync(join(SRC, 'tools/builtin/http.ts'), 'utf-8');
    const calls = http.match(/mintStorePass\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const at = http.indexOf('mintStorePass(');
    const clearance = http.lastIndexOf('exactClearance!.ensure()', at);
    const binding = http.lastIndexOf('storeBindingDigest?.(', at);
    expect(binding).toBeGreaterThan(-1);
    expect(clearance).toBeGreaterThan(binding);
  });
});

describe('the store binding has a subkey of its own (R1-7)', () => {
  it('derives it with its own HKDF label, distinct from the keyed-hash and encryption labels', () => {
    const src = readFileSync(join(SRC, 'core/engine-db.ts'), 'utf-8');
    const label = (name: string): string | undefined => new RegExp(`const ${name} = '([^']+)'`).exec(src)?.[1];
    const bind = label('STORE_BINDING_HKDF_INFO');
    expect(bind).toBeDefined();
    expect(bind).not.toBe(label('ENGINE_HASH_HKDF_INFO'));
    expect(bind).not.toBe(label('ENGINE_HKDF_INFO'));
    expect(src).toMatch(/this\._bindKey = Buffer\.from\(hkdfSync\('sha256', vaultKey, 'lynox-engine', STORE_BINDING_HKDF_INFO, CRYPTO_KEY_LENGTH\)\)/);
    expect(src).toMatch(/createHmac\('sha256', this\._bindKey\)/);
  });
});
