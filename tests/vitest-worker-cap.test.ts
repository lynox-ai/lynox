/**
 * vitest.config.ts caps a run at two forks, and the cap stays overridable from the command line.
 *
 * Read from vitest's own resolved config, in a child process so this run's state stays out of it.
 * vitest gives a project's own `maxWorkers` precedence over the root value, and `--maxWorkers`
 * only sets the root value: a cap placed on the projects would hold and ignore the flag.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

const PROBE = `
import { createVitest } from 'vitest/node';
const cli = process.argv[1] ? { maxWorkers: Number(process.argv[1]) } : {};
const vitest = await createVitest('test', { watch: false, run: true, ...cli }, {}, {});
console.log('RESOLVED ' + JSON.stringify({
  root: vitest.config.maxWorkers ?? null,
  projects: vitest.projects.map((p) => [p.name, p.config.maxWorkers ?? null]),
}));
await vitest.close();
`;

interface Resolved { root: number | null; projects: [string, number | null][] }

function resolved(cliMaxWorkers?: number): Resolved {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('VITEST')) delete env[k];
  const args = ['--input-type=module', '-e', PROBE];
  if (cliMaxWorkers !== undefined) args.push(String(cliMaxWorkers));
  const out = execFileSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const line = out.split('\n').find((l) => l.startsWith('RESOLVED '));
  if (line === undefined) throw new Error(`probe printed no result:\n${out}`);
  return JSON.parse(line.slice('RESOLVED '.length)) as Resolved;
}

describe('vitest.config.ts worker cap', { timeout: 120_000 }, () => {
  it('runs with two forks by default, set once at the root for both projects', () => {
    const r = resolved();
    expect(r.root).toBe(2);
    expect(r.projects.map(([name]) => name).sort()).toEqual(['browser-compile', 'node']);
    for (const [, own] of r.projects) expect(own).toBeNull();
  });

  it('lets --maxWorkers replace the cap', () => {
    const r = resolved(1);
    expect(r.root).toBe(1);
    for (const [, own] of r.projects) expect(own).toBeNull();
  });
});
