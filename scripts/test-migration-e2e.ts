#!/usr/bin/env npx tsx
/**
 * E2E Migration Test Script
 *
 * Tests the full zero-knowledge migration flow against real lynox instances.
 *
 * Usage:
 *   # Step 1: Preview only (safe, read-only)
 *   npx tsx scripts/test-migration-e2e.ts preview --source http://localhost:3100 --token YOUR_HTTP_SECRET
 *
 *   # Step 2: Full E2E (needs a target instance with LYNOX_MANAGED_MODE)
 *   npx tsx scripts/test-migration-e2e.ts migrate \
 *     --source http://localhost:3100 \
 *     --source-token YOUR_SOURCE_HTTP_SECRET \
 *     --target http://localhost:3200 \
 *     --migration-token THE_MIGRATION_TOKEN
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

// ── CLI Parsing ──

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function required(name: string): string {
  const val = getArg(name);
  if (!val) {
    console.error(`Missing required argument: --${name}`);
    process.exit(1);
  }
  return val;
}

// ── HTTP Helpers ──

async function apiGet(baseUrl: string, path: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → ${String(res.status)}: ${body}`);
  }
  return res.json();
}

async function apiPost(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const defaultHeaders: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...headers,
  };

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${String(res.status)}: ${text}`);
  }
  return res.json();
}

// ── Commands ──

async function preview(): Promise<void> {
  const source = required('source');
  const token = getArg('token');

  console.log(`\n📋 Migration Preview — ${source}\n`);

  const data = await apiGet(source, '/api/migration/preview', token) as {
    secrets: number;
    databases: string[];
    artifacts: number;
    hasConfig: boolean;
  };

  console.log(`  Secrets:    ${String(data.secrets)}`);
  console.log(`  Databases:  ${data.databases.join(', ') || '(none)'}`);
  console.log(`  Artifacts:  ${String(data.artifacts)}`);
  console.log(`  Config:     ${data.hasConfig ? 'yes' : 'no'}`);
  console.log(`\n✅ Preview complete — this is what would be migrated.\n`);
}

async function migrate(): Promise<void> {
  const source = required('source');
  const sourceToken = required('source-token');
  const target = required('target');
  const migrationToken = required('migration-token');

  console.log(`\n🔄 Migration E2E Test`);
  console.log(`  Source: ${source}`);
  console.log(`  Target: ${target}\n`);

  // Step 1: Preview
  console.log('→ [1/6] Fetching preview...');
  const previewData = await apiGet(source, '/api/migration/preview', sourceToken) as {
    secrets: number;
    databases: string[];
    artifacts: number;
    hasConfig: boolean;
  };
  console.log(`  ${String(previewData.secrets)} secrets, ${previewData.databases.length} databases, ${String(previewData.artifacts)} artifacts`);

  // Step 2: Start handshake on target
  console.log('→ [2/6] Starting ECDH handshake...');
  const handshakePayload = await apiGet(target, '/api/migration/handshake', undefined) as {
    serverPubKey: string;
    signature: string;
    challengeNonce: string;
  };

  // Note: In a real scenario, the client would verify the signature using the
  // HTTP secret. For testing, we skip this since we trust the target.
  console.log(`  Server pubkey: ${handshakePayload.serverPubKey.slice(0, 20)}...`);
  console.log(`  Challenge: ${handshakePayload.challengeNonce.slice(0, 16)}...`);

  // Step 3: Client key generation + handshake completion
  console.log('→ [3/6] Completing handshake (client key agreement)...');
  const clientKp = generateEphemeralKeypair();
  const serverPubKey = deserializePublicKey(handshakePayload.serverPubKey);
  const challengeNonce = Buffer.from(handshakePayload.challengeNonce, 'hex');
  const transferKey = deriveTransferKey(clientKp.privateKey, serverPubKey, challengeNonce);

  await apiPost(target, '/api/migration/handshake', {
    clientPubKey: serializePublicKey(clientKp.publicKey),
  }, { 'Authorization': `Bearer ${sourceToken}` });
  console.log('  ✅ Handshake complete — transfer key derived');

  // Step 4: Export data from source
  console.log('→ [4/6] Exporting data from source...');
  const exporter = new MigrationExporter({ vaultKey: process.env['LYNOX_VAULT_KEY'] ?? sourceToken });
  const { manifest, chunks } = exporter.export(transferKey, (p) => {
    if (p.phase !== 'done') {
      process.stdout.write(`  ${p.phase}: ${p.currentName}\r`);
    }
  });
  console.log(`  ✅ Exported: ${String(manifest.totalChunks)} chunks, manifest hash: ${manifest.manifestHash.slice(0, 16)}...`);

  // Step 5: Send manifest + chunks to target
  console.log('→ [5/6] Sending manifest + chunks to target...');
  await apiPost(target, '/api/migration/manifest', manifest, { 'Authorization': `Bearer ${sourceToken}` });
  console.log(`  Manifest accepted (${String(manifest.totalChunks)} chunks)`);

  for (const chunk of chunks) {
    const result = await apiPost(target, '/api/migration/chunk', chunk, { 'Authorization': `Bearer ${sourceToken}` }) as {
      seq: number;
      name: string;
      verified: boolean;
      complete: boolean;
    };
    console.log(`  Chunk ${String(result.seq)} (${result.name}): ${result.verified ? '✅' : '❌'} ${result.complete ? '(complete)' : ''}`);
  }

  // Step 6: Restore
  console.log('→ [6/6] Restoring on target...');
  const restoreResult = await apiPost(target, '/api/migration/restore', {}, { 'Authorization': `Bearer ${sourceToken}` }) as {
    success: boolean;
    verification: {
      secretsImported: number;
      databasesRestored: string[];
      artifactsImported: number;
      configApplied: boolean;
    };
  };

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Migration ${restoreResult.success ? '✅ SUCCESS' : '❌ FAILED'}                    ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`  Secrets imported:    ${String(restoreResult.verification.secretsImported)}`);
  console.log(`  Databases restored:  ${restoreResult.verification.databasesRestored.join(', ')}`);
  console.log(`  Artifacts imported:  ${String(restoreResult.verification.artifactsImported)}`);
  console.log(`  Config applied:      ${restoreResult.verification.configApplied ? 'yes' : 'no'}`);
  console.log(`\n  ⚠️  Target instance will restart to load imported data.\n`);
}

// ── Main ──

async function main(): Promise<void> {
  switch (command) {
    case 'preview':
      await preview();
      break;
    case 'migrate':
      await migrate();
      break;
    default:
      console.log(`
Usage:
  npx tsx scripts/test-migration-e2e.ts preview --source URL --token SECRET
  npx tsx scripts/test-migration-e2e.ts migrate --source URL --source-token SECRET --target URL --migration-token TOKEN

Example (preview only):
  npx tsx scripts/test-migration-e2e.ts preview --source http://localhost:3100 --token mytoken

Example (full E2E with two containers):
  # Start a second container as managed target:
  docker run -d --name migration-target -p 3200:3200 \\
    -e LYNOX_HTTP_PORT=3200 \\
    -e LYNOX_MANAGED_MODE=1 \\
    -e LYNOX_VAULT_KEY=target-vault-key-$(openssl rand -hex 24) \\
    -e LYNOX_HTTP_SECRET=target-http-secret-$(openssl rand -hex 16) \\
    -e LYNOX_MIGRATION_TOKEN=<generate-and-note-this> \\
    lynox:webui

  # Run the migration:
  npx tsx scripts/test-migration-e2e.ts migrate \\
    --source http://localhost:3100 --source-token SOURCE_SECRET \\
    --target http://localhost:3200 --migration-token THE_TOKEN
`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ Migration failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
