/**
 * An unknown chunk type must be REFUSED, loudly, before a byte is transferred.
 *
 * THE DEFECT THIS CLOSES, measured on 2026-09-24 across two real trees, each running its own
 * code, with the fixture built by neither: v2.14.2's importer consuming an export from
 * `origin/main` received all five chunks, verified every hash, restored the two types it knew,
 * and **discarded `sweeps` and two `portable_dir` chunks without a word**. It threw nothing,
 * and its progress stream ended at `{phase:'done',currentChunk:5,totalChunks:5}` — the
 * manifest's count, not what was restored. The mechanism was a hand-written bucket table plus
 * `if (group)`: a type present in the compile-time union but absent from that table fell
 * through in silence.
 *
 * WHY THE FIX IS STRUCTURAL AND NOT A SECOND CHECK. The union existed only at compile time, so
 * the importer needed a runtime table, and the two could drift. `MIGRATION_CHUNK_TYPES` is now
 * the single declaration — the type is derived from it, and the bucket table is built from it —
 * so a declared type cannot lack a bucket. The `if (group)` guard is gone, and its absence is
 * load-bearing: a guard there would re-create the silent drop it was meant to prevent.
 *
 * WHAT CANNOT BE FIXED, and it is why this file argues rather than just asserts: nothing here
 * reaches an ALREADY SHIPPED importer. v2.13.0 and v2.14.2 read neither `meta.type` against a
 * list nor `manifest.version` at all — measured — so an export from this version restored onto
 * one of those still loses what they cannot place. That remains a release note.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { MigrationImporter } from './migration-import.js';
import {
  MIGRATION_CHUNK_TYPES, computeManifestHash, generateEphemeralKeypair, serializePublicKey,
} from './migration-crypto.js';
import type { MigrationChunkMeta, MigrationManifest } from './migration-crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'b'.repeat(64);

/** A manifest carrying `types`, with a hash the importer will accept. */
function manifestWith(types: string[]): MigrationManifest {
  const chunks = types.map((t, i) => ({
    seq: i, type: t as MigrationChunkMeta['type'], name: t,
    originalSize: 10, checksum: 'c'.repeat(64),
  }));
  const base = {
    version: 1 as const, exportedAt: new Date().toISOString(), lynoxVersion: 'test',
    totalChunks: chunks.length, chunks,
  };
  return { ...base, manifestHash: computeManifestHash(base) };
}

/** An importer past its handshake, pointed at a throwaway directory. */
function armed(dir: string): MigrationImporter {
  const importer = new MigrationImporter({ lynoxDir: dir, vaultKey: 'a-test-vault-key-32-bytes-or-so!' });
  importer.startHandshake(TOKEN);
  importer.completeHandshake(serializePublicKey(generateEphemeralKeypair().publicKey));
  return importer;
}

describe('a manifest naming a type this build does not know is refused', () => {
  it('refuses it, and the message NAMES the type — otherwise "too old" cannot be told from "corrupt"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-unknown-'));
    try {
      const importer = armed(dir);
      let msg = '';
      try { importer.setManifest(manifestWith(['memory', 'time_machine'])); } catch (e) { msg = String(e); }
      expect(msg).toContain('time_machine');
      // The message must name BOTH causes, because the check cannot tell them apart: a corrupt
      // or hostile manifest produces the same unknown type as an export from a newer build. An
      // earlier draft asserted the newer-build cause as fact, which is a guess in the voice of
      // a diagnosis.
      expect(msg).toMatch(/newer lynox/);
      expect(msg, 'the message must not present one of two causes as the cause').toMatch(/corrupt/);
      // The orchestrator's condition, and it is the whole point: the refusal must be
      // DISTINGUISHABLE from a completed import, not merely a different exit path. A run that
      // aborts while looking finished is the defect this file exists for, with the sign flipped.
      expect(importer.isComplete()).toBe(false);
      expect(() => importer.restore()).toThrow();
      expect(readdirSync(dir), 'a refused manifest must not have written anything').toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('bounds and quotes the echoed type AT THE SOURCE, not one function away', () => {
    // `errorResponse` masks and caps at 600 chars, but that is the HTTP caller's doing. A
    // throw site that depends on its caller is safe only while every caller keeps doing it,
    // and this message is thrown from a library method that any embedder can call.
    const dir = mkdtempSync(join(tmpdir(), 'mig-long-'));
    try {
      const importer = armed(dir);
      // The control characters come FIRST, deliberately. With them at the end, `.slice(0, 64)`
      // removed them on its own and the two assertions below passed without `JSON.stringify`
      // doing anything — a mutation that deleted the quoting survived. The fixture has to put
      // the hostile part where the code under test is the only thing that can neutralise it.
      const hostile = `\n\u001b[2Jforged-log-line${'A'.repeat(5000)}`;
      let msg = '';
      try { importer.setManifest(manifestWith([hostile])); } catch (e) { msg = e instanceof Error ? e.message : ''; }
      expect(msg.length, 'the echoed type is not bounded at the throw site').toBeLessThan(400);
      expect(msg, 'a raw newline survived into the message').not.toContain('\n');
      expect(msg, 'a raw escape survived into the message').not.toContain('\u001b');
      // …and the control: a bounded prefix of the hostile input IS still shown, or the
      // operator learns nothing.
      expect(msg).toContain('AAAA');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts a manifest of KNOWN types — the control, or the test above proves nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-known-'));
    try {
      const importer = armed(dir);
      expect(() => importer.setManifest(manifestWith(['memory', 'config', 'sweeps']))).not.toThrow();
      // Accepted, and STILL not complete — no chunk has arrived. `isComplete()` therefore does
      // not distinguish the two cases on its own, which is why the test above also asserts the
      // message and the empty directory.
      expect(importer.isComplete()).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses every unknown type it is given, one at a time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-each-'));
    try {
      for (const bad of ['', 'Memory', 'memory ', 'sqlite', 'portable-dir', '__proto__']) {
        const importer = armed(dir);
        expect(() => importer.setManifest(manifestWith([bad])), `"${bad}" was accepted`).toThrow(/Unknown chunk type/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the declared list is the single source of the bucket table', () => {
  it('pins the set, so growing it is a DECISION and not a diff', () => {
    // Read from the exported list rather than parsed out of source: the list IS the runtime
    // value now. When it changes, the addition is fine — what is not fine is shipping a new
    // type under the same `manifest.version: 1`, because an importer older than the release
    // drops it without a word (measured on v2.13.0 and v2.14.2). That addition owes a release
    // note, and a decision about whether it is the release that starts checking the version.
    expect([...MIGRATION_CHUNK_TYPES].sort()).toEqual([
      'artifacts', 'config', 'memory', 'portable_dir', 'secrets', 'sqlite_db', 'sweeps',
    ]);
  });

  it('builds the buckets FROM that list and keeps no hand-written table', () => {
    // The structural half. A literal table would drift from the list again, and the drift is
    // exactly what was silent — so the shape is asserted, not only the behaviour.
    const src = readFileSync(join(HERE, 'migration-import.ts'), 'utf-8');
    expect(src).toContain('MIGRATION_CHUNK_TYPES.map(');
    expect(src, 'a re-introduced literal bucket table').not.toMatch(/\n\s+sqlite_db: \[\],/);
    expect(src, 'the silent-drop guard must stay gone').not.toMatch(/if \(group\) group\.push/);
    // …and the control that the file was read at all.
    expect(src).toContain('groupChunksByType');
  });

  it('still reads no manifest version, which is why the remedy for old instances is a text', () => {
    const src = readFileSync(join(HERE, 'migration-import.ts'), 'utf-8');
    expect(src.includes('manifest.version'), 'a version check would change the remedy').toBe(false);
  });
});
