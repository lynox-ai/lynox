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

  it('http.ts calls it once, in mintStorePassFor, after the clearance and the containment row', () => {
    const http = readFileSync(join(SRC, 'tools/builtin/http.ts'), 'utf-8');
    const calls = http.match(/mintStorePass\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const body = functionBody(http, 'mintStorePassFor');
    const clearance = body.indexOf('exactClearance.ensure()');
    const contain = body.indexOf('containment.contain(');
    const mint = body.indexOf('mintStorePass(');
    expect(clearance).toBeGreaterThan(-1);
    // ⛔ The row before the pass: a pass that exists without its row is a request nothing contains.
    expect(contain).toBeGreaterThan(clearance);
    expect(mint).toBeGreaterThan(contain);
  });

  it('the funnel calls mintStorePassFor once, after the binding check', () => {
    const http = readFileSync(join(SRC, 'tools/builtin/http.ts'), 'utf-8');
    const body = functionBody(http, 'attachEngineManagedAuth');
    expect(body.match(/mintStorePassFor\(/g) ?? []).toHaveLength(1);
    const at = body.indexOf('mintStorePassFor(');
    const binding = body.lastIndexOf('storeBindingDigest?.(', at);
    expect(binding).toBeGreaterThan(-1);
    expect(http.match(/mintStorePassFor\(/g) ?? []).toHaveLength(2); // the definition and that call
  });
});

/** The text of a top-level `function name(` from its signature to its closing brace. */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`\\n(export )?(async )?function ${name}\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

/** The argument text of each call `name(` in `src`, by balanced parentheses; definitions skipped. */
function callArgs(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/**
 * Every place a store pass is minted, with its rule, keyed by the function and the mint it calls.
 * A function that calls either mint and is not listed here fails the test below.
 *
 * The exchange pass contains nothing: it reaches only the store's token endpoint, by POST, with
 * the body it was minted for (`storePassRefusal`, `core/store-pass.ts`), so it fetches no store
 * data. Its one caller is the connect callback (pinned in the describe below).
 */
const MINTS: Record<string, string> = {
  'tools/builtin/http.ts › mintStorePassFor › mintStorePass': 'request pass: refused without a container; contains the thread or run before minting',
  'tools/builtin/http.ts › storeExchangePassFor › mintStoreExchangePass': 'exchange pass: the connect callback only; contains nothing, it fetches no store data',
};

describe('every mint of a store pass has its containment rule', () => {
  it('lists each function that calls mintStorePass or mintStoreExchangePass', () => {
    const found: string[] = [];
    for (const p of sources(SRC)) {
      const src = readFileSync(p, 'utf-8');
      const rel = relative(SRC, p).replace(/\\/g, '/');
      if (rel === 'core/store-pass.ts') continue; // the definitions
      for (const m of src.matchAll(/(?<![\w.])(mintStorePass|mintStoreExchangePass)\(/g)) {
        const before = src.slice(0, m.index);
        const fn = [...before.matchAll(/\n(?:export )?(?:async )?function (\w+)\(/g)].pop()?.[1] ?? '(top level)';
        found.push(`${rel} › ${fn} › ${m[1]!}`);
      }
    }
    for (const f of found) expect(MINTS[f], `${f} mints a store pass with no containment rule: a request pass is minted only in mintStorePassFor, the tail of the credential funnel (attachEngineManagedAuth)`).toBeDefined();
    expect(found.sort()).toEqual(Object.keys(MINTS).sort());
  });
});

/**
 * Every caller of the credential funnel, with the container its request to a store is contained
 * under (`core/containment.ts`). An agent's request is contained under its chat (`containerOf`:
 * its thread, or for a spawned child or a workflow step the chat it runs for); a bulk run's under
 * the run, because the agent `attachStoredCredential` builds has no thread.
 */
const FUNNEL_CALLERS: Record<string, string> = {
  'tools/builtin/http.ts|attachEngineManagedAuth|containerOf(agent)': 'http_request: the calling chat',
  'tools/builtin/http.ts|attachEngineManagedAuth|containerOf(deps.agent)': 'a write question\'s context read: the calling chat',
  'tools/builtin/http.ts|attachEngineManagedAuth|{ bulkRunId: container.bulkRunId }': 'attachStoredCredential: the bulk run it is given',
  'core/worker-loop.ts|attachStoredCredential|{ bulkRunId: run.id }': 'the bulk worker: the run it reads or writes for',
  'server/http-api.ts|attachStoredCredential|{ bulkRunId: runId }': 'the bulk reach check: the run it checks',
};

describe('every caller of the credential funnel names its container', () => {
  it('lists each call of attachEngineManagedAuth and attachStoredCredential with its rule', () => {
    const found: string[] = [];
    for (const p of sources(SRC)) {
      const src = readFileSync(p, 'utf-8');
      const rel = relative(SRC, p).replace(/\\/g, '/');
      for (const name of ['attachEngineManagedAuth', 'attachStoredCredential']) {
        for (const args of callArgs(src, name)) {
          const container = Object.keys(FUNNEL_CALLERS)
            .filter((k) => k.startsWith(`${rel}|${name}|`))
            .map((k) => k.split('|')[2]!)
            .find((c) => args.includes(c));
          found.push(`${rel}|${name}|${container ?? `(no listed container) ${args.replace(/\s+/g, ' ').slice(0, 80)}`}`);
        }
      }
    }
    for (const f of found) {
      expect(FUNNEL_CALLERS[f], `${f}: a new caller of the credential funnel (attachEngineManagedAuth / attachStoredCredential) must pass the container its request is contained under, and be listed here with its rule`).toBeDefined();
    }
    expect(found.sort()).toEqual(Object.keys(FUNNEL_CALLERS).sort());
  });

  it('bulk_plan hands the planning chat to every ledger insert, read through chatThreadOf and not created_by', () => {
    const bulk = readFileSync(join(SRC, 'tools/builtin/bulk.ts'), 'utf-8');
    const inserts = [...callArgs(bulk, 'ledger.recordDryRun'), ...callArgs(bulk, 'ledger.recordExternalPlan'), ...callArgs(bulk, 'ledger.recordExternalListPlan')];
    expect(inserts).toHaveLength(3);
    for (const a of inserts) expect(a).toContain('planningThread: chatThreadOf(agent)');
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
    expect(body.indexOf('if (!shopifyExchangeSwitchOn()) return undefined;')).toBeGreaterThan(-1);
    expect(body.indexOf('exactClearance.ensure()')).toBeGreaterThan(body.indexOf('shopifyExchangeSwitchOn()'));
  });

  it('the switch is read in that one place', () => {
    expect(users('LYNOX_SHOPIFY_EXCHANGE')).toEqual(['contract/env-registry.ts', 'tools/builtin/http.ts']);
    const http = readFileSync(join(SRC, 'tools/builtin/http.ts'), 'utf-8');
    expect(http.match(/LYNOX_SHOPIFY_EXCHANGE/g)).toHaveLength(2); // the doc comment and the read
  });

  it('the switch is read inside shopifyExchangeSwitchOn, which the exchange and the session prompt alone ask', () => {
    const http = readFileSync(join(SRC, 'tools/builtin/http.ts'), 'utf-8');
    const fn = http.indexOf('export function shopifyExchangeSwitchOn(): boolean {');
    expect(fn).toBeGreaterThan(-1);
    const end = http.indexOf('\n}\n', fn);
    expect(http.slice(fn, end)).toContain("const sw = process.env['LYNOX_SHOPIFY_EXCHANGE'];\n  return sw === '1' || sw === 'true';");
    // A call, not a mention: the prompt's doc comment names the predicate too.
    const callers = sources(SRC)
      .filter((p) => /\bshopifyExchangeSwitchOn\(\)/.test(readFileSync(p, 'utf-8').replace('export function shopifyExchangeSwitchOn()', '')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual(['core/session.ts', 'tools/builtin/http.ts']);
    const session = readFileSync(join(SRC, 'core/session.ts'), 'utf-8');
    expect(session.match(/shopifyPresetSuffix\(shopifyExchangeSwitchOn\(\)\)/g) ?? []).toHaveLength(2);
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
  it('passes exactClearance, storeBindingDigest and containment at each call, so no caller fails a store closed by leaving them out', () => {
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
      // And the record a request to a store is contained in: without it the attach refuses.
      expect(c, c.split('|')[0]).toMatch(/containment: \w+\.containment/);
    }
  });
});
