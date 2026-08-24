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
    case 'pair-resolver': {
      // The asserted form is the WHOLE call, both members in order. Pinning one
      // argument at a time was not enough: it accepted a member paired with a
      // FOREIGN partner. Order plus partner in one regex closes both.
      // The direct `process.env` form is NOT here: it is added per-site for
      // `alsoReadAt` only, so the primary site stays pinned to the resolver.
      const pair = row.engineConsumed.pair;
      if (!pair) return [/$^/]; // no pair declared → matches nothing; the row-level test below says why
      return [new RegExp(`\\bresolveClientPair\\(\\s*['"]${esc(pair.id)}['"]\\s*,\\s*['"]${esc(pair.secret)}['"]`)];
    }
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
    if (kind === 'pair-resolver' && readSite) {
      it(`every resolveClientPair call in ${readSite} resolves ${row.name}'s pair`, () => {
        // `some()` above asks whether the file CONTAINS a matching call. It does
        // not ask whether EVERY call matches — and engine.ts holds two (the init
        // path and reloadGoogle), so swapping the second one passed. Scoped to
        // the declared file, not the repo: this counts plain calls and requires
        // all of them to be the declared pair.
        //
        // What it does not see, and this is the honest limit rather than a
        // promise: `resolveClientPair?.(`, `.call(`, `.apply(`, a generic
        // `<T>(`, or an aliased binding. Those are not caught anywhere; the
        // fix that removes the possibility is
        // DEF-pair-resolver-swap-detectable-not-impossible.
        const src = read(readSite);
        const all = [...src.matchAll(/\bresolveClientPair\s*\(/g)].length;
        const matching = [...src.matchAll(new RegExp(readForms(row)[0]?.source ?? '$^', 'g'))].length;
        expect(all, `${readSite}: no resolveClientPair call found at all`).toBeGreaterThan(0);
        expect(matching, `${readSite}: ${all - matching} of ${all} calls do not resolve the declared pair in order`).toBe(all);
      });

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

describe('env-ABI forward: the pair-resolver form set rejects near-misses', () => {
  const ID = 'GOOGLE_CLIENT_ID';
  const SECRET = 'GOOGLE_CLIENT_SECRET';
  const row: EnvRegistryRow = {
    name: ID,
    valueKind: 'opaque',
    emitPolicy: 'operator-only',
    engineConsumed: { kind: 'pair-resolver', pair: { id: ID, secret: SECRET }, readSite: 'src/core/engine.ts' },
  };
  const matches = (src: string): boolean => readForms(row).some((f) => f.test(src));

  it('accepts the real resolver call', () => {
    expect(matches(`resolveClientPair('${ID}', '${SECRET}', {`)).toBe(true);
  });

  it('accepts a bare env read at a SECONDARY site but not at the primary one', () => {
    // The asymmetry is the point: at the declared site the resolver call is the
    // only accepted form, so swapping it for two independent process.env reads
    // fails. At a migration site the direct read IS the real form.
    const envRead = `!process.env['${ID}'] && !process.env['${SECRET}']`;
    const at = (site: string): boolean => formsForSite(row, site).some((f) => f.test(envRead));
    expect(at('src/core/engine.ts'), 'the primary site must reject a bare env read').toBe(false);
    expect(at('src/core/engine-init.ts'), 'a secondary site must accept it').toBe(true);
  });

  const rejected: [string, string][] = [
    ['a differently-named resolver', `resolveClientPairLegacy('${ID}', '${SECRET}')`],
    ['a helper whose name merely ends with the resolver', `myresolveClientPair('${ID}', '${SECRET}')`],
    ['longer names sharing the prefix', `resolveClientPair('${ID}_LEGACY', '${SECRET}_LEGACY')`],
    ['another provider pair', `resolveClientPair('MS_CLIENT_ID', 'MS_CLIENT_SECRET', {`],
    // Ships the client SECRET as the client id.
    ['a SWAPPED call', `resolveClientPair('${SECRET}', '${ID}', {`],
    // One real member, a foreign partner — the shape a one-argument form let through.
    ['a FOREIGN partner in position 1', `resolveClientPair('MS_CLIENT_ID', '${SECRET}', {`],
    ['a FOREIGN partner in position 2', `resolveClientPair('${ID}', 'MS_CLIENT_SECRET', {`],
    // Accepted only at an alsoReadAt site, added there by the site loop.
    ['a bare direct env read', `!process.env['${ID}'] && !process.env['${SECRET}']`],
    ['a dotted env read of a longer name', `process.env.${ID}_LEGACY`],
    ['a bare mention in a comment', `// ${ID} / ${SECRET} env copies were removed`],
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
  // What this does NOT do: nothing detects a resolveClientPair call in a file
  // the registry does not name. The declared file IS fully checked — every
  // plain call in it, not just one — by the forward test above; an earlier
  // version of this comment claimed the declared SITE was pinned when in truth
  // only one call in it was. The real fix removes the possibility instead of
  // chasing it — DEF-pair-resolver-swap-detectable-not-impossible.
  it('every pair descriptor is kind-checked, complete and symmetric', () => {
    // One-directional and kind-blind was not enough: a `pair` on a
    // `kind: 'direct'` row is inert but was being VALIDATED here, and dropping
    // the partner's descriptor left the surviving row happily pointing at it.
    const byName = new Map(ENV_REGISTRY.map((r) => [r.name, r]));
    const problems: string[] = [];
    for (const row of ENV_REGISTRY) {
      const pair = row.engineConsumed.pair;
      if (!pair) continue;
      if (row.engineConsumed.kind !== 'pair-resolver') {
        problems.push(`${row.name} carries a pair descriptor but kind is '${row.engineConsumed.kind}'`);
      }
      if (pair.id === pair.secret) problems.push(`${row.name} pairs with itself`);
      for (const member of [pair.id, pair.secret]) {
        const partner = byName.get(member);
        if (!partner) { problems.push(`${row.name} pairs with ${member}, which has no row`); continue; }
        if (partner.engineConsumed.kind !== 'pair-resolver') {
          problems.push(`${row.name} pairs with ${member}, whose kind is '${partner.engineConsumed.kind}'`);
        }
        const other = partner.engineConsumed.pair;
        if (!other || other.id !== pair.id || other.secret !== pair.secret) {
          problems.push(`${member} does not declare the same descriptor as ${row.name}`);
        }
      }
    }
    expect(problems, 'a pair descriptor is inert, incomplete or asymmetric').toEqual([]);
  });
});
