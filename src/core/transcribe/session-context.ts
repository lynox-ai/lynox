/**
 * Engine-backed session context extractor.
 *
 * Reads the handful of stores a voice transcription benefits from:
 *   - CRM contact names (biased rewriting for "Rolland" → "Roland")
 *   - Registered API / tool profile names (`Stripe`, `Gmail`, custom tools)
 *   - Current + recent thread titles (topical vocabulary)
 *   - KG entity canonical names (user-specific proper nouns)
 *
 * All store reads are best-effort and tolerate a null store — a fresh engine
 * without a CRM or KG still produces a valid (empty-ish) context. No store
 * is required for the facade to work.
 */

import type { Engine } from './../engine.js';
import type { TranscribeSessionContext } from './types.js';

export interface ExtractOptions {
  /** Max contacts to include. Default 80 — matches glossary cap. */
  readonly maxContacts?: number;
  /** Max KG entities to include. Default 200. */
  readonly maxKgEntities?: number;
  /** How many recent thread titles to include (including the current). Default 10. */
  readonly recentThreadTitles?: number;
}

/**
 * Pull a TranscribeSessionContext from the engine's stores.
 * `sessionId` is the current thread ID when available; passing null is fine
 * (just means the builder can't use the current thread's title as a hint).
 */
export function extractSessionContext(
  engine: Engine,
  sessionId: string | null,
  opts: ExtractOptions = {},
): TranscribeSessionContext {
  const maxContacts = opts.maxContacts ?? 80;
  const maxKg = opts.maxKgEntities ?? 200;
  const recentThreads = opts.recentThreadTitles ?? 10;

  const contactNames = readContactNames(engine, maxContacts);
  const apiProfileNames = readApiProfileNames(engine);
  const threadTitles = readThreadTitles(engine, sessionId, recentThreads);
  const kgEntityLabels = readKgEntityLabels(engine, maxKg);

  const ctx: Record<string, unknown> = {};
  if (sessionId) ctx['sessionId'] = sessionId;
  if (sessionId) ctx['threadId'] = sessionId;
  if (contactNames.length > 0) ctx['contactNames'] = contactNames;
  if (apiProfileNames.length > 0) ctx['apiProfileNames'] = apiProfileNames;
  if (threadTitles.length > 0) ctx['threadTitles'] = threadTitles;
  if (kgEntityLabels.length > 0) ctx['kgEntityLabels'] = kgEntityLabels;

  return ctx as TranscribeSessionContext;
}

function readContactNames(engine: Engine, cap: number): string[] {
  const crm = engine.getCRM();
  if (!crm) return [];
  try {
    const contacts = crm.listContacts(undefined, cap);
    const names = contacts
      .map((c) => (typeof c.name === 'string' ? c.name : ''))
      .filter((n) => n.length > 0);
    // Defense in depth: post-slice even if the store ignored the limit.
    return names.slice(0, cap);
  } catch {
    return [];
  }
}

function readApiProfileNames(engine: Engine): string[] {
  const store = engine.getApiStore();
  if (!store) return [];
  try {
    return store.getAll().map((p) => p.name).filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

function readThreadTitles(engine: Engine, sessionId: string | null, recent: number): string[] {
  const store = engine.getThreadStore();
  if (!store) return [];
  const titles: string[] = [];
  try {
    // Current thread first, so it wins priority order in the glossary builder.
    if (sessionId) {
      const current = store.getThread(sessionId);
      if (current?.title) titles.push(current.title);
    }
    const list = store.listThreads({ limit: recent });
    for (const t of list) {
      if (t.title && !titles.includes(t.title)) titles.push(t.title);
    }
  } catch {
    // best-effort
  }
  return titles;
}

function readKgEntityLabels(engine: Engine, cap: number): string[] {
  const kg = engine.getKnowledgeLayer();
  if (!kg) return [];
  try {
    const db = kg.getDb();
    const rows = db.listEntities({ limit: cap });
    const labels = rows
      .map((r) => (typeof r.canonical_name === 'string' ? r.canonical_name : ''))
      .filter((n) => n.length > 0);
    return labels.slice(0, cap);
  } catch {
    return [];
  }
}
