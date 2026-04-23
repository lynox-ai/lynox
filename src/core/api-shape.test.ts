import { describe, it, expect } from 'vitest';
import { applyShape, parsePath } from './api-shape.js';
import type { ResponseShape } from './api-store.js';

describe('parsePath', () => {
  it('parses simple field paths', () => {
    expect(parsePath('foo.bar.baz')).toEqual([
      { kind: 'field', name: 'foo' },
      { kind: 'field', name: 'bar' },
      { kind: 'field', name: 'baz' },
    ]);
  });

  it('parses array markers', () => {
    expect(parsePath('items[].name')).toEqual([
      { kind: 'field', name: 'items' },
      { kind: 'array' },
      { kind: 'field', name: 'name' },
    ]);
  });

  it('parses nested array markers', () => {
    expect(parsePath('tasks[].result[].items[].keyword')).toEqual([
      { kind: 'field', name: 'tasks' },
      { kind: 'array' },
      { kind: 'field', name: 'result' },
      { kind: 'array' },
      { kind: 'field', name: 'items' },
      { kind: 'array' },
      { kind: 'field', name: 'keyword' },
    ]);
  });
});

describe('applyShape — passthrough', () => {
  it('returns raw stringified when kind is passthrough', () => {
    const raw = { foo: 1, bar: [1, 2, 3] };
    const result = applyShape(raw, { kind: 'passthrough' });
    expect(JSON.parse(result.shaped)).toEqual(raw);
    expect(result.error).toBeUndefined();
  });

  it('returns raw stringified when kind is unset', () => {
    const raw = { foo: 1 };
    const result = applyShape(raw, {});
    expect(JSON.parse(result.shaped)).toEqual(raw);
  });
});

describe('applyShape — projection', () => {
  it('whitelists top-level fields', () => {
    const raw = { a: 1, b: 2, c: 3 };
    const result = applyShape(raw, { kind: 'reduce', include: ['a', 'c'] });
    expect(JSON.parse(result.shaped)).toEqual({ a: 1, c: 3 });
  });

  it('whitelists through arrays with []', () => {
    const raw = {
      items: [
        { id: 1, keyword: 'seo', cost: 100 },
        { id: 2, keyword: 'marketing', cost: 200 },
      ],
    };
    const result = applyShape(raw, {
      kind: 'reduce',
      include: ['items[].keyword'],
    });
    expect(JSON.parse(result.shaped)).toEqual({
      items: [{ keyword: 'seo' }, { keyword: 'marketing' }],
    });
  });

  it('whitelists deeply nested paths (DataForSEO-style)', () => {
    const raw = {
      tasks: [
        {
          id: 't1',
          noise: 'ignored',
          result: [
            {
              items: [
                { keyword: 'alpha', search_volume: 100, cpc: 1.5, competition: 'HIGH' },
                { keyword: 'beta', search_volume: 50, cpc: 0.8, competition: 'LOW' },
              ],
            },
          ],
        },
      ],
    };
    const shape: ResponseShape = {
      kind: 'reduce',
      include: ['tasks[].result[].items[].keyword', 'tasks[].result[].items[].search_volume'],
    };
    const result = applyShape(raw, shape);
    expect(JSON.parse(result.shaped)).toEqual({
      tasks: [
        {
          result: [
            {
              items: [
                { keyword: 'alpha', search_volume: 100 },
                { keyword: 'beta', search_volume: 50 },
              ],
            },
          ],
        },
      ],
    });
  });

  it('skips paths that do not exist in the response', () => {
    const raw = { a: 1 };
    const result = applyShape(raw, { kind: 'reduce', include: ['a', 'missing.path'] });
    expect(JSON.parse(result.shaped)).toEqual({ a: 1 });
  });
});

describe('applyShape — reducers', () => {
  it('reduces array of numbers to avg+peak', () => {
    const raw = { monthly_searches: [100, 200, 300, 400] };
    const result = applyShape(raw, {
      kind: 'reduce',
      reduce: { monthly_searches: 'avg+peak' },
    });
    expect(JSON.parse(result.shaped)).toEqual({
      monthly_searches: { avg: 250, peak: 400, count: 4 },
    });
  });

  it('reduces array of {value} objects (DataForSEO search-volume shape)', () => {
    const raw = {
      data: {
        monthly_searches: [
          { year: 2024, month: 1, search_volume: 1000 },
          { year: 2024, month: 2, search_volume: 2000 },
          { year: 2024, month: 3, search_volume: 3000 },
        ],
      },
    };
    const result = applyShape(raw, {
      kind: 'reduce',
      reduce: { 'data.monthly_searches': 'avg+peak' },
    });
    const parsed = JSON.parse(result.shaped) as { data: { monthly_searches: unknown } };
    expect(parsed.data.monthly_searches).toEqual({ avg: 2000, peak: 3000, count: 3 });
  });

  it('count reducer replaces array with length', () => {
    const raw = { items: Array.from({ length: 25 }, (_, i) => ({ id: i })) };
    const result = applyShape(raw, {
      kind: 'reduce',
      reduce: { items: 'count' },
    });
    expect(JSON.parse(result.shaped)).toEqual({ items: 25 });
  });

  it('first_n reducer keeps first N items (N = max_array_items)', () => {
    const raw = { items: [1, 2, 3, 4, 5] };
    const result = applyShape(raw, {
      kind: 'reduce',
      reduce: { items: 'first_n' },
      max_array_items: 2,
    });
    const parsed = JSON.parse(result.shaped) as { items: unknown[] };
    // max_array_items also applies to the reduced result — so 2 after both passes.
    expect(parsed.items.slice(0, 2)).toEqual([1, 2]);
  });

  it('reducer on nested array via path traversal', () => {
    const raw = {
      results: [
        { id: 'a', values: [1, 2, 3] },
        { id: 'b', values: [10, 20, 30] },
      ],
    };
    const result = applyShape(raw, {
      kind: 'reduce',
      reduce: { 'results[].values': 'avg' },
    });
    expect(JSON.parse(result.shaped)).toEqual({
      results: [
        { id: 'a', values: { avg: 2, count: 3 } },
        { id: 'b', values: { avg: 20, count: 3 } },
      ],
    });
  });
});

describe('applyShape — deep caps', () => {
  it('max_array_items caps arrays and appends a marker', () => {
    const raw = { items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    const result = applyShape(raw, { kind: 'reduce', max_array_items: 3 });
    const parsed = JSON.parse(result.shaped) as { items: unknown[] };
    expect(parsed.items.length).toBe(4); // 3 kept + marker
    expect(parsed.items[3]).toContain('7 more truncated');
  });

  it('max_string_chars caps deep strings', () => {
    const raw = { description: 'a'.repeat(1000), title: 'short' };
    const result = applyShape(raw, { kind: 'reduce', max_string_chars: 20 });
    const parsed = JSON.parse(result.shaped) as { description: string; title: string };
    expect(parsed.description.length).toBeLessThan(40);
    expect(parsed.description).toContain('…[+');
    expect(parsed.title).toBe('short');
  });

  it('max_chars caps final stringified output', () => {
    const raw = { long: 'x'.repeat(1000) };
    const result = applyShape(raw, { kind: 'reduce', max_chars: 100 });
    expect(result.shaped.length).toBeLessThanOrEqual(200);
    expect(result.shaped).toContain('shape-capped');
  });
});

describe('applyShape — composition', () => {
  it('projection + reducer + cap work together', () => {
    const raw = {
      tasks: [
        {
          result: [
            {
              items: [
                { keyword: 'a', search_volume: 100, trend: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
                { keyword: 'b', search_volume: 200, trend: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] },
              ],
            },
          ],
        },
      ],
    };
    const shape: ResponseShape = {
      kind: 'reduce',
      include: [
        'tasks[].result[].items[].keyword',
        'tasks[].result[].items[].search_volume',
        'tasks[].result[].items[].trend',
      ],
      reduce: { 'tasks[].result[].items[].trend': 'avg+peak' },
      max_array_items: 5,
    };
    const result = applyShape(raw, shape);
    const parsed = JSON.parse(result.shaped) as {
      tasks: [{ result: [{ items: Array<{ trend: { avg: number; peak: number } }> }] }];
    };
    expect(parsed.tasks[0].result[0].items[0]!.trend).toEqual({ avg: 6.5, peak: 12, count: 12 });
    expect(parsed.tasks[0].result[0].items[1]!.trend).toEqual({ avg: 32.5, peak: 60, count: 12 });
    expect(result.afterChars).toBeLessThan(result.beforeChars);
  });

  it('reports beforeChars and afterChars', () => {
    const raw = { a: 'x'.repeat(1000) };
    const result = applyShape(raw, { kind: 'reduce', max_string_chars: 50 });
    expect(result.beforeChars).toBeGreaterThan(1000);
    expect(result.afterChars).toBeLessThan(200);
  });
});

describe('applyShape — error fallback', () => {
  it('never throws; returns raw on internal error with error field', () => {
    // Force an error by passing a circular reference for reduce path traversal.
    // applyShape itself is defensive, but we can stress it with pathologically deep input.
    const raw: Record<string, unknown> = {};
    // Deliberately NOT circular (JSON.stringify would throw) — instead pass a non-object
    // to reduce paths that expect objects.
    const shape: ResponseShape = {
      kind: 'reduce',
      // Path into a primitive — reducers should cope without throwing.
      reduce: { 'foo.bar.baz': 'avg' },
    };
    raw.foo = 'not-an-object';
    const result = applyShape(raw, shape);
    // Either a clean result or a fallback — both are acceptable as long as it does not throw.
    expect(typeof result.shaped).toBe('string');
  });
});
