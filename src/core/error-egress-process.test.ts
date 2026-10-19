/**
 * An error nobody caught, in a REAL child process: with an exact connection held, stderr gets
 * the class and status only. The control is the same child without the marker, where Node
 * prints the provider's text, so the absence below is the handler's doing.
 */
import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CHILD = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'error-egress-child.ts');

function run(mode: 'uncaught' | 'rejection', held: 'held' | 'free', reporting: false | 'reporting' | 'reporting-removed' | 'reporting-late' | 'listener' = false): { code: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, mode, held, ...(reporting ? [reporting] : [])], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout };
}

const FRAME = /error-egress-child\.ts:\d+/;
const count = (text: string, needle: string): number => text.split(needle).length - 1;

it('an uncaught exception under an exact connection writes class and status, no stack, and ends the process', () => {
  const held = run('uncaught', 'held');
  expect(count(held.stderr, '[lynox] uncaught exception: Error (HTTP 400)')).toBe(1);
  expect(held.stderr).not.toMatch(FRAME);          // no stack: frames cannot be told from message lines
  expect(held.stderr).not.toContain('PROVIDER-BODY-7f3a');
  expect(held.code).toBe(1);

  const free = run('uncaught', 'free');
  expect(free.stderr).toContain('PROVIDER-BODY-7f3a');
  expect(free.code).not.toBe(0);
}, 45_000);

it('an unhandled rejection under an exact connection writes class and status and the process runs on', () => {
  const held = run('rejection', 'held');
  expect(count(held.stderr, '[lynox] unhandled rejection: Error (HTTP 400)')).toBe(1);
  expect(held.stderr).not.toMatch(FRAME);
  expect(held.stderr).not.toContain('PROVIDER-BODY-7f3a');
  expect(held.stdout).toContain('still-running');
  expect(held.code).toBe(0);

  // Control: with no listener at all, Node ends the process on the same rejection.
  const free = run('rejection', 'free');
  expect(free.stderr).toContain('PROVIDER-BODY-7f3a');
  expect(free.stdout).not.toContain('still-running');
  expect(free.code).not.toBe(0);
}, 45_000);

it('with error reporting on, the marker refuses it: one reduced line per error; an uncaught error ends the process, a rejection does not', () => {
  for (const mode of ['uncaught', 'rejection'] as const) {
    const held = run(mode, 'held', 'reporting');
    const line = mode === 'uncaught' ? '[lynox] uncaught exception: Error (HTTP 400)' : '[lynox] unhandled rejection: Error (HTTP 400)';
    // One line: the reporter's own handler, which writes the same line, is gone with the refusal.
    expect(count(held.stderr, line), mode).toBe(1);
    expect(held.stderr, mode).not.toMatch(FRAME);
    expect(held.stderr, mode).not.toContain('PROVIDER-BODY-7f3a');
    if (mode === 'rejection') {
      // Reporting was on: the process runs on through a rejection.
      expect(held.stdout).toContain('still-running');
      expect(held.code).toBe(0);
    } else {
      expect(held.code).toBe(1);
    }

    // Control: without the marker the reporter's handler prints the error with its stack.
    const free = run(mode, 'free', 'reporting');
    expect(free.stderr, mode).toContain('PROVIDER-BODY-7f3a');
    expect(free.stderr, mode).toMatch(FRAME);
  }
}, 90_000);

it('error reporting started after the marker is refused, so no reporter handler joins the reduced ones', () => {
  const held = run('uncaught', 'held', 'reporting-late');
  expect(held.stdout).toContain('late-init:false');
  expect(count(held.stderr, '[lynox] uncaught exception: Error (HTTP 400)')).toBe(1);
  expect(held.stderr).not.toContain('PROVIDER-BODY-7f3a');
  expect(held.code).toBe(1);
}, 45_000);

it('once error reporting removed its handlers, the reduced ones write and end the process again', () => {
  const held = run('uncaught', 'held', 'reporting-removed');
  expect(count(held.stderr, '[lynox] uncaught exception: Error (HTTP 400)')).toBe(1);
  expect(held.stderr).not.toContain('PROVIDER-BODY-7f3a');
  expect(held.code).toBe(1);
}, 45_000);

it('beside another listener the reduced handlers write but leave the exit to it, as Node does', () => {
  for (const mode of ['uncaught', 'rejection'] as const) {
    const held = run(mode, 'held', 'listener');
    expect(held.stderr, mode).toContain('Error (HTTP 400)');
    expect(held.stderr, mode).not.toContain('PROVIDER-BODY-7f3a');
    expect(held.code, mode).toBe(0);
  }
}, 45_000);

// Under the marker, once the reduced handlers are installed, a rejection never ends the process.
// main differs without a DSN, where it crashes. The state with the marker on disk at boot is a
// real engine boot in `error-egress-boot.test.ts`.
it.each([
  ['the marker set at runtime, error reporting running', 'reporting'],
  ['no DSN', false],
] as const)('under the marker, %s: a rejection leaves the process running and no provider text in stderr', (_state, reporting) => {
  const held = run('rejection', 'held', reporting);
  expect(held.stdout).toContain('still-running');
  expect(held.code).toBe(0);
  expect(held.stderr).not.toContain('PROVIDER-BODY-7f3a');
  expect(count(held.stderr, '[lynox] unhandled rejection: Error (HTTP 400)')).toBe(1);
}, 45_000);
