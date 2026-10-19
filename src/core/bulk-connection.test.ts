import { describe, it, expect } from 'vitest';
import { mergeConnections } from './bulk-connection.js';

describe('mergeConnections', () => {
  const a1 = { id: 'shop', grantId: 'g1' };

  it('is null when nothing was attached', () => {
    expect(mergeConnections([])).toBeNull();
    expect(mergeConnections([null, null])).toBeNull();
  });

  it('keeps one connection and its grant while every request agrees, skipping requests without one', () => {
    expect(mergeConnections([a1])).toEqual(a1);
    expect(mergeConnections([null, a1, a1, null])).toEqual(a1);
  });

  it('leaves the grant unknown when two requests carried different grants of one connection', () => {
    expect(mergeConnections([a1, { id: 'shop', grantId: 'g2' }])).toEqual({ id: 'shop', grantId: null });
    expect(mergeConnections([a1, { id: 'shop', grantId: null }])).toEqual({ id: 'shop', grantId: null });
  });

  it('keeps the first id with an unknown grant when a later request came from another connection', () => {
    expect(mergeConnections([a1, { id: 'other', grantId: 'g1' }])).toEqual({ id: 'shop', grantId: null });
  });

  it('never names a grant again once it is unknown, even when a later request carries the first one', () => {
    expect(mergeConnections([a1, { id: 'shop', grantId: 'g2' }, a1])).toEqual({ id: 'shop', grantId: null });
  });
});
