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
import { GOOGLE_CLIENT_PAIR } from '../src/core/google-client-pair.js';
// Imported so DELETING the weld file is a failure rather than a silent loss.
// Nothing else references it — the same device mirrors.ts relies on.
import { pairBrandWelds } from '../src/core/google-client-pair.welds.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import {
  ENV_REGISTRY,
  SELF_HOST_ONLY,
  PREFIX_FAMILIES,
  type EnvRegistryRow,
  type EngineReadKind,
} from '../src/contract/env-registry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(repoRoot, p), 'utf8');

// ── Forward: row → real read form at the real site ──────────────────────────

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** SvelteKit `$env/dynamic/private` read forms: `env.NAME` or `env['NAME']`. */
const webUiForms = (name: string): RegExp[] => [
  new RegExp(`\\benv(\\.${esc(name)}\\b|\\[['"]${esc(name)}['"]\\])`),
];

/**
 * The form set asserted at ONE site. Extracted from the forward loop so it can
 * be tested directly: while it was inline, widening it (accepting a bare env
 * read at the PRIMARY site) changed nothing any test could see, because no
 * production file exercises the widened case today. A guard whose loosening is
 * invisible is not a guard.
 */
function formsForSite(row: EnvRegistryRow, site: string): RegExp[] {
  const forms = readForms(row);
  if (site.startsWith('packages/web-ui/')) forms.push(...webUiForms(row.name));
  // A pair member is also read directly at every secondary site — the migration
  // decision is the only one today. Never at the PRIMARY site: there, two
  // independent process.env reads would pass as a resolved pair.
  if (row.engineConsumed.kind === 'pair-resolver' && site !== row.engineConsumed.readSite) {
    forms.push(new RegExp(`process\\.env(\\.${esc(row.name)}\\b|\\[['"]${esc(row.name)}['"]\\])`));
  }
  return forms;
}

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
      // The member NAMES are deliberately absent from the call site now: the
      // resolver takes one branded descriptor, so there is no argument order to
      // get wrong. This form therefore asserts only that the declared site calls
      // the resolver at all — the naming is welded elsewhere, and more strongly:
      //   · the descriptor ≡ its registry row (the drift test below);
      //   · nothing but the branded descriptor is accepted (the compile welds in
      //     src/core/google-client-pair.welds.ts).
      // Earlier revisions matched the two literals in order, which was text
      // matching standing in for a type. It caught a swap only where it already
      // knew to look; the compiler catches it everywhere, including call sites
      // that do not exist yet.
      return [/\bresolveClientPair\s*\(/];
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
      it(`${row.name} declares its pair, and is a member of it`, () => {
        const pair = row.engineConsumed.pair;
        expect(pair, `${row.name}: kind 'pair-resolver' requires pair`).toBeDefined();
        expect(
          [pair?.id, pair?.secret],
          `${row.name} declares a pair it is not a member of`,
        ).toContain(row.name);
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
        // A site inside web-ui always reads via the SvelteKit env object,
        // whatever the row's primary kind is (e.g. a core 'direct' row with a
        // web-ui alsoReadAt) — see formsForSite.
        const forms = formsForSite(row, site);
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

describe('env-ABI forward: the pair-resolver form rejects near-misses', () => {
  // What is left to check at the TEXT level is narrow, and that is the point.
  // A swapped or foreign-partnered pair used to be a regex question; since the
  // resolver takes a branded descriptor it is a COMPILE question, pinned in
  // src/core/google-client-pair.welds.ts. Those cases are gone from here rather
  // than duplicated: a text check that mirrors a compile check adds no coverage
  // and rots independently.
  const row: EnvRegistryRow = {
    name: 'GOOGLE_CLIENT_ID',
    valueKind: 'opaque',
    emitPolicy: 'when-non-default',
    engineConsumed: { kind: 'pair-resolver', pair: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' }, readSite: 'src/core/engine.ts' },
  };
  const matches = (src: string): boolean => readForms(row).some((f) => f.test(src));

  it('accepts a real resolver call', () => {
    expect(matches('const p = resolveClientPair(GOOGLE_CLIENT_PAIR, { vault });')).toBe(true);
  });

  const rejected: [string, string][] = [
    ['a differently-named resolver', 'resolveClientPairLegacy(GOOGLE_CLIENT_PAIR, {})'],
    ['a helper whose name merely ends with the resolver', 'myresolveClientPair(GOOGLE_CLIENT_PAIR, {})'],
    ['a bare mention in prose', '// resolveClientPair is described here without being called'],
  ];
  for (const [label, src] of rejected) {
    it(`rejects ${label}`, () => {
      expect(matches(src), `${label} must not match`).toBe(false);
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

/**
 * Every problem with the pair descriptors in `rows`. A function rather than an
 * inline loop so its branches can be driven by synthetic rows — against the
 * real registry they are unreachable, and an unreachable branch reads green
 * whatever it does.
 *
 * There is deliberately NO separate "the partner has the wrong kind" check: it
 * is implied. Symmetry requires the partner to declare the same descriptor, so
 * the partner has a pair, so the kind check above fires when the loop reaches
 * it. Both were present once and neither could be killed alone — a redundant
 * pair reads as two guards and is one.
 */
function pairProblems(rows: readonly EnvRegistryRow[]): string[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const problems: string[] = [];
  for (const row of rows) {
    const pair = row.engineConsumed.pair;
    if (!pair) continue;
    if (row.engineConsumed.kind !== 'pair-resolver') {
      problems.push(`${row.name} carries a pair descriptor but kind is '${row.engineConsumed.kind}'`);
    }
    if (pair.id === pair.secret) problems.push(`${row.name} pairs with itself`);
    for (const member of [pair.id, pair.secret]) {
      const partner = byName.get(member);
      if (!partner) { problems.push(`${row.name} pairs with ${member}, which has no row`); continue; }
      const other = partner.engineConsumed.pair;
      if (!other || other.id !== pair.id || other.secret !== pair.secret) {
        problems.push(`${member} does not declare the same descriptor as ${row.name}`);
      }
    }
  }
  return problems;
}

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

  // Both members of a declared pair must themselves be rows. This is the
  // coupling the file-wide source scan was reaching for, expressed as DATA
  // instead of as a regex over source text: deleting one row leaves the other
  // naming a member that does not exist, and it cannot drift with syntax.
  //
  // What this asserts is weaker than it reads, and this is the fourth attempt
  // at saying so accurately. The forward test matches source TEXT at the
  // declared readSite — it does not verify that a CALL happens. Measured:
  // rename both real calls to `resolveClientPairX(` and leave one commented-out
  // correct call behind, and this file stays green. What pins the real
  // behaviour is the boot test (`src/core/engine-client-pair-boot.test.ts`),
  // not this file; this file pins the DECLARATION against the text.
  //
  // Nor does anything here check that EVERY call resolves a declared pair: a
  // second call in the same file can swap the members. A counting check was
  // built twice and removed twice, and the reason belongs here so there is no
  // third attempt — enforcing this over source text needs a lexer, and every
  // approximation of one shipped a SILENT FAIL-OPEN. The last was defeated by
  // an ordinary `const g = 'src/*';`: the unpaired `/*` opened a pseudo-comment
  // that swallowed 263 lines and a wrong call with them, and the suite stayed
  // green. A guard that fails open is worse than none — a green check reads as
  // coverage, so it removes the pressure to fix what it is not checking.
  //
  // The fix that closes this removes the possibility rather than chasing it:
  // resolveClientPair taking the pair descriptor the contract already declares
  // leaves no argument order to swap. Tracked as
  // DEF-pair-resolver-swap-detectable-not-impossible with a compile-level
  // acceptance test, so no future regex can be mistaken for having closed it.

  it('the pair check rejects each broken shape (synthetic rows)', () => {
    // The branches of pairProblems are only reachable through a registry mutation,
    // so on the real registry they read green whatever they do. Synthetic rows
    // make each one killable on its own.
    const row = (name: string, kind: EngineReadKind, pair?: { id: string; secret: string }): EnvRegistryRow => ({
      name, valueKind: 'opaque', emitPolicy: 'operator-only',
      engineConsumed: { kind, ...(pair ? { pair } : {}), readSite: 'src/core/engine.ts' },
    });
    const P = { id: 'A_ID', secret: 'A_SECRET' };
    const ok = [row('A_ID', 'pair-resolver', P), row('A_SECRET', 'pair-resolver', P)];
    expect(pairProblems(ok), 'a well-formed pair must produce no problem').toEqual([]);
    expect(pairProblems([row('A_ID', 'direct', P), row('A_SECRET', 'pair-resolver', P)])).not.toEqual([]);
    expect(pairProblems([row('A_ID', 'pair-resolver', { id: 'A_ID', secret: 'A_ID' })])).not.toEqual([]);
    expect(pairProblems([row('A_ID', 'pair-resolver', P)])).not.toEqual([]);
    // The mirror case, and it is not decoration: the `pair.id` half of the member
    // loop is exercised by the cases above, but nothing makes its REMOVAL
    // detectable — narrowing the loop to the secret half alone survived until
    // this line existed. Measured, both narrowings now fail.
    expect(pairProblems([row('A_SECRET', 'pair-resolver', P)])).not.toEqual([]);
    expect(pairProblems([row('A_ID', 'pair-resolver', P), row('A_SECRET', 'pair-resolver', { id: 'A_SECRET', secret: 'A_ID' })])).not.toEqual([]);
  });

  it('the compile welds for the pair brands are present', () => {
    // Not a value assertion — the IMPORT is the assertion. If
    // google-client-pair.welds.ts is deleted, this file no longer resolves.
    expect(typeof pairBrandWelds).toBe('function');
  });

  it('the branded constant in src/core matches its registry descriptor', () => {
    // The brands are minted in google-client-pair.ts, deliberately NOT in the
    // contract: a contract change obliges every vendored copy to re-sync, and
    // the registry already declares the same pair as data. That leaves two
    // declarations of one fact, so this is the weld that stops them drifting.
    // Without it, renaming a member in the registry would leave the resolver
    // reading the old name with a perfectly green contract test.
    const row = ENV_REGISTRY.find((r) => r.name === GOOGLE_CLIENT_PAIR.id);
    expect(row?.engineConsumed.pair, 'the id member has no pair descriptor').toBeDefined();
    expect({ id: row?.engineConsumed.pair?.id, secret: row?.engineConsumed.pair?.secret }).toEqual({
      id: String(GOOGLE_CLIENT_PAIR.id),
      secret: String(GOOGLE_CLIENT_PAIR.secret),
    });
  });

  it('every pair descriptor is kind-checked, complete and symmetric', () => {
    expect(pairProblems([...ENV_REGISTRY]), 'a pair descriptor is inert, incomplete or asymmetric').toEqual([]);
  });
});
