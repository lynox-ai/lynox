import { describe, it, expect } from 'vitest';
import { CAPTURE_SYSTEM, CAPTURE_TOOL } from './capture-fallback.js';
import { EXTRACTION_PROMPT } from './memory.js';
import { rememberTool } from '../tools/builtin/knowledge.js';

// A remembered fact is shown to the operator under the answer and kept in their memory. On a
// German instance it came back in English ("The operator requires a preview …"), because no path
// that writes one said which language to write it in. The model-side check is the online eval
// `tests/online/capture-language-eval.test.ts`; these pin the sentences it measured.

type Schema = { properties: Record<string, { description?: string; items?: Schema }> };
const flat = (s: string): string => s.replace(/\s+/g, ' ');

describe('remembered facts keep the operator\'s language', () => {
  it('the capture instruction asks for the language of the operator\'s own sentences, whichever it is', () => {
    expect(flat(CAPTURE_SYSTEM)).toContain('Write each fact in the language the operator writes in under the operator label: the same language as the operator\'s own sentences, whichever it is.');
  });

  it('the capture instruction applies the operator\'s language to a fact from the assistant half too', () => {
    expect(flat(CAPTURE_SYSTEM)).toContain('This holds for a fact from the assistant half too');
    expect(flat(CAPTURE_SYSTEM)).toContain('a fact from an English mail in a German conversation is written in German');
  });

  it('the capture instruction judges the language by the sentences, not by names or company forms', () => {
    expect(flat(CAPTURE_SYSTEM)).toContain('Judge the language by the sentences, not by the names, places or company forms in them');
  });

  it('the capture instruction says the time stamp in front of the message is not the operator writing', () => {
    expect(flat(CAPTURE_SYSTEM)).toContain('A bracketed time stamp the system puts in front of the message is not the operator writing');
  });

  it('the capture instruction keeps proper nouns as they are', () => {
    expect(flat(CAPTURE_SYSTEM)).toContain('Proper nouns stay as they are.');
  });

  it('the capture instruction keeps the excerpt labels for the person out of a fact', () => {
    expect(flat(CAPTURE_SYSTEM)).toContain('A fact never names its person that way: state the rule itself, or make the business or a named person its subject.');
  });

  it('the capture tool asks for the fact text in the operator\'s language', () => {
    const facts = (CAPTURE_TOOL.input_schema as unknown as Schema).properties['facts'];
    expect(facts?.items?.properties['text']?.description ?? '').toContain('in the language the operator writes in');
  });

  it('the remember tool asks for the fact text in the operator\'s language', () => {
    const schema = rememberTool.definition.input_schema as unknown as Schema;
    expect(schema.properties['text']?.description ?? '').toContain('in the language the operator writes in');
  });

  it('the remember tool keeps the excerpt labels for the person out of the fact text', () => {
    const schema = rememberTool.definition.input_schema as unknown as Schema;
    expect(schema.properties['text']?.description ?? '').toContain('State the rule itself or name the business; do not call the person "the operator" or "the user".');
  });

  it('the extractor used without durable memory writes in the language of the response', () => {
    expect(EXTRACTION_PROMPT).toContain('Write each entry in the language the response below is written in; the example below is in English only because this prompt is.');
  });
});
