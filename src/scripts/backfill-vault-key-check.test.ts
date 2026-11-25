import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretVault, VaultKeyMismatchError } from '../core/secret-vault.js';
import { setDataDir } from '../core/config.js';
import { _resetVaultKeySource } from '../core/vault-key-source.js';
import { main as s2Main } from './s2-backfill.js';
import { main as s3Main } from './s3-backfill.js';
import { main as s5Main } from './s5-backfill.js';
import { main as sweepMain } from './subject-sweep.js';

/**
 * The operator scripts settle the vault key the way the engine does, and then open engine.db and
 * the other stores, which encrypt their rows under that key. The engine's start refuses a key the
 * vault on disk was not written with; the scripts must too, before any store opens. Otherwise a run
 * under a wrong or rotated key writes rows the vault's own key cannot read.
 */
const KEY_A = 'vault-key-a-000000000000000000000000';
const KEY_B = 'vault-key-b-111111111111111111111111';

/** `stopsLater`: on an empty data dir the script stops after the key check for its own reason
 *  (s2 reads a contacts collection that is not there); every other script runs through. */
const SCRIPTS: readonly { name: string; main: () => void; stopsLater: boolean }[] = [
  { name: 's2-backfill', main: s2Main, stopsLater: true },
  { name: 's3-backfill', main: s3Main, stopsLater: false },
  { name: 's5-backfill', main: s5Main, stopsLater: false },
  { name: 'subject-sweep', main: sweepMain, stopsLater: false },
];

describe.each(SCRIPTS)('$name — a vault key the vault refuses stops the run before a store opens', ({ name, main, stopsLater }) => {
  let dir: string;
  let argv: string[];

  /** Every file in the data dir besides the vault's own. */
  const storeFiles = (): string[] => readdirSync(dir).filter(f => !f.startsWith('vault.db'));

  function run(key: string): void {
    vi.stubEnv('LYNOX_VAULT_KEY', key);
    process.argv = ['node', name, '--apply', `--data-dir=${dir}`];
    main();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `lynox-${name}-vault-key-`));
    argv = process.argv;
    vi.stubEnv('LYNOX_BILLING_TIER', '');
    vi.stubEnv('LYNOX_MANAGED_MODE', '');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const v = new SecretVault({ path: join(dir, 'vault.db'), masterKey: KEY_A });
    v.set('PROBE_A', 'alpha');
    v.close();
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    setDataDir(null);
    _resetVaultKeySource();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('under a foreign key it throws the start\'s refusal and opens no store', () => {
    expect(() => run(KEY_B)).toThrow(VaultKeyMismatchError);
    expect(existsSync(join(dir, 'engine.db')), 'engine.db was opened under the foreign key').toBe(false);
    expect(storeFiles(), 'a store was opened under the foreign key').toEqual([]);
  });

  it('a vault.db that cannot be opened at all stops the run too, and opens no store', () => {
    rmSync(join(dir, 'vault.db'), { force: true });
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
    writeFileSync(join(dir, 'vault.db'), 'not a database, a broken copy of one');
    let thrown: unknown;
    try { run(KEY_B); } catch (err) { thrown = err; }
    expect(thrown, 'the run went on past a vault it could not open').toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(VaultKeyMismatchError);
    expect(existsSync(join(dir, 'engine.db')), 'engine.db was opened under an unchecked key').toBe(false);
    expect(storeFiles(), 'a store was opened under an unchecked key').toEqual([]);
  });

  it('CONTROL: under the vault\'s own key it goes past the check and opens engine.db', () => {
    let thrown: unknown;
    try { run(KEY_A); } catch (err) { thrown = err; }
    if (stopsLater) expect(thrown, 'the vault\'s own key was refused').not.toBeInstanceOf(VaultKeyMismatchError);
    else expect(thrown, 'the run under the vault\'s own key threw').toBeUndefined();
    expect(existsSync(join(dir, 'engine.db'))).toBe(true);
  });
});
