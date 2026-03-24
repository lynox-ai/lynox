import { describe, it, expect } from 'vitest';
import { buildCommandDefs } from './autocomplete.js';

describe('buildCommandDefs', () => {
  const COMMANDS = ['/clear', '/model', '/help', '/exit', '/cost'];

  const HELP_TEXT = `Conversation
  /clear              Reset conversation (keep memory)
Model
  /model [name]       Switch model (opus/sonnet/haiku)
  /cost [today|week|by-model] Show token usage and cost
System
  /help               Show this help
  /exit               Exit NODYN
`;

  it('parses commands with descriptions and categories', () => {
    const defs = buildCommandDefs(COMMANDS, HELP_TEXT);
    const clear = defs.find(d => d.name === '/clear');
    expect(clear).toBeDefined();
    expect(clear!.description).toContain('Reset conversation');
    expect(clear!.category).toBe('Conversation');
  });

  it('extracts all listed commands', () => {
    const defs = buildCommandDefs(COMMANDS, HELP_TEXT);
    expect(defs.length).toBe(5);
    expect(defs.map(d => d.name)).toContain('/model');
    expect(defs.map(d => d.name)).toContain('/cost');
  });

  it('handles commands not in help text', () => {
    const defs = buildCommandDefs(['/clear', '/unknown'], HELP_TEXT);
    const unknown = defs.find(d => d.name === '/unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.description).toBe('');
    expect(unknown!.category).toBe('Other');
  });

  it('strips argument notation from descriptions', () => {
    const defs = buildCommandDefs(COMMANDS, HELP_TEXT);
    const model = defs.find(d => d.name === '/model');
    expect(model).toBeDefined();
    // Should have clean description without [name]
    expect(model!.description).not.toContain('[name]');
  });
});
