import { describe, it, expect } from 'vitest';
import {
  buildDependencyGraph,
  detectCycle,
  computePhases,
  validateGraph,
  CycleError,
} from './graph.js';
import type { ManifestStep } from './types.js';

function step(id: string, input_from?: string[]): ManifestStep {
  return { id, agent: `agent-${id}`, runtime: 'mock', input_from };
}

describe('buildDependencyGraph', () => {
  it('returns empty deps for steps without input_from', () => {
    const adj = buildDependencyGraph([step('a'), step('b')]);
    expect(adj.get('a')?.size).toBe(0);
    expect(adj.get('b')?.size).toBe(0);
  });

  it('returns correct deps for steps with input_from', () => {
    const adj = buildDependencyGraph([step('a'), step('b', ['a']), step('c', ['a', 'b'])]);
    expect([...adj.get('b')!]).toEqual(['a']);
    expect([...adj.get('c')!].sort()).toEqual(['a', 'b']);
  });

  it('returns empty map for empty array', () => {
    const adj = buildDependencyGraph([]);
    expect(adj.size).toBe(0);
  });
});

describe('detectCycle', () => {
  it('returns null for a linear chain', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set()],
      ['b', new Set(['a'])],
      ['c', new Set(['b'])],
    ]);
    expect(detectCycle(adj)).toBeNull();
  });

  it('returns cycle path for a simple cycle', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['a'])],
    ]);
    const cycle = detectCycle(adj);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
    expect(cycle!).toContain('a');
    expect(cycle!).toContain('b');
  });

  it('detects self-loop', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['a'])],
    ]);
    const cycle = detectCycle(adj);
    expect(cycle).not.toBeNull();
    expect(cycle!).toContain('a');
  });

  it('detects cycle in diamond-with-backlink', () => {
    // a → b, a → c, b → d, c → d, d → a
    const adj = new Map<string, Set<string>>([
      ['a', new Set()],
      ['b', new Set(['a'])],
      ['c', new Set(['a'])],
      ['d', new Set(['b', 'c', 'a'])], // d depends on a (not a cycle by itself)
    ]);
    expect(detectCycle(adj)).toBeNull();

    // Now add back-edge: a depends on d → cycle
    const adj2 = new Map<string, Set<string>>([
      ['a', new Set(['d'])],
      ['b', new Set(['a'])],
      ['c', new Set(['a'])],
      ['d', new Set(['b', 'c'])],
    ]);
    expect(detectCycle(adj2)).not.toBeNull();
  });

  it('returns null for disconnected acyclic graph', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set()],
      ['b', new Set()],
      ['c', new Set(['a'])],
      ['d', new Set(['b'])],
    ]);
    expect(detectCycle(adj)).toBeNull();
  });
});

describe('computePhases', () => {
  it('linear A→B→C: 3 phases of 1', () => {
    const result = computePhases([step('a'), step('b', ['a']), step('c', ['b'])]);
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0]!.stepIds).toEqual(['a']);
    expect(result.phases[1]!.stepIds).toEqual(['b']);
    expect(result.phases[2]!.stepIds).toEqual(['c']);
    expect(result.stepOrder).toEqual(['a', 'b', 'c']);
  });

  it('independent A,B: 1 phase of 2', () => {
    const result = computePhases([step('a'), step('b')]);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.stepIds.sort()).toEqual(['a', 'b']);
  });

  it('diamond A→B, A→C, B+C→D: 3 phases', () => {
    const result = computePhases([
      step('a'),
      step('b', ['a']),
      step('c', ['a']),
      step('d', ['b', 'c']),
    ]);
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0]!.stepIds).toEqual(['a']);
    expect(result.phases[1]!.stepIds.sort()).toEqual(['b', 'c']);
    expect(result.phases[2]!.stepIds).toEqual(['d']);
  });

  it('fan-out A→B,C,D,E: 2 phases', () => {
    const result = computePhases([
      step('a'),
      step('b', ['a']),
      step('c', ['a']),
      step('d', ['a']),
      step('e', ['a']),
    ]);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0]!.stepIds).toEqual(['a']);
    expect(result.phases[1]!.stepIds.sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('fan-in A,B,C,D→E: 2 phases', () => {
    const result = computePhases([
      step('a'),
      step('b'),
      step('c'),
      step('d'),
      step('e', ['a', 'b', 'c', 'd']),
    ]);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0]!.stepIds.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(result.phases[1]!.stepIds).toEqual(['e']);
  });

  it('all independent: 1 phase with all steps', () => {
    const result = computePhases([step('a'), step('b'), step('c')]);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.stepIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('throws CycleError on cycle', () => {
    expect(() =>
      computePhases([step('a', ['b']), step('b', ['a'])]),
    ).toThrow(CycleError);
  });

  it('assigns correct phaseIndex values', () => {
    const result = computePhases([step('a'), step('b', ['a']), step('c', ['b'])]);
    expect(result.phases[0]!.phaseIndex).toBe(0);
    expect(result.phases[1]!.phaseIndex).toBe(1);
    expect(result.phases[2]!.phaseIndex).toBe(2);
  });
});

describe('validateGraph', () => {
  it('passes for valid graph', () => {
    expect(() => validateGraph([step('a'), step('b', ['a'])])).not.toThrow();
  });

  it('throws on duplicate IDs', () => {
    expect(() => validateGraph([step('a'), step('a')])).toThrow('Duplicate step ID: "a"');
  });

  it('throws on self-loops', () => {
    expect(() => validateGraph([step('a', ['a'])])).toThrow('Self-loop');
  });

  it('throws on orphan refs', () => {
    expect(() => validateGraph([step('a', ['z'])])).toThrow('Orphan reference');
    expect(() => validateGraph([step('a', ['z'])])).toThrow('"z"');
  });

  it('throws CycleError on cycles', () => {
    expect(() => validateGraph([step('a', ['b']), step('b', ['a'])])).toThrow(CycleError);
  });

  it('passes for empty deps', () => {
    expect(() => validateGraph([step('a'), step('b'), step('c')])).not.toThrow();
  });
});
