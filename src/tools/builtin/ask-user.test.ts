import { describe, it, expect, vi } from 'vitest';
import { askUserTool } from './ask-user.js';
import type { IAgent } from '../../types/index.js';

function makeAgent(overrides: Partial<IAgent> = {}): IAgent {
  return {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    ...overrides,
  };
}

describe('askUserTool', () => {
  it('calls promptUser with question and returns result', async () => {
    const promptUser = vi.fn().mockResolvedValue('user answer');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler({ question: 'What color?' }, agent);
    expect(result).toBe('user answer');
    expect(promptUser).toHaveBeenCalledWith('What color?', undefined);
  });

  it('passes options to promptUser', async () => {
    const promptUser = vi.fn().mockResolvedValue('blue');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler(
      { question: 'Pick a color', options: ['red', 'blue', 'green'] },
      agent,
    );
    expect(result).toBe('blue');
    expect(promptUser).toHaveBeenCalledWith('Pick a color', ['red', 'blue', 'green', '\x00']);
  });

  it('returns "Interactive input not available" when promptUser is undefined', async () => {
    const agent = makeAgent();
    const result = await askUserTool.handler({ question: 'Hello?' }, agent);
    expect(result).toBe('Interactive input not available in this context.');
  });

  it('uses promptTabs for tabbed multi-question dialog', async () => {
    const promptTabs = vi.fn().mockResolvedValue(['Alice', 'Engineer']);
    const promptUser = vi.fn();
    const agent = makeAgent({ promptUser, promptTabs });

    const questions = [
      { question: 'What is your name?' },
      { question: 'What is your role?', header: 'Role' },
    ];

    const result = await askUserTool.handler(
      { question: 'Setup', questions },
      agent,
    );
    expect(result).toBe('What is your name?: Alice\nWhat is your role?: Engineer');
    expect(promptTabs).toHaveBeenCalledWith([
      { question: 'What is your name?', header: undefined, options: undefined },
      { question: 'What is your role?', header: 'Role', options: undefined },
    ]);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('returns "User canceled." when promptTabs returns empty array', async () => {
    const promptTabs = vi.fn().mockResolvedValue([]);
    const agent = makeAgent({ promptUser: vi.fn(), promptTabs });

    const result = await askUserTool.handler(
      { question: 'Setup', questions: [{ question: 'Q1' }] },
      agent,
    );
    expect(result).toBe('User canceled.');
  });

  it('falls back to sequential promptUser when promptTabs is undefined', async () => {
    const promptUser = vi.fn()
      .mockResolvedValueOnce('answer 1')
      .mockResolvedValueOnce('answer 2');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler(
      { question: 'Fallback?', questions: [{ question: 'Q1' }, { question: 'Q2' }] },
      agent,
    );
    expect(result).toBe('Q1: answer 1\nQ2: answer 2');
    expect(promptUser).toHaveBeenCalledTimes(2);
    expect(promptUser).toHaveBeenCalledWith('Q1', undefined);
    expect(promptUser).toHaveBeenCalledWith('Q2', undefined);
  });
});
