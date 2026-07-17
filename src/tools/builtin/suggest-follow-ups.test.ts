import { describe, it, expect } from 'vitest';
import type { IAgent } from '../../types/index.js';
import { suggestFollowUpsTool } from './suggest-follow-ups.js';

const agent = {} as IAgent; // handler ignores the agent

describe('suggestFollowUpsTool', () => {
  it('is declared terminal (endsTurn) so the loop short-circuits after it', () => {
    expect(suggestFollowUpsTool.endsTurn).toBe(true);
  });

  it('schema requires suggestions with label+task items', () => {
    const schema = suggestFollowUpsTool.definition.input_schema as {
      required?: string[];
      properties: { suggestions: { items: { required?: string[] } } };
    };
    expect(schema.required).toContain('suggestions');
    expect(schema.properties.suggestions.items.required).toEqual(['label', 'task']);
  });

  it('handler acknowledges the count of valid suggestions', async () => {
    const r = await suggestFollowUpsTool.handler(
      { suggestions: [{ label: 'A', task: 'ta' }, { label: 'B', task: 'tb' }] },
      agent,
    );
    expect(r).toContain('2');
  });

  it('handler excludes malformed items from its count', async () => {
    const r = await suggestFollowUpsTool.handler(
      {
        suggestions: [
          { label: 'A', task: 'ta' },
          { label: '', task: 'x' },                    // blank label
          { label: 'B' } as unknown as { label: string; task: string }, // missing task
        ],
      },
      agent,
    );
    expect(r).toContain('1');
  });

  it('handler handles empty and missing suggestions gracefully', async () => {
    expect(await suggestFollowUpsTool.handler({ suggestions: [] }, agent)).toMatch(/No follow-up/i);
    expect(await suggestFollowUpsTool.handler({}, agent)).toMatch(/No follow-up/i);
  });
});
