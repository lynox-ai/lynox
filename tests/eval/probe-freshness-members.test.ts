import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The MEMBER COUNT for probe fact-freshness.
 *
 * `DEF-dk-xprov-facts-not-fresh-across-runs` was filed against one script. It is not a
 * property of one script: any probe that POSTs a fact to `/api/sessions/:id/run` writes into
 * a store that KEEPS it, so its next run measures dedup. Three such probes existed when this
 * was written, and the first sweep for them missed one — because it was drawn over the
 * DIRECTORY `scripts/model-fitness/` while the class is defined by BEHAVIOUR. A control that
 * proves the pattern matches inside a directory does not prove the directory is the right
 * place to look.
 *
 * So this test does not look for a pattern. It ENUMERATES the members from the tree and
 * requires each one to import the shared freshness module — a completeness job rather than a
 * regex, per `memory/fb_fix_per_instance.md`. A new probe joins the set by existing; nobody
 * has to remember the rule.
 *
 * What it deliberately does NOT flag: the route's own definition and its tests (they contain
 * the path because they ARE the path), and clients that expose a run helper without sending a
 * fact of their own — a member is a caller with a fact, not a transport.
 */

const REPO = path.resolve(__dirname, '../..');
/** Where a probe could plausibly live. Kept wide on purpose — the point is not to guess. */
const ROOTS = ['scripts', 'tests'];
/** The route a probe drives. */
const RUN_ROUTE = /\/api\/sessions\/[^'"`]*\/run|\/api\/sessions\/\$\{[^}]+\}\/run/;
/** The module every member must import. */
const FRESHNESS = 'probe-freshness';
/**
 * The module itself. Its docstring names the route it exists to protect, which makes it
 * match the sweep — a module cannot be its own member. Excluded by path rather than by
 * rewording the docstring: the documentation is right, the sweep just has to say so.
 */
const SELF = 'scripts/model-fitness/probe-freshness.mjs';
/**
 * Not members. `engine-client.ts` is a transport (an `EngineClient` class with a `run`
 * helper) and carries no fact of its own; its CALLERS are members if they send facts.
 */
const TRANSPORTS = new Set(['scripts/agent-efficiency/engine-client.ts']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(mjs|ts|js)$/.test(e)) out.push(full);
  }
  return out;
}

function members(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(path.join(REPO, root))) {
      const rel = path.relative(REPO, file);
      if (TRANSPORTS.has(rel)) continue;
      if (rel === SELF || rel.endsWith('probe-freshness-members.test.ts')) continue;
      const src = readFileSync(file, 'utf8');
      if (RUN_ROUTE.test(src)) found.push(rel);
    }
  }
  return found.sort();
}

describe('probe fact freshness — every engine-facing probe is a member', () => {
  it('finds the probes at all (the sweep is not looking at an empty tree)', () => {
    // The control the first sweep lacked. Without it, a wrong root or a broken pattern
    // reports "every member complies" by finding none — the reassuring shape of a blind
    // query (`memory/fb_grep_ist_blind.md`).
    const found = members();
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found).toContain('scripts/model-fitness/dk-capture-repro.mjs');
    expect(found).toContain('scripts/model-fitness/dk-capture-crossprovider.mjs');
    expect(found).toContain('tests/eval/capture-fitness-runner.mjs');
  });

  it('requires every member to import the shared freshness module', () => {
    const offenders = members().filter(
      rel => !readFileSync(path.join(REPO, rel), 'utf8').includes(FRESHNESS),
    );
    // Named, not counted: a new probe should read WHICH file it forgot, not a number.
    expect(offenders).toEqual([]);
  });

  it('rejects a would-be member that only pretends to import it', () => {
    // The mutation this test must survive is "someone writes the module name in a comment".
    // Membership is about the IMPORT, so the check is anchored on the statement, not the word.
    const importing = members().filter(rel => {
      const src = readFileSync(path.join(REPO, rel), 'utf8');
      return new RegExp(`(import|require)[^\\n]*${FRESHNESS}`).test(src);
    });
    expect(importing.sort()).toEqual(members());
  });
});
