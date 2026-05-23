import { describe, expect, it } from 'vitest';
import { HIDDEN_TOOLS, toolCallLabel } from './tool-call-label.js';

// Identity translator — keeps test assertions about the i18n KEY rather than
// the rendered string. Locks in which key is used per tool without coupling
// to DE/EN copy that may legitimately drift.
const tk = (key: string): string => key;

describe('toolCallLabel', () => {
  describe('memory_recall — discrete visibility (HN trust-debug fix)', () => {
    it('renders the query as subject when present', () => {
      // Happy path: LLM passed a query → user sees what was being recalled.
      const out = toolCallLabel('memory_recall', { namespace: 'knowledge', query: 'pricing strategy' }, tk);
      expect(out).toEqual({ action: 'tool.knowledge_recalled', subject: 'pricing strategy' });
    });

    it('falls back to namespace when LLM uses the no-query recency-dump path', () => {
      // memory_recall accepts namespace-only — see core/src/tools/builtin/memory.ts.
      // Without this fallback the bubble would render "Knowledge recalled —"
      // with no signal at all.
      const out = toolCallLabel('memory_recall', { namespace: 'status' }, tk);
      expect(out).toEqual({ action: 'tool.knowledge_recalled', subject: 'status' });
    });

    it('NEVER renders the literal string "undefined" as subject', () => {
      // Regression: plain String(undefined) leaked "undefined" into the bubble
      // whenever the optional query arg was omitted. Guard both no-query
      // and the truly-empty input shape.
      const noQuery = toolCallLabel('memory_recall', { namespace: 'methods' }, tk);
      expect(noQuery?.subject).not.toBe('undefined');
      const emptyInput = toolCallLabel('memory_recall', {}, tk);
      expect(emptyInput?.subject).not.toBe('undefined');
      const nullInput = toolCallLabel('memory_recall', null, tk);
      expect(nullInput?.subject).not.toBe('undefined');
    });

    it('trims whitespace-only query then falls back to namespace', () => {
      // Defensive: a query of "  " should not pass as a real query — that
      // would render the bubble as "Knowledge recalled —    " with no signal.
      const out = toolCallLabel('memory_recall', { namespace: 'knowledge', query: '   ' }, tk);
      expect(out?.subject).toBe('knowledge');
    });

    it('is NOT in HIDDEN_TOOLS — must always be visible alongside other tools', () => {
      // Belt-and-braces guard. If anyone ever tries to "clean up" by hiding
      // memory tools from the chat, this assertion fails loudly. The HN demo
      // and trust-debug story depends on memory_recall being visible.
      expect(HIDDEN_TOOLS.has('memory_recall')).toBe(false);
      expect(HIDDEN_TOOLS.has('memory_store')).toBe(false);
      expect(HIDDEN_TOOLS.has('memory_update')).toBe(false);
      expect(HIDDEN_TOOLS.has('memory_delete')).toBe(false);
    });
  });

  describe('other tools — sanity', () => {
    it('renders web_research query', () => {
      const out = toolCallLabel('web_research', { query: 'lynox launch' }, tk);
      expect(out).toEqual({ action: 'tool.web_search', subject: 'lynox launch' });
    });

    it('truncates memory_store content at 50 chars', () => {
      const long = 'a'.repeat(120);
      const out = toolCallLabel('memory_store', { content: long }, tk);
      expect(out?.subject.length).toBe(50);
    });

    it('returns null for hidden tools', () => {
      expect(toolCallLabel('artifact_list', {}, tk)).toBeNull();
      expect(toolCallLabel('data_store_list', {}, tk)).toBeNull();
    });

    it('falls back to the tool name as action for unknown tools', () => {
      // Unknown / future tools still surface — never silently dropped.
      const out = toolCallLabel('mystery_tool', { foo: 'bar' }, tk);
      expect(out).toEqual({ action: 'mystery_tool', subject: '' });
    });

    it('tolerates undefined / non-object inputs', () => {
      expect(() => toolCallLabel('bash', undefined, tk)).not.toThrow();
      expect(() => toolCallLabel('bash', 'not an object', tk)).not.toThrow();
      const out = toolCallLabel('bash', undefined, tk);
      expect(out).toEqual({ action: 'tool.command', subject: '' });
    });

    it('extracts last path segment for read_file / write_file', () => {
      const read = toolCallLabel('read_file', { path: '/tmp/nested/dir/file.txt' }, tk);
      expect(read?.subject).toBe('file.txt');
      const write = toolCallLabel('write_file', { path: 'shallow.md' }, tk);
      expect(write?.subject).toBe('shallow.md');
    });

    it('http_request renders METHOD + URL even when method is missing', () => {
      // Default GET — matches pre-refactor behaviour.
      const out = toolCallLabel('http_request', { url: 'https://api.example.com/x' }, tk);
      expect(out?.subject).toBe('GET https://api.example.com/x');
    });
  });
});
