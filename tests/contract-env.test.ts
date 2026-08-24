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
      // The env-name MAP ENTRY form (`'slug': 'LYNOX_FEATURE_X'`), not any
      // quoted mention — a literal surviving in a comment must not pass.
      return [new RegExp(`:\\s*['"]${n}['"]`)];
    case 'env-alias':
      return [new RegExp(`(readEnvAlias|envTier)\\(['"]${n}['"]\\)`)];
    case 'env-float':
      return [new RegExp(`envFloat\\(['"]${n}['"]\\)`)];
    case 'direct':
      return [new RegExp(`process\\.env(\\.${n}\\b|\\[['"]${n}['"]\\])`)];
    case 'pair-resolver':
      // Pinned to the member's ARGUMENT POSITION. Position-agnostic forms let a
      // SWAPPED call — the secret passed as the client id — satisfy both rows,
      // which is the pair-mixing defect core#1269 exists to prevent.
      // The direct `process.env` form is NOT here: it is added per-site for
      // `alsoReadAt` only, so the primary site stays pinned to the resolver.
      return row.engineConsumed.pairArg === 2
        ? [new RegExp(`\\bresolveClientPair\\(\\s*['"][A-Z][A-Z0-9_]*['"]\\s*,\\s*['"]${n}['"]`)]
        : [new RegExp(`\\bresolveClientPair\\(\\s*['"]${n}['"]\\s*,`)];
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
    if (kind === 'pair-resolver') {
      it(`${row.name} declares which resolver argument it is`, () => {
        // Without pairArg the form set falls back to position 1 for every
        // member, and the swap case below stops being detectable.
        expect(row.engineConsumed.pairArg, `${row.name}: kind 'pair-resolver' requires pairArg`).toBeDefined();
      });
    }
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
        // A pair member is also read directly where the migration decides — but
        // only there. Accepting it at the PRIMARY site would let two independent
        // process.env reads pass as a resolved pair.
        if (kind === 'pair-resolver' && site !== readSite) {
          forms.push(new RegExp(`process\\.env(\\.${esc(row.name)}\\b|\\[['"]${esc(row.name)}['"]\\])`));
        }
        expect(
          forms.some((f) => f.test(src)),
          `${site}: expected a ${kind}-form read of ${row.name}`,
        ).toBe(true);
      });
    }
    const flag = row.engineConsumed.featureFlag;
    if (flag) {
      it(`${row.name}: isFeatureEnabled('${flag.slug}') is called at ${flag.consumerSite}`, () => {
        // A dead flag whose map entry survives must not pass — pin a real
        // consumer call-site alongside the map entry.
        expect(read(flag.consumerSite)).toMatch(new RegExp(`isFeatureEnabled\\(['"]${esc(flag.slug)}['"]\\)`));
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

describe('env-ABI forward: the pair-resolver form set rejects near-misses', () => {
  // The form set is the only thing standing between "the consumer is pinned"
  // and "some line in the file happens to contain the name".
  const rowFor = (name: string, pairArg: 1 | 2): EnvRegistryRow => ({
    name,
    valueKind: 'opaque',
    emitPolicy: 'operator-only',
    engineConsumed: { kind: 'pair-resolver', pairArg, readSite: 'src/core/engine.ts' },
  });
  const ID = 'GOOGLE_CLIENT_ID';
  const SECRET = 'GOOGLE_CLIENT_SECRET';
  const matchesId = (src: string): boolean => readForms(rowFor(ID, 1)).some((f) => f.test(src));
  const matchesSecret = (src: string): boolean => readForms(rowFor(SECRET, 2)).some((f) => f.test(src));

  it('accepts the real resolver call, each member at its own position', () => {
    const src = `resolveClientPair('${ID}', '${SECRET}', {`;
    expect(matchesId(src), `${ID} should match at argument 1`).toBe(true);
    expect(matchesSecret(src), `${SECRET} should match at argument 2`).toBe(true);
  });

  const rejected: [string, string][] = [
    ['a differently-named resolver', `resolveClientPairLegacy('${ID}', '${SECRET}')`],
    ['a helper whose name merely ends with the resolver', `myresolveClientPair('${ID}', '${SECRET}')`],
    ['longer names sharing the prefix', `resolveClientPair('${ID}_LEGACY', '${SECRET}_LEGACY')`],
    ['another provider pair', `resolveClientPair('MS_CLIENT_ID', 'MS_CLIENT_SECRET', {`],
    // The one that matters most: a position-agnostic form set would accept
    // this, and it ships the client SECRET as the client id.
    ['a SWAPPED call — the secret passed as the client id', `resolveClientPair('${SECRET}', '${ID}', {`],
    // Accepted only at an alsoReadAt site, added there by the site loop. If the
    // primary form set took it, two independent env reads would pass as a
    // resolved pair — the mixing defect core#1269 removed.
    ['a bare direct env read', `!process.env['${ID}'] && !process.env['${SECRET}']`],
    ['a dotted env read of a longer name', `process.env.${ID}_LEGACY`],
    ['a bare mention in a comment', `// ${ID} / ${SECRET} env copies were removed`],
  ];
  for (const [label, src] of rejected) {
    it(`rejects ${label}`, () => {
      expect(matchesId(src), `${ID} must not match`).toBe(false);
      expect(matchesSecret(src), `${SECRET} must not match`).toBe(false);
    });
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

/**
 * Credential-pair reads (kind 'pair-resolver'), both argument positions. Kept
 * as their OWN list rather than inlined below, so `collectReads` can record
 * that a name was seen BY A PAIR PATTERN. Without that distinction the pair
 * coverage control is satisfied by the generic `process.env[…]` pattern
 * picking the same names up at the migration site, and deleting these two is
 * a silent no-op — measured 2026-08-24, it was exactly that.
 */
const PAIR_READ_PATTERNS: readonly RegExp[] = [
  /\bresolveClientPair\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /\bresolveClientPair\(\s*['"][A-Z][A-Z0-9_]{2,}['"]\s*,\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];

/**
 * Read forms the sweep recognizes; every pattern captures the var name as
 * group 1. Captures are NOT restricted to LYNOX_* — the coverage assertion
 * filters, so non-prefixed denylist rows (e.g. OPENAI_BASE_URL) still get a
 * meaningful absence check.
 */
const READ_PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
  /\benv\.(LYNOX_[A-Z0-9_]+)/g, // SvelteKit `$env/dynamic/private` reads in web-ui
  /\benv\[['"](LYNOX_[A-Z0-9_]+)['"]\]/g,
  /readEnvAlias\(['"]([A-Z][A-Z0-9_]{2,})['"]\)/g,
  /envTier\(['"]([A-Z][A-Z0-9_]{2,})['"]\)/g,
  /envFloat\(['"]([A-Z][A-Z0-9_]{2,})['"]\)/g,
  // managed-hook's local int-env helper (reads process.env[name] internally).
  // If the helper is renamed, its vars go stale in SELF_HOST_ONLY and the
  // allowlist-rot guard fires — update this pattern then.
  /parsePositiveIntEnv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  ...PAIR_READ_PATTERNS,
];

/** Read forms the sweep is BLIND to — banned in swept files so a new read cannot hide. */
const BLIND_FORMS: readonly [RegExp, string][] = [
  [/\{[^}]*\}\s*=\s*process\.env\b/, 'destructuring `const { X } = process.env`'],
  [/\$env\/static\/private/, "`$env/static/private` import (compile-time env read)"],
  // A pair resolved from hoisted consts is invisible to every literal-based
  // form AND to PAIR_READ_PATTERNS. The lookbehind spares the resolver's own
  // definition (checked against its single- and multi-line shapes). NOTE: this
  // scan does NOT strip comments — prose that spells the call with an opening
  // paren trips it. Stripping comments here was rejected: a naive `//` strip
  // truncates any line holding a `https://` literal, which would HIDE a real
  // read. Write about the helper without the paren instead.
  [/(?<!function )\bresolveClientPair\(\s*[A-Za-z_$]/, 'resolveClientPair() called with a non-literal argument'],
];

function collectReads(): { reads: Map<string, string[]>; blind: string[]; viaPair: Set<string> } {
  const found = new Map<string, string[]>();
  const blind: string[] = [];
  const viaPair = new Set<string>();
  const roots = ['src', 'packages/web-ui/src'];
  for (const root of roots) {
    for (const file of walk(resolve(repoRoot, root), [])) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(repoRoot, file);
      for (const pattern of READ_PATTERNS) {
        for (const m of src.matchAll(pattern)) {
          const name = m[1];
          if (!name) continue;
          const sites = found.get(name) ?? [];
          sites.push(rel);
          found.set(name, sites);
          if (PAIR_READ_PATTERNS.includes(pattern)) viaPair.add(name);
        }
      }
      for (const [form, label] of BLIND_FORMS) {
        if (form.test(src)) blind.push(`${rel}: ${label}`);
      }
    }
  }
  return { reads: found, blind, viaPair };
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

/** One filesystem sweep, shared by the reverse inventory and the pair control. */
const SWEEP = collectReads();

describe('env-ABI reverse: every LYNOX_* read has a contract stance', () => {
  const { reads, blind } = SWEEP;

  it('the sweep sees a plausible inventory (guard against a silently-empty scan)', () => {
    expect(reads.size).toBeGreaterThan(20);
  });

  it('no swept file uses a read form the sweep is blind to', () => {
    expect(blind, 'rewrite as a sweep-visible read (process.env[…] / $env/dynamic/private) or teach READ_PATTERNS the form').toEqual([]);
  });

  for (const [name, sites] of [...reads.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!name.startsWith('LYNOX_')) continue; // non-prefixed reads: honest residual (membership review line)
    it(`${name} is covered (registry row / legacy alias / SELF_HOST_ONLY / prefix family)`, () => {
      expect(
        isCovered(name),
        `${name} (read at ${[...new Set(sites)].slice(0, 3).join(', ')}) has NO contract stance — add a registry row (CP-emitted), SELF_HOST_ONLY entry (operator knob), or prefix-family rule`,
      ).toBe(true);
    });
  }

  it('every SELF_HOST_ONLY entry still has a live read (allowlist rot guard)', () => {
    const stale: string[] = [];
    for (const entry of SELF_HOST_ONLY) {
      const alive = entry.endsWith('*')
        ? [...reads.keys()].some((n) => n.startsWith(entry.slice(0, -1)))
        : reads.has(entry);
      if (!alive) stale.push(entry);
    }
    expect(stale, 'no read in src/ or packages/web-ui/src matches these SELF_HOST_ONLY entries — remove them (or fix the read they were meant to cover)').toEqual([]);
  });

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

describe('env-ABI: credential-pair reads are swept and declared', () => {
  const { reads, viaPair } = SWEEP;

  // Positive control on the pair patterns themselves. Without it, deleting them
  // from READ_PATTERNS is a silent no-op TODAY — the Google pair is not LYNOX_*,
  // so the coverage loop skips it — and the blindness would only surface at the
  // first LYNOX_* pair, long after the deletion. A guard whose absence changes
  // nothing observable is not a guard.
  it('the sweep sees every declared pair-resolver row THROUGH A PAIR PATTERN', () => {
    // Two things this control got wrong before and now does not.
    // (1) Derived from the registry, not from a name shape like
    //     /_CLIENT_(ID|SECRET)$/ — a control that can go stale is not one.
    // (2) Asserted against `viaPair`, NOT `reads`. Against `reads` it was
    //     tautological: engine-init.ts reads both names via process.env[…],
    //     which the generic pattern already captures, so deleting both pair
    //     patterns left the suite green. Measured, not reasoned.
    const declared = ENV_REGISTRY.filter((r) => r.engineConsumed.kind === 'pair-resolver').map((r) => r.name);
    expect(declared, 'no pair-resolver row exists — this control has nothing to prove').not.toEqual([]);
    const unseen = declared.filter((n) => !viaPair.has(n));
    expect(
      unseen,
      'READ_PATTERNS no longer recognizes resolveClientPair(…) reads — the reverse inventory is blind to credential pairs',
    ).toEqual([]);
  });

  // The mirror of the forward test. Forward proves a declared row IS read;
  // this proves a real read IS declared. Without it the rows can be deleted
  // outright and every other test in this file stays green.
  it('every name passed to resolveClientPair() in src/ has a registry row', () => {
    const undeclared: string[] = [];
    for (const file of walk(resolve(repoRoot, 'src'), [])) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /\bresolveClientPair\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*,\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
      )) {
        for (const name of [m[1], m[2]]) {
          if (name && !registryNames.has(name)) undeclared.push(`${name} (${relative(repoRoot, file)})`);
        }
      }
    }
    expect(undeclared, 'a credential pair is resolved from names that have no contract row').toEqual([]);
  });
});
