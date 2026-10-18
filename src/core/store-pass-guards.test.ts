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

describe('the exchange pass is minted in one place, for the connect callback alone (B4)', () => {
  const users = (name: string): string[] => sources(SRC)
    .filter((p) => new RegExp(`\\b${name}\\b`).test(readFileSync(p, 'utf-8')))
    .map((p) => relative(SRC, p).replace(/\\/g, '/'))
    .sort();

  it('only store-pass.ts defines mintStoreExchangePass and only tools/builtin/http.ts calls it', () => {
    expect(users('mintStoreExchangePass')).toEqual(['core/store-pass.ts', 'tools/builtin/http.ts']);
  });

  it('http.ts calls it once, inside storeExchangePassFor, after the switch and the clearance', () => {
    const http = readFileSync(join(SRC, 'tools/builtin/http.ts'), 'utf-8');
    expect(http.match(/mintStoreExchangePass\(/g) ?? []).toHaveLength(1);
    const fn = http.indexOf('export async function storeExchangePassFor(');
    const at = http.indexOf('mintStoreExchangePass(');
    const next = http.indexOf('\nasync function ', fn + 1);
    expect(fn).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(fn);
    expect(at).toBeLessThan(next);
    const body = http.slice(fn, at);
    expect(body.indexOf("process.env['LYNOX_SHOPIFY_EXCHANGE']")).toBeGreaterThan(-1);
    expect(body.indexOf('exactClearance.ensure()')).toBeGreaterThan(body.indexOf("process.env['LYNOX_SHOPIFY_EXCHANGE']"));
  });

  it('the switch is read in that one place', () => {
    expect(users('LYNOX_SHOPIFY_EXCHANGE')).toEqual(['contract/env-registry.ts', 'tools/builtin/http.ts']);
    const http = readFileSync(join(SRC, 'tools/builtin/http.ts'), 'utf-8');
    expect(http.match(/LYNOX_SHOPIFY_EXCHANGE/g)).toHaveLength(2); // the doc comment and the read
  });

  it('only the connect callback asks for an exchange pass', () => {
    // A call, not a mention: doc comments name the function in two more files.
    const callers = sources(SRC)
      .filter((p) => /\bstoreExchangePassFor\(/.test(readFileSync(p, 'utf-8').replace(/export async function storeExchangePassFor\(/, '')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'));
    expect(callers).toEqual(['server/http-api.ts']);
    const api = readFileSync(join(SRC, 'server/http-api.ts'), 'utf-8');
    expect(api.match(/storeExchangePassFor\(/g) ?? []).toHaveLength(1);
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

describe('every caller of attachStoredCredential hands it what a store pass needs', () => {
  it('passes exactClearance and storeBindingDigest at each call, so no caller fails a store closed by leaving them out', () => {
    const calls: string[] = [];
    for (const p of sources(SRC)) {
      const lines = readFileSync(p, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (/\battachStoredCredential\(/.test(line) && !/function attachStoredCredential\(/.test(line)) calls.push(`${relative(SRC, p)}:${String(i + 1)}|${line}`);
      });
    }
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c, c.split('|')[0]).toMatch(/exactClearance: \w+\.exactClearance/);
      expect(c, c.split('|')[0]).toMatch(/storeBindingDigest: \w+\.storeBindingDigest/);
    }
  });
});
