import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { extractEntitiesV2, parseToolInput } from './entity-extractor-v2.js';
import { ForcedToolNotCalledError, forcedToolMissCounts } from './llm-wire-rules.js';

describe('entity-extractor-v2 parseToolInput', () => {
  it('keeps proper-noun entities at sufficient confidence', () => {
    const result = parseToolInput({
      entities: [
        {
          canonical_name: 'Peter Huber',
          type: 'person',
          confidence: 0.95,
          aliases: [],
          evidence_span: 'Peter Huber said',
        },
        {
          canonical_name: 'Hetzner',
          type: 'organization',
          confidence: 0.9,
          aliases: [],
          evidence_span: 'hosted on Hetzner',
        },
      ],
      relations: [],
    });
    expect(result.entities.map(e => e.canonicalName).sort()).toEqual(['Hetzner', 'Peter Huber']);
  });

  it('drops generic nouns even when LLM returns them at ≥0.8 confidence', () => {
    // Defense-in-depth: prompt says reject these, but Haiku occasionally
    // doesn't. The post-filter must catch them.
    const result = parseToolInput({
      entities: [
        { canonical_name: 'when', type: 'person', confidence: 0.85, aliases: [], evidence_span: 'when X happens' },
        { canonical_name: 'notification', type: 'person', confidence: 0.9, aliases: [], evidence_span: 'sent a notification' },
        { canonical_name: 'support', type: 'person', confidence: 0.82, aliases: [], evidence_span: 'support team' },
        { canonical_name: 'creation', type: 'person', confidence: 0.88, aliases: [], evidence_span: 'after creation' },
        { canonical_name: 'name', type: 'organization', confidence: 0.9, aliases: [], evidence_span: 'name of the' },
        { canonical_name: 'strict', type: 'concept', confidence: 0.95, aliases: [], evidence_span: 'strict mode' },
        { canonical_name: 'logging/monitoring', type: 'project', confidence: 0.9, aliases: [], evidence_span: 'logging/monitoring stack' },
        { canonical_name: '10/1k', type: 'project', confidence: 0.85, aliases: [], evidence_span: '10/1k tokens' },
      ],
      relations: [],
    });
    expect(result.entities).toEqual([]);
  });

  it('drops junk-SHAPED persons (acronym/lowercase, NOT generic nouns) — kind-conditional', () => {
    const result = parseToolInput({
      entities: [
        { canonical_name: 'CSV', type: 'person', confidence: 0.9, aliases: [], evidence_span: 'exported a CSV' },
        { canonical_name: 'target', type: 'person', confidence: 0.88, aliases: [], evidence_span: 'hit the target' },
        { canonical_name: 'CSV', type: 'product', confidence: 0.9, aliases: [], evidence_span: 'the CSV format' },     // same shape, kept
        { canonical_name: 'Grace Hopper', type: 'person', confidence: 0.9, aliases: [], evidence_span: 'Grace Hopper said' },
      ],
      relations: [],
    });
    expect(result.entities.map(e => e.canonicalName).sort()).toEqual(['CSV', 'Grace Hopper']);
  });

  it('mixed input: keeps proper nouns, drops common nouns', () => {
    const result = parseToolInput({
      entities: [
        { canonical_name: 'lynox', type: 'product', confidence: 0.95, aliases: [], evidence_span: 'we use lynox' },
        { canonical_name: 'tools', type: 'concept', confidence: 0.9, aliases: [], evidence_span: 'these tools' },
        { canonical_name: 'Zurich', type: 'location', confidence: 0.95, aliases: [], evidence_span: 'in Zurich' },
        { canonical_name: 'workflow', type: 'concept', confidence: 0.85, aliases: [], evidence_span: 'the workflow' },
      ],
      relations: [],
    });
    expect(result.entities.map(e => e.canonicalName).sort()).toEqual(['Zurich', 'lynox']);
  });

  it('still drops sub-confidence entities regardless of name', () => {
    const result = parseToolInput({
      entities: [
        { canonical_name: 'Peter Huber', type: 'person', confidence: 0.7, aliases: [], evidence_span: 'Peter Huber' },
      ],
      relations: [],
    });
    expect(result.entities).toEqual([]);
  });

  it('drops relations whose subject/object got purged by the post-filter', () => {
    // "support" gets dropped by post-filter → relation "Peter works_for support"
    // must drop too because object is no longer in entities[].
    const result = parseToolInput({
      entities: [
        { canonical_name: 'Peter', type: 'person', confidence: 0.9, aliases: [], evidence_span: 'Peter' },
        { canonical_name: 'support', type: 'organization', confidence: 0.85, aliases: [], evidence_span: 'support team' },
      ],
      relations: [
        { subject: 'Peter', predicate: 'works_for', object: 'support', confidence: 0.9 },
      ],
    });
    expect(result.entities.map(e => e.canonicalName)).toEqual(['Peter']);
    expect(result.relations).toEqual([]);
  });

  it('handles empty / malformed input gracefully', () => {
    expect(parseToolInput(null)).toEqual({ entities: [], relations: [] });
    expect(parseToolInput({})).toEqual({ entities: [], relations: [] });
    expect(parseToolInput({ entities: 'nope' })).toEqual({ entities: [], relations: [] });
  });

  it('created_by: keeps person/org creators, drops event/project creators', () => {
    // "X created_by <event/project/place>" is a direction/kind error — a creator
    // is a who (person OR organization), not a what/where/when.
    const result = parseToolInput({
      entities: [
        { canonical_name: 'Gemini 3.1 Pro', type: 'product', confidence: 0.95, aliases: [], evidence_span: 'Gemini 3.1 Pro' },
        { canonical_name: 'Google I/O', type: 'project', confidence: 0.9, aliases: [], evidence_span: 'at Google I/O' },
        { canonical_name: 'Google', type: 'organization', confidence: 0.95, aliases: [], evidence_span: 'by Google' },
        { canonical_name: 'Linux', type: 'product', confidence: 0.95, aliases: [], evidence_span: 'Linux' },
        { canonical_name: 'Linus Torvalds', type: 'person', confidence: 0.95, aliases: [], evidence_span: 'by Linus Torvalds' },
      ],
      relations: [
        { subject: 'Gemini 3.1 Pro', predicate: 'created_by', object: 'Google I/O', confidence: 0.9 }, // event → drop
        { subject: 'Gemini 3.1 Pro', predicate: 'created_by', object: 'Google', confidence: 0.9 },     // org → keep
        { subject: 'Linux', predicate: 'created_by', object: 'Linus Torvalds', confidence: 0.9 },       // person → keep
      ],
    });
    expect(result.relations).toEqual([
      { subject: 'Gemini 3.1 Pro', predicate: 'created_by', object: 'Google', confidence: 0.9 },
      { subject: 'Linux', predicate: 'created_by', object: 'Linus Torvalds', confidence: 0.9 },
    ]);
  });

  it('drops the 2026-07 stopword/pricing/fragment gaps at ≥0.8 confidence', () => {
    const result = parseToolInput({
      entities: [
        { canonical_name: 'management', type: 'organization', confidence: 0.9, aliases: [], evidence_span: 'the management' },
        { canonical_name: 'data', type: 'person', confidence: 0.85, aliases: [], evidence_span: 'the data' },
        { canonical_name: 'page', type: 'person', confidence: 0.9, aliases: [], evidence_span: 'the page' },
        { canonical_name: 'website', type: 'organization', confidence: 0.88, aliases: [], evidence_span: 'the website' },
        { canonical_name: 'ist', type: 'person', confidence: 0.9, aliases: [], evidence_span: 'das ist' },
        { canonical_name: '153/h', type: 'project', confidence: 0.85, aliases: [], evidence_span: '153/h rate' },
        { canonical_name: 'death/disability', type: 'project', confidence: 0.9, aliases: [], evidence_span: 'death/disability cover' },
      ],
      relations: [],
    });
    expect(result.entities).toEqual([]);
  });

  it('M4 slop filter: drops slash-compound + digit-leading PROJECT names, keeps other kinds', () => {
    const result = parseToolInput({
      entities: [
        // Newly dropped by the M4 project-scoped rule (old filter missed these:
        // uppercase halves, non-common-noun, no space).
        { canonical_name: 'Orion/Vega', type: 'project', confidence: 0.9, aliases: [], evidence_span: 'Orion/Vega merge' },
        { canonical_name: '2024-roadmap', type: 'project', confidence: 0.9, aliases: [], evidence_span: 'the 2024-roadmap' },
        // Kept — the rule is scoped to `project`, so real acronyms / digit-leading
        // products of OTHER kinds survive, and multi-word projects (a space) survive.
        { canonical_name: 'AC/DC', type: 'concept', confidence: 0.9, aliases: [], evidence_span: 'AC/DC' },
        { canonical_name: '1Password', type: 'product', confidence: 0.9, aliases: [], evidence_span: '1Password vault' },
        { canonical_name: 'Q3/Q4 Planning', type: 'project', confidence: 0.9, aliases: [], evidence_span: 'Q3/Q4 Planning' },
        // digit-leading but NOT digit+separator → a real project, kept (the rule is
        // `\d+[-/]`, not a bare leading digit).
        { canonical_name: '2026 Roadmap', type: 'project', confidence: 0.9, aliases: [], evidence_span: 'the 2026 Roadmap' },
      ],
      relations: [],
    });
    expect(result.entities.map(e => e.canonicalName).sort()).toEqual(['1Password', '2026 Roadmap', 'AC/DC', 'Q3/Q4 Planning']);
  });
});

describe('entity-extractor-v2 request', () => {
  it('sends no sampling parameters, so any model the fast slot can hold accepts it', async () => {
    let sent: Record<string, unknown> | undefined;
    const client = {
      beta: {
        messages: {
          stream: (params: Record<string, unknown>) => {
            sent = params;
            return {
              finalMessage: async () => ({ content: [], usage: { input_tokens: 10, output_tokens: 5 } }),
            };
          },
        },
      },
    } as unknown as Anthropic;

    const result = await extractEntitiesV2('Acme AG signed the contract with Beta GmbH in Zurich.', client);

    // The request really went through this client and the call ran to its end (a
    // `costUsd` is only set on the success path, not in the catch) — without that,
    // the absence asserts below would pass on a request that was never built.
    expect(sent?.['tool_choice']).toEqual({ type: 'tool', name: expect.any(String) });
    expect(result.costUsd).toBeDefined();
    expect(sent).not.toHaveProperty('temperature');
    expect(sent).not.toHaveProperty('top_p');
    expect(sent).not.toHaveProperty('top_k');
  });
});

describe('entity-extractor-v2 — a reply that lost the forced call', () => {
  it('returns the reply\'s cost for the debit and counts the miss by name', async () => {
    const client = {
      beta: { messages: { stream: () => ({
        finalMessage: async () => { throw new ForcedToolNotCalledError(
          'claude-opus-5-5', { type: 'tool', name: 'extract_entities' },
          { content: [{ type: 'text', text: 'Acme AG, Beta GmbH' }], usage: { input_tokens: 400, output_tokens: 60 } }); },
      }) } },
    } as unknown as Anthropic;
    const before = forcedToolMissCounts()['entity-extractor'] ?? 0;
    const result = await extractEntitiesV2('Acme AG signed the contract with Beta GmbH in Zurich.', client);
    expect(result.entities).toEqual([]);
    // A bare await lands in the catch, which returns no costUsd: the spend would be lost.
    expect(result.costUsd).toBeGreaterThan(0);
    expect(forcedToolMissCounts()['entity-extractor']).toBe(before + 1);
  });
});
