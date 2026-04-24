import { describe, it, expect } from 'vitest';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { validateToolInput, formatValidationErrors } from './tool-input-validator.js';

// Mirrors the real task_create schema shape — we keep a local copy rather
// than importing to avoid coupling validator tests to task-tool changes.
const TASK_CREATE_SCHEMA: BetaTool['input_schema'] = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    assignee: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    watch_interval_minutes: { type: 'number' },
  },
  required: ['title'],
};

describe('validateToolInput', () => {
  it('accepts valid input matching schema', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, {
      title: 'New task',
      priority: 'high',
      tags: ['a', 'b'],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports missing required property', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, { priority: 'low' });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toBe('title');
    expect(result.errors[0]!.message).toMatch(/required/);
  });

  it('rejects unknown top-level keys by default', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, {
      title: 'ok',
      made_up_field: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe('made_up_field');
    expect(result.errors[0]!.message).toMatch(/unknown property/);
    // Help the agent: list known properties
    expect(result.errors[0]!.message).toMatch(/title/);
  });

  it('rejects type mismatch on string', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, {
      title: 123 as unknown as string,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe('title');
    expect(result.errors[0]!.message).toMatch(/expected string/);
  });

  it('rejects type mismatch on number', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, {
      title: 'ok',
      watch_interval_minutes: '60' as unknown as number,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe('watch_interval_minutes');
    expect(result.errors[0]!.message).toMatch(/expected number/);
  });

  it('rejects enum violation', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, {
      title: 'ok',
      priority: 'super-urgent',
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe('priority');
    expect(result.errors[0]!.message).toMatch(/one of/);
  });

  it('validates array item types', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, {
      title: 'ok',
      tags: ['a', 5 as unknown as string, 'c'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe('tags[1]');
    expect(result.errors[0]!.message).toMatch(/expected string/);
  });

  it('rejects non-array when array expected', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, {
      title: 'ok',
      tags: 'a,b,c' as unknown as string[],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe('tags');
    expect(result.errors[0]!.message).toMatch(/expected array/);
  });

  it('opts a schema back into loose mode with additionalProperties: true', () => {
    const loose: BetaTool['input_schema'] = {
      ...TASK_CREATE_SCHEMA,
      additionalProperties: true,
    };
    const result = validateToolInput(loose, { title: 'ok', freeform: 'allowed' });
    expect(result.ok).toBe(true);
  });

  it('silently accepts unrecognised schema constructs (forward-compat)', () => {
    const exotic: BetaTool['input_schema'] = {
      type: 'object',
      properties: { q: { oneOf: [{ type: 'string' }, { type: 'number' }] } as unknown as Record<string, unknown> },
    };
    const result = validateToolInput(exotic, { q: 'hello' });
    expect(result.ok).toBe(true);
  });

  it('accumulates multiple errors in one pass', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, {
      // missing title, bad priority, unknown key
      priority: 'bogus',
      extra: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    const paths = result.errors.map(e => e.path);
    expect(paths).toContain('title');
    expect(paths).toContain('priority');
    expect(paths).toContain('extra');
  });

  it('formatValidationErrors produces human-readable text', () => {
    const result = validateToolInput(TASK_CREATE_SCHEMA, { priority: 'x' });
    const text = formatValidationErrors(result.errors);
    expect(text).toContain('title');
    expect(text).toContain('priority');
  });

  // Regression guard: builtin tools use `{ type: 'object' }` with no `properties`
  // declared as the "free-form payload" idiom (http_request.headers,
  // data_store_insert.records[*], run_pipeline.context, etc). Strict-by-default
  // here would reject every real call.
  describe('free-form object idiom', () => {
    it('accepts arbitrary keys when nested object has no properties declared', () => {
      const schema: BetaTool['input_schema'] = {
        type: 'object',
        properties: {
          headers: { type: 'object' },
        },
      };
      const result = validateToolInput(schema, {
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      });
      expect(result.ok).toBe(true);
    });

    it('accepts arbitrary keys at root when no properties declared', () => {
      const schema: BetaTool['input_schema'] = { type: 'object' };
      const result = validateToolInput(schema, { anything: 'goes', nested: { also: true } });
      expect(result.ok).toBe(true);
    });

    it('accepts arbitrary keys in nested array items with no item properties', () => {
      const schema: BetaTool['input_schema'] = {
        type: 'object',
        properties: {
          records: { type: 'array', items: { type: 'object' } },
        },
      };
      const result = validateToolInput(schema, {
        records: [{ a: 1 }, { x: 'y', z: true }],
      });
      expect(result.ok).toBe(true);
    });

    it('still enforces strictness when properties IS declared', () => {
      const schema: BetaTool['input_schema'] = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };
      const result = validateToolInput(schema, { name: 'ok', extra: 'no' });
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.path === 'extra')).toBe(true);
    });

    it('caller can force strict on a nested empty-properties object', () => {
      const schema: BetaTool['input_schema'] = {
        type: 'object',
        properties: {
          headers: { type: 'object', properties: {}, additionalProperties: false } as unknown as Record<string, unknown>,
        },
      };
      const result = validateToolInput(schema, { headers: { Authorization: 'Bearer x' } });
      expect(result.ok).toBe(false);
    });

    it('rejects __proto__ smuggling against an empty-properties strict object', () => {
      // Using Object.hasOwn instead of `key in props` guards against entries
      // walking up the prototype chain.
      const schema: BetaTool['input_schema'] = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };
      const payload: Record<string, unknown> = { name: 'ok' };
      Object.defineProperty(payload, '__proto__', { value: { evil: true }, enumerable: true });
      const result = validateToolInput(schema, payload);
      // __proto__ key shows up via Object.keys, gets rejected as unknown.
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.path === '__proto__')).toBe(true);
    });
  });

  // Round-trip regression: validate REAL builtin tool schemas against payloads
  // shaped like the real tools see in production. Catches future schema drift
  // that would silently break dispatch.
  describe('real builtin tool schemas', () => {
    it('http_request accepts arbitrary headers', () => {
      const schema: BetaTool['input_schema'] = {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
          headers: { type: 'object' },
        },
        required: ['url'],
      };
      const result = validateToolInput(schema, {
        url: 'https://api.example.com',
        method: 'POST',
        headers: { 'X-API-Key': 'secret:KEY', 'Content-Type': 'application/json' },
      });
      expect(result.ok).toBe(true);
    });

    it('data_store_insert accepts records with arbitrary column shapes', () => {
      const schema: BetaTool['input_schema'] = {
        type: 'object',
        properties: {
          table: { type: 'string' },
          records: { type: 'array', items: { type: 'object' } },
        },
        required: ['table', 'records'],
      };
      const result = validateToolInput(schema, {
        table: 'leads',
        records: [
          { name: 'Acme', score: 9, signed_up: true },
          { name: 'Beta', industry: 'fintech' },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it('run_pipeline accepts arbitrary context map', () => {
      const schema: BetaTool['input_schema'] = {
        type: 'object',
        properties: {
          pipeline_id: { type: 'string' },
          context: { type: 'object' },
        },
        required: ['pipeline_id'],
      };
      const result = validateToolInput(schema, {
        pipeline_id: 'wf-123',
        context: { customer: 'acme', month: '2026-04', dry_run: true },
      });
      expect(result.ok).toBe(true);
    });
  });
});
