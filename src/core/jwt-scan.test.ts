import { describe, it, expect } from 'vitest';
import { JWT_SPECS, JWT_SHAPE, JWT_EGRESS_WIDE, LinearJwtRegExp, withFlags, type JwtShapeSpec } from './jwt-scan.js';

// Seeded so a failure reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Short texts dense in the parts a JWT regex reacts to: `eyJ`, dots, `-`, `_`, spaces. */
function corpus(seed: number, count: number): string[] {
  const r = rng(seed);
  const b64 = (k: number): string => Array.from({ length: k }, () => B64[Math.floor(r() * 64)]).join('');
  const piece = (): string => {
    const x = r();
    if (x < 0.25) return 'eyJ' + b64(Math.floor(r() * 24));
    if (x < 0.4) return '.';
    if (x < 0.48) return ' ';
    if (x < 0.53) return '_';
    if (x < 0.58) return '-';
    if (x < 0.61) return '"';
    return b64(1 + Math.floor(r() * 18));
  };
  return Array.from({ length: count }, () => {
    let t = '';
    const len = 2 + Math.floor(r() * 20);
    for (let i = 0; i < len; i++) t += piece();
    return t;
  });
}

const mark = (m: string): string => `<${m.length}>`;

describe('LinearJwtRegExp — same matches as the regex it stands for', () => {
  it.each(Object.entries(JWT_SPECS))('%s: replace (global and not), matchAll, match and test agree', (name, spec: JwtShapeSpec) => {
    const plainG = new RegExp(spec.regex.source, 'g');
    const linearG = new LinearJwtRegExp(spec, 'g');
    const linear = new LinearJwtRegExp(spec);
    let withMatch = 0;
    for (const t of corpus(name.length * 7919, 4000)) {
      expect(t.replace(linearG, mark), t).toBe(t.replace(plainG, mark));
      expect(t.replace(linear, mark), t).toBe(t.replace(spec.regex, mark));
      expect([...t.matchAll(linearG)].map((m) => [m.index, m[0]]), t).toEqual([...t.matchAll(plainG)].map((m) => [m.index, m[0]]));
      expect(t.match(linear)?.[0], t).toBe(t.match(spec.regex)?.[0]);
      expect(linear.test(t), t).toBe(spec.regex.test(t));
      if (spec.regex.test(t)) withMatch++;
    }
    // The corpus must actually produce matches, or the agreement above says nothing.
    expect(withMatch).toBeGreaterThan(20);
  });

  it('agrees at the edges: adjacent tokens, a token at either end, separators on both sides', () => {
    const tok = 'eyJ' + 'a'.repeat(12) + '.eyJ' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
    const cases = [tok, `${tok} ${tok}`, `${tok}.${tok}`, `-${tok}-`, `_${tok}_`, `x${tok}`, `${tok}--`, `${tok}.`, `.${tok}`];
    for (const spec of Object.values(JWT_SPECS)) {
      for (const t of cases) {
        expect(t.replace(new LinearJwtRegExp(spec, 'g'), mark), t).toBe(t.replace(new RegExp(spec.regex.source, 'g'), mark));
      }
    }
  });

  it('accepts only the g flag — any other would be carried and ignored', () => {
    expect(() => new LinearJwtRegExp(JWT_SHAPE, 'gi')).toThrow(/only the g flag/);
    expect(() => 'a.b'.split(new LinearJwtRegExp(JWT_SHAPE))).toThrow(/only the g flag/);
    expect(() => new LinearJwtRegExp(JWT_SHAPE, 'g')).not.toThrow();
  });

  it('withFlags keeps a linear regex linear, and a plain one plain', () => {
    expect(withFlags(new LinearJwtRegExp(JWT_SHAPE), 'g')).toBeInstanceOf(LinearJwtRegExp);
    expect(withFlags(/abc/, 'g')).not.toBeInstanceOf(LinearJwtRegExp);
    expect(withFlags(new LinearJwtRegExp(JWT_SHAPE), 'g').source).toBe(JWT_SHAPE.regex.source);
  });

  it('still finds a large real-world-sized token (big payload, small header)', () => {
    const token = 'eyJ' + 'h'.repeat(250) + '.eyJ' + 'p'.repeat(10_000) + '.' + 's'.repeat(342);
    expect(new LinearJwtRegExp(JWT_SHAPE).test(`Authorization: Bearer ${token}`)).toBe(true);
    expect(new LinearJwtRegExp(JWT_EGRESS_WIDE).test(`{"t":"${token}"}`)).toBe(true);
  });

  it.each(Object.entries(JWT_SPECS))('%s: stays linear on long runs without the dots a match needs', (_name, spec: JwtShapeSpec) => {
    const runs = ['eyJ', 'eyJ---', '_eyJ9aaaaaaaaaaaa', 'eyJaaaaaaaaaaaaaaaa.eyJaaaaaaaaaaaaaaaa.a-', 'eyJa.'];
    const started = performance.now();
    for (const run of runs) {
      const text = run.repeat(Math.ceil(1_000_000 / run.length));
      text.replace(new LinearJwtRegExp(spec, 'g'), 'x');
      new LinearJwtRegExp(spec).test(text);
    }
    // 1 MB per run. A quadratic scan takes minutes here; the linear one well under a second, but
    // the CI run measures with coverage on, which slows this loop about twentyfold. Ten seconds
    // keeps a wide margin on both sides.
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 60_000);
});
