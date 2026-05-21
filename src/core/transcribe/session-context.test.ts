/**
 * Unit tests — extractSessionContext (engine-backed session-context builder).
 *
 * Uses a duck-typed Engine stub so we don't need to spin up the full singleton
 * for what's ultimately a few getter calls.
 */

import { describe, expect, it } from 'vitest';
import type { Engine } from '../engine.js';
import { extractSessionContext } from './session-context.js';

interface FakeEngineParts {
  contacts?: Array<{ name?: string | undefined }>;
  apis?: Array<{ name: string }>;
  threads?: Array<{ id: string; title: string }>;
  currentThread?: { id: string; title: string };
}

function makeEngine(parts: FakeEngineParts): Engine {
  const crm = parts.contacts !== undefined
    ? { listContacts: (_filter: unknown, _limit: number) => parts.contacts }
    : null;
  const apiStore = parts.apis !== undefined
    ? { getAll: () => parts.apis }
    : null;
  const threadStore = parts.threads !== undefined || parts.currentThread !== undefined
    ? {
        getThread: (id: string) => (parts.currentThread?.id === id ? parts.currentThread : undefined),
        listThreads: (_opts: unknown) => parts.threads ?? [],
      }
    : null;

  return {
    getCRM: () => crm,
    getApiStore: () => apiStore,
    getThreadStore: () => threadStore,
    // KG is intentionally never read by the session-context extractor.
    getKnowledgeLayer: () => null,
  } as unknown as Engine;
}

describe('extractSessionContext', () => {
  it('assembles a context from CRM, API and thread stores', () => {
    const engine = makeEngine({
      contacts: [{ name: 'Roland' }, { name: 'Amanda' }],
      apis: [{ name: 'Stripe' }, { name: 'Gmail' }],
      currentThread: { id: 'thread-1', title: 'Billing bug' },
      threads: [
        { id: 'thread-1', title: 'Billing bug' },
        { id: 'thread-2', title: 'Release prep' },
      ],
    });

    const ctx = extractSessionContext(engine, 'thread-1');
    expect(ctx.sessionId).toBe('thread-1');
    expect(ctx.threadId).toBe('thread-1');
    expect(ctx.contactNames).toEqual(['Roland', 'Amanda']);
    expect(ctx.apiProfileNames).toEqual(['Stripe', 'Gmail']);
    expect(ctx.threadTitles).toEqual(['Billing bug', 'Release prep']);
  });

  it('never reads KG entity labels (excluded as a voice hint)', () => {
    // Even with a knowledge layer wired up, the extractor must not surface its
    // entities — KG proper nouns over-biased the fuzzy glossary rewrite.
    const engine = {
      getCRM: () => null,
      getApiStore: () => null,
      getThreadStore: () => null,
      getKnowledgeLayer: () => ({
        getDb: () => ({ listEntities: () => [{ canonical_name: 'Olten' }] }),
      }),
    } as unknown as Engine;
    const ctx = extractSessionContext(engine, 't');
    expect(ctx).not.toHaveProperty('kgEntityLabels');
  });

  it('handles missing stores gracefully (omits the keys)', () => {
    const engine = makeEngine({}); // all stores null
    const ctx = extractSessionContext(engine, 'thread-x');
    expect(ctx.contactNames).toBeUndefined();
    expect(ctx.apiProfileNames).toBeUndefined();
    expect(ctx.threadTitles).toBeUndefined();
    expect(ctx.sessionId).toBe('thread-x');
    expect(ctx.threadId).toBe('thread-x');
  });

  it('tolerates a null sessionId (no current thread lookup)', () => {
    const engine = makeEngine({
      contacts: [{ name: 'Roland' }],
      threads: [{ id: 't1', title: 'X' }],
    });
    const ctx = extractSessionContext(engine, null);
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.threadId).toBeUndefined();
    expect(ctx.contactNames).toEqual(['Roland']);
    expect(ctx.threadTitles).toEqual(['X']);
  });

  it('filters out contacts with empty/undefined names', () => {
    const engine = makeEngine({
      contacts: [{ name: 'Roland' }, { name: undefined }, { name: '' }, { name: 'Amanda' }],
    });
    const ctx = extractSessionContext(engine, 't');
    expect(ctx.contactNames).toEqual(['Roland', 'Amanda']);
  });

  it('prepends the current thread title and dedupes it against the listing', () => {
    const engine = makeEngine({
      currentThread: { id: 't1', title: 'Current work' },
      threads: [
        { id: 't1', title: 'Current work' }, // duplicate — should dedupe
        { id: 't2', title: 'Other work' },
      ],
    });
    const ctx = extractSessionContext(engine, 't1');
    expect(ctx.threadTitles).toEqual(['Current work', 'Other work']);
  });

  it('caps contacts according to opts', () => {
    const engine = makeEngine({
      contacts: Array.from({ length: 200 }, (_, i) => ({ name: `C${i}` })),
    });
    const ctx = extractSessionContext(engine, 't', { maxContacts: 10 });
    expect(ctx.contactNames).toHaveLength(10);
  });

  it('swallows store errors and still returns a usable context', () => {
    const engine = {
      getCRM: () => ({ listContacts: () => { throw new Error('boom'); } }),
      getApiStore: () => ({ getAll: () => [{ name: 'Stripe' }] }),
      getThreadStore: () => null,
      getKnowledgeLayer: () => null,
    } as unknown as Engine;

    const ctx = extractSessionContext(engine, 't');
    expect(ctx.contactNames).toBeUndefined();
    expect(ctx.apiProfileNames).toEqual(['Stripe']);
  });
});
