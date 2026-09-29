/**
 * The web UI keeps a copy of the engine's credential shapes (it cannot import the
 * engine). This holds the copy equal to the engine's list for the kinds the web
 * UI takes — as a SET, in both directions: a shape added only on the engine side
 * fails here, which is the direction a copy actually drifts.
 */
import { describe, it, expect } from 'vitest';
import { SECRET_SHAPES as ENGINE_SHAPES } from '../src/core/secret-store.js';
import { SECRET_SHAPES as WEB_UI_SHAPES } from '../packages/web-ui/src/lib/utils/secret-shapes.js';

const WEB_UI_KINDS = new Set(['vendor', 'jwt', 'key-block']);
const key = (s: { label: string; kind: string; pattern: RegExp }): string =>
  `${s.label} | ${s.kind} | ${s.pattern.source} | ${s.pattern.flags}`;

describe('secret shapes: web UI copy equals the engine list', () => {
  it('has exactly the engine shapes of the kinds it takes', () => {
    const engine = ENGINE_SHAPES.filter((s) => WEB_UI_KINDS.has(s.kind)).map(key).sort();
    const webUi = WEB_UI_SHAPES.map(key).sort();
    expect(webUi).toEqual(engine);
  });

  it('takes a non-empty share of each kind — an empty filter would pass the equality', () => {
    for (const kind of WEB_UI_KINDS) {
      expect(WEB_UI_SHAPES.some((s) => s.kind === kind)).toBe(true);
    }
  });
});
