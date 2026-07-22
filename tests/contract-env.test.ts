/**
 * Generated env-ABI drift tests (K-W1 §3.2, PRD-CORE-PRO-CONTRACT / DEF-0030) —
 * both directions, driven entirely by `src/contract/env-registry.ts`:
 *
 * FORWARD (row → read): every registry row with a readSite-bearing kind must
 * show its real read FORM at its real FILE — a consume-side rename/drop fails
 * CI even if a comment still mentions the name (the ACCOUNT_TIER-unset /
 * worker-profile-dead bug class). `none`-kind rows (denylisted phantoms) are
 * asserted ABSENT from the read inventory. Known limit (A6): `env-alias` rows
 * pin the alias-table entry + the readSite call, not every consuming call-site.
 *
 * REVERSE (read → row): every statically-greppable `LYNOX_*` env read under
 * `src/` and `packages/web-ui/src/` must be a registry row, a row's legacy
 * read-alias, SELF_HOST_ONLY (glob-capable), or a PREFIX_FAMILIES match — so a
 * NEW engine read cannot appear without an explicit contract stance. Honest
 * residual: a new non-LYNOX-prefixed read is invisible to this sweep (enters
 * via the membership review line instead).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import {
  ENV_REGISTRY,
  SELF_HOST_ONLY,
  PREFIX_FAMILIES,
  type EnvRegistryRow,
} from '../src/contract/env-registry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(repoRoot, p), 'utf8');

// ── Forward: row → real read form at the real site ──────────────────────────

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** SvelteKit `$env/dynamic/private` read forms: `env.NAME` or `env['NAME']`. */
const webUiForms = (name: string): RegExp[] => [
  new RegExp(`\\benv(\\.${esc(name)}\\b|\\[['"]${esc(name)}['"]\\])`),
];

/** The read form asserted per consumption kind. */
function readForms(row: EnvRegistryRow): RegExp[] {
  const n = esc(row.name);
  switch (row.engineConsumed.kind) {
    case 'config':
      return [new RegExp(`process\\.env\\[['"]${n}['"]\\]`)];
    case 'features':
      return [new RegExp(`['"]${n}['"]`)];
    case 'env-alias':
      return [new RegExp(`(readEnvAlias|envTier)\\(['"]${n}['"]\\)`)];
    case 'env-float':
      return [new RegExp(`envFloat\\(['"]${n}['"]\\)`)];
    case 'direct':
      return [new RegExp(`process\\.env(\\.${n}\\b|\\[['"]${n}['"]\\])`)];
    case 'web-ui':
      // SvelteKit server code reads via `$env/dynamic/private`.
      return [...webUiForms(row.name), new RegExp(`process\\.env(\\.${n}\\b|\\[['"]${n}['"]\\])`)];
    case 'sdk-internal':
    case 'none':
      return [];
  }
}

describe('env-ABI forward: every registry row is read at its declared site', () => {
  for (const row of ENV_REGISTRY) {
    const { kind, readSite, alsoReadAt } = row.engineConsumed;
    if (kind === 'sdk-internal') {
      it(`${row.name} (sdk-internal) is justified in its note`, () => {
        expect(row.note, `${row.name}: sdk-internal requires a note`).toBeTruthy();
      });
      continue;
    }
    if (kind === 'none') continue; // asserted absent by the reverse sweep below
    it(`${row.name} declares a readSite`, () => {
      expect(readSite, `${row.name}: kind '${kind}' requires a readSite`).toBeTruthy();
    });
    if (!readSite) continue;
    if (kind === 'web-ui') {
      it(`${row.name} (web-ui) declares its readSite under packages/web-ui/src`, () => {
        expect(readSite.startsWith('packages/web-ui/src/')).toBe(true);
      });
    }
    const sites = [readSite, ...(alsoReadAt ?? [])];
    for (const site of sites) {
      it(`${site} reads ${row.name} (${kind})`, () => {
        const src = read(site);
        const forms = readForms(row);
        // A site inside web-ui always reads via the SvelteKit env object,
        // whatever the row's primary kind is (e.g. a core 'direct' row with a
        // web-ui alsoReadAt).
        if (site.startsWith('packages/web-ui/')) forms.push(...webUiForms(row.name));
        expect(
          forms.some((f) => f.test(src)),
          `${site}: expected a ${kind}-form read of ${row.name}`,
        ).toBe(true);
      });
    }
    if (row.legacyReadAliases?.length) {
      it(`${row.name} keeps its legacy read-aliases in src/core/env.ts`, () => {
        const env = read('src/core/env.ts');
        expect(env).toMatch(new RegExp(`\\b${esc(row.name)}\\b`));
        for (const legacy of row.legacyReadAliases ?? []) {
          expect(env, `legacy read-alias ${legacy} is permanent`).toMatch(new RegExp(`\\b${esc(legacy)}\\b`));
        }
      });
    }
  }
});

// ── Reverse: read → row (mechanical inventory) ──────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit']);

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && /\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Read forms the sweep recognizes. Group 2/3/4-style captures collect the name. */
const READ_PATTERNS: readonly RegExp[] = [
  /process\.env\.(LYNOX_[A-Z0-9_]+)/g,
  /process\.env\[['"](LYNOX_[A-Z0-9_]+)['"]\]/g,
  /\benv\.(LYNOX_[A-Z0-9_]+)/g, // SvelteKit `$env/dynamic/private` reads in web-ui
  /\benv\[['"](LYNOX_[A-Z0-9_]+)['"]\]/g,
  /readEnvAlias\(['"](LYNOX_[A-Z0-9_]+)['"]\)/g,
  /envTier\(['"](LYNOX_[A-Z0-9_]+)['"]\)/g,
  /envFloat\(['"](LYNOX_[A-Z0-9_]+)['"]\)/g,
];

function collectReads(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const roots = ['src', 'packages/web-ui/src'];
  for (const root of roots) {
    for (const file of walk(resolve(repoRoot, root), [])) {
      const src = readFileSync(file, 'utf8');
      for (const pattern of READ_PATTERNS) {
        for (const m of src.matchAll(pattern)) {
          const name = m[1];
          if (!name) continue;
          const sites = found.get(name) ?? [];
          sites.push(relative(repoRoot, file));
          found.set(name, sites);
        }
      }
    }
  }
  return found;
}

const registryNames = new Set(ENV_REGISTRY.map((r) => r.name));
const legacyAliasNames = new Set(ENV_REGISTRY.flatMap((r) => r.legacyReadAliases ?? []));
const selfHostExact = new Set(SELF_HOST_ONLY.filter((s) => !s.endsWith('*')));
const selfHostGlobs = SELF_HOST_ONLY.filter((s) => s.endsWith('*')).map((s) => s.slice(0, -1));

function isCovered(name: string): boolean {
  if (registryNames.has(name)) return true;
  if (legacyAliasNames.has(name)) return true;
  if (selfHostExact.has(name)) return true;
  if (selfHostGlobs.some((p) => name.startsWith(p))) return true;
  if (PREFIX_FAMILIES.some((p) => name.startsWith(p))) return true;
  return false;
}

describe('env-ABI reverse: every LYNOX_* read has a contract stance', () => {
  const reads = collectReads();

  it('the sweep sees a plausible inventory (guard against a silently-empty scan)', () => {
    expect(reads.size).toBeGreaterThan(20);
  });

  for (const [name, sites] of [...reads.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    it(`${name} is covered (registry row / legacy alias / SELF_HOST_ONLY / prefix family)`, () => {
      expect(
        isCovered(name),
        `${name} (read at ${[...new Set(sites)].slice(0, 3).join(', ')}) has NO contract stance — add a registry row (CP-emitted), SELF_HOST_ONLY entry (operator knob), or prefix-family rule`,
      ).toBe(true);
    });
  }

  it('denylisted phantoms are not read anywhere (none-kind rows stay dead)', () => {
    for (const row of ENV_REGISTRY) {
      if (row.engineConsumed.kind !== 'none') continue;
      expect(
        reads.has(row.name),
        `${row.name} is denylisted with kind 'none' but a read exists — give it a real consumption stance`,
      ).toBe(false);
    }
  });

  it('registry rows that claim consumption are actually in the read inventory (LYNOX_* rows)', () => {
    for (const row of ENV_REGISTRY) {
      const { kind } = row.engineConsumed;
      // 'features' reads go through the flag helper (a quoted literal, pinned
      // by the forward test), not a sweep-visible read form.
      if (kind === 'none' || kind === 'sdk-internal' || kind === 'features') continue;
      if (!row.name.startsWith('LYNOX_')) continue; // non-prefixed rows escape the sweep patterns
      expect(reads.has(row.name), `${row.name}: registry claims kind '${kind}' but the sweep finds no read`).toBe(true);
    }
  });
});
