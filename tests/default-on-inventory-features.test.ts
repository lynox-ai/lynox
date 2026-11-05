/**
 * `scripts/default-on-inventory.sh` also reads the feature flags' defaults: every `true`
 * entry of `CORE_FEATURE_DEFAULTS` in `src/core/features.ts`, recorded as `feature:<name>`.
 * `isFeatureEnabled` falls back to that table when a flag's env var is unset, so a
 * `false → true` there ships the feature to every instance that sets nothing. Before this
 * read, such a flip passed the guard green.
 *
 * The flip case uses the REAL `features.ts` and the `feature:` lines of the REAL inventory,
 * so it fails if the script stops reading the file the repository actually has. The config
 * half comes from a fixture schema with one field, so a config flag that changes in the
 * repository does not change these cases. The others pin the fail-closed read: a shape the
 * script cannot read stops the run, and says why.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A tree the script runs in (it `cd`s to its own parent): a one-field schema read with `?? true`, the given features.ts and inventory. */
function run(features: string, inventory: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'default-on-features-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src/types'), { recursive: true });
  mkdirSync(join(root, 'src/core'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/default-on-inventory.sh'), join(root, 'scripts/default-on-inventory.sh'));
  writeFileSync(join(root, 'src/types/schemas.ts'), 'export const Config = z.object({\n  x_flag: z.boolean().optional(),\n});\n');
  writeFileSync(join(root, 'src/core/features.ts'), features);
  writeFileSync(join(root, 'scripts/default-on-inventory.txt'), inventory);
  writeFileSync(join(root, 'src/flags.ts'), 'export const x = cfg.x_flag ?? true;\n');
  const r = spawnSync('bash', [join(root, 'scripts/default-on-inventory.sh')], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const realFeatures = readFileSync(join(repoRoot, 'src/core/features.ts'), 'utf8');
/** The real inventory's `feature:` lines, with the fixture's one config flag. */
const realFeatureInventory = `x_flag\n${readFileSync(join(repoRoot, 'scripts/default-on-inventory.txt'), 'utf8')
  .split('\n').filter((l) => l.startsWith('feature:')).join('\n')}\n`;
/** The read the script requires word for word (it is `isFeatureEnabled`'s last line in the real file). */
const READ_LINE = '  return CORE_FEATURE_DEFAULTS[flag as FeatureFlag] ?? _dynamicDefaults.get(flag) ?? false;';
const READ = `export function isFeatureEnabled(flag: string): boolean {\n${READ_LINE}\n}\n`;
const block = (entries: string, after = ''): string =>
  `const CORE_FEATURE_DEFAULTS: Record<FeatureFlag, boolean> = {\n${entries}};\n${after}${READ}`;
const recorded = (...extra: string[]): string => `# on record\nx_flag\n${extra.join('\n')}\n`;

describe('default-on-inventory reads the feature flags\' defaults', () => {
  it('passes the real features.ts against the real inventory\'s feature lines (the control for the flip below)', () => {
    expect(realFeatureInventory).toMatch(/^feature:/m);
    const { code, out } = run(realFeatures, realFeatureInventory);
    expect(out, out).toMatch(/clean ✓/);
    expect(code, out).toBe(0);
  });

  it('fails a flip from false to true in the real features.ts, naming the flag', () => {
    const flipped = realFeatures.replace("  'unified-inbox': false,", "  'unified-inbox': true,");
    expect(flipped).not.toBe(realFeatures);
    const { code, out } = run(flipped, realFeatureInventory);
    expect(code, out).toBe(1);
    expect(out).toContain('now default to ENABLED and are not recorded:');
    expect(out).toContain('  - feature:unified-inbox');
  });

  it('passes a true entry that is on record, and a false one that is not', () => {
    const { code, out } = run(block("  'on-flag': true,\n  // a comment line\n  'off-flag': false,\n"), recorded('feature:on-flag'));
    expect(out, out).toContain('clean ✓ (2 recorded default-ON flags)');
    expect(code, out).toBe(0);
  });

  it('says a recorded feature flag that went back to false is no longer default ON', () => {
    const { code, out } = run(block("  'on-flag': false,\n"), recorded('feature:on-flag'));
    expect(code, out).toBe(0);
    expect(out).toContain('no longer default ON');
    expect(out).toContain('  - feature:on-flag');
  });

  // Fail-closed: each of these would otherwise read as "nothing default-ON". Each names its
  // diagnosis: a missing table and an unreadable one are different repairs.
  const UNREADABLE = /read \d+ of \d+ lines of CORE_FEATURE_DEFAULTS .* refusing to report a clean run/;
  const NAMED = /CORE_FEATURE_DEFAULTS is named \d+ times .* refusing to report a clean run/;
  const unreadable: Array<[string, string, RegExp]> = [
    ['a value that is a constant', block("  'on-flag': ON_BY_DEFAULT,\n"), UNREADABLE],
    ['a value on the next line', block("  'on-flag':\n    true,\n"), UNREADABLE],
    ['an unquoted key', block('  onFlag: true,\n'), UNREADABLE],
    ['a spread', block("  ...OTHER_DEFAULTS,\n  'off-flag': false,\n"), UNREADABLE],
    ['an empty table', block(''), UNREADABLE],
    // With a plain entry beside it, so the line itself decides (not an otherwise empty table).
    ['a block comment in front of an entry', block("  'off-flag': false,\n  /* on */ 'on-flag': true,\n"), UNREADABLE],
    ['block comments on both sides of an entry', block("  'off-flag': false,\n  /* a */ 'on-flag': true, /* c */\n"), UNREADABLE],
    ['an entry behind a two-line block comment', block("  'off-flag': false,\n  /* a\n  */ 'on-flag': true,\n"), UNREADABLE],
    ['no table at all', 'export const nothing = 1;\n', NAMED],
    ['a write to the table after its declaration', block("  'on-flag': false,\n", "CORE_FEATURE_DEFAULTS['on-flag'] = true;\n"), NAMED],
    ['a write to the table in place of the read', `const CORE_FEATURE_DEFAULTS: Record<FeatureFlag, boolean> = {\n  'on-flag': false,\n};\nCORE_FEATURE_DEFAULTS['on-flag'] = true;\n`, NAMED],
    ['a write on the read line itself', block("  'on-flag': false,\n").replace(READ_LINE, `${READ_LINE} CORE_FEATURE_DEFAULTS['on-flag'] = true;`), NAMED],
    ['a read that changes the default itself', block("  'on-flag': false,\n").replace(READ_LINE, '  return CORE_FEATURE_DEFAULTS[flag as FeatureFlag] ?? true;'), NAMED],
    ['an entry on the opening line', `const CORE_FEATURE_DEFAULTS: Record<FeatureFlag, boolean> = { 'on-flag': true,\n  'off-flag': false,\n};\n${READ}`, NAMED],
  ];
  for (const [what, features, diagnosis] of unreadable) {
    it(`refuses to report clean on ${what}, and says why`, () => {
      const { code, out } = run(features, recorded());
      expect(code, out).toBe(1);
      expect(out).toMatch(diagnosis);
      expect(out).not.toMatch(/clean ✓/);
    });
  }
});
