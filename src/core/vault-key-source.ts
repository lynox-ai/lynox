import type { KeyDelivery, UsageStatusRequestHeaders } from '../contract/http.js';

/**
 * Where this process's vault key came from, recorded once, when the key is first settled.
 *
 *  - `env`        — in the environment the process was started with.
 *  - `volume-env` — read from `~/.lynox/.env` (by the container entrypoint or by `loadVaultKeyFromDotEnv`).
 *  - `vault-key`  — read from the data dir's `vault.key`.
 *  - `minted`     — generated at this start (by the entrypoint or by `ensureVaultKey`).
 *  - `none`       — no key.
 */
export type VaultKeySource = 'env' | 'volume-env' | 'vault-key' | 'minted' | 'none';

/** The form of a vault key: 32 to 128 characters of base64. */
export const VAULT_KEY_PATTERN = /^[A-Za-z0-9+/=]{32,128}$/;

/** What the container entrypoint says it did, in `LYNOX_VAULT_KEY_SOURCE`. */
const ENTRYPOINT_SOURCES: Readonly<Record<string, VaultKeySource>> = {
  env: 'env',
  'volume-env': 'volume-env',
  minted: 'minted',
  none: 'none',
};

let recorded: VaultKeySource | null = null;

/**
 * Record where the key came from. Only the first call counts: once a key is loaded into the
 * environment, a later look would take it for one that came there.
 */
export function recordVaultKeySource(source: VaultKeySource): void {
  if (recorded === null) recorded = source;
}

/**
 * A key found in the environment: where it came from. The entrypoint sets `LYNOX_VAULT_KEY_SOURCE`
 * before the engine starts; without it (a start outside the container image) the key is the
 * environment's own.
 */
export function sourceOfEnvKey(): VaultKeySource {
  const said = ENTRYPOINT_SOURCES[process.env['LYNOX_VAULT_KEY_SOURCE'] ?? ''];
  // The entrypoint said `none` but a key is there now: something after it set one, not the start.
  return said === undefined || said === 'none' ? 'env' : said;
}

/** Where the key came from, or null before it was settled. */
export function vaultKeySource(): VaultKeySource | null {
  return recorded;
}

/** For tests: forget the recorded source. */
export function _resetVaultKeySource(): void {
  recorded = null;
}

/** The word the control plane is told, from the recorded source and the key now in the environment. */
export function keyDelivery(source: VaultKeySource | null, key: string | undefined): KeyDelivery {
  if (key === undefined || key === '') return 'none';
  if (source === 'env' || source === null) return VAULT_KEY_PATTERN.test(key) ? 'env' : 'malformed';
  return 'fallback';
}

/**
 * The status poll's headers. Built from the word and the key's length only: the key itself is
 * never read into them.
 */
export function keyDeliveryHeaders(
  source: VaultKeySource | null = recorded,
  key: string | undefined = process.env['LYNOX_VAULT_KEY'],
): StatusHeaders {
  const delivery = keyDelivery(source, key);
  if (delivery === 'none' || key === undefined) return { 'x-key-delivery': delivery };
  return { 'x-key-delivery': delivery, 'x-key-len64': key.length === 64 ? '1' : '0' };
}

/** The headers as sent: always the word, the length only with a key. Fits the contract's shape. */
type StatusHeaders = { 'x-key-delivery': KeyDelivery; 'x-key-len64'?: '0' | '1' } & UsageStatusRequestHeaders;
