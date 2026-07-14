import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { ThreadStore } from './thread-store.js';

/**
 * Write-restriction invariant for `ThreadStore.updateThread` (arc:model-selector
 * Wave P1, DEF-0095 / §5.1b, S4 / RI2).
 *
 * P1 widened the `updateThread` whitelist with `model_tier` + `model_tier_source`
 * so the ONE sanctioned writer — the mid-thread re-pick endpoint via
 * `Session.repickModel` — can persist a `'user'` pick. `model_tier_source` is
 * ADVISORY-ONLY (it must never gate a tier/cost decision), but a durable
 * `'user'` label is still a small trust signal, so the shape must not become a
 * source-forgery vector: an AGENT-reachable tool that forwarded a caller-shaped
 * `updates` map into `updateThread` would let a prompt-injected agent stamp
 * `model_tier_source='user'` (or silently change a thread's tier) on any turn.
 *
 * The structural guarantee, enforced here: every `updateThread(...)` call in the
 * agent-tool surface (`src/tools/`) passes an OBJECT LITERAL with statically
 * known keys — never an identifier, never a spread, never the provenance keys.
 * A future tool that did `updateThread(id, callerShapedUpdates)` fails this test.
 */
const TOOLS_DIR = join(import.meta.dirname, '../tools');

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...getAllTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) results.push(full);
  }
  return results;
}

/** Extract the full argument text of each `updateThread(` call by walking
 *  balanced parentheses (regex can't match nested parens/objects reliably). */
function updateThreadCallArgs(source: string): string[] {
  const calls: string[] = [];
  const marker = 'updateThread(';
  let idx = source.indexOf(marker);
  while (idx !== -1) {
    const start = idx + marker.length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    calls.push(source.slice(start, i - 1));
    idx = source.indexOf(marker, i);
  }
  return calls;
}

describe('ThreadStore.updateThread write-restriction (P1 provenance, S4/RI2)', () => {
  it('no agent-reachable (src/tools) updateThread call forwards a caller-shaped updates map', () => {
    const files = getAllTsFiles(TOOLS_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      if (!src.includes('updateThread(')) continue;
      for (const arg of updateThreadCallArgs(src)) {
        // arg is "<id>, <updates>" — the updates portion is after the first comma.
        const comma = arg.indexOf(',');
        const updates = (comma === -1 ? arg : arg.slice(comma + 1)).trim();
        const rel = file.slice(file.indexOf('/src/') + 1);
        // Must be an object literal with statically known keys...
        if (!updates.startsWith('{')) {
          violations.push(`${rel}: updateThread receives a non-literal argument \`${updates.slice(0, 60)}\` — a caller-shaped map can carry model_tier/model_tier_source`);
          continue;
        }
        // ...never a spread (a spread could smuggle the provenance keys in)...
        if (updates.includes('...')) {
          violations.push(`${rel}: updateThread argument spreads a variable — could carry model_tier/model_tier_source`);
        }
        // ...and never the provenance keys directly (only repickModel writes them).
        if (/\bmodel_tier(_source)?\b/.test(updates)) {
          violations.push(`${rel}: an agent-reachable tool writes model_tier/model_tier_source directly — only Session.repickModel may`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('updateThread persists the provenance keys when the sanctioned writer sets them', () => {
    // Positive control: the widened whitelist actually works for the re-pick path.
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        model_tier TEXT NOT NULL DEFAULT 'balanced',
        model_tier_source TEXT NOT NULL DEFAULT 'unknown',
        context_id TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        summary TEXT,
        summary_up_to INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        skip_extraction INTEGER NOT NULL DEFAULT 0,
        is_unread INTEGER NOT NULL DEFAULT 0,
        primary_subject_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const store = new ThreadStore(db);
    store.createThread('t1', { model_tier: 'balanced', model_tier_source: 'default' });
    expect(store.getThread('t1')?.model_tier_source).toBe('default');

    store.updateThread('t1', { model_tier: 'deep', model_tier_source: 'user' });
    const after = store.getThread('t1');
    expect(after?.model_tier).toBe('deep');
    expect(after?.model_tier_source).toBe('user');
    db.close();
  });
});
