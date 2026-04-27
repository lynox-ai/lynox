import { describe, it, expect } from 'vitest';
import { parseToolInput } from './entity-extractor-v2.js';

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
});
