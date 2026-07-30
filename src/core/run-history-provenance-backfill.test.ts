import { describe, it, expect } from 'vitest';
import { RunHistory } from './run-history.js';
import { ThreadStore } from './thread-store.js';

/**
 * Provenance recovery backfill (arc:model-selector P1, DEF-0095). Exercises the
 * REAL migration path (`new RunHistory(':memory:')` runs v47 model_tier_source +
 * v49 marker) so the SQL + brand-name normalisation are verified end-to-end.
 */
describe('RunHistory.backfillModelTierSourceFromDefault (P1 provenance recovery)', () => {
  it("labels only ≠default 'unknown' threads as 'user', normalising legacy brand names", () => {
    const rh = new RunHistory(':memory:');
    const store = new ThreadStore(rh.getDb());

    // default tier = 'balanced'. createThread leaves model_tier_source at 'unknown'
    // unless told otherwise (simulating pre-column rows).
    store.createThread('t-default', { model_tier: 'balanced' }); // == default → stays unknown
    store.createThread('t-deep', { model_tier: 'deep' });        // ≠ default → user
    store.createThread('t-sonnet', { model_tier: 'sonnet' });    // legacy balanced == default → unknown
    store.createThread('t-opus', { model_tier: 'opus' });        // legacy deep ≠ default → user
    store.createThread('t-empty', { model_tier: '' });           // unparseable → treated as default → unknown
    store.createThread('t-already', { model_tier: 'deep', model_tier_source: 'user' }); // not 'unknown' → untouched

    expect(rh.isModelProvenanceBackfillDone()).toBe(false);

    const labelled = rh.backfillModelTierSourceFromDefault('balanced');
    expect(labelled).toBe(2); // t-deep + t-opus

    expect(store.getThread('t-default')?.model_tier_source).toBe('unknown');
    expect(store.getThread('t-deep')?.model_tier_source).toBe('user');
    expect(store.getThread('t-sonnet')?.model_tier_source).toBe('unknown');
    expect(store.getThread('t-opus')?.model_tier_source).toBe('user');
    expect(store.getThread('t-empty')?.model_tier_source).toBe('unknown');
    expect(store.getThread('t-already')?.model_tier_source).toBe('user');

    // Marker flips + gates a re-run.
    rh.markModelProvenanceBackfillDone();
    expect(rh.isModelProvenanceBackfillDone()).toBe(true);
    // A second run is a no-op (rows are no longer 'unknown' where they were changed;
    // and in practice the marker gate prevents it being called again).
    expect(rh.backfillModelTierSourceFromDefault('balanced')).toBe(0);

    rh.close();
  });

  it('is a no-op on a fresh instance with no pre-column threads', () => {
    const rh = new RunHistory(':memory:');
    expect(rh.isModelProvenanceBackfillDone()).toBe(false);
    expect(rh.backfillModelTierSourceFromDefault('balanced')).toBe(0);
    rh.close();
  });
});
