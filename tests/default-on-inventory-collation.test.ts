/**
 * `scripts/default-on-inventory.sh` sorts the flags it finds and the flags it has on
 * record, then compares the two with `comm`, which needs both inputs in its own order.
 * Every `sort` and `comm` there is pinned to `LC_ALL=C`; these cases are what make each
 * pin observable.
 *
 * They run the script under en_US.UTF-8 over flag names whose en_US order differs from
 * their byte order. A `sort` and a `comm` that disagree then report flags that are on
 * record as new. Which half disagrees depends on the coreutils (measured 2026-09-21):
 * uutils `sort` follows the locale while uutils `comm` compares bytes; GNU follows the
 * locale in both, so there each pin carries the load on its own. uutils `sort -u` also
 * treats `a_b_c` and `abc` as one line under en_US and drops the second, which is why
 * both are in the fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALE = 'en_US.UTF-8';

/** en_US and byte order disagree on these, under both GNU and uutils `sort`. */
const FLAGS = ['a_c', 'ab', 'a_row_that_exists', 'abc', 'a_b_c', 'retire_raw_refresh_token', 'retired_x'];

function sortUnder(locale: string): string {
  return spawnSync('sort', [], {
    input: `${FLAGS.join('\n')}\n`,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: locale },
  }).stdout;
}

const dirs: string[] = [];

beforeAll(() => {
  // The instrument before the measurement: without the locale installed, `sort` falls
  // back to byte order and every case below would pass against an unpinned script too.
  expect(
    sortUnder(LOCALE),
    `${LOCALE} does not change the sort order on this machine, so this suite cannot tell a pinned script from an unpinned one`,
  ).not.toBe(sortUnder('C'));
});

afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A tree the script can run in: it `cd`s to its own parent directory. Every flag in
 *  `defaultOn` is read with `?? true`; `recorded` is the inventory on file. */
function run(defaultOn: string[], recorded: string[]): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'default-on-collate-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src/types'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/default-on-inventory.sh'), join(root, 'scripts/default-on-inventory.sh'));
  writeFileSync(
    join(root, 'src/types/schemas.ts'),
    `export const Config = z.object({\n${defaultOn.map((f) => `  ${f}: z.boolean().optional(),`).join('\n')}\n});\n`,
  );
  writeFileSync(join(root, 'src/flags.ts'), defaultOn.map((f) => `export const ${f}_on = cfg.${f} ?? true;`).join('\n') + '\n');
  writeFileSync(join(root, 'scripts/default-on-inventory.txt'), `# on record\n${recorded.join('\n')}\n`);
  const r = spawnSync('bash', [join(root, 'scripts/default-on-inventory.sh')], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: LOCALE },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** The `  - <flag>` lines of one output block, in order. */
function listed(out: string, header: string): string[] {
  const block = out.split(header)[1]?.split('\n\n')[0] ?? '';
  return [...block.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1] as string);
}

describe('default-on-inventory under a language locale', () => {
  it('reports nothing when every default-ON flag is on record, whatever the locale orders first', () => {
    const { code, out } = run(FLAGS, FLAGS);
    expect(out).not.toMatch(/not in sorted order/);
    expect(out, out).toContain(`default-on-inventory: clean ✓ (${FLAGS.length} recorded default-ON flags)`);
    expect(code, out).toBe(0);
  });

  it('names exactly the new flag, and no recorded one', () => {
    // With identical lists `comm` only ever compares equal pairs, so a `sort`/`comm`
    // order mismatch is invisible; one unrecorded flag is what makes it show.
    const { code, out } = run([...FLAGS, 'ab_extra'], FLAGS);
    expect(listed(out, 'now default to ENABLED and are not recorded:'), out).toEqual(['ab_extra']);
    expect(out).not.toContain('no longer default ON');
    expect(code).toBe(1);
  });
});
