/**
 * Unit coverage for `scripts/model-fitness/token-factor.ts`, which measures the token factor
 * a model switch is priced with. `scripts/` is outside the vitest `include`, so its pure parts
 * are covered here (same arrangement as tests/model-fitness-replay.test.ts).
 */
import { describe, it, expect } from 'vitest';
import * as builtin from '../src/tools/builtin/index.js';
import { modelCapability } from '../src/types/models.js';
import { PAIRS, builtinBodies, contentFactor, floorBody, hasTools } from '../scripts/model-fitness/token-factor.js';

describe('the built-in bodies', () => {
  const bodies = builtinBodies();
  const exported = Object.values(builtin).filter(v => typeof v === 'object' && v !== null && 'definition' in v);

  it('carry every tool definition src/tools/builtin exports, each once', () => {
    const tools = bodies[0]!.tools as Array<{ name: string; input_schema: unknown }>;
    expect(exported.length).toBeGreaterThan(20);
    expect(tools).toHaveLength(exported.length);
    expect(new Set(tools.map(t => t.name)).size).toBe(tools.length);
    expect(tools.filter(t => t.input_schema === undefined).map(t => t.name)).toEqual([]);
  });

  it('measure the system prompt and the tools together in one body', () => {
    expect(typeof bodies[0]!.system).toBe('string');
    expect((bodies[0]!.system as string).length).toBeGreaterThan(1000);
  });
});

describe('the pairs', () => {
  it('name only models the engine prices for the Anthropic API', () => {
    const ids = PAIRS.flatMap(p => [p.from, p.to]);
    expect(ids.filter(id => modelCapability(id)?.provider !== 'anthropic')).toEqual([]);
  });

  it('carry a same-tokenizer control for each candidate that has an earlier model of its tokenizer', () => {
    for (const to of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
      expect(PAIRS.some(p => p.to === to && p.control), to).toBe(true);
      expect(PAIRS.some(p => p.to === to && !p.control), to).toBe(true);
    }
  });
});

describe('hasTools', () => {
  it('tells the bodies with tools from those without, so each gets a floor of its shape', () => {
    const [both, systemOnly, toolsOnly, german] = builtinBodies();
    expect([both, systemOnly, toolsOnly, german].map(b => hasTools(b!))).toEqual([true, false, true, false]);
    expect(hasTools({ label: 'empty list', messages: [], tools: [] })).toBe(false);
  });
});

describe('floorBody', () => {
  it('matches the body\'s shape: one minimal tool when the body has tools, none otherwise', () => {
    // With tools present the count carries a tool-use preamble of some hundred tokens that
    // differs by model; a floor without a tool would leave it inside the content.
    expect(floorBody(true).tools).toHaveLength(1);
    expect(floorBody(false).tools).toBeUndefined();
  });
});

describe('contentFactor', () => {
  it('takes the ratio over the content, not over the fixed per-request part', () => {
    // 73 → 75 tokens with floors 8 → 10: the raw ratio is 1.03, the content is the same.
    expect(contentFactor({ from: 73, to: 75 }, { from: 8, to: 10 })).toBe(1);
    expect(contentFactor({ from: 108, to: 140 }, { from: 8, to: 10 })).toBeCloseTo(1.3);
  });

  it('refuses a body with nothing above the floor', () => {
    expect(() => contentFactor({ from: 8, to: 10 }, { from: 8, to: 10 })).toThrow(/no content above the floor/);
  });
});
