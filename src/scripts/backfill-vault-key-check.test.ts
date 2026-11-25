import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretVault, VaultKeyMismatchError } from '../core/secret-vault.js';
import { setDataDir } from '../core/config.js';
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

const SCRIPTS: readonly { name: string; main: () => void }[] = [
  { name: 's2-backfill', main: s2Main },
  { name: 's3-backfill', main: s3Main },
  { name: 's5-backfill', main: s5Main },
  { name: 'subject-sweep', main: sweepMain },
];

describe.each(SCRIPTS)('$name — a vault key the vault refuses stops the run before a store opens', ({ name, main }) => {
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('under a foreign key it throws the start\'s refusal and opens no store', () => {
    expect(() => run(KEY_B)).toThrow(VaultKeyMismatchError);
    expect(existsSync(join(dir, 'engine.db')), 'engine.db was opened under the foreign key').toBe(false);
    expect(storeFiles(), 'a store was opened under the foreign key').toEqual([]);
  });

  it('CONTROL: under the vault\'s own key it goes past the check and opens engine.db', () => {
    // An empty data dir may stop a script later for its own reasons (s2 reads a contacts
    // collection that is not there); what counts here is that the key check let it through.
    let thrown: unknown;
    try { run(KEY_A); } catch (err) { thrown = err; }
    expect(thrown, 'the vault\'s own key was refused').not.toBeInstanceOf(VaultKeyMismatchError);
    expect(existsSync(join(dir, 'engine.db'))).toBe(true);
  });
});
