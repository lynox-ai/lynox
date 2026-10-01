/**
 * `.github/workflows/dependabot-auto-merge.yml` — which dependabot PRs may merge themselves.
 *
 * The decision step's REAL `run:` block is executed here against a stub `gh`, so every branch of
 * the rule is driven, not just read: majors, groups, multi-dependency PRs and stale branches are
 * refused, and so is every case where the step cannot establish the facts (fail-closed). The one
 * case that is allowed — a single non-major update, 0 commits behind main — is the positive
 * control; without it a step that refuses everything would pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/dependabot-auto-merge.yml');

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string };
const doc = parse(readFileSync(FILE, 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
const steps = doc.jobs['enable-auto-merge']?.steps ?? [];
const decide = steps.find((s) => s.id === 'decide');

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'automerge-')); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** Run the decision block. `gh` is a stub that prints `behind` or exits with `ghExit`. */
function decideWith(env: { UPDATE_TYPE?: string; GROUP?: string; NAMES?: string }, gh: { behind?: string; ghExit?: number }) {
  const bin = mkdtempSync(join(dir, 'bin-'));
  writeFileSync(join(bin, 'gh'), gh.ghExit !== undefined ? `#!/bin/sh\nexit ${gh.ghExit}\n` : `#!/bin/sh\nprintf '%s\\n' '${gh.behind ?? ''}'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const out = join(bin, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-e', '-c', decide?.run ?? 'exit 99'], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: out, REPO: 'o/r', HEAD_SHA: 'abc',
      UPDATE_TYPE: env.UPDATE_TYPE ?? 'version-update:semver-patch', GROUP: env.GROUP ?? '', NAMES: env.NAMES ?? 'left-pad',
    },
  });
  return { code: r.status, eligible: /eligible=true/.test(readFileSync(out, 'utf8')), log: `${r.stdout}${r.stderr}` };
}

describe('dependabot-auto-merge — the decision', () => {
  it('POSITIVE CONTROL: one non-major update, 0 behind main → eligible', () => {
    const r = decideWith({}, { behind: '0' });
    expect(r.code).toBe(0);
    expect(r.eligible).toBe(true);
  });

  it.each([
    ['a major update', { UPDATE_TYPE: 'version-update:semver-major' }, { behind: '0' }, 'major'],
    ['a group PR', { GROUP: 'minor-and-patch' }, { behind: '0' }, 'group PR'],
    ['a PR naming two dependencies without a group', { NAMES: 'a, b' }, { behind: '0' }, 'not exactly one'],
    ['a PR naming no dependency', { NAMES: '' }, { behind: '0' }, 'not exactly one'],
    ['a branch behind main', {}, { behind: '3' }, '3 commit(s) behind'],
    ['gh failing (fail-closed)', {}, { ghExit: 1 }, 'could not read'],
    ['gh answering garbage (fail-closed)', {}, { behind: 'null' }, 'could not read'],
  ])('%s → not eligible', (_t, env, gh, why) => {
    const r = decideWith(env, gh);
    expect(r.code).toBe(0);
    expect(r.eligible).toBe(false);
    expect(r.log).toContain(why);
  });
});

describe('dependabot-auto-merge — the wiring', () => {
  it('enables auto-merge ONLY on the decision, and switches it off otherwise', () => {
    const enable = steps.find((s) => (s.run ?? '').includes('gh pr merge --auto'));
    const disable = steps.find((s) => (s.run ?? '').includes('--disable-auto'));
    expect(enable?.if?.replace(/\s/g, '')).toBe("steps.decide.outputs.eligible=='true'");
    expect(disable?.if?.replace(/\s/g, '')).toBe("steps.decide.outputs.eligible!='true'");
  });

  it('checks nothing out — it runs on pull_request_target with a write token', () => {
    expect(steps.filter((s) => (s.uses ?? '').startsWith('actions/checkout'))).toEqual([]);
  });
});
