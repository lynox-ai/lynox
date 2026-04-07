/**
 * Zero-knowledge migration cryptography.
 *
 * Provides X25519 ECDH key agreement + AES-256-GCM chunk encryption for
 * migrating data from self-hosted to managed hosting without the control
 * plane ever seeing plaintext.
 *
 * Protocol:
 *   1. Server generates ephemeral X25519 keypair, sends pubkey + HMAC signature
 *   2. Client generates ephemeral X25519 keypair, computes shared secret
 *   3. Both derive transferKey via HKDF-SHA256
 *   4. Client encrypts each chunk with AES-256-GCM + AAD (seq + manifest hash)
 *   5. Server decrypts, ephemeral keys destroyed after finalize
 *
 * Security properties:
 *   - Forward secrecy (ephemeral X25519 keys)
 *   - Chunk binding via AAD prevents reorder/swap
 *   - HMAC-signed handshake prevents pubkey substitution
 *   - One-time migration token prevents replay
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  CRYPTO_ALGORITHM,
  CRYPTO_KEY_LENGTH,
  CRYPTO_IV_LENGTH,
  CRYPTO_TAG_LENGTH,
} from './crypto-constants.js';

// ── Constants ──

const MIGRATION_HKDF_INFO = 'lynox-migration-v1';
const MIGRATION_HMAC_INFO = 'lynox-migration-hmac-v1';
const ECDH_CURVE = 'x25519';

/** Maximum chunk payload size (8 MB — leaves room for base64 overhead within 30 MB body limit). */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** Migration token TTL (30 minutes). */
export const MIGRATION_TOKEN_TTL_MS = 30 * 60 * 1000;

// ── Types ──

export interface EphemeralKeypair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export interface HandshakeServerPayload {
  serverPubKey: string;   // base64
  signature: string;      // hex — HMAC-SHA256(serverPubKey, signingKey)
  challengeNonce: string; // hex — 32 random bytes, used as HKDF salt
}

export interface HandshakeClientPayload {
  clientPubKey: string; // base64
}

export interface EncryptedChunk {
  seq: number;
  iv: string;      // hex
  authTag: string;  // hex
  data: string;     // base64(ciphertext)
}

export interface MigrationManifest {
  version: 1;
  exportedAt: string;               // ISO timestamp
  lynoxVersion: string;
  manifestHash: string;             // SHA-256 of canonical manifest (computed after all other fields set)
  totalChunks: number;
  chunks: MigrationChunkMeta[];
}

export interface MigrationChunkMeta {
  seq: number;
  type: 'secrets' | 'sqlite_db' | 'artifacts' | 'config';
  name: string;                     // e.g. 'history.db', 'vault_secrets'
  originalSize: number;             // bytes before encryption
  checksum: string;                 // SHA-256 of plaintext
}

// ── Key Generation ──

/** Generate an ephemeral X25519 keypair for ECDH key agreement. */
export function generateEphemeralKeypair(): EphemeralKeypair {
  const { publicKey, privateKey } = generateKeyPairSync(ECDH_CURVE);
  return { publicKey, privateKey };
}

/** Serialize a public key to base64 (raw format). */
export function serializePublicKey(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

/** Deserialize a base64 public key back to KeyObject. */
export function deserializePublicKey(b64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(b64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

// ── ECDH + Key Derivation ──

/**
 * Compute the X25519 shared secret and derive a transfer key via HKDF-SHA256.
 *
 * @param ownPrivateKey  - Our ephemeral private key
 * @param peerPublicKey  - Peer's ephemeral public key
 * @param challengeNonce - Random nonce from handshake (HKDF salt)
 * @returns 32-byte AES-256 key
 */
export function deriveTransferKey(
  ownPrivateKey: KeyObject,
  peerPublicKey: KeyObject,
  challengeNonce: Buffer,
): Buffer {
  const sharedSecret = diffieHellman({ publicKey: peerPublicKey, privateKey: ownPrivateKey });

  const transferKey = Buffer.from(
    hkdfSync('sha256', sharedSecret, challengeNonce, MIGRATION_HKDF_INFO, CRYPTO_KEY_LENGTH),
  );

  // Zeroize shared secret — only the derived transfer key should survive
  sharedSecret.fill(0);

  return transferKey;
}

// ── Handshake Signing ──

/**
 * Derive an HMAC signing key from the instance's HTTP secret.
 * Separate from the transfer key to ensure domain separation.
 */
export function deriveSigningKey(httpSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', httpSecret, 'migration-handshake', MIGRATION_HMAC_INFO, CRYPTO_KEY_LENGTH),
  );
}

/**
 * Sign a server public key with the instance's signing key.
 * Prevents MITM substitution of the ECDH public key.
 */
export function signHandshake(serverPubKeyB64: string, signingKey: Buffer): string {
  return createHmac('sha256', signingKey).update(serverPubKeyB64).digest('hex');
}

/**
 * Verify a handshake signature (timing-safe).
 * Returns true only if signature is valid.
 */
export function verifyHandshake(serverPubKeyB64: string, signature: string, signingKey: Buffer): boolean {
  const expected = createHmac('sha256', signingKey).update(serverPubKeyB64).digest();
  const actual = Buffer.from(signature, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ── Chunk Encryption ──

/**
 * Build the AAD (Additional Authenticated Data) for a chunk.
 * Binds each chunk to its sequence number and the manifest, preventing reorder/swap.
 *
 * Format: "lynox-migration-v1:<seq>:<manifestHash>"
 */
export function buildChunkAAD(seq: number, manifestHash: string): Buffer {
  return Buffer.from(`${MIGRATION_HKDF_INFO}:${String(seq)}:${manifestHash}`);
}

/**
 * Encrypt a single chunk.
 *
 * @param plaintext    - Raw data to encrypt
 * @param transferKey  - 32-byte AES-256 key from ECDH
 * @param seq          - Chunk sequence number
 * @param manifestHash - SHA-256 of the manifest (AAD binding)
 * @returns Encrypted chunk with IV, auth tag, and ciphertext
 */
export function encryptChunk(
  plaintext: Buffer,
  transferKey: Buffer,
  seq: number,
  manifestHash: string,
): EncryptedChunk {
  if (plaintext.length > MAX_CHUNK_BYTES) {
    throw new Error(`Chunk ${String(seq)} exceeds max size: ${String(plaintext.length)} > ${String(MAX_CHUNK_BYTES)}`);
  }

  const iv = randomBytes(CRYPTO_IV_LENGTH);
  const aad = buildChunkAAD(seq, manifestHash);

  const cipher = createCipheriv(CRYPTO_ALGORITHM, transferKey, iv, { authTagLength: CRYPTO_TAG_LENGTH });
  cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    seq,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted.toString('base64'),
  };
}

/**
 * Decrypt a single chunk.
 * Verifies AAD binding — rejects tampered, reordered, or swapped chunks.
 *
 * @param chunk        - Encrypted chunk
 * @param transferKey  - 32-byte AES-256 key from ECDH
 * @param manifestHash - Expected manifest hash (AAD binding)
 * @returns Decrypted plaintext
 * @throws On authentication failure (tampered data, wrong key, wrong seq)
 */
export function decryptChunk(
  chunk: EncryptedChunk,
  transferKey: Buffer,
  manifestHash: string,
): Buffer {
  const iv = Buffer.from(chunk.iv, 'hex');
  const authTag = Buffer.from(chunk.authTag, 'hex');
  const ciphertext = Buffer.from(chunk.data, 'base64');
  const aad = buildChunkAAD(chunk.seq, manifestHash);

  if (iv.length !== CRYPTO_IV_LENGTH) {
    throw new Error(`Invalid IV length: ${String(iv.length)}`);
  }
  if (authTag.length !== CRYPTO_TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: ${String(authTag.length)}`);
  }

  const decipher = createDecipheriv(CRYPTO_ALGORITHM, transferKey, iv, { authTagLength: CRYPTO_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  decipher.setAAD(aad);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── Manifest ──

/**
 * Compute the canonical hash of a manifest (excludes manifestHash field itself).
 * Used as AAD binding for all chunks.
 */
export function computeManifestHash(manifest: Omit<MigrationManifest, 'manifestHash'>): string {
  const canonical = JSON.stringify({
    version: manifest.version,
    exportedAt: manifest.exportedAt,
    lynoxVersion: manifest.lynoxVersion,
    totalChunks: manifest.totalChunks,
    chunks: manifest.chunks,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verify that a received manifest hash matches the computed hash.
 * Timing-safe comparison.
 */
export function verifyManifestHash(manifest: MigrationManifest): boolean {
  const { manifestHash, ...rest } = manifest;
  const computed = computeManifestHash(rest);
  const expected = Buffer.from(manifestHash, 'hex');
  const actual = Buffer.from(computed, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ── Migration Token ──

/**
 * Generate a cryptographically random migration token.
 * 32 bytes, hex-encoded (64 chars).
 */
export function generateMigrationToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Timing-safe comparison of migration tokens.
 */
export function verifyMigrationToken(provided: string, stored: string): boolean {
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(stored, 'hex');
  if (a.length !== b.length || a.length !== 32) return false;
  return timingSafeEqual(a, b);
}

// ── Helpers ──

/** SHA-256 hash of a buffer, returned as hex string. */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Zero-fill a buffer to remove key material from memory.
 * Best-effort — V8 may copy buffers during GC, but this handles the primary reference.
 */
export function zeroize(buf: Buffer): void {
  buf.fill(0);
}
