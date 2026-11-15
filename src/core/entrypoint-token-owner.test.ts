import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The container entrypoint when the access-token file, or the data folder it lives in, belongs
// to another uid: data an older setup wrote as uid 1001, now started as the host user's uid.
//
// A file this test's own uid cannot read or write stands in for one owned by another uid: mode
// 000 on the token file, mode 500 on the folder. Each case first checks that the stand-in really
// is unusable, so a run as root (which ignores modes) fails instead of passing on nothing. For the
// other-owner message, `id` on PATH answers with another uid than the files' owner; without it
// the owner is the running uid and the message must not blame the owner. The container run with
// two real uids is where the owner case itself is measured.
// Everything else is the real script, run by the host's `sh`; `node` on PATH stands in for the
// engine and passes `node -e` (the token generator) through to the real node.
const SCRIPT = join(__dirname, '..', '..', 'entrypoint-webui.sh');
const TOKEN = 'a'.repeat(64);
const OTHER_UID = '54321';
const homes: string[] = [];

function sandbox(otherUid = false): string {
  const home = mkdtempSync(join(tmpdir(), 'entrypoint-token-'));
  homes.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), [
    '#!/bin/sh',
    'if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi',
    'echo "ENGINE_STARTED"',
  ].join('\n') + '\n', { mode: 0o755 });
  if (otherUid) {
    writeFileSync(join(bin, 'id'), [
      '#!/bin/sh',
      `if [ "$1" = "-u" ] || [ "$1" = "-g" ]; then echo ${OTHER_UID}; exit 0; fi`,
      `if [ "$1" = "-un" ]; then echo "id: cannot find name for user ID ${OTHER_UID}" >&2; exit 1; fi`,
      'echo "unexpected id call: $*" >&2; exit 2',
    ].join('\n') + '\n', { mode: 0o755 });
  }
  mkdirSync(join(home, '.lynox'), { mode: 0o700 });
  return home;
}

function start(home: string) {
  const run = spawnSync('sh', [SCRIPT], {
    env: { HOME: home, PATH: `${join(home, 'bin')}:${process.env['PATH'] ?? ''}`, REAL_NODE: process.execPath },
    encoding: 'utf8',
  });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

const ownUid = String(process.getuid?.() ?? 'unknown');

afterEach(() => {
  for (const h of homes.splice(0)) {
    chmodSync(join(h, '.lynox'), 0o700);
    rmSync(h, { recursive: true, force: true });
  }
});

describe('the entrypoint with an access-token file it cannot use', () => {
  it('stops with the file, its owner, the running uid and the way out, and leaves the file as it was', () => {
    const home = sandbox(true);
    const file = join(home, '.lynox', '.access-token');
    writeFileSync(file, TOKEN, { mode: 0o000 });
    expect(() => readFileSync(file)).toThrow();

    const r = start(home);
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/ENGINE_STARTED/);
    expect(r.err).not.toMatch(/unexpected id call/);
    expect(r.err).toContain(`ERROR: cannot read the access token file ${file}.`);
    expect(r.err).toContain(`${file} belongs to uid ${ownUid}; this container runs as uid ${OTHER_UID}.`);
    expect(r.err).toContain('leave LYNOX_UID');
    expect(r.err).toContain('lynox does not start, and the file was not changed.');
    expect(r.err).not.toMatch(/^cat: /m);
    chmodSync(file, 0o600);
    expect(readFileSync(file, 'utf8')).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('stops the same way when the folder cannot be written, naming the folder and its owner', () => {
    const home = sandbox(true);
    const dir = join(home, '.lynox');
    chmodSync(dir, 0o500);
    expect(() => writeFileSync(join(dir, 'probe'), 'x')).toThrow();

    const r = start(home);
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/ENGINE_STARTED/);
    expect(r.err).toContain(`ERROR: cannot write the access token file ${join(dir, '.access-token')}.`);
    expect(r.err).toContain(`${dir} belongs to uid ${ownUid}; this container runs as uid ${OTHER_UID}.`);
    // The volume warning above it no longer only guesses at a missing mount.
    expect(r.err).toContain(`${dir} belongs to uid ${ownUid}; this container runs as uid ${OTHER_UID},`);
    expect(r.err).not.toMatch(/cannot create/);
  });

  it('does not blame the owner when the file is the running uid\'s own', () => {
    const home = sandbox();
    const file = join(home, '.lynox', '.access-token');
    writeFileSync(file, TOKEN, { mode: 0o000 });
    expect(() => readFileSync(file)).toThrow();

    const r = start(home);
    expect(r.status).toBe(1);
    expect(r.err).toContain(`ERROR: cannot read the access token file ${file}.`);
    expect(r.err).toContain(`${file} belongs to this container's uid, so the owner is not the cause.`);
    expect(r.err).not.toContain('LYNOX_UID');
    expect(r.err).not.toMatch(/belongs to uid/);
  });

  it('names the other causes when a folder sits at the token path', () => {
    const home = sandbox();
    const file = join(home, '.lynox', '.access-token');
    mkdirSync(file);

    const r = start(home);
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/ENGINE_STARTED/);
    expect(r.err).toContain(`ERROR: cannot write the access token file ${file}.`);
    expect(r.err).toContain('is a regular file, not a folder or a');
    expect(r.err).not.toContain('LYNOX_UID');
  });

  it('says a folder of the running uid is not writable, without blaming its owner', () => {
    const home = sandbox();
    const dir = join(home, '.lynox');
    chmodSync(dir, 0o500);
    expect(() => writeFileSync(join(dir, 'probe'), 'x')).toThrow();

    const r = start(home);
    expect(r.status).toBe(1);
    expect(r.err).toContain(`${dir} belongs to this container's uid but cannot be written`);
    expect(r.err).not.toMatch(/belongs to uid/);
  });

  it('still reads a token file it can use, and starts the engine with it', () => {
    const home = sandbox();
    const file = join(home, '.lynox', '.access-token');
    writeFileSync(file, TOKEN, { mode: 0o600 });

    const r = start(home);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^ENGINE_STARTED$/m);
    expect(r.err).toContain('Access token loaded from volume');
    expect(r.err).not.toMatch(/ERROR: cannot/);
    expect(r.err).not.toMatch(/WARNING: Volume mount/);
    expect(readFileSync(file, 'utf8')).toBe(TOKEN);
  });

  it('writes a new token when there is none and the folder is writable', () => {
    const home = sandbox();
    const r = start(home);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^ENGINE_STARTED$/m);
    expect(readFileSync(join(home, '.lynox', '.access-token'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(r.err).not.toMatch(/ERROR: cannot/);
  });
});
