/**
 * A real Engine boot on an instance that holds the exact marker (the steady state of a held
 * managed instance after its first restart), with a DSN set: error reporting never starts, and an
 * unhandled rejection afterwards leaves the process running with only the reduced line. That
 * `client:none` can fail is shown by deleting the marker check in `_initBugsink`: the same boot
 * then reports `client:built`.
 */
import { it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHILD = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'error-egress-boot-child.ts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

it('booting with the marker on disk: no reporter, and a rejection leaves the process running with no provider text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-egress-boot-'));
  dirs.push(dir);
  const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dir], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(r.stdout).toContain('client:none');
  expect(r.stdout).toContain('still-running');
  expect(r.status).toBe(0);
  expect(r.stderr).not.toContain('PROVIDER-BODY-7f3a');
  expect(r.stderr.split('[lynox] unhandled rejection: Error (HTTP 400)').length - 1).toBe(1);
}, 90_000);
