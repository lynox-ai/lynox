import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The container entrypoint, run as the image runs it: `sh` with a home of its own. `node` on
// PATH is a stand-in that runs real node for the script's `node -e` and, for the final
// `exec node /app/dist/index.js`, prints the key the engine would get instead of starting it.
const SCRIPT = join(__dirname, '..', '..', 'entrypoint-webui.sh');
const homes: string[] = [];

function sandbox(): { home: string; lynox: string } {
  const home = mkdtempSync(join(tmpdir(), 'entrypoint-mint-'));
  homes.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), [
    '#!/bin/sh',
    'if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi',
    'echo "ENGINE_KEY=${LYNOX_VAULT_KEY:-}"',
  ].join('\n') + '\n', { mode: 0o755 });
  const lynox = join(home, '.lynox');
  mkdirSync(lynox, { mode: 0o700 });
  return { home, lynox };
}

function start(home: string, env: Record<string, string> = {}): { status: number | null; out: string; err: string; engineKey: string | null } {
  const run = spawnSync('sh', [SCRIPT], {
    env: { HOME: home, PATH: `${join(home, 'bin')}:${process.env['PATH'] ?? ''}`, REAL_NODE: process.execPath, LYNOX_HTTP_SECRET: 'fixed', ...env },
    encoding: 'utf8',
  });
  const m = /^ENGINE_KEY=(.*)$/m.exec(run.stdout);
  return { status: run.status, out: run.stdout, err: run.stderr, engineKey: m ? m[1]! : null };
}

const keyLines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith('LYNOX_VAULT_KEY='));

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('the entrypoint generates a vault key only where it cannot replace one', () => {
  it('generates and saves a key on a first start (control)', () => {
    const { home, lynox } = sandbox();
    const r = start(home);
    expect(r.status).toBe(0);
    expect(r.engineKey).toMatch(/^[A-Za-z0-9+/]{64}$/);
    expect(keyLines(join(lynox, '.env'))).toEqual([`LYNOX_VAULT_KEY=${r.engineKey}`]);
    expect(statSync(join(lynox, '.env')).mode & 0o777).toBe(0o600);
    // The next start reads the saved key back instead of generating another.
    expect(start(home).engineKey).toBe(r.engineKey);
  });

  it('generates no key when the data dir already holds a vault, and leaves the engine to its vault.key', () => {
    const { home, lynox } = sandbox();
    writeFileSync(join(lynox, 'vault.db'), 'encrypted under a key this start does not have');
    const r = start(home);
    expect(r.status).toBe(0);
    expect(r.engineKey).toBe('');
    expect(existsSync(join(lynox, '.env'))).toBe(false);
    expect(r.err).toMatch(/vault\.db already exists/);
  });

  it('finds the vault in a moved data dir, by LYNOX_DATA_DIR and by the legacy LYNOX_DIR', () => {
    for (const name of ['LYNOX_DATA_DIR', 'LYNOX_DIR']) {
      const { home, lynox } = sandbox();
      const data = join(home, 'data');
      mkdirSync(data);
      writeFileSync(join(data, 'vault.db'), 'x');
      const r = start(home, { [name]: data });
      expect(r.engineKey, name).toBe('');
      expect(existsSync(join(lynox, '.env')), name).toBe(false);
    }
  });

  it('counts an empty LYNOX_DATA_DIR as unset, as the engine does', () => {
    const { home, lynox } = sandbox();
    writeFileSync(join(lynox, 'vault.db'), 'x');
    const r = start(home, { LYNOX_DATA_DIR: '', LYNOX_DIR: '' });
    expect(r.engineKey).toBe('');
    expect(existsSync(join(lynox, '.env'))).toBe(false);
  });

  it('does not start, and writes nothing, when .env is a link', () => {
    const { home, lynox } = sandbox();
    const target = join(home, 'elsewhere.env');
    writeFileSync(target, 'LYNOX_VAULT_KEY=the-vaults-key\n', { mode: 0o600 });
    symlinkSync(target, join(lynox, '.env'));
    const r = start(home);
    expect(r.status).not.toBe(0);
    expect(r.engineKey).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('LYNOX_VAULT_KEY=the-vaults-key\n');
    expect(r.err).toMatch(/symbolic link/);
  });

  it('does not start, and keeps the file, when .env has a mode other than 600 or 400', () => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, 'LYNOX_VAULT_KEY=the-vaults-key\n');
    chmodSync(env, 0o644);
    const r = start(home);
    expect(r.status).not.toBe(0);
    expect(r.engineKey).toBeNull();
    expect(readFileSync(env, 'utf8')).toBe('LYNOX_VAULT_KEY=the-vaults-key\n');
    expect(r.err).toMatch(/mode is not 600/);
  });

  it('does not start when a read-only .env holds no key', () => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, 'OTHER=1\n');
    chmodSync(env, 0o400);
    const r = start(home);
    expect(r.status).not.toBe(0);
    expect(r.engineKey).toBeNull();
    expect(readFileSync(env, 'utf8')).toBe('OTHER=1\n');
    expect(r.err).toMatch(/read-only \(mode 400\)/);
  });

  it('appends the key to a .env it read, keeping the other lines', () => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, 'OTHER=1\n', { mode: 0o600 });
    const r = start(home);
    expect(r.status).toBe(0);
    expect(readFileSync(env, 'utf8')).toBe(`OTHER=1\nLYNOX_VAULT_KEY=${r.engineKey}\n`);
  });

  it('reads the appended key on the next start when the file had an empty key line', () => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, 'LYNOX_VAULT_KEY=\n', { mode: 0o600 });
    const first = start(home);
    expect(first.engineKey).toMatch(/^[A-Za-z0-9+/]{64}$/);
    expect(keyLines(env)).toEqual(['LYNOX_VAULT_KEY=', `LYNOX_VAULT_KEY=${first.engineKey}`]);
    // The engine created the vault under that key; the next start has to hand it back.
    writeFileSync(join(lynox, 'vault.db'), 'x');
    expect(start(home).engineKey).toBe(first.engineKey);
  });

  it('touches nothing when the key is set from outside', () => {
    const { home, lynox } = sandbox();
    writeFileSync(join(lynox, 'vault.db'), 'x');
    const r = start(home, { LYNOX_VAULT_KEY: 'from-compose' });
    expect(r.status).toBe(0);
    expect(r.engineKey).toBe('from-compose');
    expect(existsSync(join(lynox, '.env'))).toBe(false);
    expect(r.err).not.toMatch(/WARNING: no vault key/);
  });
});
