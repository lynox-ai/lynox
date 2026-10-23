import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The container entrypoint, with a home of its own and without root. Each case runs twice: with
// the host's `sh` and tools (the image is node:22-slim: dash, GNU grep, coreutils), and with
// BusyBox `sh` and BusyBox applets for the tools the tested path calls, a second implementation
// of each (skipped where the host has no BusyBox). `node` on PATH is a stand-in that runs real node for the script's `node -e` and, for the final
// `exec node /app/dist/index.js`, prints the key the engine would get instead of starting it.
const SCRIPT = join(__dirname, '..', '..', 'entrypoint-webui.sh');
const homes: string[] = [];
const BUSYBOX = ['/usr/bin/busybox', '/bin/busybox'].find(p => existsSync(p));
const APPLETS = ['sh', 'grep', 'stat', 'head', 'cut', 'find', 'id', 'mkdir', 'rm', 'cat', 'sed'];
let tools: 'host' | 'busybox' = 'host';
const VAR = ['LYNOX', 'VAULT', 'KEY'].join('_');

function sandbox(): { home: string; lynox: string } {
  const home = mkdtempSync(join(tmpdir(), 'entrypoint-mint-'));
  homes.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  if (tools === 'busybox') for (const applet of APPLETS) symlinkSync(BUSYBOX!, join(bin, applet));
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

describe.each([['host'], ['busybox']] as const)('with %s tools, the entrypoint generates a vault key only where it cannot replace one', set => {
  beforeAll(() => { tools = set; });
  beforeEach(ctx => { if (set === 'busybox' && BUSYBOX === undefined) ctx.skip(); });

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

  it('generates no key and writes nothing when the data dir already holds a vault', () => {
    const { home, lynox } = sandbox();
    writeFileSync(join(lynox, 'vault.db'), 'encrypted under a key this start does not have');
    const r = start(home);
    expect(r.status).toBe(0);
    expect(r.engineKey).toBe('');
    expect(existsSync(join(lynox, '.env'))).toBe(false);
    expect(r.err).toMatch(/vault\.db already exists/);
    expect(r.err).toMatch(/set LYNOX_VAULT_KEY to the key this install was/);
  });

  it('does not warn when the vault has its vault.key beside it, which the engine reads', () => {
    const { home, lynox } = sandbox();
    writeFileSync(join(lynox, 'vault.db'), 'x');
    writeFileSync(join(lynox, 'vault.key'), 'k', { mode: 0o600 });
    const r = start(home);
    expect(r.status).toBe(0);
    expect(r.engineKey).toBe('');
    expect(existsSync(join(lynox, '.env'))).toBe(false);
    expect(r.err).not.toMatch(/found no vault key/);
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
    expect(r.err).toMatch(/lynox does not start/);
  });

  it('does not start when .env is a dangling link, and creates nothing at its target', () => {
    const { home, lynox } = sandbox();
    const target = join(home, 'missing.env');
    symlinkSync(target, join(lynox, '.env'));
    const r = start(home);
    expect(r.status).not.toBe(0);
    expect(r.engineKey).toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  it('does not start when .env is not a regular file', () => {
    const { home, lynox } = sandbox();
    mkdirSync(join(lynox, '.env'), { mode: 0o600 });
    const r = start(home);
    expect(r.status).not.toBe(0);
    expect(r.engineKey).toBeNull();
    expect(r.err).toMatch(/not a regular file/);
  });

  it.each([0o644, 0o664, 0o444, 0o440])('does not start, and keeps the file, when .env has mode %o', mode => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, 'LYNOX_VAULT_KEY=the-vaults-key\n');
    chmodSync(env, mode);
    const r = start(home);
    expect(r.status).not.toBe(0);
    expect(r.engineKey).toBeNull();
    expect(readFileSync(env, 'utf8')).toBe('LYNOX_VAULT_KEY=the-vaults-key\n');
    expect(r.err).toMatch(/mode is not 600 or 400/);
  });

  it('starts with the key a read-only .env holds', () => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, 'LYNOX_VAULT_KEY=the-vaults-key\n');
    chmodSync(env, 0o400);
    expect(start(home).engineKey).toBe('the-vaults-key');
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
    expect(r.err).toMatch(/read-only \(mode 400\), and this start read no key from it/);
  });

  it('appends the key to a .env it read, keeping the other lines', () => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, 'OTHER=1\n', { mode: 0o600 });
    const r = start(home);
    expect(r.status).toBe(0);
    expect(readFileSync(env, 'utf8')).toBe(`OTHER=1\n\nLYNOX_VAULT_KEY=${r.engineKey}\n`);
  });

  // A second key line would split the readers: the installer takes the first key line and an
  // empty one for "no key", and would then write a new key over the one appended here.
  it.each([
    // Built at run time: the secret scan reads a literal assignment as a key.
    ['an empty key line', `${VAR}=\n`],
    ['an indented key line', `  ${VAR}=the-vaults-key\n`],
    ['a key line after a byte-order mark', `\uFEFF${VAR}=\n`],
    ['a key line after a no-break space', `\u00A0${VAR}=the-vaults-key\n`],
    ['a space before the equals sign', `${VAR} =the-vaults-key\n`],
    ['an empty key line and a NUL byte elsewhere', `${VAR}=\nX=a\u0000b\n`],
    ['a no-break space before the equals sign', `${VAR}\u00A0=the-vaults-key\n`],
    ['another variable that starts with the name', `${VAR}_OLD=x\n`],
  ])('does not start, and keeps the file, when .env has %s', (_label, content) => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, content, { mode: 0o600 });
    const r = start(home);
    expect(r.status).not.toBe(0);
    expect(r.engineKey).toBeNull();
    expect(readFileSync(env, 'utf8')).toBe(content);
    expect(r.err).toMatch(/names LYNOX_VAULT_KEY in a line this start cannot read a key from/);
  });

  // The key the first start exports has to be the one the next start reads back.
  it.each([
    ['other settings', 'FOO=bar'],
    ['a comment', '# my settings'],
    ['a carriage return', 'FOO=bar\r'],
    ['a NUL byte', 'FOO=bar\u0000'],
  ])('reads the appended key back when the file ends in %s without a newline', (_label, content) => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, content, { mode: 0o600 });
    const first = start(home);
    expect(first.status).toBe(0);
    expect(first.engineKey).toMatch(/^[A-Za-z0-9+/]{64}$/);
    writeFileSync(join(lynox, 'vault.db'), 'x');
    expect(start(home).engineKey).toBe(first.engineKey);
  });

  it('appends to a .env whose only mention of the key is a comment', () => {
    const { home, lynox } = sandbox();
    const env = join(lynox, '.env');
    writeFileSync(env, '# LYNOX_VAULT_KEY=\n', { mode: 0o600 });
    const r = start(home);
    expect(r.status).toBe(0);
    expect(readFileSync(env, 'utf8')).toBe(`# LYNOX_VAULT_KEY=\n\nLYNOX_VAULT_KEY=${r.engineKey}\n`);
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
