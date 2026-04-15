import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  generateEphemeralKeypair,
  serializePublicKey,
  deserializePublicKey,
  deriveTransferKey,
  deriveSigningKey,
  signHandshake,
  verifyHandshake,
  encryptChunk,
  decryptChunk,
  buildChunkAAD,
  computeManifestHash,
  verifyManifestHash,
  generateMigrationToken,
  verifyMigrationToken,
  sha256,
  zeroize,
  MAX_CHUNK_BYTES,
  type MigrationManifest,
} from './migration-crypto.js';

// ── Key Generation & Serialization ──

describe('ECDH key generation', () => {
  it('generates valid X25519 keypair', () => {
    const kp = generateEphemeralKeypair();
    expect(kp.publicKey).toBeDefined();
    expect(kp.privateKey).toBeDefined();
    expect(kp.publicKey.type).toBe('public');
    expect(kp.privateKey.type).toBe('private');
  });

  it('generates unique keypairs', () => {
    const kp1 = generateEphemeralKeypair();
    const kp2 = generateEphemeralKeypair();
    const pub1 = serializePublicKey(kp1.publicKey);
    const pub2 = serializePublicKey(kp2.publicKey);
    expect(pub1).not.toBe(pub2);
  });

  it('serializes and deserializes public key', () => {
    const kp = generateEphemeralKeypair();
    const serialized = serializePublicKey(kp.publicKey);
    expect(typeof serialized).toBe('string');
    expect(serialized.length).toBeGreaterThan(0);

    const deserialized = deserializePublicKey(serialized);
    expect(deserialized.type).toBe('public');

    // Re-serialized should match
    const reSerialized = serializePublicKey(deserialized);
    expect(reSerialized).toBe(serialized);
  });

  it('rejects invalid base64 public key', () => {
    expect(() => deserializePublicKey('not-valid-base64!!!')).toThrow();
  });
});

// ── ECDH Key Agreement ──

describe('ECDH key agreement', () => {
  it('derives same transfer key on both sides', () => {
    const server = generateEphemeralKeypair();
    const client = generateEphemeralKeypair();
    const nonce = randomBytes(32);

    const serverKey = deriveTransferKey(server.privateKey, client.publicKey, nonce);
    const clientKey = deriveTransferKey(client.privateKey, server.publicKey, nonce);

    expect(serverKey).toEqual(clientKey);
    expect(serverKey.length).toBe(32); // 256 bits
  });

  it('different nonces produce different keys', () => {
    const server = generateEphemeralKeypair();
    const client = generateEphemeralKeypair();

    const key1 = deriveTransferKey(server.privateKey, client.publicKey, randomBytes(32));
    const key2 = deriveTransferKey(server.privateKey, client.publicKey, randomBytes(32));

    expect(key1).not.toEqual(key2);
  });

  it('different keypairs produce different shared secrets', () => {
    const server = generateEphemeralKeypair();
    const client1 = generateEphemeralKeypair();
    const client2 = generateEphemeralKeypair();
    const nonce = randomBytes(32);

    const key1 = deriveTransferKey(server.privateKey, client1.publicKey, nonce);
    const key2 = deriveTransferKey(server.privateKey, client2.publicKey, nonce);

    expect(key1).not.toEqual(key2);
  });
});

// ── Handshake Signing ──

describe('handshake signing', () => {
  const httpSecret = 'test-http-secret-12345678';

  it('signing key derivation is deterministic', () => {
    const key1 = deriveSigningKey(httpSecret);
    const key2 = deriveSigningKey(httpSecret);
    expect(key1).toEqual(key2);
  });

  it('different secrets produce different signing keys', () => {
    const key1 = deriveSigningKey('secret-a');
    const key2 = deriveSigningKey('secret-b');
    expect(key1).not.toEqual(key2);
  });

  it('signs and verifies handshake', () => {
    const kp = generateEphemeralKeypair();
    const pubKeyB64 = serializePublicKey(kp.publicKey);
    const signingKey = deriveSigningKey(httpSecret);

    const signature = signHandshake(pubKeyB64, signingKey);
    expect(verifyHandshake(pubKeyB64, signature, signingKey)).toBe(true);
  });

  it('rejects tampered public key', () => {
    const kp = generateEphemeralKeypair();
    const pubKeyB64 = serializePublicKey(kp.publicKey);
    const signingKey = deriveSigningKey(httpSecret);

    const signature = signHandshake(pubKeyB64, signingKey);

    // Tamper with the public key
    const tampered = pubKeyB64.slice(0, -2) + 'XX';
    expect(verifyHandshake(tampered, signature, signingKey)).toBe(false);
  });

  it('rejects tampered signature', () => {
    const kp = generateEphemeralKeypair();
    const pubKeyB64 = serializePublicKey(kp.publicKey);
    const signingKey = deriveSigningKey(httpSecret);

    const signature = signHandshake(pubKeyB64, signingKey);
    // XOR-flip the last byte so the tampered signature is GUARANTEED different
    // from the original. A fixed "append ff" strategy is flaky at 1/256 when
    // the real signature already ends in ff — then tampered === original.
    const lastByte = parseInt(signature.slice(-2), 16);
    const flippedByte = (lastByte ^ 0xff).toString(16).padStart(2, '0');
    const tampered = signature.slice(0, -2) + flippedByte;
    expect(tampered).not.toBe(signature);
    expect(verifyHandshake(pubKeyB64, tampered, signingKey)).toBe(false);
  });

  it('rejects wrong signing key', () => {
    const kp = generateEphemeralKeypair();
    const pubKeyB64 = serializePublicKey(kp.publicKey);
    const signingKey = deriveSigningKey(httpSecret);
    const wrongKey = deriveSigningKey('wrong-secret');

    const signature = signHandshake(pubKeyB64, signingKey);
    expect(verifyHandshake(pubKeyB64, signature, wrongKey)).toBe(false);
  });

  it('rejects signature with wrong length', () => {
    const kp = generateEphemeralKeypair();
    const pubKeyB64 = serializePublicKey(kp.publicKey);
    const signingKey = deriveSigningKey(httpSecret);

    expect(verifyHandshake(pubKeyB64, 'short', signingKey)).toBe(false);
  });
});

// ── Chunk Encryption/Decryption ──

describe('chunk encryption', () => {
  const transferKey = randomBytes(32);
  const manifestHash = sha256(Buffer.from('test-manifest'));

  it('encrypts and decrypts a chunk', () => {
    const plaintext = Buffer.from('Hello, migration!');
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);

    expect(encrypted.seq).toBe(0);
    expect(encrypted.iv.length).toBe(24); // 12 bytes hex
    expect(encrypted.authTag.length).toBe(32); // 16 bytes hex

    const decrypted = decryptChunk(encrypted, transferKey, manifestHash);
    expect(decrypted).toEqual(plaintext);
  });

  it('encrypts empty chunk', () => {
    const plaintext = Buffer.alloc(0);
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);
    const decrypted = decryptChunk(encrypted, transferKey, manifestHash);
    expect(decrypted).toEqual(plaintext);
  });

  it('encrypts large chunk (1 MB)', () => {
    const plaintext = randomBytes(1024 * 1024);
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);
    const decrypted = decryptChunk(encrypted, transferKey, manifestHash);
    expect(decrypted).toEqual(plaintext);
  });

  it('rejects chunk exceeding MAX_CHUNK_BYTES', () => {
    const plaintext = randomBytes(MAX_CHUNK_BYTES + 1);
    expect(() => encryptChunk(plaintext, transferKey, 0, manifestHash)).toThrow('exceeds max size');
  });

  it('each encryption produces unique IV (ciphertext differs)', () => {
    const plaintext = Buffer.from('same data');
    const enc1 = encryptChunk(plaintext, transferKey, 0, manifestHash);
    const enc2 = encryptChunk(plaintext, transferKey, 0, manifestHash);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.data).not.toBe(enc2.data);
  });

  it('rejects wrong transfer key', () => {
    const plaintext = Buffer.from('secret data');
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);
    const wrongKey = randomBytes(32);

    expect(() => decryptChunk(encrypted, wrongKey, manifestHash)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const plaintext = Buffer.from('important data');
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);

    // Tamper with one byte
    const dataBytes = Buffer.from(encrypted.data, 'base64');
    if (dataBytes.length > 0) dataBytes[0] = (dataBytes[0]! + 1) % 256;
    const tampered = { ...encrypted, data: dataBytes.toString('base64') };

    expect(() => decryptChunk(tampered, transferKey, manifestHash)).toThrow();
  });

  it('rejects tampered auth tag', () => {
    const plaintext = Buffer.from('important data');
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);

    const tampered = { ...encrypted, authTag: 'ff'.repeat(16) };
    expect(() => decryptChunk(tampered, transferKey, manifestHash)).toThrow();
  });

  it('rejects tampered IV', () => {
    const plaintext = Buffer.from('important data');
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);

    const tampered = { ...encrypted, iv: 'ff'.repeat(12) };
    expect(() => decryptChunk(tampered, transferKey, manifestHash)).toThrow();
  });

  it('rejects invalid IV length', () => {
    const plaintext = Buffer.from('data');
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);

    const tampered = { ...encrypted, iv: 'abcdef' };
    expect(() => decryptChunk(tampered, transferKey, manifestHash)).toThrow('Invalid IV length');
  });

  it('rejects invalid auth tag length', () => {
    const plaintext = Buffer.from('data');
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);

    const tampered = { ...encrypted, authTag: 'abcdef' };
    expect(() => decryptChunk(tampered, transferKey, manifestHash)).toThrow('Invalid auth tag length');
  });
});

// ── AAD Binding (prevents chunk reorder/swap) ──

describe('AAD binding', () => {
  const transferKey = randomBytes(32);
  const manifestHash = sha256(Buffer.from('test-manifest'));

  it('AAD includes seq and manifest hash', () => {
    const aad = buildChunkAAD(5, manifestHash);
    const aadStr = aad.toString();
    expect(aadStr).toContain('5');
    expect(aadStr).toContain(manifestHash);
    expect(aadStr).toContain('lynox-migration-v1');
  });

  it('rejects chunk with wrong seq (reorder attack)', () => {
    const data1 = Buffer.from('chunk 0 data');
    const data2 = Buffer.from('chunk 1 data');
    const enc0 = encryptChunk(data1, transferKey, 0, manifestHash);
    const enc1 = encryptChunk(data2, transferKey, 1, manifestHash);

    // Try to decrypt chunk 0's ciphertext with chunk 1's seq → AAD mismatch
    const swapped = { ...enc0, seq: 1 };
    expect(() => decryptChunk(swapped, transferKey, manifestHash)).toThrow();
  });

  it('rejects chunk with wrong manifest hash (swap attack)', () => {
    const plaintext = Buffer.from('legitimate data');
    const encrypted = encryptChunk(plaintext, transferKey, 0, manifestHash);

    const wrongManifest = sha256(Buffer.from('different-manifest'));
    expect(() => decryptChunk(encrypted, transferKey, wrongManifest)).toThrow();
  });
});

// ── Manifest ──

describe('manifest verification', () => {
  function createTestManifest(): MigrationManifest {
    const base = {
      version: 1 as const,
      exportedAt: '2026-04-07T12:00:00.000Z',
      lynoxVersion: '0.24.0',
      totalChunks: 2,
      chunks: [
        { seq: 0, type: 'secrets' as const, name: 'vault_secrets', originalSize: 100, checksum: 'abc123' },
        { seq: 1, type: 'sqlite_db' as const, name: 'history.db', originalSize: 5000, checksum: 'def456' },
      ],
    };
    const manifestHash = computeManifestHash(base);
    return { ...base, manifestHash };
  }

  it('computes deterministic manifest hash', () => {
    const hash1 = computeManifestHash({
      version: 1, exportedAt: 'x', lynoxVersion: 'y', totalChunks: 1,
      chunks: [{ seq: 0, type: 'secrets', name: 'a', originalSize: 1, checksum: 'z' }],
    });
    const hash2 = computeManifestHash({
      version: 1, exportedAt: 'x', lynoxVersion: 'y', totalChunks: 1,
      chunks: [{ seq: 0, type: 'secrets', name: 'a', originalSize: 1, checksum: 'z' }],
    });
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex
  });

  it('different manifests produce different hashes', () => {
    const hash1 = computeManifestHash({
      version: 1, exportedAt: '2026-01-01', lynoxVersion: '1.0', totalChunks: 1,
      chunks: [{ seq: 0, type: 'secrets', name: 'a', originalSize: 1, checksum: 'z' }],
    });
    const hash2 = computeManifestHash({
      version: 1, exportedAt: '2026-01-02', lynoxVersion: '1.0', totalChunks: 1,
      chunks: [{ seq: 0, type: 'secrets', name: 'a', originalSize: 1, checksum: 'z' }],
    });
    expect(hash1).not.toBe(hash2);
  });

  it('verifies valid manifest', () => {
    const manifest = createTestManifest();
    expect(verifyManifestHash(manifest)).toBe(true);
  });

  it('rejects tampered manifest — changed chunk count', () => {
    const manifest = createTestManifest();
    manifest.totalChunks = 3;
    expect(verifyManifestHash(manifest)).toBe(false);
  });

  it('rejects tampered manifest — changed chunk checksum', () => {
    const manifest = createTestManifest();
    manifest.chunks[0]!.checksum = 'tampered';
    expect(verifyManifestHash(manifest)).toBe(false);
  });

  it('rejects tampered manifest — changed hash', () => {
    const manifest = createTestManifest();
    manifest.manifestHash = 'ff'.repeat(32);
    expect(verifyManifestHash(manifest)).toBe(false);
  });
});

// ── Migration Token ──

describe('migration token', () => {
  it('generates 64-char hex token', () => {
    const token = generateMigrationToken();
    expect(token.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(token)).toBe(true);
  });

  it('generates unique tokens', () => {
    const t1 = generateMigrationToken();
    const t2 = generateMigrationToken();
    expect(t1).not.toBe(t2);
  });

  it('verifies matching tokens', () => {
    const token = generateMigrationToken();
    expect(verifyMigrationToken(token, token)).toBe(true);
  });

  it('rejects different tokens', () => {
    const t1 = generateMigrationToken();
    const t2 = generateMigrationToken();
    expect(verifyMigrationToken(t1, t2)).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(verifyMigrationToken('abcdef', generateMigrationToken())).toBe(false);
    expect(verifyMigrationToken(generateMigrationToken(), 'short')).toBe(false);
  });

  it('rejects empty tokens', () => {
    expect(verifyMigrationToken('', '')).toBe(false);
  });
});

// ── Utilities ──

describe('utilities', () => {
  it('sha256 produces 64-char hex', () => {
    const hash = sha256(Buffer.from('test'));
    expect(hash.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
  });

  it('sha256 is deterministic', () => {
    const data = Buffer.from('hello');
    expect(sha256(data)).toBe(sha256(data));
  });

  it('zeroize fills buffer with zeros', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    zeroize(buf);
    expect(buf).toEqual(Buffer.alloc(5));
  });
});

// ── Full Protocol Simulation ──

describe('full migration protocol', () => {
  it('simulates complete handshake + encrypt + decrypt flow', () => {
    const httpSecret = 'instance-http-secret-abc123';

    // Server: generate keypair + sign
    const serverKp = generateEphemeralKeypair();
    const challengeNonce = randomBytes(32);
    const serverPubB64 = serializePublicKey(serverKp.publicKey);
    const signingKey = deriveSigningKey(httpSecret);
    const signature = signHandshake(serverPubB64, signingKey);

    // Client: verify signature, generate own keypair
    expect(verifyHandshake(serverPubB64, signature, signingKey)).toBe(true);
    const clientKp = generateEphemeralKeypair();

    // Both: derive transfer key
    const serverTransferKey = deriveTransferKey(serverKp.privateKey, clientKp.publicKey, challengeNonce);
    const clientTransferKey = deriveTransferKey(clientKp.privateKey, serverKp.publicKey, challengeNonce);
    expect(serverTransferKey).toEqual(clientTransferKey);

    // Client: build manifest + encrypt chunks
    const secretsData = Buffer.from(JSON.stringify([{ name: 'API_KEY', value: 'sk-test-123' }]));
    const dbData = randomBytes(1024);

    const manifestBase = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      lynoxVersion: '0.24.0',
      totalChunks: 2,
      chunks: [
        { seq: 0, type: 'secrets' as const, name: 'vault_secrets', originalSize: secretsData.length, checksum: sha256(secretsData) },
        { seq: 1, type: 'sqlite_db' as const, name: 'history.db', originalSize: dbData.length, checksum: sha256(dbData) },
      ],
    };
    const manifestHash = computeManifestHash(manifestBase);
    const manifest: MigrationManifest = { ...manifestBase, manifestHash };

    // Client: encrypt
    const enc0 = encryptChunk(secretsData, clientTransferKey, 0, manifestHash);
    const enc1 = encryptChunk(dbData, clientTransferKey, 1, manifestHash);

    // Server: verify manifest
    expect(verifyManifestHash(manifest)).toBe(true);

    // Server: decrypt
    const dec0 = decryptChunk(enc0, serverTransferKey, manifestHash);
    const dec1 = decryptChunk(enc1, serverTransferKey, manifestHash);

    expect(dec0).toEqual(secretsData);
    expect(dec1).toEqual(dbData);

    // Verify checksums
    expect(sha256(dec0)).toBe(manifest.chunks[0]!.checksum);
    expect(sha256(dec1)).toBe(manifest.chunks[1]!.checksum);

    // Cleanup
    zeroize(serverTransferKey);
    zeroize(clientTransferKey);
  });
});
