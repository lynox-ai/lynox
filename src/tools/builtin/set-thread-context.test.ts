import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { EngineDb } from '../../core/engine-db.js';
import { SubjectStore } from '../../core/subject-store.js';
import { ThreadStore } from '../../core/thread-store.js';
import { createToolContext } from '../../core/tool-context.js';
import { setThreadContextTool } from './set-thread-context.js';
import type { IAgent } from '../../types/index.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';

// Live-threads schema mirror (history.db) incl. the A1 `primary_subject_id` column
// — the same minimal shape ThreadStore's A1 tests build. subjects live in engine.db
// (a separate handle), so the tool spans two databases exactly as in production.
function freshThreadsDb(): Database.Database {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE deleted_threads (id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL DEFAULT (datetime('now')));
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
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const THREAD = 't-current';

describe('set_thread_context tool (Context-Hierarchy Scoping — Slice A2)', () => {
  let tmpDirs: string[] = [];
  let engineDb: EngineDb;
  let subjects: SubjectStore;
  let threadsDb: Database.Database;
  let threads: ThreadStore;
  let agent: IAgent;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-a2-'));
    tmpDirs.push(dir);
    engineDb = new EngineDb(join(dir, 'engine.db'), '');
    subjects = new SubjectStore(engineDb);
    threadsDb = freshThreadsDb();
    threads = new ThreadStore(threadsDb);
    threads.createThread(THREAD);
    const ctx = createToolContext({});
    ctx.subjectStore = subjects;
    ctx.threadStore = threads;
    agent = { principal: OWNER_PRINCIPAL, toolContext: ctx, currentThreadId: THREAD } as unknown as IAgent;
  });

  afterEach(() => {
    try { engineDb.close(); } catch { /* ok */ }
    try { threadsDb.close(); } catch { /* ok */ }
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  it('anchors a project under a customer; both persist; the thread points at the project', async () => {
    const res = await setThreadContextTool.handler(
      { project: 'Website Relaunch', customer: 'Meridian' },
      agent,
    );
    expect(res).toContain('Website Relaunch');
    expect(res).toContain('Meridian');

    const orgs = subjects.listSubjects({ kind: 'organization' });
    const engs = subjects.listSubjects({ kind: 'engagement' });
    expect(orgs).toHaveLength(1);
    expect(engs).toHaveLength(1);
    expect(engs[0]!.parent_id).toBe(orgs[0]!.id);
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(engs[0]!.id);
  });

  it('is idempotent — same project+customer reuses the SAME engagement (no duplicate row)', async () => {
    await setThreadContextTool.handler({ project: 'Website', customer: 'Meridian' }, agent);
    const firstEng = subjects.listSubjects({ kind: 'engagement' })[0]!.id;

    await setThreadContextTool.handler({ project: 'Website', customer: 'Meridian' }, agent);
    const engs = subjects.listSubjects({ kind: 'engagement' });
    expect(engs).toHaveLength(1);
    expect(engs[0]!.id).toBe(firstEng);
    expect(subjects.listSubjects({ kind: 'organization' })).toHaveLength(1);
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(firstEng);
  });

  it('keeps same-named projects for different customers DISTINCT (composite (name,parent) identity)', async () => {
    await setThreadContextTool.handler({ project: 'Website', customer: 'Meridian' }, agent);
    await setThreadContextTool.handler({ project: 'Website', customer: 'Nordberg' }, agent);

    const engs = subjects.listSubjects({ kind: 'engagement' });
    expect(engs).toHaveLength(2);
    expect(new Set(engs.map((e) => e.parent_id)).size).toBe(2);

    const nordberg = subjects.listSubjects({ kind: 'organization' }).find((o) => o.name === 'Nordberg')!;
    const nordbergEng = engs.find((e) => e.parent_id === nordberg.id)!;
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(nordbergEng.id);
  });

  it('customer-only anchors the thread directly to the organization (no engagement)', async () => {
    await setThreadContextTool.handler({ customer: 'Meridian' }, agent);
    expect(subjects.listSubjects({ kind: 'engagement' })).toHaveLength(0);
    const org = subjects.listSubjects({ kind: 'organization' })[0]!;
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(org.id);
  });

  it('project-only creates an unparented engagement and anchors to it', async () => {
    await setThreadContextTool.handler({ project: 'Internal R&D' }, agent);
    const engs = subjects.listSubjects({ kind: 'engagement' });
    expect(engs).toHaveLength(1);
    expect(engs[0]!.parent_id).toBeNull();
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(engs[0]!.id);
  });

  it('adopts an existing unparented project under a customer on a later call (no duplicate)', async () => {
    await setThreadContextTool.handler({ project: 'Website' }, agent); // unparented first
    const engId = subjects.listSubjects({ kind: 'engagement' })[0]!.id;

    await setThreadContextTool.handler({ project: 'Website', customer: 'Meridian' }, agent);
    const engs = subjects.listSubjects({ kind: 'engagement' });
    expect(engs).toHaveLength(1); // adopted, not duplicated
    expect(engs[0]!.id).toBe(engId);
    const org = subjects.listSubjects({ kind: 'organization' })[0]!;
    expect(engs[0]!.parent_id).toBe(org.id);
  });

  it('reuses a same-named unparented project on a second no-client call (no duplicate)', async () => {
    await setThreadContextTool.handler({ project: 'Internal R&D' }, agent);
    const firstId = subjects.listSubjects({ kind: 'engagement' })[0]!.id;

    await setThreadContextTool.handler({ project: 'Internal R&D' }, agent);
    const engs = subjects.listSubjects({ kind: 'engagement' });
    expect(engs).toHaveLength(1); // reused, not duplicated
    expect(engs[0]!.id).toBe(firstId);
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(firstId);
  });

  it('a no-client call prefers a client-agnostic (unparented) same-named project', async () => {
    // Seed both: a "Website" filed under a client, and a client-agnostic "Website".
    const org = subjects.findOrCreate({ kind: 'organization', name: 'Meridian' }).id;
    subjects.createSubject({ kind: 'engagement', name: 'Website', parentId: org });
    const orphanId = subjects.createSubject({ kind: 'engagement', name: 'Website' });

    await setThreadContextTool.handler({ project: 'Website' }, agent); // no client named
    expect(subjects.listSubjects({ kind: 'engagement' })).toHaveLength(2); // no new row
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(orphanId); // the unparented one
  });

  it('names the client in the confirmation when a no-client call reuses a project filed under one', async () => {
    await setThreadContextTool.handler({ project: 'Website', customer: 'Meridian' }, agent);
    // Later, no client named — the only "Website" is Meridian's, so it is reused
    // AND the confirmation names Meridian rather than silently omitting it.
    const res = await setThreadContextTool.handler({ project: 'Website' }, agent);
    expect(res).toContain('Website');
    expect(res).toContain('Meridian');
    expect(subjects.listSubjects({ kind: 'engagement' })).toHaveLength(1); // reused, no dup
    const eng = subjects.listSubjects({ kind: 'engagement' })[0]!;
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(eng.id);
  });

  it('re-anchors when the project changes within the same thread (context switch)', async () => {
    await setThreadContextTool.handler({ project: 'Website', customer: 'Meridian' }, agent);
    await setThreadContextTool.handler({ project: 'Mobile App', customer: 'Meridian' }, agent);
    const engs = subjects.listSubjects({ kind: 'engagement' });
    expect(engs).toHaveLength(2);
    const mobile = engs.find((e) => e.name === 'Mobile App')!;
    expect(threads.getThread(THREAD)?.primary_subject_id).toBe(mobile.id);
  });

  it('clear:true removes the thread anchor', async () => {
    await setThreadContextTool.handler({ project: 'Website', customer: 'Meridian' }, agent);
    expect(threads.getThread(THREAD)?.primary_subject_id).not.toBeNull();

    const res = await setThreadContextTool.handler({ clear: true }, agent);
    expect(res.toLowerCase()).toContain('cleared');
    expect(threads.getThread(THREAD)?.primary_subject_id).toBeNull();
  });

  it('dedups the customer name case-insensitively (organization identity-by-name)', async () => {
    await setThreadContextTool.handler({ project: 'A', customer: 'Meridian' }, agent);
    await setThreadContextTool.handler({ project: 'B', customer: 'meridian' }, agent);
    expect(subjects.listSubjects({ kind: 'organization' })).toHaveLength(1);
  });

  it('trims surrounding whitespace in names', async () => {
    await setThreadContextTool.handler({ project: '  Website  ', customer: '  Meridian  ' }, agent);
    const org = subjects.listSubjects({ kind: 'organization' })[0]!;
    const eng = subjects.listSubjects({ kind: 'engagement' })[0]!;
    expect(org.name).toBe('Meridian');
    expect(eng.name).toBe('Website');
  });

  // ── Guards (no throw — clean error strings) ──
  it('returns a clean error when the subject graph is unavailable (flag-off runtime state)', async () => {
    agent.toolContext.subjectStore = null;
    const res = await setThreadContextTool.handler({ project: 'X' }, agent);
    expect(res).toContain('Error');
    expect(res.toLowerCase()).toContain('not available');
    // Nothing was written to the thread.
    expect(threads.getThread(THREAD)?.primary_subject_id).toBeNull();
  });

  it('returns a usage error when neither project, customer, nor clear is passed (no rows created)', async () => {
    const res = await setThreadContextTool.handler({}, agent);
    expect(res).toContain('Error');
    expect(subjects.listSubjects().length).toBe(0);
    expect(threads.getThread(THREAD)?.primary_subject_id).toBeNull();
  });

  it('returns an error when there is no current thread (before any subject is created)', async () => {
    (agent as unknown as { currentThreadId: string | undefined }).currentThreadId = undefined;
    const res = await setThreadContextTool.handler({ customer: 'Meridian' }, agent);
    expect(res).toContain('Error');
    expect(subjects.listSubjects().length).toBe(0); // early return before any write
  });

  it('is NOT a confirmation-gated / destructive write (organizational, reversible)', () => {
    expect(setThreadContextTool.requiresConfirmation).toBeFalsy();
    expect(setThreadContextTool.destructive).toBeFalsy();
  });
  // Stored subject names can be text extracted from outside content: they come back only in a
  // marked block after a sentence in lynox's own words. The text outside the blocks is pinned
  // whole, so a field added to the answer without a block turns these red.
  const outsideBlocks = (text: string): string => text.replace(/<untrusted_data[^>]*>[\s\S]*?<\/untrusted_data>/g, '[block]');
  const blockBodies = (text: string): string[] => [...text.matchAll(/<untrusted_data[^>]*>\n([\s\S]*?)\n<\/untrusted_data>/g)].map(m => m[1]!);

  it('a customer name that matches more than one entry returns the stored names in one marked block', async () => {
    subjects.findOrCreate({ kind: 'organization', name: 'Müller Bau AG', aliases: ['Müller'] });
    subjects.findOrCreate({ kind: 'organization', name: 'Müller Handel AG', aliases: ['MÜLLER'] });
    const res = await setThreadContextTool.handler({ customer: 'müller' }, agent);
    expect(blockBodies(res)).toEqual(['Müller Bau AG', 'Müller Handel AG']);
    expect(outsideBlocks(res)).toBe('The customer name matches more than one entry. Use the full name to say which one. The stored names of the matches:\nMatch 1: [block]\nMatch 2: [block]');
    expect(threads.getThread(THREAD)?.primary_subject_id ?? null).toBeNull();
  });

  it('a project filed under a client names that client only in a marked block after the sentence', async () => {
    const org = subjects.createSubject({ kind: 'organization', name: 'Nordberg GmbH' });
    subjects.createSubject({ kind: 'engagement', name: 'Website', parentId: org });
    const res = await setThreadContextTool.handler({ project: 'Website' }, agent);
    expect(blockBodies(res)).toEqual(['Nordberg GmbH']);
    expect(outsideBlocks(res)).toBe('This thread is now scoped to project "Website". Notes saved here and recall will prefer this context. It is filed under a client whose stored name is:\n[block]');
  });

  it('CONTROL: a project under no client carries no block', async () => {
    const res = await setThreadContextTool.handler({ project: 'Website' }, agent);
    expect(res).toBe('This thread is now scoped to project "Website". Notes saved here and recall will prefer this context.');
  });
});
