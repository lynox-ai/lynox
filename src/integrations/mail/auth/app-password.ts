// === App-password credential storage ===
//
// Mail accounts are stored in the lynox SecretVault as a single AES-256-GCM
// encrypted blob per account: {user, pass}. Atomic save/delete avoids a
// half-written state where the username exists without the password.
//
// Naming convention: MAIL_ACCOUNT_<SANITIZED_ID>. The MAIL_ACCOUNT_ prefix
// keeps the namespace clear and works with the LYNOX_SECRET_* env-var
// override path (e.g. LYNOX_SECRET_MAIL_ACCOUNT_RAFAEL_GMAIL=... for CI).

import { MailError } from '../provider.js';
import type { CredentialsResolver, MailCredentials } from '../providers/imap-smtp.js';

/**
 * Minimal vault contract — narrow on purpose so tests can pass a Map-backed
 * fake instead of standing up the full SecretVault. SecretVault implements
 * this interface implicitly.
 */
export interface MailCredentialBackend {
  set(name: string, value: string): void;
  get(name: string): string | null;
  delete(name: string): boolean;
  has(name: string): boolean;
}

const KEY_PREFIX = 'MAIL_ACCOUNT_';

/**
 * Convert an account id into a stable, env-var-safe vault key.
 *
 * `rafael-gmail` → `MAIL_ACCOUNT_RAFAEL_GMAIL`
 */
export function vaultKeyForAccount(accountId: string): string {
  if (!accountId) {
    throw new MailError('unsupported', 'Account id must not be empty');
  }
  const sanitized = accountId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!sanitized) {
    throw new MailError('unsupported', `Account id "${accountId}" sanitizes to empty`);
  }
  return `${KEY_PREFIX}${sanitized}`;
}

interface StoredCredentials {
  user: string;
  pass: string;
  /** ISO timestamp — stored alongside so we can show "added 2 weeks ago" in UI. */
  storedAt: string;
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { user?: unknown }).user === 'string' &&
    typeof (value as { pass?: unknown }).pass === 'string'
  );
}

/**
 * Persists per-account mail credentials in the vault and produces a
 * CredentialsResolver for ImapSmtpProvider. The resolver re-reads the vault
 * on every connection attempt, so updating credentials in the vault takes
 * effect on the next reconnect without restarting the engine.
 */
export class MailCredentialStore {
  private readonly backend: MailCredentialBackend;

  constructor(backend: MailCredentialBackend) {
    this.backend = backend;
  }

  /** Atomically save user+password for an account. Overwrites any existing entry. */
  save(accountId: string, creds: MailCredentials): void {
    if (!creds.user) throw new MailError('auth_failed', 'Missing user');
    if (!creds.pass) throw new MailError('auth_failed', 'Missing password');
    const blob: StoredCredentials = {
      user: creds.user,
      pass: creds.pass,
      storedAt: new Date().toISOString(),
    };
    this.backend.set(vaultKeyForAccount(accountId), JSON.stringify(blob));
  }

  /** True if credentials exist for this account. */
  has(accountId: string): boolean {
    return this.backend.has(vaultKeyForAccount(accountId));
  }

  /** Resolve credentials. Throws MailError(auth_failed) when missing or malformed. */
  resolve(accountId: string): MailCredentials {
    const raw = this.backend.get(vaultKeyForAccount(accountId));
    if (!raw) {
      throw new MailError('auth_failed', `No stored credentials for account "${accountId}"`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new MailError('auth_failed', `Stored credentials for "${accountId}" are not valid JSON`, { cause: err });
    }
    if (!isStoredCredentials(parsed)) {
      throw new MailError('auth_failed', `Stored credentials for "${accountId}" are missing user or pass`);
    }
    return { user: parsed.user, pass: parsed.pass };
  }

  /** Returns true if an entry was removed. */
  delete(accountId: string): boolean {
    return this.backend.delete(vaultKeyForAccount(accountId));
  }

  /**
   * Build a CredentialsResolver bound to this account. Each provider call
   * re-reads the vault, so rotating the password is a single save() — no
   * provider restart needed.
   */
  buildResolver(accountId: string): CredentialsResolver {
    return () => this.resolve(accountId);
  }
}
