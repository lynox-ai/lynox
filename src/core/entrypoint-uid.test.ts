import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The container entrypoint for a uid that has no name in the image. The installer runs the
// container as the host user's uid; the image names only node (1000) and lynox (1001).
//
// `id` on PATH stands in for that uid: `id -u` prints it, `id -un` fails the way coreutils does
// for a uid without a passwd entry (message on stderr, exit 1, measured in a container run as
// uid 1002 on the image built from main). A real uid without a name needs root or a user
// namespace, which this test cannot assume; the container run is where that is measured.
// Everything else is the real script, run to its last line by the host's `sh`.
//
// Only the host's tools: the image's /bin/sh is dash, and the entrypoint-mint test's BusyBox run
// would test nothing here — BusyBox sh runs its own `id` applet and never sees the stand-in.
const SCRIPT = join(__dirname, '..', '..', 'entrypoint-webui.sh');
const UID = '54321';
const homes: string[] = [];

function sandbox(name: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'entrypoint-uid-'));
  homes.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'id'), [
    '#!/bin/sh',
    'echo "$*" >> "$HOME/id-calls"',
    `if [ "$1" = "-u" ]; then echo ${UID}; exit 0; fi`,
    name === null
      ? `if [ "$1" = "-un" ]; then echo "id: cannot find name for user ID ${UID}" >&2; exit 1; fi`
      : `if [ "$1" = "-un" ]; then echo ${name}; exit 0; fi`,
    'echo "unexpected id call: $*" >&2; exit 2',
  ].join('\n') + '\n', { mode: 0o755 });
  writeFileSync(join(bin, 'node'), [
    '#!/bin/sh',
    'if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi',
    'echo "ENGINE_STARTED"',
  ].join('\n') + '\n', { mode: 0o755 });
  mkdirSync(join(home, '.lynox'), { mode: 0o700 });
  // A file the stand-in uid does not own (it belongs to whoever runs the test), so the
  // ownership check below the changed line finds it and prints the name it took.
  writeFileSync(join(home, '.lynox', 'config.json'), '{}\n');
  return home;
}

function start(home: string) {
  const run = spawnSync('sh', [SCRIPT], {
    env: { HOME: home, PATH: `${join(home, 'bin')}:${process.env['PATH'] ?? ''}`, REAL_NODE: process.execPath, LYNOX_HTTP_SECRET: 'fixed' },
    encoding: 'utf8',
  });
  // The stand-in must have answered `id -un`; a `sh` with its own `id` would make this test vacuous.
  const calls = existsSync(join(home, 'id-calls')) ? readFileSync(join(home, 'id-calls'), 'utf8').split('\n') : [];
  return { status: run.status, out: run.stdout, err: run.stderr, askedName: calls.includes('-un') };
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('the entrypoint starts the engine when `id -un` cannot name the uid', () => {

  it('reaches the engine and says the uid has no name', () => {
    const r = start(sandbox(null));
    expect(r.askedName).toBe(true);
    expect(r.err).not.toMatch(/unexpected id call/);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^ENGINE_STARTED$/m);
    expect(r.err).toContain(`The container runs as '(no name)' (uid ${UID})`);
  });

  it('still names the user when the image knows the uid (control)', () => {
    const r = start(sandbox('probe'));
    expect(r.askedName).toBe(true);
    expect(r.err).not.toMatch(/unexpected id call/);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^ENGINE_STARTED$/m);
    expect(r.err).toContain(`The container runs as 'probe' (uid ${UID})`);
  });
});
