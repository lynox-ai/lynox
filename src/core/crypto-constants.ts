/** Shared AES-256-GCM constants used by secret-vault and run-history encryption. */

export const CRYPTO_ALGORITHM = 'aes-256-gcm' as const;
export const CRYPTO_KEY_LENGTH = 32; // 256 bits
export const CRYPTO_IV_LENGTH = 12; // 96 bits for GCM
export const CRYPTO_TAG_LENGTH = 16; // 128-bit auth tag
