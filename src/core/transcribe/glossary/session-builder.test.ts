/**
 * Unit tests — session glossary builder + TTL cache + invalidation.
 */

import { describe, expect, it, vi } from 'vitest';
import { channels } from '../../observability.js';
import { buildSessionGlossary, SessionGlossaryCache } from './session-builder.js';

describe('buildSessionGlossary', () => {
  it('assembles terms from all five sources in priority order', () => {
    const terms = buildSessionGlossary({
      contactNames: ['Roland Müller'],
      apiProfileNames: ['Stripe'],
      workflowNames: ['Release Pipeline'],
      threadTitles: ['Billing Fix'],
      kgEntityLabels: ['Hetzner'],
    });
    // Contacts come first (highest priority in the apply step).
    expect(terms[0]).toBe('Roland Müller');
    // Multi-word names also expose their parts.
    expect(terms).toContain('Roland');
    expect(terms).toContain('Müller');
    // Later sources still appear.
    expect(terms).toContain('Stripe');
    expect(terms).toContain('Release Pipeline');
    expect(terms).toContain('Billing Fix');
    expect(terms).toContain('Hetzner');
  });

  it('dedupes case-insensitively across sources', () => {
    const terms = buildSessionGlossary({
      contactNames: ['roland'],
      kgEntityLabels: ['Roland'],
    });
    // Only one of the two should remain — the contact wins (arrives first).
    const rolandCount = terms.filter((t) => t.toLowerCase() === 'roland').length;
    expect(rolandCount).toBe(1);
  });

  it('filters out terms shorter than minLength', () => {
    const terms = buildSessionGlossary(
      { contactNames: ['Ed', 'Rob', 'Roland'] },
      { minLength: 4 },
    );
    expect(terms).not.toContain('Ed');
    expect(terms).not.toContain('Rob');
    expect(terms).toContain('Roland');
  });

  it('caps total output at maxTerms', () => {
    const names = Array.from({ length: 500 }, (_, i) => `Contact${String(i).padStart(3, '0')}`);
    const terms = buildSessionGlossary({ contactNames: names }, { maxTerms: 25 });
    expect(terms.length).toBe(25);
  });

  it('handles empty / missing sources gracefully', () => {
    expect(buildSessionGlossary({})).toEqual([]);
    expect(buildSessionGlossary({ contactNames: [] })).toEqual([]);
  });

  it('splits compound names on common separators', () => {
    const terms = buildSessionGlossary({ contactNames: ['Marie-Claire O\'Hara'] });
    expect(terms).toContain('Marie-Claire O\'Hara');
    expect(terms).toContain('Marie');
    expect(terms).toContain('Claire');
    // "O'Hara" keeps the apostrophe when expanded — stays a single token.
    expect(terms).toContain('O\'Hara');
  });
});

describe('SessionGlossaryCache', () => {
  it('returns cached terms within TTL and computes on miss', () => {
    const cache = new SessionGlossaryCache(60_000);
    const compute = vi.fn(() => ['Roland', 'Amanda']);

    const first = cache.get('thread-1', compute);
    const second = cache.get('thread-1', compute);
    expect(first).toEqual(['Roland', 'Amanda']);
    expect(second).toEqual(['Roland', 'Amanda']);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('recomputes after TTL expires', () => {
    vi.useFakeTimers();
    try {
      const cache = new SessionGlossaryCache(1_000);
      const compute = vi.fn(() => ['Roland']);
      cache.get('k', compute);
      vi.advanceTimersByTime(1_500);
      cache.get('k', compute);
      expect(compute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidate(key) clears a single entry', () => {
    const cache = new SessionGlossaryCache();
    const compute = vi.fn(() => ['x']);
    cache.get('a', compute);
    cache.get('b', compute);
    expect(cache.size).toBe(2);
    cache.invalidate('a');
    expect(cache.size).toBe(1);
  });

  it('invalidate() with no arg clears everything', () => {
    const cache = new SessionGlossaryCache();
    const compute = vi.fn(() => ['x']);
    cache.get('a', compute);
    cache.get('b', compute);
    cache.invalidate();
    expect(cache.size).toBe(0);
  });

  it('attachInvalidators() wipes the cache on datastore-insert diagnostic events', () => {
    const cache = new SessionGlossaryCache();
    const detach = cache.attachInvalidators();
    try {
      cache.get('thread', () => ['term']);
      expect(cache.size).toBe(1);
      channels.dataStoreInsert.publish({ collection: 'contacts', recordCount: 1 });
      expect(cache.size).toBe(0);
    } finally {
      detach();
    }
  });

  it('attachInvalidators() wipes the cache on knowledge-entity diagnostic events', () => {
    const cache = new SessionGlossaryCache();
    const detach = cache.attachInvalidators();
    try {
      cache.get('thread', () => ['term']);
      expect(cache.size).toBe(1);
      channels.knowledgeEntity.publish({ entityId: 'e1' });
      expect(cache.size).toBe(0);
    } finally {
      detach();
    }
  });

  it('detachInvalidators() stops reacting to diagnostic events', () => {
    const cache = new SessionGlossaryCache();
    cache.attachInvalidators();
    cache.detachInvalidators();
    cache.get('thread', () => ['term']);
    channels.dataStoreInsert.publish({ collection: 'contacts', recordCount: 1 });
    // Cache still populated — detach worked.
    expect(cache.size).toBe(1);
  });
});
