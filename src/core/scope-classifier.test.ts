import { describe, it, expect } from 'vitest';
import type { MemoryScopeRef } from '../types/index.js';
import { classifyScope } from './scope-classifier.js';

const MULTI_SCOPES: MemoryScopeRef[] = [
  { type: 'global', id: '' },
  { type: 'context', id: 'proj-abc' },
  { type: 'user', id: 'alex' },
];

describe('classifyScope', () => {
  // --- Single scope ---

  it('returns single scope with confidence 1.0 when only one scope active', () => {
    const scopes: MemoryScopeRef[] = [{ type: 'context', id: 'proj-abc' }];
    const result = classifyScope('some info', 'notes', scopes);
    expect(result.scope).toEqual({ type: 'context', id: 'proj-abc' });
    expect(result.confidence).toBe(1.0);
    expect(result.reasoning).toBe('Single scope active');
  });

  it('returns single global scope with confidence 1.0', () => {
    const scopes: MemoryScopeRef[] = [{ type: 'global', id: '' }];
    const result = classifyScope('anything', 'notes', scopes);
    expect(result.scope).toEqual({ type: 'global', id: '' });
    expect(result.confidence).toBe(1.0);
  });

  it('returns single user scope with confidence 1.0', () => {
    const scopes: MemoryScopeRef[] = [{ type: 'user', id: 'alex' }];
    const result = classifyScope('anything', 'notes', scopes);
    expect(result.scope).toEqual({ type: 'user', id: 'alex' });
    expect(result.confidence).toBe(1.0);
  });

  // --- Personal preference patterns -> user scope ---

  it('classifies "i prefer" as user scope', () => {
    const result = classifyScope('I prefer vim keybindings', 'workflow', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'user', id: 'alex' });
    expect(result.confidence).toBe(0.8);
    expect(result.reasoning).toBe('Personal preference detected');
  });

  it('classifies "my workflow" as user scope', () => {
    const result = classifyScope('my workflow uses tmux sessions', 'setup', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'user', id: 'alex' });
    expect(result.confidence).toBe(0.8);
  });

  it('classifies "i always" as user scope', () => {
    const result = classifyScope('I always run tests before committing', 'habits', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'user', id: 'alex' });
    expect(result.confidence).toBe(0.8);
  });

  it('classifies "personally" as user scope', () => {
    const result = classifyScope('Personally I find dark themes easier', 'preferences', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'user', id: 'alex' });
    expect(result.confidence).toBe(0.8);
  });

  it('classifies "my setup" as user scope', () => {
    const result = classifyScope('my setup includes neovim and zsh', 'tools', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'user', id: 'alex' });
    expect(result.confidence).toBe(0.8);
  });

  it('matches user patterns case-insensitively', () => {
    const result = classifyScope('I PREFER tabs over spaces', 'style', MULTI_SCOPES);
    expect(result.scope.type).toBe('user');
  });

  // --- Universal knowledge patterns -> global scope ---

  it('classifies "best practice" as global scope', () => {
    const result = classifyScope('best practice is to use parameterized queries', 'security', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'global', id: '' });
    expect(result.confidence).toBe(0.7);
    expect(result.reasoning).toBe('Universal knowledge detected');
  });

  it('classifies "always use" as global scope', () => {
    const result = classifyScope('always use strict mode in TypeScript', 'conventions', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'global', id: '' });
    expect(result.confidence).toBe(0.7);
  });

  it('classifies "never use" as global scope', () => {
    const result = classifyScope('never use eval in production code', 'security', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'global', id: '' });
    expect(result.confidence).toBe(0.7);
  });

  it('classifies "anti-pattern" as global scope', () => {
    const result = classifyScope('God objects are an anti-pattern', 'design', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'global', id: '' });
    expect(result.confidence).toBe(0.7);
  });

  it('classifies "security" as global scope', () => {
    const result = classifyScope('SQL injection is a major security risk', 'knowledge', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'global', id: '' });
    expect(result.confidence).toBe(0.7);
  });

  it('classifies "convention" as global scope', () => {
    const result = classifyScope('The convention is to use camelCase', 'style', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'global', id: '' });
    expect(result.confidence).toBe(0.7);
  });

  it('matches global patterns case-insensitively', () => {
    const result = classifyScope('BEST PRACTICE for error handling', 'knowledge', MULTI_SCOPES);
    expect(result.scope.type).toBe('global');
  });

  // --- Default -> context scope ---

  it('returns context scope for unmatched text', () => {
    const result = classifyScope('This project uses React Router', 'architecture', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'context', id: 'proj-abc' });
    expect(result.confidence).toBe(0.6);
    expect(result.reasoning).toBe('Default context scope');
  });

  it('returns context scope for generic technical info', () => {
    const result = classifyScope('The database schema has 5 tables', 'notes', MULTI_SCOPES);
    expect(result.scope).toEqual({ type: 'context', id: 'proj-abc' });
    expect(result.confidence).toBe(0.6);
  });

  // --- Pattern priority: user patterns take precedence over global patterns ---

  it('user patterns win over global patterns when both match', () => {
    // "i prefer" (user) + "best practice" (global) -> user wins
    const result = classifyScope('I prefer this best practice for error handling', 'style', MULTI_SCOPES);
    expect(result.scope.type).toBe('user');
    expect(result.confidence).toBe(0.8);
  });

  // --- Edge cases: missing scope types in activeScopes ---

  it('falls back to context scope when no user scope available for personal text', () => {
    const scopes: MemoryScopeRef[] = [
      { type: 'global', id: '' },
      { type: 'context', id: 'proj-abc' },
    ];
    // Personal pattern but no user scope -> falls through to global/default
    const result = classifyScope('I prefer dark mode', 'preferences', scopes);
    // No user scope in active scopes, so user pattern doesn't match
    // Falls to global patterns check (no match) -> default context
    expect(result.scope).toEqual({ type: 'context', id: 'proj-abc' });
    expect(result.confidence).toBe(0.6);
  });

  it('falls back to context scope when no global scope available for universal text', () => {
    const scopes: MemoryScopeRef[] = [
      { type: 'context', id: 'proj-abc' },
      { type: 'user', id: 'alex' },
    ];
    const result = classifyScope('best practice for error handling', 'conventions', scopes);
    // No global scope in active scopes, so global pattern doesn't match -> default context
    expect(result.scope).toEqual({ type: 'context', id: 'proj-abc' });
    expect(result.confidence).toBe(0.6);
  });

  // --- Empty scopes ---

  it('returns fallback context scope when no scopes provided', () => {
    const result = classifyScope('some info', 'notes', []);
    expect(result.scope).toEqual({ type: 'context', id: '' });
    expect(result.confidence).toBe(1.0);
    expect(result.reasoning).toBe('Single scope active');
  });

  // --- Fallback selection order ---

  it('fallback prefers context scope over non-global alternatives', () => {
    const scopes: MemoryScopeRef[] = [
      { type: 'global', id: '' },
      { type: 'user', id: 'alex' },
      { type: 'context', id: 'proj-abc' },
    ];
    const result = classifyScope('generic project info', 'notes', scopes);
    expect(result.scope).toEqual({ type: 'context', id: 'proj-abc' });
  });

  it('fallback uses first non-global scope when no context scope exists', () => {
    const scopes: MemoryScopeRef[] = [
      { type: 'global', id: '' },
      { type: 'user', id: 'alex' },
    ];
    const result = classifyScope('generic info', 'notes', scopes);
    // No context scope -> falls back to first non-global (user)
    expect(result.scope).toEqual({ type: 'user', id: 'alex' });
    expect(result.confidence).toBe(0.6);
  });

  it('fallback uses global scope when it is the only option in multi-scope', () => {
    // Technically 2 scopes but both global (unlikely edge case)
    const scopes: MemoryScopeRef[] = [
      { type: 'global', id: '' },
      { type: 'global', id: 'other' },
    ];
    const result = classifyScope('generic info', 'notes', scopes);
    expect(result.scope).toEqual({ type: 'global', id: '' });
  });

  // --- Synchronous behavior ---

  it('returns synchronously (no promise)', () => {
    const result = classifyScope('test', 'notes', MULTI_SCOPES);
    // Result is a plain object, not a Promise
    expect(result).toHaveProperty('scope');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('reasoning');
    // Verify it's not a thenable
    expect(result).not.toHaveProperty('then');
  });

  // --- Options parameter is accepted but unused ---

  it('accepts options parameter without affecting behavior', () => {
    const result = classifyScope('some info', 'notes', MULTI_SCOPES, {
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-test',
      apiBaseURL: 'https://example.com',
      projectId: 'test-proj',
    });
    expect(result.scope).toEqual({ type: 'context', id: 'proj-abc' });
    expect(result.confidence).toBe(0.6);
  });
});
