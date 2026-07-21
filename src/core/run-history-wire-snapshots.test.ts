import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { RunHistory } from './run-history.js';
import type { WireSnapshot } from './wire-capture.js';

/**
 * Extended debug capture (operator surface) — persistence tests for the
 * `wire_snapshots` table: insert/read round-trip, turn ordering, tool_names JSON,
 * encryption-at-rest of the (redacted-but-personal) user_message, deleteRun cascade,
 * the no-runId drop, and key-rotation re-encryption. See
 * pro docs/internal/prd/extended-debug-capture.md §9 step 2.
 */
describe('RunHistory wire_snapshots', () => {
  const tmpDirs: string[] = [];

  function mkSnapshot(overrides: Partial<WireSnapshot> = {}): WireSnapshot {
    return {
      runId: 'run-1',
      turnIndex: 1,
      model: 'ministral-14b-2512',
      provider: 'openai',
      systemPromptHash: 'abc123',
      userMessage: '[Now:2026-07-22] do the thing <retrieved_context>kg</retrieved_context>',
      userMessageChars: 71,
      toolNames: ['recall', 'spawn_agent', 'web_research'],
      toolCount: 3,
      toolChoice: undefined,
      temperature: 0.7,
      maxTokens: 8192,
      ephemeralTailPresent: true,
      ephemeralTailChars: 3050,
      capturedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wire-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('round-trips a snapshot: fields, tool_names JSON, booleans, turn ordering', () => {
    const dir = freshDir();
    const h = new RunHistory(join(dir, 'wire.db'));
    h.insertWireSnapshot(mkSnapshot({ turnIndex: 3 }));
    h.insertWireSnapshot(mkSnapshot({ turnIndex: 1, toolNames: ['recall'], toolCount: 1 }));
    h.insertWireSnapshot(mkSnapshot({ turnIndex: 5, ephemeralTailPresent: false, ephemeralTailChars: 0, temperature: undefined, toolChoice: 'auto' }));

    const rows = h.getWireSnapshotsForRun('run-1');
    expect(rows.map(r => r.turn_index)).toEqual([1, 3, 5]);   // turn-ordered ASC

    const t1 = rows[0]!;
    expect(t1.tool_names).toEqual(['recall']);
    expect(t1.tool_count).toBe(1);
    expect(t1.model).toBe('ministral-14b-2512');
    expect(t1.provider).toBe('openai');
    expect(t1.ephemeral_tail_present).toBe(true);
    expect(t1.temperature).toBe(0.7);

    const t5 = rows[2]!;
    expect(t5.ephemeral_tail_present).toBe(false);   // boolean 0 → false
    expect(t5.temperature).toBeNull();               // undefined → NULL
    expect(t5.tool_choice).toBe('auto');
    h.close();
  });

  it('encrypts user_message at rest (raw row is enc:, decrypts back)', () => {
    const dir = freshDir();
    const h = new RunHistory(join(dir, 'enc.db'), 'a-test-vault-key');
    const secretShaped = 'typed task <retrieved_context>owner KG</retrieved_context>';
    h.insertWireSnapshot(mkSnapshot({ userMessage: secretShaped }));

    // Decrypted read returns the plaintext.
    expect(h.getWireSnapshotsForRun('run-1')[0]!.user_message).toBe(secretShaped);

    // Raw row is encrypted at rest.
    const raw = new BetterSqlite3(join(dir, 'enc.db'))
      .prepare('SELECT user_message FROM wire_snapshots WHERE run_id = ? AND turn_index = ?')
      .get('run-1', 1) as { user_message: string };
    expect(raw.user_message.startsWith('enc:')).toBe(true);
    expect(raw.user_message).not.toContain('retrieved_context');
    h.close();
  });

  it('drops a snapshot without a runId (cannot be keyed or exported)', () => {
    const dir = freshDir();
    const h = new RunHistory(join(dir, 'wire.db'));
    h.insertWireSnapshot(mkSnapshot({ runId: undefined }));
    // No run_id → nothing persisted anywhere.
    const count = new BetterSqlite3(join(dir, 'wire.db'))
      .prepare('SELECT COUNT(*) AS n FROM wire_snapshots').get() as { n: number };
    expect(count.n).toBe(0);
    h.close();
  });

  it('INSERT OR REPLACE: a re-fire on the same (run_id, turn_index) overwrites', () => {
    const dir = freshDir();
    const h = new RunHistory(join(dir, 'wire.db'));
    h.insertWireSnapshot(mkSnapshot({ turnIndex: 2, toolCount: 3 }));
    h.insertWireSnapshot(mkSnapshot({ turnIndex: 2, toolCount: 9, toolNames: ['a', 'b'] }));
    const rows = h.getWireSnapshotsForRun('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_count).toBe(9);
    h.close();
  });

  it('deleteRun prunes the run wire_snapshots (retention rides run deletion)', () => {
    const dir = freshDir();
    const h = new RunHistory(join(dir, 'wire.db'));
    const runId = h.insertRun({ sessionId: 's', taskText: 'turn', modelTier: 'balanced', modelId: 'm' });
    h.insertWireSnapshot(mkSnapshot({ runId, turnIndex: 1 }));
    h.insertWireSnapshot(mkSnapshot({ runId, turnIndex: 2 }));
    h.insertWireSnapshot(mkSnapshot({ runId: 'other-run', turnIndex: 1 }));
    expect(h.getWireSnapshotsForRun(runId)).toHaveLength(2);

    h.deleteRun(runId);
    expect(h.getWireSnapshotsForRun(runId)).toEqual([]);        // pruned
    expect(h.getWireSnapshotsForRun('other-run')).toHaveLength(1); // isolated
    h.close();
  });

  it('isolates snapshots by run and returns empty for an unknown run', () => {
    const dir = freshDir();
    const h = new RunHistory(join(dir, 'wire.db'));
    h.insertWireSnapshot(mkSnapshot({ runId: 'run-a', turnIndex: 1 }));
    h.insertWireSnapshot(mkSnapshot({ runId: 'run-b', turnIndex: 1 }));
    expect(h.getWireSnapshotsForRun('run-a')).toHaveLength(1);
    expect(h.getWireSnapshotsForRun('run-b')).toHaveLength(1);
    expect(h.getWireSnapshotsForRun('nope')).toEqual([]);
    h.close();
  });

  it('degrades a malformed tool_names JSON row to an empty list (keeps the rest)', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'wire.db');
    const h = new RunHistory(dbPath);
    h.insertWireSnapshot(mkSnapshot({ turnIndex: 1 }));
    // Corrupt the tool_names JSON column directly (a real row can't produce this —
    // insertWireSnapshot always JSON.stringifies — but a DB-level corruption should
    // not fail the whole export).
    new BetterSqlite3(dbPath)
      .prepare('UPDATE wire_snapshots SET tool_names = ? WHERE run_id = ? AND turn_index = ?')
      .run('{not valid json', 'run-1', 1);

    const rows = h.getWireSnapshotsForRun('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_names).toEqual([]);          // degraded, not thrown
    expect(rows[0]!.model).toBe('ministral-14b-2512'); // rest of the snapshot intact
    h.close();
  });

  it('reEncryptAll rotates user_message to the new key', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'rot.db');
    const h = new RunHistory(dbPath, 'old-vault-key');
    h.insertWireSnapshot(mkSnapshot({ userMessage: 'sensitive assembled request' }));
    h.reEncryptAll('new-vault-key');
    h.close();

    // Re-open with the NEW key → decrypts.
    const h2 = new RunHistory(dbPath, 'new-vault-key');
    expect(h2.getWireSnapshotsForRun('run-1')[0]!.user_message).toBe('sensitive assembled request');
    h2.close();
  });
});
