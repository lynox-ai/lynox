/**
 * Backup encryption/decryption — AES-256-GCM per file.
 * Key derived from LYNOX_VAULT_KEY via HKDF (same pattern as run-history.ts).
 */

import { hkdfSync, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { CRYPTO_ALGORITHM, CRYPTO_KEY_LENGTH, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';

const BACKUP_HKDF_INFO = 'lynox-backup-encryption';
const BACKUP_HKDF_SALT = 'lynox-backup';
/** A second key from the same vault key: the manifest's MAC never shares a key with the files' cipher. */
const MANIFEST_HKDF_INFO = 'lynox-backup-manifest-auth';

/** File header: 'NBAK' + version byte (for future format changes). */
const FILE_MAGIC = Buffer.from('NBAK');
const FILE_VERSION = 1;
const HEADER_LENGTH = FILE_MAGIC.length + 1 + CRYPTO_IV_LENGTH + CRYPTO_TAG_LENGTH;

export interface EncryptedFileMetadata {
  iv: string;       // hex
  authTag: string;  // hex
}

/** Derive a backup-specific encryption key from the vault key. */
export function deriveBackupKey(vaultKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', vaultKey, BACKUP_HKDF_SALT, BACKUP_HKDF_INFO, CRYPTO_KEY_LENGTH));
}

/** Derive the key that authenticates a backup's manifest. */
export function deriveManifestKey(vaultKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', vaultKey, BACKUP_HKDF_SALT, MANIFEST_HKDF_INFO, CRYPTO_KEY_LENGTH));
}

/** JSON with object keys sorted at every level, so the MAC does not depend on key order or spacing. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** HMAC-SHA256 over the canonical manifest, its own `auth` field left out. Hex. */
export function manifestMac(manifest: Record<string, unknown>, key: Buffer): string {
  const { auth: _auth, ...signed } = manifest;
  return createHmac('sha256', key).update(canonicalJson(signed)).digest('hex');
}

/** Whether `mac` is the manifest's MAC under `key`, compared in constant time. */
export function manifestMacMatches(manifest: Record<string, unknown>, mac: string, key: Buffer): boolean {
  const expected = Buffer.from(manifestMac(manifest, key), 'hex');
  const given = Buffer.from(mac, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Encrypt a file in place (overwrite with encrypted content).
 * Format: NBAK + version(1) + IV(12) + authTag(16) + ciphertext
 */
export function encryptFile(srcPath: string, destPath: string, key: Buffer): EncryptedFileMetadata {
  const plaintext = readFileSync(srcPath);
  const iv = randomBytes(CRYPTO_IV_LENGTH);
  const cipher = createCipheriv(CRYPTO_ALGORITHM, key, iv, { authTagLength: CRYPTO_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Write: magic + version + iv + authTag + ciphertext
  const header = Buffer.alloc(FILE_MAGIC.length + 1);
  FILE_MAGIC.copy(header);
  header[FILE_MAGIC.length] = FILE_VERSION;

  writeFileSync(destPath, Buffer.concat([header, iv, authTag, encrypted]), { mode: 0o600 });

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt a file.
 * Validates header magic + version before decryption.
 */
export function decryptFile(srcPath: string, destPath: string, key: Buffer): void {
  writeFileSync(destPath, decryptFileToBuffer(srcPath, key), { mode: 0o600 });
}

/** Decrypt an NBAK file into memory, never onto disk. Same checks as `decryptFile`. */
export function decryptFileToBuffer(srcPath: string, key: Buffer): Buffer {
  return decryptBuffer(readFileSync(srcPath), key, srcPath);
}

/** Decrypt NBAK bytes already read. `label` names the source in errors. */
export function decryptBuffer(data: Buffer, key: Buffer, label: string): Buffer {
  const srcPath = label;
  if (data.length < HEADER_LENGTH) {
    throw new Error(`Encrypted file too short: ${srcPath}`);
  }

  // Validate magic
  if (!data.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new Error(`Invalid backup file (bad magic): ${srcPath}`);
  }

  const version = data[FILE_MAGIC.length]!;
  if (version !== FILE_VERSION) {
    throw new Error(`Unsupported backup file version ${String(version)}: ${srcPath}`);
  }

  const offset = FILE_MAGIC.length + 1;
  const iv = data.subarray(offset, offset + CRYPTO_IV_LENGTH);
  const authTag = data.subarray(offset + CRYPTO_IV_LENGTH, offset + CRYPTO_IV_LENGTH + CRYPTO_TAG_LENGTH);
  const ciphertext = data.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv(CRYPTO_ALGORITHM, key, iv, { authTagLength: CRYPTO_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Whether bytes already read start with the NBAK header. */
export function isEncryptedBackupBuffer(data: Buffer): boolean {
  return data.length >= FILE_MAGIC.length && data.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);
}

/** Check if a file has the NBAK encrypted header. */
export function isEncryptedBackupFile(filePath: string): boolean {
  try {
    const header = Buffer.alloc(FILE_MAGIC.length);
    const fd = readFileSync(filePath);
    if (fd.length < FILE_MAGIC.length) return false;
    fd.copy(header, 0, 0, FILE_MAGIC.length);
    return header.equals(FILE_MAGIC);
  } catch {
    return false;
  }
}
