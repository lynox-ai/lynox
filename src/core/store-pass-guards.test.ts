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
    const clearance = body.indexOf('exactClearance!.ensure()');
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
 * Every place a store pass is minted, with its rule. A function that calls `mintStorePass` and
 * is not listed here fails the test below. The exchange of a store's token (the OAuth callback)
 * will get a mint of its own, which contains nothing: it fetches no store data.
 */
const MINTS: Record<string, string> = {
  'tools/builtin/http.ts › mintStorePassFor': 'request pass: refused without a container; contains the thread or run before minting',
};

describe('every mint of a store pass has its containment rule', () => {
  it('lists each function that calls mintStorePass', () => {
    const found: string[] = [];
    for (const p of sources(SRC)) {
      const src = readFileSync(p, 'utf-8');
      const rel = relative(SRC, p).replace(/\\/g, '/');
      if (rel === 'core/store-pass.ts') continue; // the definition
      for (const m of src.matchAll(/(?<![\w.])mintStorePass\(/g)) {
        const before = src.slice(0, m.index);
        const fn = [...before.matchAll(/\n(?:export )?(?:async )?function (\w+)\(/g)].pop()?.[1] ?? '(top level)';
        found.push(`${rel} › ${fn}`);
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
