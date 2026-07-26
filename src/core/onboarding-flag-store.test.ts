import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import {
  OnboardingFlagStore,
  ONBOARDING_FLAGS,
  isOnboardingFlag,
} from './onboarding-flag-store.js';

describe('OnboardingFlagStore (Onboarding Wave 1 — Layer-1 foundation)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function make(): { store: OnboardingFlagStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-onb-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return { store: new OnboardingFlagStore(engine), engine };
  }

  afterEach(() => {
    for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
    for (const d of tmpDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  // ── Migration v10 shape (mutation-catching: a missing table / wrong CHECK fails here) ──

  it('v10 migration creates the onboarding_flags table and reaches schema_version 10', () => {
    const { engine } = make();
    const db = engine.getDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_flags'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('onboarding_flags');
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(version.v).toBeGreaterThanOrEqual(10);
  });

  it('the flag CHECK rejects an unknown flag at the DB layer (defense in depth)', () => {
    const { engine } = make();
    const db = engine.getDb();
    expect(() =>
      db.prepare('INSERT INTO onboarding_flags (owner_user_id, flag, value) VALUES (?, ?, ?)')
        .run('system', 'not_a_real_flag', 'x'),
    ).toThrow();
  });

  it('the composite PK (owner_user_id, flag) upserts — the second write updates, never duplicates', () => {
    const { store, engine } = make();
    store.set('knowledge_done', 'thread-A');
    store.set('knowledge_done', 'thread-B');
    const count = engine.getDb()
      .prepare("SELECT COUNT(*) AS c FROM onboarding_flags WHERE owner_user_id='system' AND flag='knowledge_done'")
      .get() as { c: number };
    expect(count.c).toBe(1);
    expect(store.get('knowledge_done')).toBe('thread-B');
  });

  // ── Store behaviour ──

  it('set + get round-trips a value; get returns null for an absent flag', () => {
    const { store } = make();
    expect(store.get('skipped')).toBeNull();
    store.set('skipped', '2026-07-26T00:00:00Z');
    expect(store.get('skipped')).toBe('2026-07-26T00:00:00Z');
  });

  it('set defaults the value to empty string when omitted', () => {
    const { store } = make();
    store.set('skipped');
    expect(store.get('skipped')).toBe('');
  });

  it('reset removes a flag and reports it; a second reset is an idempotent no-op', () => {
    const { store } = make();
    store.set('knowledge_done', 't1');
    expect(store.reset('knowledge_done')).toBe(true);
    expect(store.get('knowledge_done')).toBeNull();
    expect(store.reset('knowledge_done')).toBe(false);
  });

  it('getStatus derives the booleans + carries the durable links (RF-IRR1 thread-id)', () => {
    const { store } = make();
    expect(store.getStatus()).toEqual({
      knowledgeDone: false, knowledgeThreadId: null, skipped: false,
      pushNudge: null, firstSessionAt: null,
    });
    store.set('knowledge_done', 'onb-thread-42');
    store.set('first_session_at', '2026-07-26T08:00:00Z');
    store.set('push_nudge', 'declined');
    const s = store.getStatus();
    expect(s.knowledgeDone).toBe(true);
    expect(s.knowledgeThreadId).toBe('onb-thread-42');
    expect(s.firstSessionAt).toBe('2026-07-26T08:00:00Z');
    expect(s.pushNudge).toBe('declined');
    expect(s.skipped).toBe(false);
  });

  it('a knowledge_done with an empty value is done but carries no repair link (thread-id null)', () => {
    const { store } = make();
    store.set('knowledge_done', '');
    const s = store.getStatus();
    expect(s.knowledgeDone).toBe(true);
    expect(s.knowledgeThreadId).toBeNull();
  });

  it('owner_user_id scopes the flags — a second owner is independent (D8 multi-user-proof)', () => {
    const { store } = make();
    store.set('knowledge_done', 'sys-thread', 'system');
    store.set('knowledge_done', 'other-thread', 'user-2');
    expect(store.get('knowledge_done', 'system')).toBe('sys-thread');
    expect(store.get('knowledge_done', 'user-2')).toBe('other-thread');
    expect(store.getStatus('system').knowledgeThreadId).toBe('sys-thread');
    expect(store.getStatus('user-2').knowledgeThreadId).toBe('other-thread');
    // Resetting one owner leaves the other untouched.
    store.reset('knowledge_done', 'system');
    expect(store.get('knowledge_done', 'system')).toBeNull();
    expect(store.get('knowledge_done', 'user-2')).toBe('other-thread');
  });

  it('deleteAllData wipes onboarding_flags (GDPR Art. 17 auto-enumeration, S2)', () => {
    const { store, engine } = make();
    store.set('knowledge_done', 't1');
    engine.deleteAllData();
    expect(store.get('knowledge_done')).toBeNull();
    // schema stays intact — the table is still there, just empty.
    const table = engine.getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_flags'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('onboarding_flags');
  });

  // ── Flag enum guard (the wire-boundary validator) ──

  it('isOnboardingFlag accepts every known flag and rejects unknowns', () => {
    for (const f of ONBOARDING_FLAGS) expect(isOnboardingFlag(f)).toBe(true);
    expect(isOnboardingFlag('knowledge_done')).toBe(true);
    expect(isOnboardingFlag('bogus')).toBe(false);
    expect(isOnboardingFlag('')).toBe(false);
    expect(isOnboardingFlag('literacy_seen')).toBe(false);
  });

  it('the flag enum is exactly the four Wave-1..3 flags (forward-complete CHECK, no rebuild later)', () => {
    expect([...ONBOARDING_FLAGS].sort()).toEqual(
      ['first_session_at', 'knowledge_done', 'push_nudge', 'skipped'],
    );
  });
});
