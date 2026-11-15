import { describe, it, expect } from 'vitest';
import type { ToolEntry } from '../types/index.js';
import { withNoWebSentence } from './sub-agent-web.js';
import { STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK, SUBAGENT_NO_WEB_PROMPT_BLOCK } from './prompts.js';
import { applyNetworkPolicy, createToolContext } from './tool-context.js';

const tool = (name: string): ToolEntry => ({ definition: { name, description: '', input_schema: { type: 'object', properties: {} } }, handler: async () => '' }) as unknown as ToolEntry;

function under(policy: 'deny-all' | 'allow-list' | 'allow-all') {
  const ctx = createToolContext({});
  applyNetworkPolicy(ctx, policy, policy === 'allow-list' ? ['api.example.com'] : []);
  return ctx;
}

describe('withNoWebSentence', () => {
  it('appends the sentence after the prompt for an agent the settings keep off the web', () => {
    expect(withNoWebSentence('Base.', [tool('read_file')], under('deny-all'))).toBe(`Base.\n\n${SUBAGENT_NO_WEB_PROMPT_BLOCK}`);
  });

  it('adds the sentence for structured output after it for a workflow step only', () => {
    expect(withNoWebSentence('Base.', [tool('read_file')], under('deny-all'), { step: true }))
      .toBe(`Base.\n\n${SUBAGENT_NO_WEB_PROMPT_BLOCK} ${STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK}`);
    expect(withNoWebSentence('Base.', [tool('read_file')], under('deny-all'))).not.toContain(STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK);
    // Where the settings leave the web open, a step is told nothing either.
    expect(withNoWebSentence('Base.', [tool('read_file')], under('allow-all'), { step: true })).toBe('Base.');
  });

  // The wording is pinned verbatim: it was measured as it stands, and a change needs a new measurement.
  it('carries the step sentence verbatim, and only a step gets it', () => {
    expect(STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK).toBe('This holds for structured output too: in a table, list or JSON, write such an address as plain text followed by "(not checked)", exactly like this: example.org (not checked). Never put the address inside square brackets, parentheses or backticks.');
    expect(SUBAGENT_NO_WEB_PROMPT_BLOCK).toBe('In this run you cannot search the web or open web pages: the network settings of this instance do not allow it. Say so in your report. Do not present facts as looked up. If you mention a web address you have not opened, write it as plain text, not as a link, and say that you have not checked it.');
    const child = withNoWebSentence('Base.', [tool('read_file')], under('deny-all'));
    expect(child).not.toContain('exactly like this: example.org (not checked)');
    expect(withNoWebSentence('Base.', [tool('read_file')], under('deny-all'), { step: true })).toContain('exactly like this: example.org (not checked)');
  });

  it('tells an agent whose tools run their own code nothing, unless it has none', () => {
    expect(withNoWebSentence('Base.', [tool('lookup_company')], under('deny-all'), { step: true, ownCodeTools: true })).toBe('Base.');
    expect(withNoWebSentence('Base.', [], under('deny-all'), { step: true, ownCodeTools: true }))
      .toBe(`Base.\n\n${SUBAGENT_NO_WEB_PROMPT_BLOCK} ${STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK}`);
  });

  it('leaves the prompt as it is where the agent may reach the web, or the settings are not known', () => {
    expect(withNoWebSentence('Base.', [tool('read_file'), tool('bash')], under('deny-all'))).toBe('Base.');
    expect(withNoWebSentence('Base.', [tool('http_request')], under('allow-list'))).toBe('Base.');
    expect(withNoWebSentence('Base.', [tool('read_file')], under('allow-all'))).toBe('Base.');
    expect(withNoWebSentence('Base.', [tool('read_file')], undefined)).toBe('Base.');
  });
});
