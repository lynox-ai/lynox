#!/usr/bin/env npx tsx
/**
 * Full E2E Migration Test against real containers.
 *
 * Source: Rafael's pilot container (data copied to /tmp/migration-test/)
 * Target: migration-target container at 192.168.1.73:3200
 */

import {
  generateEphemeralKeypair,
  serializePublicKey,
  deserializePublicKey,
  deriveTransferKey,
  deriveSigningKey,
  verifyHandshake,
} from '../src/core/migration-crypto.js';
import { MigrationExporter } from '../src/core/migration-export.js';
import type { MigrationManifest, EncryptedChunk } from '../src/core/migration-crypto.js';

// ── Config ──

const TARGET_URL = 'http://192.168.1.73:3200';
const TARGET_SECRET = '90aff9d2baf94eb166cc2cb0c827d9aa';
const MIGRATION_TOKEN = '313fb25e97373144048ca9a222a6c30f16ec405b2a233755335e5bb7dc318bef';
const SOURCE_DATA_DIR = '/tmp/migration-test';
const SOURCE_VAULT_KEY = '9kYvPWmD8YRkX0HXDC0jjhiQlpXop+TfDThLOd5zo5RZG65pTmljMPxbZljPmA4y';

// ── HTTP Helpers ──

async function apiGet(path: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${TARGET_URL}${path}`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${TARGET_SECRET}`,
      ...extraHeaders,
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${String(res.status)}: ${body}`);
  return JSON.parse(body) as unknown;
}

async function apiPost(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${TARGET_URL}${path}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TARGET_SECRET}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${String(res.status)}: ${text}`);
  return JSON.parse(text) as unknown;
}

// ── Main ──

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Migration E2E Test — Real Data               ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Step 1: Preview source data
  console.log('→ [1/6] Preview source data...');
  const exporter = new MigrationExporter({ lynoxDir: SOURCE_DATA_DIR, vaultKey: SOURCE_VAULT_KEY });
  const preview = exporter.preview();
  console.log(`  Secrets: ${String(preview.secrets)}, DBs: ${preview.databases.join(', ')}, Artifacts: ${String(preview.artifacts)}, Config: ${String(preview.hasConfig)}`);

  // Step 2: Start ECDH handshake
  console.log('→ [2/6] ECDH handshake (GET)...');
  const handshake = await apiGet('/api/migration/handshake', {
    'X-Migration-Token': MIGRATION_TOKEN,
  }) as { serverPubKey: string; signature: string; challengeNonce: string };
  console.log(`  Server pubkey: ${handshake.serverPubKey.slice(0, 30)}...`);
  console.log(`  Challenge: ${handshake.challengeNonce.slice(0, 20)}...`);

  // Step 3: Client key agreement
  console.log('→ [3/6] Key agreement (POST)...');
  const clientKp = generateEphemeralKeypair();
  const serverPub = deserializePublicKey(handshake.serverPubKey);
  const nonce = Buffer.from(handshake.challengeNonce, 'hex');
  const transferKey = deriveTransferKey(clientKp.privateKey, serverPub, nonce);

  // Verify handshake signature (we know the HTTP secret for testing)
  const signingKey = deriveSigningKey(TARGET_SECRET);
  const signatureValid = verifyHandshake(handshake.serverPubKey, handshake.signature, signingKey);
  console.log(`  Signature valid: ${String(signatureValid)}`);

  await apiPost('/api/migration/handshake', {
    clientPubKey: serializePublicKey(clientKp.publicKey),
  });
  console.log('  ✅ Transfer key derived');

  // Step 4: Export + encrypt
  console.log('→ [4/6] Exporting + encrypting...');
  const { manifest, chunks } = exporter.export(transferKey, (p) => {
    if (p.phase === 'encrypting') {
      process.stdout.write(`  Encrypting: ${p.currentName}                    \r`);
    }
  });
  console.log(`  ✅ ${String(manifest.totalChunks)} chunks encrypted (manifest: ${manifest.manifestHash.slice(0, 16)}...)`);

  // Step 5: Send manifest + chunks
  console.log('→ [5/6] Sending to target...');
  await apiPost('/api/migration/manifest', manifest);
  console.log('  Manifest accepted');

  for (const chunk of chunks) {
    const result = await apiPost('/api/migration/chunk', chunk) as {
      seq: number; name: string; verified: boolean; complete: boolean;
    };
    console.log(`  Chunk ${String(result.seq)} "${result.name}": ${result.verified ? '✅' : '❌'}${result.complete ? ' (all received)' : ''}`);
  }

  // Step 6: Restore
  console.log('→ [6/6] Restoring on target...');
  const restoreResult = await apiPost('/api/migration/restore', {}) as {
    success: boolean;
    verification: {
      secretsImported: number;
      databasesRestored: string[];
      artifactsImported: number;
      configApplied: boolean;
    };
  };

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log(`║  ${restoreResult.success ? '✅ MIGRATION SUCCESS' : '❌ MIGRATION FAILED'}                       ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Secrets imported:   ${String(restoreResult.verification.secretsImported)}`);
  console.log(`  Databases restored: ${restoreResult.verification.databasesRestored.join(', ')}`);
  console.log(`  Artifacts imported: ${String(restoreResult.verification.artifactsImported)}`);
  console.log(`  Config applied:     ${String(restoreResult.verification.configApplied)}`);
  console.log('');
  console.log('  ⚠️  Target instance will restart to load imported data.');
  console.log('');
}

main().catch((err: unknown) => {
  console.error('\n❌ Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
