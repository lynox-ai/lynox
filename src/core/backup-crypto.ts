/**
 * Backup encryption/decryption — AES-256-GCM per file.
 * Key derived from NODYN_VAULT_KEY via HKDF (same pattern as run-history.ts).
 */

import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { CRYPTO_ALGORITHM, CRYPTO_KEY_LENGTH, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';

const BACKUP_HKDF_INFO = 'nodyn-backup-encryption';
const BACKUP_HKDF_SALT = 'nodyn-backup';

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
  const data = readFileSync(srcPath);

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

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  writeFileSync(destPath, decrypted, { mode: 0o600 });
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
