/**
 * `scripts/default-on-inventory.sh` also reads the feature flags' defaults: every `true`
 * entry of `CORE_FEATURE_DEFAULTS` in `src/core/features.ts`, recorded as `feature:<name>`.
 * `isFeatureEnabled` falls back to that table when a flag's env var is unset, so a
 * `false → true` there ships the feature to every instance that sets nothing. Before this
 * read, such a flip passed the guard green.
 *
 * The first case flips a flag in the REAL `features.ts` against the REAL inventory, so it
 * fails if the script stops reading the file the repository actually has. The others pin
 * the fail-closed read: a shape the script cannot read stops the run.
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

/** A tree the script runs in (it `cd`s to its own parent): the real schema and src, the given features.ts and inventory. */
function run(features: string, inventory: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'default-on-features-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src/types'), { recursive: true });
  mkdirSync(join(root, 'src/core'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/default-on-inventory.sh'), join(root, 'scripts/default-on-inventory.sh'));
  copyFileSync(join(repoRoot, 'src/types/schemas.ts'), join(root, 'src/types/schemas.ts'));
  writeFileSync(join(root, 'src/core/features.ts'), features);
  writeFileSync(join(root, 'scripts/default-on-inventory.txt'), inventory);
  // The config reads the real script finds (`?? true`, `!== false`) live under src/; the
  // fixture tree has only the two files above, so it carries them as one line each.
  writeFileSync(join(root, 'src/flags.ts'), 'export const a = cfg.bugsink_enabled ?? true;\nexport const b = cfg.changeset_review ?? true;\nexport const c = cfg.http_html_extract ?? true;\n');
  const r = spawnSync('bash', [join(root, 'scripts/default-on-inventory.sh')], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const realFeatures = readFileSync(join(repoRoot, 'src/core/features.ts'), 'utf8');
const realInventory = readFileSync(join(repoRoot, 'scripts/default-on-inventory.txt'), 'utf8');
const block = (entries: string): string => `const CORE_FEATURE_DEFAULTS: Record<FeatureFlag, boolean> = {\n${entries}};\n`;
const recorded = (...extra: string[]): string => `# on record\nbugsink_enabled\nchangeset_review\nhttp_html_extract\n${extra.join('\n')}\n`;

describe('default-on-inventory reads the feature flags\' defaults', () => {
  it('passes the real features.ts against the real inventory (the control for the flip below)', () => {
    const { code, out } = run(realFeatures, realInventory);
    expect(out, out).toMatch(/clean ✓/);
    expect(code, out).toBe(0);
  });

  it('fails a flip from false to true in the real features.ts, naming the flag', () => {
    const flipped = realFeatures.replace("  'unified-inbox': false,", "  'unified-inbox': true,");
    expect(flipped).not.toBe(realFeatures);
    const { code, out } = run(flipped, realInventory);
    expect(code, out).toBe(1);
    expect(out).toContain('now default to ENABLED and are not recorded:');
    expect(out).toContain('  - feature:unified-inbox');
  });

  it('passes a true entry that is on record, and a false one that is not', () => {
    const { code, out } = run(block("  'on-flag': true,\n  // a comment line\n  'off-flag': false,\n"), recorded('feature:on-flag'));
    expect(out, out).toContain('clean ✓ (4 recorded default-ON flags)');
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
  const unreadable: Array<[string, string, RegExp]> = [
    ['a value that is a constant', block("  'on-flag': ON_BY_DEFAULT,\n"), UNREADABLE],
    ['a value on the next line', block("  'on-flag':\n    true,\n"), UNREADABLE],
    ['an unquoted key', block('  onFlag: true,\n'), UNREADABLE],
    ['a spread', block("  ...OTHER_DEFAULTS,\n  'off-flag': false,\n"), UNREADABLE],
    ['an empty table', block(''), UNREADABLE],
    ['no table at all', 'export const nothing = 1;\n', /found no CORE_FEATURE_DEFAULTS block .* refusing to report a clean run/],
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
